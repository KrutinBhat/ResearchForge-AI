import io
import os
import sys
import types
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import base64
import json
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect
from app.api import deps
from app.core.security import (
    is_safe_archive_path,
    parse_service_account_source,
    sanitize_filename,
    validate_firebase_claims,
    validate_outbound_https_url,
    verify_firebase_id_token,
)
from app.services.export_service import (
    verify_exported_docx_bytes,
    verify_exported_pdf_bytes,
)
from app.services.project_analyzer_service import extract_and_analyze_zip

try:
    import alembic  # noqa: F401
    import sqlalchemy  # noqa: F401

    HAS_DB_STACK = True
except ImportError:
    HAS_DB_STACK = False


class TestSecurityClaimsAndExports(unittest.TestCase):
    def test_validate_firebase_claims_strict_enforcement(self):
        future_exp = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp())
        past_exp = int((datetime.now(timezone.utc) - timedelta(minutes=5)).timestamp())
        project_id = "rf-prod-project"

        valid = {
            "uid": "user_abc",
            "sub": "user_abc",
            "aud": project_id,
            "iss": f"https://securetoken.google.com/{project_id}",
            "exp": future_exp,
            "email": "researcher@university.edu",
        }
        parsed = validate_firebase_claims(valid, project_id)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["uid"], "user_abc")

        self.assertIsNone(validate_firebase_claims({**valid, "exp": past_exp}, project_id))
        self.assertIsNone(validate_firebase_claims({**valid, "aud": "wrong-project"}, project_id))
        self.assertIsNone(
            validate_firebase_claims({**valid, "iss": "https://securetoken.google.com/wrong-project"}, project_id)
        )
        self.assertIsNone(validate_firebase_claims({**valid, "sub": "other_uid"}, project_id))

    def test_verify_firebase_id_token_handles_revocation_and_valid_claims(self):
        future_exp = int((datetime.now(timezone.utc) + timedelta(minutes=20)).timestamp())
        fake_fb = types.ModuleType("firebase_admin")
        fake_fb._apps = [object()]
        fake_fb.initialize_app = MagicMock()
        fake_auth = types.ModuleType("firebase_admin.auth")
        fake_auth.verify_id_token = MagicMock(
            return_value={
                "uid": "fb_uid_1",
                "sub": "fb_uid_1",
                "aud": "rf-proj",
                "iss": "https://securetoken.google.com/rf-proj",
                "exp": future_exp,
            }
        )
        fake_fb.auth = fake_auth

        fake_cfg = MagicMock()
        fake_cfg.FIREBASE_PROJECT_ID = "rf-proj"
        fake_cfg.FIREBASE_CHECK_REVOKED = True
        fake_cfg_mod = types.ModuleType("app.core.config")
        fake_cfg_mod.get_settings = lambda: fake_cfg

        with patch.dict(
            sys.modules,
            {
                "firebase_admin": fake_fb,
                "firebase_admin.auth": fake_auth,
                "app.core.config": fake_cfg_mod,
            },
        ):
            claims = verify_firebase_id_token("valid.jwt.token")
            self.assertIsNotNone(claims)
            fake_auth.verify_id_token.assert_called_once_with("valid.jwt.token", check_revoked=True)

            fake_auth.verify_id_token.side_effect = RuntimeError("RevokedIdTokenError")
            self.assertIsNone(verify_firebase_id_token("revoked.jwt.token"))

    def test_ssrf_and_zip_bomb_protections(self):
        self.assertEqual(
            validate_outbound_https_url("https://api.openalex.org/works", {"api.openalex.org"}),
            "https://api.openalex.org/works",
        )
        with self.assertRaises(ValueError):
            validate_outbound_https_url("http://api.openalex.org/works", {"api.openalex.org"})
        with self.assertRaises(ValueError):
            validate_outbound_https_url("https://169.254.169.254/latest", {"api.openalex.org"})

        self.assertEqual(sanitize_filename("../../evil<name>.pdf"), "evil_name_.pdf")
        self.assertFalse(is_safe_archive_path("..\\windows\\system32\\cmd.exe"))

        # High compression ratio test (> 100:1) should safely skip or reject oversized payloads
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("src/app.py", "def ok(): return 1\n")
            # Highly compressible blob (> 600KB zeros compresses to < 1KB -> ratio > 500:1)
            zf.writestr("src/zeros.py", "a" * 650_000)
        analysis = extract_and_analyze_zip(buf.getvalue())
        self.assertGreaterEqual(len(analysis["skippedUnsafePaths"]), 1)

    def test_export_validators_ooxml_and_pdf(self):
        # Minimal IEEE DOCX zip structure
        ieee_buf = io.BytesIO()
        with zipfile.ZipFile(ieee_buf, "w") as zf:
            zf.writestr(
                "word/document.xml",
                '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p>'
                '<w:sectPr><w:pgMar w:top="1080"/><w:cols w:num="2"/></w:sectPr></w:body></w:document>',
            )
        meta_ieee = verify_exported_docx_bytes(ieee_buf.getvalue(), expected_style="IEEE")
        self.assertTrue(meta_ieee["validZip"])
        self.assertTrue(meta_ieee["hasTwoColumns"])
        self.assertTrue(meta_ieee["hasMargins"])

        with self.assertRaises(ValueError):
            verify_exported_docx_bytes(ieee_buf.getvalue(), expected_style="APA")

        with self.assertRaises(ValueError):
            verify_exported_pdf_bytes(b"NOT_A_PDF")
        with self.assertRaises(ValueError):
            verify_exported_pdf_bytes(b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF")
        with self.assertRaises(ValueError):
            verify_exported_pdf_bytes(b"%PDF-1.4\n3 0 obj\n<< /Type /Page >>\nendobj")

        # Ensure /Type /Pages catalog object is never miscounted as a page
        single_page_pdf = (
            b"%PDF-1.4\n"
            b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
            b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n%%EOF"
        )
        pdf_meta = verify_exported_pdf_bytes(single_page_pdf)
        self.assertTrue(pdf_meta["validPdf"])
        self.assertEqual(pdf_meta["pageCount"], 1)

        two_page_pdf = single_page_pdf.replace(
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj",
            b"3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n4 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj",
        )
        self.assertEqual(verify_exported_pdf_bytes(two_page_pdf)["pageCount"], 2)

    def test_firebase_service_account_parsing_and_opt_in_revocation(self):
        sample_sa = {
            "type": "service_account",
            "project_id": "rf-prod",
            "client_email": "firebase-adminsdk@rf-prod.iam.gserviceaccount.com",
            "private_key": "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
        }
        raw_parsed = parse_service_account_source(json.dumps(sample_sa))
        self.assertEqual(raw_parsed["project_id"], "rf-prod")

        b64_sa = base64.b64encode(json.dumps(sample_sa).encode("utf-8")).decode("ascii")
        b64_parsed = parse_service_account_source(b64_sa)
        self.assertEqual(b64_parsed["client_email"], sample_sa["client_email"])

        # Wrapped multiline base64 + outer quotes + unpadded URL-safe base64 + double-escaped \\n
        wrapped_b64 = f'"{b64_sa[:40]}\n  {b64_sa[40:]}"'
        self.assertEqual(parse_service_account_source(wrapped_b64)["project_id"], "rf-prod")
        urlsafe_unpadded = base64.urlsafe_b64encode(
            json.dumps({**sample_sa, "private_key": "line1\\nline2"}).encode("utf-8")
        ).decode("ascii").rstrip("=")
        urlsafe_parsed = parse_service_account_source(urlsafe_unpadded)
        self.assertIsNotNone(urlsafe_parsed)
        self.assertIn("\n", urlsafe_parsed["private_key"])
        self.assertNotIn("\\n", urlsafe_parsed["private_key"])
        self.assertIsNone(parse_service_account_source(""))

        future_iat = int((datetime.now(timezone.utc) + timedelta(minutes=20)).timestamp())
        future_exp = int((datetime.now(timezone.utc) + timedelta(minutes=40)).timestamp())
        self.assertIsNone(
            validate_firebase_claims(
                {
                    "uid": "u1",
                    "sub": "u1",
                    "aud": "rf-prod",
                    "iss": "https://securetoken.google.com/rf-prod",
                    "exp": future_exp,
                    "iat": future_iat,
                },
                "rf-prod",
            )
        )

        # Verify opt-in check_revoked=False default behavior
        fake_fb = types.ModuleType("firebase_admin")
        fake_fb._apps = [object()]
        fake_fb.initialize_app = MagicMock()
        fake_auth = types.ModuleType("firebase_admin.auth")
        fake_auth.verify_id_token = MagicMock(
            return_value={
                "uid": "fb_uid_2",
                "sub": "fb_uid_2",
                "aud": "rf-proj",
                "iss": "https://securetoken.google.com/rf-proj",
                "exp": future_exp,
            }
        )
        fake_fb.auth = fake_auth

        fake_creds = types.ModuleType("firebase_admin.credentials")
        fake_creds.Certificate = MagicMock(return_value="mock-cert")
        fake_fb.credentials = fake_creds

        fake_cfg = MagicMock()
        fake_cfg.FIREBASE_PROJECT_ID = "rf-proj"
        fake_cfg.FIREBASE_CHECK_REVOKED = False
        fake_cfg.FIREBASE_SERVICE_ACCOUNT_JSON = ""
        fake_cfg_mod = types.ModuleType("app.core.config")
        fake_cfg_mod.get_settings = lambda: fake_cfg

        with patch.dict(
            sys.modules,
            {
                "firebase_admin": fake_fb,
                "firebase_admin.auth": fake_auth,
                "firebase_admin.credentials": fake_creds,
                "app.core.config": fake_cfg_mod,
            },
        ):
            claims = verify_firebase_id_token("valid.jwt.token")
            self.assertIsNotNone(claims)
            fake_auth.verify_id_token.assert_called_once_with("valid.jwt.token", check_revoked=False)

    def test_alembic_logging_fileconfig_succeeds_without_qualname_error(self):
        import logging.config

        logging.config.fileConfig("alembic.ini", disable_existing_loggers=False)


@unittest.skipUnless(HAS_DB_STACK, "SQLAlchemy/Alembic packages not installed in Node-only sandbox")
class TestAlembicMigrationChain(unittest.TestCase):
    def test_alembic_sqlite_upgrade_to_head(self):
        from alembic import command
        from alembic.config import Config
        from app.core import config as app_config

        with tempfile.TemporaryDirectory(prefix="researchforge-migration-") as temp_dir:
            database_path = Path(temp_dir) / "migration.db"
            database_url = f"sqlite:///{database_path.as_posix()}"
            cfg = Config("alembic.ini")
            with patch.dict(os.environ, {"ENVIRONMENT": "development", "DATABASE_URL": database_url}):
                app_config.get_settings.cache_clear()
                try:
                    command.upgrade(cfg, "head")
                    engine = create_engine(database_url)
                    try:
                        tables = set(inspect(engine).get_table_names())
                        self.assertTrue({"users", "documents", "alembic_version"}.issubset(tables))
                        command.downgrade(cfg, "base")
                        self.assertEqual(set(inspect(engine).get_table_names()), {"alembic_version"})
                    finally:
                        engine.dispose()
                finally:
                    app_config.get_settings.cache_clear()


class TestBoundedUploadRead(IsolatedAsyncioTestCase):
    async def test_upload_is_read_in_chunks_and_closed(self):
        class Settings:
            MAX_UPLOAD_BYTES = 8

        upload = types.SimpleNamespace(
            read=AsyncMock(side_effect=[b"abcd", b"efgh", b""]),
            close=AsyncMock(),
        )
        with patch.object(deps, "get_settings", return_value=Settings()):
            self.assertEqual(await deps.read_validated_upload(upload), b"abcdefgh")
        self.assertEqual(upload.read.await_count, 3)
        upload.close.assert_awaited_once()

    async def test_oversized_upload_stops_reading_and_closes(self):
        class Settings:
            MAX_UPLOAD_BYTES = 4

        upload = types.SimpleNamespace(
            read=AsyncMock(side_effect=[b"abcd", b"e", b"must not be read"]),
            close=AsyncMock(),
        )
        with patch.object(deps, "get_settings", return_value=Settings()):
            with self.assertRaises(HTTPException) as raised:
                await deps.read_validated_upload(upload)
        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(upload.read.await_count, 2)
        upload.close.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
