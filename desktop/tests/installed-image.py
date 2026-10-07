#!/usr/bin/env python3
"""Bounded layout/export validation; no block devices or mounts."""
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location("installed_builder",
    Path(__file__).resolve().parents[1] / "tools/build-installed-image.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def archive(entries):
    contents = io.BytesIO()
    with tarfile.open(fileobj=contents, mode="w") as target:
        for name, kind, link in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = link
            target.addfile(member)
    contents.seek(0)
    return tarfile.open(fileobj=contents, mode="r:")


class InstalledImage(unittest.TestCase):
    def test_installed_login_overrides_live_autologin(self):
        self.assertGreater(Path(builder.GETTY_DROPIN).name, "polly.conf")

    def test_no_personal_password_templates(self):
        passwd = "root:x:0:0::/root:/bin/sh\npolly:x:1000:1000::/home/polly:/bin/sh\n"
        shadow = "root:!:20732:0:99999:7:::\npolly:!:20732:0:99999:7:::\n"
        self.assertEqual(len(builder.account_templates(passwd, shadow)[1]), 2)
        for invalid in (shadow.replace("root:!", "root:!$y$personal"),
                        shadow.replace("polly:!", "polly:"),
                        shadow.replace("root:!", "root:$6$personal"),
                        shadow + shadow):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                builder.account_templates(passwd, invalid)

    def test_layout(self):
        parts, size = builder.layout(3072, 2048)
        self.assertEqual([p["name"] for p in parts], ["EFI", "A", "B", "DATA"])
        self.assertEqual([p["sizeMiB"] for p in parts], [256, 3072, 3072, 2048])
        self.assertEqual(len({p["uuid"] for p in parts}), 4)
        for left, right in zip(parts, parts[1:]):
            self.assertEqual(left["startSector"] + left["sectors"], right["startSector"])
        self.assertEqual(size, (256 + 3072 * 2 + 2048 + 2) * builder.MIB)

    def test_bounds(self):
        for system, data in [(3071, 2048), (3072, 2047), (16385, 2048), (3072, 32769)]:
            with self.subTest(system=system, data=data), self.assertRaises(ValueError):
                builder.layout(system, data)

    def test_export(self):
        with archive([("usr", tarfile.DIRTYPE, ""), ("usr/lib", tarfile.DIRTYPE, ""),
                      ("lib", tarfile.SYMTYPE, "usr/lib"), ("usr/lib/library", tarfile.REGTYPE, ""),
                      ("run/socket", tarfile.FIFOTYPE, "")]) as source:
            self.assertEqual(len(builder.export_members(source)), 4)

    def test_unsafe_export(self):
        cases = [
            [("../escape", tarfile.REGTYPE, "")], [("/escape", tarfile.REGTYPE, "")],
            [("x", tarfile.REGTYPE, ""), ("x", tarfile.REGTYPE, "")],
            [("lib", tarfile.SYMTYPE, "usr/lib"), ("lib/file", tarfile.REGTYPE, "")],
            [("x", tarfile.LNKTYPE, "../escape")], [("x", tarfile.FIFOTYPE, "")],
            [("x", tarfile.LNKTYPE, "run/file"), ("run/file", tarfile.REGTYPE, "")],
        ]
        for entries in cases:
            with self.subTest(entries=entries), archive(entries) as source, self.assertRaises(ValueError):
                builder.export_members(source)


if __name__ == "__main__":
    unittest.main()
