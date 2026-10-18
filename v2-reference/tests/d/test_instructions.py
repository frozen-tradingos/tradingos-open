from __future__ import annotations

import unittest
from pathlib import Path


class DInstructionTests(unittest.TestCase):
    def test_existing_position_management_is_exact_and_never_adds(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        self.assertIn("pending position-monitor", instructions)
        self.assertIn("Never use `MANUAL_BUY`", instructions)
        self.assertIn("no greater than the confirmed quantity", instructions)
        self.assertIn("Set `max_entry_debit` to zero", instructions)

    def test_pattern_transition_prioritizes_safe_position_management(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("latest v1 `position_monitor`", normalized)
        self.assertIn("evaluate that affected position before", normalized)
        self.assertIn("uniquely identifies one exact affected contract", normalized)
        self.assertIn("use bid-only return evidence", normalized)
        self.assertIn("one output cannot safely cover multiple", normalized)
        self.assertIn("`quote_status` is not `HEALTHY`", normalized)
        self.assertIn("choose `NO_TRADE`", normalized)
        self.assertIn("Never guess", normalized)
        self.assertIn("no owner-confirmed open position", normalized)

    def test_pending_review_and_invalidation_are_hard_management_gates(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("every frozen cycle", normalized)
        self.assertIn("independently of `pending_events`", normalized)
        self.assertIn("`plan_status=PENDING_REVIEW`", normalized)
        self.assertIn("earlier `NO_TRADE` receipt", normalized)
        self.assertIn("when exactly one such holding", normalized)
        self.assertIn("if several remain, choose `NO_TRADE`", normalized)
        self.assertIn("at least one non-empty invalidation", normalized)
        self.assertIn("directly supported by the frozen evidence", normalized)
        self.assertIn("`MANUAL_EXIT` may leave invalidation empty", normalized)

    def test_degraded_reliable_news_does_not_become_a_hard_block(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("`DEGRADED` alone does not block", normalized)
        self.assertIn("reliable broad-market news remains available", normalized)
        self.assertIn("failed BLS feed is a data gap", normalized)
        self.assertIn("not an independent `NO_TRADE` rule", normalized)

    def test_range_entry_requires_exact_a2_proof_and_shadow_is_ignored(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("`WIDE_CHOP` remains a hard no-new-trade", normalized)
        self.assertIn("`a2.trend_pullback`", normalized)
        self.assertIn("`eligibility=true`", normalized)
        self.assertIn(
            "`reason=TREND_ALIGNED_PULLBACK_CONFIRMED`",
            normalized,
        )
        self.assertIn("VWAP is supporting/opposing evidence only", normalized)
        self.assertIn("`a2.half_hour_forecast`", normalized)
        self.assertIn("uncalibrated `SHADOW`", normalized)

    def test_d_consumes_ts_v2_without_turning_readiness_into_approval(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("strict `TS_OUTPUT v2`", normalized)
        self.assertIn("`symbol_outlooks.SPY.direction`", normalized)
        self.assertIn("never substitute the global `path_bias`", normalized)
        self.assertIn("`tradeability=READY_FOR_D_REVIEW`", normalized)
        self.assertIn("it is not approval", normalized)
        self.assertIn("`WAIT` or `CONDITIONAL` cannot support", normalized)
        self.assertIn("Missing enhanced evidence", normalized)
        self.assertIn("three scenario probabilities", normalized)
        self.assertIn("hash-bound original forecast", normalized)

    def test_expiration_covers_ts_horizon_without_denying_theta(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("0 through 15 DTE", normalized)
        self.assertIn("frozen TS path, targets, and time-bound invalidation", normalized)
        self.assertIn("choose `NO_TRADE` instead of inventing one", normalized)
        self.assertIn("never eliminates theta decay", normalized)

    def test_entry_cutoff_is_not_mislabeled_as_path_failure_or_exit(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("blocks only a new entry while the TS path remains valid", normalized)
        self.assertIn("is not evidence that the forecast direction failed", normalized)
        self.assertIn("cutoff alone must never cause `MANUAL_REDUCE`", normalized)
        self.assertIn("supported objective invalidation", normalized)

    def test_earnings_watch_cannot_support_a_new_entry_or_news_exception(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())

        self.assertIn("healthy v1 `a1.earnings_watch`", normalized)
        self.assertIn("`actionable=false`", normalized)
        self.assertIn("unverified/pre-release", normalized)
        self.assertIn("default to `OBSERVE` or `NO_TRADE`", normalized)
        self.assertIn("must never support `MANUAL_BUY`", normalized)
        self.assertIn("raise the score, select Call/Put", normalized)
        self.assertIn("gap may pass the stop", normalized)
        self.assertIn("full premium remains at risk", normalized)
        self.assertIn("is not that news exception", normalized)

    def test_frozen_earnings_day_context_is_read_only_schedule_risk(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "d" / "instructions.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())

        self.assertIn(
            "v1 `SUPPLEMENTAL_CONTEXT.earnings_day_context`",
            normalized,
        )
        self.assertIn("accepted Sunday bulletin", normalized)
        self.assertIn("Inspect every candidate", normalized)
        self.assertIn(
            "do not substitute the current rolling watch",
            normalized,
        )
        self.assertIn("`actionable=false`", normalized)
        self.assertIn("`SCHEDULE_RISK_ONLY`", normalized)
        self.assertIn("cannot support `MANUAL_BUY`", normalized)
        self.assertIn("prove that results were released", normalized)
        self.assertIn("separately verified release", normalized)
        self.assertIn("context itself may not", normalized)


if __name__ == "__main__":
    unittest.main()
