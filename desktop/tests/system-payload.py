#!/usr/bin/env python3
"""T07.1 ordinary synthetic Linux trees; no mounts, apt, images, native build or VM."""
import copy
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


payload = load("test_system_payload", REPO / "desktop/release/maintenance/payload.py")
builder = load("test_payload_builder", REPO / "desktop/tools/build-storage-image.py")
MIB = payload.layout.MIB
VERSION = "0.1.0-alpha.1"
SCHEMAS = {"accounts": [3], "applications": [1], "services": [2], "users": [1]}
CURRENT = {"accounts": 3, "applications": 1, "services": 2, "users": 1}


class SystemPayload(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polly-t071-payload-")
        self.addCleanup(self.temporary.cleanup)
        self.stage = Path(self.temporary.name)
        self.system, self.persistent = self.stage / "system", self.stage / "persistent"
        for name in ("usr", "boot", "etc", "System/Resources/bin", "System/Resources/sbin",
                     "System/Resources/share", "System/Resources/lib/modules/6.1-probe",
                     "System/Boot"):
            (self.system / name).mkdir(parents=True, exist_ok=True)
        for name in ("SystemData/Library/Dpkg/info", "SystemData/Library/Apt/lists",
                     "Users/1000", "SystemData/Accounts"):
            (self.persistent / name).mkdir(parents=True, exist_ok=True)
        self.dpkg = self.persistent / "SystemData/Library/Dpkg"
        self.apt = self.persistent / "SystemData/Library/Apt"
        self.inventory = self.system / payload.INVENTORY_PATH
        self.program = self.system / "System/Resources/bin/probe"
        self.program.write_bytes(b"complete native runtime")
        self.program.chmod(0o755)
        for name in ("vmlinuz-6.1-probe", "initrd.img-6.1-probe", "intel-ucode.img"):
            (self.system / "System/Boot" / name).write_bytes(b"boot fixture")
        (self.system / "System/Resources/lib/os-release").write_text(
            'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n')
        (self.system / "etc/polly-storage.json").write_text(
            json.dumps(payload.layout.contract(payload.layout.new_volume_uuids())))
        (self.system / "etc/version-related.conf").write_text("package config baseline\n")
        self.status = (
            "Package: probe\nStatus: install ok installed\nArchitecture: amd64\n"
            "Version: 1:2.0-3\nHomepage: https://example.invalid/probe\n"
            "Description: probe\n continued description\n\n")
        (self.dpkg / "status").write_text(self.status)
        self.inventory.write_text("probe\t1:2.0-3\thttps://example.invalid/probe\n")
        (self.dpkg / "info/probe.list").write_text(
            "/.\n/usr\n/usr/bin\n/usr/bin/probe\n/boot/vmlinuz-6.1-probe\n")
        (self.dpkg / "info/probe.md5sums").write_text(
            hashlib.md5(self.program.read_bytes()).hexdigest() + "  usr/bin/probe\n" +
            hashlib.md5(b"boot fixture").hexdigest() + "  boot/vmlinuz-6.1-probe\n")
        (self.apt / "extended_states").write_text("Package: probe\nAuto-Installed: 0\n")
        self.value = self.capture()

    def capture(self, **kwargs):
        options = {"version": VERSION, "overhead_bytes": dict.fromkeys(("SYSTEM", "PERSISTENT"), 16 * MIB),
                   "reserve_bytes": dict.fromkeys(("SYSTEM", "PERSISTENT"), 32 * MIB),
                   "accepts_schemas": copy.deepcopy(SCHEMAS)}
        options.update(kwargs)
        return payload.capture(self.system, self.persistent, **options)

    def preflight(self, value=None, **kwargs):
        value = self.value if value is None else value
        options = {"expected_version": VERSION, "distribution": dict(payload.DISTRIBUTION),
                   "architecture": "amd64",
                   "available_bytes": {item["role"]: item["minimumBytes"] for item in value["capacity"]},
                   "current_schemas": dict(CURRENT)}
        options.update(kwargs)
        return payload.preflight(value, self.system, self.persistent, **options)

    def test_codec_and_evidence_are_deterministic(self):
        self.assertEqual(payload.decode(payload.encode(self.value)), self.value)
        self.assertEqual(payload.encode(self.capture()), payload.encode(self.value))
        self.assertEqual(self.preflight(), self.preflight())
        evidence = self.preflight()
        self.assertTrue(evidence["readOnly"])
        self.assertFalse(evidence["authenticated"])
        self.assertFalse(evidence["bootVerified"])
        self.assertEqual(evidence["materialIds"], ["system", "dpkg", "apt"])
        self.assertEqual(evidence["packageRecords"], 1)
        self.assertEqual(evidence["runtimePaths"], 4)

    def test_exact_shape_and_strict_types(self):
        mutations = [
            lambda v: v.update(extra="unknown"),
            lambda v: v.pop("materials"),
            lambda v: v.update(schemaVersion=True),
            lambda v: v.update(schemaVersion=2),
            lambda v: v.update(storageSchemaVersion=True),
            lambda v: v.update(trust="production-signed"),
            lambda v: v.update(distribution={**v["distribution"], "extra": 1}),
            lambda v: v.update(architecture="x86_64"),
            lambda v: v.update(architecture="arm64"),
            lambda v: v.update(architecture=False),
            lambda v: v.update(materials=v["materials"][:2]),
            lambda v: v["materials"].reverse(),
            lambda v: v["materials"][1].update(id="system"),
            lambda v: v["materials"][0].update(path="../root"),
            lambda v: v["materials"][0].update(inventorySha256="A" * 64),
            lambda v: v["materials"][0].update(inventorySha256="a" * 63),
            lambda v: v["materials"][0].update(nodes=True),
            lambda v: v["materials"][0].update(nodes=0),
            lambda v: v["materials"][0].update(nodes=payload.MAX_NODES + 1),
            lambda v: v["materials"][0].update(contentBytes=-1),
            lambda v: v["materials"][0].update(measuredBytes=False),
            lambda v: v["materials"][0].update(contentBytes=payload.MAX_BYTES + 1),
            lambda v: v["packageProof"].update(extra=False),
            lambda v: v["packageProof"].update(records=False),
            lambda v: v["packageProof"].update(installedRecords=2),
            lambda v: v["packageProof"]["status"].update(bytes=True),
            lambda v: v["packageProof"]["inventory"].update(bytes=payload.MAX_RECORD_BYTES + 1),
            lambda v: v["packageProof"]["status"].update(path="var/lib/dpkg/status"),
            lambda v: v["packageProof"].update(qualification="package-list-hash"),
            lambda v: v["capacity"][0].update(reserveBytes=0),
            lambda v: v["capacity"][0].update(overheadBytes=16 * MIB - 1),
            lambda v: v["capacity"][0].update(minimumBytes=True),
            lambda v: v["capacity"][0].update(minimumBytes=v["capacity"][0]["minimumBytes"] + 1),
            lambda v: v["capacity"][1].update(role="SYSTEM"),
            lambda v: v["compatibility"][1].update(id="accounts"),
            lambda v: v["compatibility"][0].update(policy="reset"),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[True]),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[3, 3]),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[3, 2]),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[0]),
            lambda v: v["compatibility"][0].update(acceptsSchemas=[payload.MAX_SCHEMA + 1]),
        ]
        for mutation in mutations:
            value = copy.deepcopy(self.value)
            mutation(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                payload.validate(value)

    def test_version_and_size_boundaries(self):
        for version in ("1.2.3", "0.0.0", "1.2.3-alpha.0"):
            value = copy.deepcopy(self.value)
            value["version"] = version
            self.assertEqual(payload.validate(value)["version"], version)
        for version in (True, "", "01.2.3", "1.2", "v1.2.3", "1.2.3-alpha.01",
                        "1.2.3\n", "1.2.3+unknown", "9" * 65):
            value = copy.deepcopy(self.value)
            value["version"] = version
            with self.subTest(version=version), self.assertRaises(ValueError):
                payload.validate(value)
        value = copy.deepcopy(self.value)
        value["materials"][0].update(contentBytes=0, nodes=payload.MAX_NODES,
                                     measuredBytes=payload.MAX_BYTES)
        capacity = value["capacity"][0]
        capacity.update(payloadBytes=payload.MAX_BYTES,
                        minimumBytes=payload.MAX_BYTES + capacity["overheadBytes"] + capacity["reserveBytes"])
        payload.validate(value)
        for bad in (-1, True, 128 * 1024 * MIB + 1):
            with self.subTest(available=bad), self.assertRaises(ValueError):
                self.preflight(available_bytes={"SYSTEM": bad, "PERSISTENT": 128 * 1024 * MIB})
        for role in ("SYSTEM", "PERSISTENT"):
            sizes = {item["role"]: item["minimumBytes"] for item in self.value["capacity"]}
            sizes[role] -= 1
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, "Insufficient"):
                self.preflight(available_bytes=sizes)
        self.preflight(available_bytes=dict.fromkeys(("SYSTEM", "PERSISTENT"), 128 * 1024 * MIB))

    def test_malformed_duplicate_and_oversized_json(self):
        valid = payload.encode(self.value)
        cases = ("{", "[]", "null", '{"schemaVersion":1,"schemaVersion":1}',
                 valid.replace('"schemaVersion":1', '"schemaVersion":NaN', 1),
                 valid.replace('"id":"debian"', '"id":"debian","id":"debian"', 1),
                 valid + " " * payload.MAX_JSON_BYTES, "[" * 2000 + "]" * 2000)
        for text in cases:
            with self.subTest(text=text[:100]), self.assertRaises(ValueError):
                payload.decode(text)
        boundary = valid + " " * (payload.MAX_JSON_BYTES - len(valid.encode("utf8")))
        self.assertEqual(payload.decode(boundary), self.value)
        with self.assertRaises(ValueError):
            payload.decode(boundary + " ")

    def test_expected_identity_and_data_compatibility(self):
        for kwargs in ({"expected_version": "0.1.0-alpha.2"}, {"architecture": "x86_64"},
                       {"distribution": {**payload.DISTRIBUTION, "version": "12"}},
                       {"current_schemas": {**CURRENT, "accounts": 2}},
                       {"current_schemas": {**CURRENT, "users": True}},
                       {"current_schemas": {}}, {"available_bytes": {"SYSTEM": 0}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.preflight(**kwargs)
        value = self.capture(accepts_schemas={key: [] for key in SCHEMAS})
        with self.assertRaisesRegex(ValueError, "Unqualified data"):
            self.preflight(value)
        self.preflight(value, current_schemas={key: None for key in CURRENT})

    def test_entire_system_and_classified_state_are_pinned(self):
        files = (self.program, self.system / "etc/version-related.conf",
                 self.system / "System/Boot/initrd.img-6.1-probe",
                 self.dpkg / "info/probe.md5sums", self.apt / "extended_states")
        for file in files:
            before = file.read_bytes()
            info = file.stat()
            file.write_bytes(before + b"corrupted")
            with self.subTest(path=file), self.assertRaises(ValueError):
                self.preflight()
            file.write_bytes(before)
            os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns))
        self.preflight()
        # These unclassified trees are deliberately never inventoried or restored.
        (self.persistent / "Users/1000/keep").write_text("current user document")
        (self.persistent / "SystemData/Accounts/keep").write_text("not read")
        self.preflight()
        (self.system / "System/Resources/local/new-component").parent.mkdir()
        (self.system / "System/Resources/local/new-component").write_text("complete /usr includes local")
        with self.assertRaises(ValueError):
            self.preflight()
        value = self.capture()
        self.assertGreater(value["materials"][0]["nodes"], self.value["materials"][0]["nodes"])

    def test_package_records_not_a_name_list_hash(self):
        status = self.dpkg / "status"
        cases = (self.status.replace("1:2.0-3", "1:2.0-4"),
                 self.status.replace("amd64", "arm64"),
                 self.status.replace("install ok installed", "install ok unpacked"),
                 self.status.replace("install ok installed", "install reinstreq installed"),
                 self.status + self.status,
                 self.status.replace("Package: probe", "Package: probe\nPackage: probe"),
                 self.status.replace("Version: 1:2.0-3\n", ""),
                 self.status.replace("https://example.invalid/probe", "https://example.invalid/wrong"),
                 "\x00" + self.status, " continuation\n" + self.status)
        for text in cases:
            status.write_text(text)
            with self.subTest(status=text), self.assertRaises(ValueError):
                self.capture()
        status.write_text(self.status)
        for text in ("", "probe\t1:2.0-3\n", self.inventory.read_text() * 2,
                     "probe\t1:2.0-3\thttps://example.invalid/probe\textra\n",
                     "other\t1:2.0-3\thttps://example.invalid/probe\n"):
            self.inventory.write_text(text)
            with self.subTest(inventory=text), self.assertRaises(ValueError):
                self.capture()

    def test_multiarch_and_residual_config_records_are_explicit(self):
        status = self.status.replace("Version:", "Multi-Arch: same\nVersion:")
        status += ("Package: residual\nStatus: deinstall ok config-files\nArchitecture: all\n"
                   "Version: 3.0-1\n\n")
        (self.dpkg / "status").write_text(status)
        (self.dpkg / "info/probe.list").rename(self.dpkg / "info/probe:amd64.list")
        (self.dpkg / "info/probe.md5sums").rename(self.dpkg / "info/probe:amd64.md5sums")
        self.inventory.write_text("probe:amd64\t1:2.0-3\thttps://example.invalid/probe\nresidual\t3.0-1\t\n")
        value = self.capture()
        self.assertEqual(value["packageProof"]["records"], 2)
        self.assertEqual(value["packageProof"]["installedRecords"], 1)
        self.preflight(value)
        self.inventory.write_text(self.inventory.read_text().replace("probe:amd64", "probe"))
        with self.assertRaises(ValueError):
            self.capture()

    def test_missing_or_malformed_package_material_fails_capture(self):
        path = self.dpkg / "info/probe.list"
        original = path.read_text()
        for text in ("", original + "/usr/bin/probe\n", "/usr/bin/missing\n",
                     "/usr/../etc/config\n", "usr/bin/probe\n", "/usr//bin/probe\n", "//usr/bin/probe\n"):
            path.write_text(text)
            with self.subTest(file_list=text), self.assertRaises(ValueError):
                self.capture()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "Missing installed"):
            self.capture()
        path.symlink_to("probe.md5sums")
        with self.assertRaises(ValueError):
            self.capture()

    def test_distribution_layout_and_boot_material_are_qualified(self):
        release = self.system / "System/Resources/lib/os-release"
        text = release.read_text()
        release.write_text(text.replace('"13"', '"12"'))
        with self.assertRaisesRegex(ValueError, "Distribution"):
            self.capture()
        release.write_text(text)
        boot = self.system / "System/Boot/initrd.img-6.1-probe"
        boot.unlink()
        with self.assertRaisesRegex(ValueError, "boot material"):
            self.capture()
        boot.write_bytes(b"boot fixture")
        (self.system / "usr/duplicate").write_text("must not be second /usr")
        with self.assertRaisesRegex(ValueError, "Duplicated"):
            self.capture()

    def test_metadata_symlink_and_hardlink_semantics(self):
        link = self.system / "System/Resources/bin/probe-link"
        link.symlink_to("probe")
        hardlink = self.system / "System/Resources/bin/probe-hard"
        os.link(self.program, hardlink)
        directory = self.system / "System/Resources/local"
        directory.mkdir()
        (directory / "alias").symlink_to("../bin")
        (self.dpkg / "info/probe.list").write_text(
            "/usr/bin/probe\n/boot/vmlinuz-6.1-probe\n/usr/local/alias/probe\n/usr/bin/probe-link\n")
        with (self.dpkg / "info/probe.md5sums").open("a") as checksums:
            checksums.write(hashlib.md5(self.program.read_bytes()).hexdigest() +
                            "  usr/local/alias/probe\n")
        os.setxattr(self.program, "user.payload-test", b"attribute")
        value = self.capture()
        self.preflight(value)
        records, content, measured = payload.inventory(self.system)
        self.assertEqual(records["System/Resources/bin/probe"]["hardlink"],
                         records["System/Resources/bin/probe-hard"]["hardlink"])
        self.assertEqual(records["System/Resources/bin/probe-link"]["target"], "probe")
        self.assertIn("user.payload-test", records["System/Resources/bin/probe"]["xattrs"])
        self.assertGreaterEqual(measured, content)
        hardlink.unlink()
        hardlink.write_bytes(self.program.read_bytes())
        with self.assertRaises(ValueError):
            self.preflight(value)
        value = self.capture()
        self.program.chmod(0o644)
        with self.assertRaises(ValueError):
            self.preflight(value)
        value = self.capture()
        os.setxattr(self.program, "user.payload-test", b"changed")
        with self.assertRaises(ValueError):
            self.preflight(value)

    def test_external_hardlink_special_node_and_link_root_rejected(self):
        external = self.stage / "external"
        os.link(self.program, external)
        with self.assertRaisesRegex(ValueError, "Hardlink escapes"):
            self.capture()
        external.unlink()
        fifo = self.system / "System/Resources/bin/fifo"
        os.mkfifo(fifo)
        with self.assertRaisesRegex(ValueError, "special"):
            self.capture()
        fifo.unlink()
        alias = self.stage / "alias"
        alias.symlink_to(self.system, target_is_directory=True)
        with self.assertRaises(ValueError):
            payload.inventory(alias)
        with patch.object(payload.os, "listxattr", side_effect=OSError("uninspectable")):
            with self.assertRaises(OSError):
                self.capture()

    def test_package_bytes_and_checksum_material_cannot_be_resealed_as_matched(self):
        self.program.write_bytes(b"wrong program bytes")
        with self.assertRaisesRegex(ValueError, "runtime checksum"):
            self.capture()
        self.program.write_bytes(b"complete native runtime")
        checksums = self.dpkg / "info/probe.md5sums"
        text = checksums.read_text()
        for changed in ("", text + text, text.replace("usr/bin/probe", "usr/bin/unlisted"),
                        text.replace("  usr", " usr"), text.replace("usr/bin/probe", "/usr/bin/probe"),
                        text.replace(hashlib.md5(self.program.read_bytes()).hexdigest(), "0" * 32)):
            checksums.write_text(changed)
            with self.subTest(checksum=changed), self.assertRaises(ValueError):
                self.capture()
        checksums.unlink()
        with self.assertRaisesRegex(ValueError, "runtime checksum"):
            self.capture()

    def test_local_and_package_diversions_preserve_original_package_identity(self):
        diverted = self.program.with_name("probe.distrib")
        self.program.rename(diverted)
        self.program.write_bytes(b"explicit unowned overlay")
        diversions = self.dpkg / "diversions"
        record = "/usr/bin/probe\n/usr/bin/probe.distrib\n:\n"
        diversions.write_text(record)
        value = self.capture()
        self.assertEqual(value["packageProof"]["diversions"], 1)
        self.preflight(value)
        for text in (record + record, record.replace(":\n", "unknown\n"), record[:-2],
                     record.replace("probe.distrib", "probe"),
                     record + "/usr/bin/probe.distrib\n/usr/bin/other\n:\n",
                     record.replace("probe.distrib", "missing")):
            diversions.write_text(text)
            with self.subTest(diversion=text), self.assertRaises(ValueError):
                self.capture()
        # The diverting package owns its replacement; an original owner's checksum
        # must not accidentally be applied to that replacement.
        (self.dpkg / "status").write_text(self.status +
            "Package: wrapper\nStatus: install ok installed\nArchitecture: all\nVersion: 1.0\n\n")
        self.inventory.write_text(self.inventory.read_text() + "wrapper\t1.0\t\n")
        (self.dpkg / "info/wrapper.list").write_text("/usr/bin/probe\n")
        (self.dpkg / "info/wrapper.md5sums").write_text(
            hashlib.md5(self.program.read_bytes()).hexdigest() + "  usr/bin/probe\n")
        diversions.write_text(record.replace(":\n", "wrapper\n"))
        value = self.capture()
        self.assertEqual(value["packageProof"]["installedRecords"], 2)
        self.preflight(value)

    def test_symlink_loops_unsupported_links_and_owner_metadata(self):
        directory = self.system / "System/Resources/local"
        directory.mkdir()
        alias = directory / "alias"
        alias.symlink_to("alias")
        with (self.dpkg / "info/probe.list").open("a") as listing:
            listing.write("/usr/local/alias/probe\n")
        with self.assertRaisesRegex(ValueError, "symlink loop"):
            self.capture()
        alias.unlink()
        alias.symlink_to("../bin")
        hardlinked_symlink = directory / "alias-hard"
        os.link(alias, hardlinked_symlink, follow_symlinks=False)
        with self.assertRaisesRegex(ValueError, "Hardlinked symlinks"):
            payload.inventory(self.system)
        hardlinked_symlink.unlink()
        # Numeric ownership, special mode bits and mtime are retained, not normalized.
        before, _, _ = payload.inventory(self.system)
        self.program.chmod(0o4755)
        info = self.program.stat()
        os.chown(self.program, info.st_uid + 1, info.st_gid + 1)
        os.utime(self.program, ns=(info.st_atime_ns, info.st_mtime_ns + 1))
        after, _, _ = payload.inventory(self.system)
        entry = after["System/Resources/bin/probe"]
        self.assertEqual(entry["uid"], info.st_uid + 1)
        self.assertEqual(entry["gid"], info.st_gid + 1)
        self.assertEqual(entry["mtimeNs"], info.st_mtime_ns + 1)
        self.assertNotEqual(payload.checksum(before), payload.checksum(after))
        # chown can clear setuid; explicitly reapply and observe the bit, not assume it.
        self.program.chmod(0o4755)
        records, _, _ = payload.inventory(self.system)
        self.assertEqual(records["System/Resources/bin/probe"]["mode"], 0o4755)

    def test_source_syntax_and_builder_provenance_surface(self):
        for name in ("desktop/release/maintenance/payload.py", "desktop/tests/system-payload.py",
                     "desktop/tools/build-storage-image.py"):
            ast.parse((REPO / name).read_text(), filename=name)
        source = (REPO / "desktop/tools/build-storage-image.py").read_text()
        self.assertIn('"schemaVersion": 1, "stage": "development-single-system-normal-boot"', source)
        self.assertIn('REPO / "desktop/release/maintenance/payload.py"', source)
        self.assertIn('stage / "system-payload.json"', source)
        self.assertIn("(image, manifest_path, payload_path)", source)
        self.assertIn("(image, manifest_path, payload_path, sums, cfg)", source)

    def test_snapshot_change_and_limits_fail_explicitly(self):
        original = payload.inventory
        calls = 0

        def moving(root):
            nonlocal calls
            calls += 1
            if calls == 4:
                self.program.write_bytes(b"concurrent mutation")
            return original(root)

        with patch.object(payload, "inventory", side_effect=moving):
            with self.assertRaisesRegex(ValueError, "changed during proof"):
                self.capture()
        with patch.object(payload, "MAX_NODES", 2):
            with self.assertRaisesRegex(ValueError, "node limit"):
                payload.inventory(self.system)
        with patch.object(payload, "MAX_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                payload.inventory(self.system)
        with self.assertRaisesRegex(ValueError, "size limit"):
            payload._read(self.program, 1)
        exact = self.stage / "bounded"
        exact.mkdir()
        (exact / "one").write_bytes(b"x")
        with patch.object(payload, "MAX_NODES", 2), patch.object(payload, "MAX_BYTES", 4097):
            records, content, measured = payload.inventory(exact)
            self.assertEqual((len(records), content, measured), (2, 1, 4097))
        with patch.object(payload, "MAX_BYTES", 4096):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                payload.inventory(exact)

    def test_capture_bad_declarations_fail_before_material_access(self):
        cases = ({"overhead_bytes": {"SYSTEM": 16 * MIB}},
                 {"reserve_bytes": {"SYSTEM": True, "PERSISTENT": 16 * MIB}},
                 {"reserve_bytes": dict.fromkeys(("SYSTEM", "PERSISTENT"), payload.MAX_BYTES + 1)},
                 {"accepts_schemas": {}},
                 {"accepts_schemas": {**SCHEMAS, "accounts": [True]}},
                 {"accepts_schemas": {**SCHEMAS, "accounts": [3, 3]}},
                 {"accepts_schemas": {**SCHEMAS, "accounts": tuple([3])}},
                 {"accepts_schemas": {**SCHEMAS, "accounts": list(range(1, 258))}})
        for kwargs in cases:
            with self.subTest(kwargs=kwargs), patch.object(payload, "inventory") as inspect:
                with self.assertRaises(ValueError):
                    self.capture(**kwargs)
                inspect.assert_not_called()
        boundary = {**SCHEMAS, "accounts": [1, payload.MAX_SCHEMA]}
        value = self.capture(accepts_schemas=boundary,
                             reserve_bytes=dict.fromkeys(("SYSTEM", "PERSISTENT"), 16 * MIB))
        self.preflight(value, current_schemas={**CURRENT, "accounts": payload.MAX_SCHEMA})

    def test_readonly_cli_refuses_missing_and_mismatched_material(self):
        contract = self.stage / "system-payload.json"
        schemas = self.stage / "schemas.json"
        contract.write_text(payload.encode(self.value))
        schemas.write_text(json.dumps(CURRENT))
        command = [sys.executable, "-I", "-B", str(REPO / "desktop/release/maintenance/payload.py"),
                   str(contract), str(self.system), str(self.persistent),
                   "--expected-version", VERSION, "--distribution", "debian13",
                   "--architecture", "amd64", "--available-system-bytes", str(128 * MIB),
                   "--available-persistent-bytes", str(128 * MIB), "--current-schemas", str(schemas)]
        before = payload.inventory(self.system), payload.inventory(self.persistent)
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["readOnly"])
        self.assertEqual(before, (payload.inventory(self.system), payload.inventory(self.persistent)))
        contract.write_text('{"schemaVersion":1,"schemaVersion":1}')
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Duplicate JSON", result.stderr)
        contract.write_text(payload.encode(self.value))
        self.program.write_bytes(b"corrupted")
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("runtime checksum", result.stderr)

    def test_builder_consumer_qualifies_fresh_without_claiming_existing_data(self):
        measured = {role: 4096 for role in payload.layout.VOLUME_ROLES}
        measured.update(SYSTEM=builder.payload_bytes(self.system),
                        PERSISTENT=builder.payload_bytes(self.persistent))
        parts, _ = payload.layout.partition_plan(measured, dict.fromkeys(measured, 32))
        before = payload.inventory(self.system), payload.inventory(self.persistent)
        value = builder.qualify_payload(self.system, self.persistent, VERSION, parts)
        self.assertEqual(value["trust"], "development-unsigned")
        declarations = {item["id"]: item["acceptsSchemas"] for item in value["compatibility"]}
        self.assertEqual(declarations, {"accounts": [3], "applications": [], "services": [], "users": []})
        self.assertEqual(before, (payload.inventory(self.system), payload.inventory(self.persistent)))
        with self.assertRaises(ValueError):
            self.preflight(value)
        self.preflight(value, current_schemas={key: None for key in CURRENT})
        with self.assertRaises(ValueError):
            builder.qualify_payload(self.system, self.persistent, VERSION, [*parts, parts[0]])
        (self.apt / "extended_states").write_text("different package state")
        with self.assertRaises(ValueError):
            self.preflight(value, current_schemas={key: None for key in CURRENT})


if __name__ == "__main__":
    unittest.main()
