#!/usr/bin/env python3
"""No-build profile recipe and shared-template invariants."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Profiles(unittest.TestCase):
    def test_live_credentials_are_only_in_the_final_layer(self):
        recipe = (ROOT / "desktop/release/debian/Containerfile.live").read_text()
        platform, live = recipe.split("FROM platform-base AS live-base", 1)
        self.assertIn("AS platform-base", platform)
        self.assertIn("polly-account-profile template", platform)
        self.assertNotIn("polly-account-profile live", platform)
        self.assertIn("polly-account-profile live", live)

    def test_installed_build_uses_a_locked_platform_not_live(self):
        recipe = (ROOT / "desktop/release/debian/Containerfile.install").read_text()
        self.assertIn("FROM ${PLATFORM_IMAGE}", recipe)
        self.assertNotIn("FROM ${LIVE_IMAGE}", recipe)
        self.assertIn("polly-account-profile installed", recipe)
        script = (ROOT / "desktop/tools/build-installed.sh").read_text()
        self.assertIn("POLLY_PLATFORM_IMAGE", script)
        self.assertIn('if [ -n "${POLLY_LIVE_IMAGE:-}" ]', script)
        self.assertNotIn('LIVE_IMAGE=$live_id', script)

    def test_factory_reuse_never_relaxes_the_installer_password_boundary(self):
        source = (ROOT / "desktop/tools/build-installed-image.py").read_text()
        self.assertIn("Only locked, unconfigured account templates may enter an image", source)
        self.assertIn('for name in ("polly", "root")', (ROOT / "desktop/release/install/accounts.py").read_text())
        helper = (ROOT / "desktop/release/debian/account-profile").read_text()
        self.assertIn('configured credentials cannot become a factory template', helper)
        self.assertIn('only the shared template may create a mode', helper)
        self.assertNotIn("passwd -l", helper)
        self.assertNotIn("usermod -L", helper)

    def test_each_session_requires_its_own_guarded_mode(self):
        for source, mode in (("desktop/release/live/session", "live"),
                             ("desktop/release/install/session", "installed")):
            text = (ROOT / source).read_text()
            self.assertIn("polly-account-profile-check " + mode, text)
        helper = (ROOT / "desktop/release/debian/profile-check").read_text()
        self.assertIn("historical fallback is unavailable", helper)
        self.assertIn("session and image profiles do not match", helper)

    def test_offline_overlay_requires_a_qualified_locked_source(self):
        recipe = (ROOT / "desktop/release/debian/Containerfile.profiles").read_text()
        self.assertIn("ARG LOCKED_BASE_IMAGE\n", recipe)
        common, live = recipe.split("FROM platform-base AS live-base", 1)
        self.assertIn("polly-account-profile template", common)
        self.assertNotIn("polly-account-profile live", common)
        self.assertIn("polly-account-profile live", live)
        self.assertNotIn("apt-get", recipe)

    def test_memory_root_has_explicit_trusted_permissions(self):
        init = (ROOT / "desktop/release/live/init").read_text()
        self.assertIn("chmod 0755 /", init)
        builder = (ROOT / "desktop/tools/build-live-image.py").read_text()
        self.assertIn('entry(".", stat.S_IFDIR | 0o755)', builder)
        recipe = (ROOT / "desktop/release/debian/Containerfile.profiles").read_text()
        self.assertIn("COPY release/live/init /init", recipe)


if __name__ == "__main__":
    unittest.main()
