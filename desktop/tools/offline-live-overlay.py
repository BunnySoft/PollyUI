#!/usr/bin/env python3
"""Verify an offline Live overlay; runtime and media-producer revisions are separate.

Run inside the private candidate: offline-live-overlay.py overlay BUNDLE FROZEN_SOURCE
  --runtime-revision SHA --producer-revision SHA --base-image IMAGE_ID
  --recipe FILE --offline-inputs DIRECTORY
No network, package installation, account changes or disk operations occur here.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import stat
import subprocess


OVERLAYS = {
    "init": "desktop/release/live/init",
    "usr/bin/polly-live-session": "desktop/release/live/session",
    "usr/bin/polly-live-diagnostics": "desktop/release/live/diagnostics",
    "usr/share/pollyui/desktop/tools/live-session-mode.sh": "desktop/release/live/session-mode",
    "usr/share/pollyui/desktop/shell/live.mjs": "desktop/release/live/shell.mjs",
    "usr/share/pollyui/power-dependencies.json": "desktop/release/debian/power-dependencies.json",
}
NAMESPACES = ("usr/share/pollyui", "usr/lib/pollyui", "usr/share/licenses/pollyui",
              "usr/share/doc/pollyui", "usr/share/icons/PollyRabbit", "usr/share/icons/PollyClassic")


def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def regular(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Expected a regular input/payload: " + str(file))
    return info


def verify_files(root, manifest):
    expected = {}
    for item in manifest["files"]:
        name = item["path"]
        if name in expected or not name.startswith("usr/") or any(
                part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("Invalid runtime inventory path: " + name)
        file = root / name
        info = regular(file)
        if (info.st_size != item["size"] or digest(file) != item["sha256"] or
                stat.S_IMODE(info.st_mode) != int(item["mode"], 8) or info.st_uid or info.st_gid):
            raise ValueError("Frozen runtime payload/ownership/mode mismatch: " + name)
        expected[name] = item
    for name in ("usr/share/pollyui/desktop/shared/configuration-files.mjs",
                 "usr/share/pollyui/sysrt/bindings/generated/files-linux-x86_64.mjs",
                 "usr/bin/polly-settings"):
        if name not in expected:
            raise ValueError("Missing new-architecture runtime resource: " + name)
    return expected


def verify_pins(text):
    count = 0
    seen = set()
    for line in text.splitlines():
        name, version = line.split("=", 1)
        if name in seen:
            raise ValueError("Duplicate package pin: " + name)
        seen.add(name)
        actual = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", name],
                                         text=True, timeout=10)
        if actual != version:
            raise ValueError(f"Offline base/package pin mismatch: {name}: {actual} != {version}")
        count += 1
    return count


def verify_offline_inputs(directory):
    metadata = directory / "input-pack.json"
    if regular(metadata).st_size > 4 * 1024 * 1024 or (directory / "packages").is_symlink():
        raise ValueError("Invalid offline input metadata/directory")
    offline = json.loads(metadata.read_text())
    if offline.get("kind") != "debian-runtime-binary-inputs" or offline.get("schemaVersion") != 1:
        raise ValueError("Unknown offline binary input format")
    seen = set()
    for item in offline["packages"]:
        if (item["name"] in seen or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) or
                item["file"] != "packages/" + item["sha256"] + ".deb"):
            raise ValueError("Invalid offline input path or duplicate identity")
        seen.add(item["name"])
        file = directory / item["file"]
        if regular(file).st_size != item["bytes"] or digest(file) != item["sha256"]:
            raise ValueError("Offline cached input changed: " + item["name"])
        fields = subprocess.check_output(["dpkg-deb", "-f", str(file), "Package", "Version", "Architecture"],
                                         text=True, timeout=10).splitlines()
        if fields != ["Package: " + item["name"].split(":")[0], "Version: " + item["version"],
                      "Architecture: " + item["architecture"]]:
            raise ValueError("Offline input identity differs from metadata: " + item["name"])
    if not seen:
        raise ValueError("No explicit offline inputs")
    return offline


def verify_namespaces(root, allowed):
    for namespace in NAMESPACES:
        for file in (root / namespace).rglob("*"):
            if file.is_file() or file.is_symlink():
                name = file.relative_to(root).as_posix()
                if name not in allowed:
                    raise ValueError("Old/unlisted Polly runtime file survived the overlay: " + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inputs_parser = commands.add_parser("inputs")
    inputs_parser.add_argument("directory", type=Path)
    for command in ("overlay", "assembled"):
        overlay_parser = commands.add_parser(command)
        overlay_parser.add_argument("bundle", type=Path)
        overlay_parser.add_argument("source", type=Path)
        overlay_parser.add_argument("--runtime-revision", required=True)
        overlay_parser.add_argument("--producer-revision", required=True)
        overlay_parser.add_argument("--base-image", required=True)
        overlay_parser.add_argument("--recipe", type=Path, required=True)
        if command == "overlay":
            overlay_parser.add_argument("--offline-inputs", type=Path, required=True)
        else:
            overlay_parser.add_argument("--sku", required=True)
            overlay_parser.add_argument("--tools-image", required=True)
    args = parser.parse_args()
    if args.command == "inputs":
        verify_offline_inputs(args.directory.resolve())
        print("PASS: offline input identities and exact archive bytes before package execution")
        return
    for revision in (args.runtime_revision, args.producer_revision):
        if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
            raise ValueError("Expected a full explicit source revision")
    if not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", args.base_image):
        raise ValueError("Expected an immutable base image ID")
    bundle, source = args.bundle.resolve(), args.source.resolve()
    manifest = json.loads((bundle / "manifest.json").read_text())
    inputs = json.loads((bundle / "build-inputs.json").read_text())
    if (manifest["revision"] != args.runtime_revision or manifest["dirty"] is not False or
            inputs["build"]["revisionSource"] != "git" or inputs["revision"] != manifest["revision"]):
        raise ValueError("Offline media requires a verified frozen Git runtime, not an external label")
    root = Path("/")
    expected = verify_files(root, manifest)
    overlays = []
    for target, original in OVERLAYS.items():
        file, frozen = root / target, source / original
        info = regular(file)
        executable = target == "init" or target.startswith("usr/bin/") or target.endswith(".sh")
        if (digest(file) != digest(frozen) or info.st_uid or info.st_gid or
                stat.S_IMODE(info.st_mode) != (0o755 if executable else 0o644)):
            raise ValueError("Live overlay differs from frozen source: " + target)
        overlays.append({"path": target, "source": original, "sha256": digest(file)})
    boot_install = runpy.run_path(str(source / "desktop/release/debian/boot-install.py"))
    boot_targets = set()
    for target, original, data, mode in boot_install["files"](source):
        file = root / target
        info = regular(file)
        if (file.read_bytes() != data or info.st_uid or info.st_gid or stat.S_IMODE(info.st_mode) != mode):
            raise ValueError("Live boot overlay differs from frozen source: " + target)
        boot_targets.add(target)
        overlays.append({"path": target, "source": original, "sha256": digest(file), "mode": f"{mode:04o}"})
    kernel_input = None
    selected = None
    if args.command == "assembled":
        profiles = runpy.run_path(str(source / "desktop/release/debian/live-profile.py"))
        selected = profiles["verify"](root, args.sku)
        for name, original in [
                *[("usr/lib/polly-hardware/" + name, "desktop/release/debian/" + name)
                  for name in ("live-profile.py", "live-profiles.json", "basic-kernel.py", "live-display.py")],
                ("usr/lib/polly-hardware/live-root.py", "desktop/tools/live-root.py")]:
            info = regular(root / name)
            if (info.st_uid or info.st_gid or stat.S_IMODE(info.st_mode) != 0o644 or
                    (root / name).read_bytes() != (source / original).read_bytes()):
                raise ValueError("Live hardware helper differs from frozen source: " + name)
            overlays.append({"path": name, "source": original, "sha256": digest(root / name), "mode": "0644"})
        if args.sku == "basic":
            kernel_tools = runpy.run_path(str(source / "desktop/release/debian/basic-kernel.py"))
            kernel_input = kernel_tools["verify_root"](root)
            for name in (kernel_tools["RECEIPT"], kernel_tools["CONFIG"], profiles["BASIC_MODPROBE"]):
                overlays.append({"path": name, "source": "generated:basic-kernel-input",
                                 "sha256": digest(root / name), "mode": "0644"})
        if not re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", args.tools_image):
            raise ValueError("Expected immutable image tools ID")
        for name in (profiles["MARKER"], profiles["PROFILE_COPY"]):
            overlays.append({"path": name, "source": "generated:hardware-profile",
                             "sha256": digest(root / name), "mode": "0644"})
    origin_path = "usr/share/pollyui/runtime-origin.json"
    allowed = set(expected) | set(OVERLAYS) | boot_targets | {origin_path}
    verify_namespaces(root, allowed)
    pins = verify_pins((bundle / "runtime-packages.txt").read_text())
    offline = verify_offline_inputs(args.offline_inputs) if args.command == "overlay" else None
    packages = subprocess.check_output(
        ["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Homepage}\n"], text=True, timeout=30)
    inventory = root / "usr/share/polly-live-packages.tsv"
    inventory.write_text(packages)
    inventory.chmod(0o644)
    if selected:
        for name in ("var/lib/dpkg/status", "usr/share/polly-live-packages.tsv"):
            regular(root / name)
            overlays.append({"path": name, "source": "generated:installed-packages",
                             "sha256": digest(root / name), "mode": "0644"})
    receipt = {"schemaVersion": 1, "runtimeSourceRevision": args.runtime_revision,
               "runtimeSourceDirty": False, "runtimeRevisionSource": "git",
               "runtimeManifestSha256": digest(bundle / "manifest.json"),
               "runtimeBuildInputsSha256": digest(bundle / "build-inputs.json"),
               "mediaProducerRevision": args.producer_revision, "baseImageID": args.base_image,
               "overlayRecipeSha256": digest(args.recipe), "overlayVerifierSha256": digest(Path(__file__)),
               "runtimePayloadFiles": len(expected), "runtimePackagePins": pins,
               "overlays": overlays,
               "limits": ["Local byte/input receipt, not a signature or source-compliance approval.",
                          "Not UEFI or hardware acceptance; guest changes remain memory-only."]}
    if selected:
        receipt.update({"sku": args.sku, "hardwareProfile": selected, "imageToolsID": args.tools_image,
                        "nativeRuntime": {"imageID": args.base_image, "sourceRevision": args.runtime_revision,
                                          "manifestSha256": digest(bundle / "manifest.json")}})
        if kernel_input is not None:
            receipt["kernelInput"] = kernel_input
    else:
        receipt["offlineInputs"] = offline
    target = root / origin_path
    target.write_text(json.dumps(receipt, indent=2) + "\n")
    target.chmod(0o644)
    print("PASS: offline frozen runtime overlay, exact pins, final bytes/modes and no old Polly files")


if __name__ == "__main__":
    main()
