from __future__ import annotations

import json
import math
import os
import re
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import sha256_json


CONTRACT_VERSION = "v1"
COMPONENT = "A2_HALF_HOUR_FORECAST"
MODE = "SHADOW"
SYMBOLS = ("SPY", "QQQ")
BAR_INTERVAL = timedelta(minutes=5)
HORIZON = timedelta(minutes=30)
PT_ZONE = ZoneInfo("America/Los_Angeles")
FORECAST_ID_RE = re.compile(r"^hh-\d{8}T\d{4}Z$")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")

UP_STATES = {"TREND_UP", "V_REVERSAL_UP", "FALSE_BREAKDOWN"}
DOWN_STATES = {"TREND_DOWN", "V_REVERSAL_DOWN", "FALSE_BREAKOUT"}
RANGE_STATES = {"NARROW_RANGE", "WIDE_CHOP"}
UNCERTAIN_STATES = {"TRANSITION", "UNKNOWN"}
KNOWN_STATES = UP_STATES | DOWN_STATES | RANGE_STATES | UNCERTAIN_STATES


class HalfHourForecastError(RuntimeError):
    pass


class DuplicateRecordError(HalfHourForecastError):
    pass


class HalfHourForecastService:
    """Private A2 shadow forecasts. This component never emits trade actions."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.forecast_dir = root / "forecasts"
        self.outcome_dir = root / "outcomes"
        self.manifest_dir = root / "issuance_manifest"

    def process(
        self,
        *,
        contract_version: str,
        collected_at: str | datetime,
        bars: dict[str, list[dict[str, Any]]],
        pattern_states: dict[str, dict[str, Any]],
        structures: dict[str, dict[str, Any]],
        options: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        _require_version(contract_version)
        collected = _datetime(collected_at, "collected_at")
        local_date = collected.astimezone(PT_ZONE).date()
        ledger = self._reconcile_ledger()
        pending_ids: list[str] = []
        for forecast_id, forecast in ledger["forecasts"].items():
            slot = _datetime(forecast["slot_at"], "slot_at")
            target_end = _datetime(
                forecast["target_end_at"],
                "target_end_at",
            )
            if forecast_id in ledger["outcomes"]:
                continue
            if target_end > collected:
                continue
            if slot.astimezone(PT_ZONE).date() != local_date:
                pending_ids.append(forecast_id)
                continue
            outcome = self.resolve(
                contract_version=contract_version,
                forecast_id=forecast_id,
                resolved_at=collected,
                bars=bars,
            )
            if outcome["status"] != "RESOLVED":
                pending_ids.append(forecast_id)

        try:
            issued = self.issue(
                contract_version=contract_version,
                issued_at=collected,
                bars=bars,
                pattern_states=pattern_states,
                structures=structures,
                options=options,
            )
        except DuplicateRecordError:
            slot = _issue_slot(collected)
            if slot is None:
                raise
            forecast_id = _forecast_id(slot)
            existing = _read_json(self._forecast_path(forecast_id))
            _verify_forecast(existing, expected_id=forecast_id)
            issued = {
                "status": "ALREADY_ISSUED",
                "forecast_id": forecast_id,
                "forecast_hash": existing["forecast_hash"],
            }

        final_ledger = self._reconcile_ledger()
        inventory = _session_inventory_proof(
            final_ledger,
            local_date.isoformat(),
        )
        issue_status = str(issued["status"])
        return {
            "contract_version": CONTRACT_VERSION,
            "component": COMPONENT,
            "mode": MODE,
            "actionable": False,
            "status": (
                "PENDING"
                if pending_ids or issue_status == "PENDING"
                else "HEALTHY"
            ),
            "issue_status": issue_status,
            "issued_forecast_id": str(issued.get("forecast_id", "")),
            "issued_forecast_hash": str(issued.get("forecast_hash", "")),
            **inventory,
            "pending_overdue_forecast_ids": pending_ids,
        }

    def session_inventory(
        self,
        collected_at: str | datetime,
    ) -> dict[str, Any]:
        collected = _datetime(collected_at, "collected_at")
        ledger = self._reconcile_ledger()
        return _session_inventory_proof(
            ledger,
            collected.astimezone(PT_ZONE).date().isoformat(),
        )

    @staticmethod
    def empty_session_inventory(
        session_date: str = "",
    ) -> dict[str, Any]:
        return _session_inventory_proof(
            {
                "manifests": {},
                "forecasts": {},
                "outcomes": {},
            },
            session_date,
        )

    def issue(
        self,
        *,
        contract_version: str,
        issued_at: str | datetime,
        bars: dict[str, list[dict[str, Any]]],
        pattern_states: dict[str, dict[str, Any]],
        structures: dict[str, dict[str, Any]],
        options: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        _require_version(contract_version)
        self._reconcile_ledger()
        issued = _datetime(issued_at, "issued_at")
        slot = _issue_slot(issued)
        if slot is None:
            return _status("NOT_DUE", "不是半小时影子预测发行时段")
        forecast_id = _forecast_id(slot)
        if self._forecast_path(forecast_id).exists():
            raise DuplicateRecordError(f"预测已发行，拒绝重复：{forecast_id}")

        missing = [
            name
            for name, value in (
                ("bars", bars),
                ("pattern_states", pattern_states),
                ("structures", structures),
                ("options", options),
            )
            if not isinstance(value, dict) or any(symbol not in value for symbol in SYMBOLS)
        ]
        if missing:
            return _status("PENDING", f"缺少SPY/QQQ输入：{','.join(missing)}", slot)

        normalized: dict[str, list[dict[str, Any]]] = {}
        history: dict[str, list[dict[str, Any]]] = {}
        gaps: list[str] = []
        expected_history_times = [
            slot - HORIZON + index * BAR_INTERVAL for index in range(6)
        ]
        for symbol in SYMBOLS:
            if not all(
                isinstance(value.get(symbol), dict)
                for value in (pattern_states, structures, options)
            ):
                raise HalfHourForecastError(
                    f"{symbol} structured input is invalid"
                )
            normalized[symbol] = _normalize_bars(bars[symbol])
            if any(_bar_start(row) >= slot for row in normalized[symbol]):
                raise HalfHourForecastError(f"{symbol}输入含发行时点后的bar")
            by_time = {_bar_start(row): row for row in normalized[symbol]}
            selected = [by_time.get(value) for value in expected_history_times]
            if any(row is None for row in selected):
                gaps.append(f"{symbol}缺少发行前连续6根闭合5分钟bar")
                continue
            history[symbol] = [row for row in selected if row is not None]
            atr = _finite_number(structures[symbol].get("atr14"))
            if atr is None or atr <= 0:
                gaps.append(f"{symbol}缺少有效日ATR")
            state = str(pattern_states[symbol].get("current_state", ""))
            if state not in KNOWN_STATES:
                raise HalfHourForecastError(f"{symbol}盘型状态无效：{state or 'missing'}")

        if gaps:
            return _status("PENDING", "；".join(gaps), slot)

        input_payload = {
            "contract_version": CONTRACT_VERSION,
            "slot_at": slot.isoformat(),
            "bars": history,
            "pattern_states": {
                symbol: pattern_states[symbol] for symbol in SYMBOLS
            },
            "structures": {symbol: structures[symbol] for symbol in SYMBOLS},
            "options": {symbol: options[symbol] for symbol in SYMBOLS},
        }
        input_hash = sha256_json(input_payload)
        target_times = [
            slot + index * BAR_INTERVAL for index in range(6)
        ]
        record = {
            "contract_version": CONTRACT_VERSION,
            "component": COMPONENT,
            "mode": MODE,
            "actionable": False,
            "status": "ISSUED",
            "forecast_id": forecast_id,
            "model_version": "continuation-baseline-v1",
            "issued_at": issued.isoformat(),
            "slot_at": slot.isoformat(),
            "target_end_at": (slot + HORIZON).isoformat(),
            "target_bar_times": [value.isoformat() for value in target_times],
            "cadence_minutes": 15,
            "horizon_minutes": 30,
            "input_hash": input_hash,
            "input_payload": input_payload,
            "symbols": {
                symbol: _symbol_forecast(
                    symbol,
                    history[symbol],
                    pattern_states[symbol],
                    structures[symbol],
                    options[symbol],
                )
                for symbol in SYMBOLS
            },
        }
        record["forecast_hash"] = sha256_json(record)
        _verify_forecast(record, expected_id=record["forecast_id"])
        _write_once(self._forecast_path(record["forecast_id"]), record)
        _write_once(
            self._manifest_path(record["forecast_id"]),
            _manifest_entry(record),
        )
        self._reconcile_ledger()
        return record

    def resolve(
        self,
        *,
        contract_version: str,
        forecast_id: str,
        resolved_at: str | datetime,
        bars: dict[str, list[dict[str, Any]]],
    ) -> dict[str, Any]:
        _require_version(contract_version)
        self._reconcile_ledger()
        if not FORECAST_ID_RE.fullmatch(forecast_id):
            raise HalfHourForecastError("forecast_id无效")
        if self._outcome_path(forecast_id).exists():
            raise DuplicateRecordError(f"结果已结算，拒绝重复：{forecast_id}")
        forecast = _read_json(self._forecast_path(forecast_id))
        _verify_forecast(forecast, expected_id=forecast_id)
        resolved = _datetime(resolved_at, "resolved_at")
        target_end = _datetime(forecast["target_end_at"], "target_end_at")
        if resolved < target_end:
            return _status("PENDING", "30分钟预测窗口尚未结束")
        if not isinstance(bars, dict) or any(symbol not in bars for symbol in SYMBOLS):
            return _status("PENDING", "缺少SPY/QQQ结果bar")

        expected_times = [
            _datetime(value, "target_bar_time")
            for value in forecast["target_bar_times"]
        ]
        resolved_symbols: dict[str, dict[str, Any]] = {}
        gaps: list[str] = []
        for symbol in SYMBOLS:
            normalized = _normalize_bars(bars[symbol])
            if any(_bar_start(row) + BAR_INTERVAL > resolved for row in normalized):
                raise HalfHourForecastError(f"{symbol}结果输入含尚未闭合的bar")
            by_time = {_bar_start(row): row for row in normalized}
            selected = [by_time.get(value) for value in expected_times]
            if any(row is None for row in selected):
                gaps.append(f"{symbol}缺少恰好6根后续闭合5分钟bar")
                continue
            target_bars = [row for row in selected if row is not None]
            if len(target_bars) != 6:
                gaps.append(f"{symbol}后续bar数量不是6")
                continue
            resolved_symbols[symbol] = _symbol_outcome(
                forecast["symbols"][symbol],
                target_bars,
            )

        if gaps:
            return _status("PENDING", "；".join(gaps))

        outcome = {
            "contract_version": CONTRACT_VERSION,
            "component": COMPONENT,
            "mode": MODE,
            "actionable": False,
            "status": "RESOLVED",
            "forecast_id": forecast_id,
            "forecast_hash": forecast["forecast_hash"],
            "resolved_at": resolved.isoformat(),
            "target_end_at": forecast["target_end_at"],
            "bar_count_per_symbol": 6,
            "symbols": resolved_symbols,
        }
        outcome["outcome_hash"] = sha256_json(outcome)
        _verify_outcome(
            outcome,
            forecast,
            expected_id=forecast_id,
        )
        _write_once(self._outcome_path(forecast_id), outcome)
        self._reconcile_ledger()
        return outcome

    def _forecast_path(self, forecast_id: str) -> Path:
        return self.forecast_dir / f"{forecast_id}.json"

    def _outcome_path(self, forecast_id: str) -> Path:
        return self.outcome_dir / f"{forecast_id}.json"

    def _manifest_path(self, forecast_id: str) -> Path:
        return self.manifest_dir / f"{forecast_id}.json"

    def _reconcile_ledger(self) -> dict[str, dict[str, dict[str, Any]]]:
        manifest_paths = _record_paths(self.manifest_dir, "issuance manifest")
        forecast_paths = _record_paths(self.forecast_dir, "forecast")
        outcome_paths = _record_paths(self.outcome_dir, "outcome")
        manifests = {
            path.stem: _read_json(path) for path in manifest_paths
        }
        forecasts = {
            path.stem: _read_json(path) for path in forecast_paths
        }
        outcomes = {
            path.stem: _read_json(path) for path in outcome_paths
        }
        manifest_ids = set(manifests)
        forecast_ids = set(forecasts)
        outcome_ids = set(outcomes)
        if manifest_ids != forecast_ids:
            raise HalfHourForecastError(
                "issuance manifest与forecast账本不一致"
                f"；缺少forecast={sorted(manifest_ids - forecast_ids)}"
                f"；缺少manifest={sorted(forecast_ids - manifest_ids)}"
            )
        if not outcome_ids <= forecast_ids:
            raise HalfHourForecastError(
                "存在没有forecast和issuance manifest的孤儿outcome："
                + ",".join(sorted(outcome_ids - forecast_ids))
            )

        for forecast_id in sorted(forecast_ids):
            manifest = manifests[forecast_id]
            forecast = forecasts[forecast_id]
            _verify_manifest_entry(
                manifest,
                expected_id=forecast_id,
            )
            _verify_forecast(
                forecast,
                expected_id=forecast_id,
            )
            if (
                manifest["forecast_path"]
                != f"forecasts/{forecast_id}.json"
                or manifest["forecast_hash"] != forecast["forecast_hash"]
                or manifest["slot_at"] != forecast["slot_at"]
            ):
                raise HalfHourForecastError(
                    f"issuance manifest未绑定forecast：{forecast_id}"
                )
            if forecast_id in outcomes:
                _verify_outcome(
                    outcomes[forecast_id],
                    forecast,
                    expected_id=forecast_id,
                )
        return {
            "manifests": {
                key: manifests[key] for key in sorted(manifests)
            },
            "forecasts": {
                key: forecasts[key] for key in sorted(forecasts)
            },
            "outcomes": {
                key: outcomes[key] for key in sorted(outcomes)
            },
        }


def _session_inventory_proof(
    ledger: dict[str, dict[str, dict[str, Any]]],
    session_date: str,
) -> dict[str, Any]:
    records: list[dict[str, str]] = []
    for forecast_id, forecast in ledger["forecasts"].items():
        slot = _datetime(forecast["slot_at"], "inventory slot_at")
        if (
            not session_date
            or slot.astimezone(PT_ZONE).date().isoformat() != session_date
        ):
            continue
        manifest = ledger["manifests"][forecast_id]
        outcome = ledger["outcomes"].get(forecast_id)
        records.append(
            {
                "forecast_id": forecast_id,
                "slot_at": forecast["slot_at"],
                "manifest_hash": manifest["manifest_hash"],
                "forecast_hash": forecast["forecast_hash"],
                "outcome_hash": (
                    outcome["outcome_hash"] if outcome is not None else ""
                ),
            }
        )
    records.sort(
        key=lambda record: _datetime(
            record["slot_at"],
            "inventory slot_at",
        )
    )
    issued_ids = [record["forecast_id"] for record in records]
    resolved_ids = [
        record["forecast_id"]
        for record in records
        if record["outcome_hash"]
    ]
    inventory_payload = {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "session_date": session_date,
        "records": records,
    }
    return {
        "session_date": session_date,
        "session_issued_forecast_ids": issued_ids,
        "resolved_forecast_ids": resolved_ids,
        "session_inventory_hash": sha256_json(inventory_payload),
    }


def _symbol_forecast(
    symbol: str,
    history: list[dict[str, Any]],
    pattern: dict[str, Any],
    structure: dict[str, Any],
    option: dict[str, Any],
) -> dict[str, Any]:
    state = str(pattern["current_state"])
    forecast = (
        "UP"
        if state in UP_STATES
        else "DOWN"
        if state in DOWN_STATES
        else "RANGE"
        if state in RANGE_STATES
        else "UNCERTAIN"
    )
    ratio = _normalized_option_ratio(option)
    alignment = _option_alignment(forecast, ratio)
    anchor = history[-1]
    return {
        "symbol": symbol,
        "status": "SHADOW_UNCALIBRATED",
        "forecast": forecast,
        "probabilities": None,
        "bar_data_time": anchor["time"],
        "anchor_closed_price": anchor["close"],
        "daily_atr": float(structure["atr14"]),
        "pattern_state": state,
        "pattern_direction": str(
            pattern.get("direction", "unknown")
        ).strip()
        or "unknown",
        "structure_hash": sha256_json(structure),
        "history_bar_hash": sha256_json(history),
        "option_proxy": {
            "alignment": alignment,
            "put_call_volume_ratio": ratio,
            "changes_forecast": False,
            "snapshot_hash": sha256_json(option),
        },
    }


def _symbol_outcome(
    forecast: dict[str, Any],
    bars: list[dict[str, Any]],
) -> dict[str, Any]:
    anchor = float(forecast["anchor_closed_price"])
    final = float(bars[-1]["close"])
    high = max(float(row["high"]) for row in bars)
    low = min(float(row["low"]) for row in bars)
    atr = float(forecast["daily_atr"])
    return_pct = (final / anchor - 1) * 100
    mfe_pct = max((high / anchor - 1) * 100, 0.0)
    mae_pct = min((low / anchor - 1) * 100, 0.0)
    return {
        "forecast": forecast["forecast"],
        "anchor_closed_price": anchor,
        "final_close": final,
        "return_pct": round(return_pct, 6),
        "return_atr": round((final - anchor) / atr, 6),
        "mfe_pct": round(mfe_pct, 6),
        "mfe_atr": round(max(high - anchor, 0.0) / atr, 6),
        "mae_pct": round(mae_pct, 6),
        "mae_atr": round(min(low - anchor, 0.0) / atr, 6),
        "excursion_basis": "UNDERLYING_LONG",
        "bar_hash": sha256_json(bars),
        "target_bars": bars,
    }


def _option_alignment(forecast: str, ratio: float | None) -> str:
    if ratio is None or ratio <= 0:
        return "UNAVAILABLE"
    if forecast not in {"UP", "DOWN"} or 0.8 < ratio < 1.2:
        return "NEUTRAL"
    bullish_proxy = ratio <= 0.8
    return "ALIGNED" if (forecast == "UP") == bullish_proxy else "OPPOSED"


def _normalized_option_ratio(option: dict[str, Any]) -> float | None:
    ratio = _finite_number(option.get("put_call_volume_ratio"))
    return ratio if ratio is not None and ratio > 0 else None


def _normalize_bars(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise HalfHourForecastError("bar输入必须是列表")
    result: list[dict[str, Any]] = []
    seen: set[datetime] = set()
    previous: datetime | None = None
    for row in rows:
        if not isinstance(row, dict):
            raise HalfHourForecastError("bar必须是对象")
        start = _bar_datetime(row)
        if previous is not None and start < previous:
            raise HalfHourForecastError("bar time is out of order")
        if start in seen:
            raise HalfHourForecastError("bar时间重复")
        seen.add(start)
        previous = start
        if start.second or start.microsecond or start.minute % 5:
            raise HalfHourForecastError("bar时间未对齐5分钟")
        values = {
            name: _finite_number(row.get(name))
            for name in ("open", "high", "low", "close", "volume")
        }
        if any(value is None for value in values.values()):
            raise HalfHourForecastError("bar缺少有效OHLCV")
        open_price = float(values["open"])
        high = float(values["high"])
        low = float(values["low"])
        close = float(values["close"])
        volume = float(values["volume"])
        if (
            min(open_price, close) < low
            or max(open_price, close) > high
            or high < low
            or volume < 0
        ):
            raise HalfHourForecastError("bar OHLCV关系无效")
        result.append(
            {
                "time": start.isoformat(),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )
    return result


def _bar_datetime(row: dict[str, Any]) -> datetime:
    timestamp = _finite_number(row.get("timestamp"))
    if timestamp is not None and timestamp > 0:
        return datetime.fromtimestamp(timestamp, UTC)
    value = str(row.get("time") or row.get("start_at") or "").strip()
    if not value:
        raise HalfHourForecastError("bar缺少时间")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HalfHourForecastError("bar时间无效") from exc
    if parsed.tzinfo is None:
        raise HalfHourForecastError("bar time must include timezone")
    return parsed.astimezone(UTC)


def _bar_start(row: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(str(row["time"])).astimezone(UTC)


def _issue_slot(issued: datetime) -> datetime | None:
    local = issued.astimezone(PT_ZONE)
    if local.weekday() >= 5:
        return None
    slot_local = local.replace(
        minute=local.minute // 15 * 15,
        second=0,
        microsecond=0,
    )
    if local - slot_local >= timedelta(minutes=3):
        return None
    start = slot_local.replace(hour=7, minute=0)
    end = slot_local.replace(hour=12, minute=30)
    if not start <= slot_local <= end:
        return None
    return slot_local.astimezone(UTC)


def _forecast_id(slot: datetime) -> str:
    return f"hh-{slot.astimezone(UTC).strftime('%Y%m%dT%H%MZ')}"


def _datetime(value: str | datetime, label: str) -> datetime:
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise HalfHourForecastError(f"{label}无效") from exc
    if parsed.tzinfo is None:
        raise HalfHourForecastError(f"{label}必须带时区")
    return parsed.astimezone(UTC)


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _require_version(value: str) -> None:
    if value != CONTRACT_VERSION:
        raise HalfHourForecastError("拒绝未知A2半小时预测合同版本")


def _status(
    status: str,
    reason: str,
    slot: datetime | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "mode": MODE,
        "actionable": False,
        "status": status,
        "reason": reason,
    }
    if slot is not None:
        result["slot_at"] = slot.isoformat()
    return result


def _manifest_entry(forecast: dict[str, Any]) -> dict[str, Any]:
    forecast_id = str(forecast["forecast_id"])
    entry = {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "kind": "ISSUANCE",
        "forecast_id": forecast_id,
        "forecast_path": f"forecasts/{forecast_id}.json",
        "forecast_hash": forecast["forecast_hash"],
        "slot_at": forecast["slot_at"],
    }
    entry["manifest_hash"] = sha256_json(entry)
    return entry


def _verify_manifest_entry(
    entry: Any,
    *,
    expected_id: str,
) -> None:
    _require_exact_keys(
        entry,
        {
            "contract_version",
            "component",
            "kind",
            "forecast_id",
            "forecast_path",
            "forecast_hash",
            "slot_at",
            "manifest_hash",
        },
        "issuance manifest",
    )
    _require_version(str(entry["contract_version"]))
    expected_hash = str(entry["manifest_hash"])
    payload = {
        key: value for key, value in entry.items() if key != "manifest_hash"
    }
    if not _is_hash(expected_hash) or sha256_json(payload) != expected_hash:
        raise HalfHourForecastError("issuance manifest hash mismatch")
    slot = _canonical_datetime(entry["slot_at"], "manifest slot_at")
    if (
        entry["component"] != COMPONENT
        or entry["kind"] != "ISSUANCE"
        or entry["forecast_id"] != expected_id
        or not FORECAST_ID_RE.fullmatch(expected_id)
        or _forecast_id(slot) != expected_id
        or entry["forecast_path"] != f"forecasts/{expected_id}.json"
        or not _is_hash(entry["forecast_hash"])
    ):
        raise HalfHourForecastError("issuance manifest semantics are invalid")


def _verify_forecast(
    record: Any,
    *,
    expected_id: str,
) -> None:
    _require_exact_keys(
        record,
        {
            "contract_version",
            "component",
            "mode",
            "actionable",
            "status",
            "forecast_id",
            "model_version",
            "issued_at",
            "slot_at",
            "target_end_at",
            "target_bar_times",
            "cadence_minutes",
            "horizon_minutes",
            "input_hash",
            "input_payload",
            "symbols",
            "forecast_hash",
        },
        "forecast",
    )
    _require_version(str(record["contract_version"]))
    expected_hash = str(record["forecast_hash"])
    payload = {
        key: value for key, value in record.items() if key != "forecast_hash"
    }
    if not _is_hash(expected_hash) or sha256_json(payload) != expected_hash:
        raise HalfHourForecastError("预测记录哈希不匹配")

    slot = _canonical_datetime(record["slot_at"], "slot_at")
    issued = _canonical_datetime(record["issued_at"], "issued_at")
    target_end = _canonical_datetime(
        record["target_end_at"],
        "target_end_at",
    )
    target_times = record["target_bar_times"]
    expected_target_times = [
        (slot + index * BAR_INTERVAL).isoformat() for index in range(6)
    ]
    input_payload = _verify_input_payload(
        record["input_payload"],
        slot=slot,
    )
    if (
        record["component"] != COMPONENT
        or record["mode"] != MODE
        or record["actionable"] is not False
        or record["status"] != "ISSUED"
        or record["forecast_id"] != expected_id
        or not FORECAST_ID_RE.fullmatch(expected_id)
        or _forecast_id(slot) != expected_id
        or _issue_slot(issued) != slot
        or target_end != slot + HORIZON
        or target_times != expected_target_times
        or record["cadence_minutes"] != 15
        or record["horizon_minutes"] != 30
        or record["model_version"] != "continuation-baseline-v1"
        or not _is_hash(record["input_hash"])
        or sha256_json(input_payload) != record["input_hash"]
        or not isinstance(record["symbols"], dict)
        or set(record["symbols"]) != set(SYMBOLS)
    ):
        raise HalfHourForecastError("预测记录语义无效")
    for symbol in SYMBOLS:
        _verify_symbol_forecast(
            record["symbols"][symbol],
            symbol=symbol,
            slot=slot,
            history=input_payload["bars"][symbol],
            pattern=input_payload["pattern_states"][symbol],
            structure=input_payload["structures"][symbol],
            option_input=input_payload["options"][symbol],
        )


def _verify_input_payload(
    value: Any,
    *,
    slot: datetime,
) -> dict[str, Any]:
    _require_exact_keys(
        value,
        {
            "contract_version",
            "slot_at",
            "bars",
            "pattern_states",
            "structures",
            "options",
        },
        "forecast input payload",
    )
    _require_version(str(value["contract_version"]))
    input_slot = _canonical_datetime(
        value["slot_at"],
        "input payload slot_at",
    )
    if input_slot != slot:
        raise HalfHourForecastError(
            "forecast input payload slot does not match forecast"
        )
    for name in ("bars", "pattern_states", "structures", "options"):
        if (
            not isinstance(value[name], dict)
            or set(value[name]) != set(SYMBOLS)
        ):
            raise HalfHourForecastError(
                f"forecast input payload {name} symbols are invalid"
            )
    expected_times = [
        slot - HORIZON + index * BAR_INTERVAL for index in range(6)
    ]
    for symbol in SYMBOLS:
        history = value["bars"][symbol]
        normalized = _normalize_bars(history)
        if (
            normalized != history
            or [_bar_start(row) for row in history] != expected_times
            or not all(
                isinstance(value[name][symbol], dict)
                for name in ("pattern_states", "structures", "options")
            )
        ):
            raise HalfHourForecastError(
                f"{symbol} forecast input payload is invalid"
            )
    return value


def _verify_symbol_forecast(
    value: Any,
    *,
    symbol: str,
    slot: datetime,
    history: list[dict[str, Any]],
    pattern: dict[str, Any],
    structure: dict[str, Any],
    option_input: dict[str, Any],
) -> None:
    _require_exact_keys(
        value,
        {
            "symbol",
            "status",
            "forecast",
            "probabilities",
            "bar_data_time",
            "anchor_closed_price",
            "daily_atr",
            "pattern_state",
            "pattern_direction",
            "structure_hash",
            "history_bar_hash",
            "option_proxy",
        },
        f"{symbol} forecast",
    )
    option = value["option_proxy"]
    _require_exact_keys(
        option,
        {
            "alignment",
            "put_call_volume_ratio",
            "changes_forecast",
            "snapshot_hash",
        },
        f"{symbol} option proxy",
    )
    state = str(pattern.get("current_state", ""))
    expected_forecast = (
        "UP"
        if state in UP_STATES
        else "DOWN"
        if state in DOWN_STATES
        else "RANGE"
        if state in RANGE_STATES
        else "UNCERTAIN"
        if state in UNCERTAIN_STATES
        else ""
    )
    anchor = _finite_number(value["anchor_closed_price"])
    atr = _finite_number(value["daily_atr"])
    ratio = _normalized_option_ratio(option_input)
    bar_time = _canonical_datetime(
        value["bar_data_time"],
        f"{symbol} bar_data_time",
    )
    if (
        value["symbol"] != symbol
        or value["status"] != "SHADOW_UNCALIBRATED"
        or value["forecast"] != expected_forecast
        or value["probabilities"] is not None
        or bar_time != slot - BAR_INTERVAL
        or value["bar_data_time"] != history[-1]["time"]
        or anchor is None
        or anchor <= 0
        or anchor != float(history[-1]["close"])
        or atr is None
        or atr <= 0
        or atr != _finite_number(structure.get("atr14"))
        or value["pattern_state"] != state
        or value["pattern_direction"]
        != (str(pattern.get("direction", "unknown")).strip() or "unknown")
        or value["structure_hash"] != sha256_json(structure)
        or value["history_bar_hash"] != sha256_json(history)
        or option["put_call_volume_ratio"] != ratio
        or option["alignment"] != _option_alignment(expected_forecast, ratio)
        or option["changes_forecast"] is not False
        or option["snapshot_hash"] != sha256_json(option_input)
    ):
        raise HalfHourForecastError(f"{symbol} forecast semantics are invalid")


def _verify_outcome(
    outcome: Any,
    forecast: dict[str, Any],
    *,
    expected_id: str,
) -> None:
    _require_exact_keys(
        outcome,
        {
            "contract_version",
            "component",
            "mode",
            "actionable",
            "status",
            "forecast_id",
            "forecast_hash",
            "resolved_at",
            "target_end_at",
            "bar_count_per_symbol",
            "symbols",
            "outcome_hash",
        },
        "outcome",
    )
    _require_version(str(outcome["contract_version"]))
    expected_hash = str(outcome["outcome_hash"])
    payload = {
        key: value for key, value in outcome.items() if key != "outcome_hash"
    }
    if not _is_hash(expected_hash) or sha256_json(payload) != expected_hash:
        raise HalfHourForecastError("outcome hash mismatch")
    resolved_at = _canonical_datetime(outcome["resolved_at"], "resolved_at")
    target_end = _canonical_datetime(
        outcome["target_end_at"],
        "outcome target_end_at",
    )
    if (
        outcome["component"] != COMPONENT
        or outcome["mode"] != MODE
        or outcome["actionable"] is not False
        or outcome["status"] != "RESOLVED"
        or outcome["forecast_id"] != expected_id
        or outcome["forecast_id"] != forecast["forecast_id"]
        or outcome["forecast_hash"] != forecast["forecast_hash"]
        or outcome["target_end_at"] != forecast["target_end_at"]
        or resolved_at < target_end
        or outcome["bar_count_per_symbol"] != 6
        or not isinstance(outcome["symbols"], dict)
        or set(outcome["symbols"]) != set(SYMBOLS)
    ):
        raise HalfHourForecastError("outcome boundary is invalid")
    for symbol in SYMBOLS:
        _verify_symbol_outcome(
            outcome["symbols"][symbol],
            forecast["symbols"][symbol],
            symbol=symbol,
            expected_times=forecast["target_bar_times"],
        )


def _verify_symbol_outcome(
    value: Any,
    forecast: dict[str, Any],
    *,
    symbol: str,
    expected_times: list[str],
) -> None:
    _require_exact_keys(
        value,
        {
            "forecast",
            "anchor_closed_price",
            "final_close",
            "return_pct",
            "return_atr",
            "mfe_pct",
            "mfe_atr",
            "mae_pct",
            "mae_atr",
            "excursion_basis",
            "bar_hash",
            "target_bars",
        },
        f"{symbol} outcome",
    )
    target_bars = _normalize_bars(value["target_bars"])
    if (
        target_bars != value["target_bars"]
        or [row["time"] for row in target_bars] != expected_times
        or len(target_bars) != 6
        or value != _symbol_outcome(forecast, target_bars)
    ):
        raise HalfHourForecastError(f"{symbol} outcome semantics are invalid")


def _require_exact_keys(
    value: Any,
    expected: set[str],
    label: str,
) -> None:
    if not isinstance(value, dict) or set(value) != expected:
        raise HalfHourForecastError(f"{label} fields are invalid")


def _canonical_datetime(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise HalfHourForecastError(f"{label}必须是带时区时间字符串")
    parsed = _datetime(value, label)
    if value != parsed.isoformat():
        raise HalfHourForecastError(f"{label}不是规范UTC时间")
    return parsed


def _is_hash(value: Any) -> bool:
    return isinstance(value, str) and HASH_RE.fullmatch(value) is not None


def _record_paths(directory: Path, label: str) -> list[Path]:
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise HalfHourForecastError(f"{label}路径不是目录")
    paths: list[Path] = []
    for path in sorted(directory.iterdir()):
        if (
            not path.is_file()
            or path.suffix != ".json"
            or FORECAST_ID_RE.fullmatch(path.stem) is None
        ):
            raise HalfHourForecastError(
                f"unexpected {label} record: {path.name}"
            )
        paths.append(path)
    return paths


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise HalfHourForecastError("预测记录不存在") from exc
    except json.JSONDecodeError as exc:
        raise HalfHourForecastError("预测记录不是有效JSON") from exc


def _write_once(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError as exc:
            raise DuplicateRecordError(f"记录已存在，拒绝覆盖：{path.name}") from exc
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
