from __future__ import annotations

import unittest
from pathlib import Path


class CommitteeInstructionTests(unittest.TestCase):
    def test_deterministic_momentum_is_observation_only(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "committee" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("a2.momentum_monitor", instructions)
        self.assertIn("not as a final judgment", instructions)
        self.assertIn("a2.pattern_tracker.symbols.*.current_state", instructions)
        self.assertIn("Ignore `candidate_state`", instructions)
        self.assertIn("not a final judgment or a direct trade rule", instructions)
        self.assertIn(
            "Raw news and the earnings calendar are A1-only",
            normalized,
        )
        self.assertIn(
            "`a1.health.market_moving_news_evidence`",
            instructions,
        )

    def test_earnings_watch_is_never_capital_flow_evidence(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "committee" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())

        self.assertIn("healthy v1 `a1.earnings_watch`", normalized)
        self.assertIn("`actionable=false`", normalized)
        self.assertIn("read-only schedule of unverified candidates", normalized)
        self.assertIn("not capital-flow evidence", normalized)
        self.assertIn("must not change the direction, strength", normalized)
        self.assertIn("Never infer released results", normalized)
        self.assertIn("only as scheduled gap/event risk", normalized)
        self.assertIn("unknown-version watch evidence", normalized)

    def test_earnings_day_context_is_visible_but_never_flow_evidence(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "committee" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())

        self.assertIn(
            "v1 `SUPPLEMENTAL_CONTEXT.earnings_day_context`",
            normalized,
        )
        self.assertIn("accepted Sunday bulletin", normalized)
        self.assertIn("inspect every listed candidate", normalized)
        self.assertIn("`actionable=false`", normalized)
        self.assertIn("`SCHEDULE_RISK_ONLY`", normalized)
        self.assertIn("not evidence of capital entering", normalized)
        self.assertIn(
            "Do not substitute the current rolling watch",
            normalized,
        )
        self.assertIn("context itself may not", normalized)


if __name__ == "__main__":
    unittest.main()
