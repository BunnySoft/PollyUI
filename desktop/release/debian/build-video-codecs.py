#!/usr/bin/env python3
"""Build the pinned local-video-only LGPL decoder in a separate prefix."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("build", type=Path)
    parser.add_argument("prefix", type=Path)
    args = parser.parse_args()
    recipe = Path(__file__).with_name("video-codecs.json")
    record = json.loads(recipe.read_text())
    if record["schemaVersion"] != 1 or record["gpl"] or record["nonfree"] or record["network"] or record["audio"]:
        raise ValueError("The video decoder must retain its explicit local-only LGPL policy")
    archive = args.inputs / record["archive"]
    signature = archive.with_name(archive.name + ".asc")
    key = args.inputs / "ffmpeg-devel.asc"
    for path, digest in [(archive, record["sha512"]), (signature, record["signatureSha512"]), (key, record["keySha512"])]:
        if hashlib.sha512(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Video decoder input checksum mismatch: " + path.name)
    args.build.mkdir(parents=True, exist_ok=False)
    home = args.build / "gnupg"
    home.mkdir(mode=0o700)
    keyring = home / "release.gpg"
    subprocess.run(["gpg", "--homedir", str(home), "--batch", "--dearmor", "--output", str(keyring),
        str(key.resolve())], check=True)
    verified = subprocess.run(["gpgv", "--homedir", str(home), "--keyring", str(keyring), "--status-fd=1",
        str(signature.resolve()), str(archive.resolve())], check=True, text=True, stdout=subprocess.PIPE)
    if "[GNUPG:] VALIDSIG " + record["signerFingerprint"] + " " not in verified.stdout:
        raise ValueError("FFmpeg signature does not match the pinned official release signer")
    with tarfile.open(archive) as source:
        source.extractall(args.build, filter="data")
    source = args.build / ("ffmpeg-" + record["version"])
    build = args.build / "objects"
    build.mkdir()
    options = ["--prefix=" + str(args.prefix.resolve()), "--libdir=" + str(args.prefix.resolve() / "lib"),
        "--disable-autodetect", "--disable-everything", "--disable-static", "--enable-shared",
        "--disable-debug", "--disable-doc", "--disable-programs", "--disable-network",
        "--disable-gpl", "--disable-nonfree", "--disable-avdevice", "--disable-avfilter",
        "--disable-swresample", "--enable-avformat", "--enable-avcodec", "--enable-avutil",
        "--enable-swscale", "--enable-decoder=" + ",".join(record["decoders"]),
        "--enable-demuxer=" + ",".join(record["demuxers"]),
        "--enable-parser=" + ",".join(record["parsers"])]
    subprocess.run([str(source.resolve() / "configure"), *options], cwd=build, check=True)
    subprocess.run(["make", "-j", str(min(4, os.cpu_count() or 1))], cwd=build, check=True)
    subprocess.run(["make", "install"], cwd=build, check=True)
    licenses = args.prefix / "share/licenses/pollyui-video-codecs"
    licenses.mkdir(parents=True)
    for name in ("COPYING.LGPLv2.1", "LICENSE.md", "README.md"):
        shutil.copyfile(source / name, licenses / name)
    for file in (archive, signature, key, recipe):
        shutil.copyfile(file, licenses / file.name)
    (licenses / "configure-arguments.json").write_text(json.dumps(options, indent=2) + "\n")
    (args.prefix / "share/polly-video-codecs.json").write_text(json.dumps(record, indent=2) + "\n")
    print("PASS: pinned signature-verified local-only LGPL video decoder built")


if __name__ == "__main__":
    main()
