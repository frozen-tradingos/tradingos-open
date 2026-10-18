from __future__ import annotations

import json
import math
import re
import threading
import time
from copy import deepcopy
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import atomic_write_json, sha256_json
from trading_os_v2.common.lock import AlreadyRunning, ProcessLock


SYMBOLS = ("SPY", "QQQ")
SCENARIOS = ("main", "reverse", "extreme")
INTRADAY_REPORTS = {
    "OPENING_FORECAST",
    "OPEN_15M_CHECK",
    "OPEN_30M_CHECK",
    "INTRADAY_30_60M",
}
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{10}$")
RELEASE_COMMIT_RE = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
COHORT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
MESSAGE_ID_RE = re.compile(r"^[0-9]+$")
DIRECTION_RANGE_TOLERANCE_PCT = 0.05
SETTLEMENT_VERSION = "v3"
LEGACY_SETTLEMENT_VERSION = "v2"
SETTLEMENT_MIGRATION_ID = "ts-forecast-settlement-v2-to-v3"
SETTLEMENT_MIGRATION_PATH = (
    Path("migrations") / f"{SETTLEMENT_MIGRATION_ID}.json"
)
ACTIVE_SETTLEMENT_PATH = Path("settlements") / SETTLEMENT_VERSION
LEGACY_SETTLEMENT_PATH = Path("settlements")
PT_ZONE = ZoneInfo("America/Los_Angeles")
CONFIRMATION_MINUTES = {
    "LIVE_QUOTE": 5,
    "ONE_5M_CLOSE": 5,
    "ONE_15M_CLOSE": 15,
    "ONE_30M_CLOSE": 30,
}
FORECAST_HORIZONS = {
    "NEXT_REGULAR_SESSION",
    "NEXT_REGULAR_SESSION_AND_WEEK",
    "OPEN_TO_60_MINUTES",
    "NEXT_30_TO_60_MINUTES",
}
PROVENANCE_CONTEXT_FIELDS = {
    "cohort_id",
    "forecast_role",
    "official_slot",
    "delivery_proof",
    "ownership_proof",
    "parent_forecast_hash",
    "eligibility",
    "exclusion_reason",
}
PROVENANCE_ROLES = {
    "FORMAL_SLOT",
    "MATERIAL_REVISION",
    "UNDELIVERED_DRAFT",
    "TEST",
}
PROVENANCE_EXCLUSION_REASONS = {
    "LEGACY_COHORT",
    "MATERIAL_REVISION",
    "UNDELIVERED_DRAFT",
    "TEST_EVENT",
}
PROVENANCE_PATH = Path("provenance")
PROVENANCE_MANIFEST_PATH = (
    Path("state") / "ts-calibration-provenance-manifest.json"
)
CALIBRATION_PARTITION_PATH = Path("calibration-partitions")


class TSCalibrationError(RuntimeError):
    pass


_ARCHIVE_THREAD_LOCK = threading.RLock()
_ARCHIVE_DEPTH = threading.local()
_ARCHIVE_LOCK_TIMEOUT_SECONDS = 30.0


@contextmanager
def calibration_archive_lock(root: Path) -> Iterator[None]:
    key = str(root.resolve())
    with _ARCHIVE_THREAD_LOCK:
        depths = getattr(_ARCHIVE_DEPTH, "values", None)
        if depths is None:
            depths = {}
            _ARCHIVE_DEPTH.values = depths
        if depths.get(key, 0):
            depths[key] += 1
            try:
                yield
            finally:
                depths[key] -= 1
            return

        deadline = time.monotonic() + _ARCHIVE_LOCK_TIMEOUT_SECONDS
        lock = ProcessLock(root / "state" / "forecast-archive.lock")
        while True:
            try:
                lock.__enter__()
                break
            except AlreadyRunning as exc:
                if time.monotonic() >= deadline:
                    raise TSCalibrationError("TS forecast archive is busy") from exc
                time.sleep(0.05)
        depths[key] = 1
        try:
            yield
        finally:
            depths.pop(key, None)
            lock.__exit__(None, None, None)


def forecast_hash(output: dict[str, Any]) -> str:
    if output.get("contract_version") != "v2" or output.get("role") != "TS":
        raise TSCalibrationError("TS forecast must use TS_OUTPUT v2")
    return sha256_json(output)


def archive_forecast(
    root: Path,
    output: dict[str, Any],
    *,
    provenance_context: dict[str, Any],
    published_at: datetime | None = None,
) -> dict[str, Any]:
    with calibration_archive_lock(root):
        record = _archive_forecast_locked(
            root,
            output,
            published_at=published_at,
        )
        _archive_provenance_locked(root, record, provenance_context)
        return record


def _archive_forecast_locked(
    root: Path,
    output: dict[str, Any],
    *,
    published_at: datetime | None,
) -> dict[str, Any]:
    digest = forecast_hash(output)
    snapshot = output.get("evidence_snapshot", {})
    run_id = snapshot.get("run_id")
    market_time = snapshot.get("market_time", {})
    if not isinstance(run_id, str) or not run_id:
        raise TSCalibrationError("TS forecast run_id is missing")
    if (
        output.get("report_type") in INTRADAY_REPORTS
        and market_time.get("state") == "POSTMARKET"
    ):
        raise TSCalibrationError("Postmarket output is not an intraday forecast")
    observed_at = _aware(market_time.get("observed_at"), "market observed_at")
    publication_time = published_at or datetime.now(UTC)
    if publication_time.tzinfo is None:
        raise TSCalibrationError("TS forecast publication time is not aware")
    publication_time = publication_time.astimezone(UTC)
    if publication_time < observed_at.astimezone(UTC):
        raise TSCalibrationError("TS forecast publication precedes its evidence")
    record = {
        "contract_version": "v2",
        "component": "TS_FORECAST_RECORD",
        "forecast_run_id": run_id,
        "forecast_hash": digest,
        "issued_at": publication_time.isoformat(),
        "market_date": market_time.get("market_date"),
        "report_type": output.get("report_type"),
        "ts_output": output,
    }
    record["record_hash"] = sha256_json(record)
    _validate_forecast_record(record)
    _write_once(root / "forecasts" / f"{run_id}.json", record)
    inventory = {
        "contract_version": "v2",
        "component": "TS_FORECAST_INVENTORY_ENTRY",
        "forecast_run_id": run_id,
        "forecast_hash": digest,
        "record_hash": record["record_hash"],
        "report_type": record["report_type"],
        "market_date": record["market_date"],
        "issued_at": record["issued_at"],
    }
    inventory["inventory_hash"] = sha256_json(inventory)
    _validate_forecast_inventory(inventory, record)
    _write_once(root / "forecast-inventory" / f"{run_id}.json", inventory)
    _append_forecast_manifest(root, inventory)
    return record


def latest_forecast(
    root: Path,
    *,
    report_type: str | None = None,
    market_date: str | None = None,
    before: datetime | None = None,
) -> dict[str, Any] | None:
    records = []
    for record in forecast_records(root):
        issued_at = _aware(record["issued_at"], "forecast issued_at")
        if report_type is not None and record["report_type"] != report_type:
            continue
        if market_date is not None and record["market_date"] != market_date:
            continue
        if before is not None and issued_at >= before:
            continue
        records.append((issued_at, record))
    return max(records, default=(None, None), key=lambda item: item[0])[1]


def forecast_records(root: Path) -> list[dict[str, Any]]:
    with calibration_archive_lock(root):
        return _forecast_records_locked(root)


def forecast_record_for_run(root: Path, run_id: str) -> dict[str, Any] | None:
    """Return one manifest-bound forecast without requiring global closure."""
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise TSCalibrationError("Invalid TS forecast run id")
    with calibration_archive_lock(root):
        forecast_path = root / "forecasts" / f"{run_id}.json"
        inventory_path = root / "forecast-inventory" / f"{run_id}.json"
        manifest_path = root / "state" / "forecast-inventory-manifest.json"
        if not forecast_path.exists() or not inventory_path.exists():
            return None
        if not manifest_path.exists():
            raise TSCalibrationError("TS forecast inventory manifest is missing")
        record = _read_json(forecast_path)
        _validate_forecast_record(record)
        inventory = _read_json(inventory_path)
        _validate_forecast_inventory(inventory, record)
        expected = _validate_forecast_manifest(_read_json(manifest_path))
        if (
            record["forecast_run_id"] != run_id
            or inventory["forecast_run_id"] != run_id
            or expected.get(run_id) != inventory["inventory_hash"]
        ):
            raise TSCalibrationError("TS forecast filename identity mismatch")
        return record


def _forecast_records_locked(root: Path) -> list[dict[str, Any]]:
    forecast_paths = {
        path.stem: path for path in (root / "forecasts").glob("*.json")
    }
    inventory_paths = {
        path.stem: path
        for path in (root / "forecast-inventory").glob("*.json")
    }
    manifest_path = root / "state" / "forecast-inventory-manifest.json"
    if not forecast_paths and not inventory_paths and not manifest_path.exists():
        return []
    if not manifest_path.exists():
        raise TSCalibrationError("TS forecast inventory manifest is missing")
    manifest = _read_json(manifest_path)
    expected = _validate_forecast_manifest(manifest)
    if (
        set(forecast_paths) != set(inventory_paths)
        or set(forecast_paths) != set(expected)
    ):
        raise TSCalibrationError("TS forecast inventory does not match archive")
    records = []
    for run_id in sorted(forecast_paths):
        record = _read_json(forecast_paths[run_id])
        _validate_forecast_record(record)
        inventory = _read_json(inventory_paths[run_id])
        _validate_forecast_inventory(inventory, record)
        if (
            run_id != record["forecast_run_id"]
            or inventory["inventory_hash"] != expected[run_id]
        ):
            raise TSCalibrationError("TS forecast filename identity mismatch")
        records.append(record)
    return records


def _append_forecast_manifest(
    root: Path,
    inventory: dict[str, Any],
) -> None:
    path = root / "state" / "forecast-inventory-manifest.json"
    entries: list[dict[str, str]] = []
    if path.exists():
        current = _read_json(path)
        _validate_forecast_manifest(current)
        entries = list(current["entries"])
    run_id = inventory["forecast_run_id"]
    existing = {
        item["forecast_run_id"]: item["inventory_hash"] for item in entries
    }
    if run_id in existing:
        if existing[run_id] != inventory["inventory_hash"]:
            raise TSCalibrationError("TS forecast manifest identity differs")
        return
    body = {
        "contract_version": "v2",
        "component": "TS_FORECAST_INVENTORY_MANIFEST",
        "entries": [
            *entries,
            {
                "forecast_run_id": run_id,
                "inventory_hash": inventory["inventory_hash"],
            },
        ],
    }
    value = {**body, "manifest_hash": sha256_json(body)}
    _validate_forecast_manifest(value)
    atomic_write_json(path, value)


def _validate_forecast_manifest(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {
        "contract_version",
        "component",
        "entries",
        "manifest_hash",
    }:
        raise TSCalibrationError("Invalid TS forecast inventory manifest")
    body = {key: item for key, item in value.items() if key != "manifest_hash"}
    entries = value["entries"]
    if (
        value["contract_version"] != "v2"
        or value["component"] != "TS_FORECAST_INVENTORY_MANIFEST"
        or not isinstance(entries, list)
        or not entries
        or value["manifest_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS forecast inventory manifest")
    expected: dict[str, str] = {}
    for item in entries:
        if (
            not isinstance(item, dict)
            or set(item) != {"forecast_run_id", "inventory_hash"}
            or not isinstance(item["forecast_run_id"], str)
            or not item["forecast_run_id"]
            or not HASH_RE.fullmatch(str(item["inventory_hash"]))
            or item["forecast_run_id"] in expected
        ):
            raise TSCalibrationError("Invalid TS forecast manifest entry")
        expected[item["forecast_run_id"]] = item["inventory_hash"]
    return expected


def _archive_provenance_locked(
    root: Path,
    record: dict[str, Any],
    context: dict[str, Any],
) -> dict[str, Any]:
    _validate_forecast_record(record)
    if not isinstance(context, dict) or set(context) != PROVENANCE_CONTEXT_FIELDS:
        raise TSCalibrationError("Invalid TS calibration provenance context")
    output = record["ts_output"]
    snapshot = output.get("evidence_snapshot", {})
    body = {
        "contract_version": "v1",
        "component": "TS_CALIBRATION_PROVENANCE",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "record_hash": record["record_hash"],
        "cohort_id": context["cohort_id"],
        "release_commit": snapshot.get("release_commit"),
        "forecast_role": context["forecast_role"],
        "report_type": record["report_type"],
        "forecast_window": deepcopy(output.get("forecast_window")),
        "official_slot": context["official_slot"],
        "delivery_proof": deepcopy(context["delivery_proof"]),
        "ownership_proof": deepcopy(context["ownership_proof"]),
        "parent_forecast_hash": context["parent_forecast_hash"],
        "eligibility": context["eligibility"],
        "exclusion_reason": context["exclusion_reason"],
    }
    provenance = {**body, "provenance_hash": sha256_json(body)}
    _validate_provenance(provenance, record)
    records = _forecast_records_locked(root)
    update = record["ts_output"].get("forecast_update")
    parent_provenance = (
        _provenance_record_for_run_locked(
            root,
            update.get("prior_run_id"),
            records=records,
        )
        if isinstance(update, dict)
        and isinstance(update.get("prior_run_id"), str)
        else None
    )
    _validate_provenance_parent(
        provenance,
        record=record,
        records=records,
        parent_provenance=parent_provenance,
    )
    run_id = record["forecast_run_id"]
    _write_once(root / PROVENANCE_PATH / f"{run_id}.json", provenance)
    _append_provenance_manifest(root, provenance)
    return provenance


def provenance_records(root: Path) -> list[dict[str, Any]]:
    with calibration_archive_lock(root):
        records = _forecast_records_locked(root)
        return _provenance_records_locked(root, records=records)


def _provenance_records_locked(
    root: Path,
    *,
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    paths = {
        path.stem: path for path in (root / PROVENANCE_PATH).glob("*.json")
    }
    manifest_path = root / PROVENANCE_MANIFEST_PATH
    if not paths and not manifest_path.exists():
        return []
    if not paths or not manifest_path.exists():
        raise TSCalibrationError("TS calibration provenance archive is incomplete")
    expected = _validate_provenance_manifest(_read_json(manifest_path))
    if set(paths) != set(expected):
        raise TSCalibrationError("TS calibration provenance manifest differs")
    forecasts = {record["forecast_run_id"]: record for record in records}
    provenances = []
    for run_id in sorted(paths):
        record = forecasts.get(run_id)
        if record is None:
            raise TSCalibrationError("TS calibration provenance forecast is missing")
        provenance = _read_json(paths[run_id])
        _validate_provenance(provenance, record)
        if (
            provenance["forecast_run_id"] != run_id
            or provenance["provenance_hash"] != expected[run_id]
        ):
            raise TSCalibrationError("TS calibration provenance filename differs")
        provenances.append(provenance)
    by_run_id = {value["forecast_run_id"]: value for value in provenances}
    for provenance in provenances:
        record = forecasts[provenance["forecast_run_id"]]
        update = record["ts_output"].get("forecast_update")
        _validate_provenance_parent(
            provenance,
            record=record,
            records=list(forecasts.values()),
            parent_provenance=(
                by_run_id.get(update.get("prior_run_id"))
                if isinstance(update, dict)
                else None
            ),
        )
    return provenances


def _provenance_record_for_run_locked(
    root: Path,
    run_id: str,
    *,
    records: list[dict[str, Any]],
) -> dict[str, Any] | None:
    path = root / PROVENANCE_PATH / f"{run_id}.json"
    manifest_path = root / PROVENANCE_MANIFEST_PATH
    if not path.exists() or not manifest_path.exists():
        return None
    expected = _validate_provenance_manifest(_read_json(manifest_path))
    manifest_hash = expected.get(run_id)
    if manifest_hash is None:
        return None
    record = next(
        (item for item in records if item["forecast_run_id"] == run_id),
        None,
    )
    if record is None:
        raise TSCalibrationError("TS calibration provenance forecast is missing")
    provenance = _read_json(path)
    _validate_provenance(provenance, record)
    if (
        provenance["forecast_run_id"] != run_id
        or provenance["provenance_hash"] != manifest_hash
    ):
        raise TSCalibrationError("TS calibration provenance filename differs")
    return provenance


def eligible_forecast_records(
    root: Path,
    *,
    cohort_id: str | None = None,
    release_commit: str | None = None,
    report_type: str | None = None,
    forecast_horizon: str | None = None,
    forecast_window: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    with calibration_archive_lock(root):
        records = _forecast_records_locked(root)
        provenances = {
            value["forecast_run_id"]: value
            for value in _provenance_records_locked(root, records=records)
        }
        return [
            record
            for record in records
            if (
                (provenance := provenances.get(record["forecast_run_id"]))
                is not None
                and provenance["eligibility"] == "OFFICIAL_CALIBRATION"
                and _provenance_matches(
                    provenance,
                    cohort_id=cohort_id,
                    release_commit=release_commit,
                    report_type=report_type,
                    forecast_horizon=forecast_horizon,
                    forecast_window=forecast_window,
                )
            )
        ]


def eligible_forecast_record_for_run(
    root: Path,
    run_id: str,
) -> dict[str, Any] | None:
    """Return one complete eligible forecast, tolerating only retryable gaps."""
    with calibration_archive_lock(root):
        matches = [
            record
            for record in _forecast_records_locked(root)
            if record["forecast_run_id"] == run_id
        ]
        if not matches:
            return None
        if len(matches) != 1:
            raise TSCalibrationError("Duplicate TS forecast run id")
        record = matches[0]
        sidecar_path = root / PROVENANCE_PATH / f"{run_id}.json"
        manifest_path = root / PROVENANCE_MANIFEST_PATH
        if not sidecar_path.exists() or not manifest_path.exists():
            return None
        provenance = _read_json(sidecar_path)
        _validate_provenance(provenance, record)
        expected = _validate_provenance_manifest(_read_json(manifest_path))
        manifest_hash = expected.get(run_id)
        if manifest_hash is None:
            return None
        if provenance["provenance_hash"] != manifest_hash:
            raise TSCalibrationError("TS calibration provenance manifest differs")
        if provenance["eligibility"] != "OFFICIAL_CALIBRATION":
            return None
        return record


def _append_provenance_manifest(
    root: Path,
    provenance: dict[str, Any],
) -> None:
    path = root / PROVENANCE_MANIFEST_PATH
    entries: list[dict[str, str]] = []
    if path.exists():
        current = _read_json(path)
        _validate_provenance_manifest(current)
        entries = list(current["entries"])
    run_id = provenance["forecast_run_id"]
    existing = {
        item["forecast_run_id"]: item["provenance_hash"] for item in entries
    }
    if run_id in existing:
        if existing[run_id] != provenance["provenance_hash"]:
            raise TSCalibrationError("TS provenance manifest identity differs")
        return
    body = {
        "state_version": 1,
        "component": "TS_CALIBRATION_PROVENANCE_MANIFEST",
        "entries": [
            *entries,
            {
                "forecast_run_id": run_id,
                "provenance_hash": provenance["provenance_hash"],
            },
        ],
    }
    manifest = {**body, "manifest_hash": sha256_json(body)}
    _validate_provenance_manifest(manifest)
    atomic_write_json(path, manifest)


def _validate_provenance_manifest(value: Any) -> dict[str, str]:
    fields = {"state_version", "component", "entries", "manifest_hash"}
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS calibration provenance manifest")
    body = {key: item for key, item in value.items() if key != "manifest_hash"}
    entries = value["entries"]
    if (
        value["state_version"] != 1
        or value["component"] != "TS_CALIBRATION_PROVENANCE_MANIFEST"
        or not isinstance(entries, list)
        or not entries
        or value["manifest_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS calibration provenance manifest")
    expected: dict[str, str] = {}
    for item in entries:
        if (
            not isinstance(item, dict)
            or set(item) != {"forecast_run_id", "provenance_hash"}
            or RUN_ID_RE.fullmatch(str(item["forecast_run_id"])) is None
            or HASH_RE.fullmatch(str(item["provenance_hash"])) is None
            or item["forecast_run_id"] in expected
        ):
            raise TSCalibrationError("Invalid TS provenance manifest entry")
        expected[item["forecast_run_id"]] = item["provenance_hash"]
    return expected


def _provenance_matches(
    provenance: dict[str, Any],
    *,
    cohort_id: str | None,
    release_commit: str | None,
    report_type: str | None,
    forecast_horizon: str | None,
    forecast_window: dict[str, Any] | None,
) -> bool:
    return (
        (cohort_id is None or provenance["cohort_id"] == cohort_id)
        and (
            release_commit is None
            or provenance["release_commit"] == release_commit
        )
        and (report_type is None or provenance["report_type"] == report_type)
        and (
            forecast_horizon is None
            or provenance["forecast_window"].get("horizon")
            == forecast_horizon
        )
        and (
            forecast_window is None
            or provenance["forecast_window"] == forecast_window
        )
    )


def archive_observations(
    root: Path,
    observations: dict[str, Any],
    record: dict[str, Any],
) -> dict[str, Any]:
    _validate_forecast_record(record)
    _validate_observations(observations, record)
    _write_once(
        root / "observations" / f"{record['forecast_run_id']}.json",
        observations,
    )
    return observations


def settle_forecast(
    record: dict[str, Any],
    observations: dict[str, Any],
    *,
    settled_at: datetime | None = None,
) -> dict[str, Any]:
    _validate_forecast_record(record)
    _validate_observations(observations, record)
    output = record["ts_output"]
    bars = observations["symbols"]
    forecast_start = _aware(
        output["forecast_window"]["start_at"],
        "forecast window start",
    )
    issued_at = _aware(record["issued_at"], "forecast issued_at")
    has_unobserved_live_quote = any(
        _scenario_uses_live_quote(output["scenarios"][name])
        for name in SCENARIOS
    )
    scenario_results = (
        {
            name: {
                "status": "UNRESOLVED",
                "completed_stage_count": 0,
                "completed_at": None,
            }
            for name in SCENARIOS
        }
        if has_unobserved_live_quote
        else {
            name: _scenario_result(
                output["scenarios"][name],
                bars,
                not_before=forecast_start,
                fully_after=issued_at,
            )
            for name in SCENARIOS
        }
    )
    symbol_results = {}
    for symbol in SYMBOLS:
        eligible = [
            bar
            for bar in bars[symbol]
            if _aware(bar["closed_at"], "bar closed_at")
            - timedelta(minutes=5)
            >= issued_at
        ]
        if not eligible:
            raise TSCalibrationError("No settlement bars after forecast start")
        start = float(eligible[0]["open"])
        end = float(eligible[-1]["close"])
        return_pct = (end / start - 1) * 100
        actual_direction = (
            "UNRESOLVED"
            if observations["complete"] is not True
            else _direction_from_return(return_pct)
        )
        symbol_results[symbol] = {
            "start_price": start,
            "end_price": end,
            "return_pct": round(return_pct, 6),
            "forecast_direction": output["symbol_outlooks"][symbol]["direction"],
            "actual_direction": actual_direction,
        }

    completed = [
        (name, _aware(result["completed_at"], "scenario completed_at"))
        for name, result in scenario_results.items()
        if result["status"] == "CONFIRMED"
    ]
    completed.sort(key=lambda item: item[1])
    unique_winner = bool(completed) and (
        len(completed) == 1 or completed[0][1] < completed[1][1]
    )
    actual = completed[0][0].upper() if unique_winner else "UNRESOLVED"
    direction_mismatch = False
    if observations["complete"] is not True or has_unobserved_live_quote:
        actual = "UNRESOLVED"
    elif actual != "UNRESOLVED" and not _scenario_matches_directions(
        actual,
        output,
        symbol_results,
    ):
        actual = "UNRESOLVED"
        direction_mismatch = True

    probabilities = {
        name: output["scenarios"][name]["probability_pct"]
        for name in SCENARIOS
    }
    _validate_probabilities(probabilities)
    brier = (
        round(
            sum(
                (probabilities[name] / 100 - (name.upper() == actual)) ** 2
                for name in SCENARIOS
            ),
            6,
        )
        if actual != "UNRESOLVED"
        else None
    )

    body = {
        "contract_version": SETTLEMENT_VERSION,
        "component": "TS_FORECAST_SETTLEMENT",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "report_type": record["report_type"],
        "release_commit": output["evidence_snapshot"]["release_commit"],
        "forecast_window": output["forecast_window"],
        "settled_at": (settled_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "status": "RESOLVED" if actual != "UNRESOLVED" else "UNRESOLVED",
        "actual_scenario": actual,
        "scenario_probabilities": probabilities,
        "scenario_results": scenario_results,
        "symbol_results": symbol_results,
        "brier_score": brier,
        "source_observation_hashes": [observations["observation_hash"]],
        "notes": (
            []
            if actual != "UNRESOLVED"
            else [
                "Scenario stages completed but observed directions did not "
                "match the winning path"
                if direction_mismatch
                else "三路径未形成唯一且完整的可结算结果"
            ]
        ),
    }
    result = {**body, "settlement_hash": sha256_json(body)}
    _validate_settlement(result)
    return result


def _direction_from_return(return_pct: float) -> str:
    if abs(return_pct) <= DIRECTION_RANGE_TOLERANCE_PCT:
        return "RANGE"
    return "BULLISH" if return_pct > 0 else "BEARISH"


def _scenario_matches_directions(
    actual_scenario: str,
    output: dict[str, Any],
    symbol_results: dict[str, dict[str, Any]],
) -> bool:
    if actual_scenario == "MAIN":
        expected = {
            symbol: output["symbol_outlooks"][symbol]["direction"]
            for symbol in SYMBOLS
        }
    else:
        bias = output["scenarios"][actual_scenario.lower()]["bias"]
        expected = {symbol: bias for symbol in SYMBOLS}
    return all(
        symbol_results[symbol]["actual_direction"] == expected[symbol]
        for symbol in SYMBOLS
    )


def archive_settlement(root: Path, settlement: dict[str, Any]) -> dict[str, Any]:
    _validate_settlement(settlement)
    _validate_settlement_binding(root, settlement)
    run_id = settlement["forecast_run_id"]
    _write_once(root / ACTIVE_SETTLEMENT_PATH / f"{run_id}.json", settlement)
    return settlement


def settlement_records(root: Path) -> list[dict[str, Any]]:
    _require_settlement_migration(root)
    forecasts = {
        record["forecast_run_id"]: record for record in forecast_records(root)
    }
    records = []
    for path in sorted((root / ACTIVE_SETTLEMENT_PATH).glob("*.json")):
        settlement = _read_json(path)
        _validate_settlement(settlement)
        if path.stem != settlement["forecast_run_id"]:
            raise TSCalibrationError("TS settlement filename identity mismatch")
        _validate_settlement_binding(
            root,
            settlement,
            forecasts=forecasts,
        )
        records.append(settlement)
    return records


def eligible_settlement_records(
    root: Path,
    *,
    cohort_id: str | None = None,
    release_commit: str | None = None,
    report_type: str | None = None,
    forecast_horizon: str | None = None,
    forecast_window: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Return only settlements backed by an eligible provenance sidecar."""
    with calibration_archive_lock(root):
        eligible_run_ids = {
            record["forecast_run_id"]
            for record in eligible_forecast_records(
                root,
                cohort_id=cohort_id,
                release_commit=release_commit,
                report_type=report_type,
                forecast_horizon=forecast_horizon,
                forecast_window=forecast_window,
            )
        }
        return [
            settlement
            for settlement in settlement_records(root)
            if settlement["forecast_run_id"] in eligible_run_ids
        ]


def migrate_settlement_archive(
    root: Path,
    *,
    migrated_at: datetime | None = None,
) -> dict[str, Any]:
    migration_time = migrated_at or datetime.now(UTC)
    if migration_time.tzinfo is None:
        raise TSCalibrationError("TS settlement migration time is not aware")
    migration_time = migration_time.astimezone(UTC)
    with calibration_archive_lock(root):
        manifest_path = root / SETTLEMENT_MIGRATION_PATH
        legacy_paths = sorted((root / LEGACY_SETTLEMENT_PATH).glob("*.json"))
        if manifest_path.exists():
            manifest = _validate_settlement_migration(root)
            migration_time = _aware(
                manifest["migrated_at"],
                "settlement migration time",
            )
        else:
            if not legacy_paths:
                raise TSCalibrationError("No legacy TS settlements to migrate")
            legacy_run_ids = {path.stem for path in legacy_paths}
            active_paths = sorted(
                (root / ACTIVE_SETTLEMENT_PATH).glob("*.json")
            )
            if any(path.stem not in legacy_run_ids for path in active_paths):
                raise TSCalibrationError(
                    "Unbound active TS settlement exists before migration"
                )
            forecasts = {
                record["forecast_run_id"]: record
                for record in _forecast_records_locked(root)
            }
            entries = []
            for path in legacy_paths:
                source = _read_json(path)
                _validate_legacy_settlement(source)
                run_id = source["forecast_run_id"]
                if path.stem != run_id or run_id not in forecasts:
                    raise TSCalibrationError(
                        "Legacy TS settlement identity is invalid"
                    )
                observation = _read_json(
                    root / "observations" / f"{run_id}.json"
                )
                _validate_observations(observation, forecasts[run_id])
                target = settle_forecast(
                    forecasts[run_id],
                    observation,
                    settled_at=_aware(source["settled_at"], "settled_at"),
                )
                _validate_migration_binding(source, target)
                _write_once(
                    root / ACTIVE_SETTLEMENT_PATH / f"{run_id}.json",
                    target,
                )
                entries.append(
                    {
                        "forecast_run_id": run_id,
                        "source_settlement_hash": source["settlement_hash"],
                        "target_settlement_hash": target["settlement_hash"],
                    }
                )
            entries.sort(key=lambda item: item["forecast_run_id"])
            source_inventory = [
                {
                    "forecast_run_id": item["forecast_run_id"],
                    "settlement_hash": item["source_settlement_hash"],
                }
                for item in entries
            ]
            target_inventory = [
                {
                    "forecast_run_id": item["forecast_run_id"],
                    "settlement_hash": item["target_settlement_hash"],
                }
                for item in entries
            ]
            body = {
                "contract_version": "v1",
                "component": "TS_SETTLEMENT_MIGRATION",
                "migration_id": SETTLEMENT_MIGRATION_ID,
                "migrated_at": migration_time.isoformat(),
                "source_contract_version": LEGACY_SETTLEMENT_VERSION,
                "target_contract_version": SETTLEMENT_VERSION,
                "source_inventory_hash": sha256_json(source_inventory),
                "target_inventory_hash": sha256_json(target_inventory),
                "entries": entries,
            }
            manifest = {**body, "manifest_hash": sha256_json(body)}
            _validate_settlement_migration_manifest(manifest)
            _write_once(manifest_path, manifest)
            _validate_settlement_migration(root)

        settlements = eligible_settlement_records(root)
        archive_partitioned_calibration(
            root,
            settlements,
            generated_at=migration_time,
        )
        return manifest


def calibration_summary(
    settlements: list[dict[str, Any]],
    *,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    for settlement in settlements:
        _validate_settlement(settlement)
    resolved = [value for value in settlements if value["status"] == "RESOLVED"]
    buckets: dict[int, list[int]] = {}
    direction_counts = {symbol: [0, 0] for symbol in SYMBOLS}
    for settlement in resolved:
        actual = settlement["actual_scenario"].lower()
        for name, probability in settlement["scenario_probabilities"].items():
            counts = buckets.setdefault(probability, [0, 0])
            counts[0] += 1
            counts[1] += int(name == actual)
    for settlement in settlements:
        for symbol in SYMBOLS:
            result = settlement["symbol_results"][symbol]
            if result["actual_direction"] == "UNRESOLVED":
                continue
            direction_counts[symbol][0] += 1
            direction_counts[symbol][1] += int(
                result["forecast_direction"] == result["actual_direction"]
            )
    brier_values = [float(value["brier_score"]) for value in resolved]
    return {
        "contract_version": "v2",
        "component": "TS_CALIBRATION_SUMMARY",
        "generated_at": (generated_at or datetime.now(UTC)).astimezone(UTC).isoformat(),
        "settlement_count": len(settlements),
        "resolved_count": len(resolved),
        "unresolved_count": len(settlements) - len(resolved),
        "mean_brier_score": (
            round(sum(brier_values) / len(brier_values), 6)
            if brier_values
            else None
        ),
        "probability_buckets": [
            {
                "probability_pct": probability,
                "forecast_count": counts[0],
                "hit_count": counts[1],
                "realized_rate": round(counts[1] / counts[0], 6),
            }
            for probability, counts in sorted(buckets.items())
        ],
        "symbol_direction_accuracy": {
            symbol: {
                "forecast_count": counts[0],
                "correct_count": counts[1],
                "accuracy": (
                    round(counts[1] / counts[0], 6) if counts[0] else None
                ),
            }
            for symbol, counts in direction_counts.items()
        },
        "source_settlement_hashes": sorted(
            value["settlement_hash"] for value in settlements
        ),
    }


def archive_partitioned_calibration(
    root: Path,
    settlements: list[dict[str, Any]],
    *,
    generated_at: datetime,
) -> dict[str, Any]:
    """Archive one v2 summary per immutable provenance partition."""
    if generated_at.tzinfo is None:
        raise TSCalibrationError("TS calibration generation time is not aware")
    generated_at = generated_at.astimezone(UTC)
    with calibration_archive_lock(root):
        records = _forecast_records_locked(root)
        forecasts = {
            record["forecast_run_id"]: record for record in records
        }
        provenances = {
            value["forecast_run_id"]: value
            for value in _provenance_records_locked(root, records=records)
        }
        groups: dict[
            tuple[str, str, str, str],
            list[dict[str, Any]],
        ] = {}
        run_ids: set[str] = set()
        for settlement in settlements:
            _validate_settlement(settlement)
            _validate_settlement_binding(
                root,
                settlement,
                forecasts=forecasts,
            )
            run_id = settlement["forecast_run_id"]
            provenance = provenances.get(run_id)
            horizon = (
                provenance.get("forecast_window", {}).get("horizon")
                if isinstance(provenance, dict)
                else None
            )
            if (
                run_id in run_ids
                or provenance is None
                or provenance["eligibility"] != "OFFICIAL_CALIBRATION"
                or not isinstance(horizon, str)
                or horizon not in FORECAST_HORIZONS
            ):
                raise TSCalibrationError(
                    "TS calibration partition input is not uniquely eligible"
                )
            run_ids.add(run_id)
            key = (
                provenance["cohort_id"],
                provenance["release_commit"],
                provenance["report_type"],
                horizon,
            )
            groups.setdefault(key, []).append(settlement)

        entries = []
        for key in sorted(groups):
            values = sorted(
                groups[key],
                key=lambda item: item["forecast_run_id"],
            )
            summary = calibration_summary(
                values,
                generated_at=generated_at,
            )
            summary_hash = _archive_calibration_summary_immutable(
                root,
                summary,
            )
            entries.append(
                {
                    "cohort_id": key[0],
                    "release_commit": key[1],
                    "report_type": key[2],
                    "forecast_horizon": key[3],
                    "settlement_count": summary["settlement_count"],
                    "resolved_count": summary["resolved_count"],
                    "source_settlement_hashes": summary[
                        "source_settlement_hashes"
                    ],
                    "summary_hash": summary_hash,
                }
            )
        source_hashes = sorted(
            settlement["settlement_hash"] for settlement in settlements
        )
        body = {
            "state_version": 1,
            "component": "TS_CALIBRATION_PARTITION_INDEX",
            "generated_at": generated_at.isoformat(),
            "settlement_count": len(settlements),
            "resolved_count": sum(
                settlement["status"] == "RESOLVED"
                for settlement in settlements
            ),
            "source_settlement_hashes": source_hashes,
            "partitions": entries,
        }
        index = {**body, "index_hash": sha256_json(body)}
        _validate_calibration_partition_index(index)
        _write_once(
            root
            / CALIBRATION_PARTITION_PATH
            / f"{index['index_hash']}.json",
            index,
        )
        return index


def calibration_partition_index(
    root: Path,
    index_hash: str,
) -> dict[str, Any]:
    if (
        not isinstance(index_hash, str)
        or HASH_RE.fullmatch(index_hash) is None
    ):
        raise TSCalibrationError("Invalid TS calibration partition index id")
    with calibration_archive_lock(root):
        index = _read_json(
            root / CALIBRATION_PARTITION_PATH / f"{index_hash}.json"
        )
        _validate_calibration_partition_index(index)
        if index["index_hash"] != index_hash:
            raise TSCalibrationError("TS calibration partition filename differs")
        for entry in index["partitions"]:
            summary = _read_json(
                root / "calibration" / f"{entry['summary_hash']}.json"
            )
            if (
                sha256_json(summary) != entry["summary_hash"]
                or summary.get("contract_version") != "v2"
                or summary.get("component") != "TS_CALIBRATION_SUMMARY"
                or summary.get("generated_at") != index["generated_at"]
                or summary.get("settlement_count")
                != entry["settlement_count"]
                or summary.get("resolved_count") != entry["resolved_count"]
                or summary.get("source_settlement_hashes")
                != entry["source_settlement_hashes"]
            ):
                raise TSCalibrationError(
                    "TS calibration partition summary differs"
                )
        return index


def _validate_calibration_partition_index(value: Any) -> None:
    fields = {
        "state_version",
        "component",
        "generated_at",
        "settlement_count",
        "resolved_count",
        "source_settlement_hashes",
        "partitions",
        "index_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS calibration partition index")
    body = {key: item for key, item in value.items() if key != "index_hash"}
    source_hashes = value["source_settlement_hashes"]
    partitions = value["partitions"]
    if (
        value["state_version"] != 1
        or value["component"] != "TS_CALIBRATION_PARTITION_INDEX"
        or type(value["settlement_count"]) is not int
        or type(value["resolved_count"]) is not int
        or not 0 <= value["resolved_count"] <= value["settlement_count"]
        or not isinstance(source_hashes, list)
        or any(
            not isinstance(item, str) or HASH_RE.fullmatch(item) is None
            for item in source_hashes
        )
        or source_hashes != sorted(source_hashes)
        or len(source_hashes) != len(set(source_hashes))
        or len(source_hashes) != value["settlement_count"]
        or not isinstance(partitions, list)
        or not isinstance(value["index_hash"], str)
        or HASH_RE.fullmatch(value["index_hash"]) is None
        or value["index_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS calibration partition index")
    _aware(value["generated_at"], "calibration partition generated_at")
    identities = set()
    partition_hashes: list[str] = []
    settlement_count = 0
    resolved_count = 0
    entry_fields = {
        "cohort_id",
        "release_commit",
        "report_type",
        "forecast_horizon",
        "settlement_count",
        "resolved_count",
        "source_settlement_hashes",
        "summary_hash",
    }
    for entry in partitions:
        if not isinstance(entry, dict) or set(entry) != entry_fields:
            raise TSCalibrationError("Invalid TS calibration partition entry")
        hashes = entry["source_settlement_hashes"]
        if (
            not isinstance(entry["cohort_id"], str)
            or COHORT_ID_RE.fullmatch(entry["cohort_id"]) is None
            or not isinstance(entry["release_commit"], str)
            or RELEASE_COMMIT_RE.fullmatch(entry["release_commit"]) is None
            or not isinstance(entry["report_type"], str)
            or entry["report_type"]
            not in INTRADAY_REPORTS | {"WEEKEND_OUTLOOK", "NEXT_SESSION"}
            or not isinstance(entry["forecast_horizon"], str)
            or entry["forecast_horizon"] not in FORECAST_HORIZONS
            or type(entry["settlement_count"]) is not int
            or type(entry["resolved_count"]) is not int
            or not 0 <= entry["resolved_count"] <= entry["settlement_count"]
            or not isinstance(hashes, list)
            or any(
                not isinstance(item, str) or HASH_RE.fullmatch(item) is None
                for item in hashes
            )
            or hashes != sorted(hashes)
            or len(hashes) != len(set(hashes))
            or len(hashes) != entry["settlement_count"]
            or not isinstance(entry["summary_hash"], str)
            or HASH_RE.fullmatch(entry["summary_hash"]) is None
        ):
            raise TSCalibrationError("Invalid TS calibration partition entry")
        identity = (
            entry["cohort_id"],
            entry["release_commit"],
            entry["report_type"],
            entry["forecast_horizon"],
        )
        if identity in identities:
            raise TSCalibrationError("Duplicate TS calibration partition")
        identities.add(identity)
        partition_hashes.extend(hashes)
        settlement_count += entry["settlement_count"]
        resolved_count += entry["resolved_count"]
    if (
        sorted(partition_hashes) != source_hashes
        or len(partition_hashes) != len(set(partition_hashes))
        or settlement_count != value["settlement_count"]
        or resolved_count != value["resolved_count"]
    ):
        raise TSCalibrationError("TS calibration partition totals differ")


def _archive_calibration_summary_immutable(
    root: Path,
    summary: dict[str, Any],
) -> str:
    digest = sha256_json(summary)
    _write_once(root / "calibration" / f"{digest}.json", summary)
    return digest


def archive_calibration_summary(
    root: Path,
    summary: dict[str, Any],
) -> dict[str, Any]:
    _archive_calibration_summary_immutable(root, summary)
    atomic_write_json(root / "state" / "latest-calibration.json", summary)
    return summary


def daily_calibration_summary(
    root: Path,
    market_date: str,
    *,
    cohort_id: str | None = None,
    release_commit: str | None = None,
    report_type: str = "INTRADAY_30_60M",
    forecast_horizon: str = "NEXT_30_TO_60_MINUTES",
    forecast_window: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    try:
        if date.fromisoformat(market_date).isoformat() != market_date:
            raise ValueError
    except (TypeError, ValueError) as exc:
        raise TSCalibrationError("Invalid TS calibration market date") from exc
    if (
        not isinstance(report_type, str)
        or report_type
        not in INTRADAY_REPORTS | {"WEEKEND_OUTLOOK", "NEXT_SESSION"}
        or not isinstance(forecast_horizon, str)
        or forecast_horizon not in FORECAST_HORIZONS
        or (
            forecast_window is not None
            and (
                not isinstance(forecast_window, dict)
                or forecast_window.get("horizon") != forecast_horizon
            )
        )
    ):
        raise TSCalibrationError("Invalid TS daily calibration partition")
    with calibration_archive_lock(root):
        eligible_records = eligible_forecast_records(
            root,
            cohort_id=cohort_id,
            release_commit=release_commit,
            report_type=report_type,
            forecast_horizon=forecast_horizon,
            forecast_window=forecast_window,
        )
        records = {
            record["forecast_run_id"]: record
            for record in eligible_records
        }
        provenances = {
            provenance["forecast_run_id"]: provenance
            for provenance in provenance_records(root)
            if provenance["forecast_run_id"] in records
        }
        selected = []
        selected_partitions = set()
        for settlement in eligible_settlement_records(
            root,
            cohort_id=cohort_id,
            release_commit=release_commit,
            report_type=report_type,
            forecast_horizon=forecast_horizon,
            forecast_window=forecast_window,
        ):
            run_id = settlement["forecast_run_id"]
            observation = _read_json(root / "observations" / f"{run_id}.json")
            _validate_observations(observation, records[run_id])
            observation_day = (
                _aware(observation["window_end"], "observation window_end")
                .astimezone(PT_ZONE)
                .date()
                .isoformat()
            )
            if observation_day == market_date:
                selected.append(settlement)
                provenance = provenances[run_id]
                selected_partitions.add(
                    (
                        provenance["cohort_id"],
                        provenance["release_commit"],
                    )
                )
    if not selected:
        return None
    if len(selected_partitions) != 1:
        return None
    generated_at = max(
        _aware(settlement["settled_at"], "settled_at")
        for settlement in selected
    )
    return calibration_summary(selected, generated_at=generated_at)


def _scenario_result(
    scenario: dict[str, Any],
    bars: dict[str, list[dict[str, Any]]],
    *,
    not_before: datetime,
    fully_after: datetime,
) -> dict[str, Any]:
    activation = _first_group_time(
        scenario["activation"],
        bars,
        not_before=not_before,
        fully_after=fully_after,
    )
    if activation is None:
        return {
            "status": "NOT_ACTIVATED",
            "completed_stage_count": 0,
            "completed_at": None,
        }
    invalidated = _first_group_time(
        scenario["invalidation"],
        bars,
        not_before=activation,
        fully_after=fully_after,
    )
    completed = 0
    cursor = activation
    for expected_order, stage in enumerate(scenario["sequence"], start=1):
        if stage.get("order") != expected_order:
            raise TSCalibrationError("TS scenario stages are not consecutive")
        stage_at = _first_group_time(
            {"logic": "ALL", "conditions": stage["conditions"]},
            bars,
            not_before=cursor + timedelta(microseconds=1),
            fully_after=fully_after,
        )
        if invalidated is not None and (
            stage_at is None or invalidated <= stage_at
        ):
            return {
                "status": "INVALIDATED",
                "completed_stage_count": completed,
                "completed_at": invalidated.isoformat(),
            }
        if stage_at is None:
            return {
                "status": "PARTIAL",
                "completed_stage_count": completed,
                "completed_at": cursor.isoformat(),
            }
        completed += 1
        cursor = stage_at
    return {
        "status": "CONFIRMED",
        "completed_stage_count": completed,
        "completed_at": cursor.isoformat(),
    }


def _scenario_uses_live_quote(scenario: dict[str, Any]) -> bool:
    groups = [scenario["activation"], scenario["invalidation"]]
    groups.extend(
        {"conditions": stage["conditions"]} for stage in scenario["sequence"]
    )
    return any(
        condition.get("confirmation") == "LIVE_QUOTE"
        for group in groups
        for condition in group["conditions"]
    )


def _first_group_time(
    group: dict[str, Any],
    bars: dict[str, list[dict[str, Any]]],
    *,
    not_before: datetime | None = None,
    fully_after: datetime | None = None,
) -> datetime | None:
    condition_times = [
        _confirmed_times(
            condition,
            bars[condition["symbol"]],
            fully_after=fully_after,
        )
        for condition in group["conditions"]
    ]
    candidates = (
        set.intersection(*condition_times)
        if group["logic"] == "ALL"
        else set.union(*condition_times)
    )
    eligible = [
        value for value in candidates if not_before is None or value >= not_before
    ]
    return min(eligible, default=None)


def _confirmed_times(
    condition: dict[str, Any],
    bars: list[dict[str, Any]],
    *,
    fully_after: datetime | None = None,
) -> set[datetime]:
    confirmation_minutes = CONFIRMATION_MINUTES[condition["confirmation"]]
    count = confirmation_minutes // 5
    values = _metric_values(condition["metric"], bars)
    matches = [_compare(value, condition) for value in values]
    result = set()
    for index in range(count - 1, len(bars)):
        window = bars[index - count + 1 : index + 1]
        times = [_aware(item["closed_at"], "bar closed_at") for item in window]
        if (
            (
                fully_after is None
                or times[0] - timedelta(minutes=5) >= fully_after
            )
            and matches[index]
            and _consecutive_five_minute_bars(times)
            and _aligned_close(times[-1], confirmation_minutes)
        ):
            result.add(times[-1])
    return result


def _metric_values(metric: str, bars: list[dict[str, Any]]) -> list[float | None]:
    result: list[float | None] = []
    session_high = -math.inf
    session_low = math.inf
    day = None
    opening: list[dict[str, Any]] = []
    for bar in bars:
        current_day = _aware(bar["closed_at"], "bar closed_at").date()
        if current_day != day:
            day = current_day
            session_high = -math.inf
            session_low = math.inf
            opening = []
        session_high = max(session_high, float(bar["high"]))
        session_low = min(session_low, float(bar["low"]))
        if len(opening) < 6:
            opening.append(bar)
        opening_ready = len(opening) == 6
        values = {
            "LAST_PRICE": float(bar["close"]),
            "VWAP": float(bar["vwap"]) if bar["vwap"] is not None else None,
            "SESSION_HIGH": session_high,
            "SESSION_LOW": session_low,
            "OPENING_RANGE_HIGH": (
                max(float(item["high"]) for item in opening)
                if opening_ready
                else None
            ),
            "OPENING_RANGE_LOW": (
                min(float(item["low"]) for item in opening)
                if opening_ready
                else None
            ),
        }
        result.append(values[metric])
    return result


def _compare(value: float | None, condition: dict[str, Any]) -> bool:
    if value is None:
        return False
    target = float(condition["value"])
    operator = condition["operator"]
    upper = condition["upper_value"]
    if operator == "ABOVE":
        return value > target
    if operator == "BELOW":
        return value < target
    if operator == "AT_OR_ABOVE":
        return value >= target
    if operator == "AT_OR_BELOW":
        return value <= target
    if operator == "BETWEEN":
        if upper is None or float(upper) <= target:
            raise TSCalibrationError("BETWEEN requires upper_value above value")
        return target <= value <= float(upper)
    raise TSCalibrationError("Unknown TS observable operator")


def _consecutive_five_minute_bars(values: list[datetime]) -> bool:
    return all(
        later - earlier == timedelta(minutes=5)
        for earlier, later in zip(values, values[1:])
    )


def _aligned_close(value: datetime, confirmation_minutes: int) -> bool:
    return (
        value.second == 0
        and value.microsecond == 0
        and value.minute % confirmation_minutes == 0
    )


def _validate_forecast_record(record: Any) -> None:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "issued_at",
        "market_date",
        "report_type",
        "ts_output",
        "record_hash",
    }
    if not isinstance(record, dict) or set(record) != fields:
        raise TSCalibrationError("Invalid TS forecast record")
    body = {key: value for key, value in record.items() if key != "record_hash"}
    if (
        record["contract_version"] != "v2"
        or record["component"] != "TS_FORECAST_RECORD"
        or record["forecast_hash"] != forecast_hash(record["ts_output"])
        or record["record_hash"] != sha256_json(body)
        or not HASH_RE.fullmatch(record["record_hash"])
    ):
        raise TSCalibrationError("Invalid TS forecast record hash or identity")
    _aware(record["issued_at"], "forecast issued_at")


def _validate_forecast_inventory(
    value: Any,
    record: dict[str, Any],
) -> None:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "record_hash",
        "report_type",
        "market_date",
        "issued_at",
        "inventory_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS forecast inventory entry")
    body = {key: item for key, item in value.items() if key != "inventory_hash"}
    if (
        value["contract_version"] != "v2"
        or value["component"] != "TS_FORECAST_INVENTORY_ENTRY"
        or value["inventory_hash"] != sha256_json(body)
        or value["forecast_run_id"] != record["forecast_run_id"]
        or value["forecast_hash"] != record["forecast_hash"]
        or value["record_hash"] != record["record_hash"]
        or value["report_type"] != record["report_type"]
        or value["market_date"] != record["market_date"]
        or value["issued_at"] != record["issued_at"]
    ):
        raise TSCalibrationError("TS forecast inventory identity mismatch")


def _validate_provenance(
    value: Any,
    record: dict[str, Any],
) -> None:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "record_hash",
        "cohort_id",
        "release_commit",
        "forecast_role",
        "report_type",
        "forecast_window",
        "official_slot",
        "delivery_proof",
        "ownership_proof",
        "parent_forecast_hash",
        "eligibility",
        "exclusion_reason",
        "provenance_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS calibration provenance fields")
    _validate_forecast_record(record)
    output = record["ts_output"]
    snapshot = output.get("evidence_snapshot", {})
    body = {key: item for key, item in value.items() if key != "provenance_hash"}
    role = value["forecast_role"]
    eligibility = value["eligibility"]
    exclusion = value["exclusion_reason"]
    parent_hash = value["parent_forecast_hash"]
    if (
        value["contract_version"] != "v1"
        or value["component"] != "TS_CALIBRATION_PROVENANCE"
        or value["forecast_run_id"] != record["forecast_run_id"]
        or value["forecast_run_id"] != snapshot.get("run_id")
        or value["forecast_hash"] != record["forecast_hash"]
        or value["record_hash"] != record["record_hash"]
        or COHORT_ID_RE.fullmatch(str(value["cohort_id"])) is None
        or RELEASE_COMMIT_RE.fullmatch(str(value["release_commit"])) is None
        or value["release_commit"] != snapshot.get("release_commit")
        or role not in PROVENANCE_ROLES
        or value["report_type"] != record["report_type"]
        or value["report_type"]
        not in INTRADAY_REPORTS | {"WEEKEND_OUTLOOK", "NEXT_SESSION"}
        or not isinstance(value["forecast_window"], dict)
        or not isinstance(value["forecast_window"].get("horizon"), str)
        or value["forecast_window"].get("horizon") not in FORECAST_HORIZONS
        or value["forecast_window"] != output.get("forecast_window")
        or eligibility not in {"OFFICIAL_CALIBRATION", "EXCLUDED"}
        or (
            exclusion is not None
            and exclusion not in PROVENANCE_EXCLUSION_REASONS
        )
        or (
            parent_hash is not None
            and HASH_RE.fullmatch(str(parent_hash)) is None
        )
        or HASH_RE.fullmatch(str(value["provenance_hash"])) is None
        or value["provenance_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS calibration provenance identity")

    delivery_at = _validate_delivery_proof(value["delivery_proof"])
    ownership_slot = _validate_ownership_proof(value["ownership_proof"])
    official_slot = (
        None
        if value["official_slot"] is None
        else _aware(value["official_slot"], "TS provenance official slot")
    )
    issued_at = _aware(record["issued_at"], "forecast issued_at")
    if (
        delivery_at is not None
        and delivery_at.astimezone(UTC) != issued_at.astimezone(UTC)
    ):
        raise TSCalibrationError("TS provenance delivery time differs from forecast")

    if role == "FORMAL_SLOT":
        if (
            official_slot is None
            or delivery_at is None
            or parent_hash is not None
            or (
                eligibility == "OFFICIAL_CALIBRATION"
                and exclusion is not None
            )
            or (
                eligibility == "EXCLUDED"
                and exclusion != "LEGACY_COHORT"
            )
        ):
            raise TSCalibrationError("Invalid formal TS provenance")
        observed_at = _aware(
            snapshot.get("market_time", {}).get("observed_at"),
            "TS provenance market time",
        )
        if official_slot.second or official_slot.microsecond:
            raise TSCalibrationError("TS provenance official slot is not exact")
        delivery = value["delivery_proof"]
        if value["report_type"] in INTRADAY_REPORTS:
            ownership = value["ownership_proof"]
            observed_delay = observed_at.astimezone(UTC) - official_slot.astimezone(
                UTC
            )
            if (
                ownership_slot is None
                or not timedelta(0) <= observed_delay < timedelta(minutes=2)
                or ownership_slot.astimezone(UTC)
                != official_slot.astimezone(UTC)
                or (
                    delivery["delivery_kind"] == "TS_INTRADAY"
                    and ownership["owner"] != "TS_INTRADAY"
                )
                or (
                    delivery["delivery_kind"] == "AGENT_CYCLE"
                    and ownership["owner"] != "FULL_CYCLE"
                )
            ):
                raise TSCalibrationError("Invalid formal TS ownership proof")
        elif (
            value["ownership_proof"] is not None
            or delivery["delivery_kind"] != "AGENT_CYCLE"
        ):
            raise TSCalibrationError("Invalid scheduled TS ownership proof")
    elif role == "MATERIAL_REVISION":
        update = output.get("forecast_update")
        if (
            official_slot is not None
            or delivery_at is None
            or value["ownership_proof"] is not None
            or HASH_RE.fullmatch(str(parent_hash)) is None
            or not isinstance(update, dict)
            or update.get("prior_forecast_hash") != parent_hash
            or eligibility != "EXCLUDED"
            or exclusion != "MATERIAL_REVISION"
        ):
            raise TSCalibrationError("Invalid material revision provenance")
    elif role == "UNDELIVERED_DRAFT":
        if (
            official_slot is not None
            or value["delivery_proof"] is not None
            or value["ownership_proof"] is not None
            or parent_hash is not None
            or eligibility != "EXCLUDED"
            or exclusion != "UNDELIVERED_DRAFT"
        ):
            raise TSCalibrationError("Invalid undelivered draft provenance")
    elif (
        official_slot is not None
        or value["ownership_proof"] is not None
        or parent_hash is not None
        or eligibility != "EXCLUDED"
        or exclusion != "TEST_EVENT"
    ):
        raise TSCalibrationError("Invalid test forecast provenance")


def _validate_delivery_proof(value: Any) -> datetime | None:
    if value is None:
        return None
    fields = {
        "delivery_kind",
        "delivery_key",
        "completed_at",
        "discord_message_id",
        "discord_content_hash",
    }
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value["delivery_kind"] not in {"AGENT_CYCLE", "TS_INTRADAY"}
        or SAFE_ID_RE.fullmatch(str(value["delivery_key"])) is None
        or MESSAGE_ID_RE.fullmatch(str(value["discord_message_id"])) is None
        or HASH_RE.fullmatch(str(value["discord_content_hash"])) is None
    ):
        raise TSCalibrationError("Invalid TS provenance delivery proof")
    return _aware(value["completed_at"], "TS provenance delivery completion")


def _validate_provenance_parent(
    value: dict[str, Any],
    *,
    record: dict[str, Any],
    records: list[dict[str, Any]],
    parent_provenance: dict[str, Any] | None,
) -> None:
    if value["forecast_role"] != "MATERIAL_REVISION":
        return
    parent_hash = value["parent_forecast_hash"]
    matches = [
        candidate
        for candidate in records
        if candidate["forecast_hash"] == parent_hash
    ]
    update = record["ts_output"].get("forecast_update")
    if (
        parent_hash == value["forecast_hash"]
        or len(matches) != 1
        or not isinstance(update, dict)
        or update.get("prior_run_id") != matches[0]["forecast_run_id"]
    ):
        raise TSCalibrationError(
            "TS material revision parent identity is not archived"
        )
    if (
        parent_provenance is None
        or parent_provenance["forecast_run_id"]
        != matches[0]["forecast_run_id"]
        or parent_provenance["forecast_hash"] != parent_hash
    ):
        raise TSCalibrationError(
            "TS material revision parent provenance is not archived"
        )


def _validate_ownership_proof(value: Any) -> datetime | None:
    if value is None:
        return None
    fields = {"owner", "slot", "ownership_hash"}
    if (
        not isinstance(value, dict)
        or set(value) != fields
        or value["owner"] not in {"FULL_CYCLE", "TS_INTRADAY"}
        or HASH_RE.fullmatch(str(value["ownership_hash"])) is None
    ):
        raise TSCalibrationError("Invalid TS provenance ownership proof")
    return _aware(value["slot"], "TS provenance ownership slot")


def _validate_observations(
    value: Any, record: dict[str, Any]
) -> None:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "timezone",
        "window_start",
        "window_end",
        "complete",
        "source_hashes",
        "symbols",
        "observation_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS forecast observations")
    body = {key: item for key, item in value.items() if key != "observation_hash"}
    if (
        value["contract_version"] != "v2"
        or value["component"] != "TS_FORECAST_OBSERVATIONS"
        or value["forecast_run_id"] != record["forecast_run_id"]
        or value["forecast_hash"] != record["forecast_hash"]
        or value["timezone"] != "America/Los_Angeles"
        or value["observation_hash"] != sha256_json(body)
        or not isinstance(value["complete"], bool)
        or not isinstance(value["source_hashes"], list)
        or not value["source_hashes"]
        or any(not HASH_RE.fullmatch(str(item)) for item in value["source_hashes"])
        or set(value["symbols"]) != set(SYMBOLS)
    ):
        raise TSCalibrationError("Invalid TS forecast observation identity")
    start = _aware(value["window_start"], "observation window_start")
    end = _aware(value["window_end"], "observation window_end")
    if end <= start:
        raise TSCalibrationError("Invalid TS observation window")
    times = None
    for symbol in SYMBOLS:
        bars = value["symbols"][symbol]
        if not isinstance(bars, list) or not bars:
            raise TSCalibrationError(f"Missing {symbol} settlement bars")
        symbol_times = []
        for bar in bars:
            if not isinstance(bar, dict) or set(bar) != {
                "closed_at",
                "open",
                "high",
                "low",
                "close",
                "vwap",
            }:
                raise TSCalibrationError("Invalid TS settlement bar")
            closed_at = _aware(bar["closed_at"], "bar closed_at")
            prices = [bar[name] for name in ("open", "high", "low", "close")]
            if (
                any(
                    isinstance(item, bool)
                    or not isinstance(item, (int, float))
                    or not math.isfinite(item)
                    or item <= 0
                    for item in prices
                )
                or bar["low"] > min(bar["open"], bar["close"])
                or bar["high"] < max(bar["open"], bar["close"])
                or bar["low"] > bar["high"]
                or (
                    bar["vwap"] is not None
                    and (
                        isinstance(bar["vwap"], bool)
                        or not isinstance(bar["vwap"], (int, float))
                        or not math.isfinite(bar["vwap"])
                        or bar["vwap"] <= 0
                    )
                )
            ):
                raise TSCalibrationError("Invalid TS settlement OHLCV values")
            if not start <= closed_at <= end:
                raise TSCalibrationError("TS settlement bar is outside its window")
            symbol_times.append(closed_at)
        if symbol_times != sorted(set(symbol_times)):
            raise TSCalibrationError("TS settlement bars are not unique and sorted")
        if times is not None and symbol_times != times:
            raise TSCalibrationError("SPY and QQQ settlement bars are not aligned")
        times = symbol_times


def _validate_probabilities(probabilities: dict[str, Any]) -> None:
    if (
        set(probabilities) != set(SCENARIOS)
        or any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 <= value <= 100
            or value % 5
            for value in probabilities.values()
        )
        or sum(probabilities.values()) != 100
        or probabilities["main"] < max(
            probabilities["reverse"], probabilities["extreme"]
        )
    ):
        raise TSCalibrationError("Invalid TS scenario probabilities")


def _require_settlement_migration(root: Path) -> None:
    legacy_paths = list((root / LEGACY_SETTLEMENT_PATH).glob("*.json"))
    manifest_exists = (root / SETTLEMENT_MIGRATION_PATH).exists()
    if not legacy_paths and not manifest_exists:
        return
    if not legacy_paths or not manifest_exists:
        raise TSCalibrationError("TS settlement archive migration is incomplete")
    _validate_settlement_migration(root)


def _validate_settlement_migration(root: Path) -> dict[str, Any]:
    manifest = _read_json(root / SETTLEMENT_MIGRATION_PATH)
    entries = _validate_settlement_migration_manifest(manifest)
    source_paths = {
        path.stem: path
        for path in (root / LEGACY_SETTLEMENT_PATH).glob("*.json")
    }
    target_paths = {
        path.stem: path
        for path in (root / ACTIVE_SETTLEMENT_PATH).glob("*.json")
    }
    if set(source_paths) != set(entries) or not set(entries) <= set(target_paths):
        raise TSCalibrationError("TS settlement migration inventory differs")
    for run_id, entry in entries.items():
        source = _read_json(source_paths[run_id])
        target = _read_json(target_paths[run_id])
        _validate_legacy_settlement(source)
        _validate_settlement(target)
        if (
            source["forecast_run_id"] != run_id
            or target["forecast_run_id"] != run_id
            or source["settlement_hash"]
            != entry["source_settlement_hash"]
            or target["settlement_hash"]
            != entry["target_settlement_hash"]
        ):
            raise TSCalibrationError("TS settlement migration binding differs")
    return manifest


def _validate_settlement_migration_manifest(
    value: Any,
) -> dict[str, dict[str, str]]:
    fields = {
        "contract_version",
        "component",
        "migration_id",
        "migrated_at",
        "source_contract_version",
        "target_contract_version",
        "source_inventory_hash",
        "target_inventory_hash",
        "entries",
        "manifest_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSCalibrationError("Invalid TS settlement migration manifest")
    body = {key: item for key, item in value.items() if key != "manifest_hash"}
    entries = value["entries"]
    if (
        value["contract_version"] != "v1"
        or value["component"] != "TS_SETTLEMENT_MIGRATION"
        or value["migration_id"] != SETTLEMENT_MIGRATION_ID
        or value["source_contract_version"] != LEGACY_SETTLEMENT_VERSION
        or value["target_contract_version"] != SETTLEMENT_VERSION
        or not isinstance(entries, list)
        or not entries
        or not HASH_RE.fullmatch(str(value["source_inventory_hash"]))
        or not HASH_RE.fullmatch(str(value["target_inventory_hash"]))
        or not HASH_RE.fullmatch(str(value["manifest_hash"]))
        or value["manifest_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS settlement migration identity")
    _aware(value["migrated_at"], "settlement migration time")
    expected: dict[str, dict[str, str]] = {}
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or set(entry)
            != {
                "forecast_run_id",
                "source_settlement_hash",
                "target_settlement_hash",
            }
            or RUN_ID_RE.fullmatch(str(entry["forecast_run_id"])) is None
            or not HASH_RE.fullmatch(str(entry["source_settlement_hash"]))
            or not HASH_RE.fullmatch(str(entry["target_settlement_hash"]))
            or entry["forecast_run_id"] in expected
        ):
            raise TSCalibrationError("Invalid TS settlement migration entry")
        expected[entry["forecast_run_id"]] = entry
    if list(expected) != sorted(expected):
        raise TSCalibrationError("TS settlement migration entries are not sorted")
    source_inventory = [
        {
            "forecast_run_id": run_id,
            "settlement_hash": entry["source_settlement_hash"],
        }
        for run_id, entry in expected.items()
    ]
    target_inventory = [
        {
            "forecast_run_id": run_id,
            "settlement_hash": entry["target_settlement_hash"],
        }
        for run_id, entry in expected.items()
    ]
    if (
        value["source_inventory_hash"] != sha256_json(source_inventory)
        or value["target_inventory_hash"] != sha256_json(target_inventory)
    ):
        raise TSCalibrationError("TS settlement migration inventory hash differs")
    return expected


def _validate_migration_binding(
    source: dict[str, Any],
    target: dict[str, Any],
) -> None:
    stable_fields = {
        "component",
        "forecast_run_id",
        "forecast_hash",
        "report_type",
        "release_commit",
        "forecast_window",
        "settled_at",
        "scenario_probabilities",
        "scenario_results",
        "symbol_results",
        "source_observation_hashes",
    }
    if any(source[field] != target[field] for field in stable_fields):
        raise TSCalibrationError("Legacy TS settlement does not bind migration inputs")


def _validate_settlement(value: Any) -> None:
    _validate_settlement_version(value, SETTLEMENT_VERSION)


def _validate_legacy_settlement(value: Any) -> None:
    _validate_settlement_version(value, LEGACY_SETTLEMENT_VERSION)


def _validate_settlement_version(value: Any, version: str) -> None:
    required = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "report_type",
        "release_commit",
        "forecast_window",
        "settled_at",
        "status",
        "actual_scenario",
        "scenario_probabilities",
        "scenario_results",
        "symbol_results",
        "brier_score",
        "source_observation_hashes",
        "notes",
        "settlement_hash",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise TSCalibrationError("Invalid TS forecast settlement")
    body = {
        key: item for key, item in value.items() if key != "settlement_hash"
    }
    _validate_probabilities(value["scenario_probabilities"])
    if (
        value["contract_version"] != version
        or value["component"] != "TS_FORECAST_SETTLEMENT"
        or value["status"] not in {"RESOLVED", "UNRESOLVED"}
        or value["actual_scenario"]
        not in {"MAIN", "REVERSE", "EXTREME", "UNRESOLVED"}
        or (value["status"] == "RESOLVED")
        != (value["actual_scenario"] != "UNRESOLVED")
        or set(value["scenario_results"]) != set(SCENARIOS)
        or set(value["symbol_results"]) != set(SYMBOLS)
        or not isinstance(value["source_observation_hashes"], list)
        or not value["source_observation_hashes"]
        or any(
            not HASH_RE.fullmatch(str(item))
            for item in value["source_observation_hashes"]
        )
        or not HASH_RE.fullmatch(str(value["settlement_hash"]))
        or value["settlement_hash"] != sha256_json(body)
    ):
        raise TSCalibrationError("Invalid TS forecast settlement semantics")
    _aware(value["settled_at"], "settled_at")


def _validate_settlement_binding(
    root: Path,
    settlement: dict[str, Any],
    *,
    forecasts: dict[str, dict[str, Any]] | None = None,
) -> None:
    if forecasts is None:
        forecasts = {
            record["forecast_run_id"]: record
            for record in forecast_records(root)
        }
    run_id = settlement["forecast_run_id"]
    record = forecasts.get(run_id)
    if record is None:
        raise TSCalibrationError("TS settlement forecast binding is missing")
    observations = _read_json(root / "observations" / f"{run_id}.json")
    _validate_observations(observations, record)
    expected = settle_forecast(
        record,
        observations,
        settled_at=_aware(settlement["settled_at"], "settled_at"),
    )
    if settlement != expected:
        raise TSCalibrationError("TS settlement does not match bound inputs")


def _aware(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise TSCalibrationError(f"Invalid {label}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise TSCalibrationError(f"Invalid {label}") from exc
    if parsed.tzinfo is None:
        raise TSCalibrationError(f"Invalid {label}")
    return parsed


def _write_once(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
    except FileExistsError:
        if _read_json(path) != value:
            raise TSCalibrationError(f"Immutable TS artifact differs: {path.name}")


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TSCalibrationError(f"Invalid TS artifact: {path.name}") from exc
