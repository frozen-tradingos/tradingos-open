from __future__ import annotations

import json
import math
import os
import tempfile
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import canonical_json, iso_now, read_json, sha256_json
from trading_os_v2.common.lock import ProcessLock


CONTRACT_VERSION = "v1"
SOURCE = "tradier"
INTERVAL = "5min"
SESSION_FILTER = "open"
ALLOWED_SYMBOLS = {"SPY", "QQQ"}
ET_ZONE = ZoneInfo("America/New_York")
BAR_INTERVAL = timedelta(minutes=5)
FINALITY_LAG = timedelta(seconds=30)


class HistoryArchiveError(RuntimeError):
    pass


def run_configured_history_archive(
    config: dict[str, Any],
    *,
    as_of: datetime,
) -> dict[str, Any]:
    data = config.get("data")
    history = data.get("history") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("contract_version") != CONTRACT_VERSION
        or data.get("contains_secrets") is not False
        or not isinstance(data.get("storage_root"), str)
        or not isinstance(history, dict)
        or history.get("provider") != SOURCE
        or history.get("symbols") != ["SPY", "QQQ"]
        or history.get("interval") != INTERVAL
        or history.get("session_filter") != SESSION_FILTER
        or history.get("lookback_days") != 40
    ):
        raise HistoryArchiveError("Invalid configured market-history contract")

    from trading_os_v2.a1.service import A1Collector

    root = Path(data["storage_root"])
    with ProcessLock(root / "locks" / "history-archive.lock"):
        result = backfill_tradier_timesales(
            A1Collector(config)._tradier,
            root,
            as_of=as_of,
            lookback_days=history["lookback_days"],
        )
        _atomic_write_json(root / "state" / "latest-history-run.json", result)
    return result


def backfill_tradier_timesales(
    fetcher: Callable[[str, dict[str, Any], str], Any],
    root: Path,
    *,
    as_of: datetime,
    lookback_days: int = 40,
) -> dict[str, Any]:
    if as_of.tzinfo is None:
        raise HistoryArchiveError("History backfill requires an aware as_of time")
    if not 1 <= lookback_days <= 40:
        raise HistoryArchiveError("Tradier 5min open-session lookback must be 1-40 days")

    current_et = as_of.astimezone(ET_ZONE)
    last_session_date = (
        current_et.date()
        if current_et.timetz().replace(tzinfo=None) >= time(16, 0)
        else current_et.date() - timedelta(days=1)
    )
    start_date = current_et.date() - timedelta(days=lookback_days - 1)
    archive = MarketHistoryArchive(root)
    fetched_rows: dict[str, list[Any]] = {}
    for symbol in sorted(ALLOWED_SYMBOLS):
        payload = fetcher(
            "/markets/timesales",
            {
                "symbol": symbol,
                "interval": INTERVAL,
                "start": f"{start_date.isoformat()} 09:30",
                "end": f"{last_session_date.isoformat()} 16:00",
                "session_filter": SESSION_FILTER,
            },
            f"Tradier {symbol} historical 5min timesales",
        )
        fetched_rows[symbol] = _as_list(
            (payload or {}).get("series", {}).get("data")
        )

    archived, manifest = archive.archive_batch(
        fetched_rows,
        retrieved_at=as_of,
        required_session_date=last_session_date,
    )
    return {
        "contract_version": CONTRACT_VERSION,
        "status": "COMPLETED",
        "source": SOURCE,
        "interval": INTERVAL,
        "session_filter": SESSION_FILTER,
        "lookback_days": lookback_days,
        "requested_start_date": start_date.isoformat(),
        "requested_end_date": last_session_date.isoformat(),
        "symbols": archived,
        "manifest_hash": manifest["manifest_hash"],
        "completed_at": iso_now(),
    }


class MarketHistoryArchive:
    def __init__(self, root: Path, *, contract_version: str = CONTRACT_VERSION):
        if contract_version != CONTRACT_VERSION:
            raise HistoryArchiveError("Unknown market-history contract version")
        self.root = root
        self.manifest_path = root / "manifests" / "market-history-v1.json"

    def archive_rows(
        self,
        symbol: str,
        rows: Iterable[dict[str, Any]],
        *,
        retrieved_at: datetime,
    ) -> dict[str, Any]:
        if symbol not in ALLOWED_SYMBOLS:
            raise HistoryArchiveError(f"Unsupported history symbol: {symbol}")
        if retrieved_at.tzinfo is None:
            raise HistoryArchiveError("History archive requires an aware retrieval time")

        grouped = _normalize_rows(rows, retrieved_at=retrieved_at)
        _require_complete_regular_sessions(grouped)
        archived, _ = self._publish_grouped(
            {symbol: grouped},
            retrieved_at=retrieved_at,
        )
        return archived[symbol]

    def archive_batch(
        self,
        rows_by_symbol: dict[str, Iterable[dict[str, Any]]],
        *,
        retrieved_at: datetime,
        required_session_date: date | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if set(rows_by_symbol) != ALLOWED_SYMBOLS:
            raise HistoryArchiveError(
                "Atomic history archive requires exactly SPY and QQQ"
            )
        if retrieved_at.tzinfo is None:
            raise HistoryArchiveError("History archive requires an aware retrieval time")

        grouped_by_symbol: dict[str, dict[str, list[dict[str, Any]]]] = {}
        required_date = (
            required_session_date.isoformat()
            if required_session_date is not None
            else ""
        )
        for symbol in sorted(ALLOWED_SYMBOLS):
            grouped = _normalize_rows(
                rows_by_symbol[symbol],
                retrieved_at=retrieved_at,
            )
            _require_complete_regular_sessions(grouped)
            if not grouped:
                raise HistoryArchiveError(
                    f"{symbol} history contains no complete regular session"
                )
            if required_date and required_date not in grouped:
                raise HistoryArchiveError(
                    f"{symbol} history is missing required session {required_date}"
                )
            grouped_by_symbol[symbol] = grouped

        return self._publish_grouped(
            grouped_by_symbol,
            retrieved_at=retrieved_at,
        )

    def _publish_grouped(
        self,
        grouped_by_symbol: dict[str, dict[str, list[dict[str, Any]]]],
        *,
        retrieved_at: datetime,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        manifest = self.load_manifest()
        archived: dict[str, Any] = {}
        for symbol, grouped in sorted(grouped_by_symbol.items()):
            symbol_sessions = manifest["sessions"].setdefault(symbol, {})
            results: list[dict[str, Any]] = []
            for session_date, bars in sorted(grouped.items()):
                body = {
                    "contract_version": CONTRACT_VERSION,
                    "source": SOURCE,
                    "interval": INTERVAL,
                    "session_filter": SESSION_FILTER,
                    "symbol": symbol,
                    "session_date": session_date,
                    "bars": bars,
                }
                data_hash = sha256_json(body)
                payload = {**body, "data_hash": data_hash}
                target = self._revision_path(symbol, session_date, data_hash)
                _write_once_json(target, payload)

                entry = symbol_sessions.setdefault(
                    session_date,
                    {"active_hash": data_hash, "revisions": []},
                )
                revisions = entry.setdefault("revisions", [])
                if data_hash not in revisions:
                    revisions.append(data_hash)
                entry["active_hash"] = data_hash
                entry["last_retrieved_at"] = (
                    retrieved_at.astimezone(UTC).isoformat()
                )
                results.append(
                    {
                        "session_date": session_date,
                        "bar_count": len(bars),
                        "data_hash": data_hash,
                        "path": str(target),
                    }
                )
            archived[symbol] = {
                "status": "ARCHIVED" if results else "NO_COMPLETE_SESSIONS",
                "session_count": len(results),
                "sessions": results,
            }

        manifest["updated_at"] = retrieved_at.astimezone(UTC).isoformat()
        published = self._write_manifest(manifest)
        return archived, published

    def load_manifest(
        self,
        *,
        expected_hash: str | None = None,
    ) -> dict[str, Any]:
        manifest = read_json(self.manifest_path, None)
        if manifest is None:
            base = {
                "contract_version": CONTRACT_VERSION,
                "source": SOURCE,
                "interval": INTERVAL,
                "session_filter": SESSION_FILTER,
                "updated_at": "",
                "sessions": {symbol: {} for symbol in sorted(ALLOWED_SYMBOLS)},
            }
            manifest = {**base, "manifest_hash": sha256_json(base)}
        return self.validate_manifest_snapshot(
            manifest,
            expected_hash=expected_hash,
        )

    def validate_manifest_snapshot(
        self,
        manifest: Any,
        *,
        expected_hash: str | None = None,
    ) -> dict[str, Any]:
        if (
            not isinstance(manifest, dict)
            or manifest.get("contract_version") != CONTRACT_VERSION
            or manifest.get("source") != SOURCE
            or manifest.get("interval") != INTERVAL
            or manifest.get("session_filter") != SESSION_FILTER
            or not isinstance(manifest.get("sessions"), dict)
        ):
            raise HistoryArchiveError("Invalid market-history manifest")
        stored_hash = manifest.get("manifest_hash")
        body = {key: value for key, value in manifest.items() if key != "manifest_hash"}
        if stored_hash != sha256_json(body):
            raise HistoryArchiveError("Market-history manifest hash mismatch")
        if expected_hash is not None and stored_hash != expected_hash:
            raise HistoryArchiveError("Market-history manifest snapshot mismatch")
        return manifest

    def load_dataset(
        self,
        *,
        symbols: Iterable[str] = ("SPY", "QQQ"),
        start_date: date | None = None,
        end_date: date | None = None,
        manifest_snapshot: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        selected = tuple(sorted(set(symbols)))
        if not selected or any(symbol not in ALLOWED_SYMBOLS for symbol in selected):
            raise HistoryArchiveError("Dataset symbols must be SPY and/or QQQ")
        if start_date and end_date and start_date > end_date:
            raise HistoryArchiveError("Dataset start_date is after end_date")

        manifest = (
            self.load_manifest()
            if manifest_snapshot is None
            else self.validate_manifest_snapshot(manifest_snapshot)
        )
        records: list[dict[str, Any]] = []
        source_hashes: list[str] = []
        for symbol in selected:
            sessions = manifest["sessions"].get(symbol, {})
            if not isinstance(sessions, dict):
                raise HistoryArchiveError("Invalid symbol sessions in history manifest")
            for session_text, entry in sorted(sessions.items()):
                session_date = date.fromisoformat(session_text)
                if start_date and session_date < start_date:
                    continue
                if end_date and session_date > end_date:
                    continue
                if not isinstance(entry, dict) or not entry.get("active_hash"):
                    raise HistoryArchiveError("Invalid active market-history revision")
                data_hash = str(entry["active_hash"])
                payload = read_json(
                    self._revision_path(symbol, session_text, data_hash),
                    None,
                )
                _validate_revision(payload, symbol, session_text, data_hash)
                source_hashes.append(data_hash)
                records.extend(
                    {"symbol": symbol, **bar}
                    for bar in payload["bars"]
                )

        body = {
            "contract_version": CONTRACT_VERSION,
            "source": SOURCE,
            "interval": INTERVAL,
            "symbols": list(selected),
            "start_date": start_date.isoformat() if start_date else "",
            "end_date": end_date.isoformat() if end_date else "",
            "source_hashes": source_hashes,
            "records": records,
        }
        return {**body, "data_hash": sha256_json(body)}

    def _revision_path(self, symbol: str, session_date: str, data_hash: str) -> Path:
        return (
            self.root
            / "market"
            / SOURCE
            / INTERVAL
            / symbol
            / session_date
            / f"{data_hash}.json"
        )

    def _write_manifest(self, manifest: dict[str, Any]) -> dict[str, Any]:
        body = {key: value for key, value in manifest.items() if key != "manifest_hash"}
        payload = {**body, "manifest_hash": sha256_json(body)}
        _atomic_write_json(self.manifest_path, payload)
        return payload


def _normalize_rows(
    rows: Iterable[dict[str, Any]],
    *,
    retrieved_at: datetime,
) -> dict[str, list[dict[str, Any]]]:
    retrieved_utc = retrieved_at.astimezone(UTC)
    parsed: list[tuple[datetime, dict[str, Any]]] = []
    for row in rows:
        if not isinstance(row, dict):
            raise HistoryArchiveError("Tradier history row is not an object")
        start_at = _bar_start(row)
        if start_at > retrieved_utc:
            raise HistoryArchiveError("Tradier history contains a future bar")
        parsed.append((start_at, row))
    latest_start = max((start_at for start_at, _ in parsed), default=None)

    by_time: dict[datetime, dict[str, Any]] = {}
    for start_at, row in parsed:
        local = start_at.astimezone(ET_ZONE)
        if local.second or local.microsecond or local.minute % 5:
            raise HistoryArchiveError("Tradier history bar is not aligned to 5 minutes")
        if not time(9, 30) <= local.timetz().replace(tzinfo=None) < time(16, 0):
            raise HistoryArchiveError("Tradier history contains an out-of-session bar")
        has_later_bar = latest_start is not None and start_at < latest_start
        if not has_later_bar and start_at + BAR_INTERVAL + FINALITY_LAG > retrieved_utc:
            continue
        bar = _normalized_bar(row, start_at)
        previous = by_time.get(start_at)
        if previous is not None and previous != bar:
            raise HistoryArchiveError("Conflicting duplicate Tradier history bar")
        by_time[start_at] = bar

    grouped: dict[str, list[dict[str, Any]]] = {}
    for start_at, bar in sorted(by_time.items()):
        session_date = start_at.astimezone(ET_ZONE).date().isoformat()
        grouped.setdefault(session_date, []).append(bar)
    return grouped


def _require_complete_regular_sessions(
    grouped: dict[str, list[dict[str, Any]]],
) -> None:
    for session_date, bars in grouped.items():
        session = date.fromisoformat(session_date)
        expected = [
            datetime.combine(session, time(9, 30), ET_ZONE)
            .astimezone(UTC)
            + index * BAR_INTERVAL
            for index in range(78)
        ]
        observed = [
            datetime.fromisoformat(str(bar["start_at"])).astimezone(UTC)
            for bar in bars
        ]
        if observed != expected:
            raise HistoryArchiveError(
                f"{session_date} is not a complete regular session"
            )


def _bar_start(row: dict[str, Any]) -> datetime:
    timestamp = _finite_number(row.get("timestamp"), "timestamp")
    if timestamp <= 0:
        raise HistoryArchiveError("Tradier history timestamp must be positive")
    try:
        return datetime.fromtimestamp(timestamp, UTC)
    except (OSError, OverflowError, ValueError) as exc:
        raise HistoryArchiveError("Tradier history timestamp is invalid") from exc


def _normalized_bar(row: dict[str, Any], start_at: datetime) -> dict[str, Any]:
    opening = _finite_number(row.get("open"), "open")
    high = _finite_number(row.get("high"), "high")
    low = _finite_number(row.get("low"), "low")
    close = _finite_number(row.get("close"), "close")
    volume = _finite_number(row.get("volume"), "volume")
    if min(opening, high, low, close) <= 0:
        raise HistoryArchiveError("Tradier history prices must be positive")
    if high < max(opening, close, low) or low > min(opening, close, high):
        raise HistoryArchiveError("Tradier history OHLC values are inconsistent")
    if volume < 0 or not volume.is_integer():
        raise HistoryArchiveError("Tradier history volume must be a non-negative integer")
    return {
        "start_at": start_at.isoformat(),
        "session_date": start_at.astimezone(ET_ZONE).date().isoformat(),
        "open": opening,
        "high": high,
        "low": low,
        "close": close,
        "volume": int(volume),
    }


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise HistoryArchiveError(f"Tradier history {field} is invalid")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise HistoryArchiveError(f"Tradier history {field} is invalid") from exc
    if not math.isfinite(number):
        raise HistoryArchiveError(f"Tradier history {field} is not finite")
    return number


def _validate_revision(
    payload: Any,
    symbol: str,
    session_date: str,
    data_hash: str,
) -> None:
    if (
        not isinstance(payload, dict)
        or payload.get("contract_version") != CONTRACT_VERSION
        or payload.get("source") != SOURCE
        or payload.get("interval") != INTERVAL
        or payload.get("session_filter") != SESSION_FILTER
        or payload.get("symbol") != symbol
        or payload.get("session_date") != session_date
        or payload.get("data_hash") != data_hash
        or not isinstance(payload.get("bars"), list)
    ):
        raise HistoryArchiveError("Invalid market-history revision")
    body = {key: value for key, value in payload.items() if key != "data_hash"}
    if sha256_json(body) != data_hash:
        raise HistoryArchiveError("Market-history revision hash mismatch")


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _write_once_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if read_json(path, None) != value:
            raise HistoryArchiveError(f"Refusing to overwrite history revision: {path}")
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
        try:
            os.link(temporary, path)
        except FileExistsError:
            if read_json(path, None) != value:
                raise HistoryArchiveError(
                    f"Conflicting history revision already exists: {path}"
                )
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
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
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
