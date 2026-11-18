import json
import posixpath
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

MAGIC_SIGNATURES = {
    "pdf": [b"%PDF-"],
    "docx": [b"PK\x03\x04", b"PK\x05\x06"],
    "zip": [b"PK\x03\x04", b"PK\x05\x06"],
    "doc": [b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"],
    "rtf": [b"{\\rtf"],
}

DANGEROUS_SIGNATURES = [
    (b"MZ", "Windows executable payload"),
    (b"\x7fELF", "ELF executable binary"),
    (b"#!/", "Shell script payload"),
    (b"<?php", "PHP script payload"),
]

_pwd_context = None


def _get_pwd_context():
    global _pwd_context
    if _pwd_context is None:
        from passlib.context import CryptContext

        _pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
    return _pwd_context


def hash_password(password: str) -> str:
    return _get_pwd_context().hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    return _get_pwd_context().verify(plain_password, password_hash)


def create_access_token(subject: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    import jwt
    from .config import get_settings

    settings = get_settings()
    settings.validate_production_security()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    payload = {**subject, "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> Dict[str, Any]:
    import jwt
    from .config import get_settings

    settings = get_settings()
    settings.validate_production_security()
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])


def verify_firebase_id_token(token: str) -> Optional[Dict[str, Any]]:
    try:
        import firebase_admin
        from firebase_admin import auth as fb_auth
        from .config import get_settings

        if not firebase_admin._apps:
            project_id = get_settings().FIREBASE_PROJECT_ID
            cfg_path = Path("firebase-applet-config.json")
            if not project_id and cfg_path.exists():
                project_id = json.loads(cfg_path.read_text(encoding="utf-8")).get("projectId", "")
            firebase_admin.initialize_app(options={"projectId": project_id} if project_id else None)
        decoded = fb_auth.verify_id_token(token)
        return decoded
    except Exception:
        return None


def is_safe_archive_path(entry_path: str) -> bool:
    """Prevent ZIP slip / path traversal and absolute paths."""
    if not entry_path or "\x00" in entry_path:
        return False
    cleaned = entry_path.replace("\\", "/")
    if cleaned.startswith("/") or (len(cleaned) > 1 and cleaned[1] == ":"):
        return False
    normalized = posixpath.normpath(cleaned)
    if normalized.startswith("..") or "/../" in normalized or normalized == ".":
        return False
    return True


def validate_file_signature(data: bytes, filename: str, expected_ext: Optional[str] = None) -> str:
    """Verify magic bytes match expected document/archive type and reject executables."""
    if not data:
        raise ValueError("Uploaded file is empty.")

    for sig, desc in DANGEROUS_SIGNATURES:
        if data.startswith(sig):
            raise ValueError(f"Rejected unsafe upload ({desc}).")

    ext = (expected_ext or (filename.rsplit(".", 1)[-1] if "." in filename else "")).lower().strip()
    if ext in MAGIC_SIGNATURES:
        allowed = MAGIC_SIGNATURES[ext]
        if not any(data.startswith(sig) for sig in allowed):
            raise ValueError(f"File signature does not match declared .{ext} format.")
        return ext

    if ext in {"txt", "md", "tex", "csv", "json"}:
        if b"\x00" in data[:4096]:
            raise ValueError(f"Binary null bytes detected inside text .{ext} file.")
        return ext

    raise ValueError(f"Unsupported or unrecognized file extension '.{ext}'.")


def validate_public_github_url(url: str) -> tuple[str, str]:
    cleaned = (url or "").strip()
    m = re.match(r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)(?:\.git)?/?$", cleaned)
    if not m:
        raise ValueError("Only public HTTPS GitHub URLs of the form https://github.com/<owner>/<repo> are allowed.")
    return m.group(1), m.group(2).removesuffix(".git")
