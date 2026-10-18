from __future__ import annotations

from copy import deepcopy
from datetime import UTC, date, datetime
import math
from pathlib import Path
import re
from threading import Lock
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.acceptance.service import record_event
from trading_os_v2.common.config import runtime_path
from trading_os_v2.common.io import atomic_write_json, read_json, sha256_json
from trading_os_v2.common.lock import AlreadyRunning, ProcessLock
from trading_os_v2.discord_gateway.service import DiscordGateway


_MONITOR_PRIVATE_KEY = "_position_monitor_v1"
_OWNER_FACT_FIELDS = (
    "position_id",
    "underlying",
    "option_side",
    "expiration",
    "strike",
    "quantity",
    "actual_fill_price",
    "cumulative_cost_usd",
    "status",
)
_OWNER_SYNC_KEYS = {
    "contract_version",
    "initialized",
    "last_message_id",
    "outcomes",
}
_OUTCOME_KEYS = {
    "status",
    "summary",
    "received_at",
    "audit_recorded",
    "reply_marker",
    "reply_message_id",
}
_POSITION_STORE_KEYS = {
    "contract_version",
    "updated_at",
    "positions",
    "owner_sync",
}
_DISCORD_HISTORY_MAX_PAGES = 100
# ponytail: one A1-wide lock is enough for at most three phase-1 positions.
_POSITION_STATE_THREAD_LOCK = Lock()


class PositionStateLock:
    def __init__(self, path: Path) -> None:
        self.process_lock = ProcessLock(path)
        self.thread_acquired = False

    def __enter__(self) -> "PositionStateLock":
        self.thread_acquired = _POSITION_STATE_THREAD_LOCK.acquire(blocking=False)
        if not self.thread_acquired:
            raise AlreadyRunning("Position state is already being updated")
        try:
            self.process_lock.__enter__()
        except BaseException:
            _POSITION_STATE_THREAD_LOCK.release()
            self.thread_acquired = False
            raise
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        try:
            self.process_lock.__exit__(exc_type, exc, traceback)
        finally:
            if self.thread_acquired:
                _POSITION_STATE_THREAD_LOCK.release()
                self.thread_acquired = False


def load_confirmed_positions() -> list[dict[str, Any]]:
    payload = _load_position_store(runtime_path("a1", "confirmed_positions.json"))
    public_positions: list[dict[str, Any]] = []
    for item in payload["positions"]:
        if item.get("status", "OPEN") != "OPEN":
            continue
        public = deepcopy(item)
        public.pop(_MONITOR_PRIVATE_KEY, None)
        public["position_snapshot_hash"] = position_snapshot_hash(public)
        public_positions.append(public)
    return public_positions


def position_snapshot_hash(position: dict[str, Any]) -> str:
    """Hash only owner-confirmed facts; never include quotes or monitor state."""
    try:
        snapshot = {name: position[name] for name in _OWNER_FACT_FIELDS}
    except KeyError as exc:
        raise RuntimeError(f"Position is missing owner fact: {exc.args[0]}") from exc
    return sha256_json(snapshot)


def sync_owner_commands(
    gateway: DiscordGateway,
    owner_user_id: str,
) -> dict[str, Any]:
    state_path = runtime_path("a1", "confirmed_positions.json")
    updated = 0
    processed = 0
    with position_state_lock(state_path):
        payload = _load_position_store(state_path)
        owner_sync = payload["owner_sync"]
        if not owner_sync["initialized"]:
            recent = gateway.messages("owner", limit=1)
            _require_discord_messages(recent, max_count=1)
            owner_sync["initialized"] = True
            owner_sync["last_message_id"] = max(
                (str(item["id"]) for item in recent),
                default="",
                key=_message_id_key,
            )
            payload["updated_at"] = datetime.now(UTC).isoformat()
            atomic_write_json(state_path, payload)
            return {"status": "INITIALIZED", "processed": 0, "updated": 0}

        messages = _owner_history(
            gateway,
            stop_after=owner_sync["last_message_id"],
        )
        for message in messages:
            message_id = str(message["id"])
            owner_sync["last_message_id"] = message_id
            author = message.get("author")
            if not isinstance(author, dict):
                raise RuntimeError("Discord owner message author is invalid")
            if str(author.get("id", "")) != owner_user_id:
                continue
            content = str(message.get("content", "")).strip()
            if not (
                content.startswith("【老板确认｜")
                or _looks_like_position_shorthand(content)
            ):
                continue
            if message_id in owner_sync["outcomes"]:
                continue
            processed += 1
            marker = f"[A1-POSITION:{message_id}]"
            try:
                summary = apply_owner_command(payload["positions"], content)
                status = "RECORDED"
                updated += 1
            except ValueError as exc:
                summary = str(exc)
                status = "FAULT"
            owner_sync["outcomes"][message_id] = {
                "status": status,
                "summary": summary,
                "received_at": datetime.now(UTC).isoformat(),
                "audit_recorded": False,
                "reply_marker": marker,
                "reply_message_id": "",
            }
        payload["updated_at"] = datetime.now(UTC).isoformat()
        atomic_write_json(state_path, payload)

    _record_pending_owner_audits(state_path)
    _deliver_pending_owner_replies(gateway, state_path)
    return {"status": "SYNCED", "processed": processed, "updated": updated}


def position_state_lock(path: Path | None = None) -> PositionStateLock:
    state_path = path or runtime_path("a1", "confirmed_positions.json")
    return PositionStateLock(state_path.with_name("position-state.lock"))


def _deliver_pending_owner_replies(
    gateway: DiscordGateway,
    state_path: Path,
) -> None:
    with position_state_lock(state_path):
        payload = _load_position_store(state_path)
        outcomes = payload["owner_sync"]["outcomes"]
        if not any(not outcome["reply_message_id"] for outcome in outcomes.values()):
            return
        bot_id = _current_discord_bot_id(gateway)
        history = _owner_history(gateway)
        used_reply_ids = {
            outcome["reply_message_id"]
            for outcome in outcomes.values()
            if outcome["reply_message_id"]
        }
        for outcome in outcomes.values():
            marker = outcome["reply_marker"]
            content = _owner_reply(outcome["status"], outcome["summary"], marker)
            reply_message_id = outcome["reply_message_id"]
            if reply_message_id:
                _verify_owner_reply(
                    gateway,
                    reply_message_id,
                    content,
                    bot_id,
                )
                continue
            reply_message_id = _find_owner_reply(
                history,
                marker,
                content,
                bot_id,
            )
            if not reply_message_id:
                reply_message_id = str(gateway.send("owner", content))
            if (
                not reply_message_id.isdigit()
                or reply_message_id in used_reply_ids
            ):
                raise RuntimeError(
                    "Discord owner reply must have a unique numeric message id"
                )
            _verify_owner_reply(
                gateway,
                reply_message_id,
                content,
                bot_id,
            )
            used_reply_ids.add(reply_message_id)
            outcome["reply_message_id"] = reply_message_id
            payload["updated_at"] = datetime.now(UTC).isoformat()
            atomic_write_json(state_path, payload)


def _record_pending_owner_audits(state_path: Path) -> None:
    with position_state_lock(state_path):
        payload = _load_position_store(state_path)
        pending = [
            (message_id, outcome)
            for message_id, outcome in payload["owner_sync"]["outcomes"].items()
            if not outcome["audit_recorded"]
        ]
        for message_id, outcome in pending:
            record_event(
                (
                    "POSITION_CHANGE"
                    if outcome["status"] == "RECORDED"
                    else "POSITION_COMMAND_REJECTED"
                ),
                outcome["status"],
                slot=message_id,
                details={
                    "summary": outcome["summary"],
                    "discord_message_id": message_id,
                    "source": "老板人工确认",
                    "automatic_order": False,
                },
                when=datetime.fromisoformat(outcome["received_at"]),
            )
            outcome["audit_recorded"] = True
        if pending:
            payload["updated_at"] = datetime.now(UTC).isoformat()
            atomic_write_json(state_path, payload)


def _owner_reply(status: str, summary: str, marker: str) -> str:
    if status == "RECORDED":
        return (
            "【员工：A1｜持仓状态】\n"
            f"老板确认已登记：{summary}\n"
            "状态：已更新｜不会自动下单\n"
            f"{marker}"
        )
    return (
        "【员工：A1｜信息补齐请求】\n"
        f"这条持仓确认暂未登记：{summary}\n"
        "请按置顶的老板持仓确认模板补齐。\n"
        f"{marker}"
    )


def _owner_history(
    gateway: DiscordGateway,
    *,
    stop_after: str = "",
) -> list[dict[str, Any]]:
    if stop_after and not stop_after.isdigit():
        raise RuntimeError("Discord owner cursor must be numeric")
    cursor = int(stop_after) if stop_after else None
    before = ""
    seen_ids: set[str] = set()
    messages: list[dict[str, Any]] = []
    completed = False
    for _ in range(_DISCORD_HISTORY_MAX_PAGES):
        page = gateway.messages("owner", before=before, limit=100)
        identifiers = _require_discord_messages(page)
        if seen_ids.intersection(identifiers):
            raise RuntimeError("Discord owner history contains duplicate message ids")
        seen_ids.update(identifiers)
        messages.extend(
            item
            for item in page
            if cursor is None or int(str(item["id"])) > cursor
        )
        if (
            not page
            or len(page) < 100
            or (
                cursor is not None
                and any(int(identifier) <= cursor for identifier in identifiers)
            )
        ):
            completed = True
            break
        next_before = str(min(int(identifier) for identifier in identifiers))
        if before and int(next_before) >= int(before):
            raise RuntimeError(
                "Discord owner history pagination did not move backward"
            )
        before = next_before
    if not completed:
        raise RuntimeError(
            "Discord owner history exceeds the safe pagination window"
        )
    return sorted(
        messages,
        key=lambda item: _message_id_key(str(item["id"])),
    )


def _require_discord_messages(
    messages: Any,
    *,
    max_count: int = 100,
) -> list[str]:
    if not isinstance(messages, list):
        raise RuntimeError("Discord owner history must be a list")
    if len(messages) > max_count:
        raise RuntimeError("Discord owner history page exceeds its requested limit")
    identifiers: list[str] = []
    for item in messages:
        if not isinstance(item, dict):
            raise RuntimeError("Discord owner history contains an invalid message")
        identifier = str(item.get("id", ""))
        if not identifier.isdigit():
            raise RuntimeError(
                "Discord owner history requires numeric message ids"
            )
        identifiers.append(identifier)
    if len(identifiers) != len(set(identifiers)):
        raise RuntimeError("Discord owner history contains duplicate message ids")
    return identifiers


def _find_owner_reply(
    history: list[dict[str, Any]],
    marker: str,
    content: str,
    bot_id: str,
) -> str:
    marker_matches = [
        item
        for item in history
        if _is_current_discord_bot(item, bot_id)
        if marker in str(item.get("content", ""))
    ]
    exact_matches = [
        item
        for item in marker_matches
        if str(item.get("content", "")) == content
    ]
    if len(marker_matches) != len(exact_matches):
        raise RuntimeError(
            "Discord owner reply marker content does not match the ledger"
        )
    if len(exact_matches) > 1:
        raise RuntimeError("Discord owner reply marker is duplicated")
    return str(exact_matches[0]["id"]) if exact_matches else ""


def _verify_owner_reply(
    gateway: DiscordGateway,
    message_id: str,
    content: str,
    bot_id: str,
) -> None:
    if not message_id.isdigit():
        raise RuntimeError("Discord owner reply message id must be numeric")
    remote = gateway.message("owner", message_id)
    if (
        not isinstance(remote, dict)
        or str(remote.get("id", "")) != message_id
        or str(remote.get("content", "")) != content
        or not _is_current_discord_bot(remote, bot_id)
    ):
        raise RuntimeError(
            "Discord owner reply message id cannot be strictly verified"
        )


def _current_discord_bot_id(gateway: DiscordGateway) -> str:
    identity = gateway.check()
    if (
        not isinstance(identity, dict)
        or identity.get("status") != "HEALTHY"
        or not isinstance(identity.get("bot_id"), str)
        or not identity["bot_id"].isdigit()
    ):
        raise RuntimeError("Discord current bot identity cannot be verified")
    return identity["bot_id"]


def _is_current_discord_bot(message: dict[str, Any], bot_id: str) -> bool:
    author = message.get("author")
    return (
        isinstance(author, dict)
        and str(author.get("id", "")) == bot_id
        and author.get("bot") is True
    )


def _message_id_key(value: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError("Discord message id must be numeric") from exc


def _new_position_store() -> dict[str, Any]:
    return {
        "contract_version": "v1",
        "updated_at": "",
        "positions": [],
        "owner_sync": {
            "contract_version": "v1",
            "initialized": False,
            "last_message_id": "",
            "outcomes": {},
        },
    }


def _load_position_store(path: Path) -> dict[str, Any]:
    payload = read_json(path, _new_position_store())
    if not isinstance(payload, dict) or set(payload) != _POSITION_STORE_KEYS:
        raise RuntimeError("Invalid position-state contract")
    if payload["contract_version"] != "v1":
        raise RuntimeError("Unknown position-state contract version")
    if not isinstance(payload["updated_at"], str) or not isinstance(
        payload["positions"], list
    ):
        raise RuntimeError("Invalid position-state contract")
    owner_sync = payload["owner_sync"]
    if not isinstance(owner_sync, dict) or set(owner_sync) != _OWNER_SYNC_KEYS:
        raise RuntimeError("Invalid owner-sync private-state contract")
    if owner_sync["contract_version"] != "v1":
        raise RuntimeError("Unknown owner-sync private-state contract version")
    if (
        not isinstance(owner_sync["initialized"], bool)
        or not isinstance(owner_sync["last_message_id"], str)
        or (
            owner_sync["last_message_id"]
            and not owner_sync["last_message_id"].isdigit()
        )
        or not isinstance(owner_sync["outcomes"], dict)
    ):
        raise RuntimeError("Invalid owner-sync private-state contract")
    reply_message_ids: set[str] = set()
    for message_id, outcome in owner_sync["outcomes"].items():
        if (
            not isinstance(message_id, str)
            or not message_id.isdigit()
            or not isinstance(outcome, dict)
            or set(outcome) != _OUTCOME_KEYS
            or outcome["status"] not in {"RECORDED", "FAULT"}
            or not outcome["summary"]
            or not isinstance(outcome["audit_recorded"], bool)
            or not all(
                isinstance(outcome[name], str)
                for name in (
                    "summary",
                    "received_at",
                    "reply_marker",
                    "reply_message_id",
                )
            )
            or outcome["reply_marker"] != f"[A1-POSITION:{message_id}]"
            or (
                outcome["reply_message_id"]
                and not outcome["reply_message_id"].isdigit()
            )
        ):
            raise RuntimeError("Invalid owner-sync outcome")
        if outcome["reply_message_id"] in reply_message_ids:
            raise RuntimeError("Duplicate owner-sync reply message id")
        if outcome["reply_message_id"]:
            reply_message_ids.add(outcome["reply_message_id"])
        try:
            received_at = datetime.fromisoformat(outcome["received_at"])
        except ValueError as exc:
            raise RuntimeError("Invalid owner-sync outcome timestamp") from exc
        if received_at.tzinfo is None:
            raise RuntimeError("Invalid owner-sync outcome timestamp")
    return payload


def apply_owner_command(
    positions: list[dict[str, Any]],
    content: str,
) -> str:
    heading, fields = _parse_command(content)
    if heading == "【老板确认｜新增/加仓】":
        required = ["标的", "方向", "到期", "行权价", "数量", "实际成交价"]
        _require(fields, required)
        underlying = fields["标的"].upper()
        side = fields["方向"].lower()
        if underlying not in {"SPY", "QQQ"}:
            raise ValueError("标的只能是SPY或QQQ")
        if side not in {"call", "put"}:
            raise ValueError("方向只能是call或put")
        try:
            date.fromisoformat(fields["到期"])
            strike = float(fields["行权价"])
            quantity = int(fields["数量"])
            fill = float(fields["实际成交价"])
        except ValueError as exc:
            raise ValueError("到期、行权价、数量或实际成交价格式不正确") from exc
        if strike <= 0 or quantity <= 0 or fill <= 0:
            raise ValueError("行权价、数量和实际成交价必须大于0")
        base_position_id = _position_id(
            underlying,
            side,
            fields["到期"],
            strike,
        )
        matching = [
            item
            for item in positions
            if item.get("underlying") == underlying
            and item.get("option_side") == side
            and item.get("expiration") == fields["到期"]
            and float(item.get("strike", 0)) == strike
        ]
        existing = next(
            (
                item
                for item in matching
                if item.get("status", "OPEN") == "OPEN"
            ),
            None,
        )
        cost = round(fill * 100 * quantity, 2)
        if existing:
            position_id = str(existing["position_id"])
            old_quantity = int(existing["quantity"])
            old_cost = float(existing["cumulative_cost_usd"])
            new_quantity = old_quantity + quantity
            new_cost = old_cost + cost
            existing.update(
                {
                    "quantity": new_quantity,
                    "cumulative_cost_usd": round(new_cost, 2),
                    "actual_fill_price": round(new_cost / (100 * new_quantity), 4),
                    "updated_at": datetime.now(UTC).isoformat(),
                }
            )
            return f"加仓 {position_id} x{quantity}，累计投入${new_cost:.2f}"
        position_id = base_position_id
        if matching:
            used_ids = {str(item.get("position_id", "")) for item in positions}
            reentry = 2
            while f"{base_position_id}-r{reentry}" in used_ids:
                reentry += 1
            position_id = f"{base_position_id}-r{reentry}"
        positions.append(
            {
                "position_id": position_id,
                "underlying": underlying,
                "option_side": side,
                "expiration": fields["到期"],
                "strike": strike,
                "quantity": quantity,
                "actual_fill_price": fill,
                "cumulative_cost_usd": cost,
                "status": "OPEN",
                "updated_at": datetime.now(UTC).isoformat(),
            }
        )
        return f"新增 {position_id} x{quantity}，累计投入${cost:.2f}"

    if heading == "【老板确认｜减仓】":
        _require(fields, ["持仓ID", "数量"])
        position = _find_open(positions, fields["持仓ID"])
        try:
            quantity = int(fields["数量"])
        except ValueError as exc:
            raise ValueError("减仓数量格式不正确") from exc
        if quantity <= 0 or quantity > int(position["quantity"]):
            raise ValueError("减仓数量必须大于0且不能超过当前数量")
        position["quantity"] -= quantity
        if position["quantity"] == 0:
            position["status"] = "CLOSED"
        position["updated_at"] = datetime.now(UTC).isoformat()
        return f"减仓 {position['position_id']} x{quantity}"

    if heading == "【老板确认｜平仓】":
        _require(fields, ["持仓ID"])
        position = _find_open(positions, fields["持仓ID"])
        position["quantity"] = 0
        position["status"] = "CLOSED"
        position["updated_at"] = datetime.now(UTC).isoformat()
        return f"平仓 {position['position_id']}"
    raise ValueError("不支持的确认类型")


def enrich_positions(
    positions: list[dict[str, Any]],
    options: dict[str, Any],
) -> list[dict[str, Any]]:
    enriched = deepcopy(positions)
    for position in enriched:
        chain = (
            options.get(position["underlying"], {})
            .get("chains", {})
            .get(position["expiration"], [])
        )
        match = next(
            (
                item
                for item in chain
                if item.get("option_type") == position["option_side"]
                and float(item.get("strike", 0)) == float(position["strike"])
            ),
            None,
        )
        if not match:
            position.update(
                {
                    "live_quote_status": "UNAVAILABLE",
                    "option_symbol": "",
                    "current_bid": None,
                    "current_ask": None,
                    "exit_return_pct": None,
                    "exit_return_basis": "BID",
                }
            )
            continue
        bid = _positive_quote(match.get("bid"))
        ask = _positive_quote(match.get("ask"))
        fill = _positive_quote(position.get("actual_fill_price"))
        position.update(
            {
                "live_quote_status": (
                    "HEALTHY" if bid is not None and fill is not None else "UNAVAILABLE"
                ),
                "option_symbol": str(match.get("symbol", "")),
                "current_bid": bid,
                "current_ask": ask,
                "exit_return_pct": (
                    round((bid / fill - 1) * 100, 2)
                    if bid is not None and fill is not None
                    else None
                ),
                "exit_return_basis": "BID",
            }
        )
    return enriched


def _positive_quote(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _parse_command(content: str) -> tuple[str, dict[str, str]]:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not lines:
        raise ValueError("消息为空")
    if not lines[0].startswith("【"):
        return _parse_position_shorthand(" ".join(lines))
    fields: dict[str, str] = {}
    for line in lines[1:]:
        separator = "：" if "：" in line else ":" if ":" in line else ""
        if separator:
            key, value = line.split(separator, 1)
            fields[key.strip()] = value.strip()
    return lines[0], fields


def _looks_like_position_shorthand(content: str) -> bool:
    return bool(re.match(r"^\s*[A-Za-z]+\s+(?:call|put)\b", content, re.I))


def _parse_position_shorthand(content: str) -> tuple[str, dict[str, str]]:
    match = re.fullmatch(
        r"\s*([A-Za-z]+)\s+([A-Za-z]+)\s+"
        r"(\d+(?:\.\d+)?)\s+"
        r"(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s+(.+?)\s*",
        content,
        re.I,
    )
    if not match:
        raise ValueError(
            "简写格式应为：SPY put 736 7月31日 2.50 1张"
        )
    underlying, side, strike, month, day, tail = match.groups()
    if "张" not in tail:
        raise ValueError("缺少：数量（例如1张）")
    price_first = re.fullmatch(
        r"(\d+(?:\.\d+)?)\s+(\d+)\s*张",
        tail,
    )
    quantity_first = re.fullmatch(
        r"(\d+)\s*张\s+(\d+(?:\.\d+)?)",
        tail,
    )
    if price_first:
        fill, quantity = price_first.groups()
    elif quantity_first:
        quantity, fill = quantity_first.groups()
    else:
        raise ValueError("数量和实际成交价格式不正确")
    expiration = _next_expiration(int(month), int(day))
    return (
        "【老板确认｜新增/加仓】",
        {
            "标的": underlying,
            "方向": side,
            "到期": expiration.isoformat(),
            "行权价": strike,
            "数量": quantity,
            "实际成交价": fill,
        },
    )


def _next_expiration(month: int, day: int) -> date:
    today = _los_angeles_today()
    for year in range(today.year, today.year + 5):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate >= today:
            return candidate
    raise ValueError("到期月日格式不正确")


def _los_angeles_today() -> date:
    return datetime.now(ZoneInfo("America/Los_Angeles")).date()


def _require(fields: dict[str, str], names: list[str]) -> None:
    missing = [name for name in names if not fields.get(name)]
    if missing:
        raise ValueError("缺少：" + "、".join(missing))


def _find_open(
    positions: list[dict[str, Any]],
    position_id: str,
) -> dict[str, Any]:
    position = next(
        (
            item
            for item in positions
            if item.get("position_id") == position_id
            and item.get("status", "OPEN") == "OPEN"
        ),
        None,
    )
    if position is None:
        raise ValueError(f"找不到开放持仓：{position_id}")
    return position


def _position_id(
    underlying: str,
    side: str,
    expiration: str,
    strike: float,
) -> str:
    strike_text = str(int(strike)) if strike.is_integer() else str(strike)
    return f"{underlying}-{side}-{expiration}-{strike_text}"
