from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.models import User
from app.canvases import service
from app.canvases.schemas import PreviewRenderRequest
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit

router = APIRouter(prefix="/api/canvases", tags=["canvases"])


# -------- preview (M1, ephemeral) --------
# Single SVG, NO FigureVersion created, content-hash cached (design §4),
# separate rate limit from figure_rerender. (M2 will add canvas/panel CRUD to
# this same router.)
@router.post("/preview", dependencies=[Depends(rate_limit("canvas_preview", 240, 3600))])
def preview(data: PreviewRenderRequest, db: Session = Depends(get_db),
            current_user: User = Depends(get_current_user)):
    return service.render_preview(db, current_user.id, data)
