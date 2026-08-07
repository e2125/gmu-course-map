import sqlite3
import tempfile
import unittest
from pathlib import Path

from server import PlanError, PlanStore, normalize_plan_payload


class PlanStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temporary_directory.name) / "plans.db"
        self.store = PlanStore(self.database_path)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_create_and_public_read_do_not_expose_edit_token(self):
        plan, edit_token = self.store.create(
            {
                "name": "Systems track",
                "program_id": "cs-bs-2026",
                "completed_codes": ["CS 112", "CS 211"],
                "transferred_codes": ["CS 112"],
                "planned_codes": ["CS 310"],
                "planned_terms": {"CS 310": "fall-2026"},
                "earned_credits": 65,
                "audit_completed_codes": ["CS 112", "CS 211"],
            }
        )

        self.assertTrue(edit_token)
        self.assertEqual(self.store.get(plan["id"]), plan)
        self.assertNotIn("edit_token", plan)
        self.assertNotIn("edit_token_hash", plan)
        self.assertEqual(plan["transferred_codes"], ["CS 112"])
        self.assertEqual(plan["planned_codes"], ["CS 310"])
        self.assertEqual(plan["planned_terms"], {"CS 310": "fall-2026"})
        self.assertEqual(plan["earned_credits"], 65)

        with sqlite3.connect(self.database_path) as connection:
            stored_hash = connection.execute(
                "SELECT edit_token_hash FROM plans WHERE id = ?", (plan["id"],)
            ).fetchone()[0]
        self.assertNotEqual(stored_hash, edit_token)

    def test_update_requires_the_private_edit_token(self):
        plan, edit_token = self.store.create(
            {"name": "Original", "program_id": "all", "completed_codes": []}
        )

        with self.assertRaises(PlanError) as context:
            self.store.update(
                plan["id"],
                "wrong-token",
                {"name": "Changed", "program_id": "all", "completed_codes": []},
            )
        self.assertEqual(context.exception.status, 403)

        updated = self.store.update(
            plan["id"],
            edit_token,
            {
                "name": "Changed",
                "program_id": "cs-bs-2026",
                "completed_codes": ["cs211", "CS 211", "math 125"],
                "planned_codes": ["CS 310"],
                "planned_terms": {"CS 310": "spring-2027"},
                "earned_credits": 68,
                "audit_completed_codes": ["CS 211", "MATH 125"],
            },
        )
        self.assertEqual(updated["name"], "Changed")
        self.assertEqual(updated["completed_codes"], ["CS 211", "MATH 125"])
        self.assertEqual(updated["planned_codes"], ["CS 310"])
        self.assertEqual(updated["planned_terms"], {"CS 310": "spring-2027"})
        self.assertEqual(updated["earned_credits"], 68)

    def test_generated_migration_is_recorded_once(self):
        PlanStore(self.database_path)
        with sqlite3.connect(self.database_path) as connection:
            count = connection.execute("SELECT COUNT(*) FROM _migrations").fetchone()[0]
        self.assertEqual(count, 4)


class PlanValidationTests(unittest.TestCase):
    def test_normalizes_valid_payload(self):
        self.assertEqual(
            normalize_plan_payload(
                {
                    "name": "  My plan ",
                    "program_id": "cs-bs-2026",
                    "completed_codes": ["cs211", "CS 211", "math 125"],
                    "transferred_codes": ["math 125"],
                    "planned_codes": ["CS 310", "CS 211"],
                    "planned_terms": {"CS 310": "fall-2026", "CS 211": "later"},
                    "earned_credits": 65,
                    "audit_completed_codes": ["CS 211", "MATH 125"],
                }
            ),
            {
                "name": "My plan",
                "program_id": "cs-bs-2026",
                "completed_codes": ["CS 211", "MATH 125"],
                "transferred_codes": ["MATH 125"],
                "planned_codes": ["CS 310"],
                "planned_terms": {"CS 310": "fall-2026"},
                "earned_credits": 65.0,
                "audit_completed_codes": ["CS 211", "MATH 125"],
            },
        )

    def test_rejects_invalid_course_codes(self):
        with self.assertRaises(PlanError):
            normalize_plan_payload(
                {"name": "Plan", "program_id": "all", "completed_codes": ["CS 99"]}
            )
