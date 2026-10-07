#!/usr/bin/env python3
"""Role contract only; no PAM assertions or actual privileged operations."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("installed_roles",
    Path(__file__).resolve().parents[1] / "release/install/roles.py")
roles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roles)
USERS = [0, 1000, 1001]


class Roles(unittest.TestCase):
    def test_first_user_and_qualified_additional_users(self):
        policy = roles.initial(USERS)
        self.assertEqual(policy, {"schemaVersion": 1, "administratorUids": [1000]})
        self.assertEqual(roles.assigned_role(policy, 0, USERS), "root")
        self.assertEqual(roles.assigned_role(policy, 1000, USERS), "administrator")
        self.assertEqual(roles.assigned_role(policy, 1001, USERS), "standard")
        self.assertTrue(roles.management_eligible(policy, 1000, "apps.install", USERS))
        self.assertFalse(roles.management_eligible(policy, 1001, "apps.install", USERS))

    def test_unknown_alias_service_and_boolean_identities_are_not_roles(self):
        for users in ([0, 1000, True], [0, 1000, 500], [0, 1000, 65534],
                      [0, 1000, 1000], [1000, 1001]):
            with self.subTest(users=users), self.assertRaises(ValueError):
                roles.initial(users)
        for uid in (True, 500, 1002, "1000"):
            with self.subTest(uid=uid), self.assertRaises(ValueError):
                roles.assigned_role(roles.initial(USERS), uid, USERS)

    def test_policy_does_not_guess_missing_or_unqualified_administrators(self):
        for policy in ({}, {"schemaVersion": True, "administratorUids": [1000]},
                       {"schemaVersion": 2, "administratorUids": [1000]},
                       {"schemaVersion": 1, "administratorUids": []},
                       {"schemaVersion": 1, "administratorUids": [0]},
                       {"schemaVersion": 1, "administratorUids": [1002]},
                       {"schemaVersion": 1, "administratorUids": [True]},
                       {"schemaVersion": 1, "administratorUids": [1000, 1000]},
                       {"schemaVersion": 1, "administratorUids": [1001, 1000]},
                       {"schemaVersion": 1, "administratorUids": [1000], "shell": "/bin/sh"}):
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                roles.validate(policy, USERS)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            roles.parse('{"schemaVersion":1,"schemaVersion":1,"administratorUids":[1000]}', USERS)

    def test_no_general_root_or_argument_injection_operation(self):
        for operation in ("run", "/bin/sh", "apps.install;rm", "", None):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                roles.management_eligible(roles.initial(USERS), 1000, operation, USERS)


if __name__ == "__main__":
    unittest.main()
