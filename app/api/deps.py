from typing import Type, TypeVar
from fastapi import Depends, HTTPException, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.database import get_db
from ..core.security import decode_access_token, verify_firebase_id_token
from ..models.entities import ActivityLog, User

bearer_scheme = HTTPBearer(auto_error=False)
ModelT = TypeVar("ModelT")


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    token = credentials.credentials.strip()
    settings = get_settings()

    # 1. Try verified local session JWT (only valid for local/demo accounts, never Firebase accounts)
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if user_id:
            user = db.query(User).filter(User.id == user_id).first()
            if user is not None:
                if user.auth_provider == "firebase":
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Firebase accounts must authenticate using a valid Firebase ID token.",
                    )
                if user.auth_provider == "demo" and not settings.demo_enabled:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Demo workspace sessions are disabled in production.",
                    )
                return user
    except HTTPException:
        raise
    except Exception:
        pass

    # 2. Verify live Firebase ID token via Firebase Admin SDK
    fb_decoded = verify_firebase_id_token(token)
    if fb_decoded and fb_decoded.get("uid"):
        uid = fb_decoded["uid"]
        email = (fb_decoded.get("email") or f"{uid}@firebase.local").lower()
        user = db.query(User).filter(User.uid == uid).first()
        if user is None:
            by_email = db.query(User).filter(User.email == email).first()
            if by_email is not None:
                if by_email.auth_provider == "demo":
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Cannot link Firebase account to isolated demo workspace.",
                    )
                by_email.uid = uid
                by_email.auth_provider = "firebase"
                db.commit()
                db.refresh(by_email)
                return by_email

            user = User(
                uid=uid,
                email=email,
                name=(fb_decoded.get("name") or email.split("@")[0]).strip(),
                role="Researcher",
                auth_provider="firebase",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        return user

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token.")


def get_owned_or_404(
    db: Session,
    model: Type[ModelT],
    record_id: str,
    user_id: str,
    detail: str = "Resource not found.",
) -> ModelT:
    row = db.query(model).filter(model.id == record_id, model.user_id == user_id).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    return row


async def read_validated_upload(file: UploadFile) -> bytes:
    settings = get_settings()
    chunks: list[bytes] = []
    size = 0
    try:
        while chunk := await file.read(min(1024 * 1024, settings.MAX_UPLOAD_BYTES + 1 - size)):
            size += len(chunk)
            if size > settings.MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"File exceeds {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
                )
            chunks.append(chunk)
    finally:
        await file.close()

    if size == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    return b"".join(chunks)


def record_activity(db: Session, user_id: str, module: str, action: str, entity_title: str, status_label: str = "Completed") -> None:
    log = ActivityLog(
        user_id=user_id,
        module=module,
        action=action,
        entity_title=entity_title[:240],
        status=status_label,
    )
    db.add(log)
    db.commit()
