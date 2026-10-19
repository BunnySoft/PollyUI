#!/usr/bin/env python3
"""Offline configured assembly adapter. A saved solver result is never authentication."""
import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tempfile

PLAN = "etc/polly-build-plan.json"
LOCK = "etc/polly-packages.lock.json"
HERE = Path(__file__).resolve().parent


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def object_hash(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def digest(file):
    with file.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def load(directory):
    plan = json.loads((directory / "resolved-plan.json").read_bytes())
    lock = json.loads((directory / "packages.lock.json").read_bytes())
    check_plan(plan, lock)
    return plan, lock


def check_plan(plan, lock):
    content = {key: value for key, value in plan.items() if key != "planSha256"}
    if (plan.get("schemaVersion") != 1 or plan.get("kind") != "polly-live-build-plan" or
            object_hash(content) != plan.get("planSha256") or
            object_hash(plan["configuration"]) != plan.get("configSha256") or
            plan.get("status") != "resolved-unverified" or
            plan["configuration"].get("nativeVariant") != "standard-effects4" or
            plan.get("resolution", {}).get("lockSha256") != object_hash(lock) or
            lock.get("packageRequestSha256") != plan.get("packageRequestSha256")):
        raise ValueError("Configured build plan/lock identity mismatch or unavailable native variant")
    return plan


def identity(plan):
    return {"schemaVersion": 1, **{key: plan[key] for key in
            ("configSha256", "nativeVariantInputSha256", "packageRequestSha256", "planSha256",
             "stableAliasEligible")}, "name": plan["configuration"]["name"],
            "nativeVariant": plan["configuration"]["nativeVariant"],
            "capabilities": plan["configuration"]["capabilities"],
            "lockSha256": plan["resolution"]["lockSha256"]}


def label(configuration):
    return configuration["name"] + "-" + configuration["planSha256"][:12]


def checked_file(directory, item):
    name = item["path"]
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name) or
            any(part in (".", "..") for part in name.split("/"))):
        raise ValueError("Unsafe configured input path")
    target = directory
    for part in name.split("/"):
        target = target / part
        if target.is_symlink():
            raise ValueError("Linked configured input")
    if (not target.is_file() or digest(target) != item["sha256"] or
            "bytes" in item and target.stat().st_size != item["bytes"]):
        raise ValueError("Configured input changed: " + name)
    return target


def records(text):
    result = []
    for paragraph in text.split("\n\n"):
        fields = {}
        for line in paragraph.splitlines():
            if line and not line[0].isspace() and ": " in line:
                key, value = line.split(": ", 1)
                if key in fields:
                    raise ValueError("Duplicate Debian control field")
                fields[key] = value
        if fields:
            result.append(fields)
    return result


def installed(root=Path("/")):
    return {item["Package"]: (item["Version"], item["Architecture"])
            for item in records((root / "var/lib/dpkg/status").read_text())
            if item.get("Status") == "install ok installed"}


def expected_packages(lock):
    return {item["name"]: (item["version"], item["architecture"]) for item in lock["packages"]}


def authenticate(directory, lock):
    trust = json.loads((HERE / "archive-trust.json").read_bytes())
    if digest(Path(trust["keyring"])) != trust["sha256"]:
        raise ValueError("Debian archive keyring differs from the source-approved trust root")
    indexes = {}
    for source in lock["sources"]:
        release = checked_file(directory, source["inRelease"])
        index = checked_file(directory, source["index"])
        verified = subprocess.check_output(
            ["gpgv", "--keyring", trust["keyring"],
             "--output", "-", str(release)], text=True, timeout=60)
        header = records(verified.split("\nSHA256:", 1)[0])[0]
        if header.get("Origin") != trust["origin"] or header.get("Codename") not in trust["codenames"]:
            raise ValueError("Unexpected signed Debian distribution")
        now = datetime.now(timezone.utc)
        if (parsedate_to_datetime(header["Date"]) > now or
                "Valid-Until" in header and parsedate_to_datetime(header["Valid-Until"]) < now):
            raise ValueError("Signed Debian snapshot is expired or in the future; refresh resolution")
        section = re.search(r"^SHA256:\n((?:[ \t].*\n)+)", verified, re.M)
        matched = [] if section is None else [line.split() for line in section[1].splitlines()
                                             if len(line.split()) == 3 and line.split()[2] == source["releasePath"]]
        if len(matched) != 1 or matched[0][:2] != [digest(index), str(index.stat().st_size)]:
            raise ValueError("APT index is not bound to the authenticated Release SHA256")
        indexes[source["id"]] = records(index.read_text())
    for item in lock["archives"]:
        target = checked_file(directory, item)
        matches = [record for record in indexes[item["source"]]
                   if (record.get("Package"), record.get("Version"), record.get("Architecture")) ==
                   (item["name"], item["version"], item["architecture"])]
        if not matches or any(record.get("SHA256") != item["sha256"] or
                              record.get("Size") != str(item["bytes"]) for record in matches):
            raise ValueError("Archive is not the exact signed indexed package: " + item["name"])
        control = subprocess.check_output(["dpkg-deb", "-f", str(target),
                                          "Package", "Version", "Architecture"], text=True, timeout=30)
        if records(control) != [{"Package": item["name"], "Version": item["version"],
                                 "Architecture": item["architecture"]}]:
            raise ValueError("Archive control identity mismatch")
    return indexes


def apt_arguments(directory, archives, simulate):
    return (["apt-get", *(["--simulate"] if simulate else ["--yes"]), "--no-download",
             "--no-install-recommends", "--no-remove", "install"] +
            [str(checked_file(directory, item)) for item in archives])


def preflight(directory):
    plan, lock = load(directory)
    trust = json.loads((HERE / "archive-trust.json").read_bytes())
    if plan.get("archiveTrust") != trust:
        raise ValueError("Plan archive trust differs from the source-approved policy")
    authenticate(directory, lock)
    base = installed()
    projected = dict(base)
    archives = lock["archives"]
    for item in archives:
        if item["name"] in base and base[item["name"]] != (item["version"], item["architecture"]):
            raise ValueError("Configured builds cannot upgrade/replace frozen runtime packages")
        projected[item["name"]] = (item["version"], item["architecture"])
    if plan["configuration"]["hardware"] == "basic":
        kernel = runpy.run_path(str(HERE / "basic-kernel.py"))["verify_pack"](Path("/kernel-pack"))
        projected[kernel["package"]["name"]] = (kernel["package"]["version"], "amd64")
    if projected != expected_packages(lock):
        raise ValueError("Lock is not the exact base + signed archives + dedicated kernel inventory")
    # Solve the requested roots, not every cached archive as if it were a user request.
    # The temporary repositories use only the supplied, authenticated file:// snapshots.
    with tempfile.TemporaryDirectory(prefix="polly-apt-simulation-") as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        lines = []
        for source in lock["sources"]:
            release = subprocess.check_output(
                ["gpgv", "--keyring", trust["keyring"], "--output", "-",
                 str(checked_file(directory, source["inRelease"]))], text=True, timeout=60)
            suite = records(release.split("\nSHA256:", 1)[0])[0]["Codename"]
            repository = root / source["id"]
            dist = repository / "dists" / suite
            index = dist / source["releasePath"]
            index.parent.mkdir(parents=True)
            shutil.copyfile(checked_file(directory, source["inRelease"]), dist / "InRelease")
            shutil.copyfile(checked_file(directory, source["index"]), index)
            lines.append("deb [arch=amd64 signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] file:" +
                         str(repository) + " " + suite + " " + source["releasePath"].split("/")[0])
        sources = root / "sources.list"
        sources.write_text("\n".join(lines) + "\n")
        (root / "lists/partial").mkdir(parents=True)
        options = ["-o", "Dir::Etc::sourcelist=" + str(sources), "-o", "Dir::Etc::sourceparts=-",
                   "-o", "Dir::State::lists=" + str(root / "lists"),
                   "-o", "Acquire::Languages=none", "-o", "APT::Get::List-Cleanup=0"]
        subprocess.run(["apt-get", *options, "update", "-o", "APT::Update::Error-Mode=any"],
                       check=True, timeout=120)
        for stages in (("runtime", "platform"), ("runtime", "platform", "boot")):
            roots = {spec.split("=")[0] for stage in stages for spec in plan["stages"][stage]}
            requested = [name + "=" + projected[name][0] for name in sorted(roots)]
            expected = {item["name"]: item["version"] for item in archives
                        if item["stage"] in stages and base.get(item["name"]) !=
                        (item["version"], item["architecture"])}
            if plan["configuration"]["hardware"] == "basic":
                requested.append("/kernel-pack/kernel-image.deb")
                expected[kernel["package"]["name"]] = kernel["package"]["version"]
            simulation = subprocess.check_output(
                ["apt-get", *options, "--simulate", "--no-download", "--no-install-recommends",
                 "--no-remove", "install", *requested], text=True, stderr=subprocess.STDOUT, timeout=120,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
            if re.search(r"^Remv ", simulation, re.M):
                raise ValueError("APT solver proposed removing a package")
            changes = dict(re.findall(r"^Inst ([a-z0-9+.-]+)(?::amd64)?(?: \[[^\]]+\])? \(([^ ]+)",
                                      simulation, re.M))
            if changes != expected:
                raise ValueError("Actual offline APT stage solution differs from saved resolution")
    print("PASS: authenticated Debian archives, exact base inventory and offline APT simulation; not a boot test")


def install(directory, stage):
    plan, lock = load(directory)
    authenticate(directory, lock)
    archives = [item for item in lock["archives"] if item["stage"] == stage]
    if archives:
        subprocess.run(apt_arguments(directory, archives, False), check=True, timeout=1800)
    actual = installed()
    for spec in plan["stages"][stage]:
        name, _, version = spec.partition("=")
        expected = expected_packages(lock).get(name)
        if name not in actual or actual[name] != expected or version and actual[name][0] != version:
            raise ValueError("Installed stage differs from configured request: " + spec)


def verify(root, plan, lock, final=True):
    check_plan(plan, lock)
    actual = installed(root)
    if final and actual != expected_packages(lock):
        raise ValueError("Actual root package inventory differs from complete configured lock")
    for stage in ("runtime", "platform", "boot") if final else ("runtime", "platform"):
        for spec in plan["stages"][stage]:
            name, _, version = spec.partition("=")
            if name not in actual or version and actual[name][0] != version:
                raise ValueError("Configured root omits package/pin: " + spec)
    if any(name in actual for name in plan["configuration"]["policy"]["forbidden"]):
        raise ValueError("Configured root contains forbidden package")
    return identity(plan)


def verify_retained(root):
    plan = json.loads((root / PLAN).read_bytes())
    lock = json.loads((root / LOCK).read_bytes())
    return verify(root, plan, lock), plan, lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("preflight", "platform", "boot", "mark"))
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "preflight":
        preflight(args.directory)
    elif args.command in ("platform", "boot"):
        install(args.directory, args.command)
    else:
        plan, lock = load(args.directory)
        verify(Path("/"), plan, lock)
        for source, target in (("resolved-plan.json", PLAN), ("packages.lock.json", LOCK)):
            destination = Path("/") / target
            if destination.exists() or destination.is_symlink():
                raise ValueError("Refusing to overwrite configured identity")
            shutil.copyfile(args.directory / source, destination)
            destination.chmod(0o644)


if __name__ == "__main__":
    main()
