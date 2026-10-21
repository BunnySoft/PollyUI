#!/usr/bin/env python3
"""Pure mocked adapter tests, not APT, signature, package or boot qualification.

Run: python3 -I -B desktop/tests/live-config.py
All subprocess entry points fail closed unless explicitly handled by an in-memory mock.
"""
from contextlib import ExitStack, redirect_stdout
import copy
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "release/debian/live-config.py"
SPEC = importlib.util.spec_from_file_location("polly_live_config_adapter", SOURCE)
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ConfiguredAdapterTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="polly-config-unit-")))
        self.source = self.directory / "source"
        self.source.mkdir()
        self.inputs = self.directory / "inputs"
        self.inputs.mkdir()
        self.root = self.directory / "root"
        (self.root / "var/lib/dpkg").mkdir(parents=True)
        self.base = {"base-lib": ("1.0", "amd64")}
        self.actual = {**self.base, "extra": ("2.0", "amd64"), "splash": ("3.0", "all")}
        self.trust = {"schemaVersion": 1, "keyring": str(self.source / "fixture-keyring.gpg"),
                      "sha256": sha(b"untrusted unit fixture keyring"),
                      "origin": "Debian", "codenames": ["trixie"]}
        (self.source / "fixture-keyring.gpg").write_bytes(b"untrusted unit fixture keyring")
        (self.source / "archive-trust.json").write_text(json.dumps(self.trust))
        self.stack.enter_context(mock.patch.object(ADAPTER, "HERE", self.source))
        self.lock = {
            "schemaVersion": 1, "kind": "polly-apt-resolution",
            "packageRequestSha256": "a" * 64, "runtimeManifestSha256": "b" * 64,
            "runtimeImageID": "c" * 64,
            "solver": {"name": "apt-get", "version": "mock", "note": "Synthetic fixture, not a solver receipt"},
            "packages": [{"name": name, "version": version, "architecture": architecture,
                          "reason": "Synthetic explicit request"} for name, (version, architecture) in self.actual.items()],
            "archives": [], "sources": [],
        }
        for name, version, architecture, stage in (("extra", "2.0", "amd64", "platform"),
                                                   ("splash", "3.0", "all", "boot")):
            payload = ("not a Debian archive: " + name).encode()
            relative = "packages/" + sha(payload) + ".deb"
            self.write(relative, payload)
            self.lock["archives"].append({"name": name, "version": version, "architecture": architecture,
                                         "stage": stage, "source": "trixie", "path": relative,
                                         "sha256": sha(payload), "bytes": len(payload)})
        self.index_text = "\n\n".join(
            "\n".join(("Package: " + item["name"], "Version: " + item["version"],
                       "Architecture: " + item["architecture"], "SHA256: " + item["sha256"],
                       "Size: " + str(item["bytes"]))) for item in self.lock["archives"]) + "\n"
        self.write("snapshot/Packages", self.index_text.encode())
        self.write("snapshot/InRelease", b"not a signature; mocked gpgv output follows")
        self.lock["sources"] = [{"id": "trixie",
                                 "inRelease": {"path": "snapshot/InRelease",
                                               "sha256": sha((self.inputs / "snapshot/InRelease").read_bytes())},
                                 "index": {"path": "snapshot/Packages", "sha256": sha(self.index_text.encode())},
                                 "releasePath": "main/binary-amd64/Packages"}]
        self.plan = {
            "schemaVersion": 1, "kind": "polly-live-build-plan",
            "configuration": {"name": "fixture-vm", "hardware": "vm", "nativeVariant": "standard-effects4",
                              "capabilities": {"audio": "standard"}, "policy": {"forbidden": []}},
            "packageRequestSha256": self.lock["packageRequestSha256"], "nativeVariantInputSha256": "d" * 64,
            "status": "resolved-unverified", "stableAliasEligible": False, "archiveTrust": self.trust,
            "stages": {"runtime": ["base-lib=1.0"], "platform": ["extra=2.0"], "boot": ["splash=3.0"]},
            "resolution": {},
        }
        self.now = datetime.now(timezone.utc)
        self.release = ("Origin: Debian\nCodename: trixie\nDate: " + format_datetime(self.now - timedelta(days=1)) +
                        "\nValid-Until: " + format_datetime(self.now + timedelta(days=1)) +
                        "\nSHA256:\n " + sha(self.index_text.encode()) + " " + str(len(self.index_text.encode())) +
                        " main/binary-amd64/Packages\n")
        self.simulations = []
        self.runs = []
        self.check_output = self.stack.enter_context(
            mock.patch.object(ADAPTER.subprocess, "check_output", side_effect=self.fake_check_output))
        self.run = self.stack.enter_context(mock.patch.object(ADAPTER.subprocess, "run", side_effect=self.fake_run))
        for name in ("Popen", "call", "check_call"):
            self.stack.enter_context(mock.patch.object(
                ADAPTER.subprocess, name, side_effect=AssertionError("Real external command forbidden: " + name)))
        self.seal()
        self.write_status(self.actual)

    def write(self, relative, data):
        target = self.inputs / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def seal(self):
        self.plan["configSha256"] = ADAPTER.object_hash(self.plan["configuration"])
        self.plan["resolution"]["lockSha256"] = ADAPTER.object_hash(self.lock)
        self.plan["planSha256"] = ADAPTER.object_hash(
            {key: value for key, value in self.plan.items() if key != "planSha256"})
        self.write("resolved-plan.json", json.dumps(self.plan).encode())
        self.write("packages.lock.json", json.dumps(self.lock).encode())

    def write_status(self, values):
        text = "\n\n".join("Package: " + name + "\nVersion: " + version +
                           "\nArchitecture: " + architecture + "\nStatus: install ok installed"
                           for name, (version, architecture) in values.items()) + "\n"
        (self.root / "var/lib/dpkg/status").write_text(text)

    def fake_check_output(self, command, **options):
        if command[0] == "gpgv":
            self.assertEqual(command, ["gpgv", "--keyring", self.trust["keyring"], "--output", "-",
                                       str(self.inputs / "snapshot/InRelease")])
            return self.release
        if command[0] == "dpkg-deb":
            self.assertEqual(command[1], "-f")
            self.assertEqual(command[3:], ["Package", "Version", "Architecture"])
            matches = [item for item in self.lock["archives"] if str(self.inputs / item["path"]) == command[2]]
            self.assertEqual(len(matches), 1)
            item = matches[0]
            return "Package: " + item["name"] + "\nVersion: " + item["version"] + "\nArchitecture: " + item["architecture"] + "\n"
        if command[0] == "apt-get" and "--simulate" in command:
            self.assertIn("--no-download", command)
            self.assertIn("--no-install-recommends", command)
            self.assertIn("--no-remove", command)
            self.assertEqual(options["env"]["LC_ALL"], "C")
            self.assertNotIn("http:", " ".join(command))
            requested = command[command.index("install") + 1:]
            self.simulations.append(requested)
            result = "Inst extra (2.0 fixture [amd64])\n"
            if "splash=3.0" in requested:
                result += "Inst splash (3.0 fixture [all])\n"
            return result
        raise AssertionError("Unexpected external command; nothing was executed: " + repr(command))

    def fake_run(self, command, **options):
        self.assertEqual(command[0], "apt-get")
        self.assertTrue(options["check"])
        if "update" in command:
            sources_option = next(item for item in command if item.startswith("Dir::Etc::sourcelist="))
            sources = Path(sources_option.split("=", 1)[1]).read_text()
            self.assertIn(" file:", sources)
            self.assertNotIn("http:", sources)
            self.assertNotIn("https:", sources)
            self.assertIn("signed-by=/usr/share/keyrings/debian-archive-keyring.gpg", sources)
        elif "install" in command:
            for flag in ("--yes", "--no-download", "--no-install-recommends", "--no-remove"):
                self.assertIn(flag, command)
            self.assertNotIn("--simulate", command)
            files = command[command.index("install") + 1:]
            self.assertTrue(files)
            self.assertTrue(all(item.startswith(str(self.inputs / "packages")) for item in files))
            cache_option = next(item for item in command if item.startswith("Dir::Cache::archives="))
            cache = Path(cache_option.split("=", 1)[1])
            for item in self.lock["archives"]:
                if str(self.inputs / item["path"]) not in files:
                    continue
                filename = item["name"] + "_" + item["version"].replace(":", "%3a") + "_" + item["architecture"] + ".deb"
                self.assertEqual((cache / filename).read_bytes(), (self.inputs / item["path"]).read_bytes())
            self.assertFalse(any("Sandbox::User" in item for item in command))
        else:
            raise AssertionError("Unexpected mocked APT command")
        self.runs.append(command)
        return subprocess.CompletedProcess(command, 0)

    def preflight(self):
        with mock.patch.object(ADAPTER, "installed", return_value=self.base), redirect_stdout(io.StringIO()):
            ADAPTER.preflight(self.inputs)

    def test_plan_lock_identity_rejects_mutation_and_unavailable_variant(self):
        self.assertEqual(ADAPTER.load(self.inputs), (self.plan, self.lock))
        for mutation in ("plan", "lock", "request", "variant"):
            with self.subTest(mutation=mutation):
                plan, lock = copy.deepcopy(self.plan), copy.deepcopy(self.lock)
                if mutation == "plan":
                    plan["stages"]["platform"].append("injected")
                elif mutation == "lock":
                    lock["packages"][0]["version"] = "forged"
                elif mutation == "request":
                    lock["packageRequestSha256"] = "0" * 64
                    plan["resolution"]["lockSha256"] = ADAPTER.object_hash(lock)
                    plan["planSha256"] = ADAPTER.object_hash(
                        {key: value for key, value in plan.items() if key != "planSha256"})
                else:
                    plan["configuration"]["nativeVariant"] = "minimal-zh-cpu"
                    plan["configSha256"] = ADAPTER.object_hash(plan["configuration"])
                    plan["planSha256"] = ADAPTER.object_hash(
                        {key: value for key, value in plan.items() if key != "planSha256"})
                with self.assertRaises(ValueError):
                    ADAPTER.check_plan(plan, lock)
        self.check_output.assert_not_called()
        self.run.assert_not_called()

    def test_real_file_hash_size_and_safe_path_guards(self):
        item = self.lock["archives"][0]
        self.assertEqual(ADAPTER.checked_file(self.inputs, item), self.inputs / item["path"])
        for changed in ({**item, "sha256": "0" * 64}, {**item, "bytes": item["bytes"] + 1},
                        {**item, "path": "../escape.deb"}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                ADAPTER.checked_file(self.inputs, changed)
        self.check_output.assert_not_called()

    def test_mocked_authentication_binds_trust_release_index_archive_and_control(self):
        indexes = ADAPTER.authenticate(self.inputs, self.lock)
        self.assertEqual(set(indexes), {"trixie"})
        self.assertEqual(self.check_output.call_count, 3)
        self.run.assert_not_called()

    def test_changed_trust_root_fails_before_subprocess(self):
        (self.source / "fixture-keyring.gpg").write_bytes(b"changed key")
        with self.assertRaisesRegex(ValueError, "trust root"):
            ADAPTER.authenticate(self.inputs, self.lock)
        self.check_output.assert_not_called()

    def test_changed_plan_trust_policy_fails_before_authentication(self):
        self.plan["archiveTrust"] = {**self.trust, "sha256": "0" * 64}
        self.seal()
        with self.assertRaisesRegex(ValueError, "trust differs"):
            self.preflight()
        self.check_output.assert_not_called()

    def test_wrong_source_expired_future_and_wrong_index_release_are_rejected(self):
        good = self.release
        now = self.now
        variants = [
            good.replace("Origin: Debian", "Origin: Unknown"),
            good.replace("Codename: trixie", "Codename: sid"),
            good.replace(format_datetime(now + timedelta(days=1)),
                         format_datetime(now - timedelta(days=2))),
            good.replace(format_datetime(now - timedelta(days=1)),
                         format_datetime(now + timedelta(days=2))),
            good.replace(sha(self.index_text.encode()), "0" * 64),
        ]
        for release in variants:
            with self.subTest(release=release):
                self.release = release
                with self.assertRaises(ValueError):
                    ADAPTER.authenticate(self.inputs, self.lock)
        self.run.assert_not_called()

    def test_failed_gpgv_is_not_success(self):
        self.check_output.side_effect = subprocess.CalledProcessError(1, ["gpgv"])
        with self.assertRaises(subprocess.CalledProcessError):
            ADAPTER.authenticate(self.inputs, self.lock)
        self.run.assert_not_called()

    def test_archive_architecture_and_control_identity_must_match_index(self):
        self.lock["archives"][0]["architecture"] = "arm64"
        with self.assertRaisesRegex(ValueError, "exact signed indexed"):
            ADAPTER.authenticate(self.inputs, self.lock)
        self.lock["archives"][0]["architecture"] = "amd64"
        original = self.fake_check_output
        self.check_output.side_effect = lambda command, **kwargs: (
            "Package: extra\nVersion: wrong\nArchitecture: amd64\n" if command[0] == "dpkg-deb"
            else original(command, **kwargs))
        with self.assertRaisesRegex(ValueError, "control identity"):
            ADAPTER.authenticate(self.inputs, self.lock)

    def test_mocked_preflight_solves_roots_by_stage_without_archive_paths(self):
        self.preflight()
        self.assertEqual(self.simulations, [["base-lib=1.0", "extra=2.0"],
                                           ["base-lib=1.0", "extra=2.0", "splash=3.0"]])
        self.assertEqual(len(self.runs), 1)
        self.assertIn("update", self.runs[0])

    def test_preflight_rejects_wrong_projected_inventory_before_apt(self):
        self.lock["packages"].append({"name": "unprovided", "version": "1", "architecture": "amd64", "reason": "fixture"})
        self.seal()
        with self.assertRaisesRegex(ValueError, "exact base"):
            self.preflight()
        self.run.assert_not_called()

    def test_preflight_rejects_base_upgrade_before_apt(self):
        self.base["extra"] = ("old", "amd64")
        with self.assertRaisesRegex(ValueError, "upgrade/replace"):
            self.preflight()
        self.run.assert_not_called()

    def test_preflight_rejects_wrong_stage_removals_and_solver_mismatch(self):
        self.lock["archives"][0]["stage"] = "boot"
        self.seal()
        with self.assertRaisesRegex(ValueError, "stage solution"):
            self.preflight()
        self.lock["archives"][0]["stage"] = "platform"
        self.seal()
        original = self.fake_check_output
        for simulation in ("Remv base-lib [1.0]\n", "Inst extra (wrong fixture [amd64])\n"):
            with self.subTest(simulation=simulation):
                self.check_output.side_effect = lambda command, **kwargs: (
                    simulation if command[0] == "apt-get" else original(command, **kwargs))
                with self.assertRaises(ValueError):
                    self.preflight()

    def test_install_only_passes_selected_stage_archives_to_mocked_apt(self):
        with mock.patch.object(ADAPTER, "installed", return_value=self.actual):
            ADAPTER.install(self.inputs, "platform")
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.runs[0][-1], str(self.inputs / self.lock["archives"][0]["path"]))
        self.assertNotIn(str(self.inputs / self.lock["archives"][1]["path"]), self.runs[0])

    def test_install_rejects_actual_version_or_architecture_mismatch(self):
        for value in (("wrong", "amd64"), ("2.0", "arm64")):
            with self.subTest(value=value), mock.patch.object(ADAPTER, "installed",
                                                             return_value={**self.actual, "extra": value}):
                with self.assertRaisesRegex(ValueError, "Installed stage differs"):
                    ADAPTER.install(self.inputs, "platform")

    def test_actual_inventory_forbidden_architecture_and_retained_identity(self):
        self.assertEqual(ADAPTER.installed(self.root), self.actual)
        self.assertEqual(ADAPTER.verify(self.root, self.plan, self.lock)["name"], "fixture-vm")
        for actual in ({**self.actual, "unexpected": ("1", "amd64")},
                       {**self.actual, "extra": ("2.0", "arm64")}):
            with self.subTest(actual=actual):
                self.write_status(actual)
                with self.assertRaisesRegex(ValueError, "inventory differs"):
                    ADAPTER.verify(self.root, self.plan, self.lock)
        self.write_status(self.actual)
        self.plan["configuration"]["policy"]["forbidden"] = ["extra"]
        self.seal()
        with self.assertRaisesRegex(ValueError, "forbidden"):
            ADAPTER.verify(self.root, self.plan, self.lock)
        self.plan["configuration"]["policy"]["forbidden"] = []
        self.seal()
        for name, value in ((ADAPTER.PLAN, self.plan), (ADAPTER.LOCK, self.lock)):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(value))
        identity, plan, lock = ADAPTER.verify_retained(self.root)
        self.assertEqual(plan, self.plan)
        self.assertEqual(lock, self.lock)
        self.assertEqual(identity["lockSha256"], ADAPTER.object_hash(self.lock))
        self.check_output.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
