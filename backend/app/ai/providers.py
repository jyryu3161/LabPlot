"""Provider-agnostic structured-output transport for the AI features.

Neutral `content` is a list of items:
  {"kind": "text", "text": "..."}
  {"kind": "image", "mime": "image/png", "b64": "..."}

run_structured(...) returns a validated dict (parsed JSON object).
"""
from __future__ import annotations

import json
import urllib.request
import urllib.error

from app.common.exceptions import BadRequestError

_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def run_structured(provider: str, model: str, key: str | None, system: str,
                   content: list[dict], schema: dict, tool_name: str = "result",
                   max_tokens: int = 1600) -> dict:
    payload, _ = run_structured_with_usage(provider, model, key, system, content, schema, tool_name, max_tokens)
    return payload


def run_structured_with_usage(provider: str, model: str, key: str | None, system: str,
                              content: list[dict], schema: dict, tool_name: str = "result",
                              max_tokens: int = 1600) -> tuple[dict, dict]:
    if not key:
        raise BadRequestError(f"No API key configured for provider '{provider}'", error_code="AI_NO_KEY")
    if provider == "gemini":
        return _gemini(model, key, system, content, schema, max_tokens)
    return _claude(model, key, system, content, schema, tool_name, max_tokens)


# ----------------------------------------------------------------- Claude
def _claude(model, key, system, content, schema, tool_name, max_tokens) -> tuple[dict, dict]:
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

    client = anthropic.Anthropic(api_key=key)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=[{"name": tool_name, "description": f"Return the {tool_name}.", "input_schema": schema}],
            tool_choice={"type": "tool", "name": tool_name},
            messages=[{"role": "user", "content": blocks}],
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


def _gemini(model, key, system, content, schema, max_tokens) -> tuple[dict, dict]:
    parts = []
    for c in content:
        if c["kind"] == "text":
            parts.append({"text": c["text"]})
        elif c["kind"] == "image":
            parts.append({"inline_data": {"mime_type": c["mime"], "data": c["b64"]}})

    gen = {"responseMimeType": "application/json", "maxOutputTokens": max_tokens, "temperature": 0.3}
    json_instruction = (
        "\n\nReturn ONLY a single JSON object that conforms to this JSON schema "
        "(no prose, no markdown, no code fences):\n" + json.dumps(schema)
    )
    try:
        gen["responseSchema"] = _to_gemini_schema(schema)
        # Keep the explicit text instruction even when responseSchema is
        # available. Gemini can still occasionally emit plain text for simple
        # one-field responses, especially legend rewrites.
        sys_text = system + json_instruction
    except _UnsupportedSchema:
        sys_text = system + json_instruction
    body = {
        "system_instruction": {"parts": [{"text": sys_text}]},
        "contents": [{"parts": parts}],
        "generationConfig": gen,
    }
    url = _GEMINI_URL.format(model=model)
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise BadRequestError(f"Gemini API error {e.code}: {detail}", error_code="AI_API_ERROR")
    except Exception as e:
        raise BadRequestError(f"Gemini API error: {e}", error_code="AI_API_ERROR")

    try:
        cand = payload["candidates"][0]
        parts = cand.get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts)
    except (KeyError, IndexError):
        raise BadRequestError("Gemini returned no content", error_code="AI_BAD_RESPONSE")

    return _parse_json(text, schema), _gemini_usage(payload)


def _gemini_usage(payload: dict) -> dict:
    raw = payload.get("usageMetadata") or {}
    input_tokens = _as_int(raw.get("promptTokenCount"))
    output_tokens = _as_int(raw.get("candidatesTokenCount"))
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
