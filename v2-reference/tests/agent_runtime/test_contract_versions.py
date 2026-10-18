from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from trading_os_v2.agent_runtime.service import (
    AgentFailure,
    CodexAgentRuntime,
    ROLE_FILES,
    _codex_output_schema_path,
    _failure_summary,
    _verify_agent_output,
    _verify_packet,
    _verify_supplemental,
    validate_earnings_day_coverage,
    validate_earnings_day_context,
)
from trading_os_v2.common.io import sha256_json


def _schema_key_count(value: object, key: str) -> int:
    if isinstance(value, dict):
        return int(key in value) + sum(
            _schema_key_count(child, key) for child in value.values()
        )
    if isinstance(value, list):
        return sum(_schema_key_count(child, key) for child in value)
    return 0


def _valid_a2_contracts() -> dict:
    pattern_symbols = {}
    pullback_symbols = {}
    for symbol in ("SPY", "QQQ"):
        pattern_symbols[symbol] = {
            "symbol": symbol,
            "current_state": "NARROW_RANGE",
            "candidate_state": "UNKNOWN",
            "candidate_bars": 0,
            "direction": "neutral",
            "structure": "range",
            "volatility": "normal",
            "speed": "slow",
            "data_time": "2026-07-30T16:00:00+00:00",
            "state_since": "2026-07-30T15:45:00+00:00",
            "last_processed_bar_time": "2026-07-30T16:00:00+00:00",
            "last_transition": None,
        }
        pullback_symbols[symbol] = {
            "data_time": "2026-07-30T16:00:00+00:00",
            "regime": "NARROW_RANGE",
            "context_hash": "a" * 64,
            "call": {
                "eligibility": False,
                "reason": "NO_DIRECTION",
                "evidence": ["DIRECTION_NEUTRAL"],
            },
            "put": {
                "eligibility": False,
                "reason": "NO_DIRECTION",
                "evidence": ["DIRECTION_NEUTRAL"],
            },
        }
    return {
        "pattern_tracker": {
            "contract_version": "v1",
            "status": "HEALTHY",
            "updated_at": "2026-07-30T16:00:40+00:00",
            "cadence_minutes": 15,
            "confirmation_bars": 3,
            "symbols": pattern_symbols,
        },
        "trend_pullback": {
            "contract_version": "v1",
            "status": "HEALTHY",
            "policy": "TREND_ALIGNED_PULLBACK_ONLY",
            "trade_action": False,
            "symbols": pullback_symbols,
        },
    }


def _packet_with_a2() -> dict:
    payload = {
        "contract_version": "v1",
        "created_at": "2026-07-30T16:00:40+00:00",
        "a2": _valid_a2_contracts(),
    }
    return {
        "run_id": "a2-contract-test",
        "packet_hash": sha256_json(payload),
        **payload,
    }


def _valid_earnings_watch() -> dict:
    event = {
        "symbol": "AAPL",
        "date": "2026-07-30",
        "session": "AMC",
    }
    identity = {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        **event,
    }
    return {
        "contract_version": "v1",
        "component": "A1_EARNINGS_WATCH",
        "actionable": False,
        "status": "HEALTHY",
        "generated_at": "2026-07-30T15:55:00+00:00",
        "timezone": "America/Los_Angeles",
        "window_start": "2026-07-30",
        "window_end": "2026-08-05",
        "selection_rule": "TOP_20_ABSOLUTE_REVENUE_ESTIMATE",
        "events": [
            {
                "event_id": sha256_json(identity),
                **event,
                "eps_estimate": 1.89,
                "revenue_estimate": 92_000_000_000,
                "importance_rank": 1,
                "market_impact_status": "UNVERIFIED_CANDIDATE",
                "source": "Finnhub Earnings Calendar",
                "confidence": "scheduled_event",
            }
        ],
    }


def _packet_with_earnings_watch() -> dict:
    packet = _packet_with_a2()
    packet["a1"] = {
        "earnings_watch": _valid_earnings_watch(),
        "macro_results": [],
    }
    _rehash(packet)
    return packet


def _valid_macro_result(*, status: str = "VERIFIED") -> dict:
    scheduled_at = "2026-07-30T05:30:00-07:00"
    schedule_identity = {
        "contract_version": "v1",
        "component": "A1_MACRO_WATCH",
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled_at,
        "source": "BLS Official Release Calendar",
    }
    verified = status == "VERIFIED"
    result = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": status,
        "generated_at": "2026-07-30T15:55:00+00:00",
        "timezone": "America/Los_Angeles",
        "market_date": "2026-07-30",
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": sha256_json(schedule_identity),
        "category": "employment",
        "release_name": "Employment Situation",
        "scheduled_at": scheduled_at,
        "published_at": (
            "2026-07-30T05:30:00-07:00" if verified else None
        ),
        "source": "BLS" if verified else None,
        "source_url": (
            "https://www.bls.gov/news.release/empsit.nr0.htm"
            if verified
            else None
        ),
        "raw_item_hash": "c" * 64 if verified else None,
        "confidence": "official_result" if verified else None,
        "metrics": (
            [
                {
                    "name": "PAYROLL_EMPLOYMENT_CHANGE",
                    "value": 128000,
                    "unit": "JOBS",
                    "period": "2026-06",
                    "preliminary": True,
                },
                {
                    "name": "UNEMPLOYMENT_RATE",
                    "value": 4.2,
                    "unit": "PERCENT",
                    "period": "2026-06",
                    "preliminary": False,
                },
                {
                    "name": "AVERAGE_HOURLY_EARNINGS_CHANGE",
                    "value": 0.3,
                    "unit": "USD",
                    "period": "2026-06",
                    "preliminary": False,
                },
            ]
            if verified
            else []
        ),
        "result_hash": "",
    }
    _rehash_macro_result(result)
    return result


def _rehash_macro_result(result: dict) -> None:
    result["result_hash"] = sha256_json(
        {
            key: value
            for key, value in result.items()
            if key not in {"generated_at", "result_hash"}
        }
    )


def _packet_with_macro_results(*, status: str = "VERIFIED") -> dict:
    packet = _packet_with_earnings_watch()
    packet["a1"]["macro_results"] = [
        _valid_macro_result(status=status)
    ]
    _rehash(packet)
    return packet


def _earnings_day_context() -> dict:
    candidate = _valid_earnings_watch()["events"][0]
    candidates = [candidate]
    payload = {
        "contract_version": "v1",
        "component": "EARNINGS_DAY_CONTEXT",
        "actionable": False,
        "scheduled_day": "2026-07-30",
        "timezone": "America/Los_Angeles",
        "sunday_day": "2026-07-26",
        "sunday_run_id": "sunday-run",
        "sunday_packet_hash": "a" * 64,
        "sunday_information_hash": "b" * 64,
        "sunday_bulletin_delivery_key": "a1-earnings-weekly-2026-07-26",
        "day_bulletin_delivery_key": "a1-earnings-day-2026-07-30",
        "candidates": candidates,
        "candidates_hash": sha256_json(candidates),
    }
    return {**payload, "context_hash": sha256_json(payload)}


def _earnings_day_coverage() -> list[dict]:
    candidate = _earnings_day_context()["candidates"][0]
    return [
        {
            "event_id": candidate["event_id"],
            "symbol": candidate["symbol"],
            "treatment": "SCHEDULE_RISK_ONLY",
            "summary": "仅作为已安排的财报风险，等待发布后证据确认。",
        }
    ]


def _rehash(packet: dict) -> None:
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    packet["packet_hash"] = sha256_json(payload)


class AgentRuntimeContractVersionTests(unittest.TestCase):
    def test_codex_schema_compiles_nullable_one_of_without_changing_contract(
        self,
    ) -> None:
        source_path = ROLE_FILES["TS"][1]
        source_before = source_path.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch(
                "trading_os_v2.agent_runtime.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                compiled_path = _codex_output_schema_path(source_path)
                second_path = _codex_output_schema_path(source_path)
                earnings_path = _codex_output_schema_path(
                    source_path,
                    required_optional_properties={"earnings_day_coverage"},
                )

            compiled = json.loads(compiled_path.read_text(encoding="utf-8"))
            earnings = json.loads(earnings_path.read_text(encoding="utf-8"))

        self.assertEqual(compiled_path, second_path)
        self.assertNotEqual(compiled_path, source_path)
        self.assertEqual(source_path.read_bytes(), source_before)
        self.assertEqual(_schema_key_count(compiled, "oneOf"), 0)
        self.assertEqual(_schema_key_count(compiled, "anyOf"), 4)
        self.assertEqual(_schema_key_count(compiled, "uniqueItems"), 0)
        self.assertNotIn("earnings_day_coverage", compiled["properties"])
        self.assertEqual(set(compiled["properties"]), set(compiled["required"]))
        self.assertIn("earnings_day_coverage", earnings["properties"])
        self.assertIn("earnings_day_coverage", earnings["required"])
        self.assertNotEqual(compiled_path, earnings_path)

    def test_codex_schema_rejects_non_nullable_one_of(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            schema = root / "bad-schema.json"
            schema.write_text(
                json.dumps(
                    {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "string", "minLength": 1},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(AgentFailure, "unsupported oneOf"):
                _codex_output_schema_path(schema)

    def test_packet_rejects_unknown_or_missing_version(self) -> None:
        for version in ("v2", None):
            with self.subTest(contract_version=version):
                payload = {"created_at": "now", "value": 1}
                if version is not None:
                    payload["contract_version"] = version
                packet = {
                    "run_id": "test",
                    "packet_hash": sha256_json(payload),
                    **payload,
                }
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Unknown frozen evidence contract version",
                ):
                    _verify_packet(packet)

    def test_supplemental_accepts_ts_v2_and_rejects_other_versions(self) -> None:
        _verify_supplemental(
            {"ts": {"contract_version": "v2", "role": "TS"}}
        )
        values = (
            {"ts": {"contract_version": "v1", "role": "TS"}},
            {"ts": {"contract_version": "v3", "role": "TS"}},
            {"ts": {"role": "TS"}},
        )
        for value in values:
            with self.subTest(value=value):
                with self.assertRaises(AgentFailure):
                    _verify_supplemental(value)

    def test_supplemental_rejects_legacy_ts_causal_evidence_fields(self) -> None:
        for field in (
            "market_moving_news_events",
            "scheduled_macro_events",
        ):
            with self.subTest(field=field):
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Legacy unversioned TS causal evidence",
                ):
                    _verify_supplemental(
                        {"ts_report_context": {field: []}}
                    )

    def test_supplemental_accepts_exact_earnings_day_context(self) -> None:
        _verify_supplemental(
            {"earnings_day_context": _earnings_day_context()}
        )
        validate_earnings_day_context(_earnings_day_context())

    def test_supplemental_rejects_tampered_earnings_day_context(self) -> None:
        mutations = (
            lambda context: context.update({"actionable": True}),
            lambda context: context.update({"contract_version": "v2"}),
            lambda context: context.update({"scheduled_day": "2026-07-31"}),
            lambda context: context["candidates"][0].update({"symbol": "MSFT"}),
            lambda context: context.update({"candidates_hash": "0" * 64}),
            lambda context: context.update({"context_hash": "0" * 64}),
            lambda context: context.update({"unknown": "field"}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                context = _earnings_day_context()
                mutate(context)
                with self.assertRaises(AgentFailure):
                    _verify_supplemental({"earnings_day_context": context})

    def test_packet_accepts_exact_a2_public_contracts(self) -> None:
        _verify_packet(_packet_with_a2())

    def test_packet_accepts_exact_read_only_earnings_watch(self) -> None:
        _verify_packet(_packet_with_earnings_watch())

    def test_packet_accepts_verified_and_unavailable_macro_results(
        self,
    ) -> None:
        for status in ("VERIFIED", "MISSING", "DEGRADED"):
            with self.subTest(status=status):
                _verify_packet(_packet_with_macro_results(status=status))

    def test_macro_result_hash_is_stable_across_collection_time(self) -> None:
        packet = _packet_with_macro_results()
        result = packet["a1"]["macro_results"][0]
        stable_hash = result["result_hash"]
        result["generated_at"] = "2026-07-30T15:59:00+00:00"
        _rehash(packet)

        _verify_packet(packet)
        self.assertEqual(result["result_hash"], stable_hash)

    def test_packet_requires_macro_results_list_when_a1_is_present(
        self,
    ) -> None:
        packet = _packet_with_earnings_watch()
        packet["a1"].pop("macro_results")
        _rehash(packet)
        with self.assertRaisesRegex(
            AgentFailure,
            "Missing A1 macro results",
        ):
            _verify_packet(packet)

        packet = _packet_with_earnings_watch()
        packet["a1"]["macro_results"] = {}
        _rehash(packet)
        with self.assertRaisesRegex(AgentFailure, "macro results"):
            _verify_packet(packet)

    def test_packet_rejects_tampered_macro_result_identity_or_time(
        self,
    ) -> None:
        mutations = (
            lambda result: result.update({"unknown": "field"}),
            lambda result: result.update({"actionable": True}),
            lambda result: result.update(
                {"schedule_event_fingerprint": "0" * 64}
            ),
            lambda result: result.update({"category": "inflation"}),
            lambda result: result.update({"market_date": "2026-07-29"}),
            lambda result: result.update(
                {"generated_at": "2026-07-30T16:00:41+00:00"}
            ),
            lambda result: result.update(
                {"scheduled_at": "2026-07-30T12:30:00+00:00"}
            ),
            lambda result: result.update(
                {"published_at": "2026-07-30T05:29:59-07:00"}
            ),
            lambda result: result.update(
                {"published_at": "2026-07-30T09:00:00-07:00"}
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                packet = _packet_with_macro_results()
                result = packet["a1"]["macro_results"][0]
                mutate(result)
                _rehash_macro_result(result)
                _rehash(packet)
                with self.assertRaisesRegex(
                    AgentFailure,
                    "macro result",
                ):
                    _verify_packet(packet)

        packet = _packet_with_macro_results()
        packet["a1"]["macro_results"][0]["result_hash"] = "0" * 64
        _rehash(packet)
        with self.assertRaisesRegex(AgentFailure, "macro result"):
            _verify_packet(packet)

    def test_packet_rejects_invalid_macro_result_status_branch(self) -> None:
        packet = _packet_with_macro_results(status="MISSING")
        result = packet["a1"]["macro_results"][0]
        result["source"] = "BLS"
        _rehash_macro_result(result)
        _rehash(packet)
        with self.assertRaisesRegex(AgentFailure, "macro result"):
            _verify_packet(packet)

        packet = _packet_with_macro_results()
        result = packet["a1"]["macro_results"][0]
        result["metrics"] = []
        _rehash_macro_result(result)
        _rehash(packet)
        with self.assertRaisesRegex(AgentFailure, "macro result metric"):
            _verify_packet(packet)

    def test_packet_rejects_invalid_macro_result_metrics(self) -> None:
        mutations = (
            lambda metrics: metrics[0].update({"unit": "PERCENT"}),
            lambda metrics: metrics[0].update({"value": True}),
            lambda metrics: metrics[0].update({"value": float("nan")}),
            lambda metrics: metrics[0].update({"period": "2026-13"}),
            lambda metrics: metrics[0].update({"preliminary": "false"}),
            lambda metrics: metrics[0].update({"unknown": "field"}),
            lambda metrics: metrics.__setitem__(1, dict(metrics[0])),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                packet = _packet_with_macro_results()
                result = packet["a1"]["macro_results"][0]
                mutate(result["metrics"])
                _rehash_macro_result(result)
                _rehash(packet)
                with self.assertRaisesRegex(
                    AgentFailure,
                    "macro result metric",
                ):
                    _verify_packet(packet)

    def test_packet_rejects_duplicate_macro_result_identities(self) -> None:
        packet = _packet_with_macro_results()
        packet["a1"]["macro_results"].append(
            dict(packet["a1"]["macro_results"][0])
        )
        _rehash(packet)
        with self.assertRaisesRegex(AgentFailure, "macro results"):
            _verify_packet(packet)

    def test_packet_rejects_missing_or_unknown_earnings_watch_version(
        self,
    ) -> None:
        for version in ("v2", None):
            with self.subTest(contract_version=version):
                packet = _packet_with_earnings_watch()
                if version is None:
                    packet["a1"]["earnings_watch"].pop("contract_version")
                else:
                    packet["a1"]["earnings_watch"]["contract_version"] = version
                _rehash(packet)
                with self.assertRaises(AgentFailure):
                    _verify_packet(packet)

        packet = _packet_with_earnings_watch()
        packet["a1"].pop("earnings_watch")
        _rehash(packet)
        with self.assertRaisesRegex(
            AgentFailure,
            "Missing A1 earnings watch",
        ):
            _verify_packet(packet)

    def test_packet_rejects_actionable_or_future_earnings_watch(self) -> None:
        mutations = (
            lambda watch: watch.update({"actionable": True}),
            lambda watch: watch.update(
                {"generated_at": "2026-07-30T16:00:41+00:00"}
            ),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                packet = _packet_with_earnings_watch()
                mutate(packet["a1"]["earnings_watch"])
                _rehash(packet)
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Invalid A1 earnings watch",
                ):
                    _verify_packet(packet)

    def test_packet_rejects_invalid_earnings_watch_window_or_event(
        self,
    ) -> None:
        mutations = (
            lambda watch: watch.update({"window_end": "2026-08-06"}),
            lambda watch: watch["events"][0].update(
                {"event_id": "0" * 64}
            ),
            lambda watch: watch["events"][0].update(
                {"date": "2026-08-06"}
            ),
            lambda watch: watch["events"][0].update(
                {"importance_rank": True}
            ),
            lambda watch: watch["events"][0].update(
                {"eps_estimate": float("nan")}
            ),
            lambda watch: watch["events"][0].update({"unknown": "field"}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                packet = _packet_with_earnings_watch()
                mutate(packet["a1"]["earnings_watch"])
                _rehash(packet)
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Invalid A1 earnings watch",
                ):
                    _verify_packet(packet)

    def test_packet_rejects_rehashed_unknown_nested_contract_versions(self) -> None:
        mutations = (
            ("pattern_tracker",),
            ("trend_pullback",),
        )
        for path in mutations:
            with self.subTest(path=path):
                packet = _packet_with_a2()
                packet["a2"][path[0]]["contract_version"] = "v2"
                _rehash(packet)
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Unknown nested evidence contract version",
                ):
                    _verify_packet(packet)

        packet = _packet_with_a2()
        packet["a1"] = {
            "provider": {"contract_version": "v9"},
        }
        _rehash(packet)
        with self.assertRaisesRegex(
            AgentFailure,
            "Unknown nested evidence contract version",
        ):
            _verify_packet(packet)

    def test_packet_rejects_malformed_a2_public_contracts(self) -> None:
        mutations = (
            lambda packet: packet["a2"]["pattern_tracker"].update(
                {"status": "BROKEN"}
            ),
            lambda packet: packet["a2"]["pattern_tracker"]["symbols"][
                "SPY"
            ].update({"direction": "mixed"}),
            lambda packet: packet["a2"]["trend_pullback"].update(
                {"trade_action": True}
            ),
            lambda packet: packet["a2"]["trend_pullback"]["symbols"][
                "QQQ"
            ]["call"].update({"eligibility": "false"}),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                packet = _packet_with_a2()
                mutate(packet)
                _rehash(packet)
                with self.assertRaisesRegex(AgentFailure, "Invalid A2"):
                    _verify_packet(packet)

    def test_output_rejects_unknown_or_missing_version(self) -> None:
        for version in ("v1", "v3", None):
            with self.subTest(contract_version=version):
                output = {"role": "TS"}
                if version is not None:
                    output["contract_version"] = version
                with self.assertRaisesRegex(
                    AgentFailure,
                    "Unknown Agent output contract version",
                ):
                    _verify_agent_output(output, "TS")

    def test_ts_and_a3_require_exact_earnings_day_coverage(self) -> None:
        context = _earnings_day_context()
        for role in ("TS", "A3"):
            with self.subTest(role=role):
                output = {
                    "contract_version": "v2" if role == "TS" else "v1",
                    "role": role,
                    "earnings_day_coverage": _earnings_day_coverage(),
                }
                _verify_agent_output(
                    output,
                    role,
                    earnings_day_context=context,
                )
                validate_earnings_day_coverage(output, role, context)
                output["earnings_day_coverage"][0]["symbol"] = "MSFT"
                with self.assertRaisesRegex(
                    AgentFailure,
                    "coverage is invalid",
                ):
                    _verify_agent_output(
                        output,
                        role,
                        earnings_day_context=context,
                    )

    def test_public_coverage_validator_rejects_other_roles(self) -> None:
        with self.assertRaisesRegex(AgentFailure, "only valid for TS or A3"):
            validate_earnings_day_coverage(
                {
                    "contract_version": "v1",
                    "role": "COMMITTEE",
                },
                "COMMITTEE",
                _earnings_day_context(),
            )

    def test_ts_and_a3_reject_missing_or_unbound_coverage(self) -> None:
        for context, coverage in (
            (_earnings_day_context(), None),
            (None, _earnings_day_coverage()),
        ):
            with self.subTest(context=context is not None):
                output = {"contract_version": "v2", "role": "TS"}
                if coverage is not None:
                    output["earnings_day_coverage"] = coverage
                with self.assertRaises(AgentFailure):
                    _verify_agent_output(
                        output,
                        "TS",
                        earnings_day_context=context,
                    )

    def test_failure_summary_prefers_real_api_error_over_shutdown_warning(self) -> None:
        stderr = "\n".join(
            [
                'ERROR: {"error":{"message":"schema requires a type"}}',
                "2026-07-30 WARN shutdown MCP program not found",
            ]
        )
        self.assertEqual(
            _failure_summary(stderr),
            "schema requires a type",
        )

    def test_failure_summary_names_windows_dll_initialization_failure(self) -> None:
        self.assertEqual(
            _failure_summary("", 3221225794),
            "Windows进程初始化失败（0xC0000142，DLL初始化失败）",
        )

    def test_ts_retries_one_readable_locally_invalid_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instructions = root / "instructions.md"
            schema = root / "schema.json"
            workspace = root / "workspace"
            instructions.write_text("Return JSON.", encoding="utf-8")
            schema.write_text(
                json.dumps(
                    {
                        "type": "object",
                        "additionalProperties": True,
                        "required": ["contract_version", "role"],
                        "properties": {
                            "contract_version": {"type": "string"},
                            "role": {"type": "string"},
                        },
                    }
                ),
                encoding="utf-8",
            )
            workspace.mkdir()
            runtime = CodexAgentRuntime.__new__(CodexAgentRuntime)
            runtime.timeout_seconds = 15
            runtime.executable = root / "codex.exe"
            runtime.workspace = workspace
            payload = {"contract_version": "v1", "created_at": "now"}
            evidence = {
                "run_id": "ts-retry-run",
                "packet_hash": sha256_json(payload),
                **payload,
            }
            ts_report_context = {
                "report_type": "OPENING_FORECAST",
                "evidence_snapshot": {
                    "market_time": {
                        "observed_at": "2026-08-03T06:30:00-07:00",
                        "market_date": "2026-08-03",
                    }
                },
                "forecast_window": {
                    "end_at": "2026-08-03T07:30:00-07:00"
                },
            }
            output_path = root / "ts" / "ts-retry-run.json"
            role_files = {"TS": (instructions, schema, "TS")}
            validation_error = (
                "TS v2 path bias contradicts both symbol outlooks"
            )

            invocation = 0

            def execute(
                command: list[str],
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                nonlocal invocation
                invocation += 1
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(
                    json.dumps(
                        {
                            "contract_version": "v2",
                            "role": "TS",
                            "attempt": invocation,
                            "marker": "UNTRUSTED_OUTPUT_MARKER",
                        }
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    side_effect=execute,
                ) as run,
                patch(
                    "trading_os_v2.agent_runtime.service._verify_agent_output",
                    side_effect=[AgentFailure(validation_error), None],
                ),
            ):
                result = runtime.run(
                    "TS",
                    evidence,
                    {"ts_report_context": ts_report_context},
                )

            self.assertEqual(result["attempt"], 2)
            self.assertEqual(run.call_count, 2)
            first_prompt = run.call_args_list[0].kwargs["input"]
            second_prompt = run.call_args_list[1].kwargs["input"]
            self.assertNotIn("TS_CORRECTION_REQUIRED", first_prompt)
            self.assertIn("TS_MACHINE_OWNED_CAUSAL_CLAIMS", first_prompt)
            self.assertIn("TS_CORRECTION_REQUIRED", second_prompt)
            self.assertIn(validation_error, second_prompt)
            self.assertIn("Regenerate the entire", second_prompt)
            self.assertNotIn("UNTRUSTED_OUTPUT_MARKER", second_prompt)
            attempt_paths = list(
                (root / "agent_diagnostics").glob(
                    "ts-ts-retry-run-*-attempt-1.json"
                )
            )
            self.assertEqual(len(attempt_paths), 1)
            attempt_diagnostic = json.loads(
                attempt_paths[0].read_text(encoding="utf-8")
            )
            self.assertEqual(attempt_diagnostic["attempt"], 1)
            self.assertEqual(attempt_diagnostic["return_code"], 0)
            self.assertEqual(
                attempt_diagnostic["error_summary"],
                validation_error,
            )
            self.assertTrue(attempt_diagnostic["retry_planned"])

            invocation = 0
            before = set(
                (root / "agent_diagnostics").glob(
                    "ts-ts-retry-run-*-final.json"
                )
            )
            with (
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    side_effect=execute,
                ) as failed_run,
                patch(
                    "trading_os_v2.agent_runtime.service._verify_agent_output",
                    side_effect=AgentFailure(validation_error),
                ),
            ):
                with self.assertRaisesRegex(AgentFailure, validation_error):
                    runtime.run(
                        "TS",
                        evidence,
                        {"ts_report_context": ts_report_context},
                    )

            self.assertEqual(failed_run.call_count, 2)
            created = set(
                (root / "agent_diagnostics").glob(
                    "ts-ts-retry-run-*-final.json"
                )
            ) - before
            self.assertEqual(len(created), 1)
            final_diagnostic = json.loads(
                created.pop().read_text(encoding="utf-8")
            )
            self.assertEqual(final_diagnostic["attempt"], 2)
            self.assertEqual(final_diagnostic["return_code"], 0)
            self.assertEqual(
                final_diagnostic["error_summary"],
                validation_error,
            )

    def test_local_validation_retry_is_ts_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instructions = root / "instructions.md"
            schema = root / "schema.json"
            workspace = root / "workspace"
            instructions.write_text("Return JSON.", encoding="utf-8")
            schema.write_text(
                json.dumps(
                    {
                        "type": "object",
                        "additionalProperties": True,
                        "required": ["contract_version", "role"],
                        "properties": {
                            "contract_version": {"type": "string"},
                            "role": {"type": "string"},
                        },
                    }
                ),
                encoding="utf-8",
            )
            workspace.mkdir()
            runtime = CodexAgentRuntime.__new__(CodexAgentRuntime)
            runtime.timeout_seconds = 15
            runtime.executable = root / "codex.exe"
            runtime.workspace = workspace
            payload = {"contract_version": "v1", "created_at": "now"}
            evidence = {
                "run_id": "committee-no-retry",
                "packet_hash": sha256_json(payload),
                **payload,
            }
            output_path = root / "committee" / "committee-no-retry.json"
            role_files = {
                "COMMITTEE": (instructions, schema, "COMMITTEE")
            }

            def execute(
                command: list[str],
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(
                    json.dumps(
                        {"contract_version": "v1", "role": "COMMITTEE"}
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    side_effect=execute,
                ) as run,
                patch(
                    "trading_os_v2.agent_runtime.service._verify_agent_output",
                    side_effect=AgentFailure("local validation failed"),
                ),
            ):
                with self.assertRaisesRegex(
                    AgentFailure,
                    "local validation failed",
                ):
                    runtime.run("COMMITTEE", evidence)

            self.assertEqual(run.call_count, 1)
            final_paths = list(
                (root / "agent_diagnostics").glob(
                    "committee-committee-no-retry-*-final.json"
                )
            )
            self.assertEqual(len(final_paths), 1)
            final_diagnostic = json.loads(
                final_paths[0].read_text(encoding="utf-8")
            )
            self.assertEqual(final_diagnostic["attempt"], 1)

    def test_runtime_retries_dll_init_failure_with_same_safe_command(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instructions = root / "instructions.md"
            schema = root / "schema.json"
            workspace = root / "workspace"
            instructions.write_text("Return JSON.", encoding="utf-8")
            schema.write_text(
                json.dumps(
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["contract_version", "role"],
                        "properties": {
                            "contract_version": {"type": "string"},
                            "role": {"type": "string"},
                        },
                    }
                ),
                encoding="utf-8",
            )
            workspace.mkdir()

            runtime = CodexAgentRuntime.__new__(CodexAgentRuntime)
            runtime.timeout_seconds = 15
            runtime.executable = root / "codex.exe"
            runtime.workspace = workspace
            payload = {"contract_version": "v1", "created_at": "now"}
            evidence = {
                "run_id": "test-run",
                "packet_hash": sha256_json(payload),
                **payload,
            }
            output_path = root / "committee" / "test-run.json"
            sensitive_marker = "SENSITIVE_MARKET_DECISION: SPY CALL rationale"

            attempt = 0

            def complete(
                command: list[str],
                **kwargs: object,
            ) -> subprocess.CompletedProcess[str]:
                nonlocal attempt
                attempt += 1
                if attempt == 1:
                    return subprocess.CompletedProcess(
                        command,
                        3221225794,
                        "",
                        json.dumps({"message": sensitive_marker}),
                    )
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_text(
                    json.dumps(
                        {
                            "contract_version": "v1",
                            "role": "COMMITTEE",
                        }
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            environment = {
                "PATH": "safe-path",
                "CODEX_HOME": "safe-home",
                "ORDINARY_VALUE": "kept",
                "TRADIER_TOKEN": "removed",
                "FINNHUB_API_KEY": "removed",
                "DISCORD_SECRET": "removed",
            }
            role_files = {
                "COMMITTEE": (instructions, schema, "COMMITTEE")
            }
            expected_command = [
                str(runtime.executable),
                "exec",
                "--ignore-user-config",
                "-c",
                'cli_auth_credentials_store="file"',
                "-c",
                'mcp_oauth_credentials_store="file"',
                "-c",
                'web_search="disabled"',
                "--ignore-rules",
                *(item for feature in ("plugins", "apps", "shell_tool", "unified_exec", "hooks", "memories", "multi_agent", "browser_use", "computer_use", "image_generation", "view_image", "code_mode", "code_mode_only", "code_mode_host", "skill_search", "workspace_dependencies") for item in ("--disable", feature)),
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "-C",
                str(workspace),
                "--output-schema",
                str(schema),
                "-o",
                str(output_path),
                "--color",
                "never",
                "--ephemeral",
                "-",
            ]
            with (
                patch.dict(os.environ, environment, clear=True),
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    side_effect=complete,
                ) as run,
                patch(
                    "trading_os_v2.agent_runtime.service.time.sleep",
                ) as sleep,
            ):
                self.assertEqual(
                    runtime.run(
                        "COMMITTEE",
                        evidence,
                    )["role"],
                    "COMMITTEE",
                )

            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args_list[0].args[0], expected_command)
            self.assertEqual(run.call_args_list[1].args[0], expected_command)
            sleep.assert_called_once_with(1)
            attempt_paths = list(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-attempt-1.json"
                )
            )
            self.assertEqual(len(attempt_paths), 1)
            attempt_diagnostic = json.loads(
                attempt_paths[0].read_text(encoding="utf-8")
            )
            self.assertEqual(attempt_diagnostic["attempt"], 1)
            self.assertEqual(attempt_diagnostic["return_code"], 3221225794)
            self.assertTrue(attempt_diagnostic["retry_planned"])
            self.assertEqual(
                attempt_diagnostic["error_summary"],
                "Windows进程初始化失败（0xC0000142，DLL初始化失败）",
            )
            self.assertNotIn(
                sensitive_marker,
                attempt_diagnostic["error_summary"],
            )
            self.assertIn("SUPPLEMENTAL_CONTEXT", run.call_args.kwargs["input"])
            child_environment = run.call_args.kwargs["env"]
            self.assertEqual(
                child_environment,
                {
                    "PATH": "safe-path",
                    "CODEX_HOME": "safe-home",
                    "ORDINARY_VALUE": "kept",
                },
            )

            before = set(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-final.json"
                )
            )
            with (
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    return_value=subprocess.CompletedProcess(
                        expected_command,
                        1,
                        "",
                        json.dumps({"message": sensitive_marker}),
                    ),
                ),
            ):
                with self.assertRaises(AgentFailure):
                    runtime.run("COMMITTEE", evidence)

            created = set(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-final.json"
                )
            ) - before
            self.assertEqual(len(created), 1)
            failure_diagnostic = json.loads(
                created.pop().read_text(encoding="utf-8")
            )
            self.assertEqual(
                failure_diagnostic["error_summary"],
                "Codex process failed (exit code 1)",
            )
            self.assertNotIn(
                sensitive_marker,
                failure_diagnostic["error_summary"],
            )

            before = set(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-final.json"
                )
            )
            with (
                patch(
                    "trading_os_v2.agent_runtime.service.ROLE_FILES",
                    role_files,
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.agent_runtime.service.subprocess.run",
                    side_effect=[
                        subprocess.CompletedProcess(
                            expected_command,
                            3221225794,
                            "",
                            "",
                        ),
                        subprocess.TimeoutExpired(expected_command, 15),
                    ],
                ),
                patch("trading_os_v2.agent_runtime.service.time.sleep"),
            ):
                with self.assertRaisesRegex(AgentFailure, "COMMITTEE timed out"):
                    runtime.run("COMMITTEE", evidence)

            retry_attempt_paths = list(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-attempt-1.json"
                )
            )
            self.assertEqual(len(retry_attempt_paths), 2)
            final_paths = set(
                (root / "agent_diagnostics").glob(
                    "committee-test-run-*-final.json"
                )
            ) - before
            self.assertEqual(len(final_paths), 1)
            timeout_diagnostic = json.loads(
                final_paths.pop().read_text(encoding="utf-8")
            )
            self.assertEqual(timeout_diagnostic["attempt"], 2)
            self.assertIsNone(timeout_diagnostic["return_code"])

            def run_invalid_output(
                content: str,
                expected_error: str,
            ) -> dict[str, object]:
                invocation_attempt = 0

                def execute(
                    command: list[str],
                    **kwargs: object,
                ) -> subprocess.CompletedProcess[str]:
                    nonlocal invocation_attempt
                    invocation_attempt += 1
                    if invocation_attempt == 1:
                        return subprocess.CompletedProcess(
                            command,
                            3221225794,
                            "",
                            "",
                        )
                    output_path.write_text(content, encoding="utf-8")
                    return subprocess.CompletedProcess(command, 0, "", "")

                before = set(
                    (root / "agent_diagnostics").glob(
                        "committee-test-run-*-final.json"
                    )
                )
                with (
                    patch(
                        "trading_os_v2.agent_runtime.service.ROLE_FILES",
                        role_files,
                    ),
                    patch(
                        "trading_os_v2.agent_runtime.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                    patch(
                        "trading_os_v2.agent_runtime.service.subprocess.run",
                        side_effect=execute,
                    ),
                    patch("trading_os_v2.agent_runtime.service.time.sleep"),
                ):
                    with self.assertRaisesRegex(AgentFailure, expected_error):
                        runtime.run("COMMITTEE", evidence)

                created = set(
                    (root / "agent_diagnostics").glob(
                        "committee-test-run-*-final.json"
                    )
                ) - before
                self.assertEqual(len(created), 1)
                return json.loads(
                    created.pop().read_text(encoding="utf-8")
                )

            malformed_diagnostic = run_invalid_output(
                "{",
                "COMMITTEE returned invalid structured output",
            )
            self.assertEqual(malformed_diagnostic["attempt"], 2)
            wrong_role_diagnostic = run_invalid_output(
                json.dumps({"contract_version": "v1", "role": "D"}),
                "COMMITTEE returned the wrong role contract",
            )
            self.assertEqual(
                wrong_role_diagnostic["error_summary"],
                "COMMITTEE returned the wrong role contract",
            )


if __name__ == "__main__":
    unittest.main()
