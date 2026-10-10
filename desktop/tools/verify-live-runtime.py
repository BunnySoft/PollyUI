#!/usr/bin/env python3
"""Bind actual ISO initramfs payload bytes to a frozen runtime and overlay receipt."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
import tempfile


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
            if name in expected:
                if name in found:
                    raise ValueError("Duplicate runtime initramfs entry: " + name)
                found.add(name)
                record = expected[name]
                if (not stat.S_ISREG(mode) or uid or gid or
                        stat.S_IMODE(mode) != int(record["mode"], 8) or size != record["size"]):
                    raise ValueError("ISO runtime metadata differs from frozen payload: " + name)
            result = hashlib.sha256()
            captured = bytearray() if name == "usr/share/pollyui/runtime-origin.json" else None
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
                                 "mode": "0755" if item["path"] == "init" or
                                 item["path"].startswith("usr/bin/") or item["path"].endswith(".sh") else "0644"}
    with tempfile.TemporaryDirectory(prefix="polly-iso-runtime-") as temporary:
        initramfs = Path(temporary) / "initramfs.gz"
        subprocess.run(["xorriso", "-osirrox", "on", "-indev", str(iso), "-extract",
                        "/boot/initramfs.gz", str(initramfs)], check=True, timeout=180,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        check_initramfs(initramfs, expected, origin)
    receipt = {"schemaVersion": 1, "runtimeSourceRevision": manifest["revision"],
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
    target = args.media / "candidate-origin.json"
    if target.exists():
        raise ValueError("Refusing to overwrite candidate origin receipt")
    target.write_text(json.dumps(receipt, indent=2) + "\n")
    with (args.media / "SHA256SUMS").open("a") as sums:
        sums.write(digest(target) + "  candidate-origin.json\n")
    print("PASS: actual ISO initramfs matches every frozen runtime/overlay byte, mode and origin receipt")


if __name__ == "__main__":
    main()
