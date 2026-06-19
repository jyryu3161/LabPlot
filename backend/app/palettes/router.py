import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.palettes import service
from app.palettes.schemas import CustomPaletteRequest, CustomPaletteResponse

router = APIRouter(prefix="/api/palettes", tags=["palettes"])


@router.get("/custom", response_model=list[CustomPaletteResponse])
def list_custom_palettes(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return [service.palette_response(row) for row in service.list_custom_palettes(db, current_user.id)]


@router.post("/custom", response_model=CustomPaletteResponse, status_code=201)
def create_custom_palette(data: CustomPaletteRequest, db: Session = Depends(get_db),
                          current_user: User = Depends(get_current_user)):
    return service.palette_response(service.create_palette(db, current_user.id, data.name, data.colors))


@router.put("/custom/{palette_id}", response_model=CustomPaletteResponse)
def update_custom_palette(palette_id: uuid.UUID, data: CustomPaletteRequest,
                          db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.palette_response(service.update_palette(db, current_user.id, palette_id, data.name, data.colors))


@router.delete("/custom/{palette_id}", status_code=204)
def delete_custom_palette(palette_id: uuid.UUID, db: Session = Depends(get_db),
                          current_user: User = Depends(get_current_user)):
    service.delete_palette(db, current_user.id, palette_id)
