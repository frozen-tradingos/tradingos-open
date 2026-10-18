from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts" / "v2"


def schema(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


class TsOutputV2ContractTests(unittest.TestCase):
    def test_output_is_strict_prediction_first_v2(self) -> None:
        value = schema("ts-output.schema.json")
        self.assertFalse(value["additionalProperties"])
        self.assertEqual(
            value["properties"]["contract_version"],
            {"type": "string", "const": "v2"},
        )
        self.assertNotIn("confidence", value["properties"])
        self.assertNotIn("path", value["properties"])
        self.assertEqual(
            value["$defs"]["direction"]["enum"],
            ["BULLISH", "BEARISH", "RANGE"],
        )

    def test_output_separates_bias_maturity_and_tradeability(self) -> None:
        value = schema("ts-output.schema.json")
        required = set(value["required"])
        self.assertTrue(
            {"path_bias", "evidence_maturity", "tradeability"} <= required
        )
        self.assertEqual(
            value["$defs"]["tradeability"]["properties"]["status"]["enum"],
            ["WAIT", "CONDITIONAL", "READY_FOR_D_REVIEW"],
        )
        chain = value["$defs"]["causal_chain"]
        self.assertIn("event_fingerprint", chain["required"])
        self.assertIn("event_category", chain["required"])
        self.assertIn(
            "geopolitical_deescalation",
            chain["properties"]["event_category"]["enum"],
        )

    def test_output_binds_snapshot_release_and_market_time(self) -> None:
        snapshot = schema("ts-output.schema.json")["$defs"]["evidence_snapshot"]
        self.assertEqual(
            set(snapshot["required"]),
            {
                "run_id",
                "packet_hash",
                "analysis_freshness_hash",
                "release_commit",
                "market_time",
            },
        )
        market_time = snapshot["properties"]["market_time"]
        self.assertEqual(
            market_time["properties"]["timezone"]["const"],
            "America/Los_Angeles",
        )

    def test_core_and_enhanced_evidence_are_explicit(self) -> None:
        evidence = schema("ts-output.schema.json")["$defs"][
            "evidence_assessment"
        ]
        self.assertEqual(evidence["properties"]["core_status"]["const"], "READY")
        self.assertEqual(evidence["properties"]["core_gaps"]["maxItems"], 0)
        self.assertEqual(
            evidence["properties"]["enhancement_gap_effect"]["const"],
            "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY",
        )
        enhanced = schema("ts-output.schema.json")["$defs"][
            "enhanced_evidence_list"
        ]["items"]["enum"]
        self.assertIn("MACRO_SCHEDULE", enhanced)

    def test_scenarios_use_five_percent_probabilities_and_observables(self) -> None:
        defs = schema("ts-output.schema.json")["$defs"]
        probability = defs["scenario"]["properties"]["probability_pct"]
        self.assertEqual(probability["multipleOf"], 5)
        self.assertEqual(defs["scenario"]["properties"]["sequence"]["minItems"], 2)
        condition = defs["observable_condition"]
        self.assertFalse(condition["additionalProperties"])
        self.assertTrue(
            {"symbol", "metric", "operator", "value", "confirmation"}
            <= set(condition["required"])
        )

    def test_open_checks_have_prior_forecast_hash_fields(self) -> None:
        value = schema("ts-output.schema.json")
        self.assertTrue(
            {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}
            <= set(value["properties"]["report_type"]["enum"])
        )
        update = value["$defs"]["forecast_update"]
        self.assertTrue(
            {"prior_run_id", "prior_forecast_hash", "prior_status"}
            <= set(update["required"])
        )

    def test_spy_and_qqq_are_separate(self) -> None:
        outlooks = schema("ts-output.schema.json")["properties"][
            "symbol_outlooks"
        ]
        self.assertEqual(set(outlooks["required"]), {"SPY", "QQQ"})
        strength = schema("ts-output.schema.json")["$defs"]["symbol_outlook"][
            "properties"
        ]["relative_strength"]["enum"]
        self.assertEqual(strength, ["LEADER", "LAGGER", "IN_LINE"])

    def test_settlement_and_calibration_are_independent_contracts(self) -> None:
        observations = schema("ts-forecast-observations.schema.json")
        settlement = schema("ts-forecast-settlement.schema.json")
        settlement_run = schema("ts-settlement-run.schema.json")
        calibration = schema("ts-calibration-summary.schema.json")
        self.assertEqual(
            observations["properties"]["component"]["const"],
            "TS_FORECAST_OBSERVATIONS",
        )
        self.assertEqual(set(observations["properties"]["symbols"]["required"]), {"SPY", "QQQ"})
        self.assertEqual(
            observations["$defs"]["bar"]["properties"]["closed_at"]["format"],
            "date-time",
        )
        self.assertEqual(
            settlement["properties"]["component"]["const"],
            "TS_FORECAST_SETTLEMENT",
        )
        self.assertEqual(
            calibration["properties"]["component"]["const"],
            "TS_CALIBRATION_SUMMARY",
        )
        self.assertEqual(
            settlement_run["properties"]["component"]["const"],
            "TS_SETTLEMENT_RUN",
        )
        self.assertTrue(
            {
                "due_forecasts",
                "due_inventory_hash",
                "settled_due_run_ids",
                "settled_due_hash",
            }
            <= set(settlement_run["required"])
        )
        self.assertEqual(
            settlement_run["$defs"]["due_forecast"]["properties"][
                "target_market_dates"
            ]["items"]["format"],
            "date",
        )
        self.assertIn("brier_score", settlement["required"])
        self.assertIn("scenario_probabilities", settlement["required"])
        self.assertIn("source_observation_hashes", settlement["required"])
        self.assertIn(
            "forecast_direction",
            settlement["$defs"]["symbol_result"]["required"],
        )
        self.assertEqual(
            settlement["$defs"]["symbol_result"]["properties"][
                "actual_direction"
            ]["enum"],
            ["BULLISH", "BEARISH", "RANGE", "UNRESOLVED"],
        )
        self.assertIn("probability_buckets", calibration["required"])


if __name__ == "__main__":
    unittest.main()
