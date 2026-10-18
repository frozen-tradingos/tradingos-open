from __future__ import annotations

from datetime import UTC, datetime, timedelta
from math import isfinite
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import sha256_json


CONTRACT_VERSION = "v1"
BAR_INTERVAL = timedelta(minutes=5)
BAR_CLOSE_GRACE = timedelta(seconds=30)
PT_ZONE = ZoneInfo("America/Los_Angeles")
REGIMES = {
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
REGIME_DIRECTIONS = {
    "TREND_UP": "bullish",
    "V_REVERSAL_UP": "bullish",
    "FALSE_BREAKDOWN": "bullish",
    "TREND_DOWN": "bearish",
    "V_REVERSAL_DOWN": "bearish",
    "FALSE_BREAKOUT": "bearish",
}


def build_trend_pullback_assessments(
    *,
    contract_version: str,
    collected_at: str,
    bars: dict[str, list[dict[str, Any]]],
    pattern_states: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if contract_version != CONTRACT_VERSION:
        raise RuntimeError("Unknown A2 trend-pullback contract version")
    collected = _aware_time(collected_at)
    if (
        collected is None
        or not isinstance(bars, dict)
        or not isinstance(pattern_states, dict)
    ):
        raise RuntimeError("Invalid A2 trend-pullback evidence")

    symbols: dict[str, Any] = {}
    for symbol in ("SPY", "QQQ"):
        pattern = pattern_states.get(symbol)
        if not isinstance(pattern, dict):
            raise RuntimeError(f"Missing {symbol} pattern evidence")
        regime = pattern.get("current_state")
        if regime not in REGIMES:
            raise RuntimeError(f"Invalid {symbol} pattern regime")
        canonical = _canonical_bars(bars.get(symbol), collected)
        if len(canonical) < 3:
            symbols[symbol] = {
                "data_time": "",
                "regime": regime,
                "context_hash": "",
                "call": _result(False, "INSUFFICIENT_CLOSED_BARS"),
                "put": _result(False, "INSUFFICIENT_CLOSED_BARS"),
            }
            continue

        fifteen = _timeframe_context(_aggregate(canonical, 15))
        thirty = _timeframe_context(_aggregate(canonical, 30))
        direction = (
            "bullish"
            if fifteen["direction"] == thirty["direction"] == "up"
            else "bearish"
            if fifteen["direction"] == thirty["direction"] == "down"
            else "neutral"
        )
        last_three = canonical[-3:]
        vwap = _vwap(canonical)
        contexts: dict[str, dict[str, Any]] = {}
        for side in ("call", "put"):
            expected = "bullish" if side == "call" else "bearish"
            vwap_evidence = (
                "neutral"
                if not vwap
                else "supporting"
                if (
                    side == "call"
                    and last_three[-1]["close"] >= vwap
                    or side == "put"
                    and last_three[-1]["close"] <= vwap
                )
                else "opposing"
            )
            contexts[side] = {
                "contract_version": CONTRACT_VERSION,
                "side": side,
                "regime": regime,
                "direction": direction,
                "vwap_evidence": vwap_evidence,
                "collected_at": collected.isoformat(),
                "timeframes": {"15m": fifteen, "30m": thirty},
                "microstructure_5m": {
                    "confirmed_break_level": (
                        last_three[0]["high"]
                        if side == "call"
                        else last_three[0]["low"]
                    ),
                    "bars": last_three,
                },
                "expected_direction": expected,
            }

        context_payload = {
            "contract_version": CONTRACT_VERSION,
            "symbol": symbol,
            "data_time": canonical[-1]["start_time"],
            "regime": regime,
            "contexts": contexts,
        }
        symbols[symbol] = {
            "data_time": canonical[-1]["start_time"],
            "regime": regime,
            "context_hash": sha256_json(context_payload),
            "call": evaluate_trend_pullback_eligibility(contexts["call"]),
            "put": evaluate_trend_pullback_eligibility(contexts["put"]),
        }

    return {
        "contract_version": CONTRACT_VERSION,
        "status": "HEALTHY",
        "policy": "TREND_ALIGNED_PULLBACK_ONLY",
        "trade_action": False,
        "symbols": symbols,
    }


def evaluate_trend_pullback_eligibility(context: dict[str, Any]) -> dict[str, Any]:
    """Evaluate evidence only; this function never creates a trade or contract."""
    if not isinstance(context, dict):
        return _result(False, "INVALID_INPUT")
    if context.get("contract_version") != CONTRACT_VERSION:
        return _result(False, "UNKNOWN_CONTRACT_VERSION")

    side = context.get("side")
    regime = context.get("regime")
    direction = context.get("direction")
    vwap = context.get("vwap_evidence")
    if (
        side not in {"call", "put"}
        or regime not in REGIMES
        or direction not in {"bullish", "bearish", "neutral", "unknown"}
        or vwap not in {"supporting", "neutral", "opposing"}
    ):
        return _result(False, "INVALID_INPUT")
    if regime == "UNKNOWN":
        return _result(False, "UNKNOWN_REGIME", ["REGIME_UNKNOWN"])
    if regime == "WIDE_CHOP":
        return _result(False, "PURE_WIDE_CHOP", ["REGIME_WIDE_CHOP"])
    if direction in {"neutral", "unknown"}:
        return _result(False, "NO_DIRECTION", [f"DIRECTION_{direction.upper()}"])
    if REGIME_DIRECTIONS.get(regime, direction) != direction:
        return _result(False, "INVALID_INPUT")

    expected_direction = "bullish" if side == "call" else "bearish"
    expected_structure = "up" if side == "call" else "down"
    if direction != expected_direction:
        return _result(False, "DIRECTION_MISMATCH")

    timeframes = context.get("timeframes")
    if not isinstance(timeframes, dict):
        return _result(False, "INVALID_INPUT")
    fifteen = timeframes.get("15m")
    thirty = timeframes.get("30m")
    if not isinstance(fifteen, dict) or not isinstance(thirty, dict):
        return _result(False, "INVALID_INPUT")
    if fifteen.get("confirmed") is not True or thirty.get("confirmed") is not True:
        return _result(False, "UNCONFIRMED_HIGHER_TIMEFRAME")
    if (
        fifteen.get("direction") not in {"up", "down"}
        or thirty.get("direction") not in {"up", "down"}
    ):
        return _result(False, "INVALID_INPUT")
    if (
        fifteen["direction"] != expected_structure
        or thirty["direction"] != expected_structure
    ):
        return _result(False, "HIGHER_TIMEFRAME_MISMATCH")

    latest_close = _finite_number(fifteen.get("latest_close"))
    swing_low = _finite_number(fifteen.get("confirmed_swing_low"))
    swing_high = _finite_number(fifteen.get("confirmed_swing_high"))
    if (
        latest_close is None
        or (side == "call" and swing_low is None)
        or (side == "put" and swing_high is None)
        or (
            swing_low is not None
            and swing_high is not None
            and swing_low > swing_high
        )
    ):
        return _result(False, "INVALID_INPUT")
    if (
        side == "call"
        and latest_close < swing_low
        or side == "put"
        and latest_close > swing_high
    ):
        return _result(False, "FIFTEEN_MINUTE_STRUCTURE_BROKEN")

    collected_at = _aware_time(context.get("collected_at"))
    micro = context.get("microstructure_5m")
    if collected_at is None or not isinstance(micro, dict):
        return _result(False, "INVALID_INPUT")
    break_level = _finite_number(micro.get("confirmed_break_level"))
    if break_level is None:
        return _result(False, "INVALID_INPUT")
    bars, bar_error = _validated_bars(micro.get("bars"), collected_at)
    if bar_error:
        return _result(False, bar_error)

    setup, breakout, hold = bars
    if side == "call":
        confirmed = (
            setup["high"] <= break_level
            and breakout["open"] <= break_level < breakout["close"]
            and hold["low"] >= break_level
            and hold["close"] >= break_level
        )
    else:
        confirmed = (
            setup["low"] >= break_level
            and breakout["open"] >= break_level > breakout["close"]
            and hold["high"] <= break_level
            and hold["close"] <= break_level
        )
    if not confirmed:
        return _result(False, "FIVE_MINUTE_BREAK_AND_HOLD_NOT_CONFIRMED")

    return _result(
        True,
        "TREND_ALIGNED_PULLBACK_CONFIRMED",
        [
            f"REGIME_{regime}",
            f"DIRECTION_{direction.upper()}",
            f"15M_{expected_structure.upper()}_INTACT",
            f"30M_{expected_structure.upper()}",
            f"5M_BREAK_AND_HOLD_{expected_structure.upper()}",
            f"VWAP_{vwap.upper()}",
        ],
    )


def _validated_bars(
    value: Any,
    collected_at: datetime,
) -> tuple[list[dict[str, float]], str]:
    if not isinstance(value, list) or len(value) != 3:
        return [], "INVALID_INPUT"
    normalized: list[dict[str, float]] = []
    starts: list[datetime] = []
    for bar in value:
        if not isinstance(bar, dict):
            return [], "INVALID_INPUT"
        started_at = _aware_time(bar.get("start_time"))
        prices = {
            key: _finite_number(bar.get(key))
            for key in ("open", "high", "low", "close")
        }
        if started_at is None or any(item is None for item in prices.values()):
            return [], "INVALID_INPUT"
        if (
            started_at.second
            or started_at.microsecond
            or started_at.minute % 5
            or prices["low"] > prices["high"]
            or not prices["low"] <= prices["open"] <= prices["high"]
            or not prices["low"] <= prices["close"] <= prices["high"]
        ):
            return [], "INVALID_INPUT"
        if starts and started_at - starts[-1] != BAR_INTERVAL:
            return [], "INVALID_5M_SEQUENCE"
        if started_at + BAR_INTERVAL + BAR_CLOSE_GRACE > collected_at:
            return [], "UNCLOSED_5M_BAR"
        starts.append(started_at)
        normalized.append(prices)
    return normalized, ""


def _canonical_bars(
    value: Any,
    collected_at: datetime,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise RuntimeError("A2 trend-pullback bars must be a list")
    result: list[dict[str, Any]] = []
    previous: datetime | None = None
    for row in value:
        if not isinstance(row, dict):
            raise RuntimeError("A2 trend-pullback bar must be an object")
        started = _row_time(row)
        if (
            started is None
            or started.second
            or started.microsecond
            or started.minute % 5
            or (
                previous is not None
                and started - previous != BAR_INTERVAL
            )
            or started + BAR_INTERVAL + BAR_CLOSE_GRACE > collected_at
        ):
            raise RuntimeError("Invalid closed 5m trend-pullback sequence")
        values = {
            key: _finite_number(row.get(key))
            for key in ("open", "high", "low", "close", "volume")
        }
        if any(number is None for number in values.values()):
            raise RuntimeError("Invalid trend-pullback OHLCV")
        opening = float(values["open"])
        high = float(values["high"])
        low = float(values["low"])
        close = float(values["close"])
        volume = float(values["volume"])
        if (
            min(opening, close) < low
            or max(opening, close) > high
            or low <= 0
            or volume < 0
        ):
            raise RuntimeError("Invalid trend-pullback OHLCV")
        result.append(
            {
                "start_time": started.isoformat(),
                "open": opening,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )
        previous = started
    return result


def _row_time(row: dict[str, Any]) -> datetime | None:
    timestamp = _finite_number(row.get("timestamp"))
    if timestamp is not None and timestamp > 0:
        try:
            return datetime.fromtimestamp(timestamp, UTC)
        except (OSError, OverflowError, ValueError):
            return None
    value = row.get("time") or row.get("start_at") or row.get("start_time")
    return _aware_time(value)


def _aggregate(
    rows: list[dict[str, Any]],
    minutes: int,
) -> list[dict[str, Any]]:
    required = minutes // 5
    grouped: dict[datetime, list[dict[str, Any]]] = {}
    for row in rows:
        started = datetime.fromisoformat(row["start_time"]).astimezone(PT_ZONE)
        bucket = started.replace(
            minute=(started.minute // minutes) * minutes,
            second=0,
            microsecond=0,
        )
        grouped.setdefault(bucket, []).append(row)

    result: list[dict[str, Any]] = []
    for bucket, values in sorted(grouped.items()):
        if len(values) != required:
            continue
        starts = [
            datetime.fromisoformat(value["start_time"])
            for value in values
        ]
        if any(
            after - before != BAR_INTERVAL
            for before, after in zip(starts, starts[1:])
        ):
            continue
        result.append(
            {
                "start_time": bucket.astimezone(UTC).isoformat(),
                "open": values[0]["open"],
                "high": max(value["high"] for value in values),
                "low": min(value["low"] for value in values),
                "close": values[-1]["close"],
                "volume": sum(value["volume"] for value in values),
            }
        )
    return result


def _timeframe_context(rows: list[dict[str, Any]]) -> dict[str, Any]:
    recent = rows[-3:]
    direction = "unknown"
    if len(recent) == 3:
        first, _, last = recent
        if (
            last["close"] > first["close"]
            and last["high"] > first["high"]
            and last["low"] > first["low"]
        ):
            direction = "up"
        elif (
            last["close"] < first["close"]
            and last["high"] < first["high"]
            and last["low"] < first["low"]
        ):
            direction = "down"
        else:
            direction = "flat"
    return {
        "confirmed": len(recent) == 3 and direction in {"up", "down"},
        "direction": direction,
        "latest_close": rows[-1]["close"] if rows else None,
        "confirmed_swing_low": _confirmed_pivot(rows, "low"),
        "confirmed_swing_high": _confirmed_pivot(rows, "high"),
    }


def _confirmed_pivot(
    rows: list[dict[str, Any]],
    field: str,
) -> float | None:
    for index in range(len(rows) - 2, 0, -1):
        before = rows[index - 1][field]
        value = rows[index][field]
        after = rows[index + 1][field]
        if (
            field == "low"
            and value <= before
            and value < after
            or field == "high"
            and value >= before
            and value > after
        ):
            return float(value)
    return None


def _vwap(rows: list[dict[str, Any]]) -> float:
    volume = sum(row["volume"] for row in rows)
    if volume <= 0:
        return 0.0
    return sum(
        row["close"] * row["volume"]
        for row in rows
    ) / volume


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _aware_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def _result(
    eligibility: bool,
    reason: str,
    evidence: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "eligibility": eligibility,
        "reason": reason,
        "evidence": evidence or [],
    }
