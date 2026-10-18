from __future__ import annotations

from datetime import UTC, datetime, timedelta
from math import isfinite
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.config import runtime_path
from trading_os_v2.common.io import atomic_write_json, iso_now, read_json, sha256_json


CONTRACT_VERSION = "v1"
CONFIRMATION_BARS = 3
MINIMUM_WINDOW = 5
BAR_INTERVAL = timedelta(minutes=5)
LAST_BAR_CLOSE_GRACE = timedelta(seconds=30)
ET_ZONE = ZoneInfo("America/New_York")
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


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _bar_datetime(bar: dict[str, Any]) -> datetime | None:
    timestamp_value = bar.get("timestamp")
    if timestamp_value not in (None, ""):
        try:
            timestamp = float(timestamp_value)
        except (TypeError, ValueError):
            return None
        if not isfinite(timestamp) or timestamp <= 0:
            return None
        try:
            return datetime.fromtimestamp(timestamp, UTC)
        except (OSError, OverflowError, ValueError):
            return None
    value = str(bar.get("time") or "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ET_ZONE)
    return parsed.astimezone(UTC)


def _bar_time(bar: dict[str, Any]) -> str:
    parsed = _bar_datetime(bar)
    return parsed.isoformat() if parsed is not None else ""


def _collected_at(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def _closed_five_minute_bars(
    value: Any,
    collected_at: datetime,
) -> tuple[list[dict[str, Any]], bool]:
    if not isinstance(value, list):
        return [], False
    if not value:
        return [], True

    rows: list[tuple[datetime, dict[str, Any]]] = []
    for row in value:
        if not isinstance(row, dict):
            return [], False
        started_at = _bar_datetime(row)
        if (
            started_at is None
            or started_at.second
            or started_at.microsecond
            or started_at.minute % 5
            or started_at > collected_at
        ):
            return [], False
        if rows and started_at - rows[-1][0] != BAR_INTERVAL:
            return [], False
        rows.append((started_at, row))

    closed_count = len(rows) - 1
    if rows[-1][0] + BAR_INTERVAL + LAST_BAR_CLOSE_GRACE <= collected_at:
        closed_count += 1
    return [row for _, row in rows[:closed_count]], True


def _empty_symbol(symbol: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "current_state": "UNKNOWN",
        "candidate_state": "UNKNOWN",
        "candidate_bars": 0,
        "direction": "unknown",
        "structure": "unknown",
        "volatility": "unknown",
        "speed": "unknown",
        "data_time": "",
        "state_since": "",
        "last_processed_bar_time": "",
        "last_transition": None,
        "session_date": "",
    }


class MarketPatternTracker:
    def __init__(
        self,
        config: dict[str, Any],
        state_path: Path | None = None,
    ) -> None:
        if config.get("contract_version") != CONTRACT_VERSION:
            raise RuntimeError("拒绝未知A2盘型追踪合同版本")
        self.symbols = tuple(config["system"]["symbols"])
        if set(self.symbols) != {"SPY", "QQQ"}:
            raise RuntimeError("A2盘型追踪v1只支持SPY和QQQ")
        self.state_path = state_path or runtime_path("a2", "pattern_tracker.json")

    def update(
        self,
        raw: dict[str, Any],
        structures: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        state = self._load()
        now = iso_now()
        market_open = (
            str(raw.get("market", {}).get("clock", {}).get("state", "")).lower()
            == "open"
        )
        if not market_open:
            state["status"] = "INACTIVE"
            atomic_write_json(self.state_path, state)
            return _public_state(state)

        collected_at = _collected_at(raw.get("collected_at"))
        previous_value = state.get("last_collected_at", "")
        previous_collected_at = _collected_at(previous_value) if previous_value else None
        if (
            collected_at is None
            or (previous_value and previous_collected_at is None)
            or (
                previous_collected_at is not None
                and collected_at < previous_collected_at
            )
        ):
            state["updated_at"] = now
            state["status"] = "DEGRADED"
            atomic_write_json(self.state_path, state)
            return _public_state(state)

        session_date = collected_at.astimezone(ET_ZONE).date().isoformat()
        symbols = state["symbols"]
        if any(
            not isinstance(symbols.get(symbol), dict)
            or symbols[symbol].get("session_date") != session_date
            for symbol in self.symbols
        ):
            for symbol in self.symbols:
                symbols[symbol] = _empty_symbol(symbol)
                symbols[symbol]["session_date"] = session_date
            state.pop("time_fault_session_date", None)

        if state.get("time_fault_session_date") == session_date:
            state["updated_at"] = now
            state["status"] = "DEGRADED"
            atomic_write_json(self.state_path, state)
            return _public_state(state)

        closed_by_symbol: dict[str, list[dict[str, Any]]] = {}
        for symbol in self.symbols:
            bars, valid = _closed_five_minute_bars(
                raw.get("market", {}).get("timesales", {}).get(symbol, []),
                collected_at,
            )
            if not valid:
                state["updated_at"] = now
                state["status"] = "DEGRADED"
                atomic_write_json(self.state_path, state)
                return _public_state(state)
            closed_by_symbol[symbol] = bars

        for symbol in self.symbols:
            last_processed_value = str(
                state["symbols"][symbol].get("last_processed_bar_time", "")
            )
            if not last_processed_value or not closed_by_symbol[symbol]:
                continue
            last_processed = _collected_at(last_processed_value)
            latest_closed = _bar_datetime(closed_by_symbol[symbol][-1])
            if (
                last_processed is None
                or latest_closed is None
                or last_processed > latest_closed
            ):
                state["time_fault_session_date"] = session_date
                state["updated_at"] = now
                state["status"] = "DEGRADED"
                atomic_write_json(self.state_path, state)
                return _public_state(state)

        bar_counts: list[int] = []
        for symbol in self.symbols:
            target = state["symbols"].setdefault(symbol, _empty_symbol(symbol))
            bars = closed_by_symbol[symbol]
            bar_counts.append(len(bars))
            if not bars:
                continue
            self._consume(
                target,
                bars,
                _number(structures.get(symbol, {}).get("atr14")),
            )

        state["last_collected_at"] = collected_at.isoformat()
        state["updated_at"] = now
        state["status"] = (
            "INITIALIZING"
            if max(bar_counts, default=0) < MINIMUM_WINDOW
            else "DEGRADED"
            if min(bar_counts, default=0) < MINIMUM_WINDOW
            else "HEALTHY"
        )
        atomic_write_json(self.state_path, state)
        return _public_state(state)

    def _load(self) -> dict[str, Any]:
        state = read_json(self.state_path, None)
        if state is None:
            return {
                "contract_version": CONTRACT_VERSION,
                "status": "INITIALIZING",
                "updated_at": "",
                "cadence_minutes": 15,
                "confirmation_bars": CONFIRMATION_BARS,
                "symbols": {
                    symbol: _empty_symbol(symbol) for symbol in self.symbols
                },
            }
        if not isinstance(state, dict) or state.get("contract_version") != CONTRACT_VERSION:
            raise RuntimeError("拒绝未知A2盘型追踪状态版本")
        if not isinstance(state.get("symbols"), dict):
            raise RuntimeError("A2盘型追踪状态损坏")
        return state

    def _consume(
        self,
        target: dict[str, Any],
        bars: list[dict[str, Any]],
        daily_atr: float,
    ) -> None:
        last_processed = str(target.get("last_processed_bar_time", ""))
        for index, bar in enumerate(bars):
            data_time = _bar_time(bar)
            if not data_time or data_time <= last_processed:
                continue
            regime, traits = classify_pattern(bars[: index + 1], daily_atr)
            target["data_time"] = data_time
            target["last_processed_bar_time"] = data_time
            last_processed = data_time
            if regime == "UNKNOWN":
                continue
            self._advance(target, regime, traits, data_time)

    @staticmethod
    def _advance(
        target: dict[str, Any],
        regime: str,
        traits: dict[str, str],
        data_time: str,
    ) -> None:
        if regime == target["current_state"]:
            target.update(traits)
            target["candidate_state"] = "UNKNOWN"
            target["candidate_bars"] = 0
            return
        if regime == target["candidate_state"]:
            target["candidate_bars"] += 1
        else:
            target["candidate_state"] = regime
            target["candidate_bars"] = 1
        if target["candidate_bars"] < CONFIRMATION_BARS:
            return

        previous = target["current_state"]
        transition = {
            "transition_id": _transition_id(
                str(target["symbol"]),
                previous,
                regime,
                data_time,
            ),
            "symbol": target["symbol"],
            "from_state": previous,
            "to_state": regime,
            "confirmed_at": iso_now(),
            "data_time": data_time,
        }
        target["current_state"] = regime
        target.update(traits)
        target["state_since"] = data_time
        target["candidate_state"] = "UNKNOWN"
        target["candidate_bars"] = 0
        target["last_transition"] = transition


def classify_pattern(
    bars: list[dict[str, Any]],
    daily_atr: float,
) -> tuple[str, dict[str, str]]:
    if len(bars) < MINIMUM_WINDOW:
        return "UNKNOWN", {
            "direction": "unknown",
            "structure": "unknown",
            "volatility": "unknown",
            "speed": "unknown",
        }

    window = bars[-12:]
    closes = [_number(bar.get("close") or bar.get("price")) for bar in window]
    highs = [_number(bar.get("high"), closes[index]) for index, bar in enumerate(window)]
    lows = [_number(bar.get("low"), closes[index]) for index, bar in enumerate(window)]
    reference = daily_atr if daily_atr > 0 else max(closes[-1] * 0.005, 0.01)
    price_range = max(highs) - min(lows)
    net = closes[-1] - closes[0]
    path = sum(abs(after - before) for before, after in zip(closes, closes[1:]))
    efficiency = abs(net) / path if path else 0.0
    range_ratio = price_range / reference
    speed_ratio = abs(net) / reference / max(len(window) - 1, 1)

    false_break = _false_break(window, reference)
    reversal = _v_reversal(closes, reference)
    if false_break:
        regime = false_break
    elif reversal:
        regime = reversal
    elif net >= reference * 0.25 and efficiency >= 0.65:
        regime = "TREND_UP"
    elif net <= -reference * 0.25 and efficiency >= 0.65:
        regime = "TREND_DOWN"
    elif range_ratio >= 0.65 and efficiency <= 0.45:
        regime = "WIDE_CHOP"
    elif range_ratio <= 0.30:
        regime = "NARROW_RANGE"
    else:
        regime = "TRANSITION"

    if regime in {"TREND_UP", "V_REVERSAL_UP", "FALSE_BREAKDOWN"}:
        direction = "bullish"
    elif regime in {"TREND_DOWN", "V_REVERSAL_DOWN", "FALSE_BREAKOUT"}:
        direction = "bearish"
    elif net >= reference * 0.08:
        direction = "bullish"
    elif net <= -reference * 0.08:
        direction = "bearish"
    else:
        direction = "neutral"
    structure = (
        "trend"
        if regime.startswith("TREND_")
        else "reversal"
        if regime.startswith("V_REVERSAL_")
        else "breakout_failure"
        if regime.startswith("FALSE_")
        else "range"
        if regime == "NARROW_RANGE"
        else "chop"
        if regime == "WIDE_CHOP"
        else "transition"
    )
    volatility = "high" if range_ratio >= 0.65 else "low" if range_ratio <= 0.30 else "normal"
    speed = "fast" if speed_ratio >= 0.10 else "normal" if speed_ratio >= 0.04 else "slow"
    return regime, {
        "direction": direction,
        "structure": structure,
        "volatility": volatility,
        "speed": speed,
    }


def _false_break(bars: list[dict[str, Any]], reference: float) -> str:
    if len(bars) < 7:
        return ""
    prior = bars[:-3]
    recent = bars[-3:]
    prior_high = max(_number(bar.get("high") or bar.get("close")) for bar in prior)
    prior_low = min(_number(bar.get("low") or bar.get("close")) for bar in prior)
    threshold = reference * 0.03
    last_close = _number(recent[-1].get("close") or recent[-1].get("price"))
    if (
        max(_number(bar.get("high") or bar.get("close")) for bar in recent)
        > prior_high + threshold
        and last_close <= prior_high
    ):
        return "FALSE_BREAKOUT"
    if (
        min(_number(bar.get("low") or bar.get("close")) for bar in recent)
        < prior_low - threshold
        and last_close >= prior_low
    ):
        return "FALSE_BREAKDOWN"
    return ""


def _v_reversal(closes: list[float], reference: float) -> str:
    if len(closes) < 7:
        return ""
    recent = closes[-7:]
    trough = min(range(1, 6), key=recent.__getitem__)
    peak = max(range(1, 6), key=recent.__getitem__)
    drop = recent[0] - recent[trough]
    rebound = recent[-1] - recent[trough]
    down_leg = [after < before for before, after in zip(recent[:trough], recent[1 : trough + 1])]
    up_leg = [after > before for before, after in zip(recent[trough:-1], recent[trough + 1 :])]
    if (
        trough <= 4
        and down_leg
        and up_leg
        and sum(down_leg) / len(down_leg) >= 0.75
        and sum(up_leg) / len(up_leg) >= 0.75
        and drop >= reference * 0.20
        and rebound >= reference * 0.20
    ):
        if rebound >= drop * 0.65:
            return "V_REVERSAL_UP"
    rise = recent[peak] - recent[0]
    reversal = recent[peak] - recent[-1]
    up_leg = [after > before for before, after in zip(recent[:peak], recent[1 : peak + 1])]
    down_leg = [after < before for before, after in zip(recent[peak:-1], recent[peak + 1 :])]
    if (
        peak <= 4
        and up_leg
        and down_leg
        and sum(up_leg) / len(up_leg) >= 0.75
        and sum(down_leg) / len(down_leg) >= 0.75
        and rise >= reference * 0.20
        and reversal >= reference * 0.20
    ):
        if reversal >= rise * 0.65:
            return "V_REVERSAL_DOWN"
    return ""


def _transition_id(symbol: str, before: str, after: str, data_time: str) -> str:
    digest = sha256_json(
        {
            "contract_version": CONTRACT_VERSION,
            "symbol": symbol,
            "from_state": before,
            "to_state": after,
            "data_time": data_time,
        }
    )
    return f"{symbol}-{digest[:16]}"


def _public_state(state: dict[str, Any]) -> dict[str, Any]:
    public_fields = {
        "symbol",
        "current_state",
        "candidate_state",
        "candidate_bars",
        "direction",
        "structure",
        "volatility",
        "speed",
        "data_time",
        "state_since",
        "last_processed_bar_time",
        "last_transition",
    }
    return {
        "contract_version": state["contract_version"],
        "status": state["status"],
        "updated_at": state["updated_at"],
        "cadence_minutes": state["cadence_minutes"],
        "confirmation_bars": state["confirmation_bars"],
        "symbols": {
            symbol: {
                key: value
                for key, value in state["symbols"][symbol].items()
                if key in public_fields
            }
            for symbol in state["symbols"]
        },
    }
