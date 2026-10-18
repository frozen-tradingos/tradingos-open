from __future__ import annotations

import json
import math
import os
import re
import subprocess
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from trading_os_v2.common.config import ROOT, PACKAGE_ROOT, package_data_path, runtime_path
from trading_os_v2.common.io import atomic_write_json, iso_now, sha256_json


ROLE_FILES = {
    "TS": (
        ROOT / "trading_os_v2" / "ts" / "instructions.md",
        ROOT / "contracts" / "v2" / "ts-output.schema.json",
        "TS",
    ),
    "COMMITTEE": (
        ROOT / "trading_os_v2" / "committee" / "instructions.md",
        ROOT / "contracts" / "v1" / "committee-output.schema.json",
        "COMMITTEE",
    ),
    "D": (
        ROOT / "trading_os_v2" / "d" / "instructions.md",
        ROOT / "contracts" / "v1" / "d-output.schema.json",
        "D",
    ),
    "A3_REVIEW": (
        ROOT / "trading_os_v2" / "a3" / "review.md",
        ROOT / "contracts" / "v1" / "a3-review.schema.json",
        "A3_REVIEW",
    ),
    "A3": (
        ROOT / "trading_os_v2" / "a3" / "final.md",
        ROOT / "contracts" / "v1" / "a3-final.schema.json",
        "A3",
    ),
    "CODEX_GUARD": (
        ROOT / "trading_os_v2" / "codex_guard" / "instructions.md",
        ROOT / "contracts" / "v1" / "codex-guard.schema.json",
        "CODEX_GUARD",
    ),
}

PATTERN_STATES = {
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

PT_ZONE = ZoneInfo("America/Los_Angeles")
WINDOWS_DLL_INITIALIZATION_FAILURE = 0xC0000142
AGENT_OUTPUT_VERSIONS = {
    "TS": "v2",
    "COMMITTEE": "v1",
    "D": "v1",
    "A3_REVIEW": "v1",
    "A3": "v1",
    "CODEX_GUARD": "v1",
}
TS_ENHANCED_EVIDENCE = {
    "MARKET_MOVING_NEWS",
    "MACRO_SCHEDULE",
    "OIL_CONTEXT",
    "RATES_CONTEXT",
    "SECTOR_BREADTH",
    "OPTIONS_POSITIONING",
    "A2_HISTORICAL_SIMILARITY",
    "OVERNIGHT_FUTURES",
}
TS_CAUSAL_CHAIN_LIMIT = 8
TS_NEWS_VERIFICATION_RULES = frozenset(
    {"OFFICIAL_SINGLE_SOURCE", "SAME_CATEGORY_TWO_SOURCE"}
)
TS_OFFICIAL_NEWS_SOURCES = frozenset(
    {"Federal Reserve", "BLS", "BEA", "SEC"}
)
TS_LEGACY_CAUSAL_CONTEXT_FIELDS = frozenset(
    {"market_moving_news_events", "scheduled_macro_events"}
)
TS_SCHEDULED_TRANSMISSION = (
    "条件推演｜结果尚未发布；仅按高于、接近或低于预期，"
    "通过利率与风险偏好推演"
)
TS_SCHEDULED_INDEX_EFFECT = (
    "条件推演｜SPY/QQQ方向取决于公布值相对预期及公布后的利率反应"
)
MACRO_RESULT_RELEASES = {
    "Employment Situation": (
        "employment",
        {
            "PAYROLL_EMPLOYMENT_CHANGE": "JOBS",
            "UNEMPLOYMENT_RATE": "PERCENT",
            "AVERAGE_HOURLY_EARNINGS_CHANGE": "USD",
        },
    ),
    "Job Openings and Labor Turnover Survey": (
        "employment",
        {"JOB_OPENINGS": "JOBS"},
    ),
    "Consumer Price Index": (
        "inflation",
        {"CONSUMER_PRICE_INDEX_CHANGE": "PERCENT"},
    ),
    "Producer Price Index": (
        "inflation",
        {"PRODUCER_PRICE_INDEX_FINAL_DEMAND_CHANGE": "PERCENT"},
    ),
}


class AgentFailure(RuntimeError):
    pass


class CodexAgentRuntime:
    def __init__(self, timeout_seconds: int = 300):
        self.timeout_seconds = timeout_seconds
        self.executable = _find_codex()
        self.workspace = runtime_path("agent_workspace")
        self.workspace.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        role: str,
        evidence: dict[str, Any],
        supplemental: dict[str, Any] | None = None,
        *,
        ephemeral: bool = True,
    ) -> dict[str, Any]:
        if role not in ROLE_FILES:
            raise AgentFailure(f"Unknown role: {role}")
        _verify_packet(evidence)
        supplemental_context = supplemental or {}
        _verify_supplemental(supplemental_context)
        earnings_day_context = supplemental_context.get(
            "earnings_day_context"
        )
        instructions_path, schema_path, expected_role = ROLE_FILES[role]
        runtime_schema_path = _codex_output_schema_path(
            schema_path,
            required_optional_properties=(
                {"earnings_day_coverage"}
                if earnings_day_context is not None
                else set()
            ),
        )
        run_id = evidence["run_id"]
        diagnostic_id = uuid4().hex

        def record_final_failure(
            attempt_number: int,
            return_code: int | None,
            summary: str,
        ) -> None:
            atomic_write_json(
                runtime_path(
                    "agent_diagnostics",
                    f"{role.lower()}-{run_id}-{diagnostic_id}-final.json",
                ),
                {
                    "contract_version": "v1",
                    "created_at": iso_now(),
                    "role": role,
                    "run_id": run_id,
                    "attempt": attempt_number,
                    "return_code": return_code,
                    "error_summary": summary,
                },
            )

        def record_retry(
            attempt_number: int,
            return_code: int | None,
            summary: str,
        ) -> None:
            atomic_write_json(
                runtime_path(
                    "agent_diagnostics",
                    f"{role.lower()}-{run_id}-{diagnostic_id}"
                    f"-attempt-{attempt_number}.json",
                ),
                {
                    "contract_version": "v1",
                    "created_at": iso_now(),
                    "role": role,
                    "run_id": run_id,
                    "attempt": attempt_number,
                    "return_code": return_code,
                    "error_summary": summary,
                    "retry_planned": True,
                },
            )

        output_path = runtime_path(role.lower(), f"{run_id}.json")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        prompt_parts = [
            instructions_path.read_text(encoding="utf-8"),
            "The evidence packet below is immutable. Its SHA-256 is "
            f"{evidence['packet_hash']}.",
            "FROZEN_EVIDENCE_PACKET:",
            json.dumps(evidence, ensure_ascii=False, separators=(",", ":")),
            "SUPPLEMENTAL_CONTEXT:",
            json.dumps(
                supplemental_context,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        ]
        if role == "TS" and isinstance(
            supplemental_context.get("ts_report_context"),
            dict,
        ):
            prompt_parts.extend(
                [
                    "TS_MACHINE_OWNED_CAUSAL_CLAIMS:",
                    json.dumps(
                        _ts_machine_causal_claims(
                            evidence,
                            supplemental_context["ts_report_context"],
                        ),
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                ]
            )
        prompt_parts.append("Return only the schema-conforming JSON object.")
        prompt = "\n\n".join(prompt_parts)
        disabled = ("plugins", "apps", "shell_tool", "unified_exec", "hooks", "memories", "multi_agent", "browser_use", "computer_use", "image_generation", "view_image", "code_mode", "code_mode_only", "code_mode_host", "skill_search", "workspace_dependencies")
        command = [
            str(self.executable),
            "exec",
            "--ignore-user-config",
            "-c",
            'cli_auth_credentials_store="file"',
            "-c",
            'mcp_oauth_credentials_store="file"',
            "-c",
            'web_search="disabled"',
            "--ignore-rules",
            *(item for feature in disabled for item in ("--disable", feature)),
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            str(self.workspace),
            "--output-schema",
            str(runtime_schema_path),
            "-o",
            str(output_path),
            "--color",
            "never",
        ]
        if ephemeral:
            command.append("--ephemeral")
        command.append("-")
        for attempt in range(2):
            try:
                result = subprocess.run(
                    command,
                    input=prompt,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    capture_output=True,
                    timeout=self.timeout_seconds,
                    env=_sanitized_environment(),
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                record_final_failure(
                    attempt + 1,
                    None,
                    f"{role} timed out",
                )
                raise AgentFailure(f"{role} timed out") from exc
            if result.returncode != 0:
                if (
                    attempt == 0
                    and _is_windows_dll_initialization_failure(
                        result.returncode
                    )
                ):
                    record_retry(
                        1,
                        result.returncode,
                        _diagnostic_process_failure_summary(
                            result.returncode
                        ),
                    )
                    time.sleep(1)
                    continue
                summary = _failure_summary(
                    result.stderr or result.stdout,
                    result.returncode,
                )
                record_final_failure(
                    attempt + 1,
                    result.returncode,
                    _diagnostic_process_failure_summary(result.returncode),
                )
                raise AgentFailure(f"{role} failed: {summary[:500]}")
            try:
                output = json.loads(output_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, UnicodeError, json.JSONDecodeError) as exc:
                summary = f"{role} returned invalid structured output"
                record_final_failure(attempt + 1, result.returncode, summary)
                raise AgentFailure(summary) from exc
            try:
                _verify_agent_output(
                    output,
                    expected_role,
                    evidence=evidence,
                    supplemental=supplemental_context,
                    earnings_day_context=earnings_day_context,
                )
            except AgentFailure as exc:
                if role == "TS" and attempt == 0:
                    summary = str(exc)[:500]
                    record_retry(1, result.returncode, summary)
                    prompt = _ts_correction_prompt(prompt, summary)
                    continue
                record_final_failure(
                    attempt + 1,
                    result.returncode,
                    str(exc)[:500],
                )
                raise
            return output
        raise AssertionError("unreachable Agent runtime retry state")


def _codex_output_schema_path(
    schema_path: Path,
    *,
    required_optional_properties: set[str] | None = None,
) -> Path:
    """Compile a provider-compatible schema while preserving local validation."""
    try:
        source = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AgentFailure("Agent output schema is unreadable") from exc
    if not isinstance(source, dict):
        raise AgentFailure("Agent output schema must be an object")
    compiled, schema_changed = _compile_nullable_unions(source, root=source)
    properties = compiled.get("properties")
    required = compiled.get("required")
    if not isinstance(properties, dict) or not isinstance(required, list):
        raise AgentFailure("Agent output schema root object is invalid")
    optional = set(properties) - set(required)
    requested = required_optional_properties or set()
    if optional - {"earnings_day_coverage"} or requested - optional:
        raise AgentFailure("Agent output schema has unsupported optional properties")
    for name in sorted(optional):
        if name in requested:
            required.append(name)
        else:
            properties.pop(name)
    changed = bool(optional) or schema_changed
    if not changed:
        return schema_path
    target = runtime_path(
        "agent_runtime",
        "schemas",
        f"{schema_path.stem}-{sha256_json(compiled)[:16]}.json",
    )
    atomic_write_json(target, compiled)
    return target


def _compile_nullable_unions(
    value: Any,
    *,
    root: dict[str, Any],
) -> tuple[Any, bool]:
    if isinstance(value, list):
        compiled_items = [
            _compile_nullable_unions(item, root=root) for item in value
        ]
        return (
            [item for item, _ in compiled_items],
            any(changed for _, changed in compiled_items),
        )
    if not isinstance(value, dict):
        return value, False

    current = dict(value)
    changed = False
    if "uniqueItems" in current:
        if current.pop("uniqueItems") is not True:
            raise AgentFailure(
                "Agent output schema contains an unsupported uniqueItems value"
            )
        changed = True
    if "oneOf" in current:
        variants = current.pop("oneOf")
        if not _is_disjoint_nullable_union(variants, root):
            raise AgentFailure(
                "Agent output schema contains an unsupported oneOf union"
            )
        current["anyOf"] = variants
        changed = True
    compiled: dict[str, Any] = {}
    for key, child in current.items():
        compiled_child, child_changed = _compile_nullable_unions(
            child,
            root=root,
        )
        compiled[key] = compiled_child
        changed = changed or child_changed
    return compiled, changed


def _is_disjoint_nullable_union(
    variants: Any,
    root: dict[str, Any],
) -> bool:
    if not isinstance(variants, list) or len(variants) != 2:
        return False
    null_variants = [
        item
        for item in variants
        if isinstance(item, dict) and item == {"type": "null"}
    ]
    non_null = [item for item in variants if item not in null_variants]
    if len(null_variants) != 1 or len(non_null) != 1:
        return False
    candidate = non_null[0]
    if not isinstance(candidate, dict):
        return False
    declared_type = candidate.get("type")
    if isinstance(declared_type, str):
        return declared_type != "null"
    reference = candidate.get("$ref")
    if not isinstance(reference, str) or not reference.startswith("#/$defs/"):
        return False
    target = root.get("$defs", {}).get(reference.removeprefix("#/$defs/"))
    return isinstance(target, dict) and target.get("type") not in {None, "null"}


def _verify_packet(packet: dict[str, Any]) -> None:
    if packet.get("contract_version") != "v1":
        raise AgentFailure("Unknown frozen evidence contract version")
    expected = packet.get("packet_hash", "")
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    if not expected or sha256_json(payload) != expected:
        raise AgentFailure("Frozen evidence packet hash mismatch")
    _verify_explicit_contract_versions(packet)
    _verify_a1_public_contracts(packet)
    _verify_a2_public_contracts(packet)


def _verify_explicit_contract_versions(value: Any) -> None:
    if isinstance(value, dict):
        if (
            "contract_version" in value
            and value["contract_version"] != "v1"
        ):
            raise AgentFailure("Unknown nested evidence contract version")
        for child in value.values():
            _verify_explicit_contract_versions(child)
    elif isinstance(value, list):
        for child in value:
            _verify_explicit_contract_versions(child)


def _verify_a1_public_contracts(packet: dict[str, Any]) -> None:
    a1 = packet.get("a1")
    if a1 is None:
        return
    if not isinstance(a1, dict):
        raise AgentFailure("Invalid A1 evidence object")
    if "earnings_watch" not in a1:
        raise AgentFailure("Missing A1 earnings watch v1 contract")
    if "macro_results" not in a1:
        raise AgentFailure("Missing A1 macro results v1 contract")
    _verify_earnings_watch(a1["earnings_watch"], packet.get("created_at"))
    _verify_macro_results(a1["macro_results"], packet.get("created_at"))


def _verify_macro_results(
    value: Any,
    packet_created_at: Any,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise AgentFailure("Invalid A1 macro results v1 contract")
    try:
        created_at = _aware_datetime(packet_created_at)
    except (TypeError, ValueError) as exc:
        raise AgentFailure("Invalid A1 macro results v1 contract") from exc
    schedule_ids: set[str] = set()
    result_hashes: set[str] = set()
    results: list[dict[str, Any]] = []
    for raw_result in value:
        result = _verify_macro_result(raw_result, created_at)
        if (
            result["schedule_event_fingerprint"] in schedule_ids
            or result["result_hash"] in result_hashes
        ):
            raise AgentFailure("Invalid A1 macro results v1 contract")
        schedule_ids.add(result["schedule_event_fingerprint"])
        result_hashes.add(result["result_hash"])
        results.append(result)
    return results


def _verify_macro_result(
    value: Any,
    packet_created_at: datetime,
) -> dict[str, Any]:
    result = _exact_object(
        value,
        {
            "contract_version",
            "component",
            "actionable",
            "status",
            "generated_at",
            "timezone",
            "market_date",
            "selection_rule",
            "schedule_event_fingerprint",
            "category",
            "release_name",
            "scheduled_at",
            "published_at",
            "source",
            "source_url",
            "raw_item_hash",
            "confidence",
            "metrics",
            "result_hash",
        },
        "A1 macro result",
    )
    if (
        result["contract_version"] != "v1"
        or result["component"] != "A1_MACRO_RESULT"
        or result["actionable"] is not False
        or not isinstance(result["status"], str)
        or result["status"] not in {"VERIFIED", "MISSING", "DEGRADED"}
        or result["timezone"] != "America/Los_Angeles"
        or result["selection_rule"]
        != "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        or not _is_hash(result["schedule_event_fingerprint"])
        or not _is_hash(result["result_hash"])
        or not isinstance(result["metrics"], list)
        or len(result["metrics"]) > 3
    ):
        raise AgentFailure("Invalid A1 macro result v1 contract")
    release = (
        MACRO_RESULT_RELEASES.get(result["release_name"])
        if isinstance(result["release_name"], str)
        else None
    )
    if release is None or result["category"] != release[0]:
        raise AgentFailure("Invalid A1 macro result v1 contract")
    try:
        generated_at = _aware_datetime(result["generated_at"])
        scheduled_at = _aware_datetime(result["scheduled_at"])
        market_date = date.fromisoformat(result["market_date"])
    except (TypeError, ValueError) as exc:
        raise AgentFailure("Invalid A1 macro result v1 contract") from exc
    generated_pt = generated_at.astimezone(PT_ZONE)
    scheduled_pt = scheduled_at.astimezone(PT_ZONE)
    created_pt = packet_created_at.astimezone(PT_ZONE)
    schedule_identity = {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "category": result["category"],
        "release_name": result["release_name"],
        "scheduled_at": scheduled_pt.isoformat(),
        "source": "BLS Official Release Calendar",
    }
    hash_payload = {
        key: item
        for key, item in result.items()
        if key not in {"generated_at", "result_hash"}
    }
    if (
        result["scheduled_at"] != scheduled_pt.isoformat()
        or result["schedule_event_fingerprint"]
        != sha256_json(schedule_identity)
        or result["result_hash"] != sha256_json(hash_payload)
        or market_date != generated_pt.date()
        or market_date != scheduled_pt.date()
        or market_date != created_pt.date()
        or scheduled_at > generated_at
        or generated_at > packet_created_at
    ):
        raise AgentFailure("Invalid A1 macro result v1 contract")

    if result["status"] == "VERIFIED":
        if (
            result["source"] != "BLS"
            or not isinstance(result["source_url"], str)
            or re.match(r"^https://www\.bls\.gov/", result["source_url"])
            is None
            or not _is_hash(result["raw_item_hash"])
            or result["confidence"] != "official_result"
        ):
            raise AgentFailure("Invalid A1 macro result v1 contract")
        try:
            published_at = _aware_datetime(result["published_at"])
        except (TypeError, ValueError) as exc:
            raise AgentFailure("Invalid A1 macro result v1 contract") from exc
        if not scheduled_at <= published_at <= generated_at:
            raise AgentFailure("Invalid A1 macro result v1 contract")
        _verify_macro_result_metrics(result["metrics"], release[1])
    elif (
        any(
            result[field] is not None
            for field in (
                "published_at",
                "source",
                "source_url",
                "raw_item_hash",
                "confidence",
            )
        )
        or result["metrics"]
    ):
        raise AgentFailure("Invalid A1 macro result v1 contract")
    return result


def _verify_macro_result_metrics(
    value: list[Any],
    expected: dict[str, str],
) -> None:
    if len(value) != len(expected):
        raise AgentFailure("Invalid A1 macro result metric v1 contract")
    names: set[str] = set()
    canonical_metrics: set[str] = set()
    for raw_metric in value:
        metric = _exact_object(
            raw_metric,
            {"name", "value", "unit", "period", "preliminary"},
            "A1 macro result metric",
        )
        numeric = metric["value"]
        try:
            period = date.fromisoformat(f"{metric['period']}-01")
        except (TypeError, ValueError) as exc:
            raise AgentFailure(
                "Invalid A1 macro result metric v1 contract"
            ) from exc
        if (
            not isinstance(metric["name"], str)
            or expected.get(metric["name"]) != metric["unit"]
            or metric["name"] in names
            or isinstance(numeric, bool)
            or not isinstance(numeric, (int, float))
            or not math.isfinite(numeric)
            or not -1_000_000_000_000 <= numeric <= 1_000_000_000_000
            or not isinstance(metric["preliminary"], bool)
            or metric["period"] != period.strftime("%Y-%m")
        ):
            raise AgentFailure("Invalid A1 macro result metric v1 contract")
        canonical = json.dumps(
            metric,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        if canonical in canonical_metrics:
            raise AgentFailure("Invalid A1 macro result metric v1 contract")
        canonical_metrics.add(canonical)
        names.add(metric["name"])
    if names != set(expected):
        raise AgentFailure("Invalid A1 macro result metric v1 contract")


def _verify_earnings_watch(value: Any, packet_created_at: Any) -> None:
    watch = _exact_object(
        value,
        {
            "contract_version",
            "component",
            "actionable",
            "status",
            "generated_at",
            "timezone",
            "window_start",
            "window_end",
            "selection_rule",
            "events",
        },
        "A1 earnings watch",
    )
    if (
        watch["contract_version"] != "v1"
        or watch["component"] != "A1_EARNINGS_WATCH"
        or watch["actionable"] is not False
        or watch["status"] not in {"HEALTHY", "DEGRADED"}
        or watch["timezone"] != "America/Los_Angeles"
        or watch["selection_rule"]
        != "TOP_20_ABSOLUTE_REVENUE_ESTIMATE"
        or not isinstance(watch["events"], list)
        or len(watch["events"]) > 20
    ):
        raise AgentFailure("Invalid A1 earnings watch v1 contract")
    try:
        generated_at = _aware_datetime(watch["generated_at"])
        created_at = _aware_datetime(packet_created_at)
        window_start = date.fromisoformat(watch["window_start"])
        window_end = date.fromisoformat(watch["window_end"])
    except (TypeError, ValueError) as exc:
        raise AgentFailure("Invalid A1 earnings watch v1 contract") from exc
    if (
        generated_at > created_at
        or window_start != generated_at.astimezone(PT_ZONE).date()
        or window_end != window_start + timedelta(days=6)
    ):
        raise AgentFailure("Invalid A1 earnings watch v1 contract")

    event_ids: set[str] = set()
    for rank, raw_event in enumerate(watch["events"], start=1):
        event = _verify_earnings_event(
            raw_event,
            valid_start=window_start,
            valid_end=window_end,
            expected_rank=rank,
        )
        if event["event_id"] in event_ids:
            raise AgentFailure("Invalid A1 earnings watch event v1 contract")
        event_ids.add(event["event_id"])


def _verify_earnings_event(
    value: Any,
    *,
    valid_start: date,
    valid_end: date,
    expected_rank: int | None = None,
) -> dict[str, Any]:
    event = _exact_object(
        value,
        {
            "event_id",
            "symbol",
            "date",
            "session",
            "eps_estimate",
            "revenue_estimate",
            "importance_rank",
            "market_impact_status",
            "source",
            "confidence",
        },
        "A1 earnings watch event",
    )
    try:
        event_date = date.fromisoformat(event["date"])
    except (TypeError, ValueError) as exc:
        raise AgentFailure(
            "Invalid A1 earnings watch event v1 contract"
        ) from exc
    identity = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "symbol": event["symbol"],
        "date": event["date"],
        "session": event["session"],
    }
    numeric_values = (event["eps_estimate"], event["revenue_estimate"])
    if (
        not _is_hash(event["event_id"])
        or event["event_id"] != sha256_json(identity)
        or not isinstance(event["symbol"], str)
        or re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", event["symbol"]) is None
        or not valid_start <= event_date <= valid_end
        or event["session"] not in {"BMO", "AMC", "UNKNOWN"}
        or type(event["importance_rank"]) is not int
        or not 1 <= event["importance_rank"] <= 20
        or (
            expected_rank is not None
            and event["importance_rank"] != expected_rank
        )
        or event["market_impact_status"] != "UNVERIFIED_CANDIDATE"
        or event["source"] != "Finnhub Earnings Calendar"
        or event["confidence"] != "scheduled_event"
        or any(
            item is not None
            and (
                isinstance(item, bool)
                or not isinstance(item, (int, float))
                or not math.isfinite(item)
            )
            for item in numeric_values
        )
    ):
        raise AgentFailure("Invalid A1 earnings watch event v1 contract")
    return event


def _aware_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise TypeError
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError
    return parsed


def _verify_a2_public_contracts(packet: dict[str, Any]) -> None:
    a2 = packet.get("a2")
    if a2 is None:
        return
    if not isinstance(a2, dict):
        raise AgentFailure("Invalid A2 evidence object")
    if "pattern_tracker" in a2:
        _verify_pattern_tracker(a2["pattern_tracker"])
    if "trend_pullback" in a2:
        _verify_trend_pullback(a2["trend_pullback"])


def _verify_pattern_tracker(value: Any) -> None:
    fields = {
        "contract_version",
        "status",
        "updated_at",
        "cadence_minutes",
        "confirmation_bars",
        "symbols",
    }
    tracker = _exact_object(value, fields, "A2 pattern tracker")
    if (
        tracker["contract_version"] != "v1"
        or tracker["status"]
        not in {"HEALTHY", "DEGRADED", "INACTIVE", "INITIALIZING"}
        or not isinstance(tracker["updated_at"], str)
        or type(tracker["cadence_minutes"]) is not int
        or tracker["cadence_minutes"] != 15
        or type(tracker["confirmation_bars"]) is not int
        or tracker["confirmation_bars"] != 3
    ):
        raise AgentFailure("Invalid A2 pattern tracker v1 contract")
    symbols = _exact_object(
        tracker["symbols"],
        {"SPY", "QQQ"},
        "A2 pattern tracker symbols",
    )
    symbol_fields = {
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
    for symbol in ("SPY", "QQQ"):
        state = _exact_object(
            symbols[symbol],
            symbol_fields,
            f"A2 pattern tracker {symbol}",
        )
        if (
            state["symbol"] != symbol
            or state["current_state"] not in PATTERN_STATES
            or state["candidate_state"] not in PATTERN_STATES
            or type(state["candidate_bars"]) is not int
            or not 0 <= state["candidate_bars"] <= 3
            or state["direction"]
            not in {"bullish", "bearish", "neutral", "unknown"}
            or state["structure"]
            not in {
                "trend",
                "range",
                "chop",
                "reversal",
                "breakout_failure",
                "transition",
                "unknown",
            }
            or state["volatility"] not in {"low", "normal", "high", "unknown"}
            or state["speed"] not in {"slow", "normal", "fast", "unknown"}
            or any(
                not isinstance(state[field], str)
                for field in (
                    "data_time",
                    "state_since",
                    "last_processed_bar_time",
                )
            )
        ):
            raise AgentFailure("Invalid A2 pattern tracker v1 contract")
        transition = state["last_transition"]
        if transition is not None:
            transition = _exact_object(
                transition,
                {
                    "transition_id",
                    "symbol",
                    "from_state",
                    "to_state",
                    "confirmed_at",
                    "data_time",
                },
                f"A2 pattern tracker {symbol} transition",
            )
            if (
                not isinstance(transition["transition_id"], str)
                or not transition["transition_id"]
                or transition["symbol"] not in {"SPY", "QQQ"}
                or transition["from_state"] not in PATTERN_STATES
                or transition["to_state"] not in PATTERN_STATES
                or not isinstance(transition["confirmed_at"], str)
                or not isinstance(transition["data_time"], str)
            ):
                raise AgentFailure("Invalid A2 pattern tracker v1 contract")


def _verify_trend_pullback(value: Any) -> None:
    pullback = _exact_object(
        value,
        {
            "contract_version",
            "status",
            "policy",
            "trade_action",
            "symbols",
        },
        "A2 trend pullback",
    )
    if (
        pullback["contract_version"] != "v1"
        or pullback["status"] not in {"HEALTHY", "DEGRADED", "INACTIVE"}
        or pullback["policy"] != "TREND_ALIGNED_PULLBACK_ONLY"
        or pullback["trade_action"] is not False
    ):
        raise AgentFailure("Invalid A2 trend pullback v1 contract")
    symbols = pullback["symbols"]
    if (
        not isinstance(symbols, dict)
        or not set(symbols) <= {"SPY", "QQQ"}
        or (
            pullback["status"] == "HEALTHY"
            and set(symbols) != {"SPY", "QQQ"}
        )
    ):
        raise AgentFailure("Invalid A2 trend pullback v1 contract")
    symbol_fields = {"data_time", "regime", "context_hash", "call", "put"}
    for symbol, raw in symbols.items():
        state = _exact_object(
            raw,
            symbol_fields,
            f"A2 trend pullback {symbol}",
        )
        if (
            not isinstance(state["data_time"], str)
            or state["regime"] not in PATTERN_STATES
            or not isinstance(state["context_hash"], str)
            or re.fullmatch(r"(?:|[0-9a-f]{64})", state["context_hash"]) is None
        ):
            raise AgentFailure("Invalid A2 trend pullback v1 contract")
        for side in ("call", "put"):
            assessment = _exact_object(
                state[side],
                {"eligibility", "reason", "evidence"},
                f"A2 trend pullback {symbol} {side}",
            )
            if (
                not isinstance(assessment["eligibility"], bool)
                or not isinstance(assessment["reason"], str)
                or not assessment["reason"]
                or not isinstance(assessment["evidence"], list)
                or any(
                    not isinstance(item, str) or not item
                    for item in assessment["evidence"]
                )
            ):
                raise AgentFailure("Invalid A2 trend pullback v1 contract")


def _exact_object(
    value: Any,
    fields: set[str],
    label: str,
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise AgentFailure(f"Invalid {label} v1 contract")
    return value


def _verify_supplemental(value: Any) -> None:
    if isinstance(value, dict):
        if TS_LEGACY_CAUSAL_CONTEXT_FIELDS & value.keys():
            raise AgentFailure(
                "Legacy unversioned TS causal evidence fields are forbidden"
            )
        if "earnings_day_context" in value:
            _verify_earnings_day_context(value["earnings_day_context"])
        role = value.get("role")
        if role in AGENT_OUTPUT_VERSIONS:
            if value.get("contract_version") != AGENT_OUTPUT_VERSIONS[role]:
                raise AgentFailure("Missing supplemental Agent contract version")
        elif (
            "contract_version" in value
            and value["contract_version"] != "v1"
        ):
            raise AgentFailure("Unknown supplemental input contract version")
        for child in value.values():
            _verify_supplemental(child)
    elif isinstance(value, list):
        for child in value:
            _verify_supplemental(child)


def validate_earnings_day_context(value: Any) -> None:
    """Reject malformed or unknown-version earnings-day context."""
    _verify_earnings_day_context(value)


def validate_earnings_day_coverage(
    output: dict[str, Any],
    role: str,
    context: dict[str, Any],
) -> None:
    """Verify exact TS/A3 coverage against one earnings-day context."""
    if role not in {"TS", "A3"}:
        raise AgentFailure("Earnings day coverage is only valid for TS or A3")
    _verify_agent_output(
        output,
        role,
        earnings_day_context=context,
    )


def _verify_earnings_day_context(value: Any) -> None:
    context = _exact_object(
        value,
        {
            "contract_version",
            "component",
            "actionable",
            "scheduled_day",
            "timezone",
            "sunday_day",
            "sunday_run_id",
            "sunday_packet_hash",
            "sunday_information_hash",
            "sunday_bulletin_delivery_key",
            "day_bulletin_delivery_key",
            "candidates",
            "candidates_hash",
            "context_hash",
        },
        "earnings day context",
    )
    try:
        scheduled_day = date.fromisoformat(context["scheduled_day"])
        sunday_day = date.fromisoformat(context["sunday_day"])
    except (TypeError, ValueError) as exc:
        raise AgentFailure("Invalid earnings day context v1 contract") from exc
    expected_sunday = scheduled_day - timedelta(
        days=scheduled_day.weekday() + 1
    )
    candidates = context["candidates"]
    if (
        context["contract_version"] != "v1"
        or context["component"] != "EARNINGS_DAY_CONTEXT"
        or context["actionable"] is not False
        or context["timezone"] != "America/Los_Angeles"
        or scheduled_day.weekday() > 4
        or sunday_day != expected_sunday
        or not isinstance(context["sunday_run_id"], str)
        or not context["sunday_run_id"]
        or context["sunday_bulletin_delivery_key"]
        != f"a1-earnings-weekly-{sunday_day.isoformat()}"
        or context["day_bulletin_delivery_key"]
        != f"a1-earnings-day-{scheduled_day.isoformat()}"
        or not isinstance(candidates, list)
        or not 1 <= len(candidates) <= 20
        or not _is_hash(context["sunday_packet_hash"])
        or not _is_hash(context["sunday_information_hash"])
        or not _is_hash(context["candidates_hash"])
        or context["candidates_hash"] != sha256_json(candidates)
    ):
        raise AgentFailure("Invalid earnings day context v1 contract")
    event_ids: set[str] = set()
    ranks: set[int] = set()
    for raw_event in candidates:
        event = _verify_earnings_event(
            raw_event,
            valid_start=scheduled_day,
            valid_end=scheduled_day,
        )
        if (
            event["event_id"] in event_ids
            or event["importance_rank"] in ranks
        ):
            raise AgentFailure("Invalid earnings day context v1 contract")
        event_ids.add(event["event_id"])
        ranks.add(event["importance_rank"])
    payload = {
        key: item
        for key, item in context.items()
        if key != "context_hash"
    }
    if (
        not _is_hash(context["context_hash"])
        or context["context_hash"] != sha256_json(payload)
    ):
        raise AgentFailure("Invalid earnings day context v1 contract")


def _verify_agent_output(
    output: dict[str, Any],
    expected_role: str,
    *,
    evidence: dict[str, Any] | None = None,
    supplemental: dict[str, Any] | None = None,
    earnings_day_context: dict[str, Any] | None = None,
) -> None:
    expected_version = AGENT_OUTPUT_VERSIONS.get(expected_role)
    if output.get("contract_version") != expected_version:
        raise AgentFailure("Unknown Agent output contract version")
    if output.get("role") != expected_role:
        raise AgentFailure(f"{expected_role} returned the wrong role contract")
    if expected_role == "TS" and evidence is not None:
        _verify_ts_output(output, evidence, supplemental or {})
    coverage = output.get("earnings_day_coverage")
    if earnings_day_context is None:
        if coverage is not None:
            raise AgentFailure(
                f"{expected_role} returned unbound earnings day coverage"
            )
        return
    _verify_earnings_day_context(earnings_day_context)
    if expected_role not in {"TS", "A3"}:
        return
    candidates = {
        item["event_id"]: item["symbol"]
        for item in earnings_day_context["candidates"]
    }
    if not isinstance(coverage, list) or len(coverage) != len(candidates):
        raise AgentFailure(
            f"{expected_role} earnings day coverage is incomplete"
        )
    covered: dict[str, str] = {}
    for raw_item in coverage:
        item = _exact_object(
            raw_item,
            {"event_id", "symbol", "treatment", "summary"},
            f"{expected_role} earnings day coverage",
        )
        event_id = item["event_id"]
        symbol = item["symbol"]
        if (
            not isinstance(event_id, str)
            or candidates.get(event_id) != symbol
            or event_id in covered
            or item["treatment"] != "SCHEDULE_RISK_ONLY"
            or not isinstance(item["summary"], str)
            or not item["summary"].strip()
        ):
            raise AgentFailure(
                f"{expected_role} earnings day coverage is invalid"
            )
        covered[event_id] = symbol
    if covered != candidates:
        raise AgentFailure(
            f"{expected_role} earnings day coverage is incomplete"
        )


def _ts_causal_horizon(
    context: dict[str, Any],
) -> tuple[datetime, datetime]:
    try:
        observed_at = _aware_datetime(
            context["evidence_snapshot"]["market_time"]["observed_at"]
        ).astimezone(PT_ZONE)
        report_type = context["report_type"]
        if report_type == "WEEKEND_OUTLOOK":
            horizon_end = observed_at + timedelta(days=7)
        elif report_type == "NEXT_SESSION":
            horizon_end = _aware_datetime(
                context["required_next_validation"]["at"]
            ).astimezone(PT_ZONE).replace(
                hour=13,
                minute=0,
                second=0,
                microsecond=0,
            )
        elif report_type in {
            "OPENING_FORECAST",
            "OPEN_15M_CHECK",
            "OPEN_30M_CHECK",
            "INTRADAY_30_60M",
        }:
            horizon_end = _aware_datetime(
                context["forecast_window"]["end_at"]
            ).astimezone(PT_ZONE)
        else:
            raise ValueError
    except (KeyError, TypeError, ValueError) as exc:
        raise AgentFailure("Invalid TS v2 causal event horizon") from exc
    if horizon_end <= observed_at:
        raise AgentFailure("Invalid TS v2 causal event horizon")
    return observed_at, horizon_end


def _ts_selected_event_evidence(
    evidence: dict[str, Any],
    context: dict[str, Any],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    if TS_LEGACY_CAUSAL_CONTEXT_FIELDS & context.keys():
        raise AgentFailure(
            "Legacy unversioned TS causal evidence fields are forbidden"
        )
    observed_at, horizon_end = _ts_causal_horizon(context)
    try:
        report_market_date = date.fromisoformat(
            context["evidence_snapshot"]["market_time"]["market_date"]
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AgentFailure("Invalid TS v2 macro result market date") from exc
    if report_market_date != observed_at.date():
        raise AgentFailure("Invalid TS v2 macro result market date")

    raw_results = evidence.get("a1", {}).get("macro_results", [])
    if raw_results:
        validated_results = _verify_macro_results(
            raw_results,
            evidence.get("created_at"),
        )
        selected_results = [
            result
            for result in validated_results
            if result["status"] == "VERIFIED"
            and result["market_date"] == report_market_date.isoformat()
        ]
    elif not isinstance(raw_results, list):
        raise AgentFailure("Invalid TS v2 macro result evidence")
    else:
        validated_results = []
        selected_results = []
    selected_results.sort(
        key=lambda result: (
            str(result["published_at"]),
            result["release_name"],
            result["result_hash"],
        )
    )
    if len(selected_results) > TS_CAUSAL_CHAIN_LIMIT:
        raise AgentFailure("TS v2 macro results exceed causal chain capacity")
    for result in selected_results:
        published_at = _aware_datetime(result["published_at"]).astimezone(
            PT_ZONE
        )
        if published_at > observed_at:
            raise AgentFailure("TS v2 macro result is newer than the report")

    macro_watch = evidence.get("a1", {}).get("macro_watch", {})
    frozen_scheduled = (
        macro_watch.get("events", [])
        if isinstance(macro_watch, dict)
        and macro_watch.get("contract_version") == "v1"
        and macro_watch.get("component") == "A1_MACRO_WATCH"
        and macro_watch.get("status") == "HEALTHY"
        else []
    )
    if not isinstance(frozen_scheduled, list):
        raise AgentFailure("Invalid TS v2 scheduled macro evidence")
    scheduled_in_window: list[tuple[datetime, dict[str, Any]]] = []
    for item in frozen_scheduled:
        if not isinstance(item, dict):
            raise AgentFailure("Invalid TS v2 scheduled macro evidence")
        fingerprint = item.get("event_fingerprint")
        category = item.get("category")
        if (
            not isinstance(fingerprint, str)
            or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None
            or not isinstance(category, str)
            or not category
        ):
            raise AgentFailure("Invalid TS v2 scheduled macro evidence")
        _ts_scheduled_event_claim(item)
        scheduled_at = _aware_datetime(item["scheduled_at"]).astimezone(
            PT_ZONE
        )
        if observed_at < scheduled_at <= horizon_end:
            scheduled_in_window.append((scheduled_at, item))
    result_schedule_ids = {
        result["schedule_event_fingerprint"] for result in validated_results
    }
    scheduled_ids = {
        item["event_fingerprint"] for item in frozen_scheduled
    }
    if result_schedule_ids & scheduled_ids:
        raise AgentFailure("TS v2 macro schedule/result identity conflicts")
    scheduled_in_window.sort(
        key=lambda row: (
            row[0],
            str(row[1].get("release_name", "")),
            row[1]["event_fingerprint"],
        )
    )
    selected_scheduled = [
        item
        for _scheduled_at, item in scheduled_in_window[
            : TS_CAUSAL_CHAIN_LIMIT - len(selected_results)
        ]
    ]

    health = evidence.get("a1", {}).get("health", {})
    verified_news = health.get("verified_market_moving_news") is True
    frozen_news = health.get("market_moving_news_evidence", [])
    if (
        not isinstance(frozen_news, list)
        or verified_news != bool(frozen_news)
    ):
        raise AgentFailure("Invalid TS v2 selected news evidence")
    grouped_news: dict[tuple[str, str], list[dict[str, Any]]] = {}
    latest_news: dict[tuple[str, str], datetime] = {}
    if verified_news:
        for item in frozen_news:
            if not isinstance(item, dict):
                raise AgentFailure("Invalid TS v2 selected news evidence")
            fingerprint = item.get("event_fingerprint")
            category = item.get("category")
            headline = item.get("headline")
            source = item.get("source")
            verification_rule = item.get("verification_rule")
            if (
                not isinstance(fingerprint, str)
                or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None
                or not isinstance(category, str)
                or not category
                or not isinstance(headline, str)
                or not headline.strip()
                or not isinstance(source, str)
                or not source.strip()
                or verification_rule not in TS_NEWS_VERIFICATION_RULES
            ):
                raise AgentFailure("Invalid TS v2 selected news evidence")
            try:
                published_at = _aware_datetime(item.get("published_at"))
            except (TypeError, ValueError) as exc:
                raise AgentFailure(
                    "Invalid TS v2 selected news evidence"
                ) from exc
            pair = (fingerprint, category)
            grouped_news.setdefault(pair, []).append(item)
            latest_news[pair] = max(
                latest_news.get(pair, published_at),
                published_at,
            )
    news_capacity = (
        TS_CAUSAL_CHAIN_LIMIT
        - len(selected_results)
        - len(selected_scheduled)
    )
    selected_pairs = sorted(
        grouped_news,
        key=lambda pair: (
            -latest_news[pair].timestamp(),
            pair[1],
            pair[0],
        ),
    )[:news_capacity]
    selected_news = [
        item
        for pair in selected_pairs
        for item in sorted(
            grouped_news[pair],
            key=lambda proof: (
                str(proof.get("published_at", "")),
                str(proof.get("source", "")),
                str(proof.get("headline", "")),
            ),
        )
    ]
    return selected_news, selected_scheduled, selected_results


def _ts_scheduled_event_claim(item: dict[str, Any]) -> dict[str, str]:
    release_name = item.get("release_name")
    scheduled_at = item.get("scheduled_at")
    if (
        not isinstance(release_name, str)
        or not release_name.strip()
        or not isinstance(scheduled_at, str)
        or item.get("market_impact_status") != "SCHEDULED_UNRELEASED"
        or item.get("result_status") != "UNKNOWN"
    ):
        raise AgentFailure("Invalid TS v2 unreleased macro identity")
    try:
        _aware_datetime(scheduled_at)
    except ValueError as exc:
        raise AgentFailure("Invalid TS v2 unreleased macro identity") from exc
    return {
        "event": f"未发布/结果未知｜{release_name.strip()}｜{scheduled_at}",
        "transmission": TS_SCHEDULED_TRANSMISSION,
        "index_effect": TS_SCHEDULED_INDEX_EFFECT,
    }


def _ts_machine_causal_claims(
    evidence: dict[str, Any],
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    selected_news, selected_scheduled, selected_results = (
        _ts_selected_event_evidence(evidence, context)
    )
    claims: dict[tuple[str, str], dict[str, Any]] = {}
    for result in selected_results:
        pair = (result["result_hash"], result["category"])
        if pair in claims:
            raise AgentFailure("TS v2 causal evidence identity is ambiguous")
        claims[pair] = {
            "event_fingerprint": result["result_hash"],
            "event_category": result["category"],
            "event": _ts_macro_result_claim(result),
            "evidence_state": "VERIFIED",
        }
    news_by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in selected_news:
        pair = (item["event_fingerprint"], item["category"])
        news_by_pair.setdefault(pair, []).append(item)
    for pair, items in news_by_pair.items():
        if pair in claims:
            raise AgentFailure("TS v2 causal evidence identity is ambiguous")
        verification_rules = {
            item.get("verification_rule") for item in items
        }
        sources = sorted(
            {str(item.get("source", "")).strip() for item in items}
        )
        if len(verification_rules) != 1 or not sources or not sources[0]:
            raise AgentFailure("Invalid TS v2 verified news identity")
        verification_rule = next(iter(verification_rules))
        canonical = min(
            items,
            key=lambda item: (
                str(item.get("published_at", "")),
                str(item.get("source", "")),
                str(item.get("headline", "")),
            ),
        )
        headline = canonical.get("headline")
        if not isinstance(headline, str) or not headline.strip():
            raise AgentFailure("Invalid TS v2 verified news identity")
        if verification_rule == "OFFICIAL_SINGLE_SOURCE":
            source = str(canonical.get("source", "")).strip()
            if any(item not in TS_OFFICIAL_NEWS_SOURCES for item in sources):
                raise AgentFailure("Invalid TS v2 verified news identity")
            event_text = (
                f"官方单源核验｜来源：{source}｜{headline.strip()}"
            )
        elif verification_rule == "SAME_CATEGORY_TWO_SOURCE":
            if len(sources) < 2:
                raise AgentFailure("Invalid TS v2 verified news identity")
            event_text = (
                f"多源交叉核验｜仅确认同一{pair[1]}事件身份；"
                "标题细节未逐项核实｜来源："
                + "、".join(sources)
            )
        else:
            raise AgentFailure("Invalid TS v2 verified news identity")
        claims[pair] = {
            "event_fingerprint": pair[0],
            "event_category": pair[1],
            "event": event_text,
            "evidence_state": "VERIFIED",
        }
    for item in selected_scheduled:
        pair = (item["event_fingerprint"], item["category"])
        if pair in claims:
            raise AgentFailure("TS v2 causal evidence identity is ambiguous")
        claims[pair] = {
            "event_fingerprint": pair[0],
            "event_category": pair[1],
            "evidence_state": "PARTIAL",
            **_ts_scheduled_event_claim(item),
        }
    return [claims[pair] for pair in sorted(claims)]


def _ts_macro_result_claim(result: dict[str, Any]) -> str:
    metric_text = "；".join(
        (
            f"{metric['name']}="
            f"{json.dumps(metric['value'], allow_nan=False)} "
            f"{metric['unit']}"
            f"｜period={metric['period']}"
            f"｜preliminary={'true' if metric['preliminary'] else 'false'}"
        )
        for metric in sorted(
            result["metrics"],
            key=lambda item: item["name"],
        )
    )
    return (
        f"官方已发布｜{result['release_name']}｜"
        f"{result['published_at']}｜{metric_text}"
    )


def _verify_ts_output(
    output: dict[str, Any],
    evidence: dict[str, Any],
    supplemental: dict[str, Any],
) -> None:
    context = supplemental.get("ts_report_context")
    if not isinstance(context, dict):
        raise AgentFailure("Missing TS report context v2")
    for field in (
        "report_type",
        "evidence_snapshot",
        "forecast_window",
        "evidence_assessment",
    ):
        if output.get(field) != context.get(field):
            raise AgentFailure(f"TS output did not preserve {field}")
    binding = context.get("forecast_update")
    update = output.get("forecast_update")
    if (
        not isinstance(binding, dict)
        or not isinstance(update, dict)
        or any(
            update.get(field) != binding.get(field)
            for field in ("mode", "prior_run_id", "prior_forecast_hash")
        )
    ):
        raise AgentFailure("TS output did not preserve forecast update binding")

    probabilities = {
        name: output.get("scenarios", {}).get(name, {}).get("probability_pct")
        for name in ("main", "reverse", "extreme")
    }
    if (
        any(
            type(value) is not int
            or not 0 <= value <= 100
            or value % 5 != 0
            for value in probabilities.values()
        )
        or sum(probabilities.values()) != 100
        or probabilities["main"]
        < max(probabilities["reverse"], probabilities["extreme"])
    ):
        raise AgentFailure("Invalid TS v2 scenario probabilities")
    if output["scenarios"]["main"].get("bias") != output.get("path_bias"):
        raise AgentFailure("TS v2 main scenario does not match path bias")

    outlooks = output.get("symbol_outlooks")
    if not isinstance(outlooks, dict) or set(outlooks) != {"SPY", "QQQ"}:
        raise AgentFailure("Invalid TS v2 SPY/QQQ outlooks")
    strengths = [outlooks[symbol].get("relative_strength") for symbol in ("SPY", "QQQ")]
    if strengths not in (["LEADER", "LAGGER"], ["LAGGER", "LEADER"], ["IN_LINE", "IN_LINE"]):
        raise AgentFailure("Invalid TS v2 relative strength pairing")
    directions = {outlooks[symbol].get("direction") for symbol in ("SPY", "QQQ")}
    if (
        output.get("path_bias") == "BULLISH"
        and directions == {"BEARISH"}
    ) or (
        output.get("path_bias") == "BEARISH"
        and directions == {"BULLISH"}
    ):
        raise AgentFailure("TS v2 path bias contradicts both symbol outlooks")

    assessment = output.get("evidence_assessment", {})
    core_sources = assessment.get("core_sources")
    available = assessment.get("enhanced_available")
    missing = assessment.get("enhanced_missing")
    if (
        assessment.get("core_status") != "READY"
        or not _unique_string_items(core_sources)
        or set(core_sources)
        != {"SPY_QUOTE", "QQQ_QUOTE", "MARKET_CLOCK", "A2_STRUCTURE"}
        or assessment.get("core_gaps") != []
        or not _unique_string_items(available)
        or not _unique_string_items(missing)
        or set(available) & set(missing)
        or set(available) | set(missing) != TS_ENHANCED_EVIDENCE
        or assessment.get("enhancement_gap_effect")
        != "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY"
    ):
        raise AgentFailure("Invalid TS v2 evidence classification")

    report_type = output.get("report_type")
    update = output.get("forecast_update", {})
    if report_type in {"OPEN_15M_CHECK", "OPEN_30M_CHECK"}:
        if (
            update.get("mode") != "CHECK"
            or not _is_hash(update.get("prior_forecast_hash"))
            or not isinstance(update.get("prior_run_id"), str)
            or update.get("prior_status") == "NOT_APPLICABLE"
        ):
            raise AgentFailure("TS open check is not bound to its original forecast")

    scenario_signatures = {}
    for scenario_name in ("main", "reverse", "extreme"):
        scenario = output["scenarios"][scenario_name]
        stages = scenario.get("sequence")
        if (
            not isinstance(stages, list)
            or not 2 <= len(stages) <= 3
            or [stage.get("order") for stage in stages]
            != list(range(1, len(stages) + 1))
        ):
            raise AgentFailure("Invalid TS v2 scenario sequence")
        groups = [scenario.get("activation"), scenario.get("invalidation")]
        groups.extend(
            {"logic": "ALL", "conditions": stage.get("conditions")}
            for stage in stages
        )
        for group in groups:
            _verify_ts_condition_group(group)
        scenario_signatures[scenario_name] = _verify_ts_scenario_structure(
            scenario
        )
    if len(set(scenario_signatures.values())) != len(scenario_signatures):
        raise AgentFailure("TS v2 scenarios use duplicate objective paths")
    _verify_ts_main_has_future_stage(output["scenarios"]["main"], evidence)
    for chain in output.get("causal_chains", []):
        channels = chain.get("channels")
        if not _unique_string_items(channels) or not 1 <= len(channels) <= 4:
            raise AgentFailure("Invalid TS v2 causal chain channels")
        _verify_ts_condition_group(chain.get("failure_conditions"))

    _selected_news, scheduled_events, macro_results = (
        _ts_selected_event_evidence(evidence, context)
    )
    health = evidence.get("a1", {}).get("health", {})
    has_news = health.get("verified_market_moving_news") is True
    has_released_event = has_news or bool(macro_results)
    if has_released_event != ("MARKET_MOVING_NEWS" in available):
        raise AgentFailure("TS v2 news evidence classification is inconsistent")
    has_scheduled_macro = bool(scheduled_events)
    if has_scheduled_macro != ("MACRO_SCHEDULE" in available):
        raise AgentFailure("TS v2 macro schedule classification is inconsistent")
    chains = output.get("causal_chains", [])
    if (has_released_event or has_scheduled_macro) != bool(chains):
        raise AgentFailure("TS v2 causal chain does not match frozen events")
    machine_claims = _ts_machine_causal_claims(evidence, context)
    if machine_claims:
        claims_by_pair = {
            (item["event_fingerprint"], item["event_category"]): item
            for item in machine_claims
        }
        chain_pairs = {
            (item.get("event_fingerprint"), item.get("event_category"))
            for item in chains
            if isinstance(item, dict)
        }
        if (
            len(chain_pairs) != len(chains)
            or chain_pairs != set(claims_by_pair)
        ):
            raise AgentFailure(
                "TS v2 causal chain is not bound to exact verified events"
            )
        for chain in chains:
            pair = (
                chain.get("event_fingerprint"),
                chain.get("event_category"),
            )
            claim = claims_by_pair[pair]
            if (
                chain.get("event") != claim["event"]
                or chain.get("evidence_state") != claim["evidence_state"]
            ):
                raise AgentFailure(
                    "TS v2 causal text is not bound to immutable evidence"
                )
            if "transmission" in claim and (
                chain.get("kind") != "AMPLIFIER"
                or chain.get("transmission") != claim["transmission"]
                or chain.get("index_effect") != claim["index_effect"]
            ):
                raise AgentFailure(
                    "TS v2 unreleased macro must remain a conditional amplifier"
                )

    hypotheses = output.get("hypotheses")
    if (
        not isinstance(hypotheses, list)
        or [item.get("id") for item in hypotheses] != list(range(1, 13))
    ):
        raise AgentFailure("TS v2 hypotheses must contain IDs 1 through 12")
    if {item.get("symbol") for item in output.get("key_levels", [])} != {
        "SPY",
        "QQQ",
    }:
        raise AgentFailure("TS v2 key levels must cover SPY and QQQ")
    try:
        observed_at = _aware_datetime(
            output["evidence_snapshot"]["market_time"]["observed_at"]
        )
        next_at = _aware_datetime(output["next_validation"]["at"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AgentFailure("Invalid TS v2 validation time") from exc
    if next_at <= observed_at:
        raise AgentFailure("TS v2 next validation must be in the future")
    required_next_validation = context.get("required_next_validation")
    if (
        required_next_validation is not None
        and output.get("next_validation") != required_next_validation
    ):
        raise AgentFailure(
            "TS v2 next validation did not preserve required checkpoint"
        )


def _verify_ts_condition_group(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or value.get("logic") not in {"ALL", "ANY"}
        or not isinstance(value.get("conditions"), list)
        or not value["conditions"]
    ):
        raise AgentFailure("Invalid TS v2 objective condition group")
    for condition in value["conditions"]:
        if not isinstance(condition, dict):
            raise AgentFailure("Invalid TS v2 objective condition")
        operator = condition.get("operator")
        confirmation = condition.get("confirmation")
        upper = condition.get("upper_value")
        target = condition.get("value")
        if confirmation == "LIVE_QUOTE":
            raise AgentFailure("TS v2 LIVE_QUOTE condition is not replayable")
        if (
            condition.get("symbol") not in {"SPY", "QQQ"}
            or condition.get("metric") not in {
                "LAST_PRICE",
                "VWAP",
                "SESSION_HIGH",
                "SESSION_LOW",
                "OPENING_RANGE_HIGH",
                "OPENING_RANGE_LOW",
            }
            or operator not in {
                "ABOVE",
                "BELOW",
                "AT_OR_ABOVE",
                "AT_OR_BELOW",
                "BETWEEN",
            }
            or confirmation not in {
                "ONE_5M_CLOSE",
                "ONE_15M_CLOSE",
            }
            or isinstance(target, bool)
            or not isinstance(target, (int, float))
            or not math.isfinite(target)
            or target <= 0
            or (
                operator == "BETWEEN"
                and (
                    isinstance(upper, bool)
                    or not isinstance(upper, (int, float))
                    or not math.isfinite(upper)
                    or upper <= target
                )
            )
            or (operator != "BETWEEN" and upper is not None)
        ):
            raise AgentFailure("Invalid TS v2 objective condition values")


def _verify_ts_scenario_structure(scenario: dict[str, Any]) -> tuple[Any, ...]:
    activation = _ts_group_signature(scenario["activation"])
    invalidation = _ts_group_signature(scenario["invalidation"])
    stages = [
        _ts_conditions_signature(stage["conditions"])
        for stage in scenario["sequence"]
    ]
    if activation == invalidation:
        raise AgentFailure("TS v2 scenario activates and invalidates together")
    if len(stages) != len(set(stages)):
        raise AgentFailure("TS v2 scenario stages use duplicate conditions")
    if _ts_group_implies_invalidation(
        scenario["activation"],
        scenario["invalidation"],
    ):
        raise AgentFailure("TS v2 scenario activates and invalidates together")
    if any(
        _ts_all_conditions_imply_invalidation(
            stage["conditions"],
            scenario["invalidation"],
        )
        for stage in scenario["sequence"]
    ):
        raise AgentFailure("TS v2 scenario stage is also its invalidation")

    inferred_direction = _ts_stage_direction(scenario["sequence"])
    if (
        inferred_direction is not None
        and scenario.get("bias") in {"BULLISH", "BEARISH"}
        and inferred_direction != scenario["bias"]
    ):
        raise AgentFailure("TS v2 scenario bias contradicts its ordered targets")
    return activation, tuple(stages), invalidation


def _ts_stage_direction(stages: list[dict[str, Any]]) -> str | None:
    upward = {"ABOVE", "AT_OR_ABOVE"}
    downward = {"BELOW", "AT_OR_BELOW"}
    direction = None
    stage_targets = []
    for stage in stages:
        targets = {}
        for condition in stage["conditions"]:
            operator = condition.get("operator")
            current_direction = (
                "BULLISH"
                if operator in upward
                else "BEARISH" if operator in downward else None
            )
            key = (
                condition.get("symbol"),
                condition.get("metric"),
                condition.get("confirmation"),
            )
            if (
                current_direction is None
                or key in targets
                or direction not in {None, current_direction}
            ):
                return None
            direction = current_direction
            targets[key] = condition["value"]
        stage_targets.append(targets)
    keys = set(stage_targets[0])
    if any(set(targets) != keys for targets in stage_targets[1:]):
        return None
    for key in keys:
        values = [targets[key] for targets in stage_targets]
        if direction == "BULLISH" and any(
            current <= prior for prior, current in zip(values, values[1:])
        ):
            raise AgentFailure("TS v2 ordered targets do not progress")
        if direction == "BEARISH" and any(
            current >= prior for prior, current in zip(values, values[1:])
        ):
            raise AgentFailure("TS v2 ordered targets do not progress")
    return direction


def _ts_group_signature(group: dict[str, Any]) -> tuple[Any, ...]:
    return group.get("logic"), _ts_conditions_signature(group["conditions"])


def _ts_conditions_signature(conditions: list[dict[str, Any]]) -> tuple[Any, ...]:
    return tuple(sorted(_ts_condition_signature(value) for value in conditions))


def _ts_condition_signature(value: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(
        value.get(field)
        for field in (
            "symbol",
            "metric",
            "operator",
            "value",
            "upper_value",
            "confirmation",
        )
    )


def _ts_group_implies_invalidation(
    source: dict[str, Any],
    invalidation: dict[str, Any],
) -> bool:
    conditions = source["conditions"]
    if source["logic"] == "ANY":
        return all(
            _ts_all_conditions_imply_invalidation([condition], invalidation)
            for condition in conditions
        )
    return _ts_all_conditions_imply_invalidation(conditions, invalidation)


def _ts_all_conditions_imply_invalidation(
    source: list[dict[str, Any]],
    invalidation: dict[str, Any],
) -> bool:
    conditions = invalidation["conditions"]
    if invalidation["logic"] == "ANY":
        return _ts_all_conditions_imply_any(source, conditions)
    return _ts_all_conditions_imply_all(source, conditions)


def _ts_all_conditions_imply_any(
    source: list[dict[str, Any]],
    invalidation: list[dict[str, Any]],
) -> bool:
    source_by_key = _ts_intersected_condition_intervals(source)
    if source_by_key is None:
        return True
    invalidation_by_key: dict[
        tuple[Any, ...], list[tuple[Any, bool, Any, bool]]
    ] = {}
    for condition in invalidation:
        invalidation_by_key.setdefault(_ts_condition_key(condition), []).append(
            _ts_condition_bounds(condition)
        )
    universal = (-math.inf, False, math.inf, False)
    return any(
        _ts_interval_covered_by_union(
            source_by_key.get(key, universal),
            intervals,
        )
        for key, intervals in invalidation_by_key.items()
    )


def _ts_all_conditions_imply_all(
    source: list[dict[str, Any]],
    invalidation: list[dict[str, Any]],
) -> bool:
    source_by_key = _ts_intersected_condition_intervals(source)
    if source_by_key is None:
        return True
    return all(
        (source_interval := source_by_key.get(_ts_condition_key(condition)))
        is not None
        and _ts_interval_covered_by_union(
            source_interval,
            [_ts_condition_bounds(condition)],
        )
        for condition in invalidation
    )


def _ts_intersected_condition_intervals(
    conditions: list[dict[str, Any]],
) -> dict[tuple[Any, ...], tuple[Any, bool, Any, bool]] | None:
    by_key: dict[tuple[Any, ...], tuple[Any, bool, Any, bool]] = {}
    for condition in conditions:
        key = _ts_condition_key(condition)
        interval = _ts_condition_bounds(condition)
        if key in by_key:
            intersection = _ts_interval_intersection(by_key[key], interval)
            if intersection is None:
                return None
            interval = intersection
        by_key[key] = interval
    return by_key


def _ts_condition_key(value: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(
        value.get(field) for field in ("symbol", "metric", "confirmation")
    )


def _ts_condition_bounds(
    value: dict[str, Any],
) -> tuple[Any, bool, Any, bool]:
    target = value["value"]
    operator = value["operator"]
    if operator == "ABOVE":
        return target, False, math.inf, False
    if operator == "AT_OR_ABOVE":
        return target, True, math.inf, False
    if operator == "BELOW":
        return -math.inf, False, target, False
    if operator == "AT_OR_BELOW":
        return -math.inf, False, target, True
    return target, True, value["upper_value"], True


def _ts_interval_intersection(
    left: tuple[Any, bool, Any, bool],
    right: tuple[Any, bool, Any, bool],
) -> tuple[Any, bool, Any, bool] | None:
    if left[0] > right[0]:
        lower, lower_closed = left[0], left[1]
    elif right[0] > left[0]:
        lower, lower_closed = right[0], right[1]
    else:
        lower, lower_closed = left[0], left[1] and right[1]
    if left[2] < right[2]:
        upper, upper_closed = left[2], left[3]
    elif right[2] < left[2]:
        upper, upper_closed = right[2], right[3]
    else:
        upper, upper_closed = left[2], left[3] and right[3]
    interval = (lower, lower_closed, upper, upper_closed)
    return interval if _ts_interval_nonempty(interval) else None


def _ts_interval_nonempty(value: tuple[Any, bool, Any, bool]) -> bool:
    return value[0] < value[2] or (
        value[0] == value[2] and value[1] and value[3]
    )


def _ts_interval_subtract(
    source: tuple[Any, bool, Any, bool],
    removed: tuple[Any, bool, Any, bool],
) -> list[tuple[Any, bool, Any, bool]]:
    overlap = _ts_interval_intersection(source, removed)
    if overlap is None:
        return [source]
    pieces = [
        (source[0], source[1], overlap[0], not overlap[1]),
        (overlap[2], not overlap[3], source[2], source[3]),
    ]
    return [piece for piece in pieces if _ts_interval_nonempty(piece)]


def _ts_interval_covered_by_union(
    source: tuple[Any, bool, Any, bool],
    covering: list[tuple[Any, bool, Any, bool]],
) -> bool:
    remaining = [source]
    for interval in covering:
        remaining = [
            piece
            for candidate in remaining
            for piece in _ts_interval_subtract(candidate, interval)
        ]
        if not remaining:
            return True
    return False


def _verify_ts_main_has_future_stage(
    scenario: dict[str, Any],
    evidence: dict[str, Any],
) -> None:
    a2 = evidence.get("a2")
    if not isinstance(a2, dict):
        return
    structure = a2.get("structure")
    if not isinstance(structure, dict):
        return
    statuses = [
        _ts_conditions_currently_satisfied(stage["conditions"], structure)
        for stage in scenario["sequence"]
    ]
    if statuses and all(status is True for status in statuses):
        raise AgentFailure("TS v2 main path has no unobserved future stage")


def _ts_conditions_currently_satisfied(
    conditions: list[dict[str, Any]],
    structure: dict[str, Any],
) -> bool | None:
    statuses = [
        _ts_condition_currently_satisfied(condition, structure)
        for condition in conditions
    ]
    if any(status is False for status in statuses):
        return False
    if any(status is None for status in statuses):
        return None
    return True


def _ts_condition_currently_satisfied(
    condition: dict[str, Any],
    structure: dict[str, Any],
) -> bool | None:
    metric_fields = {
        "LAST_PRICE": "price",
        "VWAP": "vwap",
        "SESSION_HIGH": "session_high",
        "SESSION_LOW": "session_low",
        "OPENING_RANGE_HIGH": "opening_range_high",
        "OPENING_RANGE_LOW": "opening_range_low",
    }
    symbol = structure.get(condition.get("symbol"))
    if not isinstance(symbol, dict):
        return None
    observed = symbol.get(metric_fields.get(condition.get("metric"), ""))
    if (
        isinstance(observed, bool)
        or not isinstance(observed, (int, float))
        or not math.isfinite(observed)
        or observed <= 0
    ):
        return None
    target = condition["value"]
    operator = condition["operator"]
    if operator in {"ABOVE", "AT_OR_ABOVE"}:
        return observed > target if operator == "ABOVE" else observed >= target
    if operator in {"BELOW", "AT_OR_BELOW"}:
        return observed < target if operator == "BELOW" else observed <= target
    return target <= observed <= condition["upper_value"]


def _unique_string_items(value: Any) -> bool:
    return (
        isinstance(value, list)
        and all(isinstance(item, str) for item in value)
        and len(value) == len(set(value))
    )


def _is_hash(value: Any) -> bool:
    return (
        isinstance(value, str)
        and re.fullmatch(r"[0-9a-f]{64}", value) is not None
    )


def _ts_correction_prompt(prompt: str, error_summary: str) -> str:
    safe_summary = " ".join(error_summary.split())[:200]
    return "\n\n".join(
        [
            prompt,
            "TS_CORRECTION_REQUIRED: The previous complete JSON object failed "
            f"local validation: {safe_summary or 'validation failed'}. "
            "Regenerate the entire schema-conforming JSON object from the same "
            "frozen evidence and supplemental context. Do not return a patch, "
            "commentary, or partial object.",
        ]
    )


def _failure_summary(stderr: str, return_code: int | None = None) -> str:
    messages = re.findall(r'"message"\s*:\s*"([^"]+)"', stderr)
    if messages:
        return messages[-1]
    meaningful = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip()
        and " WARN " not in line
        and not line.startswith("OpenAI Codex")
        and not line.startswith("--------")
    ]
    if meaningful:
        return meaningful[-1]
    if _is_windows_dll_initialization_failure(return_code):
        return "Windows进程初始化失败（0xC0000142，DLL初始化失败）"
    return "unknown Codex failure"


def _diagnostic_process_failure_summary(return_code: int | None) -> str:
    if _is_windows_dll_initialization_failure(return_code):
        return "Windows进程初始化失败（0xC0000142，DLL初始化失败）"
    if return_code is None:
        return "Codex process failed"
    return f"Codex process failed (exit code {return_code})"


def _is_windows_dll_initialization_failure(return_code: int | None) -> bool:
    return (
        return_code is not None
        and return_code & 0xFFFFFFFF == WINDOWS_DLL_INITIALIZATION_FAILURE
    )


def _find_codex() -> Path:
    explicit = os.environ.get("CODEX_CLI_PATH")
    expected_home = package_data_path(PACKAGE_ROOT / "web" / "data" / "model-codex-home")
    configured_home = os.environ.get("CODEX_HOME")
    if not configured_home or Path(configured_home).resolve() != expected_home:
        raise AgentFailure("Authorize the package's independent model account before use")
    if explicit:
        executable = Path(explicit).resolve()
        if executable.is_file() and executable.is_relative_to(PACKAGE_ROOT / "web" / "node_modules"):
            return executable
    raise AgentFailure("The package-local Codex CLI is not installed")


def _sanitized_environment() -> dict[str, str]:
    blocked = ("TOKEN", "SECRET", "API_KEY", "TRADIER", "FINNHUB", "DISCORD", "FMP")
    return {
        key: value
        for key, value in os.environ.items()
        if not any(marker in key.upper() for marker in blocked)
    }
