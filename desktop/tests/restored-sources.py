#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
location = Path(__file__).parents[1] / "tools/restore-build-sources.py"
spec = importlib.util.spec_from_file_location("restore", location)
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
if not Path("/run/.containerenv").exists() and not Path("/.dockerenv").exists():
    print("SKIP: dependency source restoration requires a disposable build container")
    raise SystemExit(77)


def archive(path, entries):
    with tarfile.open(path, "w:gz") as output:
        for name, contents in entries.items():
            data = contents.encode()
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            output.addfile(member, io.BytesIO(data))


def publish(root, records):
    manifest = {"schemaVersion": 1, "kind": "custom-dependency-sources", "components": records,
                "files": [{"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size,
                           "sha256": restore.source_retention.digest(path)}
                          for folder in ("sources", "recipes") for path in (root / folder).iterdir()]}
    (root / "source-pack.json").write_text(json.dumps(manifest))


def rejects(root, output):
    try:
        restore.restore(root, output)
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError):
        assert not output.exists()
        assert not list(output.parent.glob(".polly-restore-*"))
        return
    raise AssertionError("Invalid restore accepted")


with tempfile.TemporaryDirectory(prefix="polly-restore-test-") as temporary:
    base = Path(temporary)
    upstream, shallow, pack = base / "upstream", base / "shallow", base / "pack"
    upstream.mkdir()
    restore.run("git", "-C", str(upstream), "init", "--quiet")
    for contents in ("parent", "pinned"):
        (upstream / "source.c").write_text(contents)
        restore.run("git", "-C", str(upstream), "add", ".")
        restore.run("git", "-C", str(upstream), "-c", "user.name=Source test",
                    "-c", "user.email=source-test@example.invalid", "commit", "--quiet", "-m", contents)
    restore.run("git", "clone", "--quiet", "--depth=1", upstream.as_uri(), str(shallow))
    revision = restore.run("git", "-C", str(shallow), "rev-parse", "HEAD").decode().strip()
    (pack / "sources").mkdir(parents=True)
    (pack / "recipes").mkdir()
    records = []
    for name in ("skia", "sdl", "harfbuzz"):
        restore.run("git", "-C", str(shallow), "bundle", "create", str(pack / "sources" / (name + ".bundle")), "HEAD")
        shutil.copyfile(shallow / ".git/shallow", pack / "sources" / (name + "-shallow.txt"))
        records.append({"name": name, "revision": revision, "gitBundle": "sources/" + name + ".bundle",
                        "shallowBoundary": "sources/" + name + "-shallow.txt",
                        "patch": "recipes/sdl-wayland-sync-lifetime.patch" if name == "sdl" else None})
    pins = {"sharedBuildPins": dict.fromkeys(("skia", "sdl", "harfbuzz"), revision)}
    for name in ("wlroots", "wlr-protocols"):
        path = pack / "sources" / (name + ".tar.gz")
        archive(path, {name + "-1/source.c": "source"})
        pins[name] = {"version": "1", "sha512": restore.source_retention.digest(path, "sha512")}
        records.append({"name": name, "version": "1", "file": "sources/" + path.name})
    for recipe in restore.source_retention.RECIPE_PATHS:
        (pack / "recipes" / Path(recipe).name).write_text("retained recipe fixture")
    (pack / "recipes/sources.json").write_text(json.dumps(pins))
    (pack / "recipes/libinput.json").write_text(json.dumps({"version": "1.0-1"}))
    original, debian = pack / "sources/libinput_1.0.orig.tar.gz", pack / "sources/libinput_1.0-1.debian.tar.gz"
    archive(original, {"libinput-1.0/source.c": "libinput source"})
    archive(debian, {"debian/source/format": "3.0 (quilt)\n"})
    descriptor = pack / "sources/libinput_1.0-1.dsc"
    descriptor.write_text(
        "Format: 3.0 (quilt)\nSource: libinput\nBinary: libinput-test\nArchitecture: any\n"
        "Version: 1.0-1\nMaintainer: Source Test <source-test@example.invalid>\nChecksums-Sha256:\n"
        + "".join(f" {restore.source_retention.digest(path)} {path.stat().st_size} {path.name}\n" for path in (original, debian))
        + "Files:\n"
        + "".join(f" {hashlib.md5(path.read_bytes()).hexdigest()} {path.stat().st_size} {path.name}\n" for path in (original, debian)))
    records.append({"name": "libinput", "version": "1.0-1", "file": "sources/" + descriptor.name})
    publish(pack, records)
    output = base / "restored"
    restore.restore(pack, output)
    assert json.loads((output / "restore-manifest.json").read_text())["sourcePackSha256"] == restore.source_retention.digest(pack / "source-pack.json")
    for name in ("skia", "sdl", "harfbuzz"):
        directory = output / ("pollyui-" + name)
        assert (directory / "source.c").read_text() == "pinned"
        assert restore.run("git", "-C", str(directory), "rev-parse", "--is-shallow-repository").strip() == b"true"
        restore.run("git", "-C", str(directory), "fsck", "--no-reflogs")
    assert (output / "pollyui-input-source/libinput-1.0/source.c").read_text() == "libinput source"
    for recipe in restore.source_retention.RECIPE_PATHS:
        assert (output / recipe).read_bytes() == (pack / "recipes" / Path(recipe).name).read_bytes()
    mesa_original = pack / "sources/mesa_1.0.orig.tar.gz"
    mesa_debian = pack / "sources/mesa_1.0-1.debian.tar.gz"
    archive(mesa_original, {"mesa-1.0/source.c": "mesa source"})
    archive(mesa_debian, {"debian/source/format": "3.0 (quilt)\n"})
    mesa_descriptor = pack / "sources/mesa_1.0-1.dsc"
    mesa_descriptor.write_text(
        "Format: 3.0 (quilt)\nSource: mesa\nBinary: mesa-test\nArchitecture: any\n"
        "Version: 1.0-1\nMaintainer: Source Test <source-test@example.invalid>\nChecksums-Sha256:\n"
        + "".join(f" {restore.source_retention.digest(path)} {path.stat().st_size} {path.name}\n"
                  for path in (mesa_original, mesa_debian))
        + "Files:\n"
        + "".join(f" {hashlib.md5(path.read_bytes()).hexdigest()} {path.stat().st_size} {path.name}\n"
                  for path in (mesa_original, mesa_debian)))
    for recipe in restore.source_retention.MESA_RECIPE_PATHS:
        (pack / "recipes" / Path(recipe).name).write_text("mesa fixture recipe")
    (pack / "recipes/mesa.json").write_text(json.dumps({
        "sourceVersion": "1.0-1", "rebuiltVersion": "1.0-1+polly1",
        "sourceFiles": {path.name: restore.source_retention.digest(path)
                        for path in (mesa_descriptor, mesa_original, mesa_debian)},
    }))
    records.append({"name": "mesa", "version": "1.0-1", "rebuiltVersion": "1.0-1+polly1",
                    "file": "sources/" + mesa_descriptor.name, "patch": "recipes/mesa-lifetime.patch"})
    publish(pack, records)
    restore.restore(pack, base / "with-mesa")
    assert (base / "with-mesa/pollyui-mesa-source/source.c").read_text() == "mesa source"
    saved_mesa = mesa_original.read_bytes()
    mesa_original.write_bytes(b"changed mesa")
    publish(pack, records)
    rejects(pack, base / "bad-mesa")
    mesa_original.write_bytes(saved_mesa)
    publish(pack, records)
    try:
        restore.restore(pack, output)
    except ValueError:
        assert (output / "pollyui-skia/source.c").read_text() == "pinned"
    else:
        raise AssertionError("Existing source directory replaced")
    output = base / "rejected"
    records[0]["shallowBoundary"] = None
    publish(pack, records)
    rejects(pack, output)
    records[0]["shallowBoundary"] = "sources/skia-shallow.txt"
    bundle = pack / "sources/skia.bundle"
    saved = bundle.read_bytes()
    bundle.write_bytes(b"corrupt bundle")
    rejects(pack, output)
    publish(pack, records)
    rejects(pack, output)
    bundle.write_bytes(saved)
    pins["sharedBuildPins"]["skia"] = "0" * 40
    (pack / "recipes/sources.json").write_text(json.dumps(pins))
    publish(pack, records)
    rejects(pack, output)
    pins["sharedBuildPins"]["skia"] = revision
    path = pack / "sources/wlroots.tar.gz"
    archive(path, {"wlroots-1/../../escape": "must not escape"})
    pins["wlroots"]["sha512"] = restore.source_retention.digest(path, "sha512")
    (pack / "recipes/sources.json").write_text(json.dumps(pins))
    publish(pack, records)
    rejects(pack, output)
    assert not (base / "escape").exists()
print("PASS: offline shallow Git/source restoration, recipe layout, changed inputs, archive escape and atomic failure cleanup")
