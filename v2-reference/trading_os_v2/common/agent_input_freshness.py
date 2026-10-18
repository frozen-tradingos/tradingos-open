from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from trading_os_v2.common.io import sha256_json


ET_ZONE = ZoneInfo("America/New_York")
OPEN_MAX_AGE = timedelta(minutes=20)
NON_OPEN_MAX_AGE = timedelta(days=4)
FUTURE_TOLERANCE = timedelta(minutes=1)
NON_OPEN_MARKET_STATES = {"closed", "premarket", "postmarket"}
SYMBOLS = ("SPY", "QQQ")


class AgentInputFreshnessError(RuntimeError):
    pass


def _aware_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise AgentInputFreshnessError(f"{label}缺少时间")
    try:
        parsed = datetime.fromisoformat(
            value.strip().replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise AgentInputFreshnessError(f"{label}时间无效") from exc
    if parsed.tzinfo is None:
        raise AgentInputFreshnessError(f"{label}必须包含时区")
    return parsed


def _market_time(value: Any, label: str) -> datetime:
    if value in (None, "") or isinstance(value, bool):
        raise AgentInputFreshnessError(f"{label}缺少精确时间")
    parsed: datetime
    if isinstance(value, (int, float)):
        number = float(value)
        if (
            number != number
            or number in {float("inf"), float("-inf")}
            or number <= 0
        ):
            raise AgentInputFreshnessError(f"{label}不是有限时间")
        if number >= 100_000_000_000:
            number /= 1000
        try:
            parsed = datetime.fromtimestamp(number, UTC)
        except (OverflowError, OSError, ValueError) as exc:
            raise AgentInputFreshnessError(
                f"{label}时间戳无效"
            ) from exc
    elif isinstance(value, str):
        parsed = _aware_time(value, label)
    else:
        raise AgentInputFreshnessError(f"{label}时间类型无效")
    if parsed.timestamp() <= 0:
        raise AgentInputFreshnessError(f"{label}时间必须晚于Unix纪元")
    return parsed.astimezone(UTC)


def _is_hash(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_positive_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and value == value
        and value not in {float("inf"), float("-inf")}
        and float(value) > 0
    )


def _require_window(
    timestamp: datetime,
    packet_at: datetime,
    session_mode: str,
    label: str,
) -> None:
    max_age = OPEN_MAX_AGE if session_mode == "OPEN" else NON_OPEN_MAX_AGE
    packet_utc = packet_at.astimezone(UTC)
    if (
        timestamp < packet_utc - max_age
        or timestamp > packet_utc + FUTURE_TOLERANCE
    ):
        raise AgentInputFreshnessError(
            f"{label}不在Agent允许的新鲜度窗口内"
        )


def _validate_packet_identity(
    packet: dict[str, Any],
) -> datetime:
    if (
        packet.get("contract_version") != "v1"
        or not isinstance(packet.get("run_id"), str)
        or not packet["run_id"]
        or not _is_hash(packet.get("packet_hash"))
    ):
        raise AgentInputFreshnessError("Agent输入证据身份无效")
    packet_at = _aware_time(
        packet.get("created_at"),
        "Agent证据创建时间",
    )
    payload = {
        key: value
        for key, value in packet.items()
        if key not in {"run_id", "packet_hash"}
    }
    expected_hash = sha256_json(payload)
    expected_run_id = (
        f"{packet_at.strftime('%Y%m%dT%H%M%SZ')}-"
        f"{expected_hash[:10]}"
    )
    if (
        packet["packet_hash"] != expected_hash
        or packet["run_id"] != expected_run_id
    ):
        raise AgentInputFreshnessError(
            "Agent输入证据run_id或packet_hash不是内容哈希"
        )
    return packet_at


def _clock(
    packet: dict[str, Any],
    packet_at: datetime,
) -> tuple[dict[str, str], str, date]:
    if (
        packet.get("a1", {})
        .get("providers", {})
        .get("tradier", {})
        .get("status")
        != "HEALTHY"
    ):
        raise AgentInputFreshnessError(
            "Tradier状态不是HEALTHY，禁止启动Agent"
        )
    market_clock = packet.get("a1", {}).get("market_clock")
    if not isinstance(market_clock, dict):
        raise AgentInputFreshnessError("Agent输入缺少Tradier市场时钟")
    market_state = str(market_clock.get("state", "")).lower()
    if market_state == "open":
        session_mode = "OPEN"
    elif market_state in NON_OPEN_MARKET_STATES:
        session_mode = "NON_OPEN"
    else:
        raise AgentInputFreshnessError(
            "Tradier市场时钟状态未知，禁止启动Agent"
        )
    observed_at = _market_time(
        market_clock.get("timestamp"),
        "Tradier市场时钟",
    )
    _require_window(
        observed_at,
        packet_at,
        session_mode,
        "Tradier市场时钟",
    )
    raw_date = market_clock.get("date")
    if not isinstance(raw_date, str):
        raise AgentInputFreshnessError(
            "Tradier市场时钟缺少美东日期"
        )
    try:
        market_day = date.fromisoformat(raw_date)
    except ValueError as exc:
        raise AgentInputFreshnessError(
            "Tradier市场时钟美东日期无效"
        ) from exc
    if (
        market_day.isoformat() != raw_date
        or observed_at.astimezone(ET_ZONE).date() != market_day
    ):
        raise AgentInputFreshnessError(
            "Tradier市场时钟日期与时间戳不一致"
        )
    return (
        {
            "state": market_state,
            "date": raw_date,
            "observed_at": observed_at.isoformat(),
        },
        session_mode,
        market_day,
    )


def _candidate_proof(
    candidate: Any,
    *,
    symbol: str,
    expiration: str,
    dte: int,
    packet_at: datetime,
    session_mode: str,
    seen_contracts: set[str],
) -> tuple[str, bool, list[datetime]]:
    if not isinstance(candidate, dict):
        raise AgentInputFreshnessError(
            f"{symbol}近ATM合约不是对象"
        )
    contract_symbol = candidate.get("symbol")
    side = candidate.get("side")
    if (
        not isinstance(contract_symbol, str)
        or not contract_symbol.startswith(symbol)
        or contract_symbol in seen_contracts
        or side not in {"call", "put"}
        or candidate.get("expiration") != expiration
        or candidate.get("dte") != dte
        or not _is_positive_number(candidate.get("strike"))
    ):
        raise AgentInputFreshnessError(
            f"{symbol}近ATM合约身份无效"
        )
    seen_contracts.add(contract_symbol)
    if "quote_date" in candidate:
        raise AgentInputFreshnessError(
            f"{contract_symbol}仍在使用已删除的quote_date旧字段"
        )
    trade_date = candidate.get("trade_date", "")
    if trade_date:
        if not isinstance(trade_date, str):
            raise AgentInputFreshnessError(
                f"{contract_symbol}最后成交日期无效"
            )
        try:
            parsed_trade_day = date.fromisoformat(trade_date)
        except ValueError as exc:
            raise AgentInputFreshnessError(
                f"{contract_symbol}最后成交日期无效"
            ) from exc
        if parsed_trade_day.isoformat() != trade_date:
            raise AgentInputFreshnessError(
                f"{contract_symbol}最后成交日期无效"
            )
    bid_at = _market_time(
        candidate.get("bid_at"),
        f"{contract_symbol}买价",
    )
    ask_at = _market_time(
        candidate.get("ask_at"),
        f"{contract_symbol}卖价",
    )
    for label, timestamp in (("买价", bid_at), ("卖价", ask_at)):
        _require_window(
            timestamp,
            packet_at,
            session_mode,
            f"{contract_symbol}{label}",
        )
    bid = candidate.get("bid")
    ask = candidate.get("ask")
    usable = (
        _is_positive_number(bid)
        and _is_positive_number(ask)
        and float(ask) >= float(bid)
    )
    return side, usable, [bid_at, ask_at]


def _symbol_proof(
    packet: dict[str, Any],
    *,
    symbol: str,
    packet_at: datetime,
    session_mode: str,
    market_day: date,
) -> tuple[dict[str, Any], str, datetime]:
    structures = packet.get("a2", {}).get("structure")
    options = packet.get("a2", {}).get("options")
    if not isinstance(structures, dict) or not isinstance(options, dict):
        raise AgentInputFreshnessError(
            "Agent输入缺少A2结构或期权证据"
        )
    structure = structures.get(symbol)
    option = options.get(symbol)
    if not isinstance(structure, dict) or not isinstance(option, dict):
        raise AgentInputFreshnessError(
            f"{symbol}的A2结构或期权证据缺失"
        )
    if (
        structure.get("symbol") != symbol
        or not _is_positive_number(structure.get("price"))
        or option.get("symbol") != symbol
        or not _is_positive_number(option.get("underlying"))
        or float(structure["price"]) != float(option["underlying"])
    ):
        raise AgentInputFreshnessError(
            f"{symbol}结构与期权标的身份或价格不一致"
        )
    structure_at = _market_time(
        structure.get("quote_trade_date"),
        f"{symbol}标的报价",
    )
    _require_window(
        structure_at,
        packet_at,
        session_mode,
        f"{symbol}标的报价",
    )
    if (
        session_mode == "OPEN"
        and structure_at.astimezone(ET_ZONE).date() != market_day
    ):
        raise AgentInputFreshnessError(
            f"{symbol}开盘标的报价不属于时钟交易日"
        )
    source_raw = option.get("collected_at")
    source_at = _aware_time(
        source_raw,
        f"{symbol}期权采集时间",
    ).astimezone(UTC)
    packet_utc = packet_at.astimezone(UTC)
    if (
        source_at > packet_utc
        or packet_utc - source_at > OPEN_MAX_AGE
    ):
        raise AgentInputFreshnessError(
            f"{symbol}期权采集时间与冻结证据不一致"
        )
    expected_status = (
        "CURRENT_DATE" if session_mode == "OPEN" else "MARKET_CLOSED"
    )
    if option.get("contract_quote_status") != expected_status:
        raise AgentInputFreshnessError(
            f"{symbol}期权报价状态不是{expected_status}"
        )
    expirations = option.get("expirations")
    expiration_count = option.get("expiration_count")
    if (
        not isinstance(expirations, list)
        or not expirations
        or not _is_integer(expiration_count)
        or expiration_count != len(expirations)
        or expiration_count > 16
    ):
        raise AgentInputFreshnessError(
            f"{symbol}期权到期日数量无效"
        )
    source_day = source_at.astimezone(ET_ZONE).date()
    seen_expirations: set[str] = set()
    seen_contracts: set[str] = set()
    quote_dates: set[str] = set()
    expiration_proofs: list[dict[str, Any]] = []
    for expiration_row in expirations:
        if not isinstance(expiration_row, dict):
            raise AgentInputFreshnessError(
                f"{symbol}期权到期日不是对象"
            )
        expiration_raw = expiration_row.get("expiration")
        if not isinstance(expiration_raw, str):
            raise AgentInputFreshnessError(
                f"{symbol}期权到期日无效"
            )
        try:
            expiration_day = date.fromisoformat(expiration_raw)
        except ValueError as exc:
            raise AgentInputFreshnessError(
                f"{symbol}期权到期日无效"
            ) from exc
        dte = (expiration_day - source_day).days
        contract_count = expiration_row.get("contract_count")
        if (
            expiration_day.isoformat() != expiration_raw
            or expiration_raw in seen_expirations
            or not 0 <= dte <= 15
            or expiration_row.get("dte") != dte
            or not _is_integer(contract_count)
            or contract_count <= 0
        ):
            raise AgentInputFreshnessError(
                f"{symbol}期权到期日身份或DTE无效"
            )
        seen_expirations.add(expiration_raw)
        candidates = expiration_row.get("near_atm_candidates")
        if (
            not isinstance(candidates, list)
            or not candidates
            or contract_count < len(candidates)
        ):
            raise AgentInputFreshnessError(
                f"{symbol} {expiration_raw}近ATM候选或合约总数无效"
            )
        usable = {"call": 0, "put": 0}
        quote_times: list[datetime] = []
        for candidate in candidates:
            side, candidate_usable, times = _candidate_proof(
                candidate,
                symbol=symbol,
                expiration=expiration_raw,
                dte=dte,
                packet_at=packet_at,
                session_mode=session_mode,
                seen_contracts=seen_contracts,
            )
            if candidate_usable:
                usable[side] += 1
            quote_times.extend(times)
            quote_dates.update(
                timestamp.astimezone(ET_ZONE).date().isoformat()
                for timestamp in times
            )
        if usable["call"] < 1 or usable["put"] < 1:
            raise AgentInputFreshnessError(
                f"{symbol} {expiration_raw}缺少可用call或put双边报价"
            )
        expiration_proofs.append(
            {
                "expiration": expiration_raw,
                "dte": dte,
                "contract_count": contract_count,
                "usable_call_count": usable["call"],
                "usable_put_count": usable["put"],
                "oldest_bbo_at": min(quote_times).isoformat(),
                "newest_bbo_at": max(quote_times).isoformat(),
            }
        )
    expected_dates = sorted(quote_dates)
    advertised_dates = option.get("contract_quote_dates")
    if (
        not isinstance(advertised_dates, list)
        or advertised_dates != expected_dates
        or advertised_dates != sorted(set(advertised_dates))
    ):
        raise AgentInputFreshnessError(
            f"{symbol}期权报价日期证明不一致"
        )
    if (
        session_mode == "OPEN"
        and expected_dates != [market_day.isoformat()]
    ):
        raise AgentInputFreshnessError(
            f"{symbol}开盘期权报价不是当前美东交易日"
        )
    return (
        {
            "structure_price": float(structure["price"]),
            "structure_quote_at": structure_at.isoformat(),
            "contract_quote_status": expected_status,
            "contract_quote_dates": expected_dates,
            "expiration_count": expiration_count,
            "expirations": expiration_proofs,
        },
        str(source_raw),
        source_at,
    )


def build_agent_input_freshness(
    packet: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(packet, dict):
        raise AgentInputFreshnessError("Agent输入证据不是对象")
    packet_at = _validate_packet_identity(packet)
    market_clock, session_mode, market_day = _clock(
        packet,
        packet_at,
    )
    symbols: dict[str, Any] = {}
    source_values: list[str] = []
    source_times: list[datetime] = []
    for symbol in SYMBOLS:
        proof, source_value, source_at = _symbol_proof(
            packet,
            symbol=symbol,
            packet_at=packet_at,
            session_mode=session_mode,
            market_day=market_day,
        )
        symbols[symbol] = proof
        source_values.append(source_value)
        source_times.append(source_at)
    if (
        source_values[0] != source_values[1]
        or source_times[0] != source_times[1]
    ):
        raise AgentInputFreshnessError(
            "SPY与QQQ没有使用同一A1采集时间"
        )
    payload = {
        "contract_version": "v1",
        "component": "AGENT_INPUT_FRESHNESS",
        "status": "HEALTHY",
        "run_id": packet["run_id"],
        "packet_hash": packet["packet_hash"],
        "packet_created_at": packet_at.astimezone(UTC).isoformat(),
        "source_collected_at": source_times[0].isoformat(),
        "session_mode": session_mode,
        "market_clock": market_clock,
        "symbols": symbols,
    }
    return {**payload, "freshness_hash": sha256_json(payload)}


def validate_agent_input_freshness(
    proof: Any,
    packet: dict[str, Any],
) -> dict[str, Any]:
    expected = build_agent_input_freshness(packet)
    if proof != expected or not _is_hash(expected["freshness_hash"]):
        raise AgentInputFreshnessError(
            "Agent输入新鲜度证明缺失、损坏或与冻结证据不一致"
        )
    return expected
