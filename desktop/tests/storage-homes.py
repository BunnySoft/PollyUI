#!/usr/bin/env python3
"""Small private home/compatibility tests; no credentials, image or VM."""
import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("homes",
    Path(__file__).resolve().parents[1] / "release/storage/homes.py")
homes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(homes)


@unittest.skipUnless(os.geteuid() == 0, "fresh fixture ownership requires the disposable root SDK")
class Homes(unittest.TestCase):
    def fresh(self, root, uid=1000, name="polly"):
        home = root / str(uid)
        home.mkdir(mode=0o700)
        home.chmod(0o700)
        os.chown(home, uid, uid)
        return home, {"name": name, "uid": uid, "gid": uid}

    def test_root_and_two_user_homes_keep_their_identities(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for uid, name in ((0, "root"), (1000, "polly"), (1001, "tester")):
                home, user = self.fresh(root, uid, name)
                homes.initialize(home, user)
                for name in (*homes.layout.USER_DIRECTORIES, ".local"):
                    directory = home / name
                    self.assertEqual((directory.stat().st_uid, directory.stat().st_gid), (uid, uid))
                    self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                for name, target in homes.layout.COMPATIBILITY_LINKS.items():
                    link = home / name
                    self.assertEqual(os.readlink(link), target)
                    self.assertEqual(link.lstat().st_uid, uid)
                    self.assertTrue(os.path.samestat(link.stat(), (link.parent / target).stat()))
                config = home / "Settings/user-dirs.dirs"
                self.assertEqual(config.stat().st_uid, uid)
                self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)
                self.assertIn('XDG_DOCUMENTS_DIR="$HOME/Documents"\n', config.read_text())

    def test_existing_legacy_and_product_paths_are_not_overwritten(self):
        for name, link in ((".config", False), ("Settings", False),
                           (".local", False), (".cache", True)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                home, user = self.fresh(Path(temporary))
                path = home / name
                if link:
                    path.symlink_to("missing old data")
                else:
                    path.mkdir()
                    (path / "keep").write_text("existing user state")
                before = sorted(child.name for child in home.iterdir())
                with self.assertRaisesRegex(ValueError, "explicit migration"):
                    homes.initialize(home, user)
                self.assertEqual(sorted(child.name for child in home.iterdir()), before)
                if not link:
                    self.assertEqual((path / "keep").read_text(), "existing user state")

    def test_wrong_ownership_permissions_and_identity_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            home, user = self.fresh(Path(temporary))
            for invalid in ({**user, "uid": 0}, {**user, "gid": 0},
                            {**user, "uid": True}, {**user, "name": "../polly"}):
                with self.subTest(user=invalid), self.assertRaises(ValueError):
                    homes.initialize(home, invalid)
            home.chmod(0o755)
            with self.assertRaises(ValueError):
                homes.initialize(home, user)
            self.assertEqual(list(home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
