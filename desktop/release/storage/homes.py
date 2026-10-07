"""Fresh stable-UID homes; never overwrite or silently migrate existing user paths."""
import importlib.util
import os
from pathlib import Path
import stat

spec = importlib.util.spec_from_file_location("polly_home_layout", Path(__file__).with_name("layout.py"))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

USER_DIRS = {"DESKTOP": "Desktop", "DOWNLOAD": "Downloads", "DOCUMENTS": "Documents"}


def initialize(home, user):
    if not isinstance(user, dict):
        raise ValueError("Invalid fresh user identity")
    identities = [identity for identity in layout.DEFAULT_USERS if identity["uid"] != user.get("uid")]
    layout.validate_users([*identities, user])
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != user["uid"] or info.st_gid != user["gid"] or \
            stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("Fresh home does not have its stable private identity")
    paths = [*(home / name for name in layout.USER_DIRECTORIES), home / ".local",
             *(home / name for name in layout.COMPATIBILITY_LINKS)]
    if any(path.exists() or path.is_symlink() for path in paths):
        raise ValueError("Existing XDG or compatibility data requires explicit migration")
    for name in (*layout.USER_DIRECTORIES, ".local"):
        directory = home / name
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)
        os.chown(directory, user["uid"], user["gid"])
    for name, target in layout.COMPATIBILITY_LINKS.items():
        link = home / name
        link.symlink_to(target)
        os.lchown(link, user["uid"], user["gid"])
    config = home / "Settings/user-dirs.dirs"
    with config.open("x", encoding="utf8", newline="\n") as destination:
        os.fchmod(destination.fileno(), 0o600)
        destination.write("".join(f'XDG_{name}_DIR="$HOME/{target}"\n'
                                  for name, target in USER_DIRS.items()))
    os.chown(config, user["uid"], user["gid"])
