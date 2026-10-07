#!/usr/bin/env python3
"""Synthetic T24.1/2 acceptance; never enumerate or open real host block devices."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("install_targets", REPO / "desktop/release/install/targets.py")
targets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(targets)
MIB = 1024 * 1024
MEASUREMENTS = {"payloadBytes": {"EFI": 8 * MIB, "SYSTEM": 1200 * MIB,
                                  "PERSISTENT": 100 * MIB, "RECOVERY": 400 * MIB},
                "headroomMiB": {"EFI": 64, "SYSTEM": 512, "PERSISTENT": 1024, "RECOVERY": 64}}


def disk(name, dev, model="Fixture External SSD", serial="FIXTURE-USB-001",
         wwn="0x1234567890abcdef", size=16 * 1024 * MIB, usb=True):
    return {"name": "/dev/" + name, "path": "/dev/" + name, "kname": name,
            "maj:min": dev, "type": "disk", "size": size, "model": model,
            "serial": serial, "wwn": wwn, "tran": "usb" if usb else "nvme",
            "rm": False, "ro": False, "log-sec": 512, "pkname": None,
            "mountpoints": [None], "fstype": None, "uuid": None, "partuuid": None,
            "start": None, "pttype": "gpt"}


def part(parent, name, dev, start=2048, size=256 * MIB):
    return {**copy.deepcopy(parent), "name": "/dev/" + name, "path": "/dev/" + name,
            "kname": name, "maj:min": dev, "type": "part", "size": size,
            "pkname": parent["kname"], "start": start, "pttype": None,
            "fstype": "ext4", "uuid": "fixture-filesystem", "partuuid": "fixture-partition"}


def kernel(raw, parent=None, diskseq=7):
    path = "/sys/devices/pci0000:00/usb1/1-1/block/" if raw["tran"] == "usb" else \
        "/sys/devices/pci0000:00/nvme/nvme0/"
    name = targets._kname(raw["kname"])
    if parent:
        path = parent["sysfsPath"] + "/"
    return {"sysfsPath": path + name, "dev": raw["maj:min"],
            "sizeSectors512": raw["size"] // 512, "logicalSectorBytes": raw["log-sec"],
            "readOnly": raw["ro"], "removable": raw["rm"], "diskseq": diskseq,
            "partition": 1 if parent else None, "startSector512": raw["start"],
            "parent": parent["dev"] if parent else None, "holders": [], "slaves": [],
            "partitions": [child["maj:min"] for child in raw.get("children", [])
                           if child["type"] == "part"]}


def fixture():
    host = disk("nvme0n1", "259:0", "WD_BLACK SN770 2TB", "FIXTURE-HOST",
                "0x1111111111111111", usb=False)
    root = part(host, "nvme0n1p1", "259:1", size=4 * 1024 * MIB)
    root["mountpoints"] = ["/"]
    external = disk("sdb", "8:16")
    existing = part(external, "sdb1", "8:17")
    host["children"], external["children"] = [root], [existing]
    host_kernel, external_kernel = kernel(host), kernel(external)
    return {"lsblk": {"blockdevices": [host, external]},
            "sysfs": {"259:0": host_kernel, "259:1": kernel(root, host_kernel),
                      "8:16": external_kernel, "8:17": kernel(existing, external_kernel)},
            "context": {"complete": True, "root": ["259:1"], "boot": ["259:1"],
                        "source": ["259:1"], "mounts": [{"majorMinor": "259:1", "target": "/"}],
                        "swaps": [], "errors": []}}


def external(report):
    return next(item for item in report["devices"] if item["observation"]["majorMinor"] == "8:16")


def codes(entry):
    return {item["code"] for item in entry["reasons"]}


class InstallTargets(unittest.TestCase):
    def report(self, snapshot=None, measurements=None):
        return targets.inventory(fixture() if snapshot is None else snapshot,
                                 MEASUREMENTS if measurements is None else measurements)

    def test_complete_usb_with_nonremovable_flag_and_partitions(self):
        report = self.report()
        target = external(report)
        self.assertTrue(target["eligible"], target["reasons"])
        self.assertFalse(target["removable"])
        self.assertFalse(report["writeAuthorized"])
        self.assertEqual(report["errors"], [])
        self.assertEqual(target["identity"]["serial"], "FIXTURE-USB-001")
        self.assertEqual(target["identity"]["wwn"], "1234567890abcdef")
        self.assertEqual(len(target["partitions"]), 1)
        self.assertEqual(target["partitions"][0]["startSector512"], 2048)
        self.assertEqual(target["clearingScope"]["endByteExclusive"], 16 * 1024 * MIB)
        self.assertFalse(target["clearingScope"]["performed"])
        self.assertEqual(json.loads(json.dumps(report)), report)

    def test_shared_loader_measured_capacity_not_8gib_or_ab(self):
        value = self.report()["capacity"]
        self.assertEqual([part["name"] for part in value["partitions"]],
                         ["EFI", "SYSTEM", "PERSISTENT", "RECOVERY"])
        self.assertEqual(value["layout"], targets.LAYOUT)
        self.assertNotEqual(value["requiredBytes"], 8 * 1024 * MIB)
        self.assertEqual(value["requiredBytes"], (sum(
            part["sizeMiB"] for part in value["partitions"]) + 2) * MIB)
        for part in value["partitions"]:
            self.assertNotIn("uuid", part)
            self.assertEqual(part["payloadBytes"], MEASUREMENTS["payloadBytes"][part["name"]])
        larger = copy.deepcopy(MEASUREMENTS)
        larger["payloadBytes"]["SYSTEM"] *= 2
        self.assertGreater(targets.capacity_requirements(larger)["requiredBytes"], value["requiredBytes"])

    def test_exact_capacity_threshold(self):
        required = self.report()["capacity"]["requiredBytes"]
        for size, expected in ((required - 512, False), (required, True), (required + 512, True)):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1]["size"] = size
            snap["sysfs"]["8:16"]["sizeSectors512"] = size // 512
            target = external(self.report(snap))
            self.assertEqual(target["eligible"], expected, target["reasons"])
            self.assertEqual("insufficient-capacity" in codes(target), not expected)

    def test_protected_model_aliases_even_external_or_wrong_capacity(self):
        aliases = ["Samsung SSD 990 PRO 4TB", "SAMSUNG_990_PRO_4000GB",
                   "Samsung 990 PRO 1TB", "990 PRO", "SanDisk SDSSDXPS480G",
                   "ATA SanDisk_SDSSDXPS480G", "SDSSDXPS480G",
                   "WD_BLACK SN770 2TB", "WDC WD BLACK SN770 2000GB", "WD-BLACK_SN770"]
        for alias in aliases:
            with self.subTest(alias=alias):
                snap = fixture()
                snap["lsblk"]["blockdevices"][1]["model"] = alias
                target = external(self.report(snap))
                self.assertIn("protected-model", codes(target))
                self.assertFalse(target["eligible"])
        self.assertFalse(targets.excluded_model("Fixture Other Model"))

    def test_active_root_boot_source_ancestry_excluded(self):
        report = self.report()
        host = report["devices"][0]
        self.assertTrue({"protected-model", "active-root", "active-boot",
                         "active-source", "mounted"} <= codes(host))
        for category in ("root", "boot", "source"):
            snap = fixture()
            snap["context"][category] = ["8:17"]
            self.assertIn("active-" + category, codes(external(self.report(snap))))

    def test_unknown_context_and_overlay_are_not_safe(self):
        changes = [lambda c: c.update(complete=False), lambda c: c.update(root=[]),
                   lambda c: c.update(source=[]), lambda c: c.update(boot=None),
                   lambda c: c.update(root=["0:42"]), lambda c: c.update(source=["8:99"]),
                   lambda c: c.update(mounts=None), lambda c: c.update(swaps=None),
                   lambda c: c.update(errors=["source resolution failed"]),
                   lambda c: c.update(errors=None)]
        for change in changes:
            with self.subTest(change=change):
                snap = fixture()
                change(snap["context"])
                self.assertFalse(external(self.report(snap))["eligible"])

    def test_mounted_partition_and_swap_and_holders(self):
        for kind in ("lsblk", "mountinfo", "swap", "holders"):
            snap = fixture()
            if kind == "lsblk":
                snap["lsblk"]["blockdevices"][1]["children"][0]["mountpoints"] = ["/mnt/fixture"]
            elif kind == "mountinfo":
                snap["context"]["mounts"].append({"majorMinor": "8:17", "target": "/mnt/fixture"})
            elif kind == "swap":
                snap["context"]["swaps"] = ["8:17"]
            else:
                snap["sysfs"]["8:17"]["holders"] = ["253:0"]
            target = external(self.report(snap))
            self.assertFalse(target["eligible"])
            self.assertIn("mounted" if kind in {"lsblk", "mountinfo"} else "in-use", codes(target))

    def test_removable_alone_or_usb_claim_alone_not_safe(self):
        for change in ("tran", "sysfs"):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1]["rm"] = True
            snap["sysfs"]["8:16"]["removable"] = True
            if change == "tran":
                snap["lsblk"]["blockdevices"][1]["tran"] = "nvme"
            else:
                snap["sysfs"]["8:16"]["sysfsPath"] = "/sys/devices/pci0000:00/block/sdb"
                snap["sysfs"]["8:17"]["sysfsPath"] = "/sys/devices/pci0000:00/block/sdb/sdb1"
            self.assertIn("external-provenance-unknown", codes(external(self.report(snap))))

    def test_read_only_is_not_eligible(self):
        snap = fixture()
        snap["lsblk"]["blockdevices"][1]["ro"] = True
        snap["sysfs"]["8:16"]["readOnly"] = True
        self.assertIn("read-only", codes(external(self.report(snap))))

    def test_stable_missing_placeholders_and_wwn_only(self):
        for serial, wwn in ((None, None), ("", ""), ("unknown", "0x0000000000000000"),
                            ("000000000", None), ("N/A", None)):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1].update(serial=serial, wwn=wwn)
            target = external(self.report(snap))
            self.assertIn("missing-stable-id", codes(target))
        for serial, wwn in ((None, "0x1234567890abcdef"), ("FIXTURE-USB-001", None)):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1].update(serial=serial, wwn=wwn)
            self.assertTrue(external(self.report(snap))["eligible"])

    def test_duplicate_serial_or_wwn_reject_even_with_distinct_other_id_and_model(self):
        for key in ("serial", "wwn"):
            snap = fixture()
            other = disk("sdc", "8:32", "Fixture Different Model", "FIXTURE-USB-002",
                         "0x2222222222222222")
            other[key] = snap["lsblk"]["blockdevices"][1][key]
            snap["lsblk"]["blockdevices"].append(other)
            snap["sysfs"]["8:32"] = kernel(other)
            for target in (item for item in self.report(snap)["devices"]
                           if item["observation"]["majorMinor"] in {"8:16", "8:32"}):
                self.assertIn("duplicate-stable-id", codes(target))
        snap = fixture()
        other = disk("sdc", "8:32", serial="fixture-usb-001", wwn="0x2222222222222222")
        snap["lsblk"]["blockdevices"].append(other)
        snap["sysfs"]["8:32"] = kernel(other)
        self.assertIn("duplicate-stable-id", codes(external(self.report(snap))))

    def test_model_collision_without_ids_is_not_identity(self):
        snap = fixture()
        other = disk("sdc", "8:32", serial=None, wwn=None)
        snap["lsblk"]["blockdevices"][1].update(serial=None, wwn=None)
        snap["lsblk"]["blockdevices"].append(other)
        snap["sysfs"]["8:32"] = kernel(other)
        self.assertFalse(external(self.report(snap))["eligible"])
        with self.assertRaises(ValueError):
            targets.selection(self.report(snap), external(self.report(snap))["entryId"])

    def test_byte_values_overflow_units_floats_bools_remain_visible(self):
        for value in (True, False, 0, -1, 1.0, "16G", "1e10", str(1 << 63), 1 << 63, None):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1]["size"] = value
            target = external(self.report(snap))
            self.assertIsNone(target["capacityBytes"])
            self.assertEqual(target["raw"]["size"], value)
            self.assertIn("invalid-field", codes(target))
        snap = fixture()
        snap["lsblk"]["blockdevices"][1]["size"] = str(16 * 1024 * MIB)
        snap["lsblk"]["blockdevices"][1]["log-sec"] = "512"
        snap["sysfs"]["8:16"]["sizeSectors512"] = str(16 * 1024 * MIB // 512)
        self.assertTrue(external(self.report(snap))["eligible"])

    def test_boolean_flags_accept_only_bool_or_zero_one(self):
        for value, valid in ((False, True), (0, True), ("0", True),
                             (None, False), ("false", False), (1.0, False), (2, False)):
            snap = fixture()
            snap["lsblk"]["blockdevices"][1]["rm"] = value
            target = external(self.report(snap))
            self.assertEqual(target["eligible"], valid, target["reasons"])

    def test_measurement_types_and_limits(self):
        for value in (True, 0, -1, "100", 1.0, 65 * 1024 * MIB):
            measurements = copy.deepcopy(MEASUREMENTS)
            measurements["payloadBytes"]["SYSTEM"] = value
            with self.assertRaises(ValueError):
                self.report(measurements=measurements)
        measurements = copy.deepcopy(MEASUREMENTS)
        measurements["headroomMiB"]["SYSTEM"] = False
        with self.assertRaises(ValueError):
            self.report(measurements=measurements)

    def test_missing_and_inconsistent_sysfs_fail_closed(self):
        for change in ("missing", "dev", "size", "diskseq", "sector", "path", "holders"):
            snap = fixture()
            if change == "missing":
                del snap["sysfs"]["8:16"]
            else:
                values = {"dev": "8:99", "size": 1 << 63, "diskseq": True, "sector": 513,
                          "path": "/sys/devices/../sdb", "holders": None}
                keys = {"size": "sizeSectors512", "sector": "logicalSectorBytes",
                        "path": "sysfsPath"}
                snap["sysfs"]["8:16"][keys.get(change, change)] = values[change]
            self.assertFalse(external(self.report(snap))["eligible"])

    def test_parent_conflicts_aliases_missing_parent_and_cycle(self):
        for kind in ("tree", "pkname", "kernel", "alias", "cycle", "parent-path"):
            snap = fixture()
            child = snap["lsblk"]["blockdevices"][1]["children"][0]
            if kind == "tree":
                snap["lsblk"]["blockdevices"][0]["children"].append(child)
                snap["lsblk"]["blockdevices"][1]["children"] = []
            elif kind == "pkname":
                child["pkname"] = "nvme0n1"
            elif kind == "kernel":
                snap["sysfs"]["8:17"]["parent"] = "8:99"
            elif kind == "alias":
                child["kname"] = "sdb"
            elif kind == "parent-path":
                snap["sysfs"]["8:17"]["sysfsPath"] = "/sys/devices/other/sdb1"
            else:
                snap["sysfs"]["8:16"]["slaves"] = ["8:17"]
            self.assertIn("ambiguous-topology", codes(external(self.report(snap))))

    def test_partition_geometry_overlap_and_bounds(self):
        for kind in ("overflow", "overlap", "diskseq", "start"):
            snap = fixture()
            child = snap["lsblk"]["blockdevices"][1]["children"][0]
            if kind == "overflow":
                child["size"] = 16 * 1024 * MIB
                snap["sysfs"]["8:17"]["sizeSectors512"] = child["size"] // 512
            elif kind == "overlap":
                other = part(snap["lsblk"]["blockdevices"][1], "sdb2", "8:18")
                snap["lsblk"]["blockdevices"][1]["children"].append(other)
                snap["sysfs"]["8:18"] = kernel(other, snap["sysfs"]["8:16"])
                snap["sysfs"]["8:18"]["partition"] = 2
                snap["sysfs"]["8:16"]["partitions"].append("8:18")
            elif kind == "diskseq":
                snap["sysfs"]["8:17"]["diskseq"] = 8
            else:
                child["start"] = True
            self.assertFalse(external(self.report(snap))["eligible"])

    def test_partition_listing_is_complete_not_guessed_from_table_label(self):
        snap = fixture()
        snap["lsblk"]["blockdevices"][1]["children"] = []
        del snap["sysfs"]["8:17"]
        target = external(self.report(snap))
        self.assertIn("ambiguous-topology", codes(target))
        self.assertFalse(target["eligible"])
        snap["sysfs"]["8:16"]["partitions"] = []
        self.assertTrue(external(self.report(snap))["eligible"])

    def test_dm_root_propagates_to_physical_ancestors(self):
        snap = fixture()
        dm = disk("dm-0", "253:0", serial=None, wwn=None, size=256 * MIB)
        dm.update(type="crypt", model=None, tran=None, mountpoints=["/"], pkname="sdb1")
        dm_kernel = kernel({**dm, "tran": "usb"})
        dm_kernel["slaves"] = ["8:17"]
        snap["sysfs"]["8:17"]["holders"] = ["253:0"]
        snap["sysfs"]["253:0"] = dm_kernel
        snap["lsblk"]["blockdevices"][1]["children"][0]["children"] = [dm]
        snap["context"]["root"] = ["253:0"]
        self.assertIn("active-root", codes(external(self.report(snap))))
        self.assertIn("in-use", codes(external(self.report(snap))))
        dm.update(name="/dev/mapper/fixture-root", path="/dev/mapper/fixture-root")
        report = self.report(snap)
        self.assertEqual(report["errors"], [])
        self.assertIn("active-root", codes(external(report)))

    def test_nonphysical_loop_backing_unknown_fails_closed(self):
        snap = fixture()
        loop = disk("loop0", "7:0", serial=None, wwn=None)
        loop.update(type="loop", model=None, tran=None)
        snap["lsblk"]["blockdevices"].append(loop)
        snap["sysfs"]["7:0"] = kernel({**loop, "tran": "usb"})
        snap["context"]["root"] = ["7:0"]
        self.assertIn("active-ancestry-unknown", codes(external(self.report(snap))))

    def test_dense_shared_ancestry_is_memoized_and_depth_is_bounded(self):
        snap = fixture()
        previous = ["8:17"]
        for layer in range(12):
            current = []
            for column in range(4):
                index = layer * 4 + column
                dev = "253:" + str(index)
                raw = disk("dm-" + str(index), dev, serial=None, wwn=None, size=256 * MIB)
                raw.update(type="crypt", model=None, tran=None)
                value = kernel({**raw, "tran": "usb"})
                value["slaves"] = list(previous)
                for parent in previous:
                    snap["sysfs"][parent]["holders"].append(dev)
                snap["sysfs"][dev] = value
                snap["lsblk"]["blockdevices"].append(raw)
                current.append(dev)
            previous = current
        snap["context"]["root"] = [previous[0]]
        started = time.monotonic()
        report = self.report(snap)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(report["errors"], [])
        self.assertIn("active-root", codes(external(report)))
        previous = [previous[0]]
        for index in range(48, 54):
            dev = "253:" + str(index)
            raw = disk("dm-" + str(index), dev, serial=None, wwn=None, size=256 * MIB)
            raw.update(type="crypt", model=None, tran=None)
            value = kernel({**raw, "tran": "usb"})
            value["slaves"] = previous
            snap["sysfs"][previous[0]]["holders"].append(dev)
            snap["sysfs"][dev] = value
            snap["lsblk"]["blockdevices"].append(raw)
            previous = [dev]
        self.assertIn("ambiguous-topology", codes(external(self.report(snap))))

    def test_duplicate_tree_conflict_unknown_entries_retained(self):
        snap = fixture()
        duplicate = copy.deepcopy(snap["lsblk"]["blockdevices"][1])
        duplicate["serial"] = "CONFLICT"
        snap["lsblk"]["blockdevices"].extend([duplicate, {"type": "mystery"}, None])
        report = self.report(snap)
        self.assertEqual(len(report["devices"]), 8)
        self.assertFalse(any(item["eligible"] for item in report["devices"]))
        self.assertEqual(report["devices"][-1]["raw"]["invalidEntry"], None)

    def test_limits_and_duplicate_json_keys(self):
        with self.assertRaises(ValueError):
            targets._json('{"blockdevices": [], "blockdevices": []}')
        with self.assertRaises(ValueError):
            targets._json('{"value": NaN}')
        with self.assertRaises(ValueError):
            targets._json(" " * (targets.MAX_OUTPUT + 1))
        for kind in ("count", "depth"):
            snap = fixture()
            if kind == "count":
                snap["lsblk"]["blockdevices"] = [{}] * (targets.MAX_NODES + 1)
            else:
                node = {}
                snap["lsblk"]["blockdevices"] = [node]
                for _ in range(targets.MAX_DEPTH + 2):
                    child = {}
                    node["children"] = [child]
                    node = child
            with self.assertRaises(ValueError):
                self.report(snap)
        snap = fixture()
        snap["context"]["errors"] = ["x" * 4096] * 100
        report = self.report(snap)
        self.assertFalse(external(report)["eligible"])
        self.assertLess(len(json.dumps(report)), 64000)
        snap["context"]["errors"] = ["x" * targets.MAX_OUTPUT]
        with self.assertRaises(ValueError):
            self.report(snap)

    def test_reidentify_unchanged_is_not_authorization(self):
        report = self.report()
        selected = targets.selection(report, external(report)["entryId"])
        result = targets.reidentify(selected, self.report())
        self.assertTrue(result["matches"], result["reasons"])
        self.assertFalse(result["writeAuthorized"])
        self.assertFalse(selected["writeAuthorized"])
        self.assertEqual(result["device"]["identity"], selected["identity"])

    def test_changed_identity_capacity_layout_and_readonly_after_selection(self):
        report = self.report()
        selected = targets.selection(report, external(report)["entryId"])
        for kind in ("serial", "wwn", "model", "size", "partition", "mounted", "readonly"):
            snap = fixture()
            raw = snap["lsblk"]["blockdevices"][1]
            if kind in {"serial", "wwn", "model"}:
                raw[kind] = {"serial": "REPLACED", "wwn": "0x2222222222222222",
                             "model": "Different Fixture Model"}[kind]
            elif kind == "size":
                raw["size"] += MIB
                snap["sysfs"]["8:16"]["sizeSectors512"] += MIB // 512
            elif kind == "partition":
                raw["children"][0]["uuid"] = "changed-filesystem"
            elif kind == "mounted":
                snap["context"]["mounts"].append({"majorMinor": "8:17", "target": "/mnt/fixture"})
            else:
                raw["ro"] = True
                snap["sysfs"]["8:16"]["readOnly"] = True
            result = targets.reidentify(selected, self.report(snap))
            self.assertFalse(result["matches"], kind)
            self.assertFalse(result["writeAuthorized"])

    def test_hotplug_diskseq_and_renamed_node_require_reselection(self):
        report = self.report()
        selected = targets.selection(report, external(report)["entryId"])
        for kind in ("diskseq", "renamed", "removed", "replaced-node"):
            snap = fixture()
            raw = snap["lsblk"]["blockdevices"][1]
            if kind == "diskseq":
                snap["sysfs"]["8:16"]["diskseq"] += 1
                snap["sysfs"]["8:17"]["diskseq"] += 1
            elif kind == "renamed":
                raw.update(name="/dev/sdz", path="/dev/sdz", kname="sdz")
                raw["children"][0].update(name="/dev/sdz1", path="/dev/sdz1",
                                          kname="sdz1", pkname="sdz")
                snap["sysfs"]["8:16"]["sysfsPath"] = snap["sysfs"]["8:16"]["sysfsPath"].replace("sdb", "sdz")
                snap["sysfs"]["8:17"]["sysfsPath"] = snap["sysfs"]["8:17"]["sysfsPath"].replace("sdb", "sdz")
                self.assertTrue(external(self.report(snap))["eligible"])
            elif kind == "removed":
                snap["lsblk"]["blockdevices"].pop()
                del snap["sysfs"]["8:16"], snap["sysfs"]["8:17"]
            else:
                raw.update(serial="REPLACED", wwn="0x2222222222222222")
            result = targets.reidentify(selected, self.report(snap))
            self.assertFalse(result["matches"], kind)
            self.assertIn("observation-changed" if kind in {"diskseq", "renamed"} else
                          "identity-missing", codes(result))

    def test_measurements_and_duplicate_identity_change_before_submit(self):
        report = self.report()
        selected = targets.selection(report, external(report)["entryId"])
        changed = copy.deepcopy(MEASUREMENTS)
        changed["headroomMiB"]["SYSTEM"] += 1
        result = targets.reidentify(selected, self.report(measurements=changed))
        self.assertIn("identity-changed", codes(result))
        snap = fixture()
        other = disk("sdc", "8:32")
        snap["lsblk"]["blockdevices"].append(other)
        snap["sysfs"]["8:32"] = kernel(other)
        self.assertIn("duplicate-stable-id", codes(targets.reidentify(selected, self.report(snap))))

    def test_selection_not_a_node_or_permit_and_tampering_rejected(self):
        report = self.report()
        with self.assertRaises(ValueError):
            targets.selection(report, "/dev/sdb")
        selected = targets.selection(report, external(report)["entryId"])
        for change in (lambda v: v.update(writeAuthorized=True),
                       lambda v: v.update(schemaVersion=True),
                       lambda v: v["identity"].update(serial="forged"),
                       lambda v: v.update(fingerprint="forged"),
                       lambda v: v.update(extra=True)):
            value = copy.deepcopy(selected)
            change(value)
            self.assertIn("selection-invalid", codes(targets.reidentify(value, self.report())))

    def test_private_synthetic_sysfs_tree_and_parent_mapping(self):
        snap = fixture()
        with tempfile.TemporaryDirectory(prefix="polly-target-sysfs-") as temp:
            root = Path(temp)
            (root / "dev/block").mkdir(parents=True)
            for dev in ("8:16", "8:17"):
                value = snap["sysfs"][dev]
                path = root / value["sysfsPath"].removeprefix("/sys/")
                path.mkdir(parents=True)
                for key in ("holders", "slaves"):
                    (path / key).mkdir()
                (root / "dev/block" / dev).symlink_to(path, target_is_directory=True)
                for filename, key in (("dev", "dev"), ("size", "sizeSectors512"),
                                      ("ro", "readOnly")):
                    (path / filename).write_text(str(int(value[key])) if type(value[key]) is bool
                                                 else str(value[key]))
                if value["parent"]:
                    (path / "partition").write_text("1")
                    (path / "start").write_text(str(value["startSector512"]))
                else:
                    (path / "queue").mkdir()
                    (path / "queue/logical_block_size").write_text("512")
                    (path / "removable").write_text("0")
                    (path / "diskseq").write_text("7")
            for dev in ("8:16", "8:17"):
                collected = targets._collect_kernel(dev, time.monotonic() + 3, root)
                self.assertEqual(collected["sysfsPath"], snap["sysfs"][dev]["sysfsPath"])
                self.assertEqual(targets._integer(collected["diskseq"]), 7)
                self.assertEqual(collected["partitions"], snap["sysfs"][dev]["partitions"])
            (root / "dev/block/8:99").symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                targets._collect_kernel("8:99", time.monotonic() + 3, root)

    def test_collector_parses_synthetic_standard_output_only(self):
        snap = fixture()
        output = json.dumps(snap["lsblk"])
        calls = []

        def command(args, deadline):
            calls.append(args)
            self.assertGreater(deadline, time.monotonic())
            return output if args[0] == "/usr/bin/lsblk" else "259:1\n"

        def read(path, limit=targets.MAX_TEXT):
            if str(path) == "/proc/self/mountinfo":
                return "1 0 259:1 / / rw - ext4 /dev/nvme0n1p1 rw\n"
            if str(path) == "/proc/swaps":
                return "Filename Type Size Used Priority\n"
            self.fail("Unexpected read: " + str(path))

        with patch.object(targets, "_command", side_effect=command), \
                patch.object(targets, "_read", side_effect=read), \
                patch.object(targets, "_collect_kernel", side_effect=lambda d, _: snap["sysfs"][d]), \
                patch.object(Path, "resolve", lambda path, **kwargs: path), \
                patch.object(Path, "exists", return_value=False):
            collected = targets.enumerate_readonly(["/fixture/payload"])
        self.assertTrue(external(self.report(collected))["eligible"])
        self.assertEqual(sum(call[0] == "/usr/bin/lsblk" for call in calls), 2)
        self.assertEqual(calls[0], targets.LSBLK)
        self.assertTrue(all(call[0] in {"/usr/bin/lsblk", "/usr/bin/findmnt"} for call in calls))

    def test_collector_hotplug_standard_output_preserves_rejection(self):
        snap = fixture()
        changed = copy.deepcopy(snap["lsblk"])
        changed["blockdevices"].pop()
        outputs = iter([json.dumps(snap["lsblk"]), json.dumps(changed)])
        with patch.object(targets, "_command", side_effect=lambda args, _: next(outputs)
                          if args[0] == "/usr/bin/lsblk" else "259:1\n"), \
                patch.object(targets, "_read", side_effect=lambda path, *_:
                             "Filename Type Size Used Priority\n" if str(path) == "/proc/swaps"
                             else "1 0 259:1 / / rw - ext4 /dev/nvme0n1p1 rw\n"), \
                patch.object(targets, "_collect_kernel", side_effect=lambda d, _: snap["sysfs"][d]), \
                patch.object(Path, "resolve", lambda path, **kwargs: path), \
                patch.object(Path, "exists", return_value=False):
            collected = targets.enumerate_readonly(["/fixture/payload"])
        self.assertFalse(collected["context"]["complete"])
        self.assertIn("incomplete-context", codes(external(self.report(collected))))
        self.assertIn("enumeration-changed", codes(external(self.report(collected))))

    def test_bounded_command_timeout_overflow_and_failure_without_device_access(self):
        self.assertEqual(targets._command((sys.executable, "-c", "print('fixture')"),
                                         time.monotonic() + 3), "fixture\n")
        for code, duration in (("import time; time.sleep(2)", 0.1),
                               ("import sys; sys.stdout.write('x'*3000000)", 3),
                               ("raise SystemExit(7)", 3)):
            with self.assertRaises((ValueError, subprocess.TimeoutExpired)):
                targets._command((sys.executable, "-c", code), time.monotonic() + duration)

    def test_fixture_cli_json_and_reidentify_with_private_inputs(self):
        with tempfile.TemporaryDirectory(prefix="polly-target-cli-") as temp:
            root = Path(temp)
            snap, measured, selected = (root / name for name in ("snapshot.json", "measured.json", "selected.json"))
            snap.write_text(json.dumps(fixture()))
            measured.write_text(json.dumps(MEASUREMENTS))
            selected.write_text(json.dumps(targets.selection(self.report(), external(self.report())["entryId"])))
            command = [sys.executable, "-I", "-B", str(REPO / "desktop/release/install/targets.py"),
                       "--fixture", str(snap), "--measurements", str(measured)]
            run = subprocess.run(command, check=True, capture_output=True, text=True, timeout=10)
            self.assertTrue(external(json.loads(run.stdout))["eligible"])
            run = subprocess.run([*command, "--reidentify", str(selected)], check=True,
                                 capture_output=True, text=True, timeout=10)
            self.assertTrue(json.loads(run.stdout)["matches"])
            snap.write_text('{"blockdevices": [], "blockdevices": []}')
            run = subprocess.run(command, capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 2)
            self.assertFalse(json.loads(run.stdout)["writeAuthorized"])
            self.assertIn("Duplicate", json.loads(run.stdout)["error"])


if __name__ == "__main__":
    unittest.main()
