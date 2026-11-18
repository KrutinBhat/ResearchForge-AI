from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...core.security import create_access_token, hash_password, verify_firebase_id_token, verify_password
from ...models.entities import ActivityLog, Document, Project, User
from ...schemas.common import (
    AuthUserResponse,
    FirebaseLoginRequest,
    LoginRequest,
    RegisterRequest,
    SettingsUpdateRequest,
    TokenResponse,
)
from ..deps import get_current_user

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _serialize_user(user: User) -> AuthUserResponse:
    return AuthUserResponse(
        id=user.id,
        uid=user.uid,
        email=user.email,
        name=user.name,
        institution=user.institution,
        role=user.role,
        authProvider=user.auth_provider,
        consentAnalytics=user.consent_analytics,
        consentRetention=user.consent_retention,
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == payload.email.lower()).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists.")

    user = User(
        email=payload.email.lower(),
        name=payload.name.strip(),
        institution=payload.institution.strip(),
        role=payload.role.strip() or "Researcher",
        password_hash=hash_password(payload.password),
        auth_provider="local",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token({"sub": user.id, "email": user.email})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email.lower()).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

    token = create_access_token({"sub": user.id, "email": user.email})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/firebase", response_model=TokenResponse)
def login_firebase(payload: FirebaseLoginRequest, db: Session = Depends(get_db)):
    decoded = verify_firebase_id_token(payload.idToken)
    if not decoded or not decoded.get("uid"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Firebase ID token.")
    uid = decoded["uid"]
    email = (decoded.get("email") or f"{uid}@firebase.local").lower()
    name = (decoded.get("name") or email.split("@")[0]).strip()
    user = db.query(User).filter((User.uid == uid) | (User.email == email)).first()
    if not user:
        user = User(uid=uid, email=email, name=name, auth_provider="firebase")
        db.add(user)
    else:
        user.uid = uid
        user.auth_provider = "firebase"
    db.commit()
    db.refresh(user)
    token = create_access_token({"sub": user.id, "email": user.email})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/demo", response_model=TokenResponse)
def login_demo(db: Session = Depends(get_db)):
    settings = get_settings()
    if not settings.demo_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Demo workspace is disabled in production.")

    demo_email = "demo.researcher@researchforge.edu"
    user = db.query(User).filter(User.email == demo_email).first()
    if not user:
        user = User(
            uid="demo:usr_demo_researcher",
            email=demo_email,
            name="Dr. Elena Vance",
            institution="Open Research Systems Lab",
            role="Principal Investigator",
            password_hash="",
            auth_provider="demo",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    token = create_access_token({"sub": user.id, "email": user.email})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return {"user": _serialize_user(current_user)}


@router.patch("/settings")
@router.put("/settings")
def update_settings(
    payload: SettingsUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.name is not None:
        current_user.name = payload.name.strip()
    if payload.institution is not None:
        current_user.institution = payload.institution.strip()
    if payload.role is not None:
        current_user.role = payload.role.strip()
    if payload.consentAnalytics is not None:
        current_user.consent_analytics = payload.consentAnalytics
    if payload.consentRetention is not None:
        current_user.consent_retention = payload.consentRetention

    db.commit()
    db.refresh(current_user)
    return {"user": _serialize_user(current_user)}


@router.delete("/data")
def delete_workspace_data(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    db.query(Document).filter(Document.user_id == current_user.id).delete()
    db.query(Project).filter(Project.user_id == current_user.id).delete()
    db.query(ActivityLog).filter(ActivityLog.user_id == current_user.id).delete()
    db.commit()
    return {"cleared": True}
