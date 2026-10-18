from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

from trading_os_v2.common.config import runtime_path
from trading_os_v2.common.io import atomic_write_json, sha256_json
from trading_os_v2.ts.calibration import (
    TSCalibrationError,
    archive_forecast,
    daily_calibration_summary as _daily_calibration_summary,
    eligible_forecast_record_for_run,
    eligible_forecast_records,
    forecast_record_for_run,
    forecast_records,
    forecast_hash,
    provenance_records,
)
from trading_os_v2.ts.settlement import (
    settle_due_forecasts,
    swing_scorecard_records,
)


HASH_RE = re.compile(r"^[0-9a-f]{64}$")
RUN_ID_RE = re.compile(r"^\d{8}T\d{6}Z-[0-9a-f]{10}$")
REPORT_TYPES = {
    "WEEKEND_OUTLOOK",
    "NEXT_SESSION",
    "OPENING_FORECAST",
    "OPEN_15M_CHECK",
    "OPEN_30M_CHECK",
    "INTRADAY_30_60M",
}
FORECAST_HORIZONS = {
    "NEXT_REGULAR_SESSION",
    "NEXT_REGULAR_SESSION_AND_WEEK",
    "OPEN_TO_60_MINUTES",
    "NEXT_30_TO_60_MINUTES",
}
PROVENANCE_ROLES = {
    "FORMAL_SLOT",
    "MATERIAL_REVISION",
    "UNDELIVERED_DRAFT",
    "TEST",
}
PROVENANCE_ELIGIBILITY = {"OFFICIAL_CALIBRATION", "EXCLUDED"}
CLASSIFIED_PROVENANCE = {
    ("MATERIAL_REVISION", "MATERIAL_REVISION"),
    ("UNDELIVERED_DRAFT", "UNDELIVERED_DRAFT"),
    ("TEST", "TEST_EVENT"),
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
COHORT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RELEASE_COMMIT_RE = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")


class TSForecastAnchorError(RuntimeError):
    pass


class TSProvenanceQueryError(RuntimeError):
    pass


def publish_forecast(
    output: dict[str, Any],
    *,
    provenance_context: dict[str, Any],
    published_at: datetime | None = None,
    root: Path | None = None,
) -> dict[str, Any]:
    if (
        not isinstance(provenance_context, dict)
        or set(provenance_context) != PROVENANCE_CONTEXT_FIELDS
        or provenance_context.get("forecast_role") != "FORMAL_SLOT"
        or provenance_context.get("eligibility") != "OFFICIAL_CALIBRATION"
        or provenance_context.get("exclusion_reason") is not None
        or provenance_context.get("parent_forecast_hash") is not None
    ):
        raise TSForecastAnchorError(
            "Public TS forecast requires official formal provenance"
        )
    record = archive_forecast(
        root or runtime_path("ts_calibration"),
        output,
        provenance_context=provenance_context,
        published_at=published_at,
    )
    return _forecast_anchor(record)


def archive_classified_forecast(
    output: dict[str, Any],
    *,
    provenance_context: dict[str, Any],
    published_at: datetime | None = None,
    root: Path | None = None,
) -> dict[str, Any]:
    if (
        not isinstance(provenance_context, dict)
        or set(provenance_context) != PROVENANCE_CONTEXT_FIELDS
        or provenance_context.get("eligibility") != "EXCLUDED"
        or (
            provenance_context.get("forecast_role"),
            provenance_context.get("exclusion_reason"),
        )
        not in CLASSIFIED_PROVENANCE
    ):
        raise TSForecastAnchorError(
            "Public TS classified forecast requires excluded provenance"
        )
    archive_root = root or runtime_path("ts_calibration")
    if provenance_context["forecast_role"] == "MATERIAL_REVISION":
        parent_hash = provenance_context["parent_forecast_hash"]
        update = output.get("forecast_update")
        if (
            HASH_RE.fullmatch(str(parent_hash)) is None
            or not isinstance(update, dict)
            or update.get("prior_forecast_hash") != parent_hash
        ):
            raise TSForecastAnchorError(
                "Public TS material revision requires its parent hash"
            )
        parent_run_id = update.get("prior_run_id")
        parent = (
            forecast_record_for_run(archive_root, parent_run_id)
            if isinstance(parent_run_id, str)
            and RUN_ID_RE.fullmatch(parent_run_id) is not None
            else None
        )
        if (
            parent is None
            or parent["forecast_hash"] != parent_hash
            or forecast_hash(output) == parent_hash
        ):
            raise TSCalibrationError(
                "TS material revision parent identity is not archived"
            )
    record = archive_forecast(
        archive_root,
        output,
        provenance_context=provenance_context,
        published_at=published_at,
    )
    provenance = calibration_provenance_for_run(
        record["forecast_run_id"],
        root=archive_root,
    )
    if provenance is None:
        raise TSProvenanceQueryError("Archived TS provenance is missing")
    return provenance


def opening_forecast_anchor(
    *,
    market_date: str,
    before: datetime,
    root: Path | None = None,
) -> dict[str, Any] | None:
    records = [
        record
        for record in eligible_forecast_records(
            root or runtime_path("ts_calibration"),
            report_type="OPENING_FORECAST",
        )
        if record["market_date"] == market_date
        and datetime.fromisoformat(record["issued_at"]) < before
    ]
    record = max(
        records,
        default=None,
        key=lambda item: datetime.fromisoformat(item["issued_at"]),
    )
    return None if record is None else _forecast_anchor(record)


def forecast_output_for_run(
    run_id: str,
    *,
    root: Path | None = None,
) -> dict[str, Any] | None:
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise TSForecastAnchorError("Invalid TS forecast run id")
    matches = [
        record
        for record in forecast_records(root or runtime_path("ts_calibration"))
        if record["forecast_run_id"] == run_id
    ]
    if len(matches) > 1:
        raise TSForecastAnchorError("Duplicate TS forecast run id")
    return None if not matches else matches[0]["ts_output"]


def forecast_anchor_for_run(
    run_id: str,
    *,
    root: Path | None = None,
) -> dict[str, Any] | None:
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise TSForecastAnchorError("Invalid TS forecast run id")
    record = eligible_forecast_record_for_run(
        root or runtime_path("ts_calibration"),
        run_id,
    )
    return None if record is None else _forecast_anchor(record)


def calibration_provenance_for_run(
    run_id: str,
    *,
    root: Path | None = None,
) -> dict[str, Any] | None:
    """Return one validated provenance v1 object without storage details."""
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise TSProvenanceQueryError("Invalid TS provenance run id")
    matches = [
        value
        for value in provenance_records(root or runtime_path("ts_calibration"))
        if value["forecast_run_id"] == run_id
    ]
    if len(matches) > 1:
        raise TSProvenanceQueryError("Duplicate TS provenance run id")
    return None if not matches else matches[0]


def calibration_provenance_inventory(
    *,
    root: Path | None = None,
    eligibility: str | None = None,
    forecast_role: str | None = None,
    cohort_id: str | None = None,
    release_commit: str | None = None,
    report_type: str | None = None,
    forecast_horizon: str | None = None,
) -> list[dict[str, Any]]:
    """Return a validated, read-only provenance v1 inventory."""
    if (
        eligibility is not None
        and (
            not isinstance(eligibility, str)
            or eligibility not in PROVENANCE_ELIGIBILITY
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance eligibility")
    if (
        forecast_role is not None
        and (
            not isinstance(forecast_role, str)
            or forecast_role not in PROVENANCE_ROLES
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance role")
    if (
        cohort_id is not None
        and (
            not isinstance(cohort_id, str)
            or COHORT_ID_RE.fullmatch(cohort_id) is None
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance cohort")
    if (
        release_commit is not None
        and (
            not isinstance(release_commit, str)
            or RELEASE_COMMIT_RE.fullmatch(release_commit) is None
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance release")
    if (
        report_type is not None
        and (
            not isinstance(report_type, str)
            or report_type not in REPORT_TYPES
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance report type")
    if (
        forecast_horizon is not None
        and (
            not isinstance(forecast_horizon, str)
            or forecast_horizon not in FORECAST_HORIZONS
        )
    ):
        raise TSProvenanceQueryError("Invalid TS provenance horizon")
    return [
        value
        for value in provenance_records(root or runtime_path("ts_calibration"))
        if (
            (eligibility is None or value["eligibility"] == eligibility)
            and (
                forecast_role is None
                or value["forecast_role"] == forecast_role
            )
            and (cohort_id is None or value["cohort_id"] == cohort_id)
            and (
                release_commit is None
                or value["release_commit"] == release_commit
            )
            and (report_type is None or value["report_type"] == report_type)
            and (
                forecast_horizon is None
                or value["forecast_window"]["horizon"]
                == forecast_horizon
            )
        )
    ]


def run_settlement(
    dataset: dict[str, Any],
    *,
    as_of: datetime,
) -> dict[str, Any]:
    root = runtime_path("ts_calibration")
    result = settle_due_forecasts(root, dataset, as_of=as_of)
    atomic_write_json(root / "state" / "latest-settlement-run.json", result)
    return result


def swing_scorecard_for_run(
    run_id: str,
    *,
    root: Path | None = None,
) -> dict[str, Any] | None:
    """Return one validated read-only v1 swing scorecard."""
    if RUN_ID_RE.fullmatch(run_id) is None:
        raise TSForecastAnchorError("Invalid TS swing scorecard run id")
    matches = [
        value
        for value in swing_scorecard_records(
            root or runtime_path("ts_calibration")
        )
        if value["forecast_run_id"] == run_id
    ]
    if len(matches) > 1:
        raise TSForecastAnchorError("Duplicate TS swing scorecard run id")
    return None if not matches else matches[0]


def daily_calibration_for_market_date(
    market_date: str,
    *,
    root: Path | None = None,
    cohort_id: str | None = None,
    release_commit: str | None = None,
    report_type: str = "INTRADAY_30_60M",
    forecast_horizon: str = "NEXT_30_TO_60_MINUTES",
) -> dict[str, Any] | None:
    """Return the validated v2 calibration summary through TS's public API."""
    return _daily_calibration_summary(
        root or runtime_path("ts_calibration"),
        market_date,
        cohort_id=cohort_id,
        release_commit=release_commit,
        report_type=report_type,
        forecast_horizon=forecast_horizon,
    )


def validate_forecast_anchor(value: Any) -> dict[str, Any]:
    fields = {
        "contract_version",
        "component",
        "forecast_run_id",
        "forecast_hash",
        "report_type",
        "market_date",
        "issued_at",
        "anchor_hash",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise TSForecastAnchorError("Invalid TS forecast anchor fields")
    body = {key: item for key, item in value.items() if key != "anchor_hash"}
    try:
        issued_at = datetime.fromisoformat(
            str(value["issued_at"]).replace("Z", "+00:00")
        )
        date.fromisoformat(str(value["market_date"]))
    except ValueError as exc:
        raise TSForecastAnchorError("Invalid TS forecast anchor time") from exc
    if (
        value["contract_version"] != "v2"
        or value["component"] != "TS_FORECAST_ANCHOR"
        or RUN_ID_RE.fullmatch(str(value["forecast_run_id"])) is None
        or HASH_RE.fullmatch(str(value["forecast_hash"])) is None
        or value["report_type"] not in REPORT_TYPES
        or issued_at.tzinfo is None
        or HASH_RE.fullmatch(str(value["anchor_hash"])) is None
        or value["anchor_hash"] != sha256_json(body)
    ):
        raise TSForecastAnchorError("Invalid TS forecast anchor identity")
    return value


def _forecast_anchor(record: dict[str, Any]) -> dict[str, Any]:
    body = {
        "contract_version": "v2",
        "component": "TS_FORECAST_ANCHOR",
        "forecast_run_id": record["forecast_run_id"],
        "forecast_hash": record["forecast_hash"],
        "report_type": record["report_type"],
        "market_date": record["market_date"],
        "issued_at": record["issued_at"],
    }
    return validate_forecast_anchor(
        {**body, "anchor_hash": sha256_json(body)}
    )
