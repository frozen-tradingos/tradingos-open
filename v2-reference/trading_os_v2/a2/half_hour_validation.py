from __future__ import annotations

import math
import os
import tempfile
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from statistics import fmean
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import (
    atomic_write_json,
    canonical_json,
    iso_now,
    read_json,
    sha256_json,
)


CONTRACT_VERSION = "v1"
COMPONENT = "A2_HALF_HOUR_HISTORICAL_VALIDATION"
MODE = "SHADOW"
MODEL_VERSION = "price-continuation-proxy-v2"
SYMBOLS = {"SPY", "QQQ"}
CLASSES = ("UP", "DOWN", "RANGE")
PT_ZONE = ZoneInfo("America/Los_Angeles")
BAR_INTERVAL = timedelta(minutes=5)
ISSUE_INTERVAL = timedelta(minutes=15)
HORIZON_BARS = 6
ISSUE_START = time(7, 0)
ISSUE_END = time(12, 30)

MIN_TRADING_DAYS = 20
MIN_NON_OVERLAPPING_SAMPLES = 200
MIN_ACTUAL_CLASS_SAMPLES = 30
MIN_RELATIVE_BRIER_IMPROVEMENT = 0.10
# Three-class chance level is 1/3; 0.45 requires material lift without
# pretending that this price-only shadow proxy is production-calibrated.
RECOMMENDED_BALANCED_ACCURACY_MIN = 0.45
REQUIRED_WALK_FORWARD_WINDOWS = 2
INITIAL_PRIOR_TRADING_DAYS = 10
REQUIRED_PROSPECTIVE_UNTOUCHED_DAYS = 20

PREDICTED_CLASS_PROBABILITY = 0.60
RANGE_BAR_MULTIPLIER = 0.50
MIN_RANGE_FRACTION_OF_PRICE = 0.00025


class HalfHourValidationError(RuntimeError):
    pass


def evaluate_history_dataset(dataset: dict[str, Any]) -> dict[str, Any]:
    required = {
        "contract_version",
        "source",
        "interval",
        "symbols",
        "start_date",
        "end_date",
        "source_hashes",
        "records",
        "data_hash",
    }
    if not isinstance(dataset, dict) or set(dataset) != required:
        raise HalfHourValidationError("market history dataset contract is invalid")
    if (
        dataset.get("contract_version") != CONTRACT_VERSION
        or dataset.get("source") != "tradier"
        or dataset.get("interval") != "5min"
        or not isinstance(dataset.get("symbols"), list)
        or len(dataset["symbols"]) != 1
        or dataset["symbols"][0] not in SYMBOLS
        or not isinstance(dataset.get("source_hashes"), list)
        or not all(
            isinstance(value, str)
            and len(value) == 64
            and set(value) <= set("0123456789abcdef")
            for value in dataset["source_hashes"]
        )
        or not isinstance(dataset.get("records"), list)
    ):
        raise HalfHourValidationError("market history dataset boundary is invalid")
    body = {key: value for key, value in dataset.items() if key != "data_hash"}
    if sha256_json(body) != dataset["data_hash"]:
        raise HalfHourValidationError("market history dataset hash mismatch")
    symbol = dataset["symbols"][0]
    if any(
        not isinstance(row, dict) or row.get("symbol") != symbol
        for row in dataset["records"]
    ):
        raise HalfHourValidationError("market history record symbol mismatch")
    return evaluate_price_only_history(
        contract_version=CONTRACT_VERSION,
        symbol=symbol,
        bars=dataset["records"],
    )


def archive_history_validation(
    root: Path,
    dataset: dict[str, Any],
) -> dict[str, Any]:
    result = evaluate_history_dataset(dataset)
    body = {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "source_dataset_hash": dataset["data_hash"],
        "validation": result,
    }
    record = {**body, "validation_hash": sha256_json(body)}
    symbol = result["symbol"]
    path = (
        root
        / "a2"
        / "half_hour_validation"
        / symbol
        / dataset["data_hash"]
        / f"{record['validation_hash']}.json"
    )
    _write_once(path, record)
    manifest_body = {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "updated_at": iso_now(),
        "symbol": symbol,
        "source_dataset_hash": dataset["data_hash"],
        "validation_hash": record["validation_hash"],
        "path": str(path),
        "eligible_for_owner_review": result["activation_gate"][
            "eligible_for_owner_review"
        ],
    }
    manifest = {
        **manifest_body,
        "manifest_hash": sha256_json(manifest_body),
    }
    atomic_write_json(
        root
        / "a2"
        / "half_hour_validation"
        / f"latest-{symbol}.json",
        manifest,
    )
    return {**record, "path": str(path)}


def evaluate_price_only_history(
    *,
    contract_version: str,
    symbol: str,
    bars: list[dict[str, Any]],
) -> dict[str, Any]:
    """Evaluate a causal, price-only proxy without changing the live SHADOW mode."""

    if contract_version != CONTRACT_VERSION:
        raise HalfHourValidationError("拒绝未知A2历史验证合同版本")
    if symbol not in SYMBOLS:
        raise HalfHourValidationError("A2历史验证只支持SPY或QQQ")

    normalized = _normalize_bars(bars)
    sessions = _group_sessions(normalized)
    _require_complete_sessions(sessions)
    issuances: list[dict[str, Any]] = []
    expected_issuances = len(sessions) * _slots_per_day(ISSUE_INTERVAL)
    expected_non_overlapping = len(sessions) * _slots_per_day(
        timedelta(minutes=30)
    )

    for session_date, session_bars in sessions.items():
        by_time = {
            datetime.fromisoformat(row["start_at"]): row for row in session_bars
        }
        for slot in _issue_slots(session_date):
            sample = _sample_at(by_time, slot)
            if sample is not None:
                issuances.append(sample)

    historical_samples = [
        sample
        for sample in issuances
        if _minutes_since_issue_start(sample["slot_at"]) % 30 == 0
    ]
    walk_forward = _walk_forward(historical_samples)
    metrics = walk_forward["metrics"]
    trading_days = len(sessions)
    evaluated_samples = walk_forward["sample_count"]
    checks = {
        "minimum_trading_days": trading_days >= MIN_TRADING_DAYS,
        "minimum_non_overlapping_samples": (
            evaluated_samples >= MIN_NON_OVERLAPPING_SAMPLES
        ),
        "minimum_actual_class_samples": all(
            metrics["by_class"][label]["actual_count"]
            >= MIN_ACTUAL_CLASS_SAMPLES
            for label in CLASSES
        ),
        "minimum_relative_brier_improvement": (
            metrics["relative_brier_improvement"] is not None
            and metrics["relative_brier_improvement"]
            >= MIN_RELATIVE_BRIER_IMPROVEMENT
        ),
        "minimum_balanced_accuracy": (
            metrics["balanced_accuracy"] is not None
            and metrics["balanced_accuracy"]
            >= RECOMMENDED_BALANCED_ACCURACY_MIN
        ),
        "two_consecutive_walk_forward_windows": (
            walk_forward["consecutive_pass_count"]
            >= REQUIRED_WALK_FORWARD_WINDOWS
        ),
        "validates_live_model": False,
        "minimum_prospective_untouched_days": False,
    }
    data_payload = {
        "contract_version": CONTRACT_VERSION,
        "symbol": symbol,
        "interval": "5min",
        "bars": normalized,
    }
    return {
        "contract_version": CONTRACT_VERSION,
        "component": COMPONENT,
        "mode": MODE,
        "actionable": False,
        "status": "EVALUATED",
        "symbol": symbol,
        "model_version": MODEL_VERSION,
        "validates_live_model": False,
        "historical_diagnostic_only": True,
        "research_dataset_touched": True,
        "prospective_untouched_day_count": 0,
        "data_basis": {
            "price_history": "COMPLETE_CLOSED_5M_INPUT",
            "option_chain_history": "NOT_PROVIDED",
            "option_flow_included": False,
            "scope": "PRICE_ONLY",
            "note": "仅验证价格延续代理，不包含历史期权链或期权流",
        },
        "schedule": {
            "timezone": "America/Los_Angeles",
            "first_issue": "07:00",
            "last_issue": "12:30",
            "cadence_minutes": 15,
            "horizon_bars": HORIZON_BARS,
            "horizon_minutes": 30,
            "evaluation_stride_minutes": 30,
        },
        "data_hash": sha256_json(data_payload),
        "trading_day_count": trading_days,
        "prior_trading_day_count": walk_forward["prior_trading_day_count"],
        "evaluated_trading_day_count": walk_forward[
            "evaluated_trading_day_count"
        ],
        "issued_sample_count": len(issuances),
        "historical_sample_count": len(historical_samples),
        "sample_count": evaluated_samples,
        "coverage": _ratio(len(issuances), expected_issuances),
        "non_overlapping_coverage": _ratio(
            len(historical_samples), expected_non_overlapping
        ),
        "evaluation_coverage": walk_forward["coverage"],
        "metrics": metrics,
        "walk_forward": walk_forward,
        "activation_gate": {
            "effect": "EVALUATION_ONLY",
            "eligible_for_owner_review": all(checks.values()),
            "mode_after_evaluation": MODE,
            "actionable_after_evaluation": False,
            "checks": checks,
            "thresholds": {
                "minimum_trading_days": MIN_TRADING_DAYS,
                "minimum_non_overlapping_samples": (
                    MIN_NON_OVERLAPPING_SAMPLES
                ),
                "minimum_actual_class_samples": MIN_ACTUAL_CLASS_SAMPLES,
                "minimum_relative_brier_improvement": (
                    MIN_RELATIVE_BRIER_IMPROVEMENT
                ),
                "recommended_balanced_accuracy_min": (
                    RECOMMENDED_BALANCED_ACCURACY_MIN
                ),
                "required_consecutive_walk_forward_windows": (
                    REQUIRED_WALK_FORWARD_WINDOWS
                ),
                "initial_prior_trading_days": INITIAL_PRIOR_TRADING_DAYS,
                "walk_forward_window_samples": _slots_per_day(
                    timedelta(minutes=30)
                ),
                "required_prospective_untouched_days": (
                    REQUIRED_PROSPECTIVE_UNTOUCHED_DAYS
                ),
            },
        },
    }


def _normalize_bars(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows:
        raise HalfHourValidationError("缺少5分钟历史bar")

    normalized: list[dict[str, Any]] = []
    previous: datetime | None = None
    for row in rows:
        if not isinstance(row, dict):
            raise HalfHourValidationError("历史bar必须是对象")
        started = _bar_time(row)
        if started.second or started.microsecond or started.minute % 5:
            raise HalfHourValidationError("历史bar时间未对齐5分钟")
        if previous is not None:
            if started == previous:
                raise HalfHourValidationError("历史bar时间重复")
            if started < previous:
                raise HalfHourValidationError("历史bar时间错序")
            if (
                started.astimezone(PT_ZONE).date()
                == previous.astimezone(PT_ZONE).date()
                and started - previous != BAR_INTERVAL
            ):
                raise HalfHourValidationError("交易日内缺少连续5分钟bar")
        previous = started

        local = started.astimezone(PT_ZONE)
        minute = local.hour * 60 + local.minute
        if not 6 * 60 + 30 <= minute < 13 * 60:
            raise HalfHourValidationError("历史bar不在常规交易时段")
        if "session_date" in row and row["session_date"] != local.date().isoformat():
            raise HalfHourValidationError("历史bar交易日与时间不一致")

        values = {
            name: _finite_number(row.get(name), name)
            for name in ("open", "high", "low", "close", "volume")
        }
        opening = values["open"]
        high = values["high"]
        low = values["low"]
        close = values["close"]
        volume = values["volume"]
        if (
            min(opening, high, low, close) <= 0
            or high < max(opening, close, low)
            or low > min(opening, close, high)
            or volume < 0
        ):
            raise HalfHourValidationError("历史bar OHLCV关系无效")
        normalized.append(
            {
                "start_at": started.isoformat(),
                "session_date": local.date().isoformat(),
                "open": opening,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )
    return normalized


def _bar_time(row: dict[str, Any]) -> datetime:
    values: list[datetime] = []
    for field in ("start_at", "time"):
        value = row.get(field)
        if value in (None, ""):
            continue
        try:
            parsed = datetime.fromisoformat(str(value))
        except ValueError as exc:
            raise HalfHourValidationError("历史bar时间无效") from exc
        if parsed.tzinfo is None:
            raise HalfHourValidationError(
                "historical bar time must include timezone"
            )
        values.append(parsed.astimezone(UTC))

    timestamp = row.get("timestamp")
    if timestamp not in (None, ""):
        number = _finite_number(timestamp, "timestamp")
        if number <= 0:
            raise HalfHourValidationError("历史bar时间无效")
        try:
            values.append(datetime.fromtimestamp(number, UTC))
        except (OSError, OverflowError, ValueError) as exc:
            raise HalfHourValidationError("历史bar时间无效") from exc

    if not values:
        raise HalfHourValidationError("历史bar缺少时间")
    if any(value != values[0] for value in values[1:]):
        raise HalfHourValidationError("历史bar多个时间字段不一致")
    return values[0]


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise HalfHourValidationError(f"历史bar缺少有效{field}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise HalfHourValidationError(f"历史bar缺少有效{field}") from exc
    if not math.isfinite(number):
        raise HalfHourValidationError(f"历史bar {field}不是有限数")
    return number


def _group_sessions(
    bars: list[dict[str, Any]],
) -> dict[date, list[dict[str, Any]]]:
    sessions: dict[date, list[dict[str, Any]]] = {}
    for row in bars:
        session_date = date.fromisoformat(row["session_date"])
        sessions.setdefault(session_date, []).append(row)
    return sessions


def _require_complete_sessions(
    sessions: dict[date, list[dict[str, Any]]],
) -> None:
    for session_date, rows in sessions.items():
        local_times = [
            datetime.fromisoformat(row["start_at"]).astimezone(PT_ZONE).time()
            for row in rows
        ]
        if (
            len(rows) != 78
            or local_times[0] != time(6, 30)
            or local_times[-1] != time(12, 55)
        ):
            raise HalfHourValidationError(
                f"{session_date.isoformat()} is not a complete regular session"
            )


def _issue_slots(session_date: date) -> list[datetime]:
    start = datetime.combine(session_date, ISSUE_START, PT_ZONE)
    end = datetime.combine(session_date, ISSUE_END, PT_ZONE)
    slots: list[datetime] = []
    current = start
    while current <= end:
        slots.append(current.astimezone(UTC))
        current += ISSUE_INTERVAL
    return slots


def _sample_at(
    by_time: dict[datetime, dict[str, Any]],
    slot: datetime,
) -> dict[str, Any] | None:
    history_times = [
        slot - timedelta(minutes=30) + index * BAR_INTERVAL
        for index in range(HORIZON_BARS)
    ]
    future_times = [
        slot + index * BAR_INTERVAL for index in range(HORIZON_BARS)
    ]
    if any(value not in by_time for value in history_times + future_times):
        return None

    history = [by_time[value] for value in history_times]
    future = [by_time[value] for value in future_times]
    anchor = history[-1]["close"]
    range_threshold = max(
        fmean(row["high"] - row["low"] for row in history)
        * RANGE_BAR_MULTIPLIER,
        anchor * MIN_RANGE_FRACTION_OF_PRICE,
    )
    predicted = _direction(history[-1]["close"] - history[0]["close"], range_threshold)
    actual = _direction(future[-1]["close"] - anchor, range_threshold)
    probabilities = {
        label: (
            PREDICTED_CLASS_PROBABILITY
            if label == predicted
            else (1 - PREDICTED_CLASS_PROBABILITY) / (len(CLASSES) - 1)
        )
        for label in CLASSES
    }
    return {
        "slot_at": slot.isoformat(),
        "predicted": predicted,
        "actual": actual,
        "probabilities": probabilities,
        "target_bar_count": len(future),
        "target_bar_hash": sha256_json(future),
    }


def _direction(move: float, threshold: float) -> str:
    return "UP" if move > threshold else "DOWN" if move < -threshold else "RANGE"


def _metrics(samples: list[dict[str, Any]]) -> dict[str, Any]:
    matrix = {
        actual: {predicted: 0 for predicted in CLASSES} for actual in CLASSES
    }
    for sample in samples:
        matrix[sample["actual"]][sample["predicted"]] += 1

    count = len(samples)
    actual_counts = {
        label: sum(matrix[label].values()) for label in CLASSES
    }
    predicted_counts = {
        label: sum(matrix[actual][label] for actual in CLASSES)
        for label in CLASSES
    }
    recalls = [
        matrix[label][label] / actual_counts[label]
        for label in CLASSES
        if actual_counts[label]
    ]
    balanced_accuracy = fmean(recalls) if recalls else None
    brier = (
        fmean(
            sum(
                (
                    sample["probabilities"][label]
                    - (1.0 if sample["actual"] == label else 0.0)
                )
                ** 2
                for label in CLASSES
            )
            for sample in samples
        )
        if samples
        else None
    )
    base_rates = {
        label: (
            fmean(
                _causal_base_rate_probabilities(sample)[label]
                for sample in samples
            )
            if samples
            else 0.0
        )
        for label in CLASSES
    }
    base_rate_brier = (
        fmean(
            sum(
                (
                    _causal_base_rate_probabilities(sample)[label]
                    - (1.0 if sample["actual"] == label else 0.0)
                )
                ** 2
                for label in CLASSES
            )
            for sample in samples
        )
        if samples
        else None
    )
    relative_improvement = (
        (base_rate_brier - brier) / base_rate_brier
        if brier is not None and base_rate_brier not in (None, 0.0)
        else None
    )
    majority_class = (
        max(CLASSES, key=lambda label: actual_counts[label]) if count else None
    )
    by_class: dict[str, dict[str, Any]] = {}
    for label in CLASSES:
        true_positive = matrix[label][label]
        by_class[label] = {
            "actual_count": actual_counts[label],
            "predicted_count": predicted_counts[label],
            "true_positive": true_positive,
            "recall": _rounded_ratio(true_positive, actual_counts[label]),
            "precision": _rounded_ratio(true_positive, predicted_counts[label]),
            "one_vs_rest_brier": (
                _round(
                    fmean(
                        (
                            sample["probabilities"][label]
                            - (1.0 if sample["actual"] == label else 0.0)
                        )
                        ** 2
                        for sample in samples
                    )
                )
                if samples
                else None
            ),
        }

    return {
        "confusion_matrix": {
            "orientation": "rows=actual, columns=predicted",
            "values": matrix,
        },
        "balanced_accuracy": _round(balanced_accuracy),
        "brier": _round(brier),
        "base_rate_probabilities": {
            label: _round(base_rates[label]) for label in CLASSES
        },
        "base_rate_probability_basis": "PRIOR_COMPLETE_TRADING_DAYS_ONLY",
        "majority_class": majority_class,
        "majority_class_base_rate": (
            _round(base_rates[majority_class]) if majority_class else None
        ),
        "base_rate_brier": _round(base_rate_brier),
        "relative_brier_improvement": _round(relative_improvement),
        "by_class": by_class,
    }


def _walk_forward(samples: list[dict[str, Any]]) -> dict[str, Any]:
    by_day: dict[date, list[dict[str, Any]]] = {}
    for sample in sorted(samples, key=lambda value: value["slot_at"]):
        started = datetime.fromisoformat(sample["slot_at"])
        if started.tzinfo is None:
            raise HalfHourValidationError(
                "walk-forward sample time must include timezone"
            )
        session_date = started.astimezone(PT_ZONE).date()
        by_day.setdefault(session_date, []).append(sample)

    samples_per_day = _slots_per_day(timedelta(minutes=30))
    if any(len(day_samples) != samples_per_day for day_samples in by_day.values()):
        raise HalfHourValidationError(
            "walk-forward requires complete non-overlapping trading days"
        )

    ordered_days = sorted(by_day)
    prior_days = ordered_days[:INITIAL_PRIOR_TRADING_DAYS]
    windows: list[dict[str, Any]] = []
    evaluated: list[dict[str, Any]] = []
    prior_samples = [
        sample for session_date in prior_days for sample in by_day[session_date]
    ]
    for session_date in ordered_days[INITIAL_PRIOR_TRADING_DAYS:]:
        base_rate_probabilities = _class_probabilities(prior_samples)
        chunk = [
            {
                **sample,
                "base_rate_probabilities": base_rate_probabilities,
            }
            for sample in by_day[session_date]
        ]
        metrics = _metrics(chunk)
        passed = (
            all(
                metrics["by_class"][label]["actual_count"] > 0
                for label in CLASSES
            )
            and metrics["balanced_accuracy"] is not None
            and metrics["balanced_accuracy"]
            >= RECOMMENDED_BALANCED_ACCURACY_MIN
            and metrics["relative_brier_improvement"] is not None
            and metrics["relative_brier_improvement"]
            >= MIN_RELATIVE_BRIER_IMPROVEMENT
        )
        windows.append(
            {
                "window": len(windows) + 1,
                "evaluation_date": session_date.isoformat(),
                "training_day_count": len(prior_days),
                "training_sample_count": len(prior_samples),
                "sample_count": len(chunk),
                "first_slot_at": chunk[0]["slot_at"],
                "last_slot_at": chunk[-1]["slot_at"],
                "base_rate_probabilities": base_rate_probabilities,
                "balanced_accuracy": metrics["balanced_accuracy"],
                "brier": metrics["brier"],
                "base_rate_brier": metrics["base_rate_brier"],
                "relative_brier_improvement": metrics[
                    "relative_brier_improvement"
                ],
                "actual_class_counts": {
                    label: metrics["by_class"][label]["actual_count"]
                    for label in CLASSES
                },
                "passed": passed,
            }
        )
        evaluated.extend(chunk)
        prior_days.append(session_date)
        prior_samples.extend(by_day[session_date])

    consecutive = 0
    for window in reversed(windows):
        if not window["passed"]:
            break
        consecutive += 1
    return {
        "initial_prior_trading_days": INITIAL_PRIOR_TRADING_DAYS,
        "prior_trading_day_count": min(
            len(ordered_days), INITIAL_PRIOR_TRADING_DAYS
        ),
        "evaluated_trading_day_count": len(windows),
        "sample_count": len(evaluated),
        "expected_sample_count": len(windows) * samples_per_day,
        "coverage": _ratio(
            len(evaluated), len(windows) * samples_per_day
        ),
        "window_sample_count": samples_per_day,
        "required_consecutive_windows": REQUIRED_WALK_FORWARD_WINDOWS,
        "windows": windows,
        "metrics": _metrics(evaluated),
        "consecutive_pass_count": consecutive,
        "passed": consecutive >= REQUIRED_WALK_FORWARD_WINDOWS,
    }


def _class_probabilities(samples: list[dict[str, Any]]) -> dict[str, float]:
    if not samples:
        raise HalfHourValidationError(
            "walk-forward requires prior complete trading days"
        )
    counts = {
        label: sum(sample["actual"] == label for sample in samples)
        for label in CLASSES
    }
    return {
        label: counts[label] / len(samples)
        for label in CLASSES
    }


def _causal_base_rate_probabilities(
    sample: dict[str, Any],
) -> dict[str, float]:
    probabilities = sample.get("base_rate_probabilities")
    if (
        not isinstance(probabilities, dict)
        or set(probabilities) != set(CLASSES)
    ):
        raise HalfHourValidationError(
            "metrics require prior-day base-rate probabilities"
        )
    values = {
        label: _finite_number(probabilities[label], label)
        for label in CLASSES
    }
    if (
        any(value < 0 or value > 1 for value in values.values())
        or not math.isclose(sum(values.values()), 1.0, abs_tol=1e-9)
    ):
        raise HalfHourValidationError(
            "prior-day base-rate probabilities are invalid"
        )
    return values


def _slots_per_day(interval: timedelta) -> int:
    start = datetime.combine(date.min, ISSUE_START)
    end = datetime.combine(date.min, ISSUE_END)
    return int((end - start) / interval) + 1


def _minutes_since_issue_start(value: str) -> int:
    local = datetime.fromisoformat(value).astimezone(PT_ZONE)
    return (local.hour * 60 + local.minute) - (
        ISSUE_START.hour * 60 + ISSUE_START.minute
    )


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 0.0


def _rounded_ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def _round(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None


def _write_once(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if read_json(path, None) != value:
            raise HalfHourValidationError(
                f"refusing to overwrite validation record: {path}"
            )
        return
    handle, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(canonical_json(value))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if read_json(path, None) != value:
                raise HalfHourValidationError(
                    f"conflicting validation record exists: {path}"
                )
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
