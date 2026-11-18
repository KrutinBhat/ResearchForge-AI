from fastapi import Depends, HTTPException, UploadFile, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.database import get_db
from ..core.security import decode_access_token, verify_firebase_id_token
from ..models.entities import ActivityLog, User

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    token = credentials.credentials.strip()
    try:
        payload = decode_access_token(token)
        user_id = payload.get("sub")
        if user_id:
            user = db.query(User).filter(User.id == user_id).first()
            if user is not None:
                return user
    except Exception:
        pass

    fb_decoded = verify_firebase_id_token(token)
    if fb_decoded and fb_decoded.get("uid"):
        uid = fb_decoded["uid"]
        email = (fb_decoded.get("email") or f"{uid}@firebase.local").lower()
        user = db.query(User).filter((User.uid == uid) | (User.email == email)).first()
        if user is None:
            user = User(
                uid=uid,
                email=email,
                name=(fb_decoded.get("name") or email.split("@")[0]),
                auth_provider="firebase",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        elif user.uid != uid:
            user.uid = uid
            user.auth_provider = "firebase"
            db.commit()
        return user

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token.")


async def read_validated_upload(file: UploadFile) -> bytes:
    settings = get_settings()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    if len(data) > settings.MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    return data


def record_activity(db: Session, user_id: str, module: str, action: str, entity_title: str, status_label: str = "Completed") -> None:
    log = ActivityLog(
        user_id=user_id,
        module=module,
        action=action,
        entity_title=entity_title,
        status=status_label,
    )
    db.add(log)
    db.commit()
