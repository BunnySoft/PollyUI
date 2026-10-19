#!/usr/bin/env python3
"""Small real SKU metadata/package/size fixtures; no installs, native builds or guests."""
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest

REPO = Path(__file__).resolve().parents[2]
profiles = runpy.run_path(str(REPO / "desktop/release/debian/live-profile.py"))
verify = runpy.run_path(str(REPO / "desktop/tools/verify-live-runtime.py"))
root_tools = runpy.run_path(str(REPO / "desktop/tools/live-root.py"))


def seed(root, sku, *, marked=True):
    selected = profiles["profile"](sku)
    status = []
    for spec in [*selected["requiredPackages"], "mesa-libgallium=25.0+polly1",
                 "mesa-vulkan-drivers=25.0+polly1", "libllvm19=19.1"]:
        name, _, version = spec.partition("=")
        status.append(f"Package: {name}\nStatus: install ok installed\nArchitecture: amd64\n"
                      f"Version: {version or '1.0'}\nInstalled-Size: 7\n")
        file = root / ("usr/share/fixture/" + name)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(name.encode())
        listing = root / f"var/lib/dpkg/info/{name}.list"
        listing.parent.mkdir(parents=True, exist_ok=True)
        listing.write_text(f"/.\n/usr/share/fixture/{name}\n")
    (root / "var/lib/dpkg/status").write_text("\n".join(status) + "\n")
    if marked:
        for name, data in ((profiles["MARKER"], profiles["marker"](sku)),
                           (profiles["PROFILE_COPY"], profiles["MANIFEST"].read_bytes())):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
    return selected


class HardwareProfiles(unittest.TestCase):
    def test_four_package_sets_missing_forbidden_and_legacy_full(self):
        for sku in ("full", "vm", "intel", "nvidia"):
            with self.subTest(sku=sku), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                selected = seed(root, sku)
                self.assertEqual(profiles["verify"](root, sku), selected)
                installed = profiles["packages"](root)
                self.assertIn("intel-microcode", installed)
                self.assertIn("mesa-libgallium", installed)
                if sku == "full":
                    profiles["installed_input"](root)
                else:
                    with self.assertRaisesRegex(ValueError, "Install SKU filenames/manifests are not wired"):
                        profiles["installed_input"](root)
                for name in selected["requiredPackages"]:
                    broken = copy.deepcopy(installed)
                    del broken[name.split("=")[0]]
                    with self.assertRaisesRegex(ValueError, "Missing/wrong"):
                        profiles["verify_packages"](broken, selected)
                for name in [*selected["forbiddenPackages"], "firmware-amd-graphics"]:
                    with self.assertRaisesRegex(ValueError, "Forbidden|Undeclared"):
                        profiles["verify_packages"]({**installed, name: {"version": "1"}}, selected)
                if sku != "full":
                    with self.assertRaisesRegex(ValueError, "metadata/source"):
                        profiles["verify"](root)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed(root, "full", marked=False)
            self.assertEqual(profiles["verify"](root)["sku"], "full")
            with self.assertRaises(FileNotFoundError):
                profiles["verify"](root, "full")

    def test_strict_sku_selection_and_manifest_fields(self):
        self.assertEqual(profiles["select"]("full,vm,intel,nvidia"), ["full", "vm", "intel", "nvidia"])
        for value in ("", "full,", ",vm", "vm,vm", "VM", "unknown", "intel, nvidia", "vm;id"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                profiles["select"](value)
        manifest = profiles["load"]()
        for change in (
                lambda value: value.update({"unknown": True}),
                lambda value: value["profiles"].update({"unknown": value["profiles"]["vm"]}),
                lambda value: value["profiles"]["vm"]["packageGroups"].append("unknown"),
                lambda value: value["packageGroups"]["common"].append("polkitd=126-2")):
            with tempfile.TemporaryDirectory() as temporary:
                value = copy.deepcopy(manifest)
                change(value)
                path = Path(temporary) / "profiles.json"
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    profiles["load"](path)

    def test_marker_regular_root_owner_mode_links_and_source_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed(root, "intel")
            path = root / profiles["MARKER"]
            original = path.read_bytes()
            for data, mode, uid in ((b"{}\n", 0o644, 0), (original, 0o666, 0), (original, 0o644, 1000)):
                path.write_bytes(data)
                path.chmod(mode)
                os.chown(path, uid, 0)
                with self.assertRaisesRegex(ValueError, "metadata/source"):
                    profiles["verify"](root, "intel")
            os.chown(path, 0, 0)
            path.chmod(0o644)
            path.write_bytes(original)
            linked = path.with_name("linked")
            os.link(path, linked)
            with self.assertRaisesRegex(ValueError, "metadata/source"):
                profiles["verify"](root, "intel")
            linked.unlink()
            path.unlink()
            path.symlink_to("missing")
            with self.assertRaisesRegex(ValueError, "metadata/source"):
                profiles["verify"](root, "intel")
            path.unlink()
            path.write_bytes(original)
            (root / profiles["PROFILE_COPY"]).write_bytes(b"{}\n")
            with self.assertRaisesRegex(ValueError, "metadata/source"):
                profiles["verify"](root, "intel")

    def test_clean_runtime_refuses_full_base_even_without_profile_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed(root, "full", marked=False)
            with self.assertRaisesRegex(ValueError, "clean common runtime"):
                profiles["clean_runtime"](root)
            status = root / "var/lib/dpkg/status"
            status.write_text("Package: python3\nStatus: install ok installed\nArchitecture: amd64\nVersion: 3\nInstalled-Size: 7\n")
            profiles["clean_runtime"](root)
            for name in (profiles["MARKER"], "etc/polly-account-profile", "init"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"already a platform")
                with self.assertRaisesRegex(ValueError, "clean common runtime"):
                    profiles["clean_runtime"](root)
                path.unlink()
            stripped = root / "usr/lib/firmware/unowned.bin"
            stripped.parent.mkdir(parents=True)
            stripped.write_bytes(b"full firmware without dpkg metadata is still not a clean runtime")
            with self.assertRaisesRegex(ValueError, "clean common runtime"):
                profiles["clean_runtime"](root)

    def test_direct_installed_export_entry_refuses_reduced_profile_before_image_creation(self):
        builder = runpy.run_path(str(REPO / "desktop/tools/build-installed-image.py"))
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            root = directory / "root"
            root.mkdir()
            seed(root, "nvidia")
            export = directory / "root.tar"
            with tarfile.open(export, "w") as archive:
                archive.add(root, arcname=".")
            output = directory / "must-not-exist"
            args = SimpleNamespace(source_revision="a" * 40, export=export, output=output,
                                   system_mib=3072, data_mib=2048)
            with self.assertRaisesRegex(ValueError, "Install SKU filenames/manifests are not wired"):
                builder["build"](args)
            self.assertFalse(output.exists())

    def test_size_report_measures_actual_files_not_declared_or_compressed_savings(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed(root, "vm")
            file = root / "usr/share/fixture/intel-microcode"
            alias = file.with_name("alias")
            alias.symlink_to("intel-microcode")
            with (root / "var/lib/dpkg/info/intel-microcode.list").open("a") as listing:
                listing.write("/usr/share/fixture/alias\n/usr/share/fixture/intel-microcode\n")
            report = profiles["size_report"](root, "vm", REPO)
            package = next(item for item in report["packages"] if item["name"] == "intel-microcode")
            self.assertEqual(package["installedSizeBytes"], 7 * 1024)
            self.assertEqual(package["regularFileBytes"], len(b"intel-microcode"))
            self.assertFalse(any("firmware-" in item["name"] for item in report["packages"]))
            self.assertIn("mesa-libgallium", {item["name"] for item in report["packages"]})
            self.assertNotIn("predictedSavings", report)
            (root / "var/lib/dpkg/info/intel-microcode.list").unlink()
            with self.assertRaisesRegex(ValueError, "Missing actual package file list"):
                profiles["size_report"](root, "vm", REPO)

    def test_real_bootstrap_profile_bytes_mode_and_root_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "bootstrap"
            for name in ("bin", "etc", "dev"):
                (root / name).mkdir(parents=True)
            identity, sha = "a" * 32, "b" * 64
            (root / "etc/polly-live-root").write_text(
                f"POLLY_MEDIA_ID={identity}\nPOLLY_ROOT_SHA256={sha}\nPOLLY_ROOT_BYTES=200\n")
            (root / "etc/polly-live-hardware").write_bytes(profiles["marker"]("vm"))
            (root / "init").write_bytes(b"synthetic-not-bootable")
            (root / "bin/busybox").write_bytes(b"synthetic-not-executable")
            path = Path(temporary) / "initramfs.gz"

            def pack():
                total = root_tools["write_cpio"](root, path)
                records = [{"path": file.relative_to(root).as_posix(), "mode": file.stat().st_mode,
                            **({"size": file.stat().st_size, "sha256": root_tools["digest"](file)}
                               if file.is_file() else {})} for file in sorted(root.rglob("*"))]
                records.extend({"path": name, "mode": stat.S_IFCHR | mode, "device": [major, minor]}
                               for name, (major, minor, mode) in root_tools["DEVICES"].items())
                return {"mediaIdentity": identity, "sha256": sha, "size": 200,
                        "hardwareProfile": {key: profiles["profile"]("vm")[key] for key in ("sku", "manifestSha256")},
                        "bootstrap": {"size": path.stat().st_size, "sha256": root_tools["digest"](path),
                                      "uncompressedBytes": total, "files": records}}
            verify["check_bootstrap"](path, pack())
            for content, mode in ((profiles["marker"]("full"), 0o644), (profiles["marker"]("vm"), 0o666)):
                (root / "etc/polly-live-hardware").write_bytes(content)
                (root / "etc/polly-live-hardware").chmod(mode)
                layout = pack()
                with self.assertRaisesRegex(ValueError, "hardware profile"):
                    verify["check_bootstrap"](path, layout)

    def test_shell_syntax_and_mesa_protection_are_retained(self):
        for name in ("desktop/tools/build-live.sh", "desktop/tools/build-installed.sh", "desktop/tests/debian-live-payload.sh"):
            subprocess.run(["sh", "-n", str(REPO / name)], check=True)
        recipe = (REPO / "desktop/release/debian/Containerfile.live").read_text()
        self.assertIn("FROM ${RUNTIME_IMAGE} AS platform-base", recipe)
        self.assertIn("live-profile.py clean-runtime", recipe)
        self.assertNotIn("apt-get remove", recipe)
        self.assertNotIn("rm /usr/lib", recipe)
        qualifier = (REPO / "desktop/tests/debian-live-payload.sh").read_text()
        self.assertIn("Live assembly changed the corrected Mesa package", qualifier)
        self.assertIn("mesa/runtime-packages.txt", qualifier)
        self.assertIn("polly-account-profile", qualifier)
        self.assertIn("live-profile.py installed-input", (REPO / "desktop/tools/build-installed.sh").read_text())
        startup = (REPO / "desktop/release/live/session").read_text()
        self.assertIn("polly-account-profile-check live", startup)


if __name__ == "__main__":
    unittest.main(verbosity=2)
