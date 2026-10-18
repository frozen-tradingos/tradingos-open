from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT / "contracts" / "v1" / "ts-calibration-provenance.schema.json"
)


class TSCalibrationProvenanceV1ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_sidecar_has_one_strict_exact_field_set(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertEqual(
            set(self.schema["required"]),
            {
                "contract_version",
                "component",
                "forecast_run_id",
                "forecast_hash",
                "record_hash",
                "cohort_id",
                "release_commit",
                "forecast_role",
                "report_type",
                "forecast_window",
                "official_slot",
                "delivery_proof",
                "ownership_proof",
                "parent_forecast_hash",
                "eligibility",
                "exclusion_reason",
                "provenance_hash",
            },
        )
        self.assertEqual(
            self.schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            self.schema["properties"]["component"],
            {"type": "string", "const": "TS_CALIBRATION_PROVENANCE"},
        )

    def test_identity_binds_forecast_record_cohort_release_and_exact_window(
        self,
    ) -> None:
        properties = self.schema["properties"]
        self.assertEqual(properties["forecast_run_id"], {"$ref": "#/$defs/run_id"})
        self.assertEqual(properties["forecast_hash"], {"$ref": "#/$defs/hash"})
        self.assertEqual(properties["record_hash"], {"$ref": "#/$defs/hash"})
        self.assertEqual(
            properties["release_commit"],
            {"$ref": "#/$defs/release_commit"},
        )
        self.assertEqual(
            properties["forecast_window"],
            {"$ref": "../v2/ts-output.schema.json#/$defs/forecast_window"},
        )
        self.assertEqual(
            set(self.schema["$defs"]["report_type"]["enum"]),
            {
                "WEEKEND_OUTLOOK",
                "NEXT_SESSION",
                "OPENING_FORECAST",
                "OPEN_15M_CHECK",
                "OPEN_30M_CHECK",
                "INTRADAY_30_60M",
            },
        )

    def test_roles_eligibility_and_single_exclusion_are_closed(self) -> None:
        properties = self.schema["properties"]
        self.assertEqual(
            properties["forecast_role"]["enum"],
            [
                "FORMAL_SLOT",
                "MATERIAL_REVISION",
                "UNDELIVERED_DRAFT",
                "TEST",
            ],
        )
        self.assertEqual(
            properties["eligibility"]["enum"],
            ["OFFICIAL_CALIBRATION", "EXCLUDED"],
        )
        reasons = self.schema["$defs"]["nullable_exclusion_reason"]["oneOf"]
        self.assertEqual(
            reasons,
            [
                {
                    "type": "string",
                    "enum": [
                        "LEGACY_COHORT",
                        "MATERIAL_REVISION",
                        "UNDELIVERED_DRAFT",
                        "TEST_EVENT",
                    ],
                },
                {"type": "null"},
            ],
        )

    def test_delivery_and_ownership_proofs_are_strict(self) -> None:
        delivery = self.schema["$defs"]["delivery_proof"]
        ownership = self.schema["$defs"]["ownership_proof"]
        self.assertFalse(delivery["additionalProperties"])
        self.assertEqual(
            set(delivery["required"]),
            {
                "delivery_kind",
                "delivery_key",
                "completed_at",
                "discord_message_id",
                "discord_content_hash",
            },
        )
        self.assertEqual(
            delivery["properties"]["delivery_kind"]["enum"],
            ["AGENT_CYCLE", "TS_INTRADAY"],
        )
        self.assertFalse(ownership["additionalProperties"])
        self.assertEqual(
            set(ownership["required"]),
            {"owner", "slot", "ownership_hash"},
        )
        self.assertEqual(
            ownership["properties"]["owner"]["enum"],
            ["FULL_CYCLE", "TS_INTRADAY"],
        )

    def test_role_rules_bind_slot_parent_proofs_and_exclusion(self) -> None:
        rules = self.schema["allOf"]
        by_role = {
            rule["if"]["properties"]["forecast_role"]["const"]: rule["then"]
            for rule in rules
            if "forecast_role" in rule["if"]["properties"]
            and "const" in rule["if"]["properties"]["forecast_role"]
            and len(rule["if"]["properties"]) == 1
        }
        self.assertEqual(
            set(by_role),
            {"FORMAL_SLOT", "MATERIAL_REVISION", "UNDELIVERED_DRAFT", "TEST"},
        )
        revision = by_role["MATERIAL_REVISION"]["properties"]
        self.assertEqual(revision["official_slot"], {"type": "null"})
        self.assertEqual(revision["parent_forecast_hash"], {"$ref": "#/$defs/hash"})
        self.assertEqual(revision["eligibility"], {"const": "EXCLUDED"})
        self.assertEqual(
            revision["exclusion_reason"],
            {"const": "MATERIAL_REVISION"},
        )
        draft = by_role["UNDELIVERED_DRAFT"]["properties"]
        self.assertEqual(draft["delivery_proof"], {"type": "null"})
        self.assertEqual(draft["ownership_proof"], {"type": "null"})
        formal = by_role["FORMAL_SLOT"]
        self.assertEqual(
            formal["properties"]["official_slot"],
            {"type": "string", "format": "date-time"},
        )
        self.assertEqual(
            formal["properties"]["delivery_proof"],
            {"$ref": "#/$defs/delivery_proof"},
        )

    def test_intraday_formal_slots_require_ownership_but_later_reports_do_not(
        self,
    ) -> None:
        scoped = [
            rule
            for rule in self.schema["allOf"]
            if set(rule["if"]["properties"]) == {"forecast_role", "report_type"}
        ]
        self.assertEqual(len(scoped), 2)
        intraday = next(
            rule
            for rule in scoped
            if "OPENING_FORECAST"
            in rule["if"]["properties"]["report_type"]["enum"]
        )
        later = next(rule for rule in scoped if rule is not intraday)
        self.assertEqual(
            intraday["then"]["properties"]["ownership_proof"],
            {"$ref": "#/$defs/ownership_proof"},
        )
        self.assertEqual(
            later["if"]["properties"]["report_type"]["enum"],
            ["WEEKEND_OUTLOOK", "NEXT_SESSION"],
        )
        self.assertEqual(
            later["then"]["properties"]["ownership_proof"],
            {"type": "null"},
        )


if __name__ == "__main__":
    unittest.main()
