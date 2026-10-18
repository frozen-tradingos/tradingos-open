from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def instructions() -> str:
    return (ROOT / "trading_os_v2" / "ts" / "instructions.md").read_text(
        encoding="utf-8"
    )


class TSInstructionTests(unittest.TestCase):
    def test_role_is_prediction_first_and_not_a_decision_authority(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("predicts the market path", value)
        self.assertIn("does not merely explain what already happened", value)
        self.assertIn("never decides or executes a trade", value)
        self.assertIn("A3 remains the only formal decision authority", value)

    def test_report_types_and_prior_hash_binding_are_explicit(self) -> None:
        value = instructions()
        for report_type in (
            "WEEKEND_OUTLOOK",
            "NEXT_SESSION",
            "OPENING_FORECAST",
            "OPEN_15M_CHECK",
            "OPEN_30M_CHECK",
            "INTRADAY_30_60M",
        ):
            self.assertIn(report_type, value)
        normalized = " ".join(value.split())
        self.assertIn("checks of an earlier prediction", normalized)
        self.assertIn("prior_run_id", value)
        self.assertIn("prior_forecast_hash", value)
        self.assertIn("complete immutable SPY/QQQ outlooks", normalized)
        self.assertIn("all three paths—activation, ordered stages", normalized)
        self.assertIn("Never assess a prior forecast from its hash alone", normalized)
        self.assertIn("never reset a bound continuation to `mode=NEW`", normalized)
        self.assertIn("Only when `prior_forecast` is absent", normalized)

    def test_core_gaps_fail_before_ts_but_enhancement_gaps_do_not(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("Core data is exactly the fresh SPY quote", value)
        self.assertIn("runtime must emit a fault", value)
        self.assertIn("must not stop TS from forecasting SPY and QQQ", value)
        self.assertIn("Never use a missing enhancement", value)
        self.assertIn("`evidence_assessment` exactly", value)
        self.assertIn("machine-owned fields", value)

    def test_bias_maturity_and_tradeability_are_separate(self) -> None:
        value = instructions()
        self.assertIn("path_bias", value)
        self.assertIn("evidence_maturity", value)
        self.assertIn("tradeability", value)
        self.assertIn("READY_FOR_D_REVIEW", value)
        self.assertIn("is not approval", value)

    def test_three_paths_are_probabilistic_ordered_and_verifiable(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("main`, `reverse`, and `extreme", value)
        self.assertIn("5% increments", value)
        self.assertIn("sum to 100%", value)
        self.assertIn("where price is expected to go first", value)
        self.assertIn("objective invalidation conditions", value)
        self.assertIn("Free-form or unobservable triggers are forbidden", value)
        self.assertIn("only `ONE_5M_CLOSE` or `ONE_15M_CLOSE`", value)
        self.assertIn("never use `LIVE_QUOTE`", value)
        self.assertIn("must not already satisfy every ordered stage", value)
        self.assertIn("objectively unreached future target", value)
        self.assertIn("No activation or stage condition group may imply", value)
        self.assertIn("an `ANY` invalidation must not repeat or subsume", value)

    def test_spy_qqq_and_relative_strength_are_separate(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("SPY and QQQ separate directions", value)
        self.assertIn("one `LEADER` plus one `LAGGER`", value)
        self.assertIn("evidence-time facts rather than the forward answer", value)
        self.assertIn("Separate what has already happened", value)
        self.assertIn("continuation or mean reversion", value)

    def test_news_causal_chain_keeps_verified_boundaries(self) -> None:
        value = " ".join(instructions().split())
        self.assertNotIn("ts_report_context.market_moving_news_events", value)
        self.assertNotIn("ts_report_context.scheduled_macro_events", value)
        self.assertIn("a1.health.market_moving_news_evidence", value)
        self.assertIn("runtime derives that bounded selection deterministically", value)
        self.assertIn("Ignore frozen proofs that the runtime did not select", value)
        self.assertIn("event → oil/rates/sector/risk appetite", value)
        self.assertIn("objective SPY/QQQ failure conditions", value)
        self.assertIn("never infer a different category from a substring", value)
        self.assertIn("exact `event_fingerprint`", value)
        self.assertIn("`energy`, `geopolitical_deescalation`", value)
        self.assertIn("may not be relabeled", value)
        self.assertIn("empty `causal_chains` array", value)
        self.assertIn("strict healthy v1 `a1.macro_watch`", value)
        self.assertIn("calendar entries absent from that block", value)
        self.assertIn("`kind=AMPLIFIER`", value)
        self.assertIn("`evidence_state=PARTIAL`", value)
        self.assertIn("TS_MACHINE_OWNED_CAUSAL_CLAIMS", value)
        self.assertIn("copy the supplied `transmission` and `index_effect` exactly", value)
        self.assertIn("stronger, near-consensus, and weaker outcomes", value)
        self.assertIn("Do not predict the payroll value", value)
        self.assertIn("cannot be the sole reason", value)

    def test_next_session_uses_the_machine_open_checkpoint(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("required_next_validation", value)
        self.assertIn("06:30 opening forecast", value)
        self.assertIn(
            "first judge the bound `NEXT_SESSION` forecast",
            value,
        )

    def test_manual_swing_objective_scores_future_path_without_trading(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("single-leg SPY/QQQ option with 0–15 DTE", value)
        self.assertIn("forecasting the underlying path", value)
        self.assertIn("Do not select an option", value)
        self.assertIn("turn this context into a bullish prior", value)
        self.assertIn("formal version at each scheduled slot owns", value)
        self.assertIn("must not replace, rewrite, or take credit", value)
        self.assertIn("maximum favorable and adverse excursions", value)
        self.assertIn("never inferred without a manually registered position", value)
        self.assertIn(
            "`current_pattern.summary` is strictly an evidence-time description",
            value,
        )
        self.assertIn("actual prediction in `one_line_forecast`", value)
        self.assertIn("has failed the TS role", value)

    def test_postmarket_settlement_is_separate_and_calibrated(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("Post-market result settlement is not a TS prediction report", value)
        self.assertIn("independent settlement process", value)
        self.assertIn("long-term calibration", value)
        self.assertIn("Never mix a settlement verdict", value)

    def test_a2_shadow_similarity_and_earnings_boundaries_remain(self) -> None:
        value = " ".join(instructions().split())
        self.assertIn("candidate_state", value)
        self.assertIn("actionable=false", value)
        self.assertIn("sample quality is `LOW`", value)
        self.assertIn("must not independently change `path_bias`", value)
        self.assertIn("SCHEDULE_RISK_ONLY", value)
        self.assertIn("IDs 1 through 12 exactly once", value)


if __name__ == "__main__":
    unittest.main()
