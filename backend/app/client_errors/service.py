from sqlalchemy.orm import Session

from app.auth.models import User
from app.client_errors.models import ClientErrorEvent
from app.client_errors.schemas import ClientErrorCreate


def record_client_error(db: Session, data: ClientErrorCreate, user: User | None = None, request=None) -> None:
    user_agent = request.headers.get("user-agent")[:512] if request and request.headers.get("user-agent") else None
    row = ClientErrorEvent(
        user_id=user.id if user else None,
        source=data.source,
        message=data.message,
        path=data.path,
        stack=data.stack,
        user_agent=user_agent,
    )
    db.add(row)
    db.commit()


def list_client_errors(db: Session, limit: int = 100) -> list[ClientErrorEvent]:
    limit = max(1, min(limit, 1000))
    return db.query(ClientErrorEvent).order_by(ClientErrorEvent.created_at.desc()).limit(limit).all()
