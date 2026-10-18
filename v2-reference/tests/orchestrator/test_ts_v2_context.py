from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from hashlib import sha256
import unittest
from unittest.mock import Mock, patch

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
)
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.discord_gateway.service import (
    DiscordFailure,
)
from trading_os_v2.orchestrator.service import (
    TradingOrchestrator,
    _a2_discord_format_version,
    _agent_cycle_discord_format_versions,
    _heartbeat_key_for_slot,
    _is_formal_calibration_delivery,
    _load_ts_intraday_ownership,
    _official_ts_output,
    _prior_delivered_ts_forecast,
    _record_ts_intraday_ownership,
    _scheduled_report_reason,
    _scheduled_ts_intraday_slot,
    _ts_forecast_window,
    _ts_intraday_owner,
    _ts_discord_format_version,
    _ts_enhanced_evidence,
    _ts_formal_provenance_context,
    _ts_material_revision_provenance_context,
    _ts_report_context,
    _ts_required_next_validation,
    _ts_scheduled_macro_events,
    _validate_existing_delivery_intent,
    _validate_ts_intraday_delivery_ledger,
    _with_delivery_marker,
)


RUN_ID = "20260803T133000Z-aaaaaaaaaa"


def packet() -> dict:
    return {
        "run_id": RUN_ID,
        "packet_hash": "b" * 64,
        "a1": {
            "health": {
                "verified_market_moving_news": True,
                "market_moving_news_evidence": [
                    {
                        "event_fingerprint": "1" * 64,
                        "category": "energy",
                        "headline": "Oil falls after supply increases",
                        "source": "Reuters",
                        "published_at": "2026-08-03T12:00:00+00:00",
                    },
                    {
                        "event_fingerprint": "2" * 64,
                        "category": "geopolitical_deescalation",
                        "headline": "Ceasefire agreement reduces risk",
                        "source": "Bloomberg",
                        "published_at": "2026-08-03T12:05:00+00:00",
                    },
                ],
            }
        },
        "a2": {},
    }


def macro_event(
    fingerprint: str,
    category: str,
    scheduled_at: str,
    *,
    release_name: str,
) -> dict:
    return {
        "event_fingerprint": fingerprint,
        "category": category,
        "release_name": release_name,
        "scheduled_at": scheduled_at,
        "market_impact_status": "SCHEDULED_UNRELEASED",
        "result_status": "UNKNOWN",
        "source": "BLS Official Release Calendar",
        "source_url": "https://www.bls.gov/schedule/news_release/bls.ics",
        "confidence": "official_schedule",
    }


def macro_result(*, market_date: str = "2026-08-03") -> dict:
    body = {
        "contract_version": "v1",
        "component": "A1_MACRO_RESULT",
        "actionable": False,
        "status": "VERIFIED",
        "generated_at": f"{market_date}T06:00:00-07:00",
        "timezone": "America/Los_Angeles",
        "market_date": market_date,
        "selection_rule": (
            "BLS_OFFICIAL_MARKET_MOVING_RESULTS_CURRENT_MARKET_DATE"
        ),
        "schedule_event_fingerprint": "3" * 64,
        "category": "employment",
        "release_name": "Job Openings and Labor Turnover Survey",
        "scheduled_at": f"{market_date}T05:30:00-07:00",
        "published_at": f"{market_date}T05:32:00-07:00",
        "source": "BLS",
        "source_url": "https://www.bls.gov/news.release/jolts.nr0.htm",
        "raw_item_hash": "4" * 64,
        "confidence": "official_result",
        "metrics": [
            {
                "name": "JOB_OPENINGS",
                "value": 7100000,
                "unit": "JOBS",
                "period": "2026-07",
                "preliminary": False,
            }
        ],
    }
    stable = {key: value for key, value in body.items() if key != "generated_at"}
    return {**body, "result_hash": sha256_json(stable)}


def freshness(*, observed_at: str = "2026-08-03T13:30:00+00:00") -> dict:
    return {
        "freshness_hash": "c" * 64,
        "market_clock": {
            "state": "open",
            "observed_at": observed_at,
        },
        "symbols": {
            "SPY": {"expiration_count": 1},
            "QQQ": {"expiration_count": 1},
        },
    }


class TSV2ContextTests(unittest.TestCase):
    def test_ts_discord_format_version_is_explicit_and_fail_closed(self) -> None:
        self.assertEqual(
            _ts_discord_format_version({}),
            TS_DISCORD_LEGACY_FORMAT_VERSION,
        )
        self.assertEqual(
            _ts_discord_format_version(
                {"ts_discord_format_version": TS_DISCORD_FORMAT_VERSION}
            ),
            TS_DISCORD_FORMAT_VERSION,
        )
        self.assertEqual(
            _ts_discord_format_version(
                {
                    "ts_discord_format_version": (
                        TS_DISCORD_PREVIOUS_FORMAT_VERSION
                    )
                }
            ),
            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
        )
        retained = next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS))
        self.assertEqual(
            _ts_discord_format_version(
                {"ts_discord_format_version": retained}
            ),
            retained,
        )
        with self.assertRaisesRegex(RuntimeError, "unknown Discord format"):
            _ts_discord_format_version(
                {"ts_discord_format_version": "unknown-v9"}
            )

    def test_agent_cycle_discord_versions_preserve_history_and_pair_current(
        self,
    ) -> None:
        self.assertEqual(
            _a2_discord_format_version({}),
            A2_DISCORD_LEGACY_FORMAT_VERSION,
        )
        self.assertEqual(
            _agent_cycle_discord_format_versions(
                {
                    "a2_discord_format_version": A2_DISCORD_FORMAT_VERSION,
                    "ts_discord_format_version": (
                        TS_DISCORD_PREVIOUS_FORMAT_VERSION
                    )
                }
            ),
            (
                A2_DISCORD_FORMAT_VERSION,
                TS_DISCORD_PREVIOUS_FORMAT_VERSION,
            ),
        )
        retained = next(iter(TS_DISCORD_RETAINED_FORMAT_VERSIONS))
        self.assertEqual(
            _agent_cycle_discord_format_versions(
                {"ts_discord_format_version": retained}
            ),
            (A2_DISCORD_LEGACY_FORMAT_VERSION, retained),
        )
        current = {
            "a2_discord_format_version": A2_DISCORD_FORMAT_VERSION,
            "ts_discord_format_version": TS_DISCORD_FORMAT_VERSION,
        }
        self.assertEqual(
            _agent_cycle_discord_format_versions(current),
            (A2_DISCORD_FORMAT_VERSION, TS_DISCORD_FORMAT_VERSION),
        )
        with self.assertRaisesRegex(RuntimeError, "missing its A2"):
            _agent_cycle_discord_format_versions(
                {"ts_discord_format_version": TS_DISCORD_FORMAT_VERSION}
            )
        with self.assertRaisesRegex(RuntimeError, "missing its A2"):
            _agent_cycle_discord_format_versions(
                {
                    "ts_discord_format_version": (
                        TS_DISCORD_PREVIOUS_FORMAT_VERSION
                    )
                }
            )
        with self.assertRaisesRegex(RuntimeError, "unknown Discord format"):
            _a2_discord_format_version(
                {"a2_discord_format_version": "unknown-v9"}
            )

    def test_intraday_schedule_uses_delayed_half_hour_slots(self) -> None:
        for actual, expected in (
            ("2026-08-03T06:31:15-07:00", "06:30"),
            ("2026-08-03T06:46:15-07:00", "06:45"),
            ("2026-08-03T07:01:15-07:00", "07:00"),
        ):
            self.assertEqual(
                _scheduled_ts_intraday_slot(
                    datetime.fromisoformat(actual)
                ).strftime("%H:%M"),
                expected,
            )
        self.assertEqual(
            _scheduled_ts_intraday_slot(
                datetime.fromisoformat("2026-08-03T07:31:15-07:00")
            ).strftime("%H:%M"),
            "07:30",
        )
        self.assertEqual(
            _scheduled_ts_intraday_slot(
                datetime.fromisoformat("2026-08-03T12:31:15-07:00")
            ).strftime("%H:%M"),
            "12:30",
        )
        self.assertIsNone(
            _scheduled_ts_intraday_slot(
                datetime.fromisoformat("2026-08-03T07:30:15-07:00")
            )
        )
        self.assertIsNone(
            _scheduled_ts_intraday_slot(
                datetime.fromisoformat("2026-08-03T13:01:15-07:00")
            )
        )
        self.assertEqual(
            _heartbeat_key_for_slot(
                datetime.fromisoformat("2026-08-03T09:30:00-07:00")
            ),
            "heartbeat-2026-08-03-mid",
        )
        self.assertEqual(
            _heartbeat_key_for_slot(
                datetime.fromisoformat("2026-08-03T08:00:00-07:00")
            ),
            "heartbeat-2026-08-03-0800",
        )

    def test_intraday_owner_follows_actual_full_cycle(self) -> None:
        self.assertEqual(_ts_intraday_owner(True), "FULL_CYCLE")
        self.assertEqual(_ts_intraday_owner(False), "TS_INTRADAY")

    @patch("trading_os_v2.orchestrator.service.ProcessLock")
    def test_official_output_waits_for_delivery_before_archive_and_reuses_copy(
        self,
        _process_lock,
    ) -> None:
        value = packet()
        proof = freshness()
        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "run_id": value["run_id"],
                "packet_hash": value["packet_hash"],
                "analysis_freshness_hash": proof["freshness_hash"],
                "release_commit": "d" * 40,
                "market_time": {
                    "timezone": "America/Los_Angeles",
                    "observed_at": "2026-08-03T06:30:00-07:00",
                    "market_date": "2026-08-03",
                    "state": "OPEN",
                },
            },
            "forecast_update": {
                "mode": "NEW",
                "prior_run_id": None,
                "prior_forecast_hash": None,
                "prior_status": "NOT_APPLICABLE",
                "change_summary": "Initial forecast",
            },
        }
        context = {
            "reason": "盘中30至60分钟预测",
            "ts_report_context": {
                "forecast_update": {
                    "mode": "NEW",
                    "prior_run_id": None,
                    "prior_forecast_hash": None,
                }
            },
        }
        runtime = Mock()
        runtime.run.return_value = output
        with (
            patch(
                "trading_os_v2.orchestrator.service.forecast_output_for_run",
                return_value=None,
            ),
            patch(
                "trading_os_v2.orchestrator.service.publish_forecast"
            ) as publish,
        ):
            self.assertIs(
                _official_ts_output(
                    runtime,
                    value,
                    context,
                    proof,
                    "盘中30至60分钟预测",
                ),
                output,
            )
        runtime.run.assert_called_once()
        publish.assert_not_called()

        runtime.reset_mock()
        with (
            patch(
                "trading_os_v2.orchestrator.service.forecast_output_for_run",
                return_value=output,
            ),
            patch(
                "trading_os_v2.orchestrator.service.publish_forecast"
            ) as publish,
        ):
            self.assertIs(
                _official_ts_output(
                    runtime,
                    value,
                    context,
                    proof,
                    "盘中30至60分钟预测",
                ),
                output,
            )
        runtime.run.assert_not_called()
        publish.assert_not_called()

        checked = deepcopy(output)
        checked["forecast_update"] = {
            "mode": "CHECK",
            "prior_run_id": "20260803T133000Z-eeeeeeeeee",
            "prior_forecast_hash": "f" * 64,
            "prior_status": "NOT_APPLICABLE",
            "change_summary": "Did not evaluate prior forecast",
        }
        check_context = deepcopy(context)
        check_context["ts_report_context"]["forecast_update"] = {
            key: checked["forecast_update"][key]
            for key in ("mode", "prior_run_id", "prior_forecast_hash")
        }
        with (
            patch(
                "trading_os_v2.orchestrator.service.forecast_output_for_run",
                return_value=checked,
            ),
            self.assertRaisesRegex(RuntimeError, "was not evaluated"),
        ):
            _official_ts_output(
                runtime,
                value,
                check_context,
                proof,
                "盘中30至60分钟预测",
            )

    @patch("trading_os_v2.orchestrator.service.runtime_path")
    def test_intraday_ownership_is_immutable_and_heartbeat_bound(
        self,
        runtime,
    ) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        slot = datetime.fromisoformat("2026-08-03T08:00:00-07:00")
        value = packet()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            runtime.side_effect = lambda *parts: root.joinpath(*parts)
            recorded = _record_ts_intraday_ownership(
                slot,
                value,
                owner="FULL_CYCLE",
            )
            self.assertEqual(recorded["owner"], "FULL_CYCLE")
            self.assertEqual(
                _load_ts_intraday_ownership(
                    slot,
                    datetime.fromisoformat("2026-08-03T08:01:15-07:00"),
                    value,
                ),
                recorded,
            )
            with self.assertRaisesRegex(RuntimeError, "cannot be changed"):
                _record_ts_intraday_ownership(
                    slot,
                    value,
                    owner="TS_INTRADAY",
                )

    @patch("trading_os_v2.orchestrator.service.runtime_path")
    def test_formal_intraday_provenance_uses_delivery_and_ownership(
        self,
        runtime,
    ) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        value = packet()
        slot = datetime.fromisoformat("2026-08-03T08:00:00-07:00")
        output = {
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "release_commit": "d" * 40,
                "market_time": {
                    "observed_at": "2026-08-03T08:01:29-07:00",
                },
            },
        }
        ledger = {
            "kind": "TS_INTRADAY",
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "completed_at": "2026-08-03T08:01:00-07:00",
            "messages": [
                {
                    "channel": "ts",
                    "message_id": "123",
                    "content": "frozen TS message",
                }
            ],
        }
        with TemporaryDirectory() as directory:
            root = Path(directory)
            runtime.side_effect = lambda *parts: root.joinpath(*parts)
            ownership = _record_ts_intraday_ownership(
                slot,
                value,
                owner="TS_INTRADAY",
            )
            context = _ts_formal_provenance_context(ledger, output)

        self.assertEqual(set(context), {
            "cohort_id",
            "forecast_role",
            "official_slot",
            "delivery_proof",
            "ownership_proof",
            "parent_forecast_hash",
            "eligibility",
            "exclusion_reason",
        })
        self.assertEqual(context["cohort_id"], "ts-v2-" + "d" * 40)
        self.assertEqual(context["official_slot"], ownership["slot"])
        self.assertEqual(
            context["ownership_proof"],
            {
                "owner": "TS_INTRADAY",
                "slot": ownership["slot"],
                "ownership_hash": ownership["ownership_hash"],
            },
        )
        self.assertEqual(
            context["delivery_proof"],
            {
                "delivery_kind": "TS_INTRADAY",
                "delivery_key": ledger["delivery_key"],
                "completed_at": ledger["completed_at"],
                "discord_message_id": "123",
                "discord_content_hash": sha256(
                    b"frozen TS message"
                ).hexdigest(),
            },
        )
        self.assertEqual(context["forecast_role"], "FORMAL_SLOT")
        self.assertEqual(context["eligibility"], "OFFICIAL_CALIBRATION")
        self.assertIsNone(context["parent_forecast_hash"])
        self.assertIsNone(context["exclusion_reason"])

    def test_formal_next_session_provenance_has_no_ownership(self) -> None:
        output = {
            "report_type": "NEXT_SESSION",
            "evidence_snapshot": {
                "release_commit": "e" * 40,
                "market_time": {
                    "observed_at": "2026-08-03T18:00:37-07:00",
                },
            },
        }
        ledger = {
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-2026-08-03-next-day",
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "completed_at": "2026-08-03T18:01:00-07:00",
            "messages": [
                {
                    "channel": "ts",
                    "message_id": "456",
                    "content": "next-session TS message",
                },
                {
                    "channel": "owner",
                    "message_id": "789",
                    "content": "owner message",
                },
            ],
        }

        context = _ts_formal_provenance_context(ledger, output)

        self.assertEqual(
            context["official_slot"],
            "2026-08-03T18:00:00-07:00",
        )
        self.assertIsNone(context["ownership_proof"])
        self.assertEqual(
            context["delivery_proof"]["delivery_kind"],
            "AGENT_CYCLE",
        )
        self.assertEqual(
            context["delivery_proof"]["discord_message_id"],
            "456",
        )

    def test_formal_agent_cycle_publishes_with_provenance_before_commit(
        self,
    ) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "NEXT_SESSION",
        }
        result = {
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "reason": "next session",
            "completed_at": "2026-08-03T18:01:00-07:00",
            "processed_position_event_ids": [],
            "processed_transition_ids": [],
            "ts": output,
            "a3": {},
        }
        receipt = {"receipt_hash": "f" * 64}
        ledger = {
            "status": "DELIVERED",
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-2026-08-03-next-day",
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "completed_at": "2026-08-03T18:01:00-07:00",
            "messages": [
                {
                    "channel": "ts",
                    "message_id": "456",
                    "content": "next-session TS message",
                }
            ],
        }
        provenance_context = {"cohort_id": "ts-v2-" + "d" * 40}
        anchor = {"forecast_run_id": RUN_ID, "forecast_hash": "a" * 64}
        order: list[str] = []
        orchestrator = object.__new__(TradingOrchestrator)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch("trading_os_v2.orchestrator.service.ProcessLock"),
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value={},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._cycle_completion_records",
                    return_value=(result, receipt),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._write_once_json"
                ),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
                patch(
                    "trading_os_v2.orchestrator.service._is_formal_calibration_delivery",
                    return_value=True,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run",
                    return_value=None,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._ts_formal_provenance_context",
                    side_effect=lambda *_: (
                        order.append("proof") or provenance_context
                    ),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.publish_forecast",
                    side_effect=lambda *_args, **_kwargs: (
                        order.append("publish") or anchor
                    ),
                ) as publish,
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_forecast_anchor_binding"
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
                patch("trading_os_v2.orchestrator.service.atomic_write_json"),
            ):
                completed = orchestrator._complete_cycle_delivery(ledger)

        self.assertIs(completed, result)
        self.assertEqual(order, ["proof", "publish"])
        self.assertEqual(
            publish.call_args.kwargs["provenance_context"],
            provenance_context,
        )
        checkpoint.assert_called_once()

    def test_material_agent_cycle_archives_revision_before_commit(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        parent_hash = "e" * 64
        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "release_commit": "d" * 40,
            },
            "forecast_update": {
                "mode": "CHECK",
                "prior_run_id": "20260803T133000Z-eeeeeeeeee",
                "prior_forecast_hash": parent_hash,
            },
        }
        result = {
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "reason": "material revision",
            "completed_at": "2026-08-03T08:01:00-07:00",
            "processed_position_event_ids": [],
            "processed_transition_ids": [],
            "ts": output,
            "a3": {},
        }
        receipt = {"receipt_hash": "f" * 64}
        ledger = {
            "status": "DELIVERED",
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-material-revision",
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "completed_at": result["completed_at"],
            "messages": [
                {
                    "channel": "ts",
                    "message_id": "456",
                    "content": "material TS revision",
                }
            ],
            "material_event": {"event_id": "c" * 64},
        }
        order: list[str] = []
        orchestrator = object.__new__(TradingOrchestrator)
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def write_delivery(*_args, **_kwargs) -> None:
                order.append("commit")

            with (
                patch("trading_os_v2.orchestrator.service.ProcessLock"),
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value={},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._cycle_completion_records",
                    return_value=(result, receipt),
                ),
                patch("trading_os_v2.orchestrator.service._write_once_json"),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
                patch(
                    "trading_os_v2.orchestrator.service._is_formal_calibration_delivery",
                    return_value=False,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.archive_classified_forecast",
                    side_effect=lambda *_args, **_kwargs: (
                        order.append("archive") or {}
                    ),
                ) as archive,
                patch(
                    "trading_os_v2.orchestrator.service.publish_forecast"
                ) as publish,
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run"
                ) as anchor,
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
                patch(
                    "trading_os_v2.orchestrator.service.atomic_write_json",
                    side_effect=write_delivery,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._advance_material_baseline",
                    side_effect=lambda *_: order.append("baseline"),
                ),
            ):
                completed = orchestrator._complete_cycle_delivery(ledger)

        self.assertIs(completed, result)
        self.assertEqual(order, ["archive", "commit", "baseline"])
        context = archive.call_args.kwargs["provenance_context"]
        self.assertEqual(context["forecast_role"], "MATERIAL_REVISION")
        self.assertEqual(context["eligibility"], "EXCLUDED")
        self.assertEqual(context["parent_forecast_hash"], parent_hash)
        self.assertEqual(
            archive.call_args.kwargs["published_at"].isoformat(),
            result["completed_at"],
        )
        publish.assert_not_called()
        anchor.assert_not_called()
        checkpoint.assert_not_called()

    def test_material_archive_failure_leaves_delivery_uncommitted(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {"release_commit": "d" * 40},
            "forecast_update": {
                "mode": "CHECK",
                "prior_run_id": "20260803T133000Z-eeeeeeeeee",
                "prior_forecast_hash": "e" * 64,
            },
        }
        result = {
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "reason": "material revision",
            "completed_at": "2026-08-03T08:01:00-07:00",
            "processed_position_event_ids": [],
            "processed_transition_ids": [],
            "ts": output,
            "a3": {},
        }
        receipt = {"receipt_hash": "f" * 64}
        ledger = {
            "status": "DELIVERED",
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-material-failure",
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "completed_at": result["completed_at"],
            "messages": [
                {"channel": "ts", "message_id": "456", "content": "TS"}
            ],
            "material_event": {"event_id": "c" * 64},
        }
        orchestrator = object.__new__(TradingOrchestrator)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with (
                patch("trading_os_v2.orchestrator.service.ProcessLock"),
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value={},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._cycle_completion_records",
                    return_value=(result, receipt),
                ),
                patch("trading_os_v2.orchestrator.service._write_once_json"),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
                patch(
                    "trading_os_v2.orchestrator.service._is_formal_calibration_delivery",
                    return_value=False,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.archive_classified_forecast",
                    side_effect=RuntimeError("parent is not archived"),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.atomic_write_json"
                ) as write,
                patch(
                    "trading_os_v2.orchestrator.service._advance_material_baseline"
                ) as baseline,
                self.assertRaisesRegex(RuntimeError, "parent is not archived"),
            ):
                orchestrator._complete_cycle_delivery(ledger)

        self.assertNotIn("artifacts_committed_at", ledger)
        write.assert_not_called()
        baseline.assert_not_called()

    def test_parentless_material_new_commits_without_revision_archive(
        self,
    ) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {"release_commit": "d" * 40},
            "forecast_update": {
                "mode": "NEW",
                "prior_run_id": None,
                "prior_forecast_hash": None,
            },
        }
        result = {
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "reason": "material revision",
            "completed_at": "2026-08-03T08:01:00-07:00",
            "processed_position_event_ids": [],
            "processed_transition_ids": [],
            "ts": output,
            "a3": {},
        }
        receipt = {"receipt_hash": "f" * 64}
        ledger = {
            "status": "DELIVERED",
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-material-new",
            "run_id": RUN_ID,
            "packet_hash": "b" * 64,
            "completed_at": result["completed_at"],
            "messages": [
                {"channel": "ts", "message_id": "456", "content": "TS"}
            ],
            "material_event": {"event_id": "c" * 64},
        }
        order: list[str] = []
        orchestrator = object.__new__(TradingOrchestrator)
        with TemporaryDirectory() as folder:
            root = Path(folder)

            def write_delivery(*_args, **_kwargs) -> None:
                order.append("commit")

            with (
                patch("trading_os_v2.orchestrator.service.ProcessLock"),
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value={},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._cycle_completion_records",
                    return_value=(result, receipt),
                ),
                patch("trading_os_v2.orchestrator.service._write_once_json"),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_pattern_transition_receipts"
                ),
                patch(
                    "trading_os_v2.orchestrator.service._is_formal_calibration_delivery",
                    return_value=False,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.archive_classified_forecast"
                ) as archive,
                patch(
                    "trading_os_v2.orchestrator.service.publish_forecast"
                ) as publish,
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run"
                ) as anchor,
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
                patch(
                    "trading_os_v2.orchestrator.service.atomic_write_json",
                    side_effect=write_delivery,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._advance_material_baseline",
                    side_effect=lambda *_: order.append("baseline"),
                ),
            ):
                completed = orchestrator._complete_cycle_delivery(ledger)

        self.assertIs(completed, result)
        self.assertEqual(order, ["commit", "baseline"])
        self.assertIn("artifacts_committed_at", ledger)
        archive.assert_not_called()
        publish.assert_not_called()
        anchor.assert_not_called()
        checkpoint.assert_not_called()

    def test_material_provenance_rejects_invalid_ts_delivery_proof(self) -> None:
        output = {
            "evidence_snapshot": {"release_commit": "d" * 40},
            "forecast_update": {
                "mode": "CHECK",
                "prior_run_id": "20260803T133000Z-eeeeeeeeee",
                "prior_forecast_hash": "e" * 64,
            },
        }
        ledger = {
            "kind": "AGENT_CYCLE",
            "delivery_key": "cycle-material-proof",
            "completed_at": "2026-08-03T08:01:00-07:00",
            "messages": [
                {"channel": "ts", "message_id": "not-numeric", "content": "TS"}
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "Discord proof"):
            _ts_material_revision_provenance_context(ledger, output)

    @patch(
        "trading_os_v2.orchestrator.service._load_ts_intraday_ownership",
        return_value={"owner": "FULL_CYCLE"},
    )
    @patch(
        "trading_os_v2.orchestrator.service._load_scheduled_heartbeat_packet",
        return_value=packet(),
    )
    @patch("trading_os_v2.orchestrator.service.ProcessLock")
    def test_full_cycle_ownership_skips_independent_ts_before_lock(
        self,
        process_lock,
        _heartbeat,
        _ownership,
    ) -> None:
        orchestrator = object.__new__(TradingOrchestrator)
        result = orchestrator.ts_intraday(
            started_at=datetime.fromisoformat("2026-08-03T08:01:15-07:00")
        )
        self.assertEqual(result["status"], "SKIPPED_OWNED")
        self.assertEqual(result["owner"], "FULL_CYCLE")
        process_lock.assert_not_called()

    @patch("trading_os_v2.orchestrator.service._load_cycle_evidence")
    @patch("trading_os_v2.orchestrator.service.read_json")
    @patch("trading_os_v2.orchestrator.service.ProcessLock")
    @patch(
        "trading_os_v2.orchestrator.service._load_ts_intraday_ownership",
        return_value={"owner": "TS_INTRADAY"},
    )
    @patch(
        "trading_os_v2.orchestrator.service._load_scheduled_heartbeat_packet",
        return_value=packet(),
    )
    def test_intraday_rejects_same_slot_ledger_from_different_heartbeat(
        self,
        _heartbeat,
        _ownership,
        _lock,
        read,
        load_evidence,
    ) -> None:
        read.return_value = {
            "run_id": "20260803T150000Z-eeeeeeeeee",
            "packet_hash": "e" * 64,
        }
        orchestrator = object.__new__(TradingOrchestrator)

        with self.assertRaisesRegex(
            RuntimeError,
            "does not match current heartbeat ownership",
        ):
            orchestrator.ts_intraday(
                started_at=datetime.fromisoformat("2026-08-03T08:01:15-07:00")
            )

        load_evidence.assert_not_called()

    def test_intraday_format_failure_reports_fault_without_delivery(self) -> None:
        value = packet()
        proof = freshness()
        output = {"contract_version": "v2", "role": "TS"}
        orchestrator = object.__new__(TradingOrchestrator)
        orchestrator._fault_only = Mock(  # type: ignore[method-assign]
            return_value={"fault_reported": True}
        )

        with (
            patch(
                "trading_os_v2.orchestrator.service._load_scheduled_heartbeat_packet",
                return_value=value,
            ),
            patch(
                "trading_os_v2.orchestrator.service._load_ts_intraday_ownership",
                return_value={"owner": "TS_INTRADAY"},
            ),
            patch("trading_os_v2.orchestrator.service.ProcessLock"),
            patch(
                "trading_os_v2.orchestrator.service.read_json",
                return_value=None,
            ),
            patch(
                "trading_os_v2.orchestrator.service._persist_agent_input_freshness",
                return_value=proof,
            ),
            patch("trading_os_v2.orchestrator.service.CodexAgentRuntime"),
            patch(
                "trading_os_v2.orchestrator.service._ts_report_context",
                return_value={},
            ),
            patch(
                "trading_os_v2.orchestrator.service._official_ts_output",
                return_value=output,
            ),
            patch(
                "trading_os_v2.orchestrator.service.format_agent",
                side_effect=ValueError(
                    "TS Discord 精简消息仍超过 1700 字符"
                ),
            ),
            patch(
                "trading_os_v2.orchestrator.service._deliver_messages"
            ) as deliver,
            patch.object(
                orchestrator,
                "_complete_ts_intraday_delivery",
            ) as complete,
        ):
            result = orchestrator.ts_intraday(
                started_at=datetime.fromisoformat(
                    "2026-08-03T08:01:15-07:00"
                )
            )

        self.assertEqual(result["status"], "FAULT")
        self.assertEqual(result["slot"], "08:00")
        self.assertIn("1700", result["reason"])
        orchestrator._fault_only.assert_called_once()  # type: ignore[attr-defined]
        deliver.assert_not_called()
        complete.assert_not_called()

    def test_reconcile_commits_delivered_ts_artifacts_exactly_once(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        value = packet()
        output = {"contract_version": "v2", "role": "TS"}
        anchor = {
            "forecast_run_id": value["run_id"],
            "forecast_hash": "f" * 64,
        }
        provenance_context = {
            "cohort_id": "ts-v2-" + "d" * 40,
            "forecast_role": "FORMAL_SLOT",
            "official_slot": "2026-08-03T08:00:00-07:00",
            "delivery_proof": {},
            "ownership_proof": {},
            "parent_forecast_hash": None,
            "eligibility": "OFFICIAL_CALIBRATION",
            "exclusion_reason": None,
        }
        ledger = {
            "contract_version": "v1",
            "created_at": "2026-08-03T08:00:00-07:00",
            "status": "DELIVERED",
            "kind": "TS_INTRADAY",
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "messages": [
                {
                    "channel": "ts",
                    "content": "TS delivery",
                    "message_id": "123",
                    "status": "SENT",
                    "delivered_at": "2026-08-03T08:01:00-07:00",
                }
            ],
            "completed_at": "2026-08-03T08:01:00-07:00",
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "delivery" / f"{ledger['delivery_key']}.json"
            atomic_write_json(path, ledger)
            orchestrator = object.__new__(TradingOrchestrator)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._load_position_event_receipts",
                    return_value={"events": {}},
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_intraday_delivery_ledger",
                    return_value=(value, output),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run",
                    side_effect=[None, anchor],
                ),
                patch(
                    "trading_os_v2.orchestrator.service.publish_forecast",
                    return_value=anchor,
                ) as publish,
                patch(
                    "trading_os_v2.orchestrator.service._ts_formal_provenance_context",
                    return_value=provenance_context,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_forecast_anchor_binding"
                ),
            ):
                first = orchestrator._reconcile_completed_position_deliveries()
                second = orchestrator._reconcile_completed_position_deliveries()

            self.assertEqual(first["failures"], [])
            self.assertEqual(second["failures"], [])
            stored = read_json(path)
            self.assertIn("artifacts_committed_at", stored)
            publish.assert_called_once()
            self.assertEqual(
                publish.call_args.kwargs["provenance_context"],
                provenance_context,
            )
            checkpoint.assert_called_once()

    def test_committed_ts_delivery_rejects_foreign_forecast_anchor(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        value = packet()
        output = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "run_id": value["run_id"],
                "market_time": {"market_date": "2026-08-03"},
            },
        }
        anchor_body = {
            "contract_version": "v2",
            "component": "TS_FORECAST_ANCHOR",
            "forecast_run_id": value["run_id"],
            "forecast_hash": "f" * 64,
            "report_type": output["report_type"],
            "market_date": "2026-08-03",
            "issued_at": "2026-08-03T08:01:00-07:00",
        }
        foreign_anchor = {
            **anchor_body,
            "anchor_hash": sha256_json(anchor_body),
        }
        ledger = {
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "completed_at": "2026-08-03T08:01:00-07:00",
            "artifacts_committed_at": "2026-08-03T08:01:01-07:00",
            "messages": [{"message_id": "123", "content": "TS delivery"}],
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "delivery" / f"{ledger['delivery_key']}.json"
            atomic_write_json(path, ledger)
            orchestrator = object.__new__(TradingOrchestrator)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_intraday_delivery_ledger",
                    return_value=(value, output),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run",
                    return_value=foreign_anchor,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
            ):
                with self.assertRaisesRegex(
                    RuntimeError,
                    "forecast anchor identity is invalid",
                ):
                    orchestrator._complete_ts_intraday_delivery(ledger)
            checkpoint.assert_not_called()

    def test_committed_ts_delivery_repairs_missing_provenance_without_resend(
        self,
    ) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        value = packet()
        output = {"contract_version": "v2", "role": "TS"}
        anchor = {
            "forecast_run_id": value["run_id"],
            "forecast_hash": "f" * 64,
        }
        context = {"cohort_id": "ts-v2-" + "d" * 40}
        ledger = {
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "completed_at": "2026-08-03T08:01:00-07:00",
            "artifacts_committed_at": "2026-08-03T08:01:01-07:00",
            "messages": [{"message_id": "123", "content": "TS delivery"}],
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "delivery" / f"{ledger['delivery_key']}.json"
            atomic_write_json(path, ledger)
            orchestrator = object.__new__(TradingOrchestrator)
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_intraday_delivery_ledger",
                    return_value=(value, output),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.forecast_anchor_for_run",
                    return_value=None,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._ts_formal_provenance_context",
                    return_value=context,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.publish_forecast",
                    return_value=anchor,
                ) as publish,
                patch(
                    "trading_os_v2.orchestrator.service._record_ts_forecast_checkpoint"
                ) as checkpoint,
                patch(
                    "trading_os_v2.orchestrator.service._validate_ts_forecast_anchor_binding"
                ),
            ):
                result = orchestrator._complete_ts_intraday_delivery(ledger)

        self.assertEqual(result["forecast_anchor"], anchor)
        publish.assert_called_once()
        self.assertEqual(
            publish.call_args.kwargs["provenance_context"],
            context,
        )
        checkpoint.assert_not_called()

    def test_ts_delivery_intent_accepts_only_valid_artifact_commit_marker(
        self,
    ) -> None:
        value = packet()
        delivery_key = "ts-intraday-2026-08-03-0800"
        metadata = {
            "reason": "Intraday forecast",
            "source_heartbeat_delivery_key": "heartbeat-2026-08-03-0800",
            "input_freshness": freshness(),
            "ts_output": {"contract_version": "v2", "role": "TS"},
        }
        messages = [{"channel": "ts", "content": "TS"}]
        ledger = {
            "contract_version": "v1",
            "created_at": "2026-08-03T08:00:00-07:00",
            "status": "DELIVERED",
            "kind": "TS_INTRADAY",
            "delivery_key": delivery_key,
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "messages": [
                {
                    "channel": "ts",
                    "content": _with_delivery_marker("TS", delivery_key),
                    "message_id": "123",
                    "status": "SENT",
                    "delivered_at": "2026-08-03T08:01:00-07:00",
                }
            ],
            "completed_at": "2026-08-03T08:01:00-07:00",
            "artifacts_committed_at": "2026-08-03T08:01:01-07:00",
            **metadata,
        }

        _validate_existing_delivery_intent(
            ledger,
            delivery_key,
            value,
            messages,
            kind="TS_INTRADAY",
            metadata=metadata,
        )
        ledger["artifacts_committed_at"] = "2026-08-03T08:00:59-07:00"
        with self.assertRaisesRegex(RuntimeError, "提交时间无效"):
            _validate_existing_delivery_intent(
                ledger,
                delivery_key,
                value,
                messages,
                kind="TS_INTRADAY",
                metadata=metadata,
            )

    def test_ts_delivery_intent_preserves_only_legacy_truncation(self) -> None:
        value = packet()
        delivery_key = "ts-intraday-2026-08-03-0800"
        metadata = {
            "reason": "Intraday forecast",
            "source_heartbeat_delivery_key": "heartbeat-2026-08-03-0800",
            "input_freshness": freshness(),
            "ts_output": {"contract_version": "v2", "role": "TS"},
        }
        content = "TS" * 1100
        messages = [{"channel": "ts", "content": content}]
        base_ledger = {
            "contract_version": "v1",
            "created_at": "2026-08-03T08:00:00-07:00",
            "status": "PENDING",
            "kind": "TS_INTRADAY",
            "delivery_key": delivery_key,
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "messages": [
                {
                    "channel": "ts",
                    "content": _with_delivery_marker(
                        content,
                        delivery_key,
                        legacy_truncate=True,
                    ),
                    "message_id": "",
                    "status": "PENDING",
                }
            ],
        }
        for stored_version in (
            None,
            TS_DISCORD_LEGACY_FORMAT_VERSION,
        ):
            with self.subTest(stored_version=stored_version):
                stored_metadata = dict(metadata)
                if stored_version is not None:
                    stored_metadata["ts_discord_format_version"] = (
                        stored_version
                    )
                ledger = {**base_ledger, **stored_metadata}
                _validate_existing_delivery_intent(
                    ledger,
                    delivery_key,
                    value,
                    messages,
                    kind="TS_INTRADAY",
                    metadata=stored_metadata,
                )

        for strict_version in (
            TS_DISCORD_PREVIOUS_FORMAT_VERSION,
            TS_DISCORD_FORMAT_VERSION,
        ):
            with self.subTest(strict_version=strict_version):
                strict_metadata = {
                    **metadata,
                    "ts_discord_format_version": strict_version,
                }
                strict_ledger = {
                    **base_ledger,
                    **strict_metadata,
                }
                with self.assertRaisesRegex(DiscordFailure, "拒绝截断发送"):
                    _validate_existing_delivery_intent(
                        strict_ledger,
                        delivery_key,
                        value,
                        messages,
                        kind="TS_INTRADAY",
                        metadata=strict_metadata,
                    )

    def test_intraday_window_is_clipped_to_regular_market_close(self) -> None:
        horizon, end_at, condition = _ts_forecast_window(
            "INTRADAY_30_60M",
            datetime.fromisoformat("2026-08-03T12:30:48-07:00"),
        )
        self.assertEqual(horizon, "NEXT_30_TO_60_MINUTES")
        self.assertEqual(end_at.isoformat(), "2026-08-03T13:00:00-07:00")
        self.assertEqual(condition, "AT_TIMESTAMP")
        with self.assertRaisesRegex(RuntimeError, "after market close"):
            _ts_forecast_window(
                "INTRADAY_30_60M",
                datetime.fromisoformat("2026-08-03T13:00:01-07:00"),
            )

    def test_full_cycle_calibration_requires_official_slot_ownership(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        value = packet()
        output = {
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "market_time": {
                    "observed_at": "2026-08-03T08:01:29-07:00",
                }
            },
        }
        ledger = {
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "reason": "material update",
        }
        slot = datetime.fromisoformat("2026-08-03T08:00:00-07:00")
        with TemporaryDirectory() as folder:
            root = Path(folder)
            with patch(
                "trading_os_v2.orchestrator.service.runtime_path",
                side_effect=lambda *parts: root.joinpath(*parts),
            ):
                self.assertFalse(_is_formal_calibration_delivery(ledger, output))
                _record_ts_intraday_ownership(
                    slot,
                    value,
                    owner="FULL_CYCLE",
                )
                self.assertTrue(_is_formal_calibration_delivery(ledger, output))

                foreign = packet()
                foreign["run_id"] = "20260803T150000Z-foreign"
                foreign["packet_hash"] = "c" * 64
                ledger["run_id"] = foreign["run_id"]
                ledger["packet_hash"] = foreign["packet_hash"]
                self.assertFalse(_is_formal_calibration_delivery(ledger, output))

    def test_next_session_calibration_requires_matching_fixed_reason(self) -> None:
        output = {"report_type": "NEXT_SESSION"}
        self.assertFalse(
            _is_formal_calibration_delivery(
                {"reason": "material update"},
                output,
            )
        )
        self.assertTrue(
            _is_formal_calibration_delivery(
                {"reason": "次日提前分析"},
                output,
            )
        )

    def test_opening_forecast_loads_delivered_weekend_next_session(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        prior = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "NEXT_SESSION",
            "evidence_snapshot": {
                "run_id": "20260810T054254Z-177a669827",
                "market_time": {
                    "observed_at": "2026-08-09T22:42:33-07:00",
                },
            },
            "next_validation": {
                "at": "2026-08-10T06:30:00-07:00",
                "checkpoint": "OPEN",
                "purpose": "验证次日主路径并生成06:30开盘预测",
            },
        }
        ledger = {
            "status": "DELIVERED",
            "delivery_key": "cycle-2026-08-09-next-day",
            "reason": "次日提前分析",
            "completed_at": "2026-08-09T22:45:10-07:00",
            "result": {"ts": prior},
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            path = delivery / "cycle-2026-08-09-next-day.json"
            path.touch()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    return_value=ledger,
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=packet(),
                ) as validate_cycle,
            ):
                self.assertEqual(
                    _prior_delivered_ts_forecast(
                        "OPENING_FORECAST",
                        datetime.fromisoformat(
                            "2026-08-10T06:30:47-07:00"
                        ),
                    ),
                    prior,
                )
        validate_cycle.assert_called_once_with(ledger)

    def test_opening_forecast_selects_latest_delivered_prior(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        first = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "NEXT_SESSION",
            "evidence_snapshot": {
                "run_id": "20260810T010000Z-aaaaaaaaaa",
                "market_time": {
                    "observed_at": "2026-07-02T18:00:00-07:00",
                },
            },
            "next_validation": {
                "at": "2026-07-06T06:30:00-07:00",
                "checkpoint": "OPEN",
                "purpose": "验证次日主路径并生成06:30开盘预测",
            },
        }
        second = deepcopy(first)
        second["evidence_snapshot"]["run_id"] = (
            "20260810T020000Z-bbbbbbbbbb"
        )
        second["evidence_snapshot"]["market_time"]["observed_at"] = (
            "2026-07-03T18:00:00-07:00"
        )
        ledgers = {
            "cycle-2026-07-02-next-day.json": {
                "status": "DELIVERED",
                "delivery_key": "cycle-2026-07-02-next-day",
                "reason": "次日提前分析",
                "completed_at": "2026-07-02T18:05:00-07:00",
                "result": {"ts": first},
            },
            "cycle-2026-07-03-next-day.json": {
                "status": "DELIVERED",
                "delivery_key": "cycle-2026-07-03-next-day",
                "reason": "次日提前分析",
                "completed_at": "2026-07-03T18:10:00-07:00",
                "result": {"ts": second},
            },
        }
        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            for name in ledgers:
                (delivery / name).touch()
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    side_effect=lambda path, _default: ledgers[path.name],
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=packet(),
                ),
            ):
                self.assertEqual(
                    _prior_delivered_ts_forecast(
                        "OPENING_FORECAST",
                        datetime.fromisoformat(
                            "2026-07-06T06:30:47-07:00"
                        ),
                    ),
                    second,
                )

    @patch("trading_os_v2.orchestrator.service._delivered_full_cycle_ts")
    @patch("trading_os_v2.orchestrator.service._ts_ownership_for_slot")
    def test_prior_forecast_uses_latest_delivered_and_skips_undelivered(
        self,
        ownership,
        delivered_cycle,
    ) -> None:
        prior = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "OPENING_FORECAST",
            "evidence_snapshot": {
                "run_id": "20260803T133000Z-eeeeeeeeee",
                "market_time": {
                    "observed_at": "2026-08-03T06:30:00-07:00",
                },
            },
        }
        ownership.return_value = {
            "owner": "FULL_CYCLE",
            "run_id": prior["evidence_snapshot"]["run_id"],
            "packet_hash": "b" * 64,
        }
        delivered_cycle.side_effect = [None, None, prior]

        self.assertEqual(
            _prior_delivered_ts_forecast(
                "INTRADAY_30_60M",
                datetime.fromisoformat("2026-08-03T07:30:00-07:00"),
            ),
            prior,
        )
        self.assertEqual(delivered_cycle.call_count, 3)

    def test_prior_forecast_finds_fixed_and_material_full_cycles(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        cases = (
            ("06:45", "06:30", "OPEN_15M_CHECK", "cycle-2026-08-03-early"),
            ("07:00", "06:30", "OPEN_30M_CHECK", "cycle-2026-08-03-early"),
            ("09:00", "08:30", "INTRADAY_30_60M", "cycle-material-abcd"),
            ("10:00", "09:30", "INTRADAY_30_60M", "cycle-2026-08-03-mid"),
            ("12:00", "11:30", "INTRADAY_30_60M", "cycle-2026-08-03-late"),
        )
        for current, prior_time, report_type, delivery_key in cases:
            with self.subTest(current=current), TemporaryDirectory() as folder:
                root = Path(folder)
                delivery = root / "delivery"
                delivery.mkdir()
                path = delivery / f"{delivery_key}.json"
                path.touch()
                ownership = {
                    "owner": "FULL_CYCLE",
                    "run_id": "20260803T133000Z-eeeeeeeeee",
                    "packet_hash": "b" * 64,
                }
                prior = {
                    "contract_version": "v2",
                    "role": "TS",
                    "report_type": "INTRADAY_30_60M",
                    "evidence_snapshot": {
                        "run_id": ownership["run_id"],
                        "packet_hash": ownership["packet_hash"],
                        "market_time": {
                            "observed_at": f"2026-08-03T{prior_time}:00-07:00",
                        },
                    },
                }
                ledger = {
                    "status": "DELIVERED",
                    "run_id": ownership["run_id"],
                    "packet_hash": ownership["packet_hash"],
                    "delivery_key": delivery_key,
                    "result": {"ts": prior},
                }
                with (
                    patch(
                        "trading_os_v2.orchestrator.service.runtime_path",
                        side_effect=lambda *parts: root.joinpath(*parts),
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._ts_ownership_for_slot",
                        return_value=ownership,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service.read_json",
                        return_value=ledger,
                    ),
                    patch(
                        "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                        return_value=packet(),
                    ) as validate_cycle,
                ):
                    self.assertEqual(
                        _prior_delivered_ts_forecast(
                            report_type,
                            datetime.fromisoformat(
                                f"2026-08-03T{current}:00-07:00"
                            ),
                        ),
                        prior,
                    )
                validate_cycle.assert_called_once_with(ledger)

    def test_open_checks_accept_delivered_retry_after_aborted_early(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as folder:
            root = Path(folder)
            delivery = root / "delivery"
            delivery.mkdir()
            base_path = delivery / "cycle-2026-08-03-early.json"
            retry_path = delivery / "cycle-2026-08-03-early-retry-feedface00.json"
            base_path.touch()
            retry_path.touch()
            ownership = {
                "owner": "FULL_CYCLE",
                "run_id": "20260803T133000Z-eeeeeeeeee",
                "packet_hash": "b" * 64,
            }
            prior = {
                "contract_version": "v2",
                "role": "TS",
                "report_type": "OPENING_FORECAST",
                "evidence_snapshot": {
                    "run_id": ownership["run_id"],
                    "packet_hash": ownership["packet_hash"],
                    "market_time": {
                        "observed_at": "2026-08-03T06:30:00-07:00",
                    },
                },
            }
            base = {"status": "ABORTED"}
            retry = {
                "status": "DELIVERED",
                "run_id": ownership["run_id"],
                "packet_hash": ownership["packet_hash"],
                "delivery_key": retry_path.stem,
                "reason": "早盘固定分析",
                "result": {"reason": "早盘固定分析", "ts": prior},
            }
            values = {base_path: base, retry_path: retry}
            with (
                patch(
                    "trading_os_v2.orchestrator.service.runtime_path",
                    side_effect=lambda *parts: root.joinpath(*parts),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._ts_ownership_for_slot",
                    return_value=ownership,
                ),
                patch(
                    "trading_os_v2.orchestrator.service.read_json",
                    side_effect=lambda path, _default: values.get(path),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_cycle_delivery_artifacts",
                    return_value=packet(),
                ),
                patch(
                    "trading_os_v2.orchestrator.service._validate_retry_cycle_identity"
                ) as validate_retry,
            ):
                for report_type, current in (
                    ("OPEN_15M_CHECK", "06:45"),
                    ("OPEN_30M_CHECK", "07:00"),
                ):
                    self.assertEqual(
                        _prior_delivered_ts_forecast(
                            report_type,
                            datetime.fromisoformat(
                                f"2026-08-03T{current}:00-07:00"
                            ),
                        ),
                        prior,
                    )
            self.assertEqual(validate_retry.call_count, 4)

    @patch("trading_os_v2.orchestrator.service._ts_ownership_for_slot")
    @patch("trading_os_v2.orchestrator.service._validate_ts_intraday_delivery_ledger")
    @patch("trading_os_v2.orchestrator.service.read_json")
    def test_prior_forecast_keeps_nonfixed_intraday_ledger(
        self,
        read,
        validate_intraday,
        ownership,
    ) -> None:
        ledger = {
            "status": "DELIVERED",
            "delivery_key": "ts-intraday-2026-08-03-0730",
        }
        prior = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "INTRADAY_30_60M",
            "evidence_snapshot": {
                "run_id": "20260803T143000Z-eeeeeeeeee",
                "packet_hash": "b" * 64,
                "market_time": {
                    "observed_at": "2026-08-03T07:30:00-07:00",
                },
            },
        }
        ownership.return_value = {
            "owner": "TS_INTRADAY",
            "run_id": prior["evidence_snapshot"]["run_id"],
            "packet_hash": prior["evidence_snapshot"]["packet_hash"],
        }
        read.return_value = ledger
        validate_intraday.return_value = (packet(), prior)

        self.assertEqual(
            _prior_delivered_ts_forecast(
                "INTRADAY_30_60M",
                datetime.fromisoformat("2026-08-03T08:00:00-07:00"),
            ),
            prior,
        )
        self.assertTrue(str(read.call_args.args[0]).endswith("-0730.json"))
        validate_intraday.assert_called_once_with(ledger)

    def test_delivered_ts_ledger_is_recognized_without_resending(self) -> None:
        value = packet()
        proof = freshness()
        output = {"contract_version": "v2", "role": "TS"}
        ledger = {
            "status": "DELIVERED",
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": value["run_id"],
            "packet_hash": value["packet_hash"],
            "input_freshness": proof,
            "ts_output": output,
            "reason": "ç›˜ä¸­30è‡³60åˆ†é’Ÿé¢„æµ‹",
        }
        with (
            patch(
                "trading_os_v2.orchestrator.service._load_cycle_evidence",
                return_value=value,
            ),
            patch(
                "trading_os_v2.orchestrator.service.validate_agent_input_freshness",
                return_value=proof,
            ),
            patch(
                "trading_os_v2.orchestrator.service._validate_existing_delivery_intent"
            ) as validate_intent,
            patch(
                "trading_os_v2.orchestrator.service._validate_ts_cycle_binding"
            ) as validate_binding,
            patch(
                "trading_os_v2.orchestrator.service.format_agent",
                return_value="TS",
            ) as formatter,
            patch(
                "trading_os_v2.orchestrator.service._validate_heartbeat_delivery_ledger",
                return_value=value,
            ),
            patch(
                "trading_os_v2.orchestrator.service._validate_ts_intraday_ownership",
                return_value={"owner": "TS_INTRADAY"},
            ),
        ):
            self.assertEqual(
                _validate_ts_intraday_delivery_ledger(ledger),
                (value, output),
            )
        validate_intent.assert_called_once()
        formatter.assert_called_once_with(
            "TS",
            output,
            ledger["reason"],
            ts_format_version=TS_DISCORD_LEGACY_FORMAT_VERSION,
        )
        self.assertEqual(validate_intent.call_args.args[1], ledger["delivery_key"])
        self.assertEqual(
            validate_intent.call_args.kwargs["metadata"][
                "source_heartbeat_delivery_key"
            ],
            "heartbeat-2026-08-03-0800",
        )
        self.assertNotIn(
            "ts_discord_format_version",
            validate_intent.call_args.kwargs["metadata"],
        )
        validate_binding.assert_called_once()

    def test_delivered_ts_ledger_rejects_foreign_source_heartbeat(self) -> None:
        current = packet()
        foreign = deepcopy(current)
        foreign["run_id"] = "20260803T150000Z-eeeeeeeeee"
        foreign["packet_hash"] = "e" * 64
        proof = freshness()
        ledger = {
            "status": "DELIVERED",
            "delivery_key": "ts-intraday-2026-08-03-0800",
            "run_id": foreign["run_id"],
            "packet_hash": foreign["packet_hash"],
            "input_freshness": proof,
            "ts_output": {"contract_version": "v2", "role": "TS"},
            "reason": "盘中30至60分钟预测",
        }
        with (
            patch(
                "trading_os_v2.orchestrator.service._load_cycle_evidence",
                return_value=foreign,
            ),
            patch(
                "trading_os_v2.orchestrator.service.validate_agent_input_freshness",
                return_value=proof,
            ),
            patch(
                "trading_os_v2.orchestrator.service._validate_heartbeat_delivery_ledger",
                return_value=current,
            ),
            patch(
                "trading_os_v2.orchestrator.service._validate_ts_intraday_ownership"
            ) as validate_ownership,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "not bound to its source heartbeat",
            ):
                _validate_ts_intraday_delivery_ledger(ledger)
        validate_ownership.assert_not_called()

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    def test_next_session_binds_one_snapshot_and_keeps_enhancements_optional(
        self,
        _release,
    ) -> None:
        context = _ts_report_context(
            packet(),
            freshness(observed_at="2026-08-04T01:00:00+00:00"),
            "次日提前分析",
        )
        self.assertEqual(context["report_type"], "NEXT_SESSION")
        self.assertEqual(
            context["forecast_window"],
            {
                "horizon": "NEXT_REGULAR_SESSION",
                "start_at": "2026-08-03T18:00:00-07:00",
                "end_at": None,
                "end_condition": "NEXT_REGULAR_SESSION_CLOSE",
            },
        )
        self.assertEqual(
            context["evidence_snapshot"],
            {
                "run_id": RUN_ID,
                "packet_hash": "b" * 64,
                "analysis_freshness_hash": "c" * 64,
                "release_commit": "d" * 40,
                "market_time": {
                    "timezone": "America/Los_Angeles",
                    "observed_at": "2026-08-03T18:00:00-07:00",
                    "market_date": "2026-08-03",
                    "state": "OPEN",
                },
            },
        )
        self.assertEqual(
            context["required_next_validation"],
            {
                "at": "2026-08-04T06:30:00-07:00",
                "checkpoint": "OPEN",
                "purpose": "验证次日主路径并生成06:30开盘预测",
            },
        )
        assessment = context["evidence_assessment"]
        self.assertEqual(assessment["core_status"], "READY")
        self.assertIn("MARKET_MOVING_NEWS", assessment["enhanced_available"])
        self.assertIn("OIL_CONTEXT", assessment["enhanced_available"])
        self.assertIn("OPTIONS_POSITIONING", assessment["enhanced_available"])
        self.assertIn("RATES_CONTEXT", assessment["enhanced_missing"])
        self.assertIn("SECTOR_BREADTH", assessment["enhanced_missing"])
        self.assertEqual(
            assessment["enhancement_gap_effect"],
            "LOWERS_MATURITY_NOT_FORECAST_AVAILABILITY",
        )
        self.assertNotIn("market_moving_news_events", context)
        self.assertNotIn("scheduled_macro_events", context)

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    def test_official_macro_schedule_is_optional_enhanced_evidence(
        self,
        _release,
    ) -> None:
        with_macro = packet()
        with_macro["a1"]["macro_watch"] = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "status": "HEALTHY",
            "events": [
                macro_event(
                    "e" * 64,
                    "employment",
                    "2026-08-07T05:30:00-07:00",
                    release_name="Employment Situation",
                ),
                macro_event(
                    "f" * 64,
                    "inflation",
                    "2026-08-12T05:30:00-07:00",
                    release_name="Consumer Price Index",
                ),
            ],
        }
        context = _ts_report_context(
            with_macro,
            freshness(observed_at="2026-08-07T01:00:00+00:00"),
            "次日提前分析",
        )
        assessment = context["evidence_assessment"]
        self.assertIn("MACRO_SCHEDULE", assessment["enhanced_available"])
        self.assertIn("RATES_CONTEXT", assessment["enhanced_available"])
        self.assertNotIn("MACRO_SCHEDULE", assessment["enhanced_missing"])
        self.assertNotIn("market_moving_news_events", context)
        self.assertNotIn("scheduled_macro_events", context)

    def test_verified_macro_result_survives_news_ttl_only_as_ts_evidence(
        self,
    ) -> None:
        value = packet()
        value["a1"]["health"] = {
            "verified_market_moving_news": False,
            "market_moving_news_evidence": [],
        }
        value["a1"]["macro_results"] = [macro_result()]
        frozen = deepcopy(value)

        available = _ts_enhanced_evidence(value, freshness())

        self.assertIn("MARKET_MOVING_NEWS", available)
        self.assertIn("RATES_CONTEXT", available)
        self.assertEqual(value, frozen)
        self.assertFalse(value["a1"]["health"]["verified_market_moving_news"])

    def test_macro_result_must_match_snapshot_day_and_hash(self) -> None:
        value = packet()
        value["a1"]["health"] = {
            "verified_market_moving_news": False,
            "market_moving_news_evidence": [],
        }
        stale = macro_result(market_date="2026-08-02")
        value["a1"]["macro_results"] = [stale]
        available = _ts_enhanced_evidence(value, freshness())
        self.assertNotIn("MARKET_MOVING_NEWS", available)
        self.assertNotIn("RATES_CONTEXT", available)

        tampered = macro_result()
        tampered["metrics"][0]["value"] = 1
        value["a1"]["macro_results"] = [tampered]
        available = _ts_enhanced_evidence(value, freshness())
        self.assertNotIn("MARKET_MOVING_NEWS", available)
        self.assertNotIn("RATES_CONTEXT", available)

        future = macro_result()
        future["published_at"] = "2026-08-03T07:00:00-07:00"
        future["generated_at"] = "2026-08-03T07:01:00-07:00"
        stable = {
            key: item
            for key, item in future.items()
            if key not in {"generated_at", "result_hash"}
        }
        future["result_hash"] = sha256_json(stable)
        value["a1"]["macro_results"] = [future]
        available = _ts_enhanced_evidence(value, freshness())
        self.assertNotIn("MARKET_MOVING_NEWS", available)
        self.assertNotIn("RATES_CONTEXT", available)

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    def test_causal_evidence_stays_local_and_does_not_mutate_packet(
        self,
        _release,
    ) -> None:
        value = packet()
        value["a1"]["macro_watch"] = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "status": "HEALTHY",
            "events": [
                macro_event(
                    f"{index + 64:064x}",
                    "employment",
                    f"2026-08-07T0{5 + index}:30:00-07:00",
                    release_name=f"Employment release {index}",
                )
                for index in range(3)
            ],
        }
        frozen = deepcopy(value)

        context = _ts_report_context(
            value,
            freshness(observed_at="2026-08-07T01:00:00+00:00"),
            "次日提前分析",
        )

        self.assertEqual(value, frozen)
        self.assertNotIn("market_moving_news_events", context)
        self.assertNotIn("scheduled_macro_events", context)
        assessment = context["evidence_assessment"]
        self.assertIn("MARKET_MOVING_NEWS", assessment["enhanced_available"])
        self.assertIn("MACRO_SCHEDULE", assessment["enhanced_available"])
        self.assertIn("RATES_CONTEXT", assessment["enhanced_available"])

    def test_next_session_validation_skips_weekend(self) -> None:
        required = _ts_required_next_validation(
            "NEXT_SESSION",
            datetime.fromisoformat("2026-08-07T18:00:00-07:00"),
        )
        self.assertEqual(required["at"], "2026-08-10T06:30:00-07:00")
        self.assertIsNone(
            _ts_required_next_validation(
                "INTRADAY_30_60M",
                datetime.fromisoformat("2026-08-07T12:00:00-07:00"),
            )
        )

    def test_next_session_validation_skips_nyse_regular_holidays(self) -> None:
        cases = (
            (
                "2026-07-02T18:00:00-07:00",
                "2026-07-06T06:30:00-07:00",
            ),
            (
                "2026-04-02T18:00:00-07:00",
                "2026-04-06T06:30:00-07:00",
            ),
            (
                "2027-12-30T18:00:00-08:00",
                "2027-12-31T06:30:00-08:00",
            ),
        )
        for observed_at, expected in cases:
            with self.subTest(observed_at=observed_at):
                required = _ts_required_next_validation(
                    "NEXT_SESSION",
                    datetime.fromisoformat(observed_at),
                )
                self.assertEqual(required["at"], expected)

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    def test_holiday_next_session_keeps_actual_session_macro_events(
        self,
        _release,
    ) -> None:
        with_macro = packet()
        actual_session_event = macro_event(
            "e" * 64,
            "employment",
            "2026-07-06T05:30:00-07:00",
            release_name="Employment Situation",
        )
        with_macro["a1"]["macro_watch"] = {
            "contract_version": "v1",
            "component": "A1_MACRO_WATCH",
            "status": "HEALTHY",
            "events": [
                actual_session_event,
                macro_event(
                    "f" * 64,
                    "inflation",
                    "2026-07-06T13:30:00-07:00",
                    release_name="Consumer Price Index",
                ),
            ],
        }
        frozen = deepcopy(with_macro)
        observed_at = datetime.fromisoformat("2026-07-02T18:00:00-07:00")
        selected = _ts_scheduled_macro_events(
            with_macro,
            "NEXT_SESSION",
            observed_at,
        )
        context = _ts_report_context(
            with_macro,
            freshness(observed_at="2026-07-03T01:00:00+00:00"),
            "次日提前分析",
        )
        self.assertEqual(with_macro, frozen)
        self.assertEqual(selected, [actual_session_event])
        self.assertIsNot(selected[0], actual_session_event)
        self.assertEqual(
            context["required_next_validation"]["at"],
            "2026-07-06T06:30:00-07:00",
        )
        self.assertIn(
            "MACRO_SCHEDULE",
            context["evidence_assessment"]["enhanced_available"],
        )
        self.assertNotIn("market_moving_news_events", context)
        self.assertNotIn("scheduled_macro_events", context)

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    @patch("trading_os_v2.orchestrator.service._prior_delivered_ts_forecast")
    def test_opening_forecast_audits_prior_next_session(
        self,
        latest,
        _release,
    ) -> None:
        prior_forecast = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "NEXT_SESSION",
            "evidence_snapshot": {
                "run_id": "20260810T054254Z-177a669827",
            },
        }
        latest.return_value = prior_forecast
        context = _ts_report_context(
            packet(),
            freshness(observed_at="2026-08-10T13:30:47+00:00"),
            "早盘固定分析",
        )
        self.assertEqual(context["report_type"], "OPENING_FORECAST")
        self.assertEqual(
            context["forecast_update"],
            {
                "mode": "CHECK",
                "prior_run_id": "20260810T054254Z-177a669827",
                "prior_forecast_hash": sha256_json(prior_forecast),
            },
        )
        self.assertEqual(context["prior_forecast"], prior_forecast)
        latest.assert_called_once_with(
            "OPENING_FORECAST",
            datetime.fromisoformat("2026-08-10T06:30:47-07:00"),
        )

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    @patch(
        "trading_os_v2.orchestrator.service._prior_delivered_ts_forecast",
        return_value=None,
    )
    def test_opening_forecast_without_next_session_faults(
        self,
        _latest,
        _release,
    ) -> None:
        with self.assertRaisesRegex(
            RuntimeError,
            "no delivered NEXT_SESSION",
        ):
            _ts_report_context(
                packet(),
                freshness(observed_at="2026-08-10T13:30:47+00:00"),
                "早盘固定分析",
            )

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    @patch("trading_os_v2.orchestrator.service._prior_delivered_ts_forecast")
    def test_open_checks_bind_the_same_day_opening_forecast(
        self,
        latest,
        _release,
    ) -> None:
        prior_forecast = {
            "contract_version": "v2",
            "role": "TS",
            "report_type": "OPENING_FORECAST",
            "evidence_snapshot": {
                "run_id": "20260803T133000Z-eeeeeeeeee",
            },
        }
        latest.return_value = prior_forecast
        context = _ts_report_context(
            packet(),
            freshness(observed_at="2026-08-03T13:45:00+00:00"),
            "开盘15分钟验证",
        )
        self.assertEqual(context["report_type"], "OPEN_15M_CHECK")
        self.assertEqual(
            context["forecast_update"],
            {
                "mode": "CHECK",
                "prior_run_id": "20260803T133000Z-eeeeeeeeee",
                "prior_forecast_hash": sha256_json(prior_forecast),
            },
        )
        self.assertEqual(context["prior_forecast"], prior_forecast)
        latest.assert_called_once_with(
            "OPEN_15M_CHECK",
            datetime.fromisoformat("2026-08-03T06:45:00-07:00"),
        )

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    @patch(
        "trading_os_v2.orchestrator.service._prior_delivered_ts_forecast",
        return_value=None,
    )
    def test_open_check_without_original_forecast_faults(
        self,
        _latest,
        _release,
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "缺少同日原始早盘预测"):
            _ts_report_context(
                packet(),
                freshness(observed_at="2026-08-03T14:00:00+00:00"),
                "开盘30分钟验证",
            )

    def test_open_validation_slots_are_explicit(self) -> None:
        self.assertEqual(
            _scheduled_report_reason(
                datetime.fromisoformat("2026-08-03T06:45:30-07:00")
            ),
            "开盘15分钟验证",
        )
        self.assertEqual(
            _scheduled_report_reason(
                datetime.fromisoformat("2026-08-03T07:00:30-07:00")
            ),
            "开盘30分钟验证",
        )

    @patch(
        "trading_os_v2.orchestrator.service._release_commit",
        return_value="d" * 40,
    )
    def test_missing_all_enhancements_does_not_block_forecast_context(
        self,
        _release,
    ) -> None:
        value = packet()
        value["a1"]["health"] = {
            "verified_market_moving_news": False,
            "market_moving_news_evidence": [],
        }
        proof = deepcopy(freshness())
        proof["symbols"]["SPY"]["expiration_count"] = 0
        proof["symbols"]["QQQ"]["expiration_count"] = 0
        context = _ts_report_context(value, proof, "中盘固定分析")
        self.assertEqual(
            context["evidence_assessment"]["enhanced_available"],
            [],
        )
        self.assertEqual(
            len(context["evidence_assessment"]["enhanced_missing"]),
            8,
        )
        self.assertIn(
            "MACRO_SCHEDULE",
            context["evidence_assessment"]["enhanced_missing"],
        )


if __name__ == "__main__":
    unittest.main()
