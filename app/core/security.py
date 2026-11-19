import base64
import ipaddress
import json
import os
import posixpath
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlparse

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
    (b"<script", "HTML/script payload"),
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
    secret = settings.effective_jwt_secret()
    if not secret:
        raise RuntimeError("JWT_SECRET is not configured.")
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {
        **subject,
        "iat": int(now.timestamp()),
        "exp": int(expire.timestamp()),
        "token_use": "rf_local_session",
    }
    return jwt.encode(payload, secret, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> Dict[str, Any]:
    import jwt
    from .config import get_settings

    settings = get_settings()
    settings.validate_production_security()
    secret = settings.effective_jwt_secret()
    if not secret:
        raise RuntimeError("JWT_SECRET is not configured.")
    decoded = jwt.decode(
        token,
        secret,
        algorithms=[settings.JWT_ALGORITHM],
        options={"require": ["sub", "exp"]},
    )
    if decoded.get("token_use") != "rf_local_session":
        raise jwt.InvalidTokenError("Unexpected local token type.")
    return decoded


def validate_firebase_claims(decoded: Dict[str, Any], expected_project_id: str) -> Optional[Dict[str, Any]]:
    """Enforce audience, issuer, subject/uid consistency, auth_time/iat, and expiration timestamp checks."""
    if not isinstance(decoded, dict):
        return None
    uid = decoded.get("uid") or decoded.get("user_id") or decoded.get("sub")
    sub = decoded.get("sub") or uid
    if not uid or not sub or uid != sub:
        return None

    now_ts = int(datetime.now(timezone.utc).timestamp())
    exp = decoded.get("exp")
    if not isinstance(exp, (int, float)) or exp <= now_ts:
        return None
    iat = decoded.get("iat")
    if isinstance(iat, (int, float)) and iat > now_ts + 300:
        return None
    auth_time = decoded.get("auth_time")
    if isinstance(auth_time, (int, float)) and auth_time > now_ts + 300:
        return None

    if expected_project_id:
        aud = decoded.get("aud")
        iss = decoded.get("iss")
        expected_iss = f"https://securetoken.google.com/{expected_project_id}"
        if aud != expected_project_id or iss != expected_iss:
            return None

    return {**decoded, "uid": uid, "sub": sub}


def _normalize_service_account_dict(data: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(data, dict):
        return None
    normalized = dict(data)
    pk = normalized.get("private_key")
    if isinstance(pk, str) and "\\n" in pk:
        normalized["private_key"] = pk.replace("\\n", "\n")
    return normalized


def parse_service_account_source(raw_source: str) -> Optional[Dict[str, Any]]:
    """Parse service account credentials from raw JSON, base64/urlsafe-base64 JSON, or JSON file path."""
    cleaned = (raw_source or "").strip()
    if not cleaned:
        return None

    # Strip matching wrapping quotes when passed through shell/env loaders
    if (cleaned.startswith("'") and cleaned.endswith("'")) or (
        cleaned.startswith('"') and cleaned.endswith('"')
    ):
        inner = cleaned[1:-1].strip()
        if inner:
            cleaned = inner

    if cleaned.startswith("{"):
        try:
            return _normalize_service_account_dict(json.loads(cleaned))
        except Exception:
            return None

    potential_path = Path(cleaned)
    try:
        if potential_path.exists() and potential_path.is_file():
            return _normalize_service_account_dict(json.loads(potential_path.read_text(encoding="utf-8")))
    except Exception:
        return None

    compact = re.sub(r"\s+", "", cleaned)
    if compact:
        padded = compact + ("=" * (-len(compact) % 4))
        for decoder in (
            lambda s: base64.b64decode(s, validate=True),
            lambda s: base64.urlsafe_b64decode(s.encode("ascii")),
        ):
            try:
                decoded = decoder(padded).decode("utf-8")
                if decoded.strip().startswith("{"):
                    parsed = json.loads(decoded)
                    normalized = _normalize_service_account_dict(parsed)
                    if normalized is not None:
                        return normalized
            except Exception:
                continue
    return None


def verify_firebase_id_token(token: str) -> Optional[Dict[str, Any]]:
    from .config import get_settings

    settings = get_settings()
    project_id = settings.FIREBASE_PROJECT_ID
    if not project_id:
        cfg_path = Path("firebase-applet-config.json")
        if cfg_path.exists():
            try:
                pid = str(json.loads(cfg_path.read_text(encoding="utf-8")).get("projectId", "")).strip()
                if pid and not pid.startswith("remixed-"):
                    project_id = pid
            except Exception:
                pass

    try:
        import firebase_admin
        from firebase_admin import auth as fb_auth

        if not firebase_admin._apps:
            sa_raw = getattr(settings, "FIREBASE_SERVICE_ACCOUNT_JSON", "") or os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
            sa_dict = parse_service_account_source(sa_raw)
            options = {"projectId": project_id} if project_id else None
            if sa_dict:
                from firebase_admin import credentials as fb_credentials

                cred = fb_credentials.Certificate(sa_dict)
                firebase_admin.initialize_app(cred, options=options)
            else:
                firebase_admin.initialize_app(options=options)
        decoded = fb_auth.verify_id_token(token, check_revoked=bool(getattr(settings, "FIREBASE_CHECK_REVOKED", False)))
        return validate_firebase_claims(decoded, project_id)
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


def sanitize_filename(filename: str, default_name: str = "manuscript") -> str:
    base = posixpath.basename((filename or "").replace("\\", "/")).strip()
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base)[:100]
    return cleaned or default_name


def validate_file_signature(data: bytes, filename: str, expected_ext: Optional[str] = None) -> str:
    """Verify magic bytes match expected document/archive type and reject executables."""
    if not data:
        raise ValueError("Uploaded file is empty.")

    stripped_head = data.lstrip()[:64].lower()
    for sig, desc in DANGEROUS_SIGNATURES:
        if data.startswith(sig) or stripped_head.startswith(sig.lower()):
            raise ValueError(f"Rejected unsafe upload ({desc}).")

    ext = (expected_ext or (filename.rsplit(".", 1)[-1] if "." in filename else "")).lower().strip()
    if ext in MAGIC_SIGNATURES:
        allowed = MAGIC_SIGNATURES[ext]
        if not any(data.startswith(sig) for sig in allowed):
            raise ValueError(f"File signature does not match declared .{ext} format.")
        return ext

    if ext in {"txt", "md", "tex", "csv", "json", "bib"}:
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


def validate_outbound_https_url(url: str, allowed_hosts: set[str]) -> str:
    parsed = urlparse((url or "").strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Only public HTTPS URLs are permitted.")
    host = parsed.hostname.lower()
    if host not in allowed_hosts:
        raise ValueError(f"Host '{host}' is not in the outbound scholarly allowlist.")
    try:
        for res in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(res[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                raise ValueError("Blocked outbound access to non-public IP range.")
    except socket.gaierror:
        pass
    return parsed.geturl()
