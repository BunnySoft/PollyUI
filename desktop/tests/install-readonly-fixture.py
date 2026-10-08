#!/usr/bin/env python3
"""PRIVATE CONTAINER ONLY: root stages fixtures; all acquisitions run as UID1000.

No production helper switch/environment escape; the fixture executable is
compiled against a distinct fixed test helper. Never calls host lsblk/findmnt.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
DEPLOY = Path("/usr/lib/pollyui/install-targets")
SOURCE = Path("/run/polly-install-source")
CONFIG = Path("/usr/share/pollyui/install-targets/source.json")
PRIVATE = Path("/run/polly-install-fixture")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


model = load("readonly_model_fixture", REPO / "desktop/tests/install-targets.py")
signature = load("readonly_payload_fixture", REPO / "desktop/tests/system-payload-signature.py")


class PrivateEvidence:
    """Actual collector with real private sysfs/proc text and fixed subprocess."""

    def command(self, args, deadline):
        return model.targets._command(("/usr/bin/python3", "-I", "-B",
                                      str(DEPLOY / "fixtures/command.py"), *args), deadline)

    def kernel(self, dev, deadline):
        return model.targets._collect_kernel(dev, deadline, PRIVATE / "sys")

    def resolve(self, path):
        if str(path) in ("/", "/boot"):
            return Path(path)
        return Path(path).resolve(strict=True)

    def exists(self, path):
        if path != "/System/Boot":
            raise ValueError("Unexpected fixture existence request")
        return False

    def read(self, path, limit):
        mapping = {"/proc/self/mountinfo": PRIVATE / "mountinfo", "/proc/swaps": PRIVATE / "swaps"}
        return model.targets._read(mapping[path], limit)


def prepare():
    if os.getuid() != 0 or not Path("/run/polly-readonly-private-fixture").is_file():
        raise RuntimeError("Fixture staging requires its explicit private-container marker")
    for directory in (DEPLOY / "install", DEPLOY / "storage", DEPLOY / "maintenance",
                      DEPLOY / "fixtures", SOURCE, CONFIG.parent, PRIVATE / "sys/dev/block"):
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(0o755)
    for relative in ("install/readonly-helper.py", "install/targets.py", "storage/layout.py",
                     "maintenance/payload.py"):
        shutil.copyfile(REPO / "desktop/release" / relative, DEPLOY / relative)
        (DEPLOY / relative).chmod(0o644)
    contract = signature.synthetic_contract()
    raw = signature.payload.encode(contract).encode()
    (SOURCE / "payload.json").write_bytes(raw)
    (SOURCE / "input.bin").write_bytes(b"SYNTHETIC-INPUT17")
    config = {"schemaVersion": 1, "kind": "polly-install-source", "sourceKind": "downloaded",
              "qualification": "deployment-owned-offline-inputs-v1",
              "description": "NATIVE-COLLECTOR-FIXTURE development-unsigned synthetic offline input",
              "inputs": [{"name": "input.bin", "bytes": 17}],
              "payloadContractSha256": hashlib.sha256(raw).hexdigest(),
              "measurements": {"payloadBytes": {"EFI": 4096, "SYSTEM": 4096,
                                              "PERSISTENT": 8192, "RECOVERY": 4096},
                               "headroomMiB": {"EFI": 64, "SYSTEM": 512,
                                               "PERSISTENT": 1024, "RECOVERY": 64}}}
    CONFIG.write_text(json.dumps(config))
    snapshot = model.fixture()
    (PRIVATE / "lsblk.json").write_text(json.dumps(snapshot["lsblk"]))
    (PRIVATE / "mountinfo").write_text("1 0 259:1 / / rw - ext4 /dev/nvme0n1p1 rw\n")
    (PRIVATE / "swaps").write_text("Filename Type Size Used Priority\n")
    for dev, entry in snapshot["sysfs"].items():
        base = PRIVATE / entry["sysfsPath"].removeprefix("/")
        base.mkdir(parents=True, exist_ok=True)
        for key, name in (("dev", "dev"), ("sizeSectors512", "size"), ("readOnly", "ro"),
                          ("removable", "removable"), ("diskseq", "diskseq")):
            value = int(entry[key]) if type(entry[key]) is bool else entry[key]
            (base / name).write_text(str(value))
        (base / "queue").mkdir(exist_ok=True)
        (base / "queue/logical_block_size").write_text(str(entry["logicalSectorBytes"]))
        for name in ("holders", "slaves"):
            (base / name).mkdir(exist_ok=True)
        if entry["partition"] is not None:
            (base / "partition").write_text(str(entry["partition"]))
            (base / "start").write_text(str(entry["startSector512"]))
        link = PRIVATE / "sys/dev/block" / dev
        if not link.exists():
            link.symlink_to(base)
    (DEPLOY / "fixtures/command.py").write_text(
        "import pathlib,sys\n"
        "base=pathlib.Path('/run/polly-install-fixture')\n"
        "if sys.argv[1]=='/usr/bin/lsblk': print((base/'lsblk.json').read_text())\n"
        "elif sys.argv[1]=='/usr/bin/findmnt':\n"
        " mode=(base/'mode').read_text()\n"
        " print('0:42' if mode=='overlay' and sys.argv[5]=='/' else\n"
        "       '0:43' if mode=='ram-source' and sys.argv[5].startswith('/run/polly-install-source/') else '259:1')\n"
        "else: raise RuntimeError('Fixture cannot execute a real collector command')\n")
    helper = (
        "import importlib.util,pathlib,sys,time,os\n"
        "for fd in range(3,256):\n"
        " try: os.fstat(fd)\n"
        " except OSError: continue\n"
        " raise RuntimeError('Native endpoint leaked an inherited descriptor')\n"
        "def load(name,path):\n"
        " spec=importlib.util.spec_from_file_location(name,path)\n"
        " value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value\n"
        "mode=pathlib.Path('/run/polly-install-fixture/mode').read_text()\n"
        "if mode=='oversized': print('x'*(2*1024*1024+1)); sys.exit(0)\n"
        "if mode=='malformed': print('{partial'); sys.exit(0)\n"
        "if mode=='partial': print('{}'); sys.exit(0)\n"
        "if mode=='disconnect': print('synthetic disconnect',file=sys.stderr); sys.exit(2)\n"
        "if mode in ('timeout','cancel','shutdown'): time.sleep(30); sys.exit(2)\n"
        "if mode=='final-fd':\n"
        " if os.fork()==0: time.sleep(30); os._exit(0)\n"
        " print('{}',flush=True); os._exit(0)\n"
        f"helper=load('real_readonly_helper','{DEPLOY}/install/readonly-helper.py')\n"
        f"fixture=load('private_readonly_fixture','{REPO}/desktop/tests/install-readonly-fixture.py')\n"
        "try: print(helper.acquire(evidence=fixture.PrivateEvidence()))\n"
        "except (OSError,ValueError) as error:\n"
        " print(str(error),file=sys.stderr); sys.exit(2)\n")
    (DEPLOY / "install/fixture-helper.py").write_text(helper)
    for path in (SOURCE / "payload.json", SOURCE / "input.bin", CONFIG,
                 DEPLOY / "fixtures/command.py", DEPLOY / "install/fixture-helper.py"):
        path.chmod(0o644)
    (PRIVATE / "mode").write_text("success")


def ordinary():
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)


class ReadonlyNative(unittest.TestCase):
    def setUp(self):
        prepare()

    def run_native(self, scenario):
        (PRIVATE / "mode").write_text(scenario)
        result = subprocess.run(
            ["/tmp/install-readonly-native", str(REPO),
             str(REPO / "desktop/tests/install-readonly-native.mjs"), scenario],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=35, preexec_fn=ordinary)
        print(result.stdout.decode(), end="")
        print(result.stderr.decode(), end="", file=sys.stderr)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"NATIVE READONLY PASS", result.stdout)

    def test_actual_collector_envelope_provider_reidentify(self):
        self.run_native("success")

    def test_actual_private_overlay_is_unknown(self):
        for scenario in ("overlay", "ram-source"):
            self.run_native(scenario)

    def test_partial_malformed_oversized_disconnect(self):
        for scenario in ("partial", "malformed", "oversized", "disconnect"):
            with self.subTest(scenario=scenario):
                self.run_native(scenario)

    def test_native_cancel_and_deadlines_including_exited_leader_open_fd(self):
        for scenario in ("cancel", "timeout", "final-fd", "shutdown"):
            with self.subTest(scenario=scenario):
                started = time.monotonic()
                self.run_native(scenario)
                self.assertLess(time.monotonic() - started, 12)

    def test_missing_unqualified_writable_symlink_source_refused(self):
        original = CONFIG.read_bytes()
        CONFIG.unlink()
        self.run_native("missing-config")
        CONFIG.write_bytes(original)
        config = json.loads(original)
        config["qualification"] = "ui-supplied"
        CONFIG.write_text(json.dumps(config))
        self.run_native("unqualified")
        CONFIG.write_bytes(original)
        CONFIG.chmod(0o666)
        self.run_native("writable")
        CONFIG.chmod(0o644)
        source = SOURCE / "input.bin"
        source.chmod(0o600)
        self.run_native("source-unreadable")
        source.chmod(0o644)
        source.rename(SOURCE / "input.original")
        source.symlink_to(SOURCE / "input.original")
        try:
            self.run_native("symlink")
        finally:
            source.unlink()
            (SOURCE / "input.original").rename(source)

    def test_missing_layout_payload_or_api_is_not_fallback(self):
        for path in (DEPLOY / "storage/layout.py", DEPLOY / "maintenance/payload.py",
                     SOURCE / "payload.json", DEPLOY / "install/fixture-helper.py"):
            with self.subTest(path=path):
                saved = path.read_bytes()
                path.unlink()
                try: self.run_native("missing-deployment")
                finally: path.write_bytes(saved)

    def test_source_payload_measurement_mismatch(self):
        config = json.loads(CONFIG.read_text())
        config["measurements"]["payloadBytes"]["SYSTEM"] += 1
        CONFIG.write_text(json.dumps(config))
        self.run_native("measurement-mismatch")

    def test_unsupported_source_kind_missing_measurements_and_invalid_input_names(self):
        original = CONFIG.read_text()
        for mutation in (
                lambda value: value.update(sourceKind="memory"),
                lambda value: value.pop("measurements"),
                lambda value: value["inputs"][0].update(name="../escape"),
                lambda value: value["inputs"].append(dict(value["inputs"][0])),
                lambda value: value["inputs"][0].update(bytes=18),
                lambda value: value.update(kernelBasis=["259:1"])):
            config = json.loads(original)
            mutation(config)
            CONFIG.write_text(json.dumps(config))
            self.run_native("invalid-source-config")

    def test_unqualified_source_refuses_before_any_collector_evidence(self):
        helper = load("readonly_before_evidence", DEPLOY / "install/readonly-helper.py")
        config = json.loads(CONFIG.read_text())
        config["qualification"] = "unqualified"
        CONFIG.write_text(json.dumps(config))
        evidence = PrivateEvidence()
        with patch.object(helper.os, "getuid", return_value=1000), \
                patch.object(helper.os, "geteuid", return_value=1000), \
                patch.object(evidence, "command", side_effect=AssertionError("Enumeration must not begin")) as command:
            with self.assertRaisesRegex(ValueError, "not qualified"):
                helper.acquire(evidence=evidence)
            command.assert_not_called()

    def test_helper_rejects_root_arguments_and_nonisolated(self):
        for args in (["/usr/bin/python3", "-I", "-S", str(DEPLOY / "install/readonly-helper.py")],
                     ["/usr/bin/python3", "-I", "-S", str(DEPLOY / "install/readonly-helper.py"), "--fixture"],
                     ["/usr/bin/python3", "-I", str(DEPLOY / "install/readonly-helper.py")],
                     ["/usr/bin/python3", str(DEPLOY / "install/readonly-helper.py")]):
            result = subprocess.run(args, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")

    def test_source_replaced_during_acquisition_and_unsafe_integer(self):
        helper = load("readonly_source_change", DEPLOY / "install/readonly-helper.py")
        actual = helper.configuration
        count = 0

        def replaced(*args):
            nonlocal count
            result = actual(*args)
            count += 1
            if count == 2:
                changed = dict(result[2]); changed["input.bin"] = ("replaced",)
                return result[0], result[1], changed, result[3], result[4]
            return result

        with patch.object(helper.os, "getuid", return_value=1000), \
                patch.object(helper.os, "geteuid", return_value=1000), \
                patch.object(helper, "configuration", side_effect=replaced):
            with self.assertRaisesRegex(ValueError, "changed during"):
                helper.acquire(evidence=PrivateEvidence())
        with self.assertRaisesRegex(ValueError, "exact-integer"):
            helper.bounded({"capacity": 1 << 53})

    def test_same_length_source_replacement_changes_binding_provenance(self):
        helper = load("readonly_source_identity", DEPLOY / "install/readonly-helper.py")
        with patch.object(helper.os, "getuid", return_value=1000), \
                patch.object(helper.os, "geteuid", return_value=1000):
            first = json.loads(helper.acquire(evidence=PrivateEvidence()))
            source = SOURCE / "input.bin"
            replacement = SOURCE / "replacement.bin"
            replacement.write_bytes(b"REPLACED-INPUT017")
            replacement.replace(source)
            second = json.loads(helper.acquire(evidence=PrivateEvidence()))
        self.assertEqual(first["source"]["downloadedBytes"], second["source"]["downloadedBytes"])
        self.assertNotEqual(first["source"]["description"], second["source"]["description"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--prepare":
        prepare()
    else:
        unittest.main()
