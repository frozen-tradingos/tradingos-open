from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "contracts" / "v1" / "a1-macro-result.schema.json"


class A1MacroResultContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_result_is_one_strict_read_only_release(self) -> None:
        self.assertEqual(
            self.schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema",
        )
        self.assertFalse(self.schema["additionalProperties"])
        properties = self.schema["properties"]
        self.assertEqual(set(self.schema["required"]), set(properties))
        self.assertEqual(
            properties["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            properties["component"],
            {"type": "string", "const": "A1_MACRO_RESULT"},
        )
        self.assertEqual(
            properties["actionable"],
            {"type": "boolean", "const": False},
        )
        self.assertEqual(
            properties["status"]["enum"],
            ["VERIFIED", "MISSING", "DEGRADED"],
        )

    def test_result_binds_schedule_and_official_raw_publication(self) -> None:
        properties = self.schema["properties"]
        self.assertEqual(
            properties["selection_rule"]["const"],
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE",
        )
        self.assertEqual(
            properties["schedule_event_fingerprint"]["pattern"],
            "^[0-9a-f]{64}$",
        )
        self.assertEqual(
            properties["raw_item_hash"]["oneOf"][0]["pattern"],
            "^[0-9a-f]{64}$",
        )
        self.assertEqual(
            properties["source"]["oneOf"][0],
            {"type": "string", "const": "BLS"},
        )
        self.assertEqual(
            properties["source_url"]["oneOf"][0]["pattern"],
            "^https://www\\.bls\\.gov/",
        )
        self.assertEqual(
            properties["result_hash"]["pattern"],
            "^[0-9a-f]{64}$",
        )

    def test_verified_requires_provenance_and_nonempty_metrics(self) -> None:
        status_branch = self.schema["allOf"][0]
        self.assertEqual(
            status_branch["if"]["properties"]["status"]["const"],
            "VERIFIED",
        )
        verified = status_branch["then"]["properties"]
        self.assertEqual(
            verified["confidence"],
            {"type": "string", "const": "official_result"},
        )
        self.assertEqual(
            verified["source"],
            {"type": "string", "const": "BLS"},
        )
        self.assertEqual(verified["metrics"]["minItems"], 1)

        unavailable = status_branch["else"]["properties"]
        for field in (
            "published_at",
            "source",
            "source_url",
            "raw_item_hash",
            "confidence",
        ):
            self.assertEqual(unavailable[field], {"type": "null"})
        self.assertEqual(unavailable["metrics"]["maxItems"], 0)

    def test_metrics_are_strict_typed_finite_actuals_with_periods(self) -> None:
        metrics = self.schema["properties"]["metrics"]
        self.assertTrue(metrics["uniqueItems"])
        self.assertEqual(metrics["maxItems"], 3)
        metric = self.schema["$defs"]["metric"]
        self.assertFalse(metric["additionalProperties"])
        self.assertEqual(set(metric["required"]), set(metric["properties"]))
        self.assertEqual(
            metric["properties"]["period"]["pattern"],
            "^[0-9]{4}-(0[1-9]|1[0-2])$",
        )
        value = metric["properties"]["value"]
        self.assertEqual(value["type"], "number")
        self.assertLess(value["minimum"], 0)
        self.assertGreater(value["maximum"], 0)
        self.assertEqual(
            metric["properties"]["unit"]["enum"],
            ["JOBS", "PERCENT", "USD"],
        )
        self.assertEqual(
            metric["properties"]["name"]["enum"],
            [
                "PAYROLL_EMPLOYMENT_CHANGE",
                "UNEMPLOYMENT_RATE",
                "AVERAGE_HOURLY_EARNINGS_CHANGE",
                "JOB_OPENINGS",
                "CONSUMER_PRICE_INDEX_CHANGE",
                "PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE",
            ],
        )

    def test_release_category_and_metric_domains_are_constrained(self) -> None:
        properties = self.schema["properties"]
        self.assertEqual(
            properties["category"]["enum"],
            ["employment", "inflation"],
        )
        self.assertEqual(
            properties["release_name"]["enum"],
            [
                "Employment Situation",
                "Job Openings and Labor Turnover Survey",
                "Consumer Price Index",
                "Producer Price Index",
            ],
        )
        release_branches = self.schema["allOf"][1:]
        self.assertEqual(len(release_branches), 5)
        self.assertEqual(
            release_branches[0]["then"]["properties"]["category"]["const"],
            "employment",
        )
        self.assertEqual(
            release_branches[0]["else"]["properties"]["category"]["const"],
            "inflation",
        )
        employment_metrics = release_branches[1]["then"]["properties"][
            "metrics"
        ]
        self.assertEqual(
            release_branches[1]["if"]["properties"]["status"],
            {"const": "VERIFIED"},
        )
        self.assertEqual(
            release_branches[1]["if"]["required"],
            ["release_name", "status"],
        )
        self.assertEqual(employment_metrics["minItems"], 3)
        self.assertEqual(employment_metrics["maxItems"], 3)
        self.assertEqual(len(employment_metrics["allOf"]), 3)
        for branch in release_branches[2:]:
            self.assertEqual(
                branch["if"]["properties"]["status"],
                {"const": "VERIFIED"},
            )
            metric_rule = branch["then"]["properties"]["metrics"]
            self.assertEqual(metric_rule["minItems"], 1)
            self.assertEqual(metric_rule["maxItems"], 1)


if __name__ == "__main__":
    unittest.main()
