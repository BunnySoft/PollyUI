#!/usr/bin/env python3
"""Build a pinned, private standalone ANGLE Metal runtime; never install system tools."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "third_party" / "angle-metal-manifest.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, cwd=None, env=None):
    print("+ " + " ".join(str(arg) for arg in args), flush=True)
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        print(result.stdout, flush=True)
        raise subprocess.CalledProcessError(result.returncode, args, output=result.stdout)
    return result.stdout


def fetch(url, path, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        with urllib.request.urlopen(url) as response, path.open("wb") as target:
            shutil.copyfileobj(response, target)
    if digest(path) != expected:
        raise RuntimeError(f"Official source checksum mismatch: {path}")


def checkout(repository, revision, folder):
    if not folder.exists():
        folder.mkdir(parents=True)
        command(["git", "init", folder])
        command(["git", "-C", folder, "remote", "add", "origin", repository])
        command(["git", "-C", folder, "fetch", "--depth=1", "origin", revision])
        command(["git", "-C", folder, "checkout", "--detach", revision])
    if command(["git", "-C", folder, "rev-parse", "HEAD"]).strip() != revision:
        raise RuntimeError(f"Refusing to replace another checkout: {folder}")
    if command(["git", "-C", folder, "status", "--porcelain", "--untracked-files=no"]).strip():
        raise RuntimeError(f"Refusing modified third-party sources: {folder}")


def library_dependencies(path):
    lines = command(["otool", "-L", path]).splitlines()[2:]
    return [line.strip().split(" (compatibility version", 1)[0] for line in lines]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=ROOT / "third_party" / "angle-metal")
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache" / "angle-metal-25b5594")
    parser.add_argument("--dest", type=Path, default=ROOT / "build" / "mac-webgl" / "gui" / "polly-angle")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--verify-source", action="store_true", help="Verify archives/ABI/license only; not a Mac build")
    args = parser.parse_args()
    pin = json.loads(MANIFEST.read_text())
    cache, work, dest = args.cache.resolve(), args.work.resolve(), args.dest.resolve()
    if args.jobs < 1 or work in (ROOT, Path.home(), Path(work.anchor)):
        parser.error("Use a private non-root work directory and a positive job count")
    archive = cache / "angle-25b5594.tar.gz"
    tools_archive = cache / "depot-tools-2fd34a8.tar.gz"
    fetch(pin["archiveUrl"], archive, pin["archiveSha256"])
    tools = pin["depotTools"]
    fetch(tools["archiveUrl"], tools_archive, tools["archiveSha256"])
    checked_files = {}
    with tarfile.open(archive) as source:
        prefix = f'angle-{pin["commit"]}/'
        for name, expected in [
            ("DEPS", pin["depsSha256"]), ("LICENSE", pin["licenseSha256"]),
            ("extensions/EGL_ANGLE_device_metal.txt", pin["deviceExtensionSha256"]),
        ]:
            stream = source.extractfile(prefix + name)
            if stream is None:
                raise RuntimeError(f"Missing original source/license: {name}")
            actual = hashlib.sha256(stream.read()).hexdigest()
            if actual != expected:
                raise RuntimeError(f"Source/ABI/license checksum mismatch: {name}")
            checked_files[name] = actual
    if args.verify_source:
        print(json.dumps({"kind": "source-integrity-only-not-native-compilation",
                          "commit": pin["commit"], "files": checked_files}, indent=2))
        return
    if platform.system() != "Darwin":
        parser.error("Native ANGLE Metal compilation requires macOS; archive verification is not a substitute")
    sdk = command(["xcrun", "--sdk", "macosx", "--show-sdk-version"]).strip()
    sdk_root = Path(command(["xcrun", "--sdk", "macosx", "--show-sdk-path"]).strip())
    if tuple(map(int, sdk.split("."))) < tuple(map(int, pin["minimumMacSdk"].split("."))):
        raise RuntimeError(f'Pinned ANGLE needs macOS SDK >= {pin["minimumMacSdk"]}, selected {sdk}')
    xcode = command(["xcodebuild", "-version"]).strip()
    command(["xcrun", "metal", "--version"])
    command(["xcrun", "--find", "metallib"])
    angle, depot = work / "angle", work / "depot_tools"
    checkout(pin["repository"], pin["commit"], angle)
    checkout(tools["repository"], tools["commit"], depot)
    if digest(angle / "DEPS") != pin["depsSha256"] or digest(angle / "LICENSE") != pin["licenseSha256"]:
        raise RuntimeError("Fetched Git tree does not match verified official source archive")
    environment = os.environ.copy()
    environment["PATH"] = str(depot) + os.pathsep + environment["PATH"]
    environment["DEPOT_TOOLS_UPDATE"] = "0"
    environment["DEPOT_TOOLS_METRICS"] = "0"
    custom = pin["gclientCustomVars"]
    spec = {"name": "angle", "url": pin["repository"], "managed": False, "custom_vars": custom}
    config = f"solutions = [{spec!r}]\ntarget_os = ['mac']\n"
    config_path = work / ".gclient"
    if config_path.exists() and config_path.read_text() != config:
        raise RuntimeError(f"Refusing to overwrite another gclient policy: {config_path}")
    config_path.write_text(config)
    # --nohooks prevents Chromium's system/hermetic Xcode hook; system Xcode is explicit below.
    print(command([depot / "gclient", "sync", "--nohooks", "--no-history",
                   "--revision", f'angle@{pin["commit"]}'], cwd=work, env=environment))
    locked = command([depot / "gclient", "revinfo", "--actual", "--output-json",
                      work / "dependency-revisions.json"], cwd=work, env=environment)
    print(locked)
    if command(["git", "-C", angle, "rev-parse", "HEAD"]).strip() != pin["commit"]:
        raise RuntimeError("gclient changed the fixed ANGLE source revision")
    arch = {"arm64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if arch is None:
        raise RuntimeError(f"Unsupported native macOS architecture: {platform.machine()}")
    flags = dict(pin["gnArgs"], target_cpu=arch)
    serialize = lambda value: json.dumps(value)
    gn_args = "\n".join(f"{name} = {serialize(value)}" for name, value in flags.items()) + "\n"
    build = angle / "out" / "PollyMetal"
    build.mkdir(parents=True, exist_ok=True)
    (build / "args.gn").write_text(gn_args)
    gn, ninja = angle / "buildtools" / "mac" / "gn", angle / "third_party" / "ninja" / "ninja"
    print(command([gn, "gen", build, "--fail-on-unused-args"], cwd=angle, env=environment))
    print(command([ninja, "-C", build, "-j", args.jobs, "libEGL", "libGLESv2"], env=environment))
    dest.mkdir(parents=True, exist_ok=True)
    before, after = {}, {}
    for name in ("libGLESv2.dylib", "libEGL.dylib"):
        original, staged = build / name, dest / name
        before[name] = digest(original)
        shutil.copy2(original, staged)
        command(["install_name_tool", "-id", "@rpath/" + name, staged])
        for dependency in library_dependencies(staged):
            basename = Path(dependency).name
            if basename in ("libEGL.dylib", "libGLESv2.dylib"):
                command(["install_name_tool", "-change", dependency, "@loader_path/" + basename, staged])
            elif not dependency.startswith(("/System/Library/", "/usr/lib/")):
                raise RuntimeError(f"Unstaged/unsafe runtime dependency: {dependency}")
        command(["codesign", "--force", "--sign", "-", "--timestamp=none", staged])
        command(["codesign", "--verify", "--strict", staged])
        after[name] = {"sha256": digest(staged), "dependencies": library_dependencies(staged)}
    license_files = {}
    for folder in (angle, depot):
        for current, dirs, names in os.walk(folder):
            dirs[:] = [name for name in dirs if name not in (".git", "out", "__pycache__")]
            for name in names:
                if name.upper().startswith(("LICENSE", "COPYING", "NOTICE")) or name == "README.chromium":
                    source = Path(current) / name
                    if not source.is_file():
                        continue
                    relative = Path(folder.name) / source.relative_to(folder)
                    target = dest / "licenses" / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
                    license_files[str(relative)] = digest(source)
    shutil.copy2(MANIFEST, dest / MANIFEST.name)
    receipt = {"kind": "native-macOS-built-ANGLE-Metal-not-rendering-qualification",
               "pin": pin, "sourceArchives": {"angle": digest(archive), "depotTools": digest(tools_archive)},
               "sdk": sdk, "sdkRoot": str(sdk_root), "xcode": xcode, "architecture": arch, "gnArgs": flags,
               "sdkDeviceAbi": {name: digest(sdk_root / name) for name in (
                   "System/Library/Frameworks/Metal.framework/Headers/MTLDevice.h",
                   "System/Library/Frameworks/Foundation.framework/Headers/NSBundle.h",
                   "System/Library/Frameworks/Foundation.framework/Headers/NSFileManager.h",
                   "usr/include/mach-o/dyld.h")},
               "sourceDirectory": str(angle), "outputDirectory": str(build), "stageDirectory": str(dest),
               "originalDylibs": before, "stagedDylibs": after, "licenses": license_files,
               "actualDependencies": json.loads((work / "dependency-revisions.json").read_text()),
               "qualification": "Compilation/staging only. Real core/mip/pixel/Three/current/lifetime tests must run separately."}
    (dest / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"stage": str(dest), "dylibs": after, "licenses": len(license_files)}, indent=2))


if __name__ == "__main__":
    main()
