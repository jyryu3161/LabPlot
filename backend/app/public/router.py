"""Public (no-auth) endpoints: a limited showcase gallery for the landing page.

Showcase = the root/admin account's ready figures (intentionally public).
Rendered images are already served by the public /static mount.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_db
from app.config import settings
from app.figures.models import Figure, FigureVersion
from app.figures.service import _url
from app.r_engine.templates import DOMAIN_LABELS, PLOT_DOMAINS

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/gallery")
def public_gallery(limit: int = 12, db: Session = Depends(get_db)):
    limit = max(1, min(limit, 200))
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        return {"figures": []}
    rows = (
        db.query(Figure, FigureVersion)
        .join(FigureVersion, Figure.current_version_id == FigureVersion.id)
        .filter(
            Figure.owner_id == root.id,
            Figure.status == "ready",
            FigureVersion.png_path.isnot(None),
        )
        .order_by(Figure.updated_at.desc())
        .limit(max(50, limit * 3))
        .all()
    )
    seen_types: set[str] = set()
    figures = []
    for f, v in rows:
        # Public gallery is a showcase, so keep one representative per plot type
        # instead of filling sections with visually duplicated examples.
        if f.plot_type in seen_types:
            continue
        seen_types.add(f.plot_type)
        thumb = _url(v.png_path)
        dom = PLOT_DOMAINS.get(f.plot_type, "basic")
        item = {"name": f.name, "plot_type": f.plot_type, "style_preset": f.style_preset, "thumb_url": thumb,
                "domain": dom, "domain_label": DOMAIN_LABELS.get(dom, dom)}
        figures.append(item)
        if len(figures) >= limit:
            break
    return {"figures": figures}


@router.get("/stats")
def public_stats(db: Session = Depends(get_db)):
    return {"plot_types": 22, "style_presets": 5, "palettes": 5}
