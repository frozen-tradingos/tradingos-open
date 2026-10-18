from __future__ import annotations

import unittest
from copy import deepcopy
from datetime import datetime
from zoneinfo import ZoneInfo

from trading_os_v2.common.config import load_config
from trading_os_v2.risk.service import (
    enforce_a3_final,
    enforce_d_plan,
    validate_position_management,
)


PT = ZoneInfo("America/Los_Angeles")


def evidence() -> dict:
    config = load_config()
    rules = deepcopy(config["trading_rules"])
    rules["spread_rule"] = {
        "status": "DEFINED",
        "max_relative_pct": 20,
        "max_absolute_usd": 0.5,
        "effect": "BLOCK",
    }
    candidate = {
        "side": "call",
        "expiration": "2026-07-31",
        "strike": 525,
        "bid": 2.3,
        "ask": 2.5,
        "spread_absolute": 0.2,
        "spread_pct_of_mid": 8,
    }
    return {
        "created_at": "2026-07-29T17:00:00+00:00",
        "rules": rules,
        "schedule": config["schedule"],
        "a1": {
            "health": {
                "state": "HEALTHY",
                "reliable_broad_market_news_available": True,
                "verified_market_moving_news": True,
            },
            "market_clock": {"state": "open"},
            "positions": [],
        },
        "a2": {
            "pattern_tracker": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "symbols": {
                    "SPY": {
                        "current_state": "NARROW_RANGE",
                        "last_processed_bar_time": (
                            "2026-07-29T16:55:00+00:00"
                        ),
                    }
                },
            },
            "options": {
                "SPY": {
                    "expirations": [
                        {
                            "expiration": "2026-07-31",
                            "near_atm_candidates": [candidate],
                        }
                    ]
                }
            },
            "trend_pullback": {
                "contract_version": "v1",
                "status": "HEALTHY",
                "policy": "TREND_ALIGNED_PULLBACK_ONLY",
                "trade_action": False,
                "symbols": {
                    "SPY": {
                        "data_time": "2026-07-29T16:55:00+00:00",
                        "regime": "NARROW_RANGE",
                        "context_hash": "a" * 64,
                        "call": {
                            "eligibility": True,
                            "reason": "TREND_ALIGNED_PULLBACK_CONFIRMED",
                            "evidence": ["VWAP_OPPOSING"],
                        },
                        "put": {
                            "eligibility": False,
                            "reason": "DIRECTION_MISMATCH",
                            "evidence": [],
                        },
                    }
                },
            },
        },
    }


def d_plan() -> dict:
    return {
        "role": "D",
        "action": "MANUAL_BUY",
        "score": 9,
        "underlying": "SPY",
        "option_side": "call",
        "expiration": "2026-07-31",
        "strike": 525,
        "quantity": 1,
        "max_entry_debit": 300,
        "stop_loss_pct": -40,
        "take_profit_pct": 50,
        "summary": "test",
        "entry_conditions": [],
        "invalidation": [],
        "data_gaps": [],
    }


def ts_forecast(path: str, *, tradeability: str = "READY_FOR_D_REVIEW") -> dict:
    direction = {
        "bullish": "BULLISH",
        "bearish": "BEARISH",
        "range": "RANGE",
    }.get(path, path.upper())
    return {
        "contract_version": "v2",
        "role": "TS",
        "symbol_outlooks": {
            symbol: {
                "direction": direction,
                "relative_strength": "IN_LINE",
                "summary": "测试路径",
            }
            for symbol in ("SPY", "QQQ")
        },
        "tradeability": {
            "status": tradeability,
            "reason": "测试交易性",
        },
    }


def position(
    underlying: str = "SPY",
    side: str = "call",
    expiration: str = "2026-07-31",
    strike: float = 525,
    quantity: int = 2,
) -> dict:
    return {
        "position_id": f"{underlying}-{side}-{expiration}-{strike}",
        "underlying": underlying,
        "option_side": side,
        "expiration": expiration,
        "strike": strike,
        "quantity": quantity,
        "status": "OPEN",
    }


def management_plan(action: str = "OBSERVE", **overrides: object) -> dict:
    plan = d_plan()
    plan.update(
        {
            "action": action,
            "quantity": 1,
            "max_entry_debit": 0,
            "stop_loss_pct": -40,
            "take_profit_pct": 50,
            "invalidation": ["市场结构反转"],
        }
    )
    if action == "MANUAL_EXIT":
        plan.update({"stop_loss_pct": 0, "take_profit_pct": 0, "invalidation": []})
    plan.update(overrides)
    return plan


def a3_decision(decision: str, **overrides: object) -> dict:
    result = {
        "role": "A3",
        "decision": decision,
        "score": 9,
        "underlying": "SPY",
        "option_side": "call",
        "expiration": "2026-07-31",
        "strike": 525,
        "quantity": 1,
        "max_entry_debit": 0,
        "stop_loss_pct": -40,
        "take_profit_pct": 50,
        "plain_language": "test",
        "supporting_evidence": [],
        "conflicts_resolved": [],
        "invalidation": ["市场结构反转"],
        "data_status": "HEALTHY",
    }
    if decision == "MANUAL_EXIT":
        result.update({"stop_loss_pct": 0, "take_profit_pct": 0, "invalidation": []})
    result.update(overrides)
    return result


class RiskTests(unittest.TestCase):
    def test_valid_manual_plan_passes(self) -> None:
        result, violations = enforce_d_plan(
            d_plan(),
            evidence(),
            ts_forecast("bullish"),
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(result["action"], "MANUAL_BUY")
        self.assertEqual(violations, [])

    def test_fifteen_dte_passes_and_sixteen_dte_fails_with_dynamic_limit(
        self,
    ) -> None:
        now = datetime(2026, 7, 29, 10, 0, tzinfo=PT)
        for expiration, expected_action in (
            ("2026-08-13", "MANUAL_BUY"),
            ("2026-08-14", "NO_TRADE"),
        ):
            with self.subTest(expiration=expiration):
                packet = evidence()
                expiry = packet["a2"]["options"]["SPY"]["expirations"][0]
                expiry["expiration"] = expiration
                expiry["near_atm_candidates"][0]["expiration"] = expiration
                plan = d_plan()
                plan["expiration"] = expiration

                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast("bullish"),
                    now=now,
                )

                self.assertEqual(result["action"], expected_action)
                if expected_action == "MANUAL_BUY":
                    self.assertEqual(violations, [])
                else:
                    self.assertIn("到期日在0至15天范围之外", violations)

    def test_qualified_range_pullback_passes_d_and_a3(self) -> None:
        packet = evidence()
        d_result, d_violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("range"),
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_BUY", max_entry_debit=300),
            packet,
            ts_forecast("range"),
            d_plan(),
            {"conflict_detected": False, "review_required": False},
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(d_result["action"], "MANUAL_BUY")
        self.assertEqual(d_violations, [])
        self.assertEqual(a3_result["decision"], "MANUAL_BUY")
        self.assertEqual(a3_violations, [])

    def test_range_trade_fails_closed_without_exact_a2_qualification(self) -> None:
        packets = []
        missing = evidence()
        missing["a2"].pop("trend_pullback")
        packets.append(missing)
        ineligible = evidence()
        ineligible["a2"]["trend_pullback"]["symbols"]["SPY"]["call"][
            "eligibility"
        ] = False
        packets.append(ineligible)
        wide_chop = evidence()
        wide_chop["a2"]["trend_pullback"]["symbols"]["SPY"][
            "regime"
        ] = "WIDE_CHOP"
        packets.append(wide_chop)
        bad_version = evidence()
        bad_version["a2"]["trend_pullback"]["contract_version"] = "v2"
        packets.append(bad_version)

        for packet in packets:
            with self.subTest(packet=packet):
                result, violations = enforce_d_plan(
                    d_plan(),
                    packet,
                    ts_forecast("range"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "NO_TRADE")
                self.assertTrue(violations)

    def test_uncertain_or_opposite_ts_path_blocks_new_trade(self) -> None:
        for path in ("uncertain", "bearish", "unknown"):
            with self.subTest(path=path):
                result, violations = enforce_d_plan(
                    d_plan(),
                    evidence(),
                    ts_forecast(path),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "NO_TRADE")
                self.assertTrue(
                    any("TS" in violation for violation in violations)
                )

    def test_new_trade_requires_ts_v2_and_ready_for_d_review(self) -> None:
        for output in (
            {"path": "bullish"},
            ts_forecast("bullish", tradeability="WAIT"),
            ts_forecast("bullish", tradeability="CONDITIONAL"),
        ):
            with self.subTest(output=output):
                _result, violations = enforce_d_plan(
                    d_plan(),
                    evidence(),
                    output,
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertTrue(any("TS" in item for item in violations))

    def test_directional_ts_path_cannot_bypass_a2_regime_gate(self) -> None:
        wide_chop = evidence()
        wide_chop["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "current_state"
        ] = "WIDE_CHOP"
        wide_chop["a2"]["trend_pullback"]["symbols"]["SPY"][
            "regime"
        ] = "WIDE_CHOP"

        transition = evidence()
        transition["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "current_state"
        ] = "TRANSITION"
        transition["a2"]["trend_pullback"]["symbols"]["SPY"][
            "regime"
        ] = "TRANSITION"
        transition["a2"]["trend_pullback"]["symbols"]["SPY"]["call"][
            "eligibility"
        ] = False

        bad_version = evidence()
        bad_version["a2"]["trend_pullback"]["contract_version"] = "v2"

        for packet in (wide_chop, transition, bad_version):
            with self.subTest(packet=packet):
                result, violations = enforce_d_plan(
                    d_plan(),
                    packet,
                    ts_forecast("bullish"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "NO_TRADE")
                self.assertTrue(violations)

    def test_directional_a2_regimes_must_match_side_and_ts_path(self) -> None:
        directions = {
            "TREND_UP": ("call", "bullish"),
            "V_REVERSAL_UP": ("call", "bullish"),
            "FALSE_BREAKDOWN": ("call", "bullish"),
            "TREND_DOWN": ("put", "bearish"),
            "V_REVERSAL_DOWN": ("put", "bearish"),
            "FALSE_BREAKOUT": ("put", "bearish"),
        }
        now = datetime(2026, 7, 29, 10, 0, tzinfo=PT)
        reason = "A2已确认盘型方向与TS路径或期权方向冲突"
        for regime, (expected_side, expected_path) in directions.items():
            with self.subTest(regime=regime, case="aligned"):
                packet = evidence()
                packet["a2"]["pattern_tracker"]["symbols"]["SPY"][
                    "current_state"
                ] = regime
                packet["a2"]["trend_pullback"]["symbols"]["SPY"][
                    "regime"
                ] = regime
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate["side"] = expected_side
                plan = d_plan()
                plan["option_side"] = expected_side

                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast(expected_path),
                    now=now,
                )

                self.assertEqual(result["action"], "MANUAL_BUY")
                self.assertEqual(violations, [])

            wrong_side = "put" if expected_side == "call" else "call"
            with self.subTest(regime=regime, case="wrong_side"):
                packet = evidence()
                packet["a2"]["pattern_tracker"]["symbols"]["SPY"][
                    "current_state"
                ] = regime
                packet["a2"]["trend_pullback"]["symbols"]["SPY"][
                    "regime"
                ] = regime
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate["side"] = wrong_side
                plan = d_plan()
                plan["option_side"] = wrong_side

                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast("bearish" if expected_path == "bullish" else "bullish"),
                    now=now,
                )

                self.assertEqual(result["action"], "NO_TRADE")
                self.assertIn(reason, violations)

            with self.subTest(regime=regime, case="wrong_ts"):
                packet = evidence()
                packet["a2"]["pattern_tracker"]["symbols"]["SPY"][
                    "current_state"
                ] = regime
                packet["a2"]["trend_pullback"]["symbols"]["SPY"][
                    "regime"
                ] = regime
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate["side"] = expected_side
                plan = d_plan()
                plan["option_side"] = expected_side

                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast("bearish" if expected_path == "bullish" else "bullish"),
                    now=now,
                )

                self.assertEqual(result["action"], "NO_TRADE")
                self.assertIn(reason, violations)

    def test_a2_range_proof_must_match_latest_bar_and_be_fresh(self) -> None:
        mismatched = evidence()
        mismatched["a2"]["trend_pullback"]["symbols"]["SPY"][
            "data_time"
        ] = "2026-07-29T16:50:00+00:00"

        stale = evidence()
        stale["created_at"] = "2026-07-29T17:16:00+00:00"

        future = evidence()
        future["created_at"] = "2026-07-29T16:54:00+00:00"

        for packet in (mismatched, stale, future):
            with self.subTest(packet=packet):
                result, violations = enforce_d_plan(
                    d_plan(),
                    packet,
                    ts_forecast("bullish"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "NO_TRADE")
                self.assertIn(
                    "A2顺势回撤证据时间无效或已过期",
                    violations,
                )

    def test_unset_spread_forces_no_trade(self) -> None:
        packet = evidence()
        packet["rules"]["spread_rule"]["status"] = "UNSET"
        result, violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(result["action"], "NO_TRADE")
        self.assertIn("期权价差硬阈值尚未确定", violations)

    def test_unknown_matching_regime_fails_closed_for_d_and_a3(self) -> None:
        packet = evidence()
        packet["a2"]["pattern_tracker"]["symbols"]["SPY"][
            "current_state"
        ] = "BOGUS"
        packet["a2"]["trend_pullback"]["symbols"]["SPY"]["regime"] = "BOGUS"
        now = datetime(2026, 7, 29, 10, 0, tzinfo=PT)

        d_result, d_violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=now,
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_BUY", max_entry_debit=300),
            packet,
            ts_forecast("bullish"),
            d_plan(),
            {"conflict_detected": False, "review_required": False},
            now=now,
        )

        reason = "A2盘型与顺势回撤状态不在批准枚举内"
        self.assertEqual(d_result["action"], "NO_TRADE")
        self.assertIn(reason, d_violations)
        self.assertEqual(a3_result["decision"], "NO_TRADE")
        self.assertIn(reason, a3_violations)

    def test_frozen_entry_evidence_expires_against_decision_time(self) -> None:
        packet = evidence()
        stale_now = datetime(2026, 7, 30, 10, 0, tzinfo=PT)

        d_result, d_violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=stale_now,
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_BUY", max_entry_debit=300),
            packet,
            ts_forecast("bullish"),
            d_plan(),
            {"conflict_detected": False, "review_required": False},
            now=stale_now,
        )

        reason = "A2顺势回撤证据时间无效或已过期"
        self.assertEqual(d_result["action"], "NO_TRADE")
        self.assertIn(reason, d_violations)
        self.assertEqual(a3_result["decision"], "NO_TRADE")
        self.assertIn(reason, a3_violations)

    def test_entry_check_rejects_naive_decision_time(self) -> None:
        packet = evidence()
        naive_now = datetime(2026, 7, 29, 10, 0)

        d_result, d_violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=naive_now,
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_BUY", max_entry_debit=300),
            packet,
            ts_forecast("bullish"),
            d_plan(),
            {"conflict_detected": False, "review_required": False},
            now=naive_now,
        )

        reason = "交易规则检查时间必须包含时区"
        self.assertEqual(d_result["action"], "NO_TRADE")
        self.assertIn(reason, d_violations)
        self.assertEqual(a3_result["decision"], "NO_TRADE")
        self.assertIn(reason, a3_violations)

    def test_invalid_option_quotes_fail_closed_for_d_and_a3(self) -> None:
        for bid, ask in (
            (None, 2.5),
            (0, 2.5),
            (float("nan"), 2.5),
            (2.6, 2.5),
            (2.3, float("nan")),
        ):
            with self.subTest(bid=bid, ask=ask):
                packet = evidence()
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate.update({"bid": bid, "ask": ask})
                d_result, d_violations = enforce_d_plan(
                    d_plan(),
                    packet,
                    ts_forecast("bullish"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                a3_result, a3_violations = enforce_a3_final(
                    a3_decision("MANUAL_BUY", max_entry_debit=300),
                    packet,
                    ts_forecast("bullish"),
                    d_plan(),
                    {"conflict_detected": False, "review_required": False},
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(d_result["action"], "NO_TRADE")
                self.assertIn("合约买卖报价无效", d_violations)
                self.assertEqual(a3_result["decision"], "NO_TRADE")
                self.assertIn("合约买卖报价无效", a3_violations)

    def test_spread_is_recomputed_from_bid_and_ask(self) -> None:
        packet = evidence()
        packet["rules"]["spread_rule"].update(
            {"max_relative_pct": 5, "max_absolute_usd": 0.15}
        )
        candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
            "near_atm_candidates"
        ][0]
        candidate.update(
            {
                "bid": 2.3,
                "ask": 2.5,
                "spread_absolute": 0,
                "spread_pct_of_mid": 0,
            }
        )
        d_result, d_violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_BUY", max_entry_debit=300),
            packet,
            ts_forecast("bullish"),
            d_plan(),
            {"conflict_detected": False, "review_required": False},
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(d_result["action"], "NO_TRADE")
        self.assertIn("相对买卖价差超过硬阈值", d_violations)
        self.assertIn("绝对买卖价差超过硬阈值", d_violations)
        self.assertEqual(a3_result["decision"], "NO_TRADE")
        self.assertIn("相对买卖价差超过硬阈值", a3_violations)
        self.assertIn("绝对买卖价差超过硬阈值", a3_violations)

    def test_spread_equal_to_both_limits_is_allowed(self) -> None:
        for bid, ask, budget in ((4.85, 5.0, 600), (1.95, 2.05, 300)):
            with self.subTest(bid=bid, ask=ask):
                packet = evidence()
                packet["rules"]["spread_rule"].update(
                    {"max_relative_pct": 5, "max_absolute_usd": 0.15}
                )
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate.update({"bid": bid, "ask": ask})
                plan = d_plan()
                plan["max_entry_debit"] = budget
                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast("bullish"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "MANUAL_BUY")
                self.assertEqual(violations, [])

    def test_spread_just_above_either_limit_is_rejected(self) -> None:
        for bid, ask, reason in (
            (4.84996, 5.0, "绝对买卖价差超过硬阈值"),
            (1.949999, 2.050001, "相对买卖价差超过硬阈值"),
        ):
            with self.subTest(bid=bid, ask=ask):
                packet = evidence()
                packet["rules"]["spread_rule"].update(
                    {"max_relative_pct": 5, "max_absolute_usd": 0.15}
                )
                candidate = packet["a2"]["options"]["SPY"]["expirations"][0][
                    "near_atm_candidates"
                ][0]
                candidate.update({"bid": bid, "ask": ask})
                plan = d_plan()
                plan["max_entry_debit"] = 600
                result, violations = enforce_d_plan(
                    plan,
                    packet,
                    ts_forecast("bullish"),
                    now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
                )
                self.assertEqual(result["action"], "NO_TRADE")
                self.assertIn(reason, violations)

    def test_after_cutoff_requires_verified_news(self) -> None:
        packet = evidence()
        packet["a1"]["health"]["verified_market_moving_news"] = False
        result, violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=datetime(2026, 7, 29, 10, 31, tzinfo=PT),
        )
        self.assertEqual(result["action"], "NO_TRADE")
        self.assertIn("10:30后没有经核实的重大大盘新闻", violations)

    def test_cumulative_position_budget_is_enforced(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [
            {
                "underlying": "SPY",
                "option_side": "call",
                "expiration": "2026-07-31",
                "strike": 525,
                "cumulative_cost_usd": 800,
                "status": "OPEN",
            }
        ]
        result, violations = enforce_d_plan(
            d_plan(),
            packet,
            ts_forecast("bullish"),
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(result["action"], "NO_TRADE")
        self.assertIn("加仓后本仓累计投入超过1000美元", violations)

    def test_a3_cannot_override_d_no_trade(self) -> None:
        packet = evidence()
        final = a3_decision(
            "MANUAL_BUY",
            max_entry_debit=300,
            plain_language="buy",
        )
        blocked_d = d_plan()
        blocked_d["action"] = "NO_TRADE"
        result, violations = enforce_a3_final(
            final,
            packet,
            ts_forecast("bullish"),
            blocked_d,
            {"conflict_detected": False, "review_required": False},
            now=datetime(2026, 7, 29, 10, 0, tzinfo=PT),
        )
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("D没有形成合规的人工买入方案", violations)

    def test_management_must_match_one_of_three_open_positions(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [
            position("SPY", "call", strike=525),
            position("SPY", "put", strike=520),
            position("QQQ", "call", strike=475),
        ]
        result, violations = enforce_d_plan(
            management_plan("MANUAL_REDUCE", strike=526),
            packet,
            ts_forecast("range"),
        )
        self.assertEqual(result["action"], "NO_TRADE")
        self.assertIn(
            "方案未精确匹配任何老板确认的开放持仓",
            violations,
        )

    def test_management_quantity_cannot_exceed_holding(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [position(quantity=2)]
        result, violations = enforce_d_plan(
            management_plan("MANUAL_REDUCE", quantity=3),
            packet,
            ts_forecast("range"),
        )
        self.assertEqual(result["action"], "NO_TRADE")
        self.assertIn("持仓管理数量3张超过实际持有的2张", violations)

    def test_a3_adjust_cannot_bypass_d_reduce_or_add_budget(self) -> None:
        packet = evidence()
        packet["rules"]["spread_rule"]["status"] = "UNSET"
        packet["a1"]["positions"] = [position()]
        result, violations = enforce_a3_final(
            a3_decision("MANUAL_ADJUST", max_entry_debit=100),
            packet,
            ts_forecast("range"),
            management_plan("OBSERVE"),
            {"conflict_detected": False, "review_required": False},
        )
        self.assertEqual(result["decision"], "NO_TRADE")
        self.assertIn("持仓管理不得包含新增买入预算", violations)
        self.assertIn("A3只能在D明确建议减仓时给出人工调整建议", violations)

    def test_valid_observe_reduce_and_exit_ignore_unset_new_trade_spread(self) -> None:
        packet = evidence()
        packet["rules"]["spread_rule"]["status"] = "UNSET"
        packet["a1"]["positions"] = [position()]
        for action in ("OBSERVE", "MANUAL_REDUCE", "MANUAL_EXIT"):
            with self.subTest(action=action):
                result, violations = enforce_d_plan(
                    management_plan(action),
                    packet,
                    ts_forecast("range"),
                )
                self.assertEqual(result["action"], action)
                self.assertEqual(violations, [])

    def test_d_management_requires_nonempty_invalidation(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [position()]
        reason = "持仓管理方案必须至少包含一条非空的失效条件"

        valid, valid_violations = enforce_d_plan(
            management_plan("OBSERVE", invalidation=["跌破盘中结构低点"]),
            packet,
            ts_forecast("range"),
        )
        self.assertEqual(valid["action"], "OBSERVE")
        self.assertEqual(valid_violations, [])

        for invalidation in ([], "跌破盘中结构低点", ["", "  "]):
            with self.subTest(invalidation=invalidation):
                blocked, violations = enforce_d_plan(
                    management_plan("OBSERVE", invalidation=invalidation),
                    packet,
                    ts_forecast("range"),
                )
                self.assertEqual(blocked["action"], "NO_TRADE")
                self.assertIn(reason, violations)

    def test_a3_management_requires_nonempty_invalidation(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [position()]
        review = {"conflict_detected": False, "review_required": False}
        d_output = management_plan("MANUAL_REDUCE")
        reason = "持仓管理方案必须至少包含一条非空的失效条件"

        valid, valid_violations = enforce_a3_final(
            a3_decision("MANUAL_ADJUST", invalidation=["跌破盘中结构低点"]),
            packet,
            ts_forecast("range"),
            d_output,
            review,
        )
        self.assertEqual(valid["decision"], "MANUAL_ADJUST")
        self.assertEqual(valid_violations, [])

        for invalidation in ([], "跌破盘中结构低点", ["", "  "]):
            with self.subTest(invalidation=invalidation):
                blocked, violations = enforce_a3_final(
                    a3_decision("MANUAL_ADJUST", invalidation=invalidation),
                    packet,
                    ts_forecast("range"),
                    d_output,
                    review,
                )
                self.assertEqual(blocked["decision"], "NO_TRADE")
                self.assertIn(reason, violations)

    def test_observe_without_position_is_not_management(self) -> None:
        packet = evidence()
        plan = management_plan(
            "OBSERVE",
            underlying="NONE",
            option_side="none",
            expiration="",
            strike=0,
            quantity=0,
            invalidation="not-a-list",
        )
        result, violations = enforce_d_plan(plan, packet, ts_forecast("range"))
        self.assertEqual(result["action"], "OBSERVE")
        self.assertEqual(violations, [])

    def test_manual_exit_requires_zero_stop_and_take(self) -> None:
        packet = evidence()
        packet["a1"]["positions"] = [position()]
        review = {"conflict_detected": False, "review_required": False}

        d_result, d_violations = enforce_d_plan(
            management_plan("MANUAL_EXIT", stop_loss_pct=-40),
            packet,
            ts_forecast("range"),
        )
        a3_result, a3_violations = enforce_a3_final(
            a3_decision("MANUAL_EXIT", take_profit_pct=50),
            packet,
            ts_forecast("range"),
            management_plan("MANUAL_EXIT"),
            review,
        )
        reason = "人工退出方案的止损和止盈必须都严格等于0"
        self.assertEqual(d_result["action"], "NO_TRADE")
        self.assertIn(reason, d_violations)
        self.assertEqual(a3_result["decision"], "NO_TRADE")
        self.assertIn(reason, a3_violations)

    def test_valid_a3_adjust_and_exit_match_exact_holding(self) -> None:
        packet = evidence()
        packet["rules"]["spread_rule"]["status"] = "UNSET"
        packet["a1"]["positions"] = [position()]
        review = {"conflict_detected": False, "review_required": False}

        adjusted, adjust_violations = enforce_a3_final(
            a3_decision("MANUAL_ADJUST"),
            packet,
            ts_forecast("range"),
            management_plan("MANUAL_REDUCE"),
            review,
        )
        exited, exit_violations = enforce_a3_final(
            a3_decision("MANUAL_EXIT"),
            packet,
            ts_forecast("range"),
            management_plan("MANUAL_EXIT"),
            review,
        )
        self.assertEqual(adjusted["decision"], "MANUAL_ADJUST")
        self.assertEqual(adjust_violations, [])
        self.assertEqual(exited["decision"], "MANUAL_EXIT")
        self.assertEqual(exit_violations, [])

    def test_public_match_helper_returns_exact_position(self) -> None:
        packet = evidence()
        expected = position()
        packet["a1"]["positions"] = [expected]
        matched, violations = validate_position_management(
            management_plan("OBSERVE"),
            packet,
        )
        self.assertIs(matched, expected)
        self.assertEqual(violations, [])


if __name__ == "__main__":
    unittest.main()
