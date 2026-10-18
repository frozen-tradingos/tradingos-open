from __future__ import annotations

import json
import unittest
from unittest import mock
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from trading_os_v2.a1.history_archive import (
    HistoryArchiveError,
    MarketHistoryArchive,
    backfill_tradier_timesales,
    run_configured_history_archive,
)


def _bar(
    minute: int,
    *,
    day: int = 29,
    close: float = 500.25,
    volume: int = 100,
) -> dict:
    start = datetime(2026, 7, day, 13, 30, tzinfo=UTC) + timedelta(
        minutes=minute
    )
    return {
        "timestamp": int(start.timestamp()),
        "time": start.isoformat(),
        "open": 500,
        "high": max(500.5, close),
        "low": min(499.5, close),
        "close": close,
        "volume": volume,
    }


def _session_bars(
    *,
    day: int = 29,
    revised_second_close: float | None = None,
) -> list[dict]:
    rows = [_bar(index * 5, day=day) for index in range(78)]
    if revised_second_close is not None:
        rows[1] = _bar(
            5,
            day=day,
            close=revised_second_close,
        )
    return rows


class MarketHistoryArchiveTests(unittest.TestCase):
    def test_configured_runner_persists_latest_result_under_data_root(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            config = {
                "data": {
                    "contract_version": "v1",
                    "storage_root": str(root),
                    "contains_secrets": False,
                    "history": {
                        "provider": "tradier",
                        "symbols": ["SPY", "QQQ"],
                        "interval": "5min",
                        "session_filter": "open",
                        "lookback_days": 40,
                    },
                }
            }
            expected = {"contract_version": "v1", "status": "COMPLETED"}
            with mock.patch(
                "trading_os_v2.a1.history_archive.backfill_tradier_timesales",
                return_value=expected,
            ) as backfill:
                result = run_configured_history_archive(
                    config,
                    as_of=datetime(2026, 7, 30, 21, tzinfo=UTC),
                )

            persisted = json.loads(
                (root / "state" / "latest-history-run.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(result, expected)
        self.assertEqual(persisted, expected)
        self.assertEqual(backfill.call_args.kwargs["lookback_days"], 40)

    def test_configured_runner_rejects_unknown_contract(self) -> None:
        with self.assertRaisesRegex(
            HistoryArchiveError,
            "Invalid configured market-history contract",
        ):
            run_configured_history_archive(
                {"data": {"contract_version": "v2"}},
                as_of=datetime(2026, 7, 30, 21, tzinfo=UTC),
            )

    def test_backfill_requests_open_session_and_writes_no_secret(self) -> None:
        calls: list[tuple[str, dict, str]] = []

        def fetcher(path: str, params: dict, label: str) -> dict:
            calls.append((path, params, label))
            return {"series": {"data": _session_bars(day=30)}}

        with TemporaryDirectory() as folder:
            root = Path(folder)
            result = backfill_tradier_timesales(
                fetcher,
                root,
                as_of=datetime(2026, 7, 30, 21, tzinfo=UTC),
            )
            manifest_text = (
                root / "manifests" / "market-history-v1.json"
            ).read_text(encoding="utf-8")

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual([call[1]["symbol"] for call in calls], ["QQQ", "SPY"])
        self.assertTrue(all(call[1]["interval"] == "5min" for call in calls))
        self.assertTrue(all(call[1]["session_filter"] == "open" for call in calls))
        self.assertNotIn("token", manifest_text.lower())
        self.assertNotIn("authorization", manifest_text.lower())

    def test_backfill_failure_keeps_previous_manifest_byte_for_byte(self) -> None:
        for failing_symbol in ("SPY", "QQQ"):
            with self.subTest(failing_symbol=failing_symbol):
                with TemporaryDirectory() as folder:
                    root = Path(folder)
                    archive = MarketHistoryArchive(root)
                    archive.archive_batch(
                        {
                            "SPY": _session_bars(day=29),
                            "QQQ": _session_bars(day=29),
                        },
                        retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
                    )
                    before = archive.manifest_path.read_bytes()

                    def fetcher(path: str, params: dict, label: str) -> dict:
                        del path, label
                        rows = _session_bars(day=30)
                        if params["symbol"] == failing_symbol:
                            rows = rows[:-1]
                        return {"series": {"data": rows}}

                    with self.assertRaisesRegex(
                        HistoryArchiveError,
                        "complete regular session",
                    ):
                        backfill_tradier_timesales(
                            fetcher,
                            root,
                            as_of=datetime(2026, 7, 30, 21, tzinfo=UTC),
                        )

                    self.assertEqual(
                        archive.manifest_path.read_bytes(),
                        before,
                    )
                    self.assertFalse(
                        (
                            root
                            / "market"
                            / "tradier"
                            / "5min"
                            / "SPY"
                            / "2026-07-30"
                        ).exists()
                    )
                    self.assertFalse(
                        (
                            root
                            / "market"
                            / "tradier"
                            / "5min"
                            / "QQQ"
                            / "2026-07-30"
                        ).exists()
                    )

    def test_batch_publishes_once_and_snapshot_loads_original_revisions(
        self,
    ) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive = MarketHistoryArchive(root)
            with mock.patch.object(
                archive,
                "_write_manifest",
                wraps=archive._write_manifest,
            ) as publish:
                archived, first_snapshot = archive.archive_batch(
                    {
                        "SPY": _session_bars(day=29),
                        "QQQ": _session_bars(day=29),
                    },
                    retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
                    required_session_date=date(2026, 7, 29),
                )

            self.assertEqual(publish.call_count, 1)
            self.assertEqual(set(archived), {"SPY", "QQQ"})
            first_hash = first_snapshot["manifest_hash"]
            archive.archive_batch(
                {
                    "SPY": _session_bars(
                        day=29,
                        revised_second_close=500.4,
                    ),
                    "QQQ": _session_bars(
                        day=29,
                        revised_second_close=500.4,
                    ),
                },
                retrieved_at=datetime(2026, 7, 30, 22, tzinfo=UTC),
            )

            original = archive.load_dataset(
                symbols=("SPY",),
                manifest_snapshot=first_snapshot,
            )
            current = archive.load_dataset(symbols=("SPY",))

            self.assertEqual(original["records"][1]["close"], 500.25)
            self.assertEqual(current["records"][1]["close"], 500.4)
            self.assertEqual(
                archive.validate_manifest_snapshot(
                    first_snapshot,
                    expected_hash=first_hash,
                ),
                first_snapshot,
            )
            with self.assertRaisesRegex(
                HistoryArchiveError,
                "snapshot mismatch",
            ):
                archive.load_manifest(expected_hash=first_hash)

    def test_archive_is_idempotent_and_keeps_provider_revisions(self) -> None:
        with TemporaryDirectory() as folder:
            archive = MarketHistoryArchive(Path(folder))
            first = archive.archive_rows(
                "SPY",
                _session_bars(),
                retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
            )
            repeated = archive.archive_rows(
                "SPY",
                _session_bars(),
                retrieved_at=datetime(2026, 7, 30, 21, 30, tzinfo=UTC),
            )
            revised = archive.archive_rows(
                "SPY",
                _session_bars(revised_second_close=500.3),
                retrieved_at=datetime(2026, 7, 30, 22, tzinfo=UTC),
            )
            manifest = archive.load_manifest()

            hashes = manifest["sessions"]["SPY"]["2026-07-29"]["revisions"]
            revision_files = list(
                (
                    Path(folder)
                    / "market"
                    / "tradier"
                    / "5min"
                    / "SPY"
                    / "2026-07-29"
                ).glob("*.json")
            )

        self.assertEqual(
            first["sessions"][0]["data_hash"],
            repeated["sessions"][0]["data_hash"],
        )
        self.assertNotEqual(
            first["sessions"][0]["data_hash"],
            revised["sessions"][0]["data_hash"],
        )
        self.assertEqual(len(hashes), 2)
        self.assertEqual(len(revision_files), 2)

    def test_dataset_uses_active_revision_and_verifies_hash(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive = MarketHistoryArchive(root)
            archive.archive_rows(
                "SPY",
                _session_bars(),
                retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
            )
            latest = archive.archive_rows(
                "SPY",
                _session_bars(revised_second_close=500.4),
                retrieved_at=datetime(2026, 7, 30, 22, tzinfo=UTC),
            )
            dataset = archive.load_dataset(
                symbols=("SPY",),
                start_date=date(2026, 7, 29),
                end_date=date(2026, 7, 29),
            )

            active_path = Path(latest["sessions"][0]["path"])
            corrupted = json.loads(active_path.read_text(encoding="utf-8"))
            corrupted["bars"][0]["close"] = 1
            active_path.write_text(json.dumps(corrupted), encoding="utf-8")

            with self.assertRaisesRegex(HistoryArchiveError, "hash mismatch"):
                archive.load_dataset(symbols=("SPY",))

        self.assertEqual(dataset["records"][1]["close"], 500.4)
        self.assertEqual(dataset["records"][1]["symbol"], "SPY")
        self.assertEqual(dataset["symbols"], ["SPY"])
        self.assertEqual(len(dataset["source_hashes"]), 1)
        self.assertEqual(len(dataset["data_hash"]), 64)

    def test_partial_current_bar_is_not_archived(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive = MarketHistoryArchive(root)
            with self.assertRaisesRegex(
                HistoryArchiveError,
                "complete regular session",
            ):
                archive.archive_rows(
                    "QQQ",
                    [_bar(0, day=30), _bar(5, day=30)],
                    retrieved_at=datetime(
                        2026,
                        7,
                        30,
                        13,
                        35,
                        20,
                        tzinfo=UTC,
                    ),
                )

            self.assertFalse(archive.manifest_path.exists())
            self.assertFalse((root / "market").exists())

    def test_partial_revision_cannot_replace_complete_active_data(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive = MarketHistoryArchive(root)
            complete = archive.archive_rows(
                "SPY",
                _session_bars(),
                retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
            )
            manifest_before = archive.load_manifest()

            with self.assertRaisesRegex(
                HistoryArchiveError,
                "complete regular session",
            ):
                archive.archive_rows(
                    "SPY",
                    _session_bars()[:-1],
                    retrieved_at=datetime(2026, 7, 30, 22, tzinfo=UTC),
                )

            manifest_after = archive.load_manifest()
            revisions = list(
                (
                    root
                    / "market"
                    / "tradier"
                    / "5min"
                    / "SPY"
                    / "2026-07-29"
                ).glob("*.json")
            )

        self.assertEqual(manifest_after, manifest_before)
        self.assertEqual(len(revisions), 1)
        self.assertEqual(
            manifest_after["sessions"]["SPY"]["2026-07-29"][
                "active_hash"
            ],
            complete["sessions"][0]["data_hash"],
        )

    def test_invalid_ohlc_duplicate_and_contract_fail_closed(self) -> None:
        invalid = _bar(0)
        invalid["high"] = 499
        duplicate = _bar(0)
        conflicting = _bar(0, close=501)
        with TemporaryDirectory() as folder:
            root = Path(folder)
            archive = MarketHistoryArchive(root)
            with self.assertRaisesRegex(HistoryArchiveError, "OHLC"):
                archive.archive_rows(
                    "SPY",
                    [invalid],
                    retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
                )
            with self.assertRaisesRegex(HistoryArchiveError, "Conflicting duplicate"):
                archive.archive_rows(
                    "SPY",
                    [duplicate, conflicting],
                    retrieved_at=datetime(2026, 7, 30, 21, tzinfo=UTC),
                )
            with self.assertRaisesRegex(HistoryArchiveError, "Unknown"):
                MarketHistoryArchive(root, contract_version="v2")


if __name__ == "__main__":
    unittest.main()
