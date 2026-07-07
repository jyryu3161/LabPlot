"""Imported canvas images (SVG/PNG/JPEG): sniffing, validation, sanitization.

Uploaded blobs become canvas panels alongside figure panels, get nested into
the export composite SVG (SVG imports stay vector; raster imports embed as
data-URI <image>), and are re-served to other project members' browsers — so
everything here is defensive:

- type is decided by MAGIC BYTES, never the filename/extension;
- raster images are decoded by Pillow under an explicit pixel budget (the same
  40M-px ceiling as the export raster path) so a decompression bomb is rejected
  before it can allocate;
- SVG is parsed and SANITIZED (scripts/event handlers/external references
  stripped) and the SANITIZED serialization is what gets stored — the original
  markup is discarded, so every later consumer (editor <img>, export composite,
  rsvg) only ever sees vetted markup;
- JPEGs are re-encoded through Pillow with EXIF orientation applied (browser
  <img> honours the orientation tag but rsvg's <image> and PPTX do not — the
  bytes must be physically upright to render identically everywhere). This also
  strips EXIF metadata (GPS etc.) from user photos as a side effect.
"""

from __future__ import annotations

import io
import re
import xml.etree.ElementTree as ET

from app.common.exceptions import BadRequestError

# Hard limits (grilling: 20MB/file enforced at the router read; these are the
# content-level budgets).
IMAGE_MAX_PIXELS = 40_000_000  # matches canvases.service._RASTER_MAX_PIXELS
SVG_MAX_BYTES = 5 * 1024 * 1024

# Native-size sanity envelope (mm). A 1px icon or a monster panorama both get
# clamped into something the mm-based canvas math can work with.
NATIVE_MM_MIN = 1.0
NATIVE_MM_MAX = 5000.0

_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"

# Elements that can execute script, embed foreign documents, or exfiltrate via
# timed requests. Removed subtree-and-all. SMIL animation elements are dropped
# too: they can mutate href/onbegin chains and never make sense in a static
# scientific figure.
_SVG_DISALLOWED_TAGS = {
    "script", "foreignobject", "iframe", "object", "embed", "audio", "video",
    "animate", "animatetransform", "animatemotion", "animatecolor", "set",
    "handler", "listener",
}
# href/xlink:href values allowed to survive: internal fragment references and
# embedded raster data URIs.
_SVG_HREF_OK_RE = re.compile(
    r"^\s*(#|data:image/(png|jpeg|jpg|gif|webp);base64,)", re.IGNORECASE
)
# url(...) tokens inside style/CSS: only local fragment references may stay.
_CSS_URL_RE = re.compile(r"url\s*\(\s*(['\"]?)\s*([^'\")]*)\1\s*\)", re.IGNORECASE)

_LENGTH_RE = re.compile(r"^\s*([0-9.]+)\s*(px|pt|pc|mm|cm|in|q)?\s*$", re.IGNORECASE)
_MM_PER_UNIT = {
    "px": 25.4 / 96.0,
    "pt": 25.4 / 72.0,
    "pc": 25.4 / 6.0,
    "mm": 1.0,
    "cm": 10.0,
    "in": 25.4,
    "q": 0.25,
}


def _bad(detail: str) -> BadRequestError:
    return BadRequestError(detail, error_code="BAD_IMAGE")


def sniff_kind(content: bytes) -> str:
    """'png' | 'jpg' | 'svg' from magic bytes; raises BAD_IMAGE otherwise."""
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    head = content[:4096].lstrip(b"\xef\xbb\xbf \t\r\n")
    if head.startswith(b"<"):
        lowered = head[:2048].lower()
        if b"<svg" in lowered:
            return "svg"
    raise _bad("Unsupported image type — upload an SVG, PNG, or JPEG file")


def _clamp_native(value: float) -> float:
    return max(NATIVE_MM_MIN, min(NATIVE_MM_MAX, float(value)))


def _svg_length_mm(raw: str | None) -> float | None:
    """Parse an SVG length attribute into mm. Percent/none → None."""
    if not raw:
        return None
    m = _LENGTH_RE.match(raw)
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    if num <= 0:
        return None
    unit = (m.group(2) or "px").lower()
    return num * _MM_PER_UNIT[unit]


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _attr_localname(name: str) -> str:
    return name.rsplit("}", 1)[-1].lower()


def _css_is_safe(css: str) -> bool:
    """True when the CSS text contains no import and no non-fragment url()."""
    if "@import" in css.lower():
        return False
    for m in _CSS_URL_RE.finditer(css):
        target = m.group(2).strip()
        if not target.startswith("#"):
            return False
    return True


def _sanitize_element(el: ET.Element) -> None:
    """Recursively strip unsafe children/attributes in place."""
    for child in list(el):
        if _localname(child.tag) in _SVG_DISALLOWED_TAGS:
            el.remove(child)
            continue
        _sanitize_element(child)

    for name in list(el.attrib.keys()):
        local = _attr_localname(name)
        value = el.attrib[name]
        # onload/onclick/onbegin/... — any event handler attribute.
        if local.startswith("on"):
            del el.attrib[name]
            continue
        if local == "href":
            if not _SVG_HREF_OK_RE.match(value or ""):
                del el.attrib[name]
            continue
        if local == "style" and not _css_is_safe(value or ""):
            del el.attrib[name]
            continue

    if _localname(el.tag) == "style" and el.text and not _css_is_safe(el.text):
        # Nuking the whole sheet is safer than trying to surgically rewrite
        # CSS; a stylesheet that references external resources is untrusted.
        el.text = ""


def sanitize_svg(content: bytes) -> tuple[bytes, float, float]:
    """Validate + sanitize an uploaded SVG → (sanitized_bytes, w_mm, h_mm).

    The returned bytes are a full re-serialization of the parsed tree — the
    original markup (comments, doctype, processing instructions, anything the
    parser dropped) never reaches storage.
    """
    if len(content) > SVG_MAX_BYTES:
        raise _bad(f"SVG file is over the {SVG_MAX_BYTES // (1024 * 1024)}MB limit")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _bad("SVG file is not valid UTF-8") from exc

    # DTDs are rejected outright BEFORE parsing: internal entity expansion
    # (billion laughs) blows memory inside the parser itself, and no legitimate
    # figure SVG ships a doctype.
    lowered = text.lower()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise _bad("SVG files with DOCTYPE/ENTITY declarations are not supported")

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise _bad("SVG file could not be parsed") from exc
    if _localname(root.tag) != "svg":
        raise _bad("File is not an SVG document")

    _sanitize_element(root)
    # The root itself: strip event handlers etc. (recursion covers children).
    for name in list(root.attrib.keys()):
        if _attr_localname(name).startswith("on"):
            del root.attrib[name]

    # Native size: width/height attributes (physical units) preferred, viewBox
    # (px @ 96dpi) fallback, then a 100mm square as the last resort.
    w_mm = _svg_length_mm(root.attrib.get("width"))
    h_mm = _svg_length_mm(root.attrib.get("height"))
    if w_mm is None or h_mm is None:
        vb = root.attrib.get("viewBox")
        if vb:
            parts = re.split(r"[\s,]+", vb.strip())
            if len(parts) == 4:
                try:
                    vw, vh = float(parts[2]), float(parts[3])
                    if vw > 0 and vh > 0:
                        w_mm = w_mm if w_mm is not None else vw * _MM_PER_UNIT["px"]
                        h_mm = h_mm if h_mm is not None else vh * _MM_PER_UNIT["px"]
                except ValueError:
                    pass
    if w_mm is None or h_mm is None:
        w_mm, h_mm = 100.0, 100.0

    # An SVG WITHOUT a viewBox draws in raw px user units (1 unit = 1 CSS px of
    # the viewport). The export composite nests panels via a viewBox window, so
    # synthesize one covering the full px extent of the declared size —
    # otherwise a width="50mm" document would be windowed to 50 USER UNITS
    # (~a quarter of its content) at export.
    if "viewBox" not in root.attrib:
        w_px = w_mm / _MM_PER_UNIT["px"]
        h_px = h_mm / _MM_PER_UNIT["px"]
        root.set("viewBox", f"0 0 {w_px:g} {h_px:g}")

    # Serialize with the SVG namespace as the default prefix so the stored
    # markup nests cleanly into the export composite (no ns0: noise on every
    # element). register_namespace is process-global but idempotent.
    ET.register_namespace("", _SVG_NS)
    ET.register_namespace("xlink", _XLINK_NS)
    serialized = ET.tostring(root, encoding="unicode")
    out = ('<?xml version="1.0" encoding="UTF-8"?>\n' + serialized).encode("utf-8")
    return out, _clamp_native(w_mm), _clamp_native(h_mm)


def validate_raster(content: bytes, kind: str) -> tuple[bytes, float, float]:
    """Validate an uploaded PNG/JPEG → (bytes_to_store, w_mm, h_mm).

    Decodes under the pixel budget; JPEGs are re-encoded upright (EXIF
    orientation applied, metadata dropped). PNGs are stored byte-identical.
    """
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = IMAGE_MAX_PIXELS
    try:
        with Image.open(io.BytesIO(content)) as im:
            fmt = (im.format or "").upper()
            if kind == "png" and fmt != "PNG":
                raise _bad("File content is not a valid PNG image")
            if kind == "jpg" and fmt != "JPEG":
                raise _bad("File content is not a valid JPEG image")
            width, height = im.size
            if width <= 0 or height <= 0:
                raise _bad("Image has no pixels")
            if width * height > IMAGE_MAX_PIXELS:
                raise _bad(
                    f"Image is {width}x{height}px, over the "
                    f"{IMAGE_MAX_PIXELS // 1_000_000}M-pixel limit"
                )

            dpi = im.info.get("dpi")
            dpi_x = dpi_y = 96.0
            if isinstance(dpi, (tuple, list)) and len(dpi) >= 2:
                try:
                    dx, dy = float(dpi[0]), float(dpi[1])
                    # Ignore garbage resolutions (0/1 dpi placeholders, or
                    # absurd values) rather than producing a 30-metre panel.
                    if 10.0 <= dx <= 2400.0 and 10.0 <= dy <= 2400.0:
                        dpi_x, dpi_y = dx, dy
                except (TypeError, ValueError):
                    pass

            out_bytes = content
            if kind == "jpg":
                upright = ImageOps.exif_transpose(im)
                width, height = upright.size
                if width * height > IMAGE_MAX_PIXELS:
                    raise _bad("Image is over the pixel limit")
                buf = io.BytesIO()
                if upright.mode not in ("RGB", "L"):
                    upright = upright.convert("RGB")
                upright.save(buf, format="JPEG", quality=95, dpi=(dpi_x, dpi_y))
                out_bytes = buf.getvalue()
            else:
                # Fully decode so a truncated/corrupt file fails HERE, not in
                # a later export.
                im.load()
    except BadRequestError:
        raise
    except Exception as exc:  # Pillow raises a zoo of decode errors
        raise _bad("Image file could not be decoded") from exc

    w_mm = _clamp_native(width / dpi_x * 25.4)
    h_mm = _clamp_native(height / dpi_y * 25.4)
    return out_bytes, w_mm, h_mm
