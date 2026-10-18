from __future__ import annotations

import json
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable
from zoneinfo import ZoneInfo

from trading_os_v2.a2.half_hour_forecast import (
    DuplicateRecordError,
    HalfHourForecastError,
    HalfHourForecastService,
)
from trading_os_v2.common.io import sha256_json


PT = ZoneInfo("America/Los_Angeles")
PUBLIC_PROOF_KEYS = {
    "contract_version",
    "component",
    "mode",
    "actionable",
    "status",
    "issue_status",
    "issued_forecast_id",
    "issued_forecast_hash",
    "session_date",
    "session_issued_forecast_ids",
    "session_inventory_hash",
    "resolved_forecast_ids",
    "pending_overdue_forecast_ids",
}


def _bar(start: datetime, close: float, *, high: float | None = None, low: float | None = None) -> dict:
    return {
        "timestamp": int(start.timestamp()),
        "open": close,
        "high": high if high is not None else close + 0.25,
        "low": low if low is not None else close - 0.25,
        "close": close,
        "volume": 1000,
    }


def _history(slot: datetime, base: float) -> list[dict]:
    return [
        _bar(slot - timedelta(minutes=30 - 5 * index), base + index * 0.1)
        for index in range(6)
    ]


def _future(slot: datetime, closes: list[float]) -> list[dict]:
    return [
        _bar(
            slot + timedelta(minutes=5 * index),
            close,
            high=close + 1,
            low=close - 1,
        )
        for index, close in enumerate(closes)
    ]


def _inputs(slot: datetime, spy_state: str = "TREND_UP", qqq_state: str = "TREND_DOWN") -> dict:
    return {
        "contract_version": "v1",
        "issued_at": slot + timedelta(seconds=20),
        "bars": {
            "SPY": _history(slot, 100),
            "QQQ": _history(slot, 200),
        },
        "pattern_states": {
            "SPY": {"current_state": spy_state, "direction": "bullish"},
            "QQQ": {"current_state": qqq_state, "direction": "bearish"},
        },
        "structures": {
            "SPY": {"atr14": 5.0, "vwap_state": "above"},
            "QQQ": {"atr14": 8.0, "vwap_state": "below"},
        },
        "options": {
            "SPY": {"put_call_volume_ratio": 1.5},
            "QQQ": {"put_call_volume_ratio": 0.7},
        },
    }


def _process_inputs(slot: datetime) -> dict:
    result = _inputs(slot)
    result["collected_at"] = result.pop("issued_at")
    return result


def _rewrite_forecast_and_manifest(
    root: Path,
    forecast_id: str,
    mutate: Callable[[dict], None],
) -> None:
    forecast_path = root / "forecasts" / f"{forecast_id}.json"
    forecast = json.loads(forecast_path.read_text(encoding="utf-8"))
    mutate(forecast)
    forecast["forecast_hash"] = sha256_json(
        {
            key: value
            for key, value in forecast.items()
            if key != "forecast_hash"
        }
    )
    forecast_path.write_text(
        json.dumps(forecast, ensure_ascii=False),
        encoding="utf-8",
    )

    manifest_path = root / "issuance_manifest" / f"{forecast_id}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["forecast_hash"] = forecast["forecast_hash"]
    if "slot_at" in forecast:
        manifest["slot_at"] = forecast["slot_at"]
    manifest["manifest_hash"] = sha256_json(
        {
            key: value
            for key, value in manifest.items()
            if key != "manifest_hash"
        }
    )
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False),
        encoding="utf-8",
    )


def _rewrite_outcome(
    path: Path,
    mutate: Callable[[dict], None],
) -> None:
    outcome = json.loads(path.read_text(encoding="utf-8"))
    mutate(outcome)
    outcome["outcome_hash"] = sha256_json(
        {
            key: value
            for key, value in outcome.items()
            if key != "outcome_hash"
        }
    )
    path.write_text(
        json.dumps(outcome, ensure_ascii=False),
        encoding="utf-8",
    )


def _expected_inventory_hash(
    root: Path,
    session_date: str,
    forecast_ids: list[str],
) -> str:
    records = []
    for forecast_id in forecast_ids:
        manifest = json.loads(
            (
                root / "issuance_manifest" / f"{forecast_id}.json"
            ).read_text(encoding="utf-8")
        )
        forecast = json.loads(
            (
                root / "forecasts" / f"{forecast_id}.json"
            ).read_text(encoding="utf-8")
        )
        outcome_path = root / "outcomes" / f"{forecast_id}.json"
        outcome = (
            json.loads(outcome_path.read_text(encoding="utf-8"))
            if outcome_path.exists()
            else None
        )
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
    return sha256_json(
        {
            "contract_version": "v1",
            "component": "A2_HALF_HOUR_FORECAST",
            "session_date": session_date,
            "records": records,
        }
    )


class HalfHourForecastTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.service = HalfHourForecastService(self.root)
        self.slot = datetime(2026, 7, 30, 7, 0, tzinfo=PT)

    def test_issues_shadow_continuation_without_option_flip(self) -> None:
        result = self.service.issue(**_inputs(self.slot))

        self.assertEqual(result["status"], "ISSUED")
        self.assertEqual(result["mode"], "SHADOW")
        self.assertFalse(result["actionable"])
        self.assertEqual(result["symbols"]["SPY"]["forecast"], "UP")
        self.assertEqual(
            result["symbols"]["SPY"]["option_proxy"]["alignment"],
            "OPPOSED",
        )
        self.assertFalse(
            result["symbols"]["SPY"]["option_proxy"]["changes_forecast"]
        )
        self.assertEqual(result["symbols"]["QQQ"]["forecast"], "DOWN")
        self.assertEqual(
            result["symbols"]["QQQ"]["option_proxy"]["alignment"],
            "OPPOSED",
        )
        self.assertEqual(len(result["target_bar_times"]), 6)
        payload = {
            key: value for key, value in result.items() if key != "forecast_hash"
        }
        self.assertEqual(result["forecast_hash"], sha256_json(payload))

    def test_transition_and_unknown_are_uncertain(self) -> None:
        result = self.service.issue(
            **_inputs(self.slot, spy_state="TRANSITION", qqq_state="UNKNOWN")
        )
        self.assertEqual(result["symbols"]["SPY"]["forecast"], "UNCERTAIN")
        self.assertEqual(result["symbols"]["QQQ"]["forecast"], "UNCERTAIN")
        self.assertEqual(
            result["symbols"]["SPY"]["option_proxy"]["alignment"],
            "NEUTRAL",
        )

    def test_range_states_stay_range(self) -> None:
        result = self.service.issue(
            **_inputs(self.slot, spy_state="NARROW_RANGE", qqq_state="WIDE_CHOP")
        )
        self.assertEqual(result["symbols"]["SPY"]["forecast"], "RANGE")
        self.assertEqual(result["symbols"]["QQQ"]["forecast"], "RANGE")

    def test_schedule_starts_at_0700_and_ends_at_1230(self) -> None:
        early = _inputs(self.slot - timedelta(minutes=15))
        late_slot = self.slot.replace(hour=12, minute=30)
        late = _inputs(late_slot)
        after = _inputs(late_slot + timedelta(minutes=15))

        self.assertEqual(self.service.issue(**early)["status"], "NOT_DUE")
        self.assertEqual(self.service.issue(**late)["status"], "ISSUED")
        self.assertEqual(self.service.issue(**after)["status"], "NOT_DUE")

    def test_bounded_lateness_maps_to_the_scheduled_forecast_id(self) -> None:
        on_time = self.service.issue(**_inputs(self.slot))
        late_service = HalfHourForecastService(self.root / "late")
        late = _inputs(self.slot)
        late["issued_at"] = self.slot + timedelta(minutes=1, seconds=59)

        delayed = late_service.issue(**late)

        self.assertEqual(delayed["forecast_id"], on_time["forecast_id"])

    def test_three_minutes_late_is_not_due(self) -> None:
        inputs = _inputs(self.slot)
        inputs["issued_at"] = self.slot + timedelta(minutes=3)

        self.assertEqual(self.service.issue(**inputs)["status"], "NOT_DUE")

    def test_missing_history_is_pending_and_not_written(self) -> None:
        inputs = _inputs(self.slot)
        inputs["bars"]["SPY"].pop()
        result = self.service.issue(**inputs)
        self.assertEqual(result["status"], "PENDING")
        self.assertFalse((self.root / "forecasts").exists())

    def test_future_bar_is_rejected(self) -> None:
        inputs = _inputs(self.slot)
        inputs["bars"]["SPY"].append(_bar(self.slot, 101))
        with self.assertRaisesRegex(HalfHourForecastError, "发行时点后"):
            self.service.issue(**inputs)

    def test_out_of_order_and_naive_bar_times_are_rejected(self) -> None:
        inputs = _inputs(self.slot)
        inputs["bars"]["SPY"][0], inputs["bars"]["SPY"][1] = (
            inputs["bars"]["SPY"][1],
            inputs["bars"]["SPY"][0],
        )
        with self.assertRaisesRegex(HalfHourForecastError, "out of order"):
            self.service.issue(**inputs)

        inputs = _inputs(self.slot)
        inputs["bars"]["SPY"][0].pop("timestamp")
        inputs["bars"]["SPY"][0]["start_at"] = "2026-07-30T09:30:00"
        with self.assertRaisesRegex(HalfHourForecastError, "timezone"):
            self.service.issue(**inputs)

    def test_unknown_contract_and_pattern_are_rejected(self) -> None:
        inputs = _inputs(self.slot)
        inputs["contract_version"] = "v2"
        with self.assertRaisesRegex(HalfHourForecastError, "未知"):
            self.service.issue(**inputs)

        inputs = _inputs(self.slot)
        inputs["pattern_states"]["SPY"]["current_state"] = "MADE_UP"
        with self.assertRaisesRegex(HalfHourForecastError, "盘型状态无效"):
            self.service.issue(**inputs)

    def test_duplicate_forecast_is_rejected_without_overwrite(self) -> None:
        first = self.service.issue(**_inputs(self.slot))
        path = self.root / "forecasts" / f"{first['forecast_id']}.json"
        before = path.read_bytes()
        with self.assertRaises(DuplicateRecordError):
            self.service.issue(**_inputs(self.slot))
        self.assertEqual(path.read_bytes(), before)

    def test_resolve_waits_for_exact_six_future_closed_bars(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        result = self.service.resolve(
            contract_version="v1",
            forecast_id=forecast["forecast_id"],
            resolved_at=self.slot + timedelta(minutes=30),
            bars={
                "SPY": _future(self.slot, [101, 102, 103, 104, 105]) ,
                "QQQ": _future(self.slot, [201, 202, 203, 204, 205]),
            },
        )
        self.assertEqual(result["status"], "PENDING")
        self.assertFalse((self.root / "outcomes").exists())

    def test_resolves_write_once_hash_bound_outcome(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        bars = {
            "SPY": _future(self.slot, [101, 99, 102, 98, 104, 103]),
            "QQQ": _future(self.slot, [201, 199, 202, 198, 204, 203]),
        }
        outcome = self.service.resolve(
            contract_version="v1",
            forecast_id=forecast["forecast_id"],
            resolved_at=self.slot + timedelta(minutes=30),
            bars=bars,
        )

        self.assertEqual(outcome["status"], "RESOLVED")
        self.assertEqual(outcome["bar_count_per_symbol"], 6)
        self.assertEqual(outcome["forecast_hash"], forecast["forecast_hash"])
        spy = outcome["symbols"]["SPY"]
        anchor = forecast["symbols"]["SPY"]["anchor_closed_price"]
        self.assertAlmostEqual(
            spy["return_pct"],
            (103 / anchor - 1) * 100,
            places=6,
        )
        self.assertEqual(spy["excursion_basis"], "UNDERLYING_LONG")
        expected_target_bars = [
            {
                "time": datetime.fromtimestamp(
                    row["timestamp"], UTC
                ).isoformat(),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            }
            for row in bars["SPY"]
        ]
        self.assertEqual(spy["target_bars"], expected_target_bars)
        self.assertEqual(
            spy["bar_hash"],
            sha256_json(expected_target_bars),
        )
        payload = {
            key: value for key, value in outcome.items() if key != "outcome_hash"
        }
        self.assertEqual(outcome["outcome_hash"], sha256_json(payload))

        path = self.root / "outcomes" / f"{forecast['forecast_id']}.json"
        before = path.read_bytes()
        with self.assertRaises(DuplicateRecordError):
            self.service.resolve(
                contract_version="v1",
                forecast_id=forecast["forecast_id"],
                resolved_at=self.slot + timedelta(minutes=30),
                bars=bars,
            )
        self.assertEqual(path.read_bytes(), before)

    def test_resolve_rejects_unclosed_future_data(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        bars = {
            "SPY": _future(self.slot, [101, 102, 103, 104, 105, 106]),
            "QQQ": _future(self.slot, [201, 202, 203, 204, 205, 206]),
        }
        bars["SPY"].append(_bar(self.slot + timedelta(minutes=30), 107))
        with self.assertRaisesRegex(HalfHourForecastError, "尚未闭合"):
            self.service.resolve(
                contract_version="v1",
                forecast_id=forecast["forecast_id"],
                resolved_at=self.slot + timedelta(minutes=30),
                bars=bars,
            )

    def test_process_is_idempotent_and_resolves_due_forecasts(self) -> None:
        first_inputs = _inputs(self.slot)
        first_inputs["collected_at"] = first_inputs.pop("issued_at")
        first = self.service.process(**first_inputs)
        repeated = self.service.process(**first_inputs)

        later_inputs = _inputs(self.slot + timedelta(minutes=30))
        later_inputs["collected_at"] = later_inputs.pop("issued_at")
        later = self.service.process(**later_inputs)

        self.assertEqual(first["status"], "HEALTHY")
        self.assertEqual(first["issue_status"], "ISSUED")
        self.assertEqual(repeated["issue_status"], "ALREADY_ISSUED")
        self.assertEqual(
            later["resolved_forecast_ids"],
            [first["issued_forecast_id"]],
        )
        self.assertEqual(later["issue_status"], "ISSUED")
        self.assertNotIn("symbols", later)

    def test_existing_outcome_is_reported_after_process_retry(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        self.service.resolve(
            contract_version="v1",
            forecast_id=forecast["forecast_id"],
            resolved_at=self.slot + timedelta(minutes=30),
            bars={
                "SPY": _future(self.slot, [101, 102, 103, 104, 105, 106]),
                "QQQ": _future(self.slot, [201, 202, 203, 204, 205, 206]),
            },
        )

        retried = self.service.process(
            **_process_inputs(self.slot + timedelta(minutes=30))
        )

        self.assertEqual(
            retried["resolved_forecast_ids"],
            [forecast["forecast_id"]],
        )

    def test_session_inventory_accumulates_all_issued_and_resolved(self) -> None:
        first = self.service.process(**_process_inputs(self.slot))
        second = self.service.process(
            **_process_inputs(self.slot + timedelta(minutes=15))
        )
        third = self.service.process(
            **_process_inputs(self.slot + timedelta(minutes=30))
        )
        fourth = self.service.process(
            **_process_inputs(self.slot + timedelta(minutes=45))
        )
        issued_ids = [
            result["issued_forecast_id"]
            for result in (first, second, third, fourth)
        ]

        self.assertEqual(set(fourth), PUBLIC_PROOF_KEYS)
        self.assertEqual(fourth["session_date"], "2026-07-30")
        self.assertEqual(
            fourth["session_issued_forecast_ids"],
            issued_ids,
        )
        self.assertEqual(
            fourth["resolved_forecast_ids"],
            issued_ids[:2],
        )
        self.assertEqual(
            fourth["session_inventory_hash"],
            _expected_inventory_hash(
                self.root,
                "2026-07-30",
                issued_ids,
            ),
        )

    def test_deleting_complete_triplet_rolls_back_public_inventory(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        forecast_id = forecast["forecast_id"]
        self.service.resolve(
            contract_version="v1",
            forecast_id=forecast_id,
            resolved_at=self.slot + timedelta(minutes=30),
            bars={
                "SPY": _future(self.slot, [101] * 6),
                "QQQ": _future(self.slot, [201] * 6),
            },
        )
        before = self.service.session_inventory(
            self.slot + timedelta(minutes=30)
        )
        (self.root / "issuance_manifest" / f"{forecast_id}.json").unlink()
        (self.root / "forecasts" / f"{forecast_id}.json").unlink()
        (self.root / "outcomes" / f"{forecast_id}.json").unlink()

        after = self.service.session_inventory(
            self.slot + timedelta(minutes=45)
        )

        self.assertEqual(before["session_issued_forecast_ids"], [forecast_id])
        self.assertEqual(before["resolved_forecast_ids"], [forecast_id])
        self.assertEqual(after["session_issued_forecast_ids"], [])
        self.assertEqual(after["resolved_forecast_ids"], [])
        self.assertNotEqual(
            after["session_inventory_hash"],
            before["session_inventory_hash"],
        )

    def test_append_only_manifest_binds_each_issuance(self) -> None:
        first = self.service.issue(**_inputs(self.slot))
        first_path = (
            self.root
            / "issuance_manifest"
            / f"{first['forecast_id']}.json"
        )
        first_bytes = first_path.read_bytes()
        first_entry = json.loads(first_bytes)
        self.assertEqual(first_entry["contract_version"], "v1")
        self.assertEqual(first_entry["kind"], "ISSUANCE")
        self.assertEqual(first_entry["forecast_id"], first["forecast_id"])
        self.assertEqual(
            first_entry["forecast_path"],
            f"forecasts/{first['forecast_id']}.json",
        )
        self.assertEqual(first_entry["forecast_hash"], first["forecast_hash"])
        self.assertEqual(first_entry["slot_at"], first["slot_at"])

        second = self.service.issue(
            **_inputs(self.slot + timedelta(minutes=15))
        )

        self.assertEqual(first_path.read_bytes(), first_bytes)
        self.assertTrue(
            (
                self.root
                / "issuance_manifest"
                / f"{second['forecast_id']}.json"
            ).is_file()
        )

    def test_missing_manifest_or_forecast_artifacts_fail_closed(self) -> None:
        scenarios = ("manifest", "forecast", "forecast_and_outcome")
        for scenario in scenarios:
            with self.subTest(scenario=scenario), TemporaryDirectory() as folder:
                root = Path(folder)
                service = HalfHourForecastService(root)
                forecast = service.issue(**_inputs(self.slot))
                forecast_id = forecast["forecast_id"]
                if scenario == "forecast_and_outcome":
                    service.resolve(
                        contract_version="v1",
                        forecast_id=forecast_id,
                        resolved_at=self.slot + timedelta(minutes=30),
                        bars={
                            "SPY": _future(self.slot, [101] * 6),
                            "QQQ": _future(self.slot, [201] * 6),
                        },
                    )
                    (
                        root / "outcomes" / f"{forecast_id}.json"
                    ).unlink()
                target = (
                    root / "issuance_manifest" / f"{forecast_id}.json"
                    if scenario == "manifest"
                    else root / "forecasts" / f"{forecast_id}.json"
                )
                target.unlink()

                with self.assertRaisesRegex(
                    HalfHourForecastError,
                    "manifest.*forecast",
                ):
                    service.process(
                        **_process_inputs(
                            self.slot + timedelta(minutes=45)
                        )
                    )

    def test_orphan_outcome_and_wrong_filenames_fail_closed(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            service = HalfHourForecastService(root)
            forecast = service.issue(**_inputs(self.slot))
            service.resolve(
                contract_version="v1",
                forecast_id=forecast["forecast_id"],
                resolved_at=self.slot + timedelta(minutes=30),
                bars={
                    "SPY": _future(self.slot, [101] * 6),
                    "QQQ": _future(self.slot, [201] * 6),
                },
            )
            outcome = (
                root / "outcomes" / f"{forecast['forecast_id']}.json"
            )
            outcome.rename(root / "outcomes" / "hh-20260730T1500Z.json")
            with self.assertRaisesRegex(
                HalfHourForecastError,
                "孤儿outcome",
            ):
                service.process(
                    **_process_inputs(self.slot + timedelta(minutes=45))
                )

        with TemporaryDirectory() as folder:
            root = Path(folder)
            service = HalfHourForecastService(root)
            forecast = service.issue(**_inputs(self.slot))
            source = (
                root / "forecasts" / f"{forecast['forecast_id']}.json"
            )
            source.rename(root / "forecasts" / "renamed.json")
            with self.assertRaisesRegex(
                HalfHourForecastError,
                "unexpected forecast record",
            ):
                service.issue(
                    **_inputs(self.slot + timedelta(minutes=15))
                )

    def test_rehashed_semantic_forecast_tampering_fails_closed(self) -> None:
        changed_slot = (
            self.slot + timedelta(minutes=15)
        ).astimezone(UTC).isoformat()
        changed_target = (
            self.slot + timedelta(minutes=35)
        ).astimezone(UTC).isoformat()
        changed_bar_time = (
            self.slot - timedelta(minutes=10)
        ).astimezone(UTC).isoformat()
        cases: dict[str, Callable[[dict], None]] = {
            "forecast_id": lambda value: value.__setitem__(
                "forecast_id",
                "hh-20260730T1415Z",
            ),
            "slot": lambda value: value.__setitem__(
                "slot_at",
                changed_slot,
            ),
            "target_end": lambda value: value.__setitem__(
                "target_end_at",
                changed_target,
            ),
            "target_bars": lambda value: value[
                "target_bar_times"
            ].pop(),
            "cadence": lambda value: value.__setitem__(
                "cadence_minutes",
                30,
            ),
            "horizon": lambda value: value.__setitem__(
                "horizon_minutes",
                25,
            ),
            "symbols": lambda value: value["symbols"].pop("QQQ"),
            "anchor": lambda value: value["symbols"]["SPY"].__setitem__(
                "anchor_closed_price",
                0,
            ),
            "daily_atr": lambda value: value["symbols"]["SPY"].__setitem__(
                "daily_atr",
                6,
            ),
            "structure_hash": lambda value: value["symbols"][
                "SPY"
            ].__setitem__("structure_hash", "b" * 64),
            "history_hash": lambda value: value["symbols"]["SPY"].__setitem__(
                "history_bar_hash",
                "b" * 64,
            ),
            "pattern_forecast": lambda value: value["symbols"][
                "SPY"
            ].__setitem__("pattern_state", "TREND_DOWN"),
            "bar_time": lambda value: value["symbols"]["SPY"].__setitem__(
                "bar_data_time",
                changed_bar_time,
            ),
            "option_alignment": lambda value: value["symbols"]["SPY"][
                "option_proxy"
            ].__setitem__("alignment", "ALIGNED"),
            "option_ratio": lambda value: value["symbols"]["SPY"][
                "option_proxy"
            ].__setitem__("put_call_volume_ratio", 1.1),
            "option_hash": lambda value: value["symbols"]["SPY"][
                "option_proxy"
            ].__setitem__("snapshot_hash", "b" * 64),
            "input_hash": lambda value: value.__setitem__(
                "input_hash",
                "a" * 63,
            ),
            "unknown_field": lambda value: value.__setitem__(
                "legacy_bridge",
                True,
            ),
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                service = HalfHourForecastService(root)
                forecast = service.issue(**_inputs(self.slot))
                _rewrite_forecast_and_manifest(
                    root,
                    forecast["forecast_id"],
                    mutate,
                )
                with self.assertRaises(HalfHourForecastError):
                    service.process(
                        **_process_inputs(
                            self.slot + timedelta(minutes=15)
                        )
                    )

    def test_rehashed_manifest_and_outcome_tampering_fails_closed(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        forecast_id = forecast["forecast_id"]
        manifest_path = (
            self.root / "issuance_manifest" / f"{forecast_id}.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["forecast_path"] = "../forecasts/forged.json"
        manifest["manifest_hash"] = sha256_json(
            {
                key: value
                for key, value in manifest.items()
                if key != "manifest_hash"
            }
        )
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            HalfHourForecastError,
            "manifest semantics",
        ):
            self.service.process(
                **_process_inputs(self.slot + timedelta(minutes=15))
            )

        with TemporaryDirectory() as folder:
            root = Path(folder)
            service = HalfHourForecastService(root)
            forecast = service.issue(**_inputs(self.slot))
            service.resolve(
                contract_version="v1",
                forecast_id=forecast["forecast_id"],
                resolved_at=self.slot + timedelta(minutes=30),
                bars={
                    "SPY": _future(self.slot, [101] * 6),
                    "QQQ": _future(self.slot, [201] * 6),
                },
            )
            outcome_path = (
                root / "outcomes" / f"{forecast['forecast_id']}.json"
            )
            _rewrite_outcome(
                outcome_path,
                lambda value: value.__setitem__(
                    "resolved_at",
                    (
                        self.slot + timedelta(minutes=25)
                    ).astimezone(UTC).isoformat(),
                ),
            )
            with self.assertRaisesRegex(
                HalfHourForecastError,
                "outcome boundary",
            ):
                service.process(
                    **_process_inputs(self.slot + timedelta(minutes=45))
                )

    def test_rehashed_outcome_bar_and_metric_tampering_fails_closed(
        self,
    ) -> None:
        wrong_time = (
            self.slot - timedelta(minutes=5)
        ).astimezone(UTC).isoformat()
        cases: dict[str, Callable[[dict], None]] = {
            "bar_hash": lambda value: value["symbols"]["SPY"].__setitem__(
                "bar_hash",
                "b" * 64,
            ),
            "final_close": lambda value: value["symbols"]["SPY"].__setitem__(
                "final_close",
                999,
            ),
            "return_pct": lambda value: value["symbols"]["SPY"].__setitem__(
                "return_pct",
                999,
            ),
            "return_atr": lambda value: value["symbols"]["SPY"].__setitem__(
                "return_atr",
                999,
            ),
            "mfe_pct": lambda value: value["symbols"]["SPY"].__setitem__(
                "mfe_pct",
                999,
            ),
            "mfe_atr": lambda value: value["symbols"]["SPY"].__setitem__(
                "mfe_atr",
                999,
            ),
            "mae_pct": lambda value: value["symbols"]["SPY"].__setitem__(
                "mae_pct",
                -999,
            ),
            "mae_atr": lambda value: value["symbols"]["SPY"].__setitem__(
                "mae_atr",
                -999,
            ),
            "target_time": lambda value: value["symbols"]["SPY"][
                "target_bars"
            ][0].__setitem__("time", wrong_time),
            "target_close": lambda value: value["symbols"]["SPY"][
                "target_bars"
            ][-1].update(
                {
                    "open": 150.0,
                    "high": 151.0,
                    "low": 149.0,
                    "close": 150.0,
                }
            ),
            "missing_target_bar": lambda value: value["symbols"]["SPY"][
                "target_bars"
            ].pop(),
        }
        for label, mutate in cases.items():
            with self.subTest(label=label), TemporaryDirectory() as folder:
                root = Path(folder)
                service = HalfHourForecastService(root)
                forecast = service.issue(**_inputs(self.slot))
                service.resolve(
                    contract_version="v1",
                    forecast_id=forecast["forecast_id"],
                    resolved_at=self.slot + timedelta(minutes=30),
                    bars={
                        "SPY": _future(
                            self.slot,
                            [101, 99, 102, 98, 104, 103],
                        ),
                        "QQQ": _future(
                            self.slot,
                            [201, 199, 202, 198, 204, 203],
                        ),
                    },
                )
                outcome_path = (
                    root
                    / "outcomes"
                    / f"{forecast['forecast_id']}.json"
                )
                _rewrite_outcome(outcome_path, mutate)
                with self.assertRaises(HalfHourForecastError):
                    service.process(
                        **_process_inputs(
                            self.slot + timedelta(minutes=45)
                        )
                    )

    def test_previous_session_unresolved_forecast_remains_visible(self) -> None:
        first_inputs = _inputs(self.slot)
        first_inputs["collected_at"] = first_inputs.pop("issued_at")
        first = self.service.process(**first_inputs)

        next_inputs = _inputs(self.slot + timedelta(days=1))
        next_inputs["collected_at"] = next_inputs.pop("issued_at")
        next_day = self.service.process(**next_inputs)

        self.assertEqual(next_day["status"], "PENDING")
        self.assertEqual(
            next_day["pending_overdue_forecast_ids"],
            [first["issued_forecast_id"]],
        )

    def test_process_rejects_tampered_existing_outcome(self) -> None:
        first_inputs = _inputs(self.slot)
        first_inputs["collected_at"] = first_inputs.pop("issued_at")
        first = self.service.process(**first_inputs)
        later_inputs = _inputs(self.slot + timedelta(minutes=30))
        later_inputs["collected_at"] = later_inputs.pop("issued_at")
        self.service.process(**later_inputs)

        outcome_path = (
            self.root
            / "outcomes"
            / f"{first['issued_forecast_id']}.json"
        )
        outcome = json.loads(outcome_path.read_text(encoding="utf-8"))
        outcome["symbols"]["SPY"]["return_pct"] = 999
        outcome_path.write_text(json.dumps(outcome), encoding="utf-8")

        next_inputs = _inputs(self.slot + timedelta(minutes=45))
        next_inputs["collected_at"] = next_inputs.pop("issued_at")
        with self.assertRaisesRegex(HalfHourForecastError, "hash mismatch"):
            self.service.process(**next_inputs)

    def test_tampered_or_unknown_stored_forecast_is_rejected(self) -> None:
        forecast = self.service.issue(**_inputs(self.slot))
        path = self.root / "forecasts" / f"{forecast['forecast_id']}.json"
        stored = json.loads(path.read_text(encoding="utf-8"))
        stored["contract_version"] = "v2"
        path.write_text(json.dumps(stored), encoding="utf-8")
        with self.assertRaisesRegex(HalfHourForecastError, "未知"):
            self.service.resolve(
                contract_version="v1",
                forecast_id=forecast["forecast_id"],
                resolved_at=self.slot + timedelta(minutes=30),
                bars={
                    "SPY": _future(self.slot, [101] * 6),
                    "QQQ": _future(self.slot, [201] * 6),
                },
            )


if __name__ == "__main__":
    unittest.main()
