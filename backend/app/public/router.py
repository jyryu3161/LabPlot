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
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        return {"figures": []}
    figs = (db.query(Figure)
            .filter(Figure.owner_id == root.id, Figure.status == "ready")
            .order_by(Figure.updated_at.desc())
            .all())
    seen_types: set[str] = set()
    primary, extra = [], []
    for f in figs:
        v = db.query(FigureVersion).filter(FigureVersion.id == f.current_version_id).first()
        thumb = _url(v.png_path) if v else None
        if not thumb:
            continue
        dom = PLOT_DOMAINS.get(f.plot_type, "basic")
        item = {"name": f.name, "plot_type": f.plot_type, "style_preset": f.style_preset, "thumb_url": thumb,
                "domain": dom, "domain_label": DOMAIN_LABELS.get(dom, dom)}
        # prefer one-per-plot-type first for visual variety, then fill with the rest
        if f.plot_type not in seen_types:
            seen_types.add(f.plot_type)
            primary.append(item)
        else:
            extra.append(item)
    return {"figures": (primary + extra)[:limit]}


@router.get("/stats")
def public_stats(db: Session = Depends(get_db)):
    return {"plot_types": 9, "journal_styles": 5, "palettes": 5}
