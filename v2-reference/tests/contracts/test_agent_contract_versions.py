from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = (
    "ts-output.schema.json",
    "committee-output.schema.json",
    "d-output.schema.json",
    "a3-review.schema.json",
    "a3-final.schema.json",
    "codex-guard.schema.json",
)


class AgentContractVersionTests(unittest.TestCase):
    def test_all_agent_outputs_require_v1(self) -> None:
        for name in SCHEMAS:
            with self.subTest(schema=name):
                schema = json.loads(
                    (ROOT / "contracts" / "v1" / name).read_text(encoding="utf-8")
                )
                self.assertIn("contract_version", schema["required"])
                self.assertEqual(
                    schema["properties"]["contract_version"],
                    {"type": "string", "const": "v1"},
                )

    def test_a2_pattern_tracker_contract_is_strict_v1(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "a2-pattern-tracker.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(schema["properties"]["cadence_minutes"]["const"], 15)
        self.assertEqual(schema["properties"]["confirmation_bars"]["const"], 3)
        self.assertEqual(
            set(schema["properties"]["symbols"]["required"]),
            {"SPY", "QQQ"},
        )

    def test_a2_trend_pullback_contract_is_strict_and_non_executing(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "a2-trend-pullback.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            schema["properties"]["trade_action"],
            {"type": "boolean", "const": False},
        )
        self.assertFalse(schema["$defs"]["symbol"]["additionalProperties"])
        self.assertFalse(
            schema["$defs"]["assessment"]["additionalProperties"]
        )

    def test_earnings_day_context_is_strict_and_non_actionable(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "earnings-day-context.schema.json"
            ).read_text(encoding="utf-8")
        )

        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            schema["properties"]["component"],
            {"type": "string", "const": "EARNINGS_DAY_CONTEXT"},
        )
        self.assertEqual(
            schema["properties"]["actionable"],
            {"type": "boolean", "const": False},
        )
        self.assertEqual(schema["properties"]["candidates"]["minItems"], 1)
        self.assertEqual(schema["properties"]["candidates"]["maxItems"], 20)
        self.assertFalse(schema["$defs"]["candidate"]["additionalProperties"])

    def test_ts_and_a3_expose_conditional_earnings_day_coverage(self) -> None:
        for name in ("ts-output.schema.json", "a3-final.schema.json"):
            with self.subTest(schema=name):
                schema = json.loads(
                    (ROOT / "contracts" / "v1" / name).read_text(
                        encoding="utf-8"
                    )
                )
                self.assertNotIn("earnings_day_coverage", schema["required"])
                coverage = schema["$defs"]["earnings_day_coverage"]
                self.assertEqual(coverage["minItems"], 1)
                self.assertEqual(coverage["maxItems"], 20)
                item = coverage["items"]
                self.assertFalse(item["additionalProperties"])
                self.assertEqual(
                    item["properties"]["treatment"],
                    {"type": "string", "const": "SCHEDULE_RISK_ONLY"},
                )

    def test_pattern_transition_receipts_contract_is_strict_v1(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "pattern-transition-receipts.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        receipt = schema["$defs"]["transition_receipt"]
        self.assertFalse(receipt["additionalProperties"])
        self.assertEqual(
            set(receipt["properties"]["agent_proof"]["required"]),
            {"TS", "COMMITTEE", "D", "A3_REVIEW", "A3"},
        )
        self.assertEqual(
            set(receipt["properties"]["discord_message_ids"]["required"]),
            {"a2", "ts", "committee", "d", "a3", "owner"},
        )
        self.assertEqual(
            receipt["properties"]["all_messages_delivered"]["const"],
            True,
        )

    def test_position_monitor_contracts_are_strict_v1(self) -> None:
        for name in (
            "position-management-plans.schema.json",
            "position-monitor.schema.json",
            "position-event-receipts.schema.json",
        ):
            with self.subTest(schema=name):
                schema = json.loads(
                    (ROOT / "contracts" / "v1" / name).read_text(
                        encoding="utf-8"
                    )
                )
                self.assertFalse(schema["additionalProperties"])
                self.assertEqual(
                    schema["properties"]["contract_version"],
                    {"type": "string", "const": "v1"},
                )
        monitor = json.loads(
            (
                ROOT / "contracts" / "v1" / "position-monitor.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            monitor["properties"]["cadence_seconds"]["const"],
            60,
        )
        self.assertIn(
            "STOP_LOSS_REACHED",
            monitor["$defs"]["event"]["properties"]["event_type"]["enum"],
        )
        self.assertFalse(
            monitor["$defs"]["position"]["additionalProperties"]
        )

    def test_delivery_reconciliation_contract_is_strict_v1(self) -> None:
        schema = json.loads(
            (
                ROOT
                / "contracts"
                / "v1"
                / "delivery-reconciliation.schema.json"
            ).read_text(encoding="utf-8")
        )
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(
            schema["properties"]["contract_version"],
            {"type": "string", "const": "v1"},
        )
        self.assertEqual(
            schema["properties"]["status"],
            {
                "type": "string",
                "enum": ["COMPLETED", "DEGRADED"],
            },
        )
        self.assertEqual(
            set(schema["required"]),
            {
                "contract_version",
                "status",
                "reconciled_position_event_ids",
                "suppressed_stale_position_event_ids",
                "failures",
            },
        )
        completed_rule, degraded_rule = schema["allOf"]
        self.assertEqual(
            completed_rule["then"]["properties"]["failures"]["maxItems"],
            0,
        )
        self.assertEqual(
            degraded_rule["then"]["properties"]["failures"]["minItems"],
            1,
        )


if __name__ == "__main__":
    unittest.main()
