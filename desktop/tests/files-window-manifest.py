#!/usr/bin/env python3
"""Source-only tests for strict native evidence aggregation; no GUI success claims."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("files_window", Path(__file__).with_name("files-window.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class NativeManifest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="polly-files-manifest-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for flow, stages in fixture.STAGES.items():
            directory = self.root / flow
            directory.mkdir()
            self.write(flow, "inputs.json", {"flow": flow, "uid": 1000, "root": "/private/" + flow,
                "cwd": "/source",
                "driverSha256": "driver", "runtimeSha256": "runtime", "sourceSha256": {"view": "source"}})
            self.write(flow, "files-window-result.json", {"flow": flow, "passed": True, "native": True,
                "root": "/private/" + flow, "captures": [{"stage": stage} for stage in stages],
                "closeObserved": True, "evidence": {key: True for key in fixture.REQUIRED_EVIDENCE[flow]}})
            self.write(flow, "mime-result.json", {"uid": 1000, "argv": ["/private/" + flow + "/literal %u; \u4e2d\u6587.txt"],
                "cwd": "/source", "text": "Synthetic private Files MIME content.\n"})
            (directory / "native.log").write_text(
                "FILES_WINDOW_DRIVE_PASS:\nFILES_WINDOW_CLOSE_PASS:\nFILES_WINDOW_SUPERVISOR_PASS:\n")
            captures = []
            for stage in stages:
                image = directory / ("files-" + stage + ".png")
                image.write_bytes(b"synthetic aggregation fixture, not native evidence")
                captures.append({"stage": stage, "sha256": hashlib.sha256(image.read_bytes()).hexdigest()})
            self.write(flow, "captures.json", captures)

    def write(self, flow, name, value):
        (self.root / flow / name).write_text(json.dumps(value))

    def aggregate(self):
        return fixture.aggregate_flows(self.root, {"browser": 10, "details": 20})

    def test_stage_sets_cover_eleven_distinct_visuals_and_both_flows(self):
        result = self.aggregate()
        self.assertEqual([flow["id"] for flow in result["flows"]], ["browser", "details"])
        stages = [capture["stage"] for flow in result["flows"] for capture in flow["captures"]]
        self.assertEqual(len(stages), 11)
        self.assertEqual(len(set(stages)), 11)
        self.assertEqual(result["flows"][1]["elapsedMs"], 20)

    def test_incomplete_or_failed_flow_cannot_create_aggregate_success(self):
        for change in ("passed", "closeObserved", "native"):
            with self.subTest(change=change):
                receipt = {"flow": "details", "passed": True, "native": True,
                           "closeObserved": True, "evidence": {"action": True}}
                receipt[change] = False
                self.write("details", "files-window-result.json", receipt)
                with self.assertRaises(RuntimeError):
                    self.aggregate()
        self.assertFalse((self.root / "aggregate.json").exists())

    def test_wrong_stage_order_or_changed_image_is_rejected(self):
        captures = json.loads((self.root / "details/captures.json").read_text())
        self.write("details", "captures.json", list(reversed(captures)))
        with self.assertRaises(RuntimeError):
            self.aggregate()
        self.write("details", "captures.json", captures)
        (self.root / "details/files-no-matches.png").write_bytes(b"changed")
        with self.assertRaises(RuntimeError):
            self.aggregate()

    def test_fresh_home_and_current_identical_source_runtime_are_required(self):
        inputs = json.loads((self.root / "details/inputs.json").read_text())
        for change in ("root", "driverSha256", "runtimeSha256", "sourceSha256"):
            with self.subTest(change=change):
                changed = dict(inputs)
                changed[change] = "/private/browser" if change == "root" else "other"
                self.write("details", "inputs.json", changed)
                with self.assertRaises(RuntimeError):
                    self.aggregate()

    def test_failure_marker_overrides_success_markers(self):
        path = self.root / "details/native.log"
        path.write_text(path.read_text() + "FILES_WINDOW_FAIL: actual native input failed\n")
        with self.assertRaises(RuntimeError):
            self.aggregate()

    def test_missing_action_and_cross_flow_consumer_are_rejected(self):
        receipt = json.loads((self.root / "details/files-window-result.json").read_text())
        del receipt["evidence"]["properties"]
        self.write("details", "files-window-result.json", receipt)
        with self.assertRaises(RuntimeError):
            self.aggregate()
        receipt["evidence"]["properties"] = True
        self.write("details", "files-window-result.json", receipt)
        self.write("details", "mime-result.json", json.loads((self.root / "browser/mime-result.json").read_text()))
        with self.assertRaises(RuntimeError):
            self.aggregate()


if __name__ == "__main__":
    unittest.main()
