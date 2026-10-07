#!/usr/bin/env python3
"""Semantic plan invariants; no runtime account or disk operations."""
import copy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("polly_plan", REPO / "desktop/tools/polly-plan.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class Plan(unittest.TestCase):
    def setUp(self):
        self.plan = json.loads((REPO / "docs/POLLYOS-PLAN.json").read_text())

    def task(self, key):
        return next(node for node in self.plan["nodes"] if node["id"] == key)

    def test_complete_semantic_model_and_scoped_completion(self):
        nodes = planner.validate(self.plan)
        self.assertEqual(len(self.plan["legacy"]), 141)
        self.assertEqual(self.task("role-bootstrap")["requires"], ["role-model", "first-entry"])
        self.assertNotIn("admin-ui", self.task("removable-policy")["requires"])
        self.assertNotIn("migrated-boot", self.task("current-fresh-boot")["requires"])
        for source, old in self.plan["legacy"].items():
            if old["status"] == "done":
                self.assertTrue(any(node["status"] == "done" and source in node["sources"]
                                    for node in nodes.values()), source)
        self.assertEqual(self.task("migrated-boot")["status"], "pending")

    def test_duplicate_or_orphan_nodes_are_rejected(self):
        self.plan["nodes"].append(copy.deepcopy(self.plan["nodes"][0]))
        with self.assertRaises(ValueError):
            planner.validate(self.plan)
        self.plan["nodes"].pop()
        self.task("role-bootstrap")["parent"] = "missing"
        with self.assertRaises(ValueError):
            planner.validate(self.plan)

    def test_whole_parent_and_cross_mode_prerequisites_are_rejected(self):
        for key in ("t05", "r2", "migrated-boot", "candidate-1"):
            self.task("first-entry")["requires"] = [key]
            with self.subTest(prerequisite=key), self.assertRaises(ValueError):
                planner.validate(self.plan)

    def test_cycles_missing_evidence_and_lost_contracts_are_rejected(self):
        self.task("role-model")["requires"] = ["role-bootstrap"]
        with self.assertRaisesRegex(ValueError, "cycle"):
            planner.validate(self.plan)
        self.task("role-model")["requires"] = ["account-model"]
        self.task("first-passwords")["evidence"] = ""
        with self.assertRaisesRegex(ValueError, "evidence"):
            planner.validate(self.plan)
        self.task("first-passwords")["evidence"] = "scoped test receipt"
        self.plan["legacy"]["M99.1"] = {"status": "pending", "requirement": "must not disappear"}
        with self.assertRaisesRegex(ValueError, "lost"):
            planner.validate(self.plan)

    def test_boolean_schema_and_overlong_labels_are_rejected(self):
        self.plan["schemaVersion"] = True
        with self.assertRaises(ValueError):
            planner.validate(self.plan)
        self.plan["schemaVersion"] = 1
        self.task("role-model")["label"] = "x" * 25
        with self.assertRaisesRegex(ValueError, "long"):
            planner.validate(self.plan)

    def test_import_database_preserves_all_nodes_origins_and_edge_kinds(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "plan.sqlite"
            planner.database(self.plan, path)
            with closing(sqlite3.connect(path)) as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM cards").fetchone()[0],
                                 len(self.plan["nodes"]))
                self.assertEqual(connection.execute("SELECT count(DISTINCT source_id) FROM origins").fetchone()[0], 141)
                kinds = {row[0] for row in connection.execute("SELECT DISTINCT kind FROM edges")}
                self.assertEqual(kinds, {"parent", "requires"})
                self.assertEqual(connection.execute(
                    "SELECT status FROM cards WHERE id='t25-m08-1'").fetchone()[0], "blocked")
            with self.assertRaisesRegex(ValueError, "overwrite"):
                planner.database(self.plan, path)

    def test_supported_sql_transfer_matches_the_canonical_model(self):
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE TABLE plan_subtasks(id TEXT PRIMARY KEY,task TEXT)")
            connection.executemany("INSERT INTO plan_subtasks VALUES(?,?)",
                ((key.lower().replace(".", "-"), value["requirement"].replace("`", ""))
                 for key, value in self.plan["legacy"].items()))
            connection.executescript(planner.transfer_sql(self.plan))
            expected = planner.rollup(self.plan["nodes"])
            actual = {row[0]: row[1:] for row in connection.execute(
                "SELECT id,label,parent_id,status,scope FROM polly_stage_nodes")}
            self.assertEqual(set(actual), set(expected))
            for key, node in expected.items():
                self.assertEqual(actual[key], (
                    node["label"], node.get("parent") or "", node["status"], node["scope"].replace("`", "")))
            self.assertEqual(connection.execute(
                "SELECT count(DISTINCT source_id) FROM polly_stage_origins").fetchone()[0], 141)


if __name__ == "__main__":
    unittest.main()
