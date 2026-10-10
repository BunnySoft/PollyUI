#!/usr/bin/env python3
"""Synthetic qualification guard tests, not boot or hardware acceptance."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "handoff", Path(__file__).resolve().parents[1] / "tools/physical-test-handoff.py")
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class Guard(unittest.TestCase):
    def test_full_gate_and_exact_identity_required(self):
        stages = {"prepare": {"filesNative": True, "shellPid": 10, "settingsPid": 20},
                  "about": {"sameSettingsPid": 20},
                  "reopen": {"shellPid": 10, "newSettingsPid": 30,
                             "configuration": {"id": "xp", "filesEnabled": False}}}
        for name, theme, enabled in (("selected", "bigsur", True), ("user-theme", "alpha-vm", True),
                                     ("restored", "xp", False)):
            stages[name] = {"shellPid": 10, "settingsPid": 20,
                            "configuration": {"id": theme, "filesEnabled": enabled}}
        result = {"ready": True, "nativeChineseCommit": True, "nativeClipboardPaste": True,
                  "keyboardWorkspaceSwitch": True, "pamSessionRegistered": True,
                  "firmware": "OVMF UEFI", "acceleration": "kvm", "isoSha256": "a" * 64,
                  "ordinaryUser": 1000, "bootMedia": "read-only optical",
                  "newArchitecture": {"runtimeSourceRevision": "b" * 40, "harnessRevision": "c" * 40,
                                      "fixturesInIso": False, "actualStages": stages}}
        handoff.validate_result(result, "b" * 40, "c" * 40, "a" * 64)
        for name in ("ready", "nativeChineseCommit", "nativeClipboardPaste", "keyboardWorkspaceSwitch"):
            with self.subTest(gate=name), self.assertRaises(ValueError):
                handoff.validate_result({**result, name: False}, "b" * 40, "c" * 40, "a" * 64)
        with self.assertRaises(ValueError):
            handoff.validate_result(result, "d" * 40, "c" * 40, "a" * 64)
        with self.assertRaises(ValueError):
            handoff.validate_result(result, "b" * 40, "c" * 40, "d" * 64)
        bad = copy.deepcopy(result)
        bad["newArchitecture"]["actualStages"]["reopen"]["newSettingsPid"] = 20
        with self.assertRaises(ValueError):
            handoff.validate_result(bad, "b" * 40, "c" * 40, "a" * 64)
        bad = copy.deepcopy(result)
        bad["newArchitecture"]["actualStages"]["user-theme"]["configuration"]["id"] = "xp"
        with self.assertRaises(ValueError):
            handoff.validate_result(bad, "b" * 40, "c" * 40, "a" * 64)


if __name__ == "__main__":
    unittest.main()
