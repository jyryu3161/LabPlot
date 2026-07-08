from __future__ import annotations

import re
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import Request

from app.common.exceptions import AppError
from app.config import settings


def allowed_origins() -> list[str]:
    return [o.strip() for o in settings.ALLOWED_ORIGINS.split(",") if o.strip()]


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    ),
}


INTERACTIVE_FIGURE_HTML_HEADERS = {
    **SECURITY_HEADERS,
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": (
        "default-src 'self' data: blob:; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' data: blob:; "
        "frame-ancestors 'self'; "
        "base-uri 'self'; "
        "form-action 'none'"
    ),
}

_INTERACTIVE_FIGURE_HTML_RE = re.compile(r"^/static/figures/.+\.html$", re.IGNORECASE)


def security_headers_for_path(path: str) -> dict[str, str]:
    if _INTERACTIVE_FIGURE_HTML_RE.match(path):
        return INTERACTIVE_FIGURE_HTML_HEADERS
    return SECURITY_HEADERS


class InMemoryRateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        now = time.monotonic()
        hits = self._hits[key]
        while hits and hits[0] <= now - window_seconds:
            hits.popleft()
        if len(hits) >= limit:
            raise AppError(status_code=429, detail="Too many requests. Please try again later.", error_code="RATE_LIMITED")
        hits.append(now)


_limiter = InMemoryRateLimiter()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
        if hops:
            return hops[-1]
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, limit: int, window_seconds: int) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        _limiter.check(f"{name}:{_client_ip(request)}", limit, window_seconds)

    return dependency
