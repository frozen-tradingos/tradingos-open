from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT / "contracts" / "v1" / "position-event-receipts.schema.json"
)


def _object_keys_are_valid(
    base: dict[str, object],
    overlay: dict[str, object],
    keys: set[str],
) -> bool:
    required = set(base.get("required", [])) | set(overlay.get("required", []))
    if not required <= keys:
        return False
    if len(keys) < int(overlay.get("minProperties", 0)):
        return False
    if len(keys) > int(overlay.get("maxProperties", len(keys))):
        return False

    properties = set(base.get("properties", {}))
    patterns = tuple(base.get("patternProperties", {}))
    if base.get("additionalProperties") is False:
        for key in keys - properties:
            if not any(re.fullmatch(pattern, key) for pattern in patterns):
                return False
    return True


class PositionEventReceiptContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.receipt = cls.schema["$defs"]["event_receipt"]
        cls.agent_proof = cls.receipt["properties"]["agent_proof"]
        cls.discord_ids = cls.receipt["properties"]["discord_message_ids"]
        cls.conditions = {
            item["if"]["properties"]["kind"]["const"]: item["then"]["properties"]
            for item in cls.receipt["allOf"]
        }

    def test_agent_cycle_accepts_only_complete_agent_proof(self) -> None:
        constraints = self.conditions["AGENT_CYCLE"]["agent_proof"]
        required = {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"}

        self.assertEqual(set(constraints["required"]), required)
        self.assertTrue(
            _object_keys_are_valid(self.agent_proof, constraints, required)
        )
        self.assertTrue(
            _object_keys_are_valid(
                self.agent_proof,
                constraints,
                required | {"TARGETED_TS", "TARGETED_COMMITTEE", "TARGETED_D"},
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.agent_proof,
                constraints,
                required - {"A3_REVIEW"},
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.agent_proof,
                constraints,
                required | {"TARGETED_A3"},
            )
        )

    def test_agent_cycle_requires_exact_discord_channels(self) -> None:
        constraints = self.conditions["AGENT_CYCLE"]["discord_message_ids"]
        required = {"a2", "ts", "committee", "d", "a3", "owner"}

        self.assertEqual(set(constraints["required"]), required)
        self.assertTrue(
            _object_keys_are_valid(self.discord_ids, constraints, required)
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.discord_ids,
                constraints,
                required | {"a1"},
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.discord_ids,
                constraints,
                required - {"owner"},
            )
        )

    def test_fault_only_accepts_empty_proof_and_exact_fault_channels(self) -> None:
        proof_constraints = self.conditions["FAULT_ONLY"]["agent_proof"]
        channel_constraints = self.conditions["FAULT_ONLY"][
            "discord_message_ids"
        ]
        channels = {"a1", "owner"}

        self.assertTrue(
            _object_keys_are_valid(
                self.agent_proof,
                proof_constraints,
                set(),
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.agent_proof,
                proof_constraints,
                {"TS"},
            )
        )
        self.assertTrue(
            _object_keys_are_valid(
                self.discord_ids,
                channel_constraints,
                channels,
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.discord_ids,
                channel_constraints,
                channels | {"a2"},
            )
        )
        self.assertFalse(
            _object_keys_are_valid(
                self.discord_ids,
                channel_constraints,
                channels - {"owner"},
            )
        )

    def test_hashes_ids_and_time_are_strict(self) -> None:
        hash_schemas = (
            self.receipt["properties"]["packet_hash"],
            self.receipt["properties"]["receipt_hash"],
            self.schema["$defs"]["agent_receipt"]["properties"][
                "evidence_hash"
            ],
        )
        for hash_schema in hash_schemas:
            with self.subTest(hash_schema=hash_schema):
                pattern = re.compile(hash_schema["pattern"])
                self.assertIsNotNone(pattern.fullmatch("a" * 64))
                self.assertIsNone(pattern.fullmatch("a" * 63))
                self.assertIsNone(pattern.fullmatch("A" * 64))

        for field in ("event_id", "run_id"):
            with self.subTest(field=field):
                field_schema = self.receipt["properties"][field]
                self.assertEqual(field_schema["minLength"], 1)
                self.assertIsNotNone(
                    re.search(field_schema["pattern"], "nonempty")
                )
                self.assertIsNone(re.search(field_schema["pattern"], "   "))

        for field_schema in self.discord_ids["properties"].values():
            self.assertEqual(field_schema["minLength"], 1)
            self.assertIsNone(re.search(field_schema["pattern"], " \t "))

        self.assertEqual(
            self.receipt["properties"]["completed_at"]["format"],
            "date-time",
        )
        completed_at_pattern = re.compile(
            self.receipt["properties"]["completed_at"]["pattern"]
        )
        self.assertIsNotNone(
            completed_at_pattern.fullmatch("2026-07-29T23:30:00-07:00")
        )
        self.assertIsNone(completed_at_pattern.fullmatch("2026-07-29 23:30"))

        event_key_schema = self.schema["properties"]["events"][
            "propertyNames"
        ]
        self.assertIsNotNone(
            re.search(event_key_schema["pattern"], "event-1")
        )
        self.assertIsNone(re.search(event_key_schema["pattern"], " \t "))

    def test_receipt_objects_reject_unknown_fields(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertFalse(self.receipt["additionalProperties"])
        self.assertFalse(self.agent_proof["additionalProperties"])
        self.assertFalse(self.discord_ids["additionalProperties"])
        self.assertFalse(
            self.schema["$defs"]["agent_receipt"]["additionalProperties"]
        )


if __name__ == "__main__":
    unittest.main()
