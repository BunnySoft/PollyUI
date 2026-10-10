#!/usr/bin/env python3
"""Publish identical optical ISO bytes only after explicit full-VM qualification approval."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile


def digest(file):
    if file.is_symlink() or not file.is_file():
        raise ValueError("Expected a regular artifact: " + str(file))
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_result(result, revision, harness, sha):
    for name in ("ready", "nativeChineseCommit", "nativeClipboardPaste",
                 "keyboardWorkspaceSwitch", "pamSessionRegistered"):
        if result.get(name) is not True:
            raise ValueError("Missing successful full acceptance gate: " + name)
    if (result.get("firmware") != "OVMF UEFI" or result.get("acceleration") != "kvm" or
            result.get("isoSha256") != sha or result.get("ordinaryUser") != 1000 or
            result.get("bootMedia") != "read-only optical"):
        raise ValueError("Optical UEFI acceptance identity mismatch")
    actual = result["newArchitecture"]
    if actual.get("runtimeSourceRevision") != revision or actual.get("harnessRevision") != harness or \
            actual.get("fixturesInIso") is not False:
        raise ValueError("Runtime/harness provenance mismatch or fixture media")
    stages = actual["actualStages"]
    prepared = stages["prepare"]
    if prepared.get("filesNative") is not True or prepared["settingsPid"] == prepared["shellPid"]:
        raise ValueError("Missing actual Files or independent Settings acceptance")
    for stage, theme, files in (("selected", "bigsur", True), ("user-theme", "alpha-vm", True),
                                ("restored", "xp", False)):
        state = stages[stage]
        if state["shellPid"] != prepared["shellPid"] or state["settingsPid"] != prepared["settingsPid"] or \
                state["configuration"] != {"id": theme, "filesEnabled": files}:
            raise ValueError("Missing real owned Settings/JSON operation: " + stage)
    if stages["about"]["sameSettingsPid"] != prepared["settingsPid"] or \
            stages["reopen"]["shellPid"] != prepared["shellPid"] or \
            stages["reopen"]["newSettingsPid"] == prepared["settingsPid"] or \
            stages["reopen"]["configuration"] != stages["restored"]["configuration"]:
        raise ValueError("About or same-session Settings reopen did not pass")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("media", "runtime", "evidence", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--runtime-revision", required=True)
    parser.add_argument("--harness-revision", required=True)
    parser.add_argument("--iso-sha256", required=True)
    parser.add_argument("--approved-for-physical-test", action="store_true")
    args = parser.parse_args()
    if not args.approved_for_physical_test:
        raise ValueError("Explicit qualification approval is required; tool integrity checks are not approval")
    if any(not re.fullmatch(r"[0-9a-f]{40}", value) for value in
           (args.runtime_revision, args.harness_revision)) or not re.fullmatch(r"[0-9a-f]{64}", args.iso_sha256):
        raise ValueError("Expected full explicit runtime/harness revisions and ISO SHA256")
    if args.output.exists():
        raise ValueError("Refusing to overwrite an existing physical-test handoff")
    result = json.loads((args.evidence / "result.json").read_text())
    validate_result(result, args.runtime_revision, args.harness_revision, args.iso_sha256)
    runtime = json.loads((args.runtime / "manifest.json").read_text())
    inputs = json.loads((args.runtime / "build-inputs.json").read_text())
    origin = json.loads((args.media / "candidate-origin.json").read_text())
    if runtime["revision"] != args.runtime_revision or runtime["dirty"] is not False or \
            inputs["revision"] != args.runtime_revision or inputs["dirty"] is not False or \
            inputs["build"]["revisionSource"] != "git" or origin["runtimeSourceRevision"] != args.runtime_revision or \
            origin["isoSha256"] != args.iso_sha256 or \
            origin["runtimeManifestSha256"] != digest(args.runtime / "manifest.json") or \
            origin["runtimeBuildInputsSha256"] != digest(args.runtime / "build-inputs.json"):
        raise ValueError("Frozen runtime/actual ISO origin receipt differs from approved inputs")
    name = result["iso"]
    if Path(name).name != name or not name.endswith(".iso"):
        raise ValueError("Invalid optical artifact name")
    source = args.media / name
    if digest(source) != args.iso_sha256:
        raise ValueError("Approved ISO bytes changed")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".physical-test-", dir=args.output.parent))
    try:
        shutil.copyfile(source, staging / name)
        if digest(staging / name) != args.iso_sha256:
            raise ValueError("Copied optical ISO differs from the accepted media")
        for original, target in ((args.media / "live-manifest.json", "live-manifest.json"),
                                 (args.media / "candidate-origin.json", "candidate-origin.json"),
                                 (args.runtime / "manifest.json", "runtime-manifest.json"),
                                 (args.runtime / "build-inputs.json", "runtime-build-inputs.json")):
            shutil.copyfile(original, staging / target)
        evidence = staging / "vm-evidence"
        evidence.mkdir()
        for artifact in ("result.json", "serial.log", "qemu.log", "desktop.png", "workspace2.png",
                         "settings-appearance.png", "settings-about.png", "settings-reopened.png"):
            shutil.copyfile(args.evidence / artifact, evidence / artifact)
        raw = (evidence / "serial.log").read_text(errors="replace")
        session_failures = [re.sub(r"\x1b\[[0-9;]*m", "", line) for line in raw.splitlines()
                            if "PollyDesktop session failed" in line]
        qualification = {
            "schemaVersion": 1, "stage": "physical-test-eligible-not-hardware-qualified",
            "eligibleForPhysicalTesting": True, "physicalHardwareVerified": False,
            "runtimeSourceRevision": args.runtime_revision, "harnessRevision": args.harness_revision,
            "iso": {"name": name, "sha256": args.iso_sha256, "bytes": source.stat().st_size},
            "sameBytesAsAcceptedUefiOpticalMedia": True, "vmResultSha256": digest(evidence / "result.json"),
            "runtimeManifestSha256": origin["runtimeManifestSha256"],
            "runtimeBuildInputsSha256": origin["runtimeBuildInputsSha256"],
            "candidateOriginSha256": digest(args.media / "candidate-origin.json"),
            "baseImageID": origin["baseImageID"], "runtimeImageID": origin["runtimeImageID"],
            "rootExportSha256": origin["rootExportSha256"],
            "scope": "Primary ordinary-user seat0 desktop and all recorded application acceptance stages.",
            "rawSessionFailuresPreserved": session_failures,
            "references": {"candidate": str(args.media), "runtime": str(args.runtime),
                           "fullVmEvidence": str(args.evidence)},
            "limits": [
                "Unsigned UEFI memory-only Live Alpha; no installer, automatic internal-disk mounting or disk persistence.",
                "Physical hardware boot, GPU, wired/Wi-Fi networking and audio remain unverified.",
                "The 4 GiB/2-vCPU virtio guest is a test configuration, not a proven hardware minimum.",
                "No guest NIC or host audio; VM success does not qualify physical network/audio signals.",
                "QMP quit is not an ordinary guest user power-off test.",
                "Secondary ttyS0 login session3 has no seat; its desktop attempt fails with status1 before returning CLI.",
                "The primary Shell PID is independently stable throughout the accepted Settings/JSON stages.",
                "USB image boot was not tested in this run and is not qualified by this optical ISO handoff.",
                "Historical failures/diagnostics remain retained; raw logs are not error-free.",
                "No USB writing, host firmware change or physical-machine operation was performed.",
                "Redistribution/source-compliance audit is not asserted complete."
            ]
        }
        (staging / "qualification.json").write_text(json.dumps(qualification, indent=2) + "\n")
        (staging / "HANDOFF.txt").write_text(
            "PollyDesktop " + runtime["version"] + " physical-test optical ISO\n"
            "Read qualification.json for approved scope and limitations.\n"
            "SHA256: " + args.iso_sha256 + "\n"
            "Identical bytes to the accepted OVMF UEFI/KVM optical media; not rebuilt after testing.\n"
            "Unsigned, memory-only Live boot. No installer or automatic internal-disk mounting.\n"
            "Physical GPU, networking, audio, hardware compatibility and power-off remain unverified.\n"
            "Raw logs preserve the secondary seatless serial-login desktop failure; only primary seat0 is accepted.\n"
            "The USB image has not received this optical boot qualification. No device has been written.\n")
        files = sorted(file for file in staging.rglob("*") if file.is_file())
        (staging / "SHA256SUMS").write_text("".join(digest(file) + "  " +
            file.relative_to(staging).as_posix() + "\n" for file in files))
        staging.rename(args.output)
    except BaseException:
        shutil.rmtree(staging)
        raise
    print("Created same-byte physical-test optical ISO handoff; physical hardware remains unverified")


if __name__ == "__main__":
    main()
