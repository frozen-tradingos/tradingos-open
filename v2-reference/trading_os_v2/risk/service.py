from __future__ import annotations

import math
import re
from copy import deepcopy
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo


PT_ZONE = ZoneInfo("America/Los_Angeles")
ENTRY_EVIDENCE_MAX_AGE = timedelta(minutes=20)
A2_REGIMES = {
    "TREND_UP",
    "TREND_DOWN",
    "NARROW_RANGE",
    "WIDE_CHOP",
    "V_REVERSAL_UP",
    "V_REVERSAL_DOWN",
    "FALSE_BREAKOUT",
    "FALSE_BREAKDOWN",
    "TRANSITION",
    "UNKNOWN",
}
A2_REGIME_DIRECTIONS = {
    "TREND_UP": "bullish",
    "V_REVERSAL_UP": "bullish",
    "FALSE_BREAKDOWN": "bullish",
    "TREND_DOWN": "bearish",
    "V_REVERSAL_DOWN": "bearish",
    "FALSE_BREAKOUT": "bearish",
}
NEW_TRADE_ACTIONS = {"MANUAL_BUY"}
POSITION_MANAGEMENT_ACTIONS = {
    "OBSERVE",
    "MANUAL_REDUCE",
    "MANUAL_ADJUST",
    "MANUAL_EXIT",
}


def enforce_d_plan(
    plan: dict[str, Any],
    evidence: dict[str, Any],
    ts_output: dict[str, Any],
    *,
    now: datetime | None = None,
) -> tuple[dict[str, Any], list[str]]:
    result = deepcopy(plan)
    violations = _new_trade_violations(result, evidence, ts_output, now=now)
    if _is_position_management(result):
        _, management_violations = validate_position_management(result, evidence)
        violations.extend(management_violations)
    violations = list(dict.fromkeys(violations))
    if (
        result.get("action") in NEW_TRADE_ACTIONS
        or _is_position_management(result)
    ) and violations:
        result.update(
            {
                "action": "NO_TRADE",
                "score": min(int(result.get("score", 0)), 8),
                "underlying": "NONE",
                "option_side": "none",
                "expiration": "",
                "strike": 0,
                "quantity": 0,
                "max_entry_debit": 0,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "summary": "硬规则阻止方案：" + "；".join(violations),
                "entry_conditions": [],
                "invalidation": [],
            }
        )
    return result, violations


def enforce_a3_final(
    decision: dict[str, Any],
    evidence: dict[str, Any],
    ts_output: dict[str, Any],
    d_output: dict[str, Any],
    review: dict[str, Any],
    *,
    now: datetime | None = None,
) -> tuple[dict[str, Any], list[str]]:
    result = deepcopy(decision)
    violations: list[str] = []
    action = result.get("decision")
    if action in NEW_TRADE_ACTIONS:
        violations.extend(_new_trade_violations(result, evidence, ts_output, now=now))
        if d_output.get("action") != "MANUAL_BUY":
            violations.append("D没有形成合规的人工买入方案")
        if review.get("conflict_detected") and review.get("review_required"):
            if not result.get("conflicts_resolved"):
                violations.append("A3没有说明冲突如何解决")
    if _is_position_management(result):
        _, management_violations = validate_position_management(result, evidence)
        violations.extend(management_violations)
    if action == "MANUAL_ADJUST":
        if d_output.get("action") != "MANUAL_REDUCE":
            violations.append("A3只能在D明确建议减仓时给出人工调整建议")
        else:
            _, d_violations = validate_position_management(d_output, evidence)
            violations.extend(d_violations)
            if (
                _contract_key(result) != _contract_key(d_output)
                or _integer(result.get("quantity"))
                != _integer(d_output.get("quantity"))
            ):
                violations.append("A3人工调整与D减仓方案的合约或数量不一致")

    result["data_status"] = evidence["a1"]["health"]["state"]
    violations = list(dict.fromkeys(violations))
    if violations:
        result.update(
            {
                "decision": "NO_TRADE",
                "score": min(int(result.get("score", 0)), 8),
                "underlying": "NONE",
                "option_side": "none",
                "expiration": "",
                "strike": 0,
                "quantity": 0,
                "max_entry_debit": 0,
                "stop_loss_pct": 0,
                "take_profit_pct": 0,
                "plain_language": "不执行该方案。硬规则未通过：" + "；".join(violations),
                "supporting_evidence": [],
                "conflicts_resolved": list(
                    dict.fromkeys(result.get("conflicts_resolved", []) + violations)
                ),
                "invalidation": [],
            }
        )
    return result, list(dict.fromkeys(violations))


def validate_position_management(
    proposal: dict[str, Any],
    evidence: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str]]:
    """Match a management proposal to exactly one confirmed open holding."""
    if not _is_position_management(proposal):
        return None, []

    action = proposal.get("action", proposal.get("decision"))
    violations: list[str] = []
    key = _contract_key(proposal)
    if (
        key[0] not in {"SPY", "QQQ"}
        or key[1] not in {"call", "put"}
        or not key[2]
        or key[3] <= 0
    ):
        violations.append("持仓管理方案的合约信息不完整或无效")

    quantity = _integer(proposal.get("quantity"))
    if quantity is None or quantity < 1:
        violations.append("持仓管理数量必须是至少1张的整数")

    matches = [
        position
        for position in evidence.get("a1", {}).get("positions", [])
        if position.get("status", "OPEN") == "OPEN"
        and _contract_key(position) == key
    ]
    matched = matches[0] if len(matches) == 1 else None
    if not violations and not matches:
        violations.append("方案未精确匹配任何老板确认的开放持仓")
    elif len(matches) > 1:
        violations.append("方案匹配到多个开放持仓，无法安全确定目标")

    if matched is not None and quantity is not None:
        held_quantity = _integer(matched.get("quantity"))
        if held_quantity is None or held_quantity < 1:
            violations.append("老板确认的开放持仓数量无效")
        elif quantity > held_quantity:
            violations.append(
                f"持仓管理数量{quantity}张超过实际持有的{held_quantity}张"
            )

    entry_debit = _as_number(proposal.get("max_entry_debit"))
    if entry_debit is None or entry_debit != 0:
        violations.append("持仓管理不得包含新增买入预算")

    if action in {"OBSERVE", "MANUAL_REDUCE", "MANUAL_ADJUST"}:
        rules = evidence["rules"]
        stop = _as_number(proposal.get("stop_loss_pct"))
        take = _as_number(proposal.get("take_profit_pct"))
        invalidation = proposal.get("invalidation")
        if not isinstance(invalidation, list) or not any(
            isinstance(item, str) and item.strip() for item in invalidation
        ):
            violations.append("持仓管理方案必须至少包含一条非空的失效条件")
        if (
            stop is None
            or not rules["stop_loss_pct_min"]
            <= stop
            <= rules["stop_loss_pct_max"]
        ):
            violations.append("持仓管理止损不在-50%至-30%之间")
        if (
            take is None
            or not rules["take_profit_pct_min"]
            <= take
            <= rules["take_profit_pct_max"]
        ):
            violations.append("持仓管理止盈不在30%至70%之间")
    elif action == "MANUAL_EXIT":
        stop = _as_number(proposal.get("stop_loss_pct"))
        take = _as_number(proposal.get("take_profit_pct"))
        if stop != 0 or take != 0:
            violations.append("人工退出方案的止损和止盈必须都严格等于0")

    violations = list(dict.fromkeys(violations))
    return (matched if not violations else None), violations


def _new_trade_violations(
    proposal: dict[str, Any],
    evidence: dict[str, Any],
    ts_output: dict[str, Any],
    *,
    now: datetime | None,
) -> list[str]:
    if proposal.get("action", proposal.get("decision")) not in NEW_TRADE_ACTIONS:
        return []

    rules = evidence["rules"]
    health = evidence["a1"]["health"]
    underlying = proposal.get("underlying")
    side = proposal.get("option_side")
    violations: list[str] = []
    requested_now = now or datetime.now(PT_ZONE)
    if requested_now.tzinfo is None:
        violations.append("交易规则检查时间必须包含时区")
        current = datetime.now(PT_ZONE)
    else:
        current = requested_now.astimezone(PT_ZONE)
    if not rules["manual_only"]:
        violations.append("第一阶段不是人工模式")
    if health["state"] in {"BLOCKED", "DEGRADED_NO_TRADE"}:
        violations.append(f"数据状态为{health['state']}")
    if not health.get("reliable_broad_market_news_available", False):
        violations.append("无法获得可靠的大盘新闻")
    if rules["spread_rule"]["status"] != "DEFINED":
        violations.append("期权价差硬阈值尚未确定")
    if int(proposal.get("score", 0)) < rules["score_actionable_min"]:
        violations.append("评分不足9分")
    outlooks = ts_output.get("symbol_outlooks")
    outlook = (
        outlooks.get(underlying)
        if isinstance(outlooks, dict) and underlying in {"SPY", "QQQ"}
        else None
    )
    direction = outlook.get("direction") if isinstance(outlook, dict) else None
    path = (
        direction.lower()
        if ts_output.get("contract_version") == "v2"
        and ts_output.get("role") == "TS"
        and direction in {"BULLISH", "BEARISH", "RANGE"}
        else None
    )
    if path is None:
        violations.append("TS_OUTPUT v2对应标的方向合同无效")
    elif (
        path == "bullish"
        and side == "put"
        or path == "bearish"
        and side == "call"
    ):
        violations.append("TS方向与期权方向冲突")
    tradeability = ts_output.get("tradeability", {}).get("status")
    if tradeability != "READY_FOR_D_REVIEW":
        violations.append("TS交易性尚未达到READY_FOR_D_REVIEW")
    context_violation = _a2_entry_context_violation(
        evidence,
        underlying,
        side,
        require_qualification=path == "range",
        ts_path=path,
        now=current,
    )
    if context_violation:
        violations.append(context_violation)

    market_state = str(
        evidence.get("a1", {}).get("market_clock", {}).get("state", "")
    ).lower()
    if market_state != "open":
        violations.append("市场当前未开盘")

    cutoff_hour, cutoff_minute = (
        int(part) for part in evidence["schedule"]["new_position_cutoff"].split(":")
    )
    if (current.hour, current.minute) >= (cutoff_hour, cutoff_minute):
        if rules["after_cutoff_requires_verified_market_moving_news"] and not health.get(
            "verified_market_moving_news", False
        ):
            violations.append("10:30后没有经核实的重大大盘新闻")

    expiration = proposal.get("expiration", "")
    strike = _number(proposal.get("strike"))
    quantity = int(proposal.get("quantity", 0))
    total_budget = _number(proposal.get("max_entry_debit"))
    if underlying not in rules["underlyings"]:
        violations.append("标的不是SPY或QQQ")
    if side not in rules["option_sides"]:
        violations.append("不是单腿Call或Put")
    dte = _dte(expiration, current.date())
    if dte is None or not rules["dte_min"] <= dte <= rules["dte_max"]:
        violations.append(
            f"到期日在{rules['dte_min']}至{rules['dte_max']}天范围之外"
        )
    if quantity < 1:
        violations.append("合约数量必须至少为1")
    if total_budget <= 0 or total_budget > rules["max_cumulative_cost_per_position_usd"]:
        violations.append("本仓累计预算超过1000美元或无效")
    stop = _number(proposal.get("stop_loss_pct"))
    take = _number(proposal.get("take_profit_pct"))
    if not rules["stop_loss_pct_min"] <= stop <= rules["stop_loss_pct_max"]:
        violations.append("止损不在-50%至-30%之间")
    if not rules["take_profit_pct_min"] <= take <= rules["take_profit_pct_max"]:
        violations.append("止盈不在30%至70%之间")

    candidate = _find_candidate(evidence, underlying, side, expiration, strike)
    if candidate is None:
        violations.append("合约不在本次冻结的Tradier期权链候选中")
    else:
        bid = _as_number(candidate.get("bid"))
        ask = _as_number(candidate.get("ask"))
        if bid is None or ask is None or bid <= 0 or ask < bid:
            violations.append("合约买卖报价无效")
        else:
            if quantity > 0 and ask * 100 * quantity > total_budget + 0.01:
                violations.append("按真实卖价计算的合约成本超过方案预算")
            spread = rules["spread_rule"]
            if spread["status"] == "DEFINED":
                relative_limit = _as_number(spread.get("max_relative_pct"))
                absolute_limit = _as_number(spread.get("max_absolute_usd"))
                if (
                    relative_limit is None
                    or absolute_limit is None
                    or relative_limit <= 0
                    or absolute_limit <= 0
                ):
                    violations.append("期权价差硬阈值无效")
                else:
                    bid_decimal = Decimal(str(bid))
                    ask_decimal = Decimal(str(ask))
                    absolute = ask_decimal - bid_decimal
                    relative = (
                        absolute
                        / ((ask_decimal + bid_decimal) / Decimal("2"))
                        * Decimal("100")
                    )
                    if relative > Decimal(str(relative_limit)):
                        violations.append("相对买卖价差超过硬阈值")
                    if absolute > Decimal(str(absolute_limit)):
                        violations.append("绝对买卖价差超过硬阈值")

    positions = evidence.get("a1", {}).get("positions", [])
    matching_positions = [
        item
        for item in positions
        if item.get("underlying") == underlying
        and item.get("option_side") == side
        and item.get("expiration") == expiration
        and _number(item.get("strike")) == strike
        and item.get("status", "OPEN") == "OPEN"
    ]
    open_positions = [
        item for item in positions if item.get("status", "OPEN") == "OPEN"
    ]
    if not matching_positions and len(open_positions) >= rules["max_open_positions"]:
        violations.append("真实持仓已经达到3个")
    prior_cost = sum(
        _number(item.get("cumulative_cost_usd")) for item in matching_positions
    )
    if prior_cost + total_budget > rules["max_cumulative_cost_per_position_usd"]:
        violations.append("加仓后本仓累计投入超过1000美元")
    return list(dict.fromkeys(violations))


def _a2_entry_context_violation(
    evidence: dict[str, Any],
    underlying: Any,
    side: Any,
    *,
    require_qualification: bool,
    ts_path: Any,
    now: datetime,
) -> str:
    expected_policy = {
        "status": "TREND_ALIGNED_PULLBACK_ONLY",
        "wide_chop_new_trade_allowed": False,
        "transition_requires_qualified_context": True,
        "required_structure_timeframes": ["15m", "30m"],
        "microstructure_confirmation": "5M_BREAK_AND_NEXT_BAR_HOLD",
        "vwap_role": "EVIDENCE_ONLY",
    }
    if evidence.get("rules", {}).get("range_market_policy") != expected_policy:
        return "震荡顺势回撤规则合同无效"
    tracker = evidence.get("a2", {}).get("pattern_tracker")
    if (
        not isinstance(tracker, dict)
        or tracker.get("contract_version") != "v1"
        or tracker.get("status") != "HEALTHY"
        or not isinstance(tracker.get("symbols"), dict)
    ):
        return "A2盘型证据不可用于新开仓"
    pattern = tracker["symbols"].get(underlying)
    if not isinstance(pattern, dict):
        return "A2缺少对应标的的盘型证据"
    proof = evidence.get("a2", {}).get("trend_pullback")
    if (
        not isinstance(proof, dict)
        or proof.get("contract_version") != "v1"
        or proof.get("status") != "HEALTHY"
        or proof.get("policy") != "TREND_ALIGNED_PULLBACK_ONLY"
        or proof.get("trade_action") is not False
        or not isinstance(proof.get("symbols"), dict)
    ):
        return "震荡路径缺少有效的A2顺势回撤证据"
    symbol = proof["symbols"].get(underlying)
    if not isinstance(symbol, dict):
        return "震荡路径缺少对应标的的A2顺势回撤证据"
    regime = symbol.get("regime")
    if regime != pattern.get("current_state"):
        return "A2盘型与顺势回撤证据不一致"
    if regime not in A2_REGIMES:
        return "A2盘型与顺势回撤状态不在批准枚举内"
    if regime == "WIDE_CHOP":
        return "大幅纯震荡禁止新开仓"
    if regime == "UNKNOWN":
        return "A2盘型尚未确认，禁止新开仓"
    regime_direction = A2_REGIME_DIRECTIONS.get(regime)
    if regime_direction is not None:
        expected_side = "call" if regime_direction == "bullish" else "put"
        if side != expected_side or ts_path != regime_direction:
            return "A2已确认盘型方向与TS路径或期权方向冲突"
    context_hash = symbol.get("context_hash")
    assessment = symbol.get(side)
    data_time = _aware_datetime(symbol.get("data_time"))
    created_at = _aware_datetime(evidence.get("created_at"))
    created_age = now - created_at if created_at is not None else None
    data_age = now - data_time if data_time is not None else None
    if (
        data_time is None
        or created_at is None
        or now.tzinfo is None
        or symbol.get("data_time") != pattern.get("last_processed_bar_time")
        or data_time > created_at
        or created_at - data_time > ENTRY_EVIDENCE_MAX_AGE
        or created_age is None
        or created_age < timedelta(0)
        or created_age > ENTRY_EVIDENCE_MAX_AGE
        or data_age is None
        or data_age < timedelta(0)
        or data_age > ENTRY_EVIDENCE_MAX_AGE
    ):
        return "A2顺势回撤证据时间无效或已过期"
    if (
        not isinstance(context_hash, str)
        or re.fullmatch(r"[0-9a-f]{64}", context_hash) is None
    ):
        return "A2顺势回撤上下文无效"
    if not (
        require_qualification
        or regime in {"NARROW_RANGE", "TRANSITION"}
    ):
        return ""
    if (
        not isinstance(assessment, dict)
        or set(assessment) != {"eligibility", "reason", "evidence"}
        or assessment.get("eligibility") is not True
        or assessment.get("reason") != "TREND_ALIGNED_PULLBACK_CONFIRMED"
        or not isinstance(assessment.get("evidence"), list)
    ):
        return "震荡路径尚未确认顺势回撤结构"
    return ""


def _aware_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _find_candidate(
    evidence: dict[str, Any],
    underlying: Any,
    side: Any,
    expiration: Any,
    strike: float,
) -> dict[str, Any] | None:
    option_data = evidence.get("a2", {}).get("options", {}).get(underlying, {})
    for expiry in option_data.get("expirations", []):
        if expiry.get("expiration") != expiration:
            continue
        for candidate in expiry.get("near_atm_candidates", []):
            if (
                candidate.get("side") == side
                and _number(candidate.get("strike")) == strike
            ):
                return candidate
    return None


def _dte(expiration: str, market_day: Any) -> int | None:
    try:
        return (datetime.strptime(expiration, "%Y-%m-%d").date() - market_day).days
    except (TypeError, ValueError):
        return None


def _is_position_management(proposal: dict[str, Any]) -> bool:
    action = proposal.get("action", proposal.get("decision"))
    if action not in POSITION_MANAGEMENT_ACTIONS:
        return False
    if action != "OBSERVE":
        return True
    return any(
        (
            proposal.get("underlying") not in {None, "NONE"},
            proposal.get("option_side") not in {None, "none"},
            bool(proposal.get("expiration")),
            _number(proposal.get("strike")) > 0,
            _integer(proposal.get("quantity")) not in {None, 0},
        )
    )


def _contract_key(proposal: dict[str, Any]) -> tuple[Any, Any, Any, float]:
    return (
        proposal.get("underlying"),
        proposal.get("option_side"),
        proposal.get("expiration"),
        _number(proposal.get("strike")),
    )


def _integer(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number.is_integer() else None


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _number(value: Any) -> float:
    return _as_number(value) or 0.0
