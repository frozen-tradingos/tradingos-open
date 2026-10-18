from __future__ import annotations

from copy import deepcopy
import unittest

from trading_os_v2.agent_runtime.service import (
    AgentFailure,
    ROLE_FILES,
    TS_SCHEDULED_INDEX_EFFECT,
    TS_SCHEDULED_TRANSMISSION,
    _ts_machine_causal_claims,
    _verify_agent_output,
)
from trading_os_v2.common.io import sha256_json


def condition(value: float, operator: str = "AT_OR_ABOVE") -> dict:
    return {
        "symbol": "SPY",
        "metric": "LAST_PRICE",
        "operator": operator,
        "value": value,
        "upper_value": None,
        "confirmation": "ONE_5M_CLOSE",
    }


def scenario(probability: int, bias: str, value: float) -> dict:
    step = -1 if bias == "BEARISH" else 1
    operator = "AT_OR_BELOW" if bias == "BEARISH" else "AT_OR_ABOVE"
    invalidation_operator = (
        "AT_OR_ABOVE" if bias == "BEARISH" else "AT_OR_BELOW"
    )
    return {
        "bias": bias,
        "probability_pct": probability,
        "summary": "未来路径",
        "activation": {
            "logic": "ALL",
            "conditions": [condition(value, operator)],
        },
        "sequence": [
            {
                "order": 1,
                "label": "先到",
                "conditions": [condition(value + step, operator)],
            },
            {
                "order": 2,
                "label": "再到",
                "conditions": [condition(value + 2 * step, operator)],
            },
        ],
        "invalidation": {
            "logic": "ALL",
            "conditions": [condition(value - step, invalidation_operator)],
        },
    }


def context(*, report_type: str = "OPENING_FORECAST") -> dict:
    snapshot = {
        "run_id": "20260803T133000Z-aaaaaaaaaa",
        "packet_hash": "b" * 64,
        "analysis_freshness_hash": "c" * 64,
        "release_commit": "d" * 40,
        "market_time": {
            "timezone": "America/Los_Angeles",
            "observed_at": "2026-08-03T06:30:00-07:00",
            "market_date": "2026-08-03",
            "state": "OPEN",
        },
    }
    update = {
        "mode": "NEW",
        "prior_run_id": None,
        "prior_forecast_hash": None,
    }
    if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
        update = {
            "mode": "CHECK",
            "prior_run_id": "20260803T133000Z-eeeeeeeeee",
            "prior_forecast_hash": "f" * 64,
        }
    evidence_assessment = {
        "core_status": "READY",
        "core_sources": [
            "SPY_QUOTE",
            "QQQ_QUOTE",
            "MARKET_CLOCK",
            "A2_STRUCTURE",
        ],
        "core_gaps": [],
        "enhanced_available": ["OPTIONS_POSITIONING"],
        "enhanced_missing": [
            "MARKET_MOVING_NEWS",
            "MACRO_SCHEDULE",
            "OIL_CONTEXT",
            "RATES_CONTEXT",
            "SECTOR_BREADTH",
            "A2_HISTORICAL_SIMILARITY",
            "OVERNIGHT_FUTURES",
        ],
        "enhancement_gap_effect": "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY",
    }
    report_context = {
        "report_type": report_type,
        "evidence_snapshot": snapshot,
        "forecast_window": {
            "horizon": "OPEN_TO_60_MINUTES",
            "start_at": "2026-08-03T06:30:00-07:00",
            "end_at": "2026-08-03T07:30:00-07:00",
            "end_condition": "AT_TIMESTAMP",
        },
        "forecast_update": update,
        "evidence_assessment": evidence_assessment,
    }
    return report_context


def ts_output(*, report_type: str = "OPENING_FORECAST") -> tuple[dict, dict]:
    report_context = context(report_type=report_type)
    value = {
        "contract_version": "v2",
        "role": "TS",
        **{
            key: deepcopy(value)
            for key, value in report_context.items()
            if key not in {"forecast_update", "required_next_validation"}
        },
        "forecast_update": {
            **deepcopy(report_context["forecast_update"]),
            "prior_status": (
                "PARTIAL"
                if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}
                else "NOT_APPLICABLE"
            ),
            "change_summary": "原路径部分成立" if "CHECK" in report_type else "新预测",
        },
        "current_pattern": {"regime": "TREND_UP", "summary": "上升趋势"},
        "one_line_forecast": "先回踩再向上测试压力",
        "path_bias": "BULLISH",
        "symbol_outlooks": {
            "SPY": {
                "direction": "BULLISH",
                "relative_strength": "LAGGER",
                "summary": "跟随上涨",
            },
            "QQQ": {
                "direction": "BULLISH",
                "relative_strength": "LEADER",
                "summary": "科技领涨",
            },
        },
        "evidence_maturity": {"level": "MEDIUM", "reason": "核心数据完整"},
        "tradeability": {"status": "CONDITIONAL", "reason": "等待触发"},
        "scenarios": {
            "main": scenario(60, "BULLISH", 100),
            "reverse": scenario(25, "BEARISH", 95),
            "extreme": scenario(15, "BULLISH", 110),
        },
        "causal_chains": [],
        "key_levels": [
            {"symbol": "SPY", "label": "支撑", "value": 100, "basis": "价格"},
            {"symbol": "QQQ", "label": "支撑", "value": 200, "basis": "价格"},
        ],
        "next_validation": deepcopy(
            report_context.get(
                "required_next_validation",
                {
                    "at": "2026-08-03T06:45:00-07:00",
                    "checkpoint": "OPEN_15M",
                    "purpose": "验证主路径",
                },
            )
        ),
        "most_likely_mistake": "追逐第一根反抽",
        "historical_similarity_context": {
            "used": False,
            "sample_quality": "UNAVAILABLE",
            "summary": "未使用",
        },
        "hypotheses": [
            {"id": index, "assessment": "neutral", "reason": "证据中性"}
            for index in range(1, 13)
        ],
        "data_gaps": [],
    }
    return value, report_context


def verified_news_event(
    *,
    fingerprint: str,
    category: str,
    published_at: str = "2026-08-03T12:00:00+00:00",
    headline: str | None = None,
    source: str = "Federal Reserve",
    verification_rule: str = "OFFICIAL_SINGLE_SOURCE",
) -> dict:
    return {
        "event_fingerprint": fingerprint,
        "category": category,
        "headline": headline or f"Verified {category} market event",
        "source": source,
        "published_at": published_at,
        "verification_rule": verification_rule,
    }


def scheduled_macro_event(
    *,
    fingerprint: str,
    scheduled_at: str = "2026-08-04T05:30:00-07:00",
) -> dict:
    return {
        "event_fingerprint": fingerprint,
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled_at,
        "market_impact_status": "SCHEDULED_UNRELEASED",
        "result_status": "UNKNOWN",
        "source": "BLS Official Release Calendar",
        "source_url": "https://www.bls.gov/schedule/news_release/bls.ics",
        "confidence": "official_schedule",
    }


def verified_macro_result(
    *,
    market_date: str = "2026-08-03",
    generated_at: str = "2026-08-03T06:29:00-07:00",
    scheduled_at: str = "2026-08-03T05:30:00-07:00",
    published_at: str = "2026-08-03T05:30:00-07:00",
) -> dict:
    schedule_identity = {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled_at,
        "source": "BLS Official Release Calendar",
    }
    result = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": "VERIFIED",
        "generated_at": generated_at,
        "timezone": "America/Los_Angeles",
        "market_date": market_date,
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": sha256_json(schedule_identity),
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled_at,
        "published_at": published_at,
        "source": "BLS",
        "source_url": "https://www.bls.gov/news.release/empsit.nr0.htm",
        "raw_item_hash": "a" * 64,
        "confidence": "official_result",
        "metrics": [
            {
                "name": "PAYROLL_EMPLOYMENT_CHANGE",
                "value": 128000,
                "unit": "JOBS",
                "period": "2026-07",
                "preliminary": True,
            },
            {
                "name": "UNEMPLOYMENT_RATE",
                "value": 4.2,
                "unit": "PERCENT",
                "period": "2026-07",
                "preliminary": False,
            },
            {
                "name": "AVERAGE_HOURLY_EARNINGS_CHANGE",
                "value": 0.3,
                "unit": "USD",
                "period": "2026-07",
                "preliminary": False,
            },
        ],
        "result_hash": "",
    }
    result["result_hash"] = sha256_json(
        {
            key: value
            for key, value in result.items()
            if key not in {"generated_at", "result_hash"}
        }
    )
    return result


def frozen_evidence(
    *,
    news: list[dict] | None = None,
    scheduled: list[dict] | None = None,
    results: list[dict] | None = None,
    created_at: str = "2026-08-03T06:30:00-07:00",
) -> dict:
    health = {"verified_market_moving_news": bool(news)}
    if news is not None:
        health["market_moving_news_evidence"] = deepcopy(news)
    a1 = {"health": health}
    if scheduled is not None:
        a1["macro_watch"] = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "status": "HEALTHY",
            "events": deepcopy(scheduled),
        }
    if results is not None:
        a1["macro_results"] = deepcopy(results)
    frozen = {"a1": a1}
    if results:
        frozen["created_at"] = created_at
    return frozen


def add_macro_result_chain(
    value: dict,
    report_context: dict,
    result: dict,
) -> dict:
    frozen = frozen_evidence(results=[result])
    claim = _ts_machine_causal_claims(frozen, report_context)[0]
    for assessment in (
        value["evidence_assessment"],
        report_context["evidence_assessment"],
    ):
        assessment["enhanced_available"].append("MARKET_MOVING_NEWS")
        assessment["enhanced_missing"].remove("MARKET_MOVING_NEWS")
    value["causal_chains"].append(
        {
            **claim,
            "kind": "CATALYST",
            "channels": ["RATES", "RISK_APPETITE"],
            "transmission": "实际数据经利率与风险偏好传导",
            "index_effect": "影响SPY与QQQ",
            "failure_conditions": deepcopy(
                value["scenarios"]["main"]["invalidation"]
            ),
        }
    )
    return frozen


def add_verified_chain(
    value: dict,
    report_context: dict,
    *,
    fingerprint: str,
    category: str,
) -> dict:
    event = verified_news_event(
        fingerprint=fingerprint,
        category=category,
    )
    for assessment in (
        value["evidence_assessment"],
        report_context["evidence_assessment"],
    ):
        if "MARKET_MOVING_NEWS" not in assessment["enhanced_available"]:
            assessment["enhanced_available"].append("MARKET_MOVING_NEWS")
            assessment["enhanced_missing"].remove("MARKET_MOVING_NEWS")
        if (
            category == "energy"
            and "OIL_CONTEXT" not in assessment["enhanced_available"]
        ):
            assessment["enhanced_available"].append("OIL_CONTEXT")
            assessment["enhanced_missing"].remove("OIL_CONTEXT")
    value["causal_chains"].append(
        {
            "kind": "CATALYST",
            "event_fingerprint": fingerprint,
            "event_category": category,
            "event": (
                "官方单源核验｜来源：Federal Reserve｜"
                f"{event['headline']}"
            ),
            "evidence_state": "VERIFIED",
            "channels": ["OIL" if category == "energy" else "RISK_APPETITE"],
            "transmission": "通过风险偏好传导",
            "index_effect": "影响SPY与QQQ",
            "failure_conditions": deepcopy(
                value["scenarios"]["main"]["invalidation"]
            ),
        }
    )
    return event


def add_scheduled_macro_chain(
    value: dict,
    report_context: dict,
    *,
    fingerprint: str,
) -> dict:
    event = scheduled_macro_event(fingerprint=fingerprint)
    required_validation = {
        "at": "2026-08-04T06:30:00-07:00",
        "checkpoint": "OPEN",
        "purpose": "验证次日主路径并生成06:30开盘预测",
    }
    report_context["required_next_validation"] = deepcopy(
        required_validation
    )
    value["next_validation"] = deepcopy(required_validation)
    for assessment in (
        value["evidence_assessment"],
        report_context["evidence_assessment"],
    ):
        for source in ("MACRO_SCHEDULE", "RATES_CONTEXT"):
            if source not in assessment["enhanced_available"]:
                assessment["enhanced_available"].append(source)
                assessment["enhanced_missing"].remove(source)
    value["causal_chains"].append(
        {
            "kind": "AMPLIFIER",
            "event_fingerprint": fingerprint,
            "event_category": "employment",
            "event": (
                "未发布/结果未知｜Employment Situation｜"
                "2026-08-04T05:30:00-07:00"
            ),
            "evidence_state": "PARTIAL",
            "channels": ["RATES", "RISK_APPETITE"],
            "transmission": TS_SCHEDULED_TRANSMISSION,
            "index_effect": TS_SCHEDULED_INDEX_EFFECT,
            "failure_conditions": deepcopy(
                value["scenarios"]["main"]["invalidation"]
            ),
        }
    )
    return event


class TSOutputV2RuntimeTests(unittest.TestCase):
    def test_ts_runtime_uses_only_v2_schema(self) -> None:
        self.assertEqual(ROLE_FILES["TS"][1].parts[-2:], ("v2", "ts-output.schema.json"))

    def test_valid_ts_v2_preserves_context_and_semantics(self) -> None:
        value, report_context = ts_output()
        _verify_agent_output(
            value,
            "TS",
            evidence={"a1": {"health": {"verified_market_moving_news": False}}},
            supplemental={"ts_report_context": report_context},
        )

    def test_provider_schema_compilation_keeps_local_uniqueness_checks(self) -> None:
        value, report_context = ts_output()
        for assessment in (
            value["evidence_assessment"],
            report_context["evidence_assessment"],
        ):
            assessment["enhanced_available"].append("OPTIONS_POSITIONING")
        with self.assertRaisesRegex(AgentFailure, "evidence classification"):
            _verify_agent_output(
                value,
                "TS",
                evidence={"a1": {"health": {"verified_market_moving_news": False}}},
                supplemental={"ts_report_context": report_context},
            )

        value, report_context = ts_output()
        event = add_verified_chain(
            value,
            report_context,
            fingerprint="a" * 64,
            category="energy",
        )
        value["causal_chains"][0]["channels"].append("OIL")
        with self.assertRaisesRegex(AgentFailure, "causal chain channels"):
            _verify_agent_output(
                value,
                "TS",
                evidence=frozen_evidence(news=[event]),
                supplemental={"ts_report_context": report_context},
            )

    def test_open_checks_require_original_hash_binding(self) -> None:
        value, report_context = ts_output(report_type="OPEN_15M_CHECK")
        value["forecast_update"]["prior_forecast_hash"] = None
        report_context["forecast_update"]["prior_forecast_hash"] = None
        with self.assertRaisesRegex(AgentFailure, "original forecast"):
            _verify_agent_output(
                value,
                "TS",
                evidence={"a1": {"health": {"verified_market_moving_news": False}}},
                supplemental={"ts_report_context": report_context},
            )

    def test_probabilities_and_relative_strength_fail_closed(self) -> None:
        mutations = (
            lambda value: value["scenarios"]["main"].update(
                {"probability_pct": 55}
            ),
            lambda value: value["symbol_outlooks"]["SPY"].update(
                {"relative_strength": "LEADER"}
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaises(AgentFailure):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {"health": {"verified_market_moving_news": False}}
                        },
                        supplemental={"ts_report_context": report_context},
                    )

    def test_path_bias_cannot_oppose_both_symbol_outlooks(self) -> None:
        for path_bias, direction in (
            ("BULLISH", "BEARISH"),
            ("BEARISH", "BULLISH"),
        ):
            with self.subTest(path_bias=path_bias):
                value, report_context = ts_output()
                value["path_bias"] = path_bias
                value["scenarios"]["main"]["bias"] = path_bias
                for outlook in value["symbol_outlooks"].values():
                    outlook["direction"] = direction
                with self.assertRaisesRegex(AgentFailure, "symbol outlooks"):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

    def test_scenario_paths_and_stages_must_be_distinct(self) -> None:
        mutations = (
            lambda value: value["scenarios"]["main"]["sequence"][1].update(
                {
                    "conditions": deepcopy(
                        value["scenarios"]["main"]["sequence"][0][
                            "conditions"
                        ]
                    )
                }
            ),
            lambda value: value["scenarios"].update(
                {
                    "reverse": {
                        **deepcopy(value["scenarios"]["main"]),
                        "probability_pct": 25,
                    }
                }
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaisesRegex(AgentFailure, "duplicate"):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

    def test_scenario_conditions_must_be_replayable_and_coherent(self) -> None:
        mutations = (
            (
                "LIVE_QUOTE",
                lambda value: value["scenarios"]["main"]["activation"][
                    "conditions"
                ][0].update({"confirmation": "LIVE_QUOTE"}),
            ),
            (
                "Invalid TS v2 objective condition values",
                lambda value: value["scenarios"]["main"]["activation"][
                    "conditions"
                ][0].update({"confirmation": "ONE_30M_CLOSE"}),
            ),
            (
                "activates and invalidates",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": deepcopy(
                            value["scenarios"]["main"]["activation"]
                        )
                    }
                ),
            ),
            (
                "also its invalidation",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ALL",
                            "conditions": deepcopy(
                                value["scenarios"]["main"]["sequence"][0][
                                    "conditions"
                                ]
                            ),
                        }
                    }
                ),
            ),
            (
                "do not progress",
                lambda value: value["scenarios"]["main"]["sequence"][1][
                    "conditions"
                ][0].update({"value": 100.5}),
            ),
            (
                "contradicts its ordered targets",
                lambda value: value["scenarios"]["reverse"].update(
                    {"bias": "BULLISH"}
                ),
            ),
        )
        for message, mutate in mutations:
            with self.subTest(message=message):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaisesRegex(AgentFailure, message):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

    def test_any_invalidation_cannot_overlap_activation_or_stage(self) -> None:
        mutations = (
            (
                "activates and invalidates",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ANY",
                            "conditions": deepcopy(
                                value["scenarios"]["main"]["activation"][
                                    "conditions"
                                ]
                            ),
                        }
                    }
                ),
            ),
            (
                "also its invalidation",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ANY",
                            "conditions": deepcopy(
                                value["scenarios"]["main"]["sequence"][0][
                                    "conditions"
                                ]
                            ),
                        }
                    }
                ),
            ),
            (
                "activates and invalidates",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ANY",
                            "conditions": [condition(99, "AT_OR_ABOVE")],
                        }
                    }
                ),
            ),
        )
        for message, mutate in mutations:
            with self.subTest(message=message):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaisesRegex(AgentFailure, message):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

        value, report_context = ts_output()
        value["scenarios"]["main"]["invalidation"]["logic"] = "ANY"
        _verify_agent_output(
            value,
            "TS",
            evidence={
                "a1": {"health": {"verified_market_moving_news": False}}
            },
            supplemental={"ts_report_context": report_context},
        )

    def test_all_invalidation_cannot_be_implied_by_activation_or_stage(
        self,
    ) -> None:
        mutations = (
            (
                "activates and invalidates",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ALL",
                            "conditions": [condition(99, "AT_OR_ABOVE")],
                        }
                    }
                ),
            ),
            (
                "also its invalidation",
                lambda value: value["scenarios"]["main"].update(
                    {
                        "invalidation": {
                            "logic": "ALL",
                            "conditions": [condition(101, "AT_OR_ABOVE")],
                        }
                    }
                ),
            ),
        )
        for message, mutate in mutations:
            with self.subTest(message=message):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaisesRegex(AgentFailure, message):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

        value, report_context = ts_output()
        qqq_condition = condition(200, "AT_OR_ABOVE")
        qqq_condition["symbol"] = "QQQ"
        value["scenarios"]["main"]["invalidation"] = {
            "logic": "ALL",
            "conditions": [
                condition(99, "AT_OR_ABOVE"),
                qqq_condition,
            ],
        }
        _verify_agent_output(
            value,
            "TS",
            evidence={
                "a1": {"health": {"verified_market_moving_news": False}}
            },
            supplemental={"ts_report_context": report_context},
        )

    def test_any_invalidation_cannot_cover_a_condition_group(self) -> None:
        def between(lower: float, upper: float) -> dict:
            value = condition(lower, "BETWEEN")
            value["upper_value"] = upper
            return value

        mutations = (
            (
                "activates and invalidates",
                lambda value: (
                    value["scenarios"]["main"]["activation"].update(
                        {
                            "logic": "ALL",
                            "conditions": [
                                condition(100, "AT_OR_ABOVE"),
                                condition(110, "AT_OR_BELOW"),
                            ],
                        }
                    ),
                    value["scenarios"]["main"].update(
                        {
                            "invalidation": {
                                "logic": "ANY",
                                "conditions": [between(100, 110)],
                            }
                        }
                    ),
                ),
            ),
            (
                "activates and invalidates",
                lambda value: (
                    value["scenarios"]["main"]["activation"].update(
                        {"logic": "ALL", "conditions": [between(100, 110)]}
                    ),
                    value["scenarios"]["main"].update(
                        {
                            "invalidation": {
                                "logic": "ANY",
                                "conditions": [
                                    condition(105, "AT_OR_BELOW"),
                                    condition(105, "ABOVE"),
                                ],
                            }
                        }
                    ),
                ),
            ),
            (
                "also its invalidation",
                lambda value: (
                    value["scenarios"]["main"]["sequence"][0].update(
                        {
                            "conditions": [
                                condition(101, "AT_OR_ABOVE"),
                                condition(111, "AT_OR_BELOW"),
                            ]
                        }
                    ),
                    value["scenarios"]["main"].update(
                        {
                            "invalidation": {
                                "logic": "ANY",
                                "conditions": [between(101, 111)],
                            }
                        }
                    ),
                ),
            ),
        )
        for message, mutate in mutations:
            with self.subTest(message=message):
                value, report_context = ts_output()
                mutate(value)
                with self.assertRaisesRegex(AgentFailure, message):
                    _verify_agent_output(
                        value,
                        "TS",
                        evidence={
                            "a1": {
                                "health": {
                                    "verified_market_moving_news": False
                                }
                            }
                        },
                        supplemental={"ts_report_context": report_context},
                    )

        value, report_context = ts_output()
        value["scenarios"]["main"]["activation"] = {
            "logic": "ALL",
            "conditions": [between(100, 110)],
        }
        value["scenarios"]["main"]["invalidation"] = {
            "logic": "ANY",
            "conditions": [
                condition(104, "AT_OR_BELOW"),
                condition(106, "ABOVE"),
            ],
        }
        _verify_agent_output(
            value,
            "TS",
            evidence={
                "a1": {"health": {"verified_market_moving_news": False}}
            },
            supplemental={"ts_report_context": report_context},
        )

    def test_multi_symbol_stage_direction_is_checked_when_comparable(
        self,
    ) -> None:
        def paired(operator: str, spy: float, qqq: float) -> list[dict]:
            qqq_condition = condition(qqq, operator)
            qqq_condition["symbol"] = "QQQ"
            return [condition(spy, operator), qqq_condition]

        value, report_context = ts_output()
        value["scenarios"]["main"]["sequence"][0]["conditions"] = paired(
            "AT_OR_BELOW", 99, 199
        )
        value["scenarios"]["main"]["sequence"][1]["conditions"] = paired(
            "AT_OR_BELOW", 98, 198
        )
        value["scenarios"]["main"]["invalidation"] = {
            "logic": "ALL",
            "conditions": [condition(90, "AT_OR_BELOW")],
        }
        with self.assertRaisesRegex(AgentFailure, "ordered targets"):
            _verify_agent_output(
                value,
                "TS",
                evidence={
                    "a1": {"health": {"verified_market_moving_news": False}}
                },
                supplemental={"ts_report_context": report_context},
            )

        value, report_context = ts_output()
        value["scenarios"]["extreme"]["bias"] = "BEARISH"
        value["scenarios"]["extreme"]["sequence"][0]["conditions"] = paired(
            "AT_OR_ABOVE", 111, 211
        )
        value["scenarios"]["extreme"]["sequence"][1]["conditions"] = paired(
            "AT_OR_ABOVE", 112, 212
        )
        value["scenarios"]["extreme"]["invalidation"] = {
            "logic": "ALL",
            "conditions": [condition(120, "AT_OR_ABOVE")],
        }
        with self.assertRaisesRegex(AgentFailure, "ordered targets"):
            _verify_agent_output(
                value,
                "TS",
                evidence={
                    "a1": {"health": {"verified_market_moving_news": False}}
                },
                supplemental={"ts_report_context": report_context},
            )

        value, report_context = ts_output()
        value["scenarios"]["main"]["sequence"][0]["conditions"] = paired(
            "AT_OR_ABOVE", 101, 201
        )
        value["scenarios"]["main"]["sequence"][1]["conditions"] = paired(
            "AT_OR_ABOVE", 102, 202
        )
        _verify_agent_output(
            value,
            "TS",
            evidence={
                "a1": {"health": {"verified_market_moving_news": False}}
            },
            supplemental={"ts_report_context": report_context},
        )

    def test_main_path_keeps_at_least_one_unobserved_stage(self) -> None:
        def evidence(price: float) -> dict:
            state = {
                "price": price,
                "vwap": price,
                "session_high": price,
                "session_low": price,
                "opening_range_high": price,
                "opening_range_low": price,
            }
            return {
                "a1": {"health": {"verified_market_moving_news": False}},
                "a2": {
                    "structure": {
                        "SPY": state,
                        "QQQ": deepcopy(state),
                    }
                },
            }

        value, report_context = ts_output()
        _verify_agent_output(
            value,
            "TS",
            evidence=evidence(101),
            supplemental={"ts_report_context": report_context},
        )

        value, report_context = ts_output()
        with self.assertRaisesRegex(AgentFailure, "unobserved future stage"):
            _verify_agent_output(
                value,
                "TS",
                evidence=evidence(103),
                supplemental={"ts_report_context": report_context},
            )

    def test_verified_news_requires_matching_classification_and_chain(self) -> None:
        value, report_context = ts_output()
        with self.assertRaisesRegex(AgentFailure, "news evidence"):
            _verify_agent_output(
                value,
                "TS",
                evidence={"a1": {"health": {"verified_market_moving_news": True}}},
                supplemental={"ts_report_context": report_context},
            )

    def test_machine_claims_prioritize_macro_then_newest_news(self) -> None:
        report_context = context()
        scheduled = [
            scheduled_macro_event(
                fingerprint=f"{index:064x}",
                scheduled_at=(
                    "2026-08-03T06:40:00-07:00"
                    if index == 1
                    else "2026-08-03T06:50:00-07:00"
                    if index == 2
                    else "2026-08-03T07:00:00-07:00"
                ),
            )
            for index in range(1, 4)
        ]
        news = [
            verified_news_event(
                fingerprint=f"{100 + index:064x}",
                category="energy",
                published_at=f"2026-08-03T12:{index:02d}:00+00:00",
            )
            for index in range(10)
        ]

        claims = _ts_machine_causal_claims(
            frozen_evidence(news=news, scheduled=scheduled),
            report_context,
        )

        self.assertEqual(len(claims), 8)
        self.assertEqual(
            {
                claim["event_fingerprint"]
                for claim in claims
                if claim["evidence_state"] == "PARTIAL"
            },
            {item["event_fingerprint"] for item in scheduled},
        )
        self.assertEqual(
            {
                claim["event_fingerprint"]
                for claim in claims
                if claim["evidence_state"] == "VERIFIED"
            },
            {item["event_fingerprint"] for item in news[5:]},
        )

    def test_machine_claims_keep_earliest_eight_macro_events(self) -> None:
        report_context = context()
        times = (
            "06:35",
            "06:40",
            "06:45",
            "06:50",
            "06:55",
            "07:00",
            "07:05",
            "07:10",
            "07:15",
        )
        scheduled = [
            scheduled_macro_event(
                fingerprint=f"{index:064x}",
                scheduled_at=f"2026-08-03T{event_time}:00-07:00",
            )
            for index, event_time in enumerate(times, start=1)
        ]
        news = [
            verified_news_event(
                fingerprint="f" * 64,
                category="energy",
            )
        ]

        claims = _ts_machine_causal_claims(
            frozen_evidence(news=news, scheduled=scheduled),
            report_context,
        )

        self.assertEqual(len(claims), 8)
        self.assertTrue(
            all(claim["evidence_state"] == "PARTIAL" for claim in claims)
        )
        self.assertEqual(
            {claim["event_fingerprint"] for claim in claims},
            {item["event_fingerprint"] for item in scheduled[:8]},
        )

    def test_verified_macro_result_remains_available_all_market_session(
        self,
    ) -> None:
        report_context = context(report_type="INTRADAY_30_60M")
        report_context["evidence_snapshot"]["market_time"].update(
            {
                "observed_at": "2026-08-03T12:30:00-07:00",
                "market_date": "2026-08-03",
            }
        )
        report_context["forecast_window"].update(
            {
                "start_at": "2026-08-03T12:30:00-07:00",
                "end_at": "2026-08-03T13:00:00-07:00",
            }
        )
        result = verified_macro_result()

        claims = _ts_machine_causal_claims(
            frozen_evidence(
                results=[result],
                created_at="2026-08-03T12:30:00-07:00",
            ),
            report_context,
        )

        self.assertEqual(len(claims), 1)
        claim = claims[0]
        self.assertEqual(claim["event_fingerprint"], result["result_hash"])
        self.assertEqual(claim["event_category"], "employment")
        self.assertEqual(claim["evidence_state"], "VERIFIED")
        self.assertIn("PAYROLL_EMPLOYMENT_CHANGE=128000 JOBS", claim["event"])
        self.assertIn("UNEMPLOYMENT_RATE=4.2 PERCENT", claim["event"])
        for forbidden in ("预期", "above", "below", "expectation"):
            self.assertNotIn(forbidden, claim["event"].lower())

    def test_macro_result_classifies_as_market_moving_without_news_ttl(
        self,
    ) -> None:
        value, report_context = ts_output()
        result = verified_macro_result()
        frozen = add_macro_result_chain(value, report_context, result)

        _verify_agent_output(
            value,
            "TS",
            evidence=frozen,
            supplemental={"ts_report_context": report_context},
        )
        self.assertFalse(
            frozen["a1"]["health"]["verified_market_moving_news"]
        )

    def test_macro_result_from_other_market_date_is_not_selected(self) -> None:
        prior = verified_macro_result(
            market_date="2026-08-02",
            generated_at="2026-08-02T06:29:00-07:00",
            scheduled_at="2026-08-02T05:30:00-07:00",
            published_at="2026-08-02T05:30:00-07:00",
        )

        claims = _ts_machine_causal_claims(
            frozen_evidence(
                results=[prior],
                created_at="2026-08-02T06:30:00-07:00",
            ),
            context(),
        )

        self.assertEqual(claims, [])

    def test_macro_result_newer_than_report_is_rejected(self) -> None:
        result = verified_macro_result(
            generated_at="2026-08-03T06:40:00-07:00",
            published_at="2026-08-03T06:35:00-07:00",
        )
        with self.assertRaisesRegex(AgentFailure, "newer than the report"):
            _ts_machine_causal_claims(
                frozen_evidence(
                    results=[result],
                    created_at="2026-08-03T06:40:00-07:00",
                ),
                context(),
            )

    def test_macro_schedule_and_result_identity_cannot_conflict(self) -> None:
        result = verified_macro_result()
        scheduled = scheduled_macro_event(
            fingerprint=result["schedule_event_fingerprint"],
            scheduled_at="2026-08-03T06:40:00-07:00",
        )
        with self.assertRaisesRegex(AgentFailure, "identity conflicts"):
            _ts_machine_causal_claims(
                frozen_evidence(results=[result], scheduled=[scheduled]),
                context(),
            )

    def test_next_session_macro_horizon_uses_required_session_close(self) -> None:
        report_context = context(report_type="NEXT_SESSION")
        report_context["evidence_snapshot"]["market_time"].update(
            {
                "observed_at": "2026-07-02T13:05:00-07:00",
                "market_date": "2026-07-02",
                "state": "POSTMARKET",
            }
        )
        report_context["required_next_validation"] = {
            "at": "2026-07-06T06:30:00-07:00",
            "checkpoint": "OPEN",
            "purpose": "验证次日主路径并生成06:30开盘预测",
        }
        scheduled = [
            scheduled_macro_event(
                fingerprint=f"{index:064x}",
                scheduled_at=scheduled_at,
            )
            for index, scheduled_at in enumerate(
                (
                    "2026-07-02T13:00:00-07:00",
                    "2026-07-06T05:30:00-07:00",
                    "2026-07-06T13:00:00-07:00",
                    "2026-07-06T13:01:00-07:00",
                    "2026-07-07T05:30:00-07:00",
                ),
                start=1,
            )
        ]

        claims = _ts_machine_causal_claims(
            frozen_evidence(scheduled=scheduled),
            report_context,
        )

        self.assertEqual(
            {claim["event_fingerprint"] for claim in claims},
            {
                scheduled[1]["event_fingerprint"],
                scheduled[2]["event_fingerprint"],
            },
        )

    def test_causal_chain_binds_exact_energy_and_deescalation_categories(
        self,
    ) -> None:
        value, report_context = ts_output()
        energy_event = add_verified_chain(
            value,
            report_context,
            fingerprint="1" * 64,
            category="energy",
        )
        deescalation_event = add_verified_chain(
            value,
            report_context,
            fingerprint="2" * 64,
            category="geopolitical_deescalation",
        )
        evidence = frozen_evidence(
            news=[energy_event, deescalation_event]
        )
        _verify_agent_output(
            value,
            "TS",
            evidence=evidence,
            supplemental={"ts_report_context": report_context},
        )
        value["causal_chains"][1]["event_category"] = (
            "geopolitical_escalation"
        )
        with self.assertRaisesRegex(AgentFailure, "exact verified events"):
            _verify_agent_output(
                value,
                "TS",
                evidence=evidence,
                supplemental={"ts_report_context": report_context},
            )

    def test_causal_chain_cannot_drop_same_category_verified_event(self) -> None:
        value, report_context = ts_output()
        first_event = add_verified_chain(
            value,
            report_context,
            fingerprint="1" * 64,
            category="energy",
        )
        second_event = verified_news_event(
            fingerprint="2" * 64,
            category="energy",
            published_at="2026-08-03T12:05:00+00:00",
        )
        evidence = frozen_evidence(news=[first_event, second_event])

        with self.assertRaisesRegex(AgentFailure, "exact verified events"):
            _verify_agent_output(
                value,
                "TS",
                evidence=evidence,
                supplemental={"ts_report_context": report_context},
            )

    def test_causal_chain_deduplicates_two_source_event_proofs(self) -> None:
        value, report_context = ts_output()
        fingerprint = "1" * 64
        first_proof = add_verified_chain(
            value,
            report_context,
            fingerprint=fingerprint,
            category="energy",
        )
        proofs = [
            {
                **first_proof,
                "source": source,
                "headline": headline,
                "verification_rule": "SAME_CATEGORY_TWO_SOURCE",
            }
            for source, headline in (
                ("Reuters", "Oil rises 4% after supply disruption"),
                ("Bloomberg", "Crude gains after supply disruption"),
            )
        ]
        evidence = frozen_evidence(news=proofs)
        expected_event = (
            "多源交叉核验｜仅确认同一energy事件身份；"
            "标题细节未逐项核实｜来源：Bloomberg、Reuters"
        )
        value["causal_chains"][0]["event"] = expected_event

        claims = _ts_machine_causal_claims(evidence, report_context)
        self.assertEqual(claims[0]["event"], expected_event)
        self.assertNotIn(proofs[0]["headline"], claims[0]["event"])
        self.assertNotIn(proofs[1]["headline"], claims[0]["event"])

        _verify_agent_output(
            value,
            "TS",
            evidence=evidence,
            supplemental={"ts_report_context": report_context},
        )

        value["causal_chains"].append(deepcopy(value["causal_chains"][0]))
        with self.assertRaisesRegex(AgentFailure, "exact verified events"):
            _verify_agent_output(
                value,
                "TS",
                evidence=evidence,
                supplemental={"ts_report_context": report_context},
            )

    def test_verified_news_rules_fail_closed(self) -> None:
        report_context = context()
        fingerprint = "7" * 64
        base = verified_news_event(
            fingerprint=fingerprint,
            category="energy",
        )
        cases = (
            [
                {
                    **base,
                    "source": "Reuters",
                    "verification_rule": "SAME_CATEGORY_TWO_SOURCE",
                }
            ],
            [
                base,
                {
                    **base,
                    "source": "Bloomberg",
                    "verification_rule": "SAME_CATEGORY_TWO_SOURCE",
                },
            ],
            [{**base, "verification_rule": "UNKNOWN"}],
            [{**base, "source": "Reuters"}],
        )
        for proofs in cases:
            with self.subTest(proofs=proofs):
                with self.assertRaisesRegex(
                    AgentFailure,
                    "verified news identity|selected news evidence",
                ):
                    _ts_machine_causal_claims(
                        frozen_evidence(news=proofs),
                        report_context,
                    )

    def test_scheduled_macro_event_is_bound_as_partial_amplifier(self) -> None:
        value, report_context = ts_output(report_type="NEXT_SESSION")
        scheduled_event = add_scheduled_macro_chain(
            value,
            report_context,
            fingerprint="3" * 64,
        )
        frozen = frozen_evidence(scheduled=[scheduled_event])
        _verify_agent_output(
            value,
            "TS",
            evidence=frozen,
            supplemental={"ts_report_context": report_context},
        )

        value["causal_chains"][0]["kind"] = "CATALYST"
        with self.assertRaisesRegex(AgentFailure, "conditional amplifier"):
            _verify_agent_output(
                value,
                "TS",
                evidence=frozen,
                supplemental={"ts_report_context": report_context},
            )

    def test_scheduled_macro_rejects_fabricated_release_claims(self) -> None:
        value, report_context = ts_output(report_type="NEXT_SESSION")
        scheduled_event = add_scheduled_macro_chain(
            value,
            report_context,
            fingerprint="4" * 64,
        )
        frozen = frozen_evidence(scheduled=[scheduled_event])

        cases = (
            (
                "event",
                "非农已公布：新增50万，远超预期",
                "immutable evidence",
            ),
            (
                "transmission",
                "非农已经公布并推动收益率上升",
                "conditional amplifier",
            ),
            (
                "index_effect",
                "已公布的强劲非农已经推高QQQ",
                "conditional amplifier",
            ),
        )
        for field, fabricated, error in cases:
            with self.subTest(field=field):
                candidate = deepcopy(value)
                candidate["causal_chains"][0][field] = fabricated
                with self.assertRaisesRegex(AgentFailure, error):
                    _verify_agent_output(
                        candidate,
                        "TS",
                        evidence=frozen,
                        supplemental={"ts_report_context": report_context},
                    )

    def test_verified_news_event_text_is_bound_to_frozen_headline(self) -> None:
        value, report_context = ts_output()
        event = add_verified_chain(
            value,
            report_context,
            fingerprint="5" * 64,
            category="energy",
        )
        frozen = frozen_evidence(news=[event])
        _verify_agent_output(
            value,
            "TS",
            evidence=frozen,
            supplemental={"ts_report_context": report_context},
        )

        value["causal_chains"][0]["event"] = "已核实｜油价暴跌20%"
        with self.assertRaisesRegex(AgentFailure, "immutable evidence"):
            _verify_agent_output(
                value,
                "TS",
                evidence=frozen,
                supplemental={"ts_report_context": report_context},
            )

    def test_scheduled_macro_requires_machine_owned_unknown_state(self) -> None:
        value, report_context = ts_output(report_type="NEXT_SESSION")
        event = add_scheduled_macro_chain(
            value,
            report_context,
            fingerprint="6" * 64,
        )
        tampered = deepcopy(event)
        tampered["result_status"] = "VERIFIED"
        frozen = frozen_evidence(scheduled=[tampered])

        with self.assertRaisesRegex(AgentFailure, "unreleased macro identity"):
            _verify_agent_output(
                value,
                "TS",
                evidence=frozen,
                supplemental={"ts_report_context": report_context},
            )

    def test_next_session_preserves_required_open_checkpoint(self) -> None:
        value, report_context = ts_output(report_type="NEXT_SESSION")
        required = {
            "at": "2026-08-04T06:30:00-07:00",
            "checkpoint": "OPEN",
            "purpose": "验证次日主路径并生成06:30开盘预测",
        }
        report_context["required_next_validation"] = deepcopy(required)
        value["next_validation"] = deepcopy(required)
        _verify_agent_output(
            value,
            "TS",
            evidence={"a1": {"health": {"verified_market_moving_news": False}}},
            supplemental={"ts_report_context": report_context},
        )

        value["next_validation"]["checkpoint"] = "OPEN_30M"
        with self.assertRaisesRegex(AgentFailure, "required checkpoint"):
            _verify_agent_output(
                value,
                "TS",
                evidence={
                    "a1": {"health": {"verified_market_moving_news": False}}
                },
                supplemental={"ts_report_context": report_context},
            )

    def test_context_tampering_and_nonobjective_between_are_rejected(self) -> None:
        value, report_context = ts_output()
        value["evidence_snapshot"]["release_commit"] = "e" * 40
        with self.assertRaisesRegex(AgentFailure, "evidence_snapshot"):
            _verify_agent_output(
                value,
                "TS",
                evidence={"a1": {"health": {"verified_market_moving_news": False}}},
                supplemental={"ts_report_context": report_context},
            )

        value, report_context = ts_output()
        target = value["scenarios"]["main"]["activation"]["conditions"][0]
        target.update({"operator": "BETWEEN", "upper_value": 99})
        with self.assertRaisesRegex(AgentFailure, "condition values"):
            _verify_agent_output(
                value,
                "TS",
                evidence={"a1": {"health": {"verified_market_moving_news": False}}},
                supplemental={"ts_report_context": report_context},
            )


if __name__ == "__main__":
    unittest.main()
