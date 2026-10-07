#!/usr/bin/env python3
"""Public identity planning; no passwords, account writes or credential output."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("identities",
    Path(__file__).resolve().parents[1] / "release/storage/identities.py")
identities = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identities)
USER = {"name": "polly", "uid": 1000, "gid": 1000}
SOURCE_PASSWD = ("root:x:0:0:root:/root:/bin/sh\n"
                 "polly:x:1000:1000:polly:/home/polly:/bin/sh\n"
                 "tester:x:1001:1001:tester:/home/tester:/bin/sh\n"
                 "worker:x:110:110:service:/nonexistent:/usr/sbin/nologin\n")
SOURCE_GROUP = "root:x:0:\npolly:x:1000:\ntester:x:1001:\nworker:x:110:\n"
TARGET_PASSWD = SOURCE_PASSWD.replace("worker:x:110:110:", "worker:x:112:112:")
TARGET_GROUP = SOURCE_GROUP.replace("worker:x:110:", "worker:x:112:")


def plan():
    return {"schemaVersion": 1, "source": identities.fingerprint(SOURCE_PASSWD, SOURCE_GROUP),
            "target": identities.fingerprint(TARGET_PASSWD, TARGET_GROUP),
            "users": [{"name": "worker", "role": "service", "sourceUid": 110, "targetUid": 112},
                      {"name": "tester", "role": "user", "sourceUid": 1001, "targetUid": 1001}],
            "groups": [{"name": "worker", "role": "service", "sourceGid": 110, "targetGid": 112},
                       {"name": "tester", "role": "user", "sourceGid": 1001, "targetGid": 1001}]}


class Identities(unittest.TestCase):
    def verify(self, record):
        return identities.IdentityMap(record, USER).verify(
            SOURCE_PASSWD, SOURCE_GROUP, TARGET_PASSWD, TARGET_GROUP)

    def test_explicit_service_rebase_and_stable_other_user(self):
        mapper = self.verify(plan())
        self.assertEqual(mapper.allowed("uid", "source"), {0, 1000, 1001, 110})
        self.assertEqual(mapper.allowed("gid", "target"), {0, 1000, 1001, 112})
        self.assertEqual(mapper.uid_map, {110: 112, 1001: 1001})

    def test_stale_proof_and_numeric_guesses_are_rejected(self):
        for field in ("source", "target"):
            record = plan()
            record[field]["passwd"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "stale"):
                self.verify(record)
        record = plan()
        record["users"][0]["sourceUid"] = 109
        with self.assertRaisesRegex(ValueError, "disagrees"):
            self.verify(record)
        record = plan()
        record["groups"] = [record["groups"][1]]
        with self.assertRaisesRegex(ValueError, "primary group"):
            self.verify(record)
        same = plan()
        same["target"] = same["source"]
        same["users"][0]["targetUid"] = 110
        same["groups"] = [same["groups"][1]]
        with self.assertRaisesRegex(ValueError, "primary group"):
            identities.IdentityMap(same, USER).verify(
                SOURCE_PASSWD, SOURCE_GROUP, SOURCE_PASSWD, SOURCE_GROUP)

    def test_privilege_aliases_user_drift_and_boolean_numbers_are_rejected(self):
        for change in ({"targetUid": 0}, {"sourceUid": 0}, {"targetUid": 1000},
                       {"targetUid": 1002}, {"sourceUid": True}, {"role": "unknown"}):
            record = plan()
            record["users"][0].update(change)
            with self.assertRaises(ValueError):
                self.verify(record)
        record = plan()
        record["users"][1]["targetUid"] = 1002
        with self.assertRaisesRegex(ValueError, "remain stable"):
            self.verify(record)
        record = plan()
        record["users"].append(copy.deepcopy(record["users"][0]))
        with self.assertRaisesRegex(ValueError, "aliases"):
            self.verify(record)

    def test_public_databases_cannot_contain_secret_fields_or_ambiguous_ids(self):
        for text in (SOURCE_PASSWD.replace("root:x:", "root:$invalid:"),
                     SOURCE_PASSWD + "alias:x:0:0:alias:/root:/bin/sh\n",
                     SOURCE_PASSWD.replace("worker:x:110:", "worker:x:0110:")):
            with self.assertRaises(ValueError):
                identities.database(text, "passwd")
        with self.assertRaises(ValueError):
            identities.database(SOURCE_GROUP + "alias:x:110:\n", "group")

    def test_unknown_selectors_and_duplicate_json_fields_are_rejected(self):
        mapper = self.verify(plan())
        for kind, side in (("unknown", "source"), ("uid", "unknown")):
            with self.assertRaises(ValueError):
                mapper.allowed(kind, side)
        with self.assertRaises(ValueError):
            identities.database(SOURCE_PASSWD, "unknown")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            identities.load_record('{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(ValueError):
            identities.IdentityMap(plan(), {**USER, "uid": True})


if __name__ == "__main__":
    unittest.main()
