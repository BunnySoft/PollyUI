#!/usr/bin/env python3
"""Private tmpfs/bind and synthetic owner handoff; no real iwd, radio or disk writes."""
import argparse
import errno
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from unittest.mock import patch
import importlib.machinery
import importlib.util


def load(name, path):
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(path)))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def run(*arguments, **kwargs):
    return subprocess.run(arguments, check=True, timeout=20, **kwargs)


def refused(operation, exceptions=(OSError, ValueError)):
    try:
        operation()
    except exceptions:
        return
    raise RuntimeError("Required network-state refusal was not enforced")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if os.getuid() != 0 or not Path("/run/.containerenv").exists():
        raise RuntimeError("Network mount fixture requires an isolated root container")
    if args.report and (args.report.exists() or args.report.is_symlink()):
        raise RuntimeError("Refusing to overwrite network evidence")
    storage = load("fixture_network_storage", args.repo / "desktop/release/storage/storage.py")
    accounts = load("fixture_network_accounts", args.repo / "desktop/release/install/accounts.py")
    network = load("fixture_network_state", args.repo / "desktop/release/network/state.py")
    volumes = {"EFI": "12AB-34CD", "SYSTEM": "10000000-0000-4000-8000-000000000001",
               "PERSISTENT": "10000000-0000-4000-8000-000000000002",
               "RECOVERY": "10000000-0000-4000-8000-000000000003"}
    observed = dict(volumes)
    contract = storage.layout.contract(volumes)
    invocation = "1" * 32
    fake = b"[Security]\nPassphrase=SyntheticOnly-NotARealCredential\n"
    run("mount", "--make-rprivate", "/")
    with tempfile.TemporaryDirectory(prefix="polly-t171-mount-") as temporary:
        stage = Path(temporary)
        stage.chmod(0o755)
        root = stage / "root"
        root.mkdir()
        run("mount", "-t", "tmpfs", "-o", "mode=755,size=32m", "tmpfs", str(root))
        try:
            manifest = root / "etc/polly-storage.json"
            manifest.parent.mkdir()
            manifest.write_text(json.dumps(contract))
            manifest.chmod(0o644)
            run_root = root / "run"
            run_root.mkdir(mode=0o755)
            run("mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid,size=32m",
                "tmpfs", str(run_root))
            state = storage.Storage(root)
            persistent = state.persistent
            persistent.mkdir(parents=True)
            run("mount", "-t", "tmpfs", "-o", "mode=755,nodev,nosuid,size=32m",
                "tmpfs", str(persistent))
            for directory in contract["directories"]:
                path = persistent / directory["path"]
                path.mkdir(parents=True, exist_ok=True)
                path.chmod(directory["mode"])
            for user in contract["users"]:
                path = persistent / f"Users/{user['uid']}"
                path.mkdir(mode=0o700)
                os.chown(path, user["uid"], user["gid"])
            for mapping in contract["mappings"]:
                source, target = state.source(mapping), state.path(mapping["target"])
                source.mkdir(parents=True, exist_ok=True)
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o1777 if mapping["target"] == "/var/tmp" else 0o755)
            efi = state.path("/System/Boot/efi")
            efi.mkdir()
            run("mount", "-t", "tmpfs", "-o", "mode=755", "tmpfs", str(efi))
            run("mount", "--bind", str(state.path("/System/Resources")), str(state.path("/usr")))

            def volume(instance, path, role, flags):
                record = storage.command("/usr/bin/findmnt", "-rn", "-M", str(path),
                                         "-o", "FSTYPE,OPTIONS").split()
                expected = {"SYSTEM": root, "PERSISTENT": persistent, "EFI": efi}[role]
                if len(record) != 2 or record[0] != "tmpfs" or \
                        path.stat().st_dev != expected.stat().st_dev:
                    raise ValueError("Fixture mount references the wrong private filesystem")
                storage.validate_volume(observed[role] + " tmpfs " + record[1],
                                        instance.volumes[role], "tmpfs", flags)

            with patch.object(storage.Storage, "volume", volume):
                state.prepare()
                state.check()
                run("mount", "-o", "remount,bind,ro", str(state.path("/usr")))
                refused(state.check)
                run("mount", "-o", "remount,bind,rw", str(state.path("/usr")))
                state.check()
                net = network.NetworkState(storage, accounts, root)
                net.runtime.mkdir(mode=0o700)
                net.iwd.mkdir(mode=0o700)
                run("mount", "-t", "tmpfs", "-o", "mode=700,nodev,nosuid,size=32m",
                    "tmpfs", str(net.iwd))
                for name, text in (
                        ("polly-account-profile", "installed\n"),
                        ("passwd", "root:x:0:0:root:/root:/bin/sh\n"
                         "polly:x:1000:1000:fixture:/home/polly:/bin/sh\n"),
                        ("group", "root:x:0:\npolly:x:1000:\nshadow:x:42:\n"),
                        ("shadow", "root:!:20000:0:99999:7:::\npolly:!:20000:0:99999:7:::\n")):
                    path = root / "etc" / name
                    path.write_text(text)
                    path.chmod(0o640 if name == "shadow" else 0o644)
                    if name == "shadow":
                        os.chown(path, 0, 42)
                network.initialize_empty(persistent / "SystemData/Network",
                                         volumes["PERSISTENT"], storage, accounts, root, image_root=root)
                run("mount", "--bind", str(persistent / "SystemData/Network"), str(net.runtime))
                refused(lambda: net.memory_runtime("installed"))
                run("umount", str(net.runtime))
                net.memory_runtime("installed")
                run("mount", "--bind", str(net.runtime), str(net.runtime))
                net.memory_runtime("installed")
                run("mount", "-o", "remount,bind,ro", str(net.runtime))
                refused(lambda: net.memory_runtime("installed"))
                run("umount", str(net.runtime))
                net.memory_runtime("installed")
                guard = Path("/usr/lib/polly-account-profile-check")
                shutil.copyfile(args.repo / "desktop/release/debian/profile-check", guard)
                guard.chmod(0o755)
                Path("/etc/polly-account-profile").write_text("installed\n")
                Path("/etc/polly-account-profile").chmod(0o644)
                fixture_guard = root / "usr/lib/polly-account-profile-check"
                fixture_guard.parent.mkdir(parents=True)
                shutil.copyfile(guard, fixture_guard)
                fixture_guard.chmod(0o755)
                (root / "etc/polly-account-profile").write_text("installed\n")
                (root / "etc/polly-account-profile").chmod(0o644)
                configuration = root / "etc/iwd/main.conf"
                configuration.parent.mkdir()
                shutil.copyfile(args.repo / "desktop/system/iwd-main.conf", configuration)
                configuration.chmod(0o644)
                owner = None

                def stopped():
                    if owner is not None and owner.poll() is None:
                        raise ValueError("Synthetic iwd owner is still running")

                with patch.object(net, "stopped", stopped):
                    first = net.run("load", invocation)
                    assert first["profileCount"] == 0
                    owner = subprocess.Popen([
                        "/usr/bin/python3", "-I", "-B", "-c",
                        "import os,sys,tempfile,time;from pathlib import Path;"
                        "p=Path(sys.argv[1]);"
                        "fd,n=tempfile.mkstemp(prefix='Fixture.psk.',suffix='.tmp',dir=p);"
                        "os.write(fd,bytes.fromhex(sys.argv[2]));os.close(fd);"
                        "os.rename(n,p/'Fixture.psk');"
                        "(p/'hotspot').mkdir(mode=0o700);"
                        "time.sleep(0.3)",
                        str(net.iwd), fake.hex()], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    try:
                        refused(lambda: net.run("save", invocation, "success"))
                        _, errors = owner.communicate(timeout=10)
                        if owner.returncode:
                            raise RuntimeError("Synthetic owner failed; no checkpoint claimed")
                        assert errors == b""
                    finally:
                        if owner.poll() is None:
                            owner.terminate()
                            owner.wait(timeout=10)
                    real_sync = net.sync

                    def forbid_runtime_sync(path):
                        if path == net.runtime:
                            raise OSError(errno.EIO, "synthetic post-release runtime sync failure")
                        return real_sync(path)

                    with patch.object(net, "sync", side_effect=forbid_runtime_sync):
                        saved = net.run("save", invocation, "success")
                    assert saved["profileCount"] == 1
                    assert not (net.runtime / "lease.json").exists()
                    pointer = (net.network / "state.json").read_bytes()
                    value = json.loads(pointer)
                    profile = net.network / value["generation"] / "Fixture.psk"
                    assert profile.read_bytes() == fake
                    assert stat.S_IMODE(profile.stat().st_mode) == 0o600
                    assert stat.S_IMODE(net.network.stat().st_mode) == 0o700
                    (net.iwd / "Fixture.psk").unlink()
                    assert net.run("load", "2" * 32)["profileCount"] == 1
                    assert (net.iwd / "Fixture.psk").read_bytes() == fake
                    run("/usr/bin/python3", "-I", "-B", "-c",
                        "import sys;from pathlib import Path;"
                        "\nfor name in sys.argv[1:]:\n"
                        " try: list(Path(name).iterdir())\n"
                        " except PermissionError: pass\n"
                        " else: raise RuntimeError('Private network state was readable')\n",
                        str(net.network), str(net.iwd), str(net.runtime),
                        user=1000, group=1000, extra_groups=[])
                    observed["PERSISTENT"] = volumes["SYSTEM"]
                    refused(lambda: net.run("save", "2" * 32, "success"))
                    observed["PERSISTENT"] = volumes["PERSISTENT"]
                    run("mount", "-o", "remount,ro,nodev,nosuid", str(persistent))
                    refused(lambda: net.run("save", "2" * 32, "success"))
                    run("mount", "-o", "remount,rw,nodev,nosuid", str(persistent))
                    info = os.statvfs(persistent)
                    size = (info.f_blocks - info.f_bfree) * info.f_frsize + 512 * 1024
                    run("mount", "-o", "remount,size=" + str(size), str(persistent))
                    try:
                        net.run("save", "2" * 32, "success")
                    except OSError as error:
                        assert error.errno == errno.ENOSPC
                    else:
                        raise RuntimeError("Actual private tmpfs capacity loss was accepted")
                    run("mount", "-o", "remount,size=32m", str(persistent))
                    assert (net.network / "state.json").read_bytes() == pointer
                    assert (net.runtime / "lease.json").exists()
                    assert net.run("save", "2" * 32, "success")["checkpoint"] == "committed"
                    net.run("load", "3" * 32)
                    before = (net.network / "state.json").read_bytes()
                    real_unlink = Path.unlink

                    def fail_release(path, *arguments, **keywords):
                        if path == net.runtime / "lease.json":
                            raise OSError(errno.EIO, "synthetic RAM lease unlink failure")
                        return real_unlink(path, *arguments, **keywords)

                    with patch.object(Path, "unlink", fail_release):
                        refused(lambda: net.run("save", "3" * 32, "success"))
                    assert (net.network / "state.json").read_bytes() != before
                    assert (net.runtime / "lease.json").exists()
                    refused(lambda: net.run("load", "4" * 32))
                    run("umount", str(persistent))
                    refused(lambda: net.run("load", "4" * 32),
                            (OSError, ValueError, RuntimeError))
                    assert not (persistent / "SystemData/Network/state.json").exists()
        finally:
            run("umount", "--recursive", str(root))

        # Only disposable container service directories are changed, never cached images.
        for source, destination in (
                ("desktop/release/network/state.py", "/usr/lib/polly-network/state.py"),
                ("desktop/release/storage/storage.py", "/usr/lib/polly-storage/storage.py"),
                ("desktop/release/storage/layout.py", "/usr/lib/polly-storage/layout.py"),
                ("desktop/release/install/accounts.py", "/usr/sbin/polly-accounts")):
            path = Path(destination)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text((args.repo / source).read_text(), encoding="utf8", newline="\n")
            path.chmod(0o644 if path.name == "layout.py" else 0o755)
        run("/usr/bin/python3", "-I", "-B", "-c",
            "import importlib.util;from pathlib import Path;"
            "s=importlib.util.spec_from_file_location('installed_network',"
            "'/usr/lib/polly-network/state.py');"
            "m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "m.deployment();m.no_new_privileges();"
            "assert 'NoNewPrivs:\\t1' in Path('/proc/self/status').read_text()")
        helper = Path("/usr/lib/polly-network/state.py")
        helper.chmod(0o777)
        result = subprocess.run([str(helper), "load"], capture_output=True, text=True,
                                timeout=10, env={"INVOCATION_ID": invocation})
        assert result.returncode == 1 and not result.stdout
        assert '"status":"refused"' in result.stderr
        helper.chmod(0o755)
        units = stage / "units"
        units.mkdir()
        (units / "iwd.service").write_text(
            Path("/usr/lib/systemd/system/iwd.service").read_text() + "\n" +
            (args.repo / "desktop/release/debian/network-runtime.conf").read_text() + "\n" +
            (args.repo / "desktop/release/network/iwd-state.conf").read_text())
        shutil.copyfile(args.repo / "desktop/release/storage/polly-storage.service",
                        units / "polly-storage.service")
        run("systemd-analyze", "verify", "--man=no",
            str(units / "iwd.service"), str(units / "polly-storage.service"))
        for mode in ("template", "recovery"):
            Path("/etc/polly-account-profile").write_text(mode + "\n")
            result = subprocess.run(["/usr/lib/polly-account-profile-check", "installed"],
                                    capture_output=True, timeout=10)
            assert result.returncode != 0
        Path("/etc/polly-account-profile").write_text("installed\n")
        result = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", "/usr/lib/polly-network/state.py", "load"],
            capture_output=True, text=True, timeout=10,
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "INVOCATION_ID": invocation})
        assert result.returncode == 1 and not result.stdout
        assert "POLLY_NETWORK_STATE_FAILED:" in result.stderr and "SyntheticOnly" not in result.stderr
        result = subprocess.run(
            ["/usr/bin/python3", "-I", "-B", "/usr/lib/polly-network/state.py", "load"],
            capture_output=True, text=True, timeout=10, user=1000, group=1000, extra_groups=[],
            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "INVOCATION_ID": invocation})
        assert result.returncode == 1 and not result.stdout
        assert '"error":"permission"' in result.stderr
    report = {"schemaVersion": 1, "result": "pass", "syntheticProfiles": 1,
              "privateMountsVerified": True, "requiredCheckerExecuted": True,
              "uid1000Refused": True, "wrongUuidRefused": True, "readOnlyRefused": True,
              "actualTmpfsReserveRefused": True, "missingVolumeRefused": True,
              "unitCompositionVerified": True, "cliFailureRedacted": True,
              "sandboxReadOnlyViewRefused": True,
              "fixedDeploymentVerified": True, "helperNoNewPrivilegesVerified": True,
              "ramRuntimeVerified": True, "foreignRuntimeBindRefused": True,
              "sameRamRuntimeBindAccepted": True, "readOnlyRuntimeBindRefused": True,
              "terminalGuardReleaseVerified": True, "unlinkFailureBlocksReload": True,
              "systemdExecutionVerified": False, "physicalNetworkVerified": False,
              "coldBootVerified": False, "filesystemIdentities": "synthetic-tmpfs-not-ext4"}
    if args.report:
        with args.report.open("x", encoding="utf8") as target:
            json.dump(report, target, indent=2)
            target.write("\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
