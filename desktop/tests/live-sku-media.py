#!/usr/bin/env python3
"""Actual tiny ISO/USB byte verification for four synthetic, non-bootable SKU fixtures."""
import hashlib
import copy
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
fixtures = runpy.run_path(str(Path(__file__).with_name("live-profiles.py")))
profiles, roots = fixtures["profiles"], fixtures["root_tools"]


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else (json.dumps(data, indent=2) + "\n").encode())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class MediaProfiles(unittest.TestCase):
    def test_actual_iso_usb_root_boot_profile_and_receipt_for_every_sku(self):
        for sku in ("full", "vm", "intel", "nvidia"):
            with self.subTest(sku=sku), tempfile.TemporaryDirectory(prefix="polly-sku-media-") as temp:
                directory = Path(temp)
                root, bundle, inputs, media = [directory / name for name in ("root", "runtime", "inputs", "media")]
                for path in (root, bundle, inputs, media):
                    path.mkdir()
                selected = fixtures["seed"](root, sku)
                write(root / "usr/bin/pollyui", b"synthetic non-executable native runtime")
                runtime = {"dirty": False, "revision": "a" * 40, "files": [{
                    "path": "usr/bin/pollyui", "mode": "0644",
                    "sha256": digest(root / "usr/bin/pollyui"), "size": (root / "usr/bin/pollyui").stat().st_size}]}
                write(bundle / "manifest.json", runtime)
                write(bundle / "build-inputs.json", {"fixtureOnly": True})
                native = {"imageID": "b" * 64, "sourceRevision": runtime["revision"],
                          "manifestSha256": digest(bundle / "manifest.json")}
                packages = profiles["packages"](root)
                write(root / "usr/share/polly-live-packages.tsv",
                      "".join(f"{name}\t{item['version']}\tfixture\n" for name, item in packages.items()).encode())
                overlays = [{"path": name, "mode": "0644", "sha256": digest(root / name)}
                            for name in (profiles["MARKER"], profiles["PROFILE_COPY"],
                                         "var/lib/dpkg/status", "usr/share/polly-live-packages.tsv")]
                origin = {"schemaVersion": 1, "fixtureOnly": True, "sku": sku, "hardwareProfile": selected,
                          "nativeRuntime": native, "imageToolsID": "c" * 64,
                          "runtimeSourceRevision": runtime["revision"], "runtimeSourceDirty": False,
                          "runtimeManifestSha256": native["manifestSha256"],
                          "runtimeBuildInputsSha256": digest(bundle / "build-inputs.json"),
                          "mediaProducerRevision": "d" * 40, "baseImageID": native["imageID"],
                          "overlayRecipeSha256": "e" * 64, "overlays": overlays}
                write(root / "usr/share/pollyui/runtime-origin.json", origin)
                with tarfile.open(inputs / "root.tar", "w") as archive:
                    archive.add(root, arcname=".")
                run(sys.executable, "-I", "-B", str(REPO / "desktop/tools/retain-live-inputs.py"), str(inputs))
                image = directory / "image"
                boot = image / "boot"
                boot.mkdir(parents=True)
                run("mksquashfs", str(root), str(boot / "root.squashfs"), "-noappend", "-processors", "1",
                    "-comp", "gzip", "-no-progress", "-quiet")
                bootstrap = directory / "bootstrap"
                for name in ("bin", "etc", "dev"):
                    (bootstrap / name).mkdir(parents=True)
                identity = "f" * 32
                sha, size = digest(boot / "root.squashfs"), (boot / "root.squashfs").stat().st_size
                write(bootstrap / "etc/polly-live-root",
                      f"POLLY_MEDIA_ID={identity}\nPOLLY_ROOT_SHA256={sha}\nPOLLY_ROOT_BYTES={size}\n".encode())
                write(bootstrap / "etc/polly-live-hardware", profiles["marker"](sku))
                write(bootstrap / "init", b"not a bootable init")
                write(bootstrap / "bin/busybox", b"not an executable")
                total = roots["write_cpio"](bootstrap, boot / "initramfs.gz")
                files = [{"path": file.relative_to(bootstrap).as_posix(), "mode": file.stat().st_mode,
                          **({"size": file.stat().st_size, "sha256": digest(file)} if file.is_file() else {})}
                         for file in sorted(bootstrap.rglob("*"))]
                files.extend({"path": name, "mode": 0o020000 | mode, "device": [major, minor]}
                             for name, (major, minor, mode) in roots["DEVICES"].items())
                layout = {"kind": "squashfs-ram-overlay", "path": "boot/root.squashfs",
                          "sha256": sha, "size": size, "mediaIdentity": identity,
                          "copyToRam": True, "writable": "tmpfs-overlay",
                          "hardwareProfile": {key: selected[key] for key in ("sku", "manifestSha256")},
                          "bootstrap": {"path": "boot/initramfs.gz", "sha256": digest(boot / "initramfs.gz"),
                                        "size": (boot / "initramfs.gz").stat().st_size,
                                        "uncompressedBytes": total, "files": files}}
                write(image / f"polly/{identity}.marker", (sha + "\n").encode())
                config = b"# synthetic unique embedded config for SKU fixture: " + sku.encode() + b"\n"
                write(media / "grub.cfg", config)
                write(image / "EFI/BOOT/BOOTX64.EFI", b"NOT-BOOTABLE-EFI\n" + config + b"end")
                write(boot / "vmlinuz", b"not-a-kernel")
                write(boot / "intel-ucode.img", b"not-microcode")
                with (boot / "efiboot.img").open("wb") as output:
                    output.truncate(4 * 1024 * 1024)
                run("mkfs.fat", str(boot / "efiboot.img"))
                run("mmd", "-i", str(boot / "efiboot.img"), "::/EFI", "::/EFI/BOOT")
                run("mcopy", "-i", str(boot / "efiboot.img"), str(image / "EFI/BOOT/BOOTX64.EFI"),
                    "::/EFI/BOOT/BOOTX64.EFI")
                prefix = f"pollydesktop-0.1.0-alpha.8-debian13-{sku}-x86_64-"
                iso, usb = media / (prefix + "uefi-live.iso"), media / (prefix + "uefi-usb.img")
                run("xorriso", "-as", "mkisofs", "-R", "-J", "-o", str(iso), str(image))
                with usb.open("wb") as output:
                    output.truncate(17 * 1024 * 1024)
                fat = directory / "fat.img"
                with fat.open("wb") as output:
                    output.truncate(16 * 1024 * 1024)
                run("mkfs.fat", str(fat))
                for child in image.iterdir():
                    run("mcopy", "-s", "-i", str(fat), str(child), "::/")
                with usb.open("r+b") as output, fat.open("rb") as source:
                    output.seek(1024 * 1024)
                    while block := source.read(1024 * 1024):
                        output.write(block)
                uncompressed = sum(file.stat().st_size for file in root.rglob("*") if file.is_file())
                sizes = profiles["size_report"](root, sku, REPO)
                sizes["media"] = {"isoBytes": iso.stat().st_size, "usbBytes": usb.stat().st_size,
                                  "rootBytes": size, "rootUncompressedBytes": uncompressed,
                                  "bootstrapBytes": layout["bootstrap"]["size"], "bootstrapUncompressedBytes": total}
                manifest = {"schemaVersion": 2, "distribution": "debian13", "version": "0.1.0-alpha.8",
                            "sourceRevision": "d" * 40, "runtimeImage": native["imageID"], "sku": sku,
                            "hardwareProfile": selected, "nativeRuntime": native, "imageToolsID": "c" * 64,
                            "root": layout, "grub": {"templateSha256": "e" * 64, "embeddedSha256": digest(media / "grub.cfg")},
                            "uncompressedPayloadBytes": uncompressed, "sizeReport": sizes,
                            "packages": [{"name": name, "version": item["version"]} for name, item in packages.items()],
                            "iso": {"name": iso.name, "size": iso.stat().st_size, "sha256": digest(iso)},
                            "usb": {"name": usb.name, "size": usb.stat().st_size, "sha256": digest(usb)},
                            "bootFiles": [{"path": "boot/" + file.name, "size": file.stat().st_size, "sha256": digest(file)}
                                          for file in boot.iterdir() if file.name != "efiboot.img"]}
                profiles["validate_media"](manifest)
                duplicate = copy.deepcopy(manifest)
                duplicate["packages"][0] = dict(duplicate["packages"][1])
                with self.assertRaisesRegex(ValueError, "differs from media package inventory"):
                    profiles["validate_media"](duplicate)
                write(media / "live-manifest.json", manifest)
                command = [sys.executable, "-I", "-B", str(REPO / "desktop/tools/verify-live-runtime.py"),
                           str(media), str(bundle), str(inputs), "--producer-revision", "d" * 40]
                result = run(*command)
                self.assertIn("PASS: actual media root", result.stdout)
                receipt = json.loads((media / "candidate-origin.json").read_bytes())
                self.assertEqual(receipt["sku"], sku)
                self.assertEqual(receipt["nativeRuntime"], native)
                self.assertTrue(receipt["fixtureOnly"])
                self.assertEqual(receipt["stage"], "verified-structure-fixture-not-publishable")
                self.assertEqual(receipt["sizeReport"], sizes)
                manifest["sku"] = "unknown"
                write(media / "live-manifest.json", manifest)
                rejected = subprocess.run(command, capture_output=True, text=True, timeout=30)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("hardware SKU", rejected.stderr)
                print(f"PASS: actual synthetic {sku} ISO/USB bytes, root/boot profile and non-publishable receipt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
