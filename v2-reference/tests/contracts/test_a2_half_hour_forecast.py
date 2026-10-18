from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = (
    ROOT
    / "contracts"
    / "v1"
    / "a2-half-hour-forecast.schema.json"
)


class A2HalfHourForecastContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_public_proof_has_exact_v1_shadow_fields(self) -> None:
        self.assertFalse(self.schema["additionalProperties"])
        self.assertEqual(
            set(self.schema["required"]),
            {
                "contract_version",
                "component",
                "mode",
                "actionable",
                "status",
                "issue_status",
                "issued_forecast_id",
                "issued_forecast_hash",
                "session_date",
                "session_issued_forecast_ids",
                "session_inventory_hash",
                "resolved_forecast_ids",
                "pending_overdue_forecast_ids",
            },
        )
        properties = self.schema["properties"]
        self.assertEqual(
            properties["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            properties["component"],
            {"type": "string", "const": "A2_HALF_HOUR_FORECAST"},
        )
        self.assertEqual(
            properties["mode"],
            {"type": "string", "const": "SHADOW"},
        )
        self.assertEqual(
            properties["actionable"],
            {"type": "boolean", "const": False},
        )

    def test_inventory_fields_are_hash_bound_forecast_lists(self) -> None:
        properties = self.schema["properties"]
        self.assertEqual(
            properties["session_inventory_hash"]["pattern"],
            "^[0-9a-f]{64}$",
        )
        self.assertEqual(
            properties["session_issued_forecast_ids"],
            {"$ref": "#/$defs/forecast_ids"},
        )
        self.assertEqual(
            properties["resolved_forecast_ids"],
            {"$ref": "#/$defs/forecast_ids"},
        )
        forecast_ids = self.schema["$defs"]["forecast_ids"]
        self.assertTrue(forecast_ids["uniqueItems"])
        self.assertEqual(
            forecast_ids["items"]["pattern"],
            "^hh-[0-9]{8}T[0-9]{4}Z$",
        )


if __name__ == "__main__":
    unittest.main()
