from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
import json
import math
from pathlib import Path
import re
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import sha256_json
from trading_os_v2.ts.calibration import (
    TSCalibrationError,
    archive_observations,
    archive_partitioned_calibration,
    archive_settlement,
    calibration_archive_lock,
    eligible_forecast_records,
    eligible_settlement_records,
    settle_forecast,
)


SYMBOLS = ("SPY", "QQQ")
INTRADAY_REPORTS = {
    "OPENING_FORECAST",
    "OPEN_15M_CHECK",
    "OPEN_30M_CHECK",
    "INTRADAY_30_60M",
}
PT_ZONE = ZoneInfo("America/Los_Angeles")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{10}$")
SWING_SCORECARD_PATH = "swing-scorecards"
SWING_SYMBOL_FIELDS = {
    "forecast_direction",
    "entry_price",
    "entry_at",
    "max_price",
    "max_bar_closed_at",
    "min_price",
    "min_bar_closed_at",
    "close_price",
    "close_at",
    "upside_excursion_pct",
    "downside_excursion_pct",
    "close_return_pct",
    "favorable_excursion_pct",
    "adverse_excursion_pct",
    "first_extreme",
}


class TSSettlementError(RuntimeError):
    pass


def settle_due_forecasts(
    root: Path,
    dataset: dict[str, Any],
    *,
    as_of: datetime,
) -> dict[str, Any]:
    if as_of.tzinfo is None:
        raise TSSettlementError("TS settlement requires aware as_of")
    grouped = _validated_dataset(dataset)
    try:
        with calibration_archive_lock(root):
            return _settle_due_forecasts_locked(
                root,
                dataset,
                as_of=as_of,
                grouped=grouped,
            )
    except TSCalibrationError as exc:
        raise TSSettlementError(str(exc)) from exc


def _settle_due_forecasts_locked(
    root: Path,
    dataset: dict[str, Any],
    *,
    as_of: datetime,
    grouped: dict[str, dict[str, list[dict[str, Any]]]],
) -> dict[str, Any]:
    common_dates = sorted(set(grouped["SPY"]) & set(grouped["QQQ"]))
    due_forecasts: list[dict[str, Any]] = []
    settled_due: list[str] = []
    newly_settled: list[str] = []
    pending: list[str] = []
    try:
        settlements = eligible_settlement_records(root)
        completed = {
            item["forecast_run_id"]
            for item in settlements
        }
        records = eligible_forecast_records(root)
    except TSCalibrationError as exc:
        raise TSSettlementError(str(exc)) from exc
    scorecard_run_ids = {
        value["forecast_run_id"]
        for value in swing_scorecard_records(root, records=records)
    }
    for record in records:
        run_id = record["forecast_run_id"]
        if run_id not in completed or run_id in scorecard_run_ids:
            continue
        observations = _read_scorecard(
            root / "observations" / f"{run_id}.json"
        )
        if observations.get("complete") is True:
            _archive_swing_scorecard(
                root,
                _swing_scorecard(record, observations),
                record,
                observations,
            )
    for record in records:
        run_id = record["forecast_run_id"]
        selected_dates = _settlement_dates(
            record,
            common_dates,
            as_of.date(),
        )
        if selected_dates is None:
            if run_id not in completed:
                pending.append(run_id)
            continue
        target_day = date.fromisoformat(selected_dates[-1])
        if run_id in completed and target_day < as_of.date():
            continue
        due_forecasts.append(
            {
                "forecast_run_id": run_id,
                "target_market_dates": selected_dates,
            }
        )
        if run_id in completed:
            settled_due.append(run_id)
            continue
        observations = _observations(
            record,
            dataset,
            grouped,
            selected_dates,
        )
        archive_observations(root, observations, record)
        if observations["complete"] is True:
            _archive_swing_scorecard(
                root,
                _swing_scorecard(record, observations),
                record,
                observations,
            )
        archive_settlement(
            root,
            settle_forecast(record, observations, settled_at=as_of),
        )
        newly_settled.append(run_id)
        settled_due.append(run_id)

    settlements = eligible_settlement_records(root)
    calibration_index = archive_partitioned_calibration(
        root,
        settlements,
        generated_at=as_of,
    )
    body = {
        "contract_version": "v2",
        "component": "TS_SETTLEMENT_RUN",
        "status": "COMPLETED",
        "as_of": as_of.astimezone(UTC).isoformat(),
        "dataset_hash": dataset["data_hash"],
        "due_forecasts": due_forecasts,
        "due_inventory_hash": sha256_json(due_forecasts),
        "settled_due_run_ids": settled_due,
        "settled_due_hash": sha256_json(settled_due),
        "newly_settled_run_ids": newly_settled,
        "newly_settled_hash": sha256_json(newly_settled),
        "pending_run_ids": pending,
        "settlement_count": len(settlements),
        "resolved_count": calibration_index["resolved_count"],
        "calibration_hash": calibration_index["index_hash"],
    }
    return {**body, "run_hash": sha256_json(body)}


def _validated_dataset(
    dataset: dict[str, Any],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    if not isinstance(dataset, dict):
        raise TSSettlementError("Invalid immutable market-history dataset")
    body = {
        key: value for key, value in dataset.items() if key != "data_hash"
    }
    if (
        dataset.get("contract_version") != "v1"
        or dataset.get("source") != "tradier"
        or dataset.get("interval") != "5min"
        or dataset.get("symbols") != ["QQQ", "SPY"]
        or dataset.get("data_hash") != sha256_json(body)
        or not isinstance(dataset.get("source_hashes"), list)
        or not dataset["source_hashes"]
        or not isinstance(dataset.get("records"), list)
    ):
        raise TSSettlementError("Invalid immutable market-history dataset")
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = {
        symbol: defaultdict(list) for symbol in SYMBOLS
    }
    for row in dataset["records"]:
        if not isinstance(row, dict) or row.get("symbol") not in SYMBOLS:
            raise TSSettlementError("Invalid settlement history row")
        try:
            session = date.fromisoformat(str(row.get("session_date")))
            start = datetime.fromisoformat(str(row.get("start_at")))
        except ValueError as exc:
            raise TSSettlementError("Invalid settlement history time") from exc
        if start.tzinfo is None:
            raise TSSettlementError("Settlement history time is not aware")
        normalized = dict(row)
        normalized["session_date"] = session.isoformat()
        grouped[row["symbol"]][session.isoformat()].append(normalized)
    for symbol in SYMBOLS:
        for session, bars in grouped[symbol].items():
            bars.sort(key=lambda item: item["start_at"])
            times = [item["start_at"] for item in bars]
            if len(bars) != 78 or times != sorted(set(times)):
                raise TSSettlementError(
                    f"{symbol} {session} is not one complete regular session"
                )
    if set(grouped["SPY"]) != set(grouped["QQQ"]):
        raise TSSettlementError("SPY and QQQ settlement sessions are not aligned")
    return grouped


def _settlement_dates(
    record: dict[str, Any],
    common_dates: list[str],
    as_of_day: date,
) -> list[str] | None:
    issued_day = date.fromisoformat(record["market_date"])
    available = [
        item
        for item in common_dates
        if date.fromisoformat(item) <= as_of_day
    ]
    if record["report_type"] == "WEEKEND_OUTLOOK":
        selected = [item for item in available if date.fromisoformat(item) > issued_day][
            :5
        ]
        return selected if len(selected) == 5 else None
    if record["report_type"] == "NEXT_SESSION":
        selected = [item for item in available if date.fromisoformat(item) > issued_day]
        return selected[:1] or None
    if record["report_type"] in INTRADAY_REPORTS:
        start_raw = record["ts_output"]["forecast_window"].get("start_at")
        try:
            start_at = datetime.fromisoformat(str(start_raw))
        except ValueError as exc:
            raise TSSettlementError("Invalid intraday forecast start") from exc
        if start_at.tzinfo is None:
            raise TSSettlementError("Intraday forecast start is not aware")
        market_start = start_at.astimezone(PT_ZONE)
        market_close = market_start.replace(
            hour=13,
            minute=0,
            second=0,
            microsecond=0,
        )
        if market_start >= market_close:
            return None
        target = issued_day.isoformat()
        return [target] if target in available else None
    raise TSSettlementError("Unknown TS report type in forecast archive")


def _observations(
    record: dict[str, Any],
    dataset: dict[str, Any],
    grouped: dict[str, dict[str, list[dict[str, Any]]]],
    selected_dates: list[str],
) -> dict[str, Any]:
    end_raw = record["ts_output"]["forecast_window"]["end_at"]
    end_at = datetime.fromisoformat(end_raw) if end_raw else None
    observation_end = _covering_five_minute_close(end_at) if end_at else None
    symbols: dict[str, list[dict[str, Any]]] = {}
    for symbol in SYMBOLS:
        converted: list[dict[str, Any]] = []
        for session in selected_dates:
            cumulative_value = 0.0
            cumulative_volume = 0.0
            for row in grouped[symbol][session]:
                closed_at = datetime.fromisoformat(row["start_at"]) + timedelta(
                    minutes=5
                )
                cumulative_value += float(row["close"]) * float(row["volume"])
                cumulative_volume += float(row["volume"])
                if observation_end is not None and closed_at > observation_end:
                    continue
                converted.append(
                    {
                        "closed_at": closed_at.isoformat(),
                        "open": float(row["open"]),
                        "high": float(row["high"]),
                        "low": float(row["low"]),
                        "close": float(row["close"]),
                        "vwap": (
                            round(cumulative_value / cumulative_volume, 8)
                            if cumulative_volume
                            else None
                        ),
                    }
                )
        if not converted:
            raise TSSettlementError("Forecast has no closed settlement bars")
        symbols[symbol] = converted
    spy_times = [item["closed_at"] for item in symbols["SPY"]]
    qqq_times = [item["closed_at"] for item in symbols["QQQ"]]
    if spy_times != qqq_times:
        raise TSSettlementError("SPY and QQQ observation bars are not aligned")
    complete = observation_end is None or (
        datetime.fromisoformat(spy_times[-1]) >= observation_end
    )
    body = {
        "contract_version": "v2",
        "component": "TS_FORECAST_OBSERVATIONS",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "timezone": "America/Los_Angeles",
        "window_start": spy_times[0],
        "window_end": spy_times[-1],
        "complete": complete,
        "source_hashes": sorted(set(dataset["source_hashes"])),
        "symbols": symbols,
    }
    return {**body, "observation_hash": sha256_json(body)}


def _covering_five_minute_close(value: datetime) -> datetime:
    aligned = value.replace(second=0, microsecond=0)
    remainder = value.minute % 5
    if remainder or value.second or value.microsecond:
        aligned += timedelta(minutes=5 - remainder if remainder else 5)
    return aligned


def _calculate_swing_scorecard(
    record: dict[str, Any],
    observations: dict[str, Any],
) -> dict[str, Any]:
    if observations.get("complete") is not True:
        raise TSSettlementError("Swing scorecard requires complete observations")
    output = record["ts_output"]
    issued_at = datetime.fromisoformat(record["issued_at"])
    if issued_at.tzinfo is None:
        raise TSSettlementError("Swing scorecard forecast time is not aware")
    symbol_results: dict[str, dict[str, Any]] = {}
    for symbol in SYMBOLS:
        eligible = [
            bar
            for bar in observations["symbols"][symbol]
            if datetime.fromisoformat(bar["closed_at"]) - timedelta(minutes=5)
            >= issued_at
        ]
        if not eligible:
            raise TSSettlementError("Swing scorecard has no post-forecast bars")
        entry = float(eligible[0]["open"])
        maximum = max(eligible, key=lambda item: float(item["high"]))
        minimum = min(eligible, key=lambda item: float(item["low"]))
        last = eligible[-1]
        upside = (float(maximum["high"]) / entry - 1) * 100
        downside = (float(minimum["low"]) / entry - 1) * 100
        close_return = (float(last["close"]) / entry - 1) * 100
        direction = output["symbol_outlooks"][symbol]["direction"]
        if direction == "BULLISH":
            favorable = upside
            adverse = downside
        elif direction == "BEARISH":
            favorable = -downside
            adverse = -upside
        else:
            favorable = None
            adverse = None
        max_at = datetime.fromisoformat(maximum["closed_at"])
        min_at = datetime.fromisoformat(minimum["closed_at"])
        first_extreme = (
            "HIGH_FIRST"
            if max_at < min_at
            else "LOW_FIRST"
            if min_at < max_at
            else "SAME_BAR_UNRESOLVED"
        )
        first_closed_at = datetime.fromisoformat(eligible[0]["closed_at"])
        symbol_results[symbol] = {
            "forecast_direction": direction,
            "entry_price": entry,
            "entry_at": (first_closed_at - timedelta(minutes=5)).isoformat(),
            "max_price": float(maximum["high"]),
            "max_bar_closed_at": maximum["closed_at"],
            "min_price": float(minimum["low"]),
            "min_bar_closed_at": minimum["closed_at"],
            "close_price": float(last["close"]),
            "close_at": last["closed_at"],
            "upside_excursion_pct": round(upside, 6),
            "downside_excursion_pct": round(downside, 6),
            "close_return_pct": round(close_return, 6),
            "favorable_excursion_pct": (
                None if favorable is None else round(favorable, 6)
            ),
            "adverse_excursion_pct": (
                None if adverse is None else round(adverse, 6)
            ),
            "first_extreme": first_extreme,
        }
    body = {
        "contract_version": "v1",
        "component": "TS_SWING_SCORECARD",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "report_type": record["report_type"],
        "forecast_window": output["forecast_window"],
        "measured_at": observations["window_end"],
        "holding_style": "MANUAL_SINGLE_LEG_0_TO_15_DTE",
        "execution_scope": "READ_ONLY_NO_ORDER_ACTION",
        "forecast_role": "FORMAL_SLOT",
        "eligibility": "OFFICIAL_CALIBRATION",
        "option_execution_evidence": (
            "NOT_INFERRED_WITHOUT_MANUAL_POSITION"
        ),
        "source_observation_hash": observations["observation_hash"],
        "symbols": symbol_results,
    }
    return {**body, "scorecard_hash": sha256_json(body)}


def _swing_scorecard(
    record: dict[str, Any],
    observations: dict[str, Any],
) -> dict[str, Any]:
    result = _calculate_swing_scorecard(record, observations)
    _validate_swing_scorecard(result, record, observations)
    return result


def _validate_swing_scorecard(
    value: Any,
    record: dict[str, Any],
    observations: dict[str, Any],
) -> None:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "report_type",
        "forecast_window",
        "measured_at",
        "holding_style",
        "execution_scope",
        "forecast_role",
        "eligibility",
        "option_execution_evidence",
        "source_observation_hash",
        "symbols",
        "scorecard_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSSettlementError("Invalid TS swing scorecard")
    if not isinstance(observations, dict):
        raise TSSettlementError("Invalid TS swing observations")
    observation_body = {
        key: item
        for key, item in observations.items()
        if key != "observation_hash"
    }
    if (
        observations.get("component") != "TS_FORECAST_OBSERVATIONS"
        or observations.get("complete") is not True
        or observations.get("forecast_run_id") != record["forecast_run_id"]
        or observations.get("forecast_hash") != record["forecast_hash"]
        or observations.get("observation_hash")
        != sha256_json(observation_body)
    ):
        raise TSSettlementError("Invalid TS swing observations")
    body = {key: item for key, item in value.items() if key != "scorecard_hash"}
    if (
        value["contract_version"] != "v1"
        or value["component"] != "TS_SWING_SCORECARD"
        or RUN_ID_RE.fullmatch(str(value["forecast_run_id"])) is None
        or HASH_RE.fullmatch(str(value["forecast_hash"])) is None
        or HASH_RE.fullmatch(str(value["source_observation_hash"])) is None
        or value["scorecard_hash"] != sha256_json(body)
        or value["forecast_run_id"] != record["forecast_run_id"]
        or value["forecast_hash"] != record["forecast_hash"]
        or value["report_type"] != record["report_type"]
        or value["forecast_window"] != record["ts_output"]["forecast_window"]
        or value["source_observation_hash"]
        != observations["observation_hash"]
        or value["measured_at"] != observations["window_end"]
        or value["holding_style"] != "MANUAL_SINGLE_LEG_0_TO_15_DTE"
        or value["execution_scope"] != "READ_ONLY_NO_ORDER_ACTION"
        or value["forecast_role"] != "FORMAL_SLOT"
        or value["eligibility"] != "OFFICIAL_CALIBRATION"
        or value["option_execution_evidence"]
        != "NOT_INFERRED_WITHOUT_MANUAL_POSITION"
        or set(value["symbols"]) != set(SYMBOLS)
    ):
        raise TSSettlementError("Invalid TS swing scorecard identity")
    _aware_scorecard_time(value["measured_at"], "scorecard measured_at")
    for symbol in SYMBOLS:
        item = value["symbols"][symbol]
        if not isinstance(item, dict) or set(item) != SWING_SYMBOL_FIELDS:
            raise TSSettlementError("Invalid TS swing symbol result")
        direction = item["forecast_direction"]
        prices = [
            item[name]
            for name in (
                "entry_price",
                "max_price",
                "min_price",
                "close_price",
            )
        ]
        excursions = [
            item[name]
            for name in (
                "upside_excursion_pct",
                "downside_excursion_pct",
                "close_return_pct",
            )
        ]
        if (
            direction not in {"BULLISH", "BEARISH", "RANGE"}
            or direction
            != record["ts_output"]["symbol_outlooks"][symbol]["direction"]
            or any(
                isinstance(number, bool)
                or not isinstance(number, (int, float))
                or not math.isfinite(number)
                or number <= 0
                for number in prices
            )
            or any(
                isinstance(number, bool)
                or not isinstance(number, (int, float))
                or not math.isfinite(number)
                for number in excursions
            )
            or item["upside_excursion_pct"] < 0
            or item["downside_excursion_pct"] > 0
            or item["first_extreme"]
            not in {"HIGH_FIRST", "LOW_FIRST", "SAME_BAR_UNRESOLVED"}
        ):
            raise TSSettlementError("Invalid TS swing symbol values")
        for name in (
            "entry_at",
            "max_bar_closed_at",
            "min_bar_closed_at",
            "close_at",
        ):
            _aware_scorecard_time(item[name], f"scorecard {name}")
        directional = [
            item["favorable_excursion_pct"],
            item["adverse_excursion_pct"],
        ]
        if direction == "RANGE":
            if directional != [None, None]:
                raise TSSettlementError("Range scorecard has directional P&L")
        elif any(
            isinstance(number, bool)
            or not isinstance(number, (int, float))
            or not math.isfinite(number)
            for number in directional
        ):
            raise TSSettlementError("Directional scorecard has invalid excursion")
    if value != _calculate_swing_scorecard(record, observations):
        raise TSSettlementError(
            "TS swing scorecard differs from bound observations"
        )


def _archive_swing_scorecard(
    root: Path,
    value: dict[str, Any],
    record: dict[str, Any],
    observations: dict[str, Any],
) -> dict[str, Any]:
    _validate_swing_scorecard(value, record, observations)
    path = root / SWING_SCORECARD_PATH / f"{record['forecast_run_id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
    except FileExistsError:
        existing = _read_scorecard(path)
        if existing != value:
            raise TSSettlementError(
                f"Immutable TS swing scorecard differs: {path.name}"
            )
    return value


def swing_scorecard_records(
    root: Path,
    *,
    records: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    try:
        with calibration_archive_lock(root):
            forecasts = {
                record["forecast_run_id"]: record
                for record in (
                    eligible_forecast_records(root)
                    if records is None
                    else records
                )
            }
            values = []
            for path in sorted(
                (root / SWING_SCORECARD_PATH).glob("*.json")
            ):
                value = _read_scorecard(path)
                run_id = (
                    value.get("forecast_run_id")
                    if isinstance(value, dict)
                    else None
                )
                record = forecasts.get(run_id)
                if record is None or path.stem != run_id:
                    raise TSSettlementError(
                        "TS swing scorecard has no official forecast"
                    )
                observation_path = root / "observations" / f"{run_id}.json"
                observations = _read_scorecard(observation_path)
                _validate_swing_scorecard(value, record, observations)
                values.append(value)
            return values
    except TSCalibrationError as exc:
        raise TSSettlementError(str(exc)) from exc


def _aware_scorecard_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise TSSettlementError(f"Invalid {label}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TSSettlementError(f"Invalid {label}") from exc
    if parsed.tzinfo is None:
        raise TSSettlementError(f"Invalid {label}")
    return parsed


def _read_scorecard(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TSSettlementError(f"Invalid TS swing artifact: {path.name}") from exc
