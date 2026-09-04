"""Provider-agnostic structured-output transport for the AI features.

Neutral `content` is a list of items:
  {"kind": "text", "text": "..."}
  {"kind": "image", "mime": "image/png", "b64": "..."}

run_structured(...) returns a validated dict (parsed JSON object).
"""
from __future__ import annotations

import json
import logging
import re
import socket
import time
import urllib.request
import urllib.error

from app.common.exceptions import BadRequestError
from app.config import settings

logger = logging.getLogger(__name__)

_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Gemini model names are interpolated into the request URL path; only accept the
# characters real model ids use so a bad config value can't alter the URL.
_GEMINI_MODEL_RE = re.compile(r"^[A-Za-z0-9._-]+$")
# Injectable so tests can assert on retry delays without actually sleeping.
_SLEEP = time.sleep
_RETRYABLE_HTTP_STATUS = {429, 500, 503, 504}
# Upper bound on how long a single retry sleep may honor from an upstream
# Retry-After header. This runs synchronously inside a request handler
# holding a pooled DB session, so an upstream telling us to wait minutes
# (or longer) must not be allowed to block the thread that long.
_MAX_RETRY_DELAY = 15.0
# Extra output-token budget reserved for Gemini's internal reasoning when a
# thinking level is requested, on top of the caller's requested max_tokens for
# the visible JSON payload. Without this, a "high" thinking budget can consume
# the entire max_tokens window and truncate (or entirely crowd out) the JSON
# response, which used to fail opaquely inside _parse_json.
_THINKING_RESERVE = 8192


def run_structured(provider: str, model: str, key: str | None, system: str,
                   content: list[dict], schema: dict, tool_name: str = "result",
                   max_tokens: int = 1600, gemini_thinking_level: str | None = None,
                   temperature: float | None = None) -> dict:
    payload, _ = run_structured_with_usage(
        provider, model, key, system, content, schema, tool_name, max_tokens, gemini_thinking_level,
        temperature=temperature,
    )
    return payload


def run_structured_with_usage(provider: str, model: str, key: str | None, system: str,
                              content: list[dict], schema: dict, tool_name: str = "result",
                              max_tokens: int = 1600,
                              gemini_thinking_level: str | None = None,
                              temperature: float | None = None) -> tuple[dict, dict]:
    if not key:
        raise BadRequestError(f"No API key configured for provider '{provider}'", error_code="AI_NO_KEY")
    if provider == "gemini":
        return _gemini(model, key, system, content, schema, max_tokens, gemini_thinking_level, temperature)
    return _claude(model, key, system, content, schema, tool_name, max_tokens, temperature)


# ----------------------------------------------------------------- Claude
def _claude(model, key, system, content, schema, tool_name, max_tokens, temperature: float | None = None) -> tuple[dict, dict]:
    try:
        import anthropic
    except ImportError:
        raise BadRequestError("anthropic SDK not installed", error_code="AI_NO_SDK")

    blocks = []
    for c in content:
        if c["kind"] == "text":
            blocks.append({"type": "text", "text": c["text"]})
        elif c["kind"] == "image":
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": c["mime"], "data": c["b64"]}})

    client = anthropic.Anthropic(api_key=key, timeout=90.0, max_retries=2)
    kwargs = {}
    if temperature is not None:
        kwargs["temperature"] = temperature
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=[{"name": tool_name, "description": f"Return the {tool_name}.", "input_schema": schema}],
            tool_choice={"type": "tool", "name": tool_name},
            messages=[{"role": "user", "content": blocks}],
            **kwargs,
        )
    except Exception as e:
        raise BadRequestError(f"Claude API error: {e}", error_code="AI_API_ERROR")
    usage = _claude_usage(resp)
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            return block.input, usage
    raise BadRequestError("Claude returned no structured output", error_code="AI_BAD_RESPONSE")


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _claude_usage(resp) -> dict:
    raw = getattr(resp, "usage", None)
    if not raw:
        return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    input_tokens = (
        _as_int(getattr(raw, "input_tokens", 0))
        + _as_int(getattr(raw, "cache_creation_input_tokens", 0))
        + _as_int(getattr(raw, "cache_read_input_tokens", 0))
    )
    output_tokens = _as_int(getattr(raw, "output_tokens", 0))
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }


# ----------------------------------------------------------------- Gemini
class _UnsupportedSchema(Exception):
    pass


def _to_gemini_schema(js: dict) -> dict:
    """Convert a JSON-Schema dict to Gemini responseSchema (uppercase types).
    Raises _UnsupportedSchema for generic/property-less objects (e.g. param_patch)."""
    t = js.get("type")
    if t == "object":
        props = js.get("properties")
        if not props:
            raise _UnsupportedSchema()
        g = {"type": "OBJECT", "properties": {k: _to_gemini_schema(v) for k, v in props.items()}}
        if js.get("required"):
            g["required"] = js["required"]
        return g
    if t == "array":
        return {"type": "ARRAY", "items": _to_gemini_schema(js["items"])}
    if t == "string":
        g = {"type": "STRING"}
        if js.get("enum"):
            g["enum"] = js["enum"]
        return g
    if t == "integer":
        return {"type": "INTEGER"}
    if t == "number":
        return {"type": "NUMBER"}
    if t == "boolean":
        return {"type": "BOOLEAN"}
    raise _UnsupportedSchema()


def _supports_thinking_level(model: str) -> bool:
    return "gemini-3" in (model or "").lower()


def _retry_delay(error: urllib.error.HTTPError) -> float:
    """Honor a Retry-After header when the API sends one, else a fixed 2s."""
    headers = getattr(error, "headers", None)
    header = headers.get("Retry-After") if headers is not None else None
    if header:
        try:
            return min(_MAX_RETRY_DELAY, max(0.0, float(header)))
        except (TypeError, ValueError):
            pass
    return 2.0


def _post_with_retry(req: urllib.request.Request, timeout: float = 90.0) -> bytes:
    """POST `req`, retrying exactly once for transient failures.

    Retryable: HTTP 429/500/503/504, and connection/timeout errors
    (URLError/socket.timeout/TimeoutError). Any other error (e.g. HTTP 400)
    propagates immediately on the first attempt so the caller can react to it
    (e.g. drop an unsupported responseSchema and retry with a different body)
    instead of burning the one retry on a request that will fail again
    unchanged.
    """
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if attempt == 0 and e.code in _RETRYABLE_HTTP_STATUS:
                delay = _retry_delay(e)
                logger.warning("Gemini API returned HTTP %s; retrying once after %.1fs", e.code, delay)
                last_error = e
                _SLEEP(delay)
                continue
            raise
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e:
            if attempt == 0:
                logger.warning("Gemini API network error (%r); retrying once after 2.0s", e)
                last_error = e
                _SLEEP(2.0)
                continue
            raise
    raise last_error  # pragma: no cover - loop above always returns or raises


def _decode_gemini_payload(raw: bytes) -> dict:
    """Decode a Gemini response body, mapping any decode/shape failure to
    AI_API_ERROR instead of letting it propagate as an unhandled 500."""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BadRequestError(f"Gemini API error: non-JSON response ({e})", error_code="AI_API_ERROR")
    if not isinstance(payload, dict):
        raise BadRequestError("Gemini API error: unexpected response shape", error_code="AI_API_ERROR")
    return payload


def _gemini(model, key, system, content, schema, max_tokens, thinking_level: str | None = None,
            temperature: float | None = None) -> tuple[dict, dict]:
    # Reject anything that isn't a plain model id before it reaches the URL path.
    if not isinstance(model, str) or not _GEMINI_MODEL_RE.fullmatch(model):
        model = settings.GEMINI_MODEL
    parts = []
    for c in content:
        if c["kind"] == "text":
            parts.append({"text": c["text"]})
        elif c["kind"] == "image":
            parts.append({"inline_data": {"mime_type": c["mime"], "data": c["b64"]}})

    gen = {
        "responseMimeType": "application/json", "maxOutputTokens": max_tokens,
        "temperature": temperature if temperature is not None else 0.3,
    }
    if _supports_thinking_level(model):
        # Gemini 3.x models think by default (dynamic budget) even when no
        # thinkingLevel is set, and that reasoning is budgeted from the same
        # maxOutputTokens window as the visible JSON. Always reserve headroom
        # so thinking can't crowd out (truncate) a small structured answer
        # such as the 500-token verify verdict.
        gen["maxOutputTokens"] = max_tokens + _THINKING_RESERVE
        if thinking_level:
            gen["thinkingConfig"] = {"thinkingLevel": thinking_level}
    json_instruction = (
        "\n\nReturn ONLY a single JSON object that conforms to this JSON schema "
        "(no prose, no markdown, no code fences):\n" + json.dumps(schema)
    )
    schema_supported = True
    try:
        gen["responseSchema"] = _to_gemini_schema(schema)
        # Keep the explicit text instruction even when responseSchema is
        # available. Gemini can still occasionally emit plain text for simple
        # one-field responses, especially legend rewrites.
        sys_text = system + json_instruction
    except _UnsupportedSchema:
        schema_supported = False
        logger.warning("Gemini responseSchema unsupported for this schema shape; falling back to prompt-only JSON")
        sys_text = system + json_instruction

    def _build_request(gen_config: dict) -> urllib.request.Request:
        body = {
            "system_instruction": {"parts": [{"text": sys_text}]},
            "contents": [{"parts": parts}],
            "generationConfig": gen_config,
        }
        return urllib.request.Request(
            _GEMINI_URL.format(model=model), data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key}, method="POST",
        )

    def _post(gen_config: dict) -> bytes:
        return _post_with_retry(_build_request(gen_config), timeout=90.0)

    try:
        raw = _post(gen)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        if (
            e.code == 400 and schema_supported
            and re.search(r"responseschema|response_schema|\bschema\b", detail, re.IGNORECASE)
        ):
            logger.warning("Gemini rejected responseSchema with HTTP 400 (%s); retrying once without it", detail[:200])
            gen.pop("responseSchema", None)
            retry_req = _build_request(gen)
            try:
                raw = _post_with_retry(retry_req, timeout=90.0)
            except urllib.error.HTTPError as e2:
                detail2 = e2.read().decode("utf-8", "ignore")[:300]
                raise BadRequestError(f"Gemini API error {e2.code}: {detail2}", error_code="AI_API_ERROR")
            except Exception as e2:
                raise BadRequestError(f"Gemini API error: {e2}", error_code="AI_API_ERROR")
        else:
            raise BadRequestError(f"Gemini API error {e.code}: {detail}", error_code="AI_API_ERROR")
    except Exception as e:
        raise BadRequestError(f"Gemini API error: {e}", error_code="AI_API_ERROR")

    payload = _decode_gemini_payload(raw)
    try:
        cand = payload["candidates"][0]
        parts_out = cand.get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts_out)
    except (KeyError, IndexError):
        raise BadRequestError("Gemini returned no content", error_code="AI_BAD_RESPONSE")

    if cand.get("finishReason") == "MAX_TOKENS":
        # One bounded retry: double the visible budget and pin thinking to
        # "low" (when the model supports levels and none was requested) so a
        # verbose dynamic-thinking pass can't starve the JSON twice in a row.
        first_usage = _gemini_usage(payload)
        retry_gen = dict(gen)
        retry_gen["maxOutputTokens"] = int(gen.get("maxOutputTokens", max_tokens)) * 2
        if _supports_thinking_level(model) and not thinking_level:
            retry_gen["thinkingConfig"] = {"thinkingLevel": "low"}
        logger.warning("Gemini output truncated (MAX_TOKENS); retrying once with maxOutputTokens=%s",
                       retry_gen["maxOutputTokens"])
        try:
            raw2 = _post(retry_gen)
        except urllib.error.HTTPError as e2:
            detail2 = e2.read().decode("utf-8", "ignore")[:300]
            raise BadRequestError(f"Gemini API error {e2.code}: {detail2}", error_code="AI_API_ERROR")
        except (urllib.error.URLError, socket.timeout, TimeoutError) as e2:
            raise BadRequestError(f"Gemini API error: {e2}", error_code="AI_API_ERROR")
        payload = _decode_gemini_payload(raw2)
        try:
            cand = payload["candidates"][0]
            parts_out = cand.get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts_out)
        except (KeyError, IndexError):
            raise BadRequestError("Gemini returned no content", error_code="AI_BAD_RESPONSE")
        if cand.get("finishReason") == "MAX_TOKENS":
            raise BadRequestError("AI output truncated (MAX_TOKENS)", error_code="AI_BAD_RESPONSE")
        usage = _gemini_usage(payload)
        usage = {k: usage[k] + first_usage[k] for k in ("input_tokens", "output_tokens", "total_tokens")}
        return _parse_json(text, schema), usage

    return _parse_json(text, schema), _gemini_usage(payload)


def _gemini_usage(payload: dict) -> dict:
    raw = payload.get("usageMetadata") or {}
    input_tokens = _as_int(raw.get("promptTokenCount"))
    output_tokens = _as_int(raw.get("candidatesTokenCount")) + _as_int(raw.get("thoughtsTokenCount"))
    total_tokens = _as_int(raw.get("totalTokenCount")) or (input_tokens + output_tokens)
    if total_tokens > input_tokens + output_tokens:
        # Gemini bills thinking tokens as output tokens. Some responses report
        # them only in totalTokenCount, so store billable output, not visible text
        # output only.
        output_tokens = max(0, total_tokens - input_tokens)
    else:
        total_tokens = input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


def _parse_json(text: str, schema: dict | None = None) -> dict:
    t = (text or "").strip()
    # strip ```json ... ``` / ``` ... ``` fences
    if t.startswith("```"):
        t = t[3:]
        if t[:4].lower() == "json":
            t = t[4:]
        if t.endswith("```"):
            t = t[:-3]
        t = t.strip()
    try:
        parsed = json.loads(t, strict=False)
        if isinstance(parsed, dict):
            return parsed
        coerced = _coerce_single_string_response(parsed, schema)
        if coerced is not None:
            return coerced
    except json.JSONDecodeError:
        pass
    # robust brace extraction (handles trailing prose)
    start = t.find("{")
    if start >= 0:
        depth = 0
        for i in range(start, len(t)):
            if t[i] == "{":
                depth += 1
            elif t[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(t[start:i + 1], strict=False)
                        if isinstance(parsed, dict):
                            return parsed
                    except json.JSONDecodeError:
                        break
    # last resort: simple span
    end = t.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(t[start:end + 1], strict=False)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    coerced = _coerce_single_string_response(t, schema)
    if coerced is not None:
        return coerced
    raise BadRequestError("Gemini did not return valid JSON", error_code="AI_BAD_RESPONSE")


def _coerce_single_string_response(value, schema: dict | None) -> dict | None:
    """Accept plain text for schemas shaped like {"legend": string}.

    Gemini sometimes ignores JSON-only instructions for simple rewrite tasks and
    returns the requested prose directly. This keeps those user-facing workflows
    usable without weakening multi-field structured responses.
    """
    if not schema or schema.get("type") != "object":
        return None
    props = schema.get("properties")
    required = schema.get("required") or []
    if not isinstance(props, dict) or len(props) != 1 or len(required) != 1:
        return None
    key = required[0]
    field = props.get(key)
    if not isinstance(field, dict) or field.get("type") != "string":
        return None
    if isinstance(value, str):
        text = value.strip()
        if text and "{" not in text and "}" not in text:
            return {key: text}
    return None
