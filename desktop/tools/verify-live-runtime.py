#!/usr/bin/env python3
"""Bind actual ISO/USB root bytes to a frozen runtime and overlay receipt."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import runpy
import stat
import subprocess
import tempfile


NAMESPACES = ("usr/share/pollyui", "usr/lib/pollyui", "usr/share/licenses/pollyui",
              "usr/share/doc/pollyui", "usr/share/icons/PollyRabbit", "usr/share/icons/PollyClassic")
ROOT = runpy.run_path(str(Path(__file__).with_name("live-root.py")))


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def check_initramfs(path, expected, origin):
    found = set()
    origin_seen = False
    with gzip.open(path, "rb") as source:
        while True:
            header = source.read(110)
            if len(header) != 110 or header[:6] != b"070701":
                raise ValueError("Invalid/truncated newc initramfs header")
            fields = [int(header[index:index + 8], 16) for index in range(6, 110, 8)]
            _, mode, uid, gid, _, _, size, _, _, _, _, namesize, _ = fields
            name = source.read(namesize)
            if len(name) != namesize or not name.endswith(b"\0"):
                raise ValueError("Invalid initramfs path")
            name = name[:-1].decode()
            source.read(-(110 + namesize) % 4)
            if name == "TRAILER!!!":
                break
            origin_entry = name == "usr/share/pollyui/runtime-origin.json"
            if (stat.S_ISREG(mode) or stat.S_ISLNK(mode)) and name not in expected and not origin_entry and any(
                    name == namespace or name.startswith(namespace + "/") for namespace in NAMESPACES):
                raise ValueError("Old/unlisted Polly runtime file in ISO: " + name)
            if origin_entry and (not stat.S_ISREG(mode) or uid or gid or stat.S_IMODE(mode) != 0o644):
                raise ValueError("Invalid ISO origin receipt ownership/mode")
            if name in expected:
                if name in found:
                    raise ValueError("Duplicate runtime initramfs entry: " + name)
                found.add(name)
                record = expected[name]
                if (not stat.S_ISREG(mode) or uid or gid or
                        stat.S_IMODE(mode) != int(record["mode"], 8) or size != record["size"]):
                    raise ValueError("ISO runtime metadata differs from frozen payload: " + name)
            result = hashlib.sha256()
            captured = bytearray() if origin_entry else None
            remaining = size
            while remaining:
                block = source.read(min(remaining, 1024 * 1024))
                if not block:
                    raise ValueError("Truncated initramfs payload")
                remaining -= len(block)
                if name in expected:
                    result.update(block)
                if captured is not None:
                    if len(captured) + len(block) > 1024 * 1024:
                        raise ValueError("Origin receipt is too large")
                    captured.extend(block)
            source.read(-size % 4)
            if name in expected and result.hexdigest() != expected[name]["sha256"]:
                raise ValueError("ISO runtime bytes differ from frozen payload: " + name)
            if captured is not None and json.loads(captured) != origin:
                raise ValueError("Actual ISO origin receipt differs from candidate input receipt")
            if captured is not None:
                if origin_seen:
                    raise ValueError("Duplicate initramfs origin receipt")
                origin_seen = True
    if found != set(expected):
        raise ValueError("ISO omits frozen runtime files: " + repr(sorted(set(expected) - found)))
    if not origin_seen:
        raise ValueError("ISO omits the actual runtime origin receipt")


def check_layout(manifest):
    root = manifest.get("root")
    if root == "initramfs, memory only" and manifest.get("schemaVersion", 1) == 1:
        return False
    if (manifest.get("schemaVersion") != 2 or manifest.get("distribution") != "debian13" or
            not isinstance(root, dict) or root.get("kind") != ROOT["ROOT_KIND"] or
            root.get("path") != ROOT["ROOT_PATH"] or root.get("copyToRam") is not True or
            root.get("writable") != "tmpfs-overlay" or
            not re.fullmatch(r"[0-9a-f]{32}", root.get("mediaIdentity", ""))):
        raise ValueError("Unsupported Live root layout/schema")
    bootstrap = root.get("bootstrap", {})
    for record in (root, bootstrap):
        if (not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", "")) or
                type(record.get("size")) is not int or not 0 < record["size"] < 2 ** 32):
            raise ValueError("Invalid Live root/bootstrap identity")
    if (bootstrap.get("path") != "boot/initramfs.gz" or
            type(bootstrap.get("uncompressedBytes")) is not int or
            not 0 < bootstrap["uncompressedBytes"] <= ROOT["MAX_BOOTSTRAP_BYTES"]):
        raise ValueError("Invalid small-bootstrap contract")
    if any(not re.fullmatch(r"[0-9a-f]{64}", manifest.get("grub", {}).get(key, ""))
           for key in ("templateSha256", "embeddedSha256")):
        raise ValueError("Missing actual embedded GRUB configuration identity")
    return True


def check_bootstrap(path, layout):
    bootstrap = layout["bootstrap"]
    if path.stat().st_size != bootstrap["size"] or digest(path) != bootstrap["sha256"]:
        raise ValueError("Actual bootstrap differs from media manifest")
    found = {}
    total = 0
    with gzip.open(path, "rb") as source:
        while True:
            header = source.read(110)
            if len(header) != 110 or header[:6] != b"070701":
                raise ValueError("Invalid bootstrap newc header")
            fields = [int(header[index:index + 8], 16) for index in range(6, 110, 8)]
            _, mode, uid, gid, _, _, size, _, _, major, minor, namesize, _ = fields
            if not 1 <= namesize <= 4096 or size > ROOT["MAX_BOOTSTRAP_BYTES"]:
                raise ValueError("Oversize bootstrap entry")
            name = source.read(namesize)
            if not name.endswith(b"\0"):
                raise ValueError("Invalid bootstrap path")
            name = name[:-1].decode()
            source.read(-(110 + namesize) % 4)
            if name == "TRAILER!!!":
                break
            ROOT["safe_name"](name)
            if name in found or uid or gid:
                raise ValueError("Duplicate/non-root bootstrap entry: " + name)
            if (name.endswith(".squashfs") or
                    not (name in {".", "init", "bin", "etc", "lib", "lib64", "dev", "proc", "sys",
                                  "run", "tmp", "media", "newroot", "dev/console", "dev/null"} or
                         name.startswith(("bin/", "etc/polly-live-", "lib/", "lib64/")))):
                raise ValueError("Full runtime/unexpected path in bootstrap: " + name)
            data = source.read(size)
            if len(data) != size:
                raise ValueError("Truncated bootstrap entry")
            source.read(-size % 4)
            found[name] = (mode, data, major, minor)
            if stat.S_ISREG(mode):
                total += size
                if total > ROOT["MAX_BOOTSTRAP_BYTES"]:
                    raise ValueError("Bootstrap exceeds 64 MiB unpacked")
    expected = (f"POLLY_MEDIA_ID={layout['mediaIdentity']}\n"
                f"POLLY_ROOT_SHA256={layout['sha256']}\nPOLLY_ROOT_BYTES={layout['size']}\n").encode()
    if (found.get("etc/polly-live-root", (0, b""))[1] != expected or total != bootstrap["uncompressedBytes"] or
            not found.get("init") or not found.get("bin/busybox")):
        raise ValueError("Bootstrap lacks exact root identity/init/tools")
    records = {record["path"]: record for record in bootstrap["files"]}
    if len(records) != len(bootstrap["files"]) or set(records) != set(found) - {"."}:
        raise ValueError("Bootstrap file inventory differs")
    for name, record in records.items():
        mode, data, major, minor = found[name]
        if (mode != record["mode"] or
                stat.S_ISREG(mode) and (len(data) != record["size"] or
                                       hashlib.sha256(data).hexdigest() != record["sha256"]) or
                stat.S_ISLNK(mode) and data.decode() != record["link"] or
                stat.S_ISCHR(mode) and [major, minor] != record["device"]):
            raise ValueError("Bootstrap node differs from exact inventory: " + name)


def check_squashfs(path, expected, origin):
    listing = subprocess.check_output(
        ["unsquashfs", "-processors", "1", "-lln", "-d", "root", str(path)],
        text=True, timeout=180)
    found = {}
    origin_path = "usr/share/pollyui/runtime-origin.json"
    for line in listing.splitlines():
        match = re.fullmatch(r"([-dlbcps][rwxstST-]{9})\s+(\d+)/(\d+)\s+(\d+)\s+"
                             r"\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+root(?:/(.*))?", line)
        if not match:
            if " root/" in line:
                raise ValueError("Unrecognized SquashFS metadata: " + line)
            continue
        permissions, uid, gid, size, name = match.groups()
        if name is None:
            continue
        if permissions[0] == "l":
            name = name.split(" -> ", 1)[0]
        ROOT["safe_name"](name)
        if name in found:
            raise ValueError("Duplicate SquashFS path: " + name)
        found[name] = (permissions, int(uid), int(gid), int(size))
        if permissions[0] != "d" and name not in expected and name != origin_path and any(
                name == namespace or name.startswith(namespace + "/") for namespace in NAMESPACES):
            raise ValueError("Old/unlisted Polly runtime file in ISO: " + name)
    if set(expected) - found.keys() or origin_path not in found:
        raise ValueError("SquashFS omits frozen runtime/origin files")
    records = {**expected, origin_path: {"mode": "0644"}}
    for name, record in records.items():
        mode, uid, gid, size = found[name]
        if (mode[0] != "-" or uid or gid or mode != stat.filemode(stat.S_IFREG | int(record["mode"], 8)) or
                (name != origin_path and size != record["size"])):
            raise ValueError("SquashFS runtime metadata differs from frozen payload: " + name)
    names = sorted(records)
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(["unsquashfs", "-processors", "1", "-cat", str(path), *names],
                                   stdout=subprocess.PIPE, stderr=errors)
        try:
            for name in names:
                size = found[name][3]
                result = hashlib.sha256()
                captured = bytearray()
                if name == origin_path and size > 1024 * 1024:
                    raise ValueError("Origin receipt exceeds 1 MiB")
                while size:
                    block = process.stdout.read(min(size, 1024 * 1024))
                    if not block:
                        raise ValueError("Truncated SquashFS runtime stream: " + name)
                    size -= len(block)
                    result.update(block)
                    if name == origin_path:
                        captured.extend(block)
                if name == origin_path:
                    if json.loads(captured) != origin:
                        raise ValueError("Actual SquashFS origin receipt differs")
                elif result.hexdigest() != expected[name]["sha256"]:
                    raise ValueError("SquashFS runtime bytes differ from frozen payload: " + name)
            if process.stdout.read(1) or process.wait(timeout=180):
                errors.seek(0)
                raise ValueError("SquashFS streaming failed: " + errors.read().decode(errors="replace")[-4000:])
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("media", type=Path)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("--producer-revision", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.producer_revision):
        raise ValueError("Expected a full media producer revision")
    manifest = json.loads((args.runtime / "manifest.json").read_text())
    origin = json.loads((args.inputs / "runtime-origin.json").read_text())
    media_manifest = json.loads((args.media / "live-manifest.json").read_text())
    if media_manifest["sourceRevision"] != args.producer_revision:
        raise ValueError("Media source does not match verification producer")
    compressed = check_layout(media_manifest)
    name = media_manifest["iso"]["name"]
    if Path(name).name != name or not name.endswith(".iso"):
        raise ValueError("Invalid candidate ISO path")
    iso = args.media / name
    if digest(iso) != media_manifest["iso"]["sha256"]:
        raise ValueError("Candidate ISO changed")
    if manifest["dirty"] or manifest["revision"] != origin["runtimeSourceRevision"]:
        raise ValueError("Expected a frozen runtime matching actual candidate receipt")
    if digest(args.runtime / "manifest.json") != origin["runtimeManifestSha256"]:
        raise ValueError("Runtime manifest differs from actual candidate input receipt")
    expected = {item["path"]: item for item in manifest["files"]}
    for item in origin["overlays"]:
        file = args.inputs / "frozen-overlays" / item["path"]
        if digest(file) != item["sha256"]:
            raise ValueError("Retained frozen overlay bytes changed")
        expected[item["path"]] = {"size": file.stat().st_size, "sha256": item["sha256"],
                                 "mode": item.get("mode", "0755" if item["path"] == "init" or
                                 item["path"].startswith("usr/bin/") or item["path"].endswith(".sh") else "0644")}
    with tempfile.TemporaryDirectory(prefix="polly-iso-runtime-") as temporary:
        initramfs = Path(temporary) / "initramfs.gz"
        subprocess.run(["xorriso", "-osirrox", "on", "-indev", str(iso), "-extract",
                        "/boot/initramfs.gz", str(initramfs)], check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if compressed:
            layout = media_manifest["root"]
            check_bootstrap(initramfs, layout)
            configuration = (args.media / "grub.cfg").read_bytes()
            if hashlib.sha256(configuration).hexdigest() != media_manifest["grub"]["embeddedSha256"]:
                raise ValueError("Retained generated GRUB config differs")
            efi = Path(temporary) / "BOOTX64.EFI"
            efiboot = Path(temporary) / "efiboot.img"
            for source, target in (("EFI/BOOT/BOOTX64.EFI", efi), ("boot/efiboot.img", efiboot)):
                subprocess.run(["xorriso", "-osirrox", "on", "-indev", str(iso), "-extract",
                                "/" + source, str(target)], check=True, timeout=180,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if efi.read_bytes().count(configuration) != 1:
                raise ValueError("Actual EFI does not contain the exact generated GRUB config")
            inner_efi = Path(temporary) / "inner-efi"
            subprocess.run(["mcopy", "-i", str(efiboot), "::/EFI/BOOT/BOOTX64.EFI", str(inner_efi)],
                           check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if digest(inner_efi) != digest(efi):
                raise ValueError("El Torito EFI differs from actual ISO EFI")
            squashfs = Path(temporary) / "root.squashfs"
            marker = Path(temporary) / "marker"
            for source, target in ((layout["path"], squashfs),
                                   ("polly/" + layout["mediaIdentity"] + ".marker", marker)):
                subprocess.run(["xorriso", "-osirrox", "on", "-indev", str(iso), "-extract",
                                "/" + source, str(target)], check=True, timeout=180,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if (squashfs.stat().st_size != layout["size"] or digest(squashfs) != layout["sha256"] or
                    marker.read_text() != layout["sha256"] + "\n"):
                raise ValueError("Actual ISO compressed root/marker differs")
            check_squashfs(squashfs, expected, origin)
            usb = args.media / media_manifest["usb"]["name"]
            if Path(media_manifest["usb"]["name"]).name != media_manifest["usb"]["name"]:
                raise ValueError("Unsafe USB image path")
            if (not usb.name.endswith(".img") or usb.stat().st_size != media_manifest["usb"]["size"] or
                    digest(usb) != media_manifest["usb"]["sha256"]):
                raise ValueError("Candidate USB changed")
            # Builder's exact GPT/FAT offset; mtools reads regular files, never devices.
            for source, reference in ((layout["path"], squashfs),
                                      ("boot/initramfs.gz", initramfs),
                                      ("polly/" + layout["mediaIdentity"] + ".marker", marker),
                                      ("EFI/BOOT/BOOTX64.EFI", efi)):
                actual = Path(temporary) / "usb-entry"
                subprocess.run(["mcopy", "-i", str(usb) + "@@1048576", "::/" + source, str(actual)],
                               check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                if digest(actual) != digest(reference):
                    raise ValueError("USB boot payload differs from verified ISO: " + source)
                actual.unlink()
            records = media_manifest["bootFiles"]
            if {record["path"] for record in records} != {
                    "boot/vmlinuz", "boot/intel-ucode.img", "boot/initramfs.gz", layout["path"]}:
                raise ValueError("Invalid boot payload inventory")
            for record in records:
                if record["path"] not in {"boot/vmlinuz", "boot/intel-ucode.img"}:
                    continue
                reference = Path(temporary) / "optical-boot-entry"
                actual = Path(temporary) / "usb-boot-entry"
                subprocess.run(["xorriso", "-osirrox", "on", "-indev", str(iso), "-extract",
                                "/" + record["path"], str(reference)], check=True, timeout=180,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                subprocess.run(["mcopy", "-i", str(usb) + "@@1048576", "::/" + record["path"], str(actual)],
                               check=True, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                if (reference.stat().st_size != record["size"] or digest(reference) != record["sha256"] or
                        digest(actual) != record["sha256"]):
                    raise ValueError("Actual media kernel/microcode differs: " + record["path"])
                actual.unlink()
                reference.unlink()
        else:
            check_initramfs(initramfs, expected, origin)
    receipt = {"schemaVersion": 2 if compressed else 1, "runtimeSourceRevision": manifest["revision"],
               "runtimeSourceDirty": False, "runtimeManifestSha256": origin["runtimeManifestSha256"],
               "runtimeBuildInputsSha256": origin["runtimeBuildInputsSha256"],
               "mediaProducerRevision": args.producer_revision,
               "overlayProducerRevision": origin["mediaProducerRevision"],
               "overlayRecipeSha256": origin["overlayRecipeSha256"],
               "baseImageID": origin["baseImageID"], "runtimeImageID": media_manifest["runtimeImage"],
               "rootExportSha256": digest(args.inputs / "root.tar"),
               "runtimeOriginSha256": digest(args.inputs / "runtime-origin.json"),
               "isoSha256": digest(iso), "isoPayloadFilesVerified": len(expected),
               "stage": "verified-uefi-candidate-not-physical-qualified",
               "limits": ["ISO payload integrity is not successful UEFI boot or physical qualification.",
                          "Runtime, overlay and media verification producers have separate source revisions."]}
    if compressed:
        receipt.update({"rootLayout": media_manifest["root"],
                        "usbSha256": media_manifest["usb"]["sha256"],
                        "usbPayloadFilesVerified": len(expected), "bootstrapVerified": True})
    if origin.get("fixtureOnly") is True:
        receipt.update({"fixtureOnly": True, "stage": "verified-structure-fixture-not-publishable"})
    target = args.media / "candidate-origin.json"
    if target.exists():
        raise ValueError("Refusing to overwrite candidate origin receipt")
    target.write_text(json.dumps(receipt, indent=2) + "\n")
    with (args.media / "SHA256SUMS").open("a") as sums:
        sums.write(digest(target) + "  candidate-origin.json\n")
    print("PASS: actual media root matches every frozen runtime/overlay byte, mode and origin receipt")


if __name__ == "__main__":
    main()
