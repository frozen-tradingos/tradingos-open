from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from trading_os_v2.common.discord_display import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_FORMAT_VERSIONS,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    TS_DISCORD_LEGACY_FORMAT_VERSION,
    TS_DISCORD_PREVIOUS_FORMAT_VERSION,
    TS_DISCORD_RETAINED_FORMAT_VERSIONS,
)


class DiscordFailure(RuntimeError):
    pass


_DISCORD_CONTENT_LIMIT = 2000
_TS_CONTENT_LIMIT = 1700
DAILY_REVIEW_DISCORD_FORMAT_VERSION = "compact-v1"
DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION = "full-v1"
_TS_FULL_UNMAPPED_VALUES = {
    "MIXED",
    "LEADER",
    "LAGGER",
    "IN_LINE",
    "OIL",
    "RATES",
    "SECTOR",
    "RISK_APPETITE",
    "VOLATILITY",
    "MEGA_CAPS",
}


_DISPLAY_VALUES = {
    "HEALTHY": "正常",
    "DEGRADED": "降级运行",
    "DEGRADED_NO_TRADE": "降级运行，禁止新交易判断",
    "BLOCKED": "已阻断",
    "FAILED": "失败",
    "UNAVAILABLE": "不可用",
    "UNKNOWN": "未知",
    "FAULT": "故障",
    "RECOVERED": "已恢复",
    "SKIPPED": "已跳过",
    "INACTIVE": "休市待命",
    "INITIALIZING": "初始化中",
    "PENDING": "处理中",
    "CONFIRMED": "原预测成立",
    "PARTIAL": "原预测部分成立",
    "WEAKENED": "原预测减弱",
    "INVALIDATED": "原预测失效",
    "open": "交易中",
    "closed": "已闭市",
    "premarket": "盘前",
    "postmarket": "盘后",
    "bullish": "偏多",
    "bearish": "偏空",
    "BULLISH": "偏多",
    "BEARISH": "偏空",
    "RANGE": "区间震荡",
    "MIXED": "多空混合",
    "LEADER": "相对强",
    "LAGGER": "相对弱",
    "IN_LINE": "同步",
    "OIL": "油价",
    "RATES": "利率",
    "SECTOR": "行业",
    "RISK_APPETITE": "风险偏好",
    "VOLATILITY": "波动率",
    "MEGA_CAPS": "大型科技股",
    "range": "区间震荡",
    "uncertain": "不确定",
    "neutral": "中性",
    "mixed": "多空混合",
    "unknown": "未知",
    "entering": "资金进入",
    "exiting": "资金撤退",
    "strengthening": "资金增强",
    "reversing": "资金反转",
    "MANUAL_BUY": "人工买入建议",
    "OBSERVE": "观察",
    "NO_TRADE": "不交易",
    "MANUAL_REDUCE": "人工减仓建议",
    "MANUAL_ADJUST": "人工调整建议",
    "MANUAL_EXIT": "人工平仓建议",
    "call": "看涨期权",
    "put": "看跌期权",
    "none": "无",
    "NONE": "无",
    "TS": "TS",
    "COMMITTEE": "资金动量委员会",
    "D": "D",
    "TREND_UP": "趋势上涨",
    "TREND_DOWN": "趋势下跌",
    "NARROW_RANGE": "窄幅横盘",
    "WIDE_CHOP": "大幅震荡",
    "V_REVERSAL_UP": "V形向上反转",
    "V_REVERSAL_DOWN": "V形向下反转",
    "FALSE_BREAKOUT": "假突破",
    "FALSE_BREAKDOWN": "假跌破",
    "TRANSITION": "过渡状态",
    "trend": "趋势",
    "chop": "震荡",
    "reversal": "反转",
    "breakout_failure": "突破失败",
    "transition": "过渡",
    "central_bank": "央行政策",
    "inflation": "通胀",
    "employment": "就业",
    "growth": "经济增长",
    "systemic_event": "系统性事件",
    "low": "低",
    "normal": "正常",
    "high": "高",
    "slow": "慢",
    "fast": "快",
}

_ROUTES = (
    ("【员工：A1｜故障报告】", {"a1", "owner"}),
    ("【员工：A1｜每日复盘】", {"daily_review"}),
    ("【员工：A1｜下周重大财报候选】", {"earnings_calendar"}),
    ("【员工：A1｜今日重大财报候选提醒】", {"earnings_calendar"}),
    ("【员工：A1｜重大新闻】", {"major_news"}),
    ("【员工：A1｜持仓状态】", {"owner"}),
    ("【员工：A1｜信息补齐请求】", {"owner"}),
    ("【员工：A1｜老板持仓确认模板】", {"owner"}),
    ("【员工：A1｜", {"a1"}),
    ("【员工：A2｜", {"a2"}),
    ("【员工：TS｜", {"ts"}),
    ("【员工：资金动量委员会｜", {"committee"}),
    ("【员工：D｜", {"d"}),
    ("【员工：A3｜", {"a3", "owner"}),
    ("【员工：Codex｜", {"a1", "owner"}),
)


class DiscordGateway:
    def __init__(self, config: dict[str, Any]):
        raise DiscordFailure("Discord is disabled in the independent public package")

    def send(self, channel_key: str, content: str) -> str:
        validate_delivery_route(channel_key, content)
        _reject_overlong_content(content)
        try:
            channel_id = self.config["channels"][channel_key]
        except KeyError as exc:
            raise DiscordFailure(f"Discord频道未配置：{channel_key}") from exc
        body = json.dumps(
            {
                "content": content,
                "allowed_mentions": {"parse": []},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{channel_id}/messages",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bot {self.token}",
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "TradingOSV2-Discord/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return str(payload["id"])
        except urllib.error.HTTPError as exc:
            raise DiscordFailure(
                f"Discord频道{channel_key}发送失败：HTTP {exc.code}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DiscordFailure(
                f"Discord频道{channel_key}发送失败：{type(exc).__name__}"
            ) from exc

    def edit(self, channel_key: str, message_id: str, content: str) -> str:
        validate_delivery_route(channel_key, content)
        _reject_overlong_content(content)
        try:
            channel_id = self.config["channels"][channel_key]
        except KeyError as exc:
            raise DiscordFailure(f"Discord频道未配置：{channel_key}") from exc
        if not message_id.isdigit():
            raise DiscordFailure("Discord message_id格式无效")
        body = json.dumps(
            {
                "content": content,
                "allowed_mentions": {"parse": []},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            (
                f"https://discord.com/api/v10/channels/{channel_id}/messages/"
                f"{message_id}"
            ),
            data=body,
            method="PATCH",
            headers={
                "Authorization": f"Bot {self.token}",
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "TradingOSV2-Discord/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return str(payload["id"])
        except urllib.error.HTTPError as exc:
            raise DiscordFailure(
                f"Discord频道{channel_key}更新失败：HTTP {exc.code}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DiscordFailure(
                f"Discord频道{channel_key}更新失败：{type(exc).__name__}"
            ) from exc

    def check(self) -> dict[str, str]:
        request = urllib.request.Request(
            "https://discord.com/api/v10/users/@me",
            headers={
                "Authorization": f"Bot {self.token}",
                "User-Agent": "TradingOSV2-Discord/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
                return {
                    "status": "HEALTHY",
                    "bot_id": str(payload["id"]),
                    "username": str(payload["username"]),
                }
        except urllib.error.HTTPError as exc:
            raise DiscordFailure(f"Discord健康检查失败：HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DiscordFailure(
                f"Discord健康检查失败：{type(exc).__name__}"
            ) from exc

    def messages(
        self,
        channel_key: str,
        *,
        after: str = "",
        before: str = "",
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        channel_id = self.config["channels"][channel_key]
        if after and before:
            raise DiscordFailure("Discord消息分页不能同时指定after和before")
        params: dict[str, str | int] = {"limit": min(max(limit, 1), 100)}
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{channel_id}/messages?{query}",
            headers={
                "Authorization": f"Bot {self.token}",
                "User-Agent": "TradingOSV2-Discord/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if not isinstance(payload, list):
                    raise DiscordFailure("Discord消息响应格式错误")
                return payload
        except urllib.error.HTTPError as exc:
            raise DiscordFailure(
                f"读取Discord频道{channel_key}失败：HTTP {exc.code}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DiscordFailure(
                f"读取Discord频道{channel_key}失败：{type(exc).__name__}"
            ) from exc

    def message(
        self,
        channel_key: str,
        message_id: str,
    ) -> dict[str, Any]:
        try:
            channel_id = self.config["channels"][channel_key]
        except KeyError as exc:
            raise DiscordFailure(f"Discord频道未配置：{channel_key}") from exc
        if not message_id.isdigit():
            raise DiscordFailure("Discord message_id格式无效")
        request = urllib.request.Request(
            (
                "https://discord.com/api/v10/channels/"
                f"{channel_id}/messages/{message_id}"
            ),
            headers={
                "Authorization": f"Bot {self.token}",
                "User-Agent": "TradingOSV2-Discord/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
                if not isinstance(payload, dict):
                    raise DiscordFailure("Discord单条消息响应格式错误")
                return payload
        except urllib.error.HTTPError as exc:
            raise DiscordFailure(
                f"读取Discord频道{channel_key}消息失败：HTTP {exc.code}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise DiscordFailure(
                f"读取Discord频道{channel_key}消息失败：{type(exc).__name__}"
            ) from exc


def validate_delivery_route(channel_key: str, content: str) -> None:
    for title, allowed_channels in _ROUTES:
        if content.startswith(title):
            if channel_key not in allowed_channels:
                raise DiscordFailure(
                    f"员工标题与频道不匹配：禁止发送到{channel_key}"
                )
            return
    raise DiscordFailure("Discord消息缺少标准员工标题")


def format_heartbeat(packet: dict[str, Any], reason: str = "") -> str:
    a1 = packet["a1"]
    a2 = packet["a2"]
    providers = a1["providers"]
    structures = a2["structure"]
    options = a2["options"]
    momentum = a2.get("momentum_monitor", {})
    error_text = "；".join(
        _display_text(item) for item in a1["health"]["errors"][:3]
    ) or "无"
    return "\n".join(
        [
            "【员工：A1｜系统与数据】",
            f"报告类型：{_display_reason(reason, '15分钟心跳')}",
            f"时间：{packet['created_at']}",
            "市场状态："
            f"{_display_value(a1['market_clock'].get('state', 'unknown'))}",
            f"系统状态：{_display_value(a1['health']['state'])}",
            "真实API："
            f"Tradier={_display_value(providers['tradier']['status'])}｜"
            f"Finnhub={_display_value(providers['finnhub']['status'])}｜"
            f"官方源={_display_value(providers['official_news']['status'])}｜"
            "Google新闻="
            f"{_display_value(providers['google_news_rss']['status'])}",
            "行情："
            f"SPY={structures['SPY']['price']}｜"
            f"QQQ={structures['QQQ']['price']}",
            "期权链："
            f"SPY={options['SPY']['expiration_count']}个到期日｜"
            f"QQQ={options['QQQ']['expiration_count']}个到期日",
            "资金动量监控："
            f"{_display_value(momentum.get('direction', 'unknown'))}｜"
            f"强度={momentum.get('score', 0)}｜每15分钟重算",
            "财报观察：独立频道提醒｜TS仅可读取严格只读的事件风险上下文",
            f"证据包：{packet['packet_hash'][:12]}｜已冻结",
            "重大大盘新闻："
            + (
                "已核实"
                if a1["health"].get("verified_market_moving_news")
                else "未核实"
            ),
            f"异常：{error_text}",
            f"结论：{_display_value(a1['health']['state'])}",
        ]
    )


def format_a2(
    packet: dict[str, Any],
    reason: str = "",
    *,
    format_version: str = A2_DISCORD_FORMAT_VERSION,
) -> str:
    if format_version not in A2_DISCORD_FORMAT_VERSIONS:
        raise ValueError(
            f"Unsupported A2 Discord format version: {format_version}"
        )
    return _format_a2_full(
        packet,
        reason,
        compact_initializing=(format_version == A2_DISCORD_FORMAT_VERSION),
    )


def _format_a2_full(
    packet: dict[str, Any],
    reason: str,
    *,
    compact_initializing: bool,
) -> str:
    analysis = packet["a2"]
    spy = analysis["options"]["SPY"]
    qqq = analysis["options"]["QQQ"]
    tracker = analysis.get("pattern_tracker", {})
    tracker_symbols = tracker.get("symbols", {})
    initializing = (
        compact_initializing and tracker.get("status") == "INITIALIZING"
    )
    pattern_lines = (
        [
            "盘型追踪：确认盘型初始化中｜等待最少5根闭合5分钟K线，"
            "再连续3根确认｜TS方向见TS频道"
        ]
        if initializing
        else [
            "盘型追踪："
            f"{_display_value(tracker.get('status', 'UNKNOWN'))}｜"
            "每15分钟读取新增5分钟K线，连续3根确认",
            _pattern_message_line(
                "SPY",
                tracker_symbols.get("SPY", {}),
                compact_unconfirmed=compact_initializing,
            ),
            _pattern_message_line(
                "QQQ",
                tracker_symbols.get("QQQ", {}),
                compact_unconfirmed=compact_initializing,
            ),
        ]
    )
    gaps = "；".join(
        _display_text(item) for item in analysis["data_gaps"][:4]
    ) or "无"
    return "\n".join(
        [
            "【员工：A2｜增强证据】",
            f"报告类型：{_display_reason(reason, '盘中实质变化复核')}",
            f"时间：{packet['created_at']}",
            "相对强弱："
            f"{analysis['relative_strength']['leader']}领先｜"
            f"QQQ-SPY={analysis['relative_strength']['QQQ_minus_SPY_session_pct']}%",
            "SPY期权："
            f"P/C成交量={spy['put_call_volume_ratio']}｜"
            f"P/C持仓量={spy['put_call_open_interest_ratio']}",
            "QQQ期权："
            f"P/C成交量={qqq['put_call_volume_ratio']}｜"
            f"P/C持仓量={qqq['put_call_open_interest_ratio']}",
            *pattern_lines,
            f"证据缺口：{gaps}",
            f"证据包：{packet['packet_hash'][:12]}｜已冻结",
        ]
    )


def _pattern_message_line(
    symbol: str,
    value: Any,
    *,
    compact_unconfirmed: bool = False,
) -> str:
    state = value if isinstance(value, dict) else {}
    if compact_unconfirmed and state.get("current_state") == "UNKNOWN":
        processed = str(state.get("last_processed_bar_time", ""))
        processed_text = (
            f"｜最近已处理K线={processed}" if processed else ""
        )
        return f"{symbol}确认盘型：等待连续3次确认{processed_text}"
    transition = state.get("last_transition")
    transition_text = "本交易日尚无已确认切换"
    if isinstance(transition, dict):
        transition_text = (
            f"{_display_value(transition.get('from_state', 'UNKNOWN'))}"
            f"→{_display_value(transition.get('to_state', 'UNKNOWN'))}"
            f"（{transition.get('confirmed_at', '时间未知')}）"
        )
    return (
        f"{symbol}盘型：{_display_value(state.get('current_state', 'UNKNOWN'))}｜"
        f"方向={_display_value(state.get('direction', 'unknown'))}｜"
        f"结构={_display_value(state.get('structure', 'unknown'))}｜"
        f"波动={_display_value(state.get('volatility', 'unknown'))}｜"
        f"速度={_display_value(state.get('speed', 'unknown'))}｜"
        f"最近切换={transition_text}"
    )


def format_agent(
    role: str,
    output: dict[str, Any],
    reason: str = "",
    *,
    ts_format_version: str | None = None,
) -> str:
    report_type = _display_reason(reason, "盘中实质变化复核")
    if role == "TS":
        version = ts_format_version or TS_DISCORD_FORMAT_VERSION
        if version not in TS_DISCORD_FORMAT_VERSIONS:
            raise ValueError(f"Unsupported TS Discord format version: {version}")
        if version == "compact-v4":
            return _format_ts_compact_v4(output)
        if version == "compact-v3":
            return _format_ts_compact_v3(output)
        if version == "compact-v2":
            return _format_ts_v2(output, report_type, forecast_first=True)
        if version == "compact-v1":
            return _format_ts_v2(output, report_type, forecast_first=False)
        if version == "full-v1":
            return _format_ts_v2_full(output, report_type)
        raise RuntimeError(f"TS Discord format has no renderer: {version}")
    if role == "COMMITTEE":
        return "\n".join(
            [
                "【员工：资金动量委员会｜资金判断】",
                f"报告类型：{report_type}",
                "资金状态："
                f"{_display_value(output['flow_state'])}｜"
                f"方向：{_display_value(output['direction'])}",
                f"信心：{output['confidence']}/10",
                f"说明：{_display_text(output['summary'])}",
                "反转信号："
                + (
                    "；".join(
                        _display_text(item)
                        for item in output["reversal_signals"][:3]
                    )
                    or "未发现"
                ),
            ]
        )
    if role == "D":
        contract = (
            f"{output['underlying']} {_display_value(output['option_side'])} "
            f"{output['expiration']} {output['strike']}"
            if output["underlying"] != "NONE"
            else "无"
        )
        return "\n".join(
            [
                "【员工：D｜人工交易方案】",
                f"报告类型：{report_type}",
                f"方案：{_display_value(output['action'])}｜"
                f"评分：{output['score']}/10",
                f"合约：{contract}",
                f"预算上限：${output['max_entry_debit']}",
                f"止损：{output['stop_loss_pct']}%｜止盈：{output['take_profit_pct']}%",
                f"说明：{_display_text(output['summary'])}",
                "权限：仅人工建议｜禁止自动下单",
            ]
        )
    raise ValueError(f"Unsupported role format: {role}")


def _format_ts_compact_v4(output: dict[str, Any]) -> str:
    if output.get("contract_version") != "v2":
        raise ValueError("TS Discord output requires TS_OUTPUT v2")
    title = {
        "WEEKEND_OUTLOOK": "周末市场预测",
        "NEXT_SESSION": "次日市场预测",
        "OPENING_FORECAST": "开盘预测",
        "OPEN_15M_CHECK": "开盘15分钟验证",
        "OPEN_30M_CHECK": "开盘30分钟验证",
        "INTRADAY_30_60M": "未来30至60分钟预测",
    }[output["report_type"]]
    scenarios = output["scenarios"]
    outlooks = output["symbol_outlooks"]
    window = output["forecast_window"]
    window_end = (
        str(window["end_at"])[11:16]
        if window["end_at"] is not None
        else {
            "NEXT_REGULAR_SESSION_CLOSE": "次日收盘",
            "NEXT_FIVE_REGULAR_SESSIONS_CLOSE": "未来五日收盘",
        }[window["end_condition"]]
    )
    calibration = (
        "｜校准中"
        if output["report_type"]
        in {"OPEN_30M_CHECK", "INTRADAY_30_60M"}
        else ""
    )
    heading = (
        f"【员工：TS｜{title}｜"
        f"{window['start_at'][11:16]}→{window_end}"
        f"{calibration}】"
    )
    chains = output["causal_chains"][:2]
    causal = "；".join(
        f"[{_ts_chain_display_state(item)}]"
        f"{_compact_text(item['event'], 45)}→"
        f"{'/'.join(_display_value(channel) for channel in item['channels'])}→"
        f"{_compact_text(item['index_effect'], 55)}"
        for item in chains
    ) or "暂无已核实的新催化；不把普通新闻伪装成因果"
    main_sequence = " → ".join(
        _format_ts_stage(stage) for stage in scenarios["main"]["sequence"]
    )
    update = output["forecast_update"]
    validation = (
        "验证："
        f"{_display_value(update['prior_status'])}｜"
        f"修正={_compact_text(update['change_summary'], 70)}｜"
        if update["mode"] == "CHECK"
        else ""
    )
    review = (
        "｜READY_FOR_D_REVIEW"
        if output["tradeability"]["status"] == "READY_FOR_D_REVIEW"
        else ""
    )
    validation_at = str(output["next_validation"]["at"])
    market_date = str(output["evidence_snapshot"]["market_time"]["market_date"])
    validation_label = (
        validation_at[11:16]
        if validation_at.startswith(market_date)
        else f"{validation_at[5:10]} {validation_at[11:16]}"
    )
    observed_at = str(output["evidence_snapshot"]["market_time"]["observed_at"])
    evidence_label = observed_at[5:16].replace("T", " ")
    message = "\n".join(
        [
            heading,
            "冻结证据（当下，不是预测）："
            f"{evidence_label}｜盘型="
            f"{_display_value(output['current_pattern']['regime'])}｜"
            f"{_compact_text(output['current_pattern']['summary'], 90)}",
            "未来方向（预测）："
            f"{_display_value(output['path_bias'])}｜"
            f"SPY={_display_value(outlooks['SPY']['direction'])}/"
            f"{_display_value(outlooks['SPY']['relative_strength'])}｜"
            f"QQQ={_display_value(outlooks['QQQ']['direction'])}/"
            f"{_display_value(outlooks['QQQ']['relative_strength'])}",
            f"催化与因果状态：{causal}",
            f"未来主路径{scenarios['main']['probability_pct']}%："
            f"{_compact_text(output['one_line_forecast'], 110)}｜{main_sequence}",
            "替代路径："
            f"反向{scenarios['reverse']['probability_pct']}%="
            f"{_format_ts_scenario_summary(scenarios['reverse']['summary'])}｜"
            f"极端{scenarios['extreme']['probability_pct']}%="
            f"{_format_ts_scenario_summary(scenarios['extreme']['summary'])}",
            "主路径触发（不是最终判对）："
            f"{_compact_text(_format_ts_conditions(scenarios['main']['activation'], 2), 100)}",
            "主路径失效（触发后才评估）："
            f"{_compact_text(_format_ts_conditions(scenarios['main']['invalidation'], 2), 100)}",
            f"{validation}下一验证：{validation_label}｜"
            f"按顺序完成全部阶段才算成立｜固定时点评分，不用后见数据改写{review}",
        ]
    )
    if len(message) > _TS_CONTENT_LIMIT:
        raise ValueError("TS Discord 精简消息仍超过 1700 字符")
    return message


def _ts_chain_display_state(chain: dict[str, Any]) -> str:
    state = chain.get("evidence_state")
    if state == "VERIFIED":
        return "已核实因果"
    if state == "PARTIAL" and chain.get("kind") == "AMPLIFIER":
        return "待发布日程/结果未知"
    if state == "PARTIAL":
        return "部分证据/未形成因果结论"
    return "争议证据/不作为因果结论"


def _format_ts_compact_v3(output: dict[str, Any]) -> str:
    if output.get("contract_version") != "v2":
        raise ValueError("TS Discord output requires TS_OUTPUT v2")
    title = {
        "WEEKEND_OUTLOOK": "周末市场预测",
        "NEXT_SESSION": "次日市场预测",
        "OPENING_FORECAST": "开盘预测",
        "OPEN_15M_CHECK": "开盘15分钟验证",
        "OPEN_30M_CHECK": "开盘30分钟验证",
        "INTRADAY_30_60M": "未来30至60分钟预测",
    }[output["report_type"]]
    scenarios = output["scenarios"]
    outlooks = output["symbol_outlooks"]
    window = output["forecast_window"]
    window_end = (
        str(window["end_at"])[11:16]
        if window["end_at"] is not None
        else {
            "NEXT_REGULAR_SESSION_CLOSE": "次日收盘",
            "NEXT_FIVE_REGULAR_SESSIONS_CLOSE": "未来五日收盘",
        }[window["end_condition"]]
    )
    calibration = (
        "｜校准中"
        if output["report_type"]
        in {"OPEN_30M_CHECK", "INTRADAY_30_60M"}
        else ""
    )
    heading = (
        f"【员工：TS｜{title}｜"
        f"{window['start_at'][11:16]}→{window_end}"
        f"{calibration}】"
    )
    chains = output["causal_chains"][:2]
    causal = "；".join(
        f"{_compact_text(item['event'], 45)}→"
        f"{'/'.join(_display_value(channel) for channel in item['channels'])}→"
        f"{_compact_text(item['index_effect'], 55)}"
        for item in chains
    ) or "暂无已核实的新催化"
    main_sequence = " → ".join(
        _format_ts_stage(stage) for stage in scenarios["main"]["sequence"]
    )
    update = output["forecast_update"]
    validation = (
        "验证："
        f"{_display_value(update['prior_status'])}｜"
        f"修正={_compact_text(update['change_summary'], 70)}｜"
        if update["mode"] == "CHECK"
        else ""
    )
    review = (
        "｜READY_FOR_D_REVIEW"
        if output["tradeability"]["status"] == "READY_FOR_D_REVIEW"
        else ""
    )
    validation_at = str(output["next_validation"]["at"])
    market_date = str(output["evidence_snapshot"]["market_time"]["market_date"])
    validation_label = (
        validation_at[11:16]
        if validation_at.startswith(market_date)
        else f"{validation_at[5:10]} {validation_at[11:16]}"
    )
    message = "\n".join(
        [
            heading,
            "方向："
            f"{_display_value(output['path_bias'])}｜"
            f"SPY={_display_value(outlooks['SPY']['direction'])}/"
            f"{_display_value(outlooks['SPY']['relative_strength'])}｜"
            f"QQQ={_display_value(outlooks['QQQ']['direction'])}/"
            f"{_display_value(outlooks['QQQ']['relative_strength'])}",
            "为什么："
            f"{_compact_text(output['current_pattern']['summary'], 90)}｜{causal}",
            f"主路径{scenarios['main']['probability_pct']}%："
            f"{_compact_text(output['one_line_forecast'], 110)}｜{main_sequence}",
            f"反向{scenarios['reverse']['probability_pct']}%："
            f"{_format_ts_scenario_summary(scenarios['reverse']['summary'])}｜"
            f"极端{scenarios['extreme']['probability_pct']}%："
            f"{_format_ts_scenario_summary(scenarios['extreme']['summary'])}",
            "改变判断：触发="
            f"{_compact_text(_format_ts_conditions(scenarios['main']['activation'], 2), 90)}｜"
            "失效="
            f"{_compact_text(_format_ts_conditions(scenarios['main']['invalidation'], 2), 90)}",
            f"{validation}下一验证：{validation_label}{review}",
        ]
    )
    if len(message) > _TS_CONTENT_LIMIT:
        raise ValueError("TS Discord 精简消息仍超过 1700 字符")
    return message


def _format_ts_v2(
    output: dict[str, Any],
    report_type: str,
    *,
    forecast_first: bool,
) -> str:
    if output.get("contract_version") != "v2":
        raise ValueError("TS Discord output requires TS_OUTPUT v2")
    heading = {
        "WEEKEND_OUTLOOK": "【员工：TS｜周末市场预测】",
        "NEXT_SESSION": "【员工：TS｜次日市场预测】",
        "OPENING_FORECAST": "【员工：TS｜开盘预测】",
        "OPEN_15M_CHECK": "【员工：TS｜开盘15分钟验证】",
        "OPEN_30M_CHECK": "【员工：TS｜开盘30分钟验证】",
        "INTRADAY_30_60M": "【员工：TS｜未来30至60分钟预测】",
    }[output["report_type"]]
    scenarios = output["scenarios"]
    outlooks = output["symbol_outlooks"]
    main_sequence = " → ".join(
        _format_ts_stage(stage) for stage in scenarios["main"]["sequence"]
    )
    chains = output["causal_chains"][:2]
    causal = "；".join(
        f"{_compact_text(item['event'], 55)} → "
        f"{'/'.join(_display_value(channel) for channel in item['channels'])} → "
        f"{_compact_text(item['index_effect'], 70)}"
        for item in chains
    ) or "没有已核实增强新闻；仍按核心数据给出预测"
    snapshot = output["evidence_snapshot"]
    update = output["forecast_update"]
    binding = (
        f"｜原预测={update['prior_forecast_hash'][:12]}"
        if update["mode"] == "CHECK"
        else ""
    )
    correction = (
        "原预测验证结论："
        f"{_display_value(update['prior_status'])}｜"
        f"修正说明：{_compact_text(update['change_summary'], 90)}"
        if update["mode"] == "CHECK"
        else ""
    )
    calibration = (
        "阶段：校准中｜不声称胜率｜不自动交易"
        if output["report_type"]
        in {"OPEN_30M_CHECK", "INTRADAY_30_60M"}
        else ""
    )
    outlook_line = (
        "SPY="
        f"{_display_value(outlooks['SPY']['direction'])}/"
        f"{_display_value(outlooks['SPY']['relative_strength'])}｜QQQ="
        f"{_display_value(outlooks['QQQ']['direction'])}/"
        f"{_display_value(outlooks['QQQ']['relative_strength'])}"
    )
    first_screen = (
        [
            f"现在：{_display_value(output['path_bias'])}｜{outlook_line}",
            f"为什么：{_compact_text(output['current_pattern']['summary'], 120)}｜"
            f"新闻={causal}",
            f"接下来：主路径{scenarios['main']['probability_pct']}%｜"
            f"{_compact_text(output['one_line_forecast'], 150)}",
            f"先到再到：{main_sequence}",
        ]
        if forecast_first
        else [
            f"现在：盘型={_display_value(output['current_pattern']['regime'])}｜"
            f"涨跌横盘={_display_value(output['path_bias'])}",
            outlook_line,
            f"为什么：{_compact_text(output['current_pattern']['summary'], 120)}｜"
            f"新闻={causal}",
            f"接下来：主路径{scenarios['main']['probability_pct']}%｜"
            f"{_compact_text(output['one_line_forecast'], 150)}",
            f"先到再到：{main_sequence}",
        ]
    )
    pattern_detail = (
        [
            "A2确认盘型："
            f"{_display_value(output['current_pattern']['regime'])}"
        ]
        if forecast_first
        else []
    )
    message = "\n".join(
        [
            heading,
            *first_screen,
            f"主路径摘要={_format_ts_scenario_summary(scenarios['main']['summary'])}",
            "三路径概率："
            f"主={scenarios['main']['probability_pct']}%｜"
            f"反向={scenarios['reverse']['probability_pct']}%｜"
            f"极端={scenarios['extreme']['probability_pct']}%",
            "反向/极端："
            f"{_format_ts_scenario_summary(scenarios['reverse']['summary'])}｜"
            f"{_format_ts_scenario_summary(scenarios['extreme']['summary'])}",
            f"主路径触发：{_format_ts_conditions(scenarios['main']['activation'], 2)}",
            f"主路径失效：{_format_ts_conditions(scenarios['main']['invalidation'], 2)}",
            *pattern_detail,
            f"报告类型：{_compact_text(report_type, 36)}｜"
            f"窗口={output['forecast_window']['horizon']}",
            f"市场时间：{snapshot['market_time']['observed_at']}｜"
            f"证据={snapshot['run_id']}｜release={snapshot['release_commit'][:8]}"
            f"{binding}",
            *([correction] if correction else []),
            *([calibration] if calibration else []),
            f"证据成熟度：{output['evidence_maturity']['level']}｜"
            f"交易性：{output['tradeability']['status']}",
            f"下一验证：{output['next_validation']['at']}｜"
            f"{_compact_text(output['next_validation']['purpose'], 80)}",
            f"当天最容易犯的错：{_compact_text(output['most_likely_mistake'], 80)}",
            f"完整证据：见不可变证据归档｜run_id={snapshot['run_id']}",
            "权限：TS只负责预测｜D负责方案｜A3最终决定｜禁止自动下单",
        ]
    )
    if len(message) > _TS_CONTENT_LIMIT:
        raise ValueError("TS Discord 精简消息仍超过 1700 字符")
    return message


def _format_ts_v2_full(output: dict[str, Any], report_type: str) -> str:
    """Render the former V2 body only to verify immutable delivery ledgers."""
    if output.get("contract_version") != "v2":
        raise ValueError("TS Discord output requires TS_OUTPUT v2")
    heading = {
        "WEEKEND_OUTLOOK": "【员工：TS｜周末市场预测】",
        "NEXT_SESSION": "【员工：TS｜次日市场预测】",
        "OPENING_FORECAST": "【员工：TS｜开盘预测】",
        "OPEN_15M_CHECK": "【员工：TS｜开盘15分钟验证】",
        "OPEN_30M_CHECK": "【员工：TS｜开盘30分钟验证】",
        "INTRADAY_30_60M": "【员工：TS｜未来30至60分钟预测】",
    }[output["report_type"]]
    scenarios = output["scenarios"]
    outlooks = output["symbol_outlooks"]
    main_sequence = " → ".join(
        _display_ts_full_text(stage["label"])
        for stage in scenarios["main"]["sequence"]
    )
    chains = output["causal_chains"][:2]
    causal = "；".join(
        f"{_display_ts_full_text(item['event'])} → "
        f"{'/'.join(_display_ts_full_value(channel) for channel in item['channels'])} → "
        f"{_display_ts_full_text(item['index_effect'])}"
        for item in chains
    ) or "没有已核实增强新闻；仍按核心数据给出预测"
    snapshot = output["evidence_snapshot"]
    update = output["forecast_update"]
    binding = (
        f"｜原预测={update['prior_forecast_hash'][:12]}"
        if update["mode"] == "CHECK"
        else ""
    )
    correction = (
        "原预测验证结论："
        f"{_display_ts_full_value(update['prior_status'])}｜"
        f"修正说明：{_display_ts_full_text(update['change_summary'])}"
        if update["mode"] == "CHECK"
        else ""
    )
    calibration = (
        "阶段：校准中｜不声称胜率｜不自动交易"
        if output["report_type"]
        in {"OPEN_30M_CHECK", "INTRADAY_30_60M"}
        else ""
    )
    return "\n".join(
        [
            heading,
            f"报告类型：{report_type}｜窗口={output['forecast_window']['horizon']}",
            f"市场时间：{snapshot['market_time']['observed_at']}｜"
            f"证据={snapshot['run_id']}｜release={snapshot['release_commit'][:8]}"
            f"{binding}",
            *([correction] if correction else []),
            *([calibration] if calibration else []),
            f"当前盘型：{_display_ts_full_value(output['current_pattern']['regime'])}｜"
            f"{_display_ts_full_text(output['current_pattern']['summary'])}",
            f"一句话方向：{_display_ts_full_value(output['path_bias'])}｜"
            f"{_display_ts_full_text(output['one_line_forecast'])}",
            "SPY："
            f"{_display_ts_full_value(outlooks['SPY']['direction'])}/"
            f"{_display_ts_full_value(outlooks['SPY']['relative_strength'])}｜"
            "QQQ："
            f"{_display_ts_full_value(outlooks['QQQ']['direction'])}/"
            f"{_display_ts_full_value(outlooks['QQQ']['relative_strength'])}",
            "三路径："
            f"主{scenarios['main']['probability_pct']}%｜"
            f"反向{scenarios['reverse']['probability_pct']}%｜"
            f"极端{scenarios['extreme']['probability_pct']}%",
            f"预计顺序：{main_sequence}",
            f"主路径触发：{_format_ts_full_conditions(scenarios['main']['activation'])}",
            f"主路径失效：{_format_ts_full_conditions(scenarios['main']['invalidation'])}",
            f"新闻因果链：{causal}",
            f"证据成熟度：{output['evidence_maturity']['level']}｜"
            f"交易性：{output['tradeability']['status']}",
            f"下一次验证：{output['next_validation']['at']}｜"
            f"{_display_ts_full_text(output['next_validation']['purpose'])}",
            f"当天最容易犯的错：{_display_ts_full_text(output['most_likely_mistake'])}",
            "权限：TS只负责预测｜D负责方案｜A3最终决定｜禁止自动下单",
        ]
    )


def _format_ts_full_conditions(group: dict[str, Any]) -> str:
    joiner = " 且 " if group["logic"] == "ALL" else " 或 "
    return joiner.join(_format_ts_condition(item) for item in group["conditions"])


def _display_ts_full_text(value: Any) -> str:
    """Translate text exactly as the original full-v1 renderer did."""
    text = str(value)
    gap_suffixes = {
        " intraday bars unavailable": "盘中K线不可用",
        " has fewer than 20 daily bars": "日线数据不足20根",
        " has no 0-15 DTE option chain": "没有0至15天到期的期权链",
    }
    for suffix, translation in gap_suffixes.items():
        if text.endswith(suffix):
            return text[: -len(suffix)] + translation
    phrases = {
        "BLS official feed": "BLS官方信息源",
        "Finnhub primary news/earnings unavailable": "Finnhub主要新闻及财报不可用",
        "Option spread hard threshold is not defined": "期权价差硬阈值尚未确定",
        "Dark-pool provider is not configured in phase 1": "第一阶段尚未配置暗池数据源",
        "timed out": "运行超时",
        "failed": "运行失败",
        "returned invalid structured output": "返回的结构化结果无效",
        "returned the wrong role contract": "返回了错误的岗位契约",
        "Frozen evidence packet hash mismatch": "冻结证据包哈希不匹配",
    }
    for source, translation in phrases.items():
        text = text.replace(source, translation)
    historical_values = {
        key: translation
        for key, translation in _DISPLAY_VALUES.items()
        if key not in _TS_FULL_UNMAPPED_VALUES
    }
    for source, translation in sorted(
        historical_values.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        text = re.sub(
            rf"(?<![A-Za-z0-9_]){re.escape(source)}(?![A-Za-z0-9_])",
            translation,
            text,
        )
    return text


def _display_ts_full_value(value: Any) -> str:
    if str(value) in _TS_FULL_UNMAPPED_VALUES:
        return "未知"
    return _display_value(value)


def _format_ts_conditions(group: dict[str, Any], limit: int) -> str:
    joiner = " 且 " if group["logic"] == "ALL" else " 或 "
    conditions = group["conditions"][:limit]
    result = joiner.join(_format_ts_condition(item) for item in conditions)
    remaining = len(group["conditions"]) - len(conditions)
    return f"{result} 等{len(group['conditions'])}项" if remaining else result


def _format_ts_scenario_summary(value: Any) -> str:
    return _compact_text(value, 90)


def _format_ts_stage(stage: dict[str, Any]) -> str:
    conditions = stage["conditions"]
    remaining = f"等{len(conditions)}项" if len(conditions) > 1 else ""
    return (
        f"{_compact_text(stage['label'], 12)}="
        f"{_compact_text(_format_ts_condition(conditions[0]), 72)}{remaining}"
    )


def _format_ts_condition(item: dict[str, Any]) -> str:
    return (
        f"{item['symbol']} {item['metric']} {item['operator']} "
        f"{item['value']}"
        + (
            f"至{item['upper_value']}"
            if item["upper_value"] is not None
            else ""
        )
        + f"（{item['confirmation']}）"
    )


def format_final(
    output: dict[str, Any],
    reason: str = "",
    review: dict[str, Any] | None = None,
) -> str:
    contract = (
        f"{output['underlying']} {_display_value(output['option_side'])} "
        f"{output['expiration']} {output['strike']} × {output['quantity']}"
        if output["underlying"] != "NONE"
        else "无"
    )
    conflict_detected = bool((review or {}).get("conflict_detected"))
    conflict_location = (
        f"{_display_value((review or {}).get('review_target', 'NONE'))}："
        f"{_display_text((review or {}).get('reason', '未说明'))}"
        if conflict_detected
        else "无"
    )
    resolution = (
        "；".join(
            _display_text(item)
            for item in output.get("conflicts_resolved", [])[:3]
        )
        or ("不交易，冲突未被充分解决" if conflict_detected else "无需解决")
    )
    return "\n".join(
        [
            "【员工：A3｜最终决定】",
            f"报告类型：{_display_reason(reason, '盘中实质变化复核')}",
            f"决定：{_display_value(output['decision'])}｜"
            f"评分：{output['score']}/10",
            f"合约：{contract}",
            f"预算上限：${output['max_entry_debit']}",
            f"止损：{output['stop_loss_pct']}%｜止盈：{output['take_profit_pct']}%",
            f"结论：{_display_text(output['plain_language'])}",
            f"冲突位置：{conflict_location}",
            f"解决说明：{resolution}",
            "失效条件："
            + (
                "；".join(
                    _display_text(item) for item in output["invalidation"][:3]
                )
                or "无"
            ),
            f"数据状态：{_display_value(output['data_status'])}",
            "执行方式：老板人工确认｜系统禁止自动下单",
        ]
    )


def format_daily_review(
    review: dict[str, Any],
    *,
    format_version: str = DAILY_REVIEW_DISCORD_FORMAT_VERSION,
) -> str:
    if format_version == DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION:
        return _format_daily_review_full(review)
    if format_version != DAILY_REVIEW_DISCORD_FORMAT_VERSION:
        raise ValueError(
            f"Unsupported daily review Discord format version: {format_version}"
        )
    errors = (
        "；".join(
            _compact_text(item, 140) for item in review.get("errors", [])[:2]
        )
        or "无"
    )
    trades = (
        "；".join(
            _compact_text(item, 100) for item in review.get("trades", [])[:2]
        )
        or "无"
    )
    market = _compact_text(
        review.get("market_summary", "无可用市场摘要"),
        220,
    )
    return "\n".join(
        [
            "【员工：A1｜每日复盘】",
            f"日期：{review['date']}（加州时间）",
            f"大盘：{market}",
            f"系统状态：{_display_value(review['system_status'])}",
            f"关键故障：{errors}",
            f"TS预测验收：{_compact_text(review.get('ts_prediction_summary', '未提供'), 180)}",
            f"人工买卖：{trades}",
            f"开放持仓：{review['open_position_count']}笔",
            f"当日验收：{_compact_text(review['acceptance_summary'], 120)}",
            f"完整复盘：{_compact_text(review['archive_path'], 220)}",
            "权限：仅复盘记录｜禁止自动下单",
        ]
    )


def _format_daily_review_full(review: dict[str, Any]) -> str:
    errors = (
        "；".join(_display_text(item) for item in review.get("errors", [])[:5])
        or "无"
    )
    trades = (
        "；".join(_display_text(item) for item in review.get("trades", [])[:5])
        or "无"
    )
    market = review.get("market_summary", "无可用市场摘要")
    return "\n".join(
        [
            "【员工：A1｜每日复盘】",
            f"日期：{review['date']}（加州时间）",
            f"系统状态：{_display_value(review['system_status'])}",
            f"系统错误：{errors}",
            f"大盘情况：{market}",
            f"买卖记录：{trades}",
            f"开放持仓：{review['open_position_count']}笔",
            f"当日验收：{review['acceptance_summary']}",
            f"TS预测验收：{review.get('ts_prediction_summary', '未提供')}",
            f"本机存档：{review['archive_path']}",
            "权限：仅复盘记录｜禁止自动下单",
        ]
    )


def format_earnings_calendar(
    *,
    mode: str,
    day: str,
    source_status: str,
    items: list[dict[str, Any]],
) -> str:
    if mode not in {"WEEKLY", "DAY"}:
        raise ValueError("财报公告模式必须是WEEKLY或DAY")
    rows = [
        (
            f"- {item.get('date', '日期未知')}｜{item.get('symbol', '标的未知')}｜"
            f"{_earnings_session(item.get('session', ''))}｜"
            f"每股收益预期={_optional_number(item.get('eps_estimate'))}｜"
            f"营收预期={_optional_number(item.get('revenue_estimate'))}"
        )
        for item in items[:20]
    ] or [
        "- 下周没有候选" if mode == "WEEKLY" else "- 今天没有候选"
    ]
    if mode == "WEEKLY":
        title = "【员工：A1｜下周重大财报候选】"
        report_type = "周末财报观察｜只读候选"
        window = (
            f"统计起点：{day}（加州时间）｜范围：当天至未来6个日历日"
        )
        reminder = "提醒阶段：周末首次提醒｜财报当天将进行二次提醒"
    else:
        title = "【员工：A1｜今日重大财报候选提醒】"
        report_type = "财报当天二次提醒｜只读候选"
        window = f"财报日期：{day}（加州时间）"
        reminder = (
            "事件风险：财报可能造成隔夜跳空，30%至50%止损可能被穿透，"
            "最大损失可能达到全部权利金"
        )
    return "\n".join(
        [
            title,
            f"报告类型：{report_type}",
            window,
            f"数据源：Finnhub财报日历｜状态={_display_value(source_status)}",
            f"候选数量：{len(items)}",
            "筛选说明：按营收预期绝对值排序取前20名候选｜"
            "不等同于已核实会影响SPY或QQQ",
            "候选：",
            *rows,
            reminder,
            "用途：A1提醒｜TS仅可用于事件风险和条件剧本｜"
            "不得单独触发人工买入建议",
            "权限：老板人工决定｜系统禁止自动下单",
        ]
    )


def format_major_news(
    *,
    event_fingerprint: str,
    evidence: list[dict[str, Any]],
) -> str:
    if not evidence:
        raise ValueError("重大新闻公告必须包含已核实证据")
    categories = sorted(
        {
            _display_value(item.get("category", ""))
            for item in evidence
            if str(item.get("category", "")).strip()
        }
    )
    rows = [
        (
            f"- {item.get('headline', '标题缺失')}｜"
            f"来源={item.get('source', '来源未知')}｜"
            f"发布时间={item.get('published_at', '时间未知')}"
        )
        for item in evidence[:3]
    ]
    rule = (
        "官方单源"
        if any(item.get("verification_rule") == "OFFICIAL_SINGLE_SOURCE" for item in evidence)
        else "同类双源"
    )
    return "\n".join(
        [
            "【员工：A1｜重大新闻】",
            "报告类型：已核实大盘重大事件｜确定性事件只发布一次",
            f"事件类别：{'、'.join(categories) or '重大大盘事件'}",
            f"验证规则：{rule}",
            *rows,
            f"事件指纹：{event_fingerprint}",
            "用途：A1持续观察｜可作为已核实大盘事件摘要供Agent参考",
        ]
    )


def format_fault(component: str, reason: str, impact: str) -> str:
    return "\n".join(
        [
            "【员工：A1｜故障报告】",
            f"故障位置：{_display_text(component)}",
            f"故障原因：{_display_text(reason)}",
            f"影响：{_display_text(impact)}",
            "处理：停止新交易判断｜不猜测｜不自动下单",
        ]
    )


def format_guard(output: dict[str, Any]) -> str:
    faults = "；".join(_display_text(item) for item in output["faults"][:5]) or "无"
    return "\n".join(
        [
            "【员工：Codex｜独立系统巡查】",
            f"状态：{_display_value(output['status'])}",
            f"故障：{faults}",
            f"是否建议重启：{'是' if output['restart_recommended'] else '否'}",
            f"给老板：{_display_text(output['owner_message'])}",
        ]
    )


def position_command_template() -> str:
    return "\n".join(
        [
            "【员工：A1｜老板持仓确认模板】",
            "新增或加仓时，请由服务器老板本人发送：",
            "【老板确认｜新增/加仓】",
            "标的：SPY",
            "方向：call",
            "到期：2026-07-31",
            "行权价：525",
            "数量：1",
            "实际成交价：2.50",
            "",
            "减仓：",
            "【老板确认｜减仓】",
            "持仓ID：SPY-call-2026-07-31-525",
            "数量：1",
            "",
            "平仓：",
            "【老板确认｜平仓】",
            "持仓ID：SPY-call-2026-07-31-525",
            "系统只接受完整模板；成交价按每股期权报价填写。",
        ]
    )


def _display_value(value: Any) -> str:
    return _DISPLAY_VALUES.get(str(value), "未知")


def _reject_overlong_content(content: str) -> None:
    if len(content) > _DISCORD_CONTENT_LIMIT:
        raise DiscordFailure("Discord消息超过2000字符，拒绝截断发送")


def _compact_text(value: Any, limit: int) -> str:
    text = " ".join(_display_text(value).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _display_reason(reason: str, default: str) -> str:
    if not reason:
        return default
    if re.search(r"[\u4e00-\u9fff]", reason):
        return reason
    return "手动触发分析"


def _earnings_session(value: Any) -> str:
    return {
        "bmo": "盘前",
        "amc": "盘后",
        "dmh": "盘中",
    }.get(str(value).lower(), "时段未标明")


def _optional_number(value: Any) -> str:
    return "未提供" if value is None else str(value)


def _display_text(value: Any) -> str:
    text = str(value)
    gap_suffixes = {
        " intraday bars unavailable": "盘中K线不可用",
        " has fewer than 20 daily bars": "日线数据不足20根",
        " has no 0-15 DTE option chain": "没有0至15天到期的期权链",
    }
    for suffix, translation in gap_suffixes.items():
        if text.endswith(suffix):
            return text[: -len(suffix)] + translation
    phrases = {
        "BLS official feed": "BLS官方信息源",
        "Finnhub primary news/earnings unavailable": "Finnhub主要新闻及财报不可用",
        "Option spread hard threshold is not defined": "期权价差硬阈值尚未确定",
        "Dark-pool provider is not configured in phase 1": "第一阶段尚未配置暗池数据源",
        "timed out": "运行超时",
        "failed": "运行失败",
        "returned invalid structured output": "返回的结构化结果无效",
        "returned the wrong role contract": "返回了错误的岗位契约",
        "Frozen evidence packet hash mismatch": "冻结证据包哈希不匹配",
    }
    for source, translation in phrases.items():
        text = text.replace(source, translation)
    for source, translation in sorted(
        _DISPLAY_VALUES.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        text = re.sub(
            rf"(?<![A-Za-z0-9_]){re.escape(source)}(?![A-Za-z0-9_])",
            translation,
            text,
        )
    return text


