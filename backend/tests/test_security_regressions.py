import os
import unittest

from app.assets.router import _allowed_ref
from app.common.asset_tokens import create_asset_token, signed_asset_url, verify_asset_token
from app.common.security import INTERACTIVE_FIGURE_HTML_HEADERS, security_headers_for_path
from app.config import settings


class AssetSecurityTests(unittest.TestCase):
    def test_signed_asset_token_rejects_tampering_and_expiry(self):
        ref = os.path.join(settings.figures_dir, "figure-id", "version-id", "figure.png")
        token = create_asset_token(ref)
        self.assertEqual(verify_asset_token(token), ref)
        self.assertIsNone(verify_asset_token(token + "x"))
        self.assertIsNone(verify_asset_token(create_asset_token(ref, ttl_seconds=-1)))

    def test_asset_urls_do_not_expose_r_scripts(self):
        ref = os.path.join(settings.figures_dir, "figure-id", "version-id", "figure.png")
        url = signed_asset_url(ref)
        self.assertIsNotNone(url)
        self.assertTrue(url.startswith("/api/assets/signed/"))
        self.assertIsNone(signed_asset_url(ref.removesuffix(".png") + ".R"))

    def test_asset_allowlist_is_confined_to_figure_storage(self):
        self.assertTrue(_allowed_ref(os.path.join(settings.figures_dir, "id", "figure.png")))
        self.assertFalse(_allowed_ref("/etc/passwd"))
        self.assertFalse(_allowed_ref(os.path.join(settings.figures_dir, "id", "script.R")))

    def test_signed_interactive_html_gets_frameable_headers(self):
        headers = security_headers_for_path("/api/assets/signed/token/figure.html")
        self.assertEqual(headers, INTERACTIVE_FIGURE_HTML_HEADERS)
        self.assertEqual(headers["X-Frame-Options"], "SAMEORIGIN")
        self.assertIn("frame-ancestors 'self'", headers["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
