from __future__ import annotations

import unittest
from pathlib import Path


class A3InstructionTests(unittest.TestCase):
    def test_review_and_final_keep_ts_v2_concepts_separate(self) -> None:
        root = Path(__file__).resolve().parents[2]
        review = (
            root / "trading_os_v2" / "a3" / "review.md"
        ).read_text(encoding="utf-8")
        final = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        for name, instructions in (("review", review), ("final", final)):
            with self.subTest(name=name):
                normalized = " ".join(instructions.split())
                lower = normalized.lower()
                self.assertIn("strict `TS_OUTPUT v2`", normalized)
                self.assertIn("three 5%-bucket", normalized)
                self.assertIn("objective triggers", normalized)
                self.assertIn("original-forecast hash binding", normalized)
                self.assertIn("`READY_FOR_D_REVIEW`", normalized)
                self.assertTrue(
                    "not approval" in lower or "never approval" in lower
                )
                self.assertIn("missing enhanced evidence", lower)
                self.assertIn("Committee", normalized)

    def test_position_adjustment_can_only_reduce_exact_holding(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        self.assertIn("pending position-monitor event", instructions)
        self.assertIn("only when D explicitly", instructions)
        self.assertIn("must never mean adding", instructions)
        self.assertIn("or reopening", instructions)
        self.assertIn("no threshold may be guessed", instructions)

    def test_confirmed_pattern_change_prioritizes_safe_exact_holding(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        self.assertIn("confirmed A2 pattern transition", instructions)
        self.assertIn("first match the transition symbol", instructions)
        self.assertIn("open holdings", instructions)
        self.assertIn("fresh and `HEALTHY`", instructions)
        self.assertIn("only its bid", instructions)
        self.assertIn("substitute mark, last", instructions)
        self.assertIn("Do not also recommend a new entry, add, or re-entry", instructions)
        self.assertIn("multiple affected holdings", instructions)
        self.assertIn("If the transition symbol has no open holding", instructions)

    def test_managed_holding_requires_supported_invalidation(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        self.assertIn("Every `OBSERVE` or `MANUAL_ADJUST` position plan", instructions)
        self.assertIn("at least one", instructions)
        self.assertIn("evidence-supported condition in `invalidation`", instructions)
        self.assertIn("instead of leaving it empty or guessing", instructions)
        self.assertIn("`MANUAL_EXIT` may leave `invalidation` empty", instructions)

    def test_entry_cutoff_is_not_mislabeled_as_direction_or_exit_signal(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("entry is blocked without claiming the TS path was invalidated", normalized)
        self.assertIn("not a bearish or bullish signal", normalized)
        self.assertIn("must never become a reason to reduce or exit", normalized)
        self.assertIn("objective invalidation supported by the frozen packet", normalized)

    def test_pending_plan_is_reviewed_even_after_event_receipt(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        self.assertIn("On every frozen cycle", instructions)
        self.assertIn("even when\n`pending_events` is empty", instructions)
        self.assertIn("`plan_status=PENDING_REVIEW`", instructions)
        self.assertIn("review D's exact management proposal", instructions)
        self.assertIn("prior `NO_TRADE` event receipt", instructions)
        self.assertIn("must not suppress this management priority", instructions)
        self.assertIn("must not become a new entry, add, or re-entry", instructions)
        self.assertIn("more than\none open holding is `PENDING_REVIEW`", instructions)

    def test_degraded_reliable_news_does_not_become_a_hard_block(self) -> None:
        root = Path(__file__).resolve().parents[2]
        instructions = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        normalized = " ".join(instructions.split())
        self.assertIn("`DEGRADED` alone does not block", normalized)
        self.assertIn("reliable broad-market news remains available", normalized)
        self.assertIn("failed BLS feed is a data gap", normalized)
        self.assertIn("not an independent `NO_TRADE` rule", normalized)

    def test_range_gate_and_shadow_boundaries_apply_to_review_and_final(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        review = (
            root / "trading_os_v2" / "a3" / "review.md"
        ).read_text(encoding="utf-8")
        final = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")

        for name, instructions in (("review", review), ("final", final)):
            with self.subTest(name=name):
                normalized = " ".join(instructions.split())
                self.assertIn("`WIDE_CHOP` is a hard rejection", normalized)
                self.assertIn("`NARROW_RANGE` or `TRANSITION`", normalized)
                self.assertIn("healthy v1 `a2.trend_pullback`", normalized)
                self.assertIn("exact underlying and Call/Put side", normalized)
                self.assertIn("`eligibility=true`", normalized)
                self.assertIn(
                    "VWAP is one supporting or opposing observation only",
                    normalized,
                )
                self.assertIn("neither reject nor approve", normalized)
                self.assertIn("`mode=SHADOW`", normalized)
                self.assertIn("`actionable=false`", normalized)

        normalized_review = " ".join(review.split())
        self.assertIn(
            "It must not affect whether a conflict exists",
            normalized_review,
        )
        normalized_final = " ".join(final.split())
        self.assertIn("It must never affect conflict resolution", normalized_final)
        self.assertIn("the final decision, score", normalized_final)

    def test_earnings_watch_cannot_be_upgraded_and_gap_risk_is_explicit(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        review = (
            root / "trading_os_v2" / "a3" / "review.md"
        ).read_text(encoding="utf-8")
        final = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        normalized_review = " ".join(review.split())
        normalized_final = " ".join(final.split())

        for name, instructions in (
            ("review", normalized_review),
            ("final", normalized_final),
        ):
            with self.subTest(name=name):
                self.assertIn("healthy v1 `a1.earnings_watch`", instructions)
                self.assertIn("`actionable=false`", instructions)
                self.assertIn("read-only schedule", instructions)
                self.assertIn("not released results", instructions)
                self.assertIn("Never infer an actual result", instructions)
                self.assertIn("`UNVERIFIED_CANDIDATE`", instructions)

        self.assertIn("cannot support `MANUAL_BUY`", normalized_review)
        self.assertIn("earnings-risk `OBSERVE` or `NO_TRADE`", normalized_review)
        self.assertIn(
            "must never upgrade an earnings-risk `OBSERVE` or `NO_TRADE`",
            normalized_final,
        )
        self.assertIn("market-moving-news exception after 10:30", normalized_final)
        self.assertIn("overnight gap may pass the stop", normalized_final)
        self.assertIn("loss may reach the full premium", normalized_final)
        self.assertIn("not a guaranteed loss cap", normalized_final)

    def test_earnings_day_context_is_read_only_and_final_covers_every_event(
        self,
    ) -> None:
        root = Path(__file__).resolve().parents[2]
        review = (
            root / "trading_os_v2" / "a3" / "review.md"
        ).read_text(encoding="utf-8")
        final = (
            root / "trading_os_v2" / "a3" / "final.md"
        ).read_text(encoding="utf-8")
        normalized_review = " ".join(review.split())
        normalized_final = " ".join(final.split())

        for name, instructions in (
            ("review", normalized_review),
            ("final", normalized_final),
        ):
            with self.subTest(name=name):
                self.assertIn(
                    "v1 `SUPPLEMENTAL_CONTEXT.earnings_day_context`",
                    instructions,
                )
                self.assertIn("accepted Sunday bulletin", instructions)
                self.assertIn("current rolling watch", instructions)
                self.assertIn("`actionable=false`", instructions)
                self.assertIn("`SCHEDULE_RISK_ONLY`", instructions)
                self.assertIn("cannot prove a release", instructions)
                self.assertIn("context itself may not", instructions)

        self.assertIn("Inspect every candidate exactly once", normalized_final)
        self.assertIn("one `earnings_day_coverage` item", normalized_final)
        self.assertIn("exact `event_id` and `symbol`", normalized_final)
        self.assertIn("current post-release evidence", normalized_final)
        self.assertIn(
            "Omit `earnings_day_coverage` when the context is absent",
            normalized_final,
        )


if __name__ == "__main__":
    unittest.main()
