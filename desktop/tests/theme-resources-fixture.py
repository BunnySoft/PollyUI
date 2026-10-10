"""Run theme file policy over actual native SDK descriptors, without a desktop."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

runner, library = sys.argv[1:]
repo = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="polly-theme-sdk-") as temporary:
    home = Path(temporary)
    data, config, cases = home / "data", home / "config", home / "cases"
    themes = data / "pollyui" / "themes"
    themes.mkdir(parents=True, mode=0o700)
    (config / "pollyui").mkdir(parents=True, mode=0o700)
    cases.mkdir(mode=0o700)

    def definition(directory, content=b'{"theme":"fixture"}', mode=0o600):
        directory.mkdir(mode=0o700)
        file = directory / "theme.json"
        file.write_bytes(content)
        file.chmod(mode)

    definition(cases / "valid")
    (cases / "valid" / "bitmap.png").write_bytes(b"\x00\xff\x80bitmap")
    (cases / "valid" / "nested").mkdir(mode=0o700)
    (cases / "valid" / "nested" / "bitmap.jpg").write_bytes(b"\x00\xff\x80bitmap")
    (cases / "valid" / "asset-link.png").symlink_to("bitmap.png")
    (cases / "valid" / "directory-link").symlink_to("nested")
    (cases / "valid" / "huge.png").touch()
    os.truncate(cases / "valid" / "huge.png", 4 * 1024 * 1024 + 1)
    (cases / "valid" / "limit.png").touch()
    os.truncate(cases / "valid" / "limit.png", 4 * 1024 * 1024)
    definition(cases / "limit", b"x" * (128 * 1024))
    definition(cases / "oversized", b"x" * (128 * 1024 + 1))
    definition(cases / "empty", b"")
    definition(cases / "nul", b"x\0y")
    definition(cases / "invalid-utf8", b"\xc0\x80")
    definition(cases / "writable", mode=0o620)
    definition(cases / "writable-directory")
    (cases / "writable-directory").chmod(0o722)
    (cases / "symlink-file").mkdir(mode=0o700)
    (cases / "symlink-file" / "theme.json").symlink_to("../valid/theme.json")
    (cases / "fifo").mkdir(mode=0o700)
    os.mkfifo(cases / "fifo" / "theme.json", 0o600)
    (cases / "missing").mkdir(mode=0o700)
    (cases / "directory-link").symlink_to("valid", target_is_directory=True)
    definition(cases / "invalid-name")
    (cases / "total").mkdir(mode=0o700)
    for index in range(5):
        definition(cases / "total" / f"theme-{index}", b"x" * (128 * 1024))
    (cases / "count").mkdir(mode=0o700)
    for index in range(65):
        definition(cases / "count" / f"theme-{index}")
    overrides = config / "pollyui" / "theme-overrides.json"
    overrides.write_text('{"overrides":"fixture"}')
    (home / ".local" / "share" / "pollyui" / "themes").mkdir(parents=True, mode=0o700)
    (home / ".config" / "pollyui").mkdir(parents=True, mode=0o700)
    environment = {**os.environ, "HOME": str(home), "XDG_DATA_HOME": str(data), "XDG_CONFIG_HOME": str(config)}
    subprocess.run([runner, str(repo / "desktop" / "tests" / "theme-resources.mjs"), library],
                   cwd=repo, env=environment, check=True, timeout=160)
    for name, extra in (
        ("relative-xdg", {"XDG_DATA_HOME": "relative"}),
        ("relative-home", {"XDG_DATA_HOME": "", "HOME": "relative"}),
        ("relative-component", {"XDG_DATA_HOME": str(data) + "/../data"}),
        ("overlong-xdg", {"XDG_DATA_HOME": "/" + "x" * 4096}),
        ("missing", {"XDG_DATA_HOME": str(home / "missing-data"), "XDG_CONFIG_HOME": str(home / "missing-config")}),
        ("fallback", {"XDG_DATA_HOME": "", "XDG_CONFIG_HOME": ""}),
    ):
        subprocess.run([runner, str(repo / "desktop" / "tests" / "theme-resources-paths.mjs"), library],
                       cwd=repo, env={**environment, **extra, "POLLY_THEME_CASE": name}, check=True, timeout=30)
    (home / "data-link").symlink_to(data, target_is_directory=True)
    subprocess.run([runner, str(repo / "desktop" / "tests" / "theme-resources-paths.mjs"), library],
                   cwd=repo, env={**environment, "XDG_DATA_HOME": str(home / "data-link"), "POLLY_THEME_CASE": "symlink"},
                   check=True, timeout=30)
    print("PASS: native theme policy, exact limits, ownership, symlinks, assets and descriptor cleanup")
