from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...core.database import get_db
from ...core.rate_limit import limiter
from ...core.security import create_access_token, hash_password, verify_firebase_id_token, verify_password
from ...models.entities import (
    ActivityLog,
    AnalysisJob,
    Citation,
    CitationCheck,
    CorpusChunk,
    Document,
    IntegrityAudit,
    Project,
    QualityEvaluation,
    RefinementJob,
    SimilarityReport,
    User,
    WritingAnalysis,
)
from ...schemas.common import (
    AuthUserResponse,
    FirebaseLoginRequest,
    LoginRequest,
    RegisterRequest,
    SettingsUpdateRequest,
    TokenResponse,
)
from ..deps import get_current_user, record_activity

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


auth_settings = get_settings()


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(f"{auth_settings.AUTH_RATE_LIMIT_PER_MINUTE}/minute")
def register(request: Request, payload: RegisterRequest, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists.")

    # Role is strictly server-assigned; never accept client-supplied privilege roles.
    user = User(
        email=email,
        name=payload.name.strip(),
        institution=payload.institution.strip(),
        role="Researcher",
        password_hash=hash_password(payload.password),
        auth_provider="local",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token({"sub": user.id, "email": user.email, "provider": "local"})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/login", response_model=TokenResponse)
@limiter.limit(f"{auth_settings.AUTH_RATE_LIMIT_PER_MINUTE}/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    user = db.query(User).filter(User.email == email).first()
    if not user or user.auth_provider in {"firebase", "demo"} or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password.")

    token = create_access_token({"sub": user.id, "email": user.email, "provider": "local"})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/firebase", response_model=TokenResponse)
@limiter.limit(f"{auth_settings.AUTH_RATE_LIMIT_PER_MINUTE}/minute")
def login_firebase(request: Request, payload: FirebaseLoginRequest, db: Session = Depends(get_db)):
    decoded = verify_firebase_id_token(payload.idToken)
    if not decoded or not decoded.get("uid"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired Firebase ID token.")

    uid = decoded["uid"]
    email = (decoded.get("email") or f"{uid}@firebase.local").lower().strip()
    name = (decoded.get("name") or email.split("@")[0]).strip()

    user = db.query(User).filter(User.uid == uid).first()
    if user is None:
        by_email = db.query(User).filter(User.email == email).first()
        if by_email is not None:
            if by_email.auth_provider == "demo":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Isolated demo user cannot sign in via Firebase.")
            by_email.uid = uid
            by_email.auth_provider = "firebase"
            user = by_email
        else:
            user = User(
                uid=uid,
                email=email,
                name=name,
                role="Researcher",
                auth_provider="firebase",
            )
            db.add(user)
    else:
        user.email = email
        if name:
            user.name = name
        user.auth_provider = "firebase"

    db.commit()
    db.refresh(user)
    # Return the validated live Firebase ID token itself so expiration & revocation remain bound to Firebase.
    return TokenResponse(token=payload.idToken, user=_serialize_user(user))


@router.post("/demo", response_model=TokenResponse)
@limiter.limit(f"{auth_settings.AUTH_RATE_LIMIT_PER_MINUTE}/minute")
def login_demo(request: Request, db: Session = Depends(get_db)):
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
            role="Demo Workspace",
            password_hash="",
            auth_provider="demo",
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    token = create_access_token({"sub": user.id, "email": user.email, "provider": "demo"})
    return TokenResponse(token=token, user=_serialize_user(user))


@router.post("/logout")
def logout_session(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    record_activity(db, current_user.id, "Authentication", "Signed out of workspace", current_user.email)
    return {"loggedOut": True}


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
    if payload.consentAnalytics is not None:
        current_user.consent_analytics = payload.consentAnalytics
    if payload.consentRetention is not None:
        current_user.consent_retention = payload.consentRetention

    db.commit()
    db.refresh(current_user)
    return {"updated": True, "user": _serialize_user(current_user)}


@router.delete("/data")
def delete_workspace_data(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    uid = current_user.id
    db.query(RefinementJob).filter(RefinementJob.user_id == uid).delete()
    db.query(AnalysisJob).filter(AnalysisJob.user_id == uid).delete()
    db.query(CorpusChunk).filter(CorpusChunk.user_id == uid).delete()
    db.query(Citation).filter(Citation.user_id == uid).delete()
    db.query(SimilarityReport).filter(SimilarityReport.user_id == uid).delete()
    db.query(WritingAnalysis).filter(WritingAnalysis.user_id == uid).delete()
    db.query(CitationCheck).filter(CitationCheck.user_id == uid).delete()
    db.query(QualityEvaluation).filter(QualityEvaluation.user_id == uid).delete()
    db.query(IntegrityAudit).filter(IntegrityAudit.user_id == uid).delete()
    db.query(Document).filter(Document.user_id == uid).delete()
    db.query(Project).filter(Project.user_id == uid).delete()
    db.query(ActivityLog).filter(ActivityLog.user_id == uid).delete()
    db.commit()
    return {"cleared": True}
