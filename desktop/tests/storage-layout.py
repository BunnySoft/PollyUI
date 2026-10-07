#!/usr/bin/env python3
"""Storage contract tests without credentials, filesystem mounts or device access."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("storage_layout",
    Path(__file__).resolve().parents[1] / "release/storage/layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)

VOLUMES = {
    "EFI": "12AB-34CD",
    "SYSTEM": "10000000-0000-4000-8000-000000000001",
    "PERSISTENT": "10000000-0000-4000-8000-000000000002",
    "RECOVERY": "10000000-0000-4000-8000-000000000003",
}


class StorageLayout(unittest.TestCase):
    def test_contract_round_trip(self):
        value = layout.contract(VOLUMES)
        self.assertEqual(layout.validate(json.loads(json.dumps(value))), value)
        self.assertNotIn("initialized", value)
        self.assertEqual(value["mappings"][0], {
            "volume": "SYSTEM", "source": "System/Resources", "target": "/usr", "phase": "initramfs",
        })
        self.assertEqual({item["target"] for item in value["mappings"]} & {"/etc", "/var", "/var/lib"}, set())

    def test_unknown_or_changed_contract_rejected(self):
        mutations = [
            lambda value: value.update(schemaVersion=2),
            lambda value: value.update(schemaVersion=True),
            lambda value: value.update(extra=True),
            lambda value: value.update(persistentMount="/tmp"),
            lambda value: value["mappings"][0].update(phase="system"),
            lambda value: value["mappings"][0].update(source="../usr"),
            lambda value: value["directories"][0].update(mode=0o777),
            lambda value: value["directories"][0].update(mode=float(0o755)),
            lambda value: value["directories"][0].update(uid=False),
            lambda value: value["restoreRules"][1].update(policy="restore-old-copy"),
            lambda value: value["volumes"][0].update(filesystem="ext4"),
            lambda value: value["volumes"].reverse(),
        ]
        for mutation in mutations:
            value = layout.contract(VOLUMES)
            mutation(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                layout.validate(value)

    def test_volume_identity_errors(self):
        cases = [
            {**VOLUMES, "SYSTEM": VOLUMES["PERSISTENT"]},
            {**VOLUMES, "SYSTEM": "../disk"},
            {**VOLUMES, "EFI": "12ab-34cd"},
            {**VOLUMES, "SYSTEM": False},
            {key: value for key, value in VOLUMES.items() if key != "RECOVERY"},
        ]
        for volumes in cases:
            with self.subTest(volumes=volumes), self.assertRaises(ValueError):
                layout.contract(volumes)

    def test_uid_based_data_identity_survives_rename(self):
        users = [*copy.deepcopy(layout.DEFAULT_USERS), {"name": "guest", "uid": 1001, "gid": 1001}]
        before = layout.contract(VOLUMES, users)
        users[1]["name"] = "owner"
        after = layout.contract(VOLUMES, users)
        old = next(item for item in before["mappings"] if item["target"] == "/home/polly")
        new = next(item for item in after["mappings"] if item["target"] == "/home/owner")
        self.assertEqual(old["source"], new["source"])
        self.assertEqual(new["source"], "Users/1000")
        self.assertIn({"volume": "PERSISTENT", "source": "Users/0",
                       "target": "/root", "phase": "system"}, after["mappings"])

    def test_invalid_user_identities(self):
        cases = [
            [{"name": "root", "uid": 0, "gid": 0}],
            [{"name": "root", "uid": 0, "gid": 0}, {"name": "polly", "uid": True, "gid": 1000}],
            [{"name": "root", "uid": 0, "gid": 0}, {"name": "polly", "uid": 1000, "gid": 0}],
            [*layout.DEFAULT_USERS, {"name": "duplicate", "uid": 1000, "gid": 1000}],
            [*layout.DEFAULT_USERS, {"name": "daemon", "uid": 999, "gid": 999}],
            [*layout.DEFAULT_USERS, {"name": "../user", "uid": 1001, "gid": 1001}],
        ]
        for users in cases:
            with self.subTest(users=users), self.assertRaises(ValueError):
                layout.validate_users(users)

    def test_restore_groups_are_distinct(self):
        rules = {rule["id"]: rule for rule in layout.contract(VOLUMES)["restoreRules"]}
        self.assertEqual(rules["system"]["policy"], "restore-matched-set")
        self.assertIn("/SystemData/Library/Dpkg", rules["system"]["paths"])
        self.assertIn("/SystemData/Library/Apt", rules["system"]["paths"])
        self.assertEqual(rules["identity"]["policy"], "retain-latest")
        self.assertEqual(rules["applications"]["policy"], "independent-application-transaction")
        self.assertEqual(rules["users"]["policy"], "preserve-unless-explicit-data-migration")

    def test_measured_partition_sizes(self):
        payloads = dict(zip(layout.VOLUME_ROLES, [8 * layout.MIB, 1200 * layout.MIB,
                                                  100 * layout.MIB, 400 * layout.MIB]))
        reserve = dict.fromkeys(layout.VOLUME_ROLES, 32)
        parts, image_bytes = layout.partition_plan(payloads, reserve)
        self.assertEqual([part["name"] for part in parts], list(layout.VOLUME_ROLES))
        self.assertEqual(len({part["uuid"] for part in parts}), 4)
        for part in parts:
            self.assertEqual(part["sizeMiB"], (part["payloadBytes"] + layout.MIB - 1) // layout.MIB +
                             part["filesystemOverheadMiB"] + part["reserveMiB"])
        for left, right in zip(parts, parts[1:]):
            self.assertEqual(left["startSector"] + left["sectors"], right["startSector"])
        self.assertEqual(image_bytes, (sum(part["sizeMiB"] for part in parts) + 2) * layout.MIB)
        layout.validate(layout.contract({part["name"]: part["uuid"] for part in parts}))

    def test_empty_or_unmeasured_partitions_rejected(self):
        payloads = dict.fromkeys(layout.VOLUME_ROLES, layout.MIB)
        reserves = dict.fromkeys(layout.VOLUME_ROLES, 32)
        for role in layout.VOLUME_ROLES:
            for invalid in (0, -1, True, 65 * 1024 * layout.MIB):
                with self.subTest(role=role, invalid=invalid), self.assertRaises(ValueError):
                    layout.partition_plan({**payloads, role: invalid}, reserves)
        with self.assertRaises(ValueError):
            layout.partition_plan(payloads, {"SYSTEM": 32})


if __name__ == "__main__":
    unittest.main()
