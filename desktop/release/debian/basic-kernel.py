#!/usr/bin/env python3
"""Verify/build an explicit offline Debian basic kernel input; never fetch or install it."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import runpy
import shutil
import stat
import subprocess
import tarfile
import tempfile
import traceback

HERE = Path(__file__).resolve().parent
PROFILES = runpy.run_path(str(HERE / "live-profile.py"))
HELPERS = HERE / "live-root.py" if (HERE / "live-root.py").is_file() else HERE.parents[1] / "tools/live-root.py"
RECEIPT = "usr/share/polly-basic-kernel.json"
CONFIG = "usr/share/polly-basic-kernel.config"
STRATEGY = "debian-bindeb-pkg-simpledrm-unsigned-dev"


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def regular(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("Kernel pack requires regular files: " + str(path))


def check_manifest(value):
    PROFILES["keys"](value, ("schemaVersion", "kind", "kernelRelease", "package", "configSha256", "source"))
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["kind"] != "polly-basic-kernel-pack" or
            not re.fullmatch(r"[a-zA-Z0-9.+_-]+-polly-basic", value["kernelRelease"])):
        raise ValueError("Invalid dedicated basic kernel identity")
    PROFILES["keys"](value["package"], ("name", "version", "architecture", "sha256", "size"))
    package = value["package"]
    if (package["name"] != "linux-image-" + value["kernelRelease"] or package["architecture"] != "amd64" or
            not isinstance(package["version"], str) or not re.fullmatch(r"[A-Za-z0-9.+:~_-]+", package["version"]) or
            type(package["size"]) is not int or not 0 < package["size"] < 2 ** 31):
        raise ValueError("Invalid kernel image Debian package identity")
    PROFILES["keys"](value["source"], ("archiveSha256", "baseConfigSha256", "strategy"))
    if value["source"]["strategy"] != STRATEGY:
        raise ValueError("Unknown kernel source build strategy")
    for sha in (value["configSha256"], package["sha256"],
                value["source"]["archiveSha256"], value["source"]["baseConfigSha256"]):
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError("Invalid kernel input SHA256")


def verify_pack(directory):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Kernel pack directory must be a real directory")
    for name in ("kernel-pack.json", "kernel.config", "kernel-image.deb"):
        regular(directory / name)
    metadata = directory / "kernel-pack.json"
    if metadata.stat().st_size > 65536:
        raise ValueError("Oversize kernel pack metadata")
    value = json.loads(metadata.read_bytes())
    check_manifest(value)
    config, deb = directory / "kernel.config", directory / "kernel-image.deb"
    if (digest(config) != value["configSha256"] or digest(deb) != value["package"]["sha256"] or
            deb.stat().st_size != value["package"]["size"]):
        raise ValueError("Kernel pack actual bytes differ from declared identity")
    PROFILES["verify_kernel"](config.read_text(), PROFILES["profile"]("basic"))
    fields = subprocess.check_output(["dpkg-deb", "-f", str(deb), "Package", "Version", "Architecture"],
                                     text=True, timeout=30).splitlines()
    package = value["package"]
    if fields != ["Package: " + package["name"], "Version: " + package["version"], "Architecture: amd64"]:
        raise ValueError("Kernel .deb identity differs from kernel pack")
    with tempfile.TemporaryFile() as archive_file:
        subprocess.run(["dpkg-deb", "--fsys-tarfile", str(deb)], check=True, stdout=archive_file, timeout=180)
        archive_file.seek(0)
        helpers = runpy.run_path(str(HELPERS))
        with tarfile.open(fileobj=archive_file) as archive:
            members = helpers["export_members"](archive)
            if any(name.endswith("/signing_key.pem") for name in members):
                raise ValueError("Kernel image package must not contain the private build signing key")
            release = value["kernelRelease"]
            kernels = [name for name, node in members.items() if name.startswith("boot/vmlinuz-") and node.isfile()]
            module_releases = {name.split("/")[3 if name.startswith("usr/") else 2] for name in members
                               if re.match(r"(?:usr/)?lib/modules/[^/]+/", name)}
            if kernels != ["boot/vmlinuz-" + release] or module_releases != {release}:
                raise ValueError("Kernel pack must contain exactly one kernel and matching module release")
            with archive.extractfile(members[kernels[0]]) as source:
                image_sha = hashlib.file_digest(source, "sha256").hexdigest()
            node = members["boot/config-" + release]
            with archive.extractfile(node) as source:
                if not node.isfile() or source.read() != config.read_bytes():
                    raise ValueError("Pack config differs from actual Debian kernel payload")
            options = dict(line.split("=", 1) for line in config.read_text().splitlines()
                           if line.startswith("CONFIG_") and "=" in line)
            if options["CONFIG_DRM_SIMPLEDRM"] == "m" and not any(
                    name.endswith(("simpledrm.ko", "simpledrm.ko.xz", "simpledrm.ko.gz"))
                    and node.isfile() for name, node in members.items()):
                raise ValueError("Kernel pack omits its simpledrm module")
    return {**value, "packManifestSha256": digest(metadata), "imageSha256": image_sha}


def verify_root(root):
    path, config = root / RECEIPT, root / CONFIG
    PROFILES["regular"](path)
    PROFILES["regular"](config)
    value = json.loads(path.read_bytes())
    sha = value.pop("packManifestSha256", None)
    image_sha = value.pop("imageSha256", None)
    check_manifest(value)
    if (any(not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{64}", item) for item in (sha, image_sha)) or
            digest(config) != value["configSha256"]):
        raise ValueError("Actual root dedicated kernel receipt/config mismatch")
    PROFILES["verify_kernel"](config.read_text(), PROFILES["profile"]("basic"))
    installed = PROFILES["packages"](root)
    images = {name for name in installed if name.startswith("linux-image-")}
    if (images != {value["package"]["name"]} or
            installed[value["package"]["name"]]["version"] != value["package"]["version"]):
        raise ValueError("Actual installed kernel differs from dedicated kernel pack")
    return {**value, "packManifestSha256": sha, "imageSha256": image_sha}


def build(source, source_sha, config, config_sha, output, jobs):
    for path, sha in ((source, source_sha), (config, config_sha)):
        regular(path)
        if not re.fullmatch(r"[0-9a-f]{64}", sha) or digest(path) != sha:
            raise ValueError("Explicit offline kernel source/config SHA256 mismatch")
    if output.exists() or output.is_symlink():
        raise ValueError("Refusing existing kernel pack output")
    if jobs < 1 or jobs > 64:
        raise ValueError("Kernel build jobs must be between 1 and 64")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".polly-kernel-", dir=output.parent) as temporary:
        stage = Path(temporary)
        unpack = stage / "source"
        unpack.mkdir()
        with tarfile.open(source) as archive:
            helpers = runpy.run_path(str(HELPERS))
            members = helpers["export_members"](archive)
            if any(name.endswith("/certs/signing_key.pem") for name in members):
                raise ValueError("Dedicated kernel source archive must not contain a pre-existing private signing key")
            archive.extractall(unpack, filter="data")
        roots = [path for path in unpack.iterdir() if path.is_dir() and not path.is_symlink()]
        if len(roots) != 1 or not (roots[0] / "Makefile").is_file() or not (roots[0] / "scripts/config").is_file():
            raise ValueError("Expected one complete local Linux source archive")
        kernel, obj = roots[0], stage / "build"
        obj.mkdir()
        shutil.copyfile(config, obj / ".config")
        log = stage / "kernel-build.log"
        log.touch()

        def retain_failure():
            with tempfile.NamedTemporaryFile(prefix=output.name + ".failed-", suffix=".log",
                                             dir=output.parent, delete=False) as target:
                with log.open("rb") as source:
                    shutil.copyfileobj(source, target)
                return Path(target.name)

        def run(*command, capture=False):
            with log.open("ab") as target:
                target.write(("\n$ " + repr(command) + "\n").encode())
                result = subprocess.run(command, check=False, stdout=subprocess.PIPE if capture else target,
                                        stderr=target, timeout=21600)
                if capture and result.stdout is not None:
                    target.write(result.stdout)
                if result.returncode:
                    raise subprocess.CalledProcessError(result.returncode, command)
                return result.stdout.decode().strip() if capture else None

        try:
            for key in (kernel / "certs/signing_key.pem", obj / "certs/signing_key.pem"):
                if key.exists() or key.is_symlink():
                    raise ValueError("Dedicated kernel build refuses pre-existing signing keys; use a key-free source archive")
            make = ["make", "-C", str(kernel), "O=" + str(obj)]
            run(*make, "olddefconfig")
            signing = []
            if "CONFIG_MODULE_SIG=y" in (obj / ".config").read_text().splitlines():
                signing = ["--enable", "MODULE_SIG_ALL", "--set-str", "MODULE_SIG_KEY", "certs/signing_key.pem"]
            run(str(kernel / "scripts/config"), "--file", str(obj / ".config"),
                "--module", "DRM_SIMPLEDRM", "--enable", "SYSFB_SIMPLEFB", "--disable", "FB_SIMPLE",
                "--disable", "MODULE_COMPRESS_ZSTD", "--enable", "MODULE_COMPRESS_XZ",
                "--disable", "LOCALVERSION_AUTO", "--set-str", "LOCALVERSION", "-polly-basic",
                "--set-str", "SYSTEM_TRUSTED_KEYS", "", "--set-str", "SYSTEM_REVOCATION_KEYS", "",
                *signing)
            run(*make, "olddefconfig")
            run(*make, "syncconfig")
            config_values = []
            for path in (obj / ".config", obj / "include/config/auto.conf"):
                config_values.append({key: value.strip('"') for line in path.read_text().splitlines()
                                      if line.startswith("CONFIG_") and "=" in line
                                      for key, value in [line.split("=", 1)]})
            policy_names = {name for values in config_values for name in values
                            if name.startswith(("CONFIG_LOCALVERSION", "CONFIG_DRM_", "CONFIG_SYSFB_",
                                                "CONFIG_MODULE_COMPRESS", "CONFIG_MODULE_SIG",
                                                "CONFIG_SYSTEM_TRUSTED_KEYS", "CONFIG_SYSTEM_REVOCATION_KEYS"))}
            policy_names.add("CONFIG_FB_SIMPLE")
            if any(config_values[0].get(name, "n") != config_values[1].get(name, "n") for name in policy_names):
                raise ValueError("Kernel .config and generated auto.conf disagree on basic kernel policy")
            PROFILES["verify_kernel"]((obj / ".config").read_text(), PROFILES["profile"]("basic"))
            release = run(*make, "-s", "kernelrelease", capture=True)
            if not re.fullmatch(r"[a-zA-Z0-9.+_-]+-polly-basic", release):
                raise ValueError("Dedicated kernel release must end with -polly-basic")
            run(*make, "-j" + str(jobs), "bindeb-pkg", "KDEB_PKGVERSION=1+polly.basic",
                "KDEB_SOURCENAME=polly-basic-linux")
            images = []
            for deb in stage.glob("linux-image-*.deb"):
                name = subprocess.check_output(["dpkg-deb", "-f", str(deb), "Package"], text=True, timeout=30).strip()
                if name == "linux-image-" + release:
                    images.append(deb)
            if len(images) != 1:
                raise ValueError("Expected exactly one dedicated built kernel image package")
            pack = stage / "pack"
            pack.mkdir()
            shutil.copyfile(images[0], pack / "kernel-image.deb")
            shutil.copyfile(obj / ".config", pack / "kernel.config")
            deb = pack / "kernel-image.deb"
            version = subprocess.check_output(["dpkg-deb", "-f", str(deb), "Version"], text=True, timeout=30).strip()
            value = {"schemaVersion": 1, "kind": "polly-basic-kernel-pack", "kernelRelease": release,
                     "package": {"name": "linux-image-" + release, "version": version, "architecture": "amd64",
                                 "sha256": digest(deb), "size": deb.stat().st_size},
                     "configSha256": digest(pack / "kernel.config"),
                     "source": {"archiveSha256": source_sha, "baseConfigSha256": config_sha, "strategy": STRATEGY}}
            (pack / "kernel-pack.json").write_text(json.dumps(value, indent=2) + "\n")
            result = verify_pack(pack)
            shutil.copyfile(log, pack / "kernel-build.log")
            pack.rename(output)
        except BaseException as error:
            with log.open("a") as target:
                traceback.print_exception(error, file=target)
            failure = retain_failure()
            error.add_note("Kernel build raw log retained: " + str(failure))
            raise
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("verify")
    check.add_argument("directory", type=Path)
    install = commands.add_parser("install")
    install.add_argument("directory", type=Path)
    create = commands.add_parser("build")
    for name in ("source", "config", "output"):
        create.add_argument("--" + name, type=Path, required=True)
    for name in ("source-sha256", "config-sha256"):
        create.add_argument("--" + name, required=True)
    create.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    if args.command == "build":
        result = build(args.source, args.source_sha256, args.config, args.config_sha256, args.output, args.jobs)
    else:
        result = verify_pack(args.directory)
        if args.command == "install":
            if any(name.startswith("linux-image-") for name in PROFILES["packages"](Path("/"))):
                raise ValueError("Dedicated kernel installation requires a clean runtime with no stock kernel")
            subprocess.run(["apt-get", "install", "-y", "--no-install-recommends",
                            str((args.directory / "kernel-image.deb").resolve())], check=True, timeout=600)
            for name, data in ((RECEIPT, (json.dumps(result, indent=2) + "\n").encode()),
                               (CONFIG, (args.directory / "kernel.config").read_bytes())):
                target = Path("/") / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(0o644)
            verify_root(Path("/"))
            release = result["kernelRelease"]
            if (sorted(path.name for path in Path("/boot").glob("vmlinuz-*")) != ["vmlinuz-" + release] or
                    digest(Path("/boot") / ("vmlinuz-" + release)) != result["imageSha256"] or
                    digest(Path("/boot") / ("config-" + release)) != result["configSha256"]):
                raise ValueError("Installed basic boot kernel/config differs from verified input package")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
