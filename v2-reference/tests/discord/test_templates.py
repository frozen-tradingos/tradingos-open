from __future__ import annotations

import hashlib
import unittest

from tests.agent_runtime.test_ts_output_v2 import (
    add_scheduled_macro_chain,
    add_verified_chain,
    ts_output,
)
from trading_os_v2.discord_gateway.service import (
    A2_DISCORD_FORMAT_VERSION,
    A2_DISCORD_LEGACY_FORMAT_VERSION,
    DAILY_REVIEW_DISCORD_FORMAT_VERSION,
    DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
    DiscordFailure,
    TS_DISCORD_FORMAT_VERSION,
    TS_DISCORD_FORMAT_VERSIONS,
    _display_text,
    _format_ts_compact_v4,
    format_agent,
    format_a2,
    format_daily_review,
    format_earnings_calendar,
    format_final,
    format_heartbeat,
    format_major_news,
    validate_delivery_route,
)


class DiscordTemplateTests(unittest.TestCase):
    def test_fifteen_day_chain_gap_is_translated_to_chinese(self) -> None:
        self.assertEqual(
            _display_text("SPY has no 0-15 DTE option chain"),
            "SPY没有0至15天到期的期权链",
        )

    def test_a2_reports_only_confirmed_pattern_state_in_chinese(self) -> None:
        transition = {
            "from_state": "TRANSITION",
            "to_state": "TREND_UP",
            "confirmed_at": "2026-07-30T14:00:00+00:00",
        }
        packet = {
            "created_at": "2026-07-30T14:01:00+00:00",
            "packet_hash": "a" * 64,
            "a2": {
                "relative_strength": {
                    "leader": "SPY",
                    "QQQ_minus_SPY_session_pct": -0.2,
                },
                "options": {
                    symbol: {
                        "put_call_volume_ratio": 1.0,
                        "put_call_open_interest_ratio": 1.1,
                    }
                    for symbol in ("SPY", "QQQ")
                },
                "pattern_tracker": {
                    "status": "HEALTHY",
                    "symbols": {
                        "SPY": {
                            "current_state": "TREND_UP",
                            "candidate_state": "FALSE_BREAKOUT",
                            "direction": "bullish",
                            "structure": "trend",
                            "volatility": "normal",
                            "speed": "fast",
                            "last_transition": transition,
                        },
                        "QQQ": {
                            "current_state": "NARROW_RANGE",
                            "candidate_state": "TREND_DOWN",
                            "direction": "neutral",
                            "structure": "range",
                            "volatility": "low",
                            "speed": "slow",
                            "last_transition": None,
                        },
                    },
                },
                "data_gaps": [],
            },
        }
        message = format_a2(packet)
        self.assertIn("【员工：A2｜增强证据】", message)
        self.assertIn("SPY盘型：趋势上涨", message)
        self.assertIn("最近切换=过渡状态→趋势上涨", message)
        self.assertIn("QQQ盘型：窄幅横盘", message)
        self.assertNotIn("FALSE_BREAKOUT", message)
        self.assertNotIn("TREND_DOWN", message)
        legacy = format_a2(
            packet,
            format_version=A2_DISCORD_LEGACY_FORMAT_VERSION,
        )
        self.assertEqual(
            hashlib.sha256(legacy.encode("utf-8")).hexdigest(),
            "8a6d4a0b083f37489805cb3eac143daf49a4d4bcad7a881fd24b3b8990a8e1f3",
        )

    def test_a2_initializing_explains_warmup_without_unknown_traits(self) -> None:
        packet = {
            "created_at": "2026-08-06T13:31:00+00:00",
            "packet_hash": "b" * 64,
            "a2": {
                "relative_strength": {
                    "leader": "SPY",
                    "QQQ_minus_SPY_session_pct": -0.1,
                },
                "options": {
                    symbol: {
                        "put_call_volume_ratio": 1.0,
                        "put_call_open_interest_ratio": 1.1,
                    }
                    for symbol in ("SPY", "QQQ")
                },
                "pattern_tracker": {
                    "status": "INITIALIZING",
                    "symbols": {
                        symbol: {
                            "current_state": "UNKNOWN",
                            "candidate_state": "UNKNOWN",
                            "candidate_bars": 0,
                            "direction": "unknown",
                            "structure": "unknown",
                            "volatility": "unknown",
                            "speed": "unknown",
                            "last_transition": None,
                        }
                        for symbol in ("SPY", "QQQ")
                    },
                },
                "data_gaps": [],
            },
        }

        current = format_a2(
            packet,
            format_version=A2_DISCORD_FORMAT_VERSION,
        )
        legacy = format_a2(
            packet,
            format_version=A2_DISCORD_LEGACY_FORMAT_VERSION,
        )

        self.assertIn("确认盘型初始化中", current)
        self.assertIn("等待最少5根闭合5分钟K线，再连续3根确认", current)
        self.assertIn("TS方向见TS频道", current)
        for misleading in (
            "SPY盘型：未知",
            "QQQ盘型：未知",
            "方向=未知",
            "结构=未知",
            "波动=未知",
            "速度=未知",
        ):
            self.assertNotIn(misleading, current)
        self.assertIn("SPY盘型：未知", legacy)
        self.assertIn("方向=未知", legacy)

    def test_a2_delivery_rejects_unknown_format_version(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported A2 Discord format"):
            format_a2({}, format_version="unknown-v9")

    def test_a2_compact_waits_for_confirmation_without_unknown_traits(self) -> None:
        packet = {
            "created_at": "2026-08-06T14:01:00+00:00",
            "packet_hash": "c" * 64,
            "a2": {
                "relative_strength": {
                    "leader": "QQQ",
                    "QQQ_minus_SPY_session_pct": 0.1,
                },
                "options": {
                    symbol: {
                        "put_call_volume_ratio": 1.0,
                        "put_call_open_interest_ratio": 1.1,
                    }
                    for symbol in ("SPY", "QQQ")
                },
                "pattern_tracker": {
                    "status": "HEALTHY",
                    "symbols": {
                        symbol: {
                            "current_state": "UNKNOWN",
                            "candidate_state": "TREND_UP",
                            "candidate_bars": 1,
                            "direction": "unknown",
                            "structure": "unknown",
                            "volatility": "unknown",
                            "speed": "unknown",
                            "last_processed_bar_time": (
                                "2026-08-06T06:55:00-07:00"
                            ),
                            "last_transition": None,
                        }
                        for symbol in ("SPY", "QQQ")
                    },
                },
                "data_gaps": [],
            },
        }

        current = format_a2(
            packet,
            format_version=A2_DISCORD_FORMAT_VERSION,
        )
        legacy = format_a2(
            packet,
            format_version=A2_DISCORD_LEGACY_FORMAT_VERSION,
        )

        self.assertIn("SPY确认盘型：等待连续3次确认", current)
        self.assertIn("最近已处理K线=2026-08-06T06:55:00-07:00", current)
        self.assertNotIn("TREND_UP", current)
        self.assertNotIn("方向=未知", current)
        self.assertIn("SPY盘型：未知", legacy)

    def test_heartbeat_reports_continuous_momentum(self) -> None:
        packet = {
            "created_at": "2026-07-29T18:00:00-07:00",
            "packet_hash": "a" * 64,
            "a1": {
                "market_clock": {"state": "open"},
                "health": {
                    "state": "HEALTHY",
                    "errors": [],
                    "verified_market_moving_news": False,
                },
                "providers": {
                    name: {"status": "HEALTHY"}
                    for name in (
                        "tradier",
                        "finnhub",
                        "official_news",
                        "google_news_rss",
                    )
                },
            },
            "a2": {
                "structure": {
                    "SPY": {"price": 500},
                    "QQQ": {"price": 450},
                },
                "options": {
                    "SPY": {"expiration_count": 5},
                    "QQQ": {"expiration_count": 5},
                },
                "momentum_monitor": {
                    "direction": "bearish",
                    "score": -4,
                },
            },
        }
        message = format_heartbeat(packet)
        self.assertIn("市场状态：交易中", message)
        self.assertIn("系统状态：正常", message)
        self.assertIn("资金动量监控：偏空｜强度=-4｜每15分钟重算", message)
        self.assertIn(
            "财报观察：独立频道提醒｜TS仅可读取严格只读的事件风险上下文",
            message,
        )
        self.assertNotIn("HEALTHY", message)

    def test_a1_information_bulletins_have_dedicated_chinese_routes(self) -> None:
        earnings = format_earnings_calendar(
            mode="WEEKLY",
            day="2026-07-30",
            source_status="HEALTHY",
            items=[
                {
                    "date": "2026-07-31",
                    "symbol": "AAPL",
                    "session": "amc",
                    "eps_estimate": 1.2,
                    "revenue_estimate": None,
                }
            ],
        )
        self.assertIn("【员工：A1｜下周重大财报候选】", earnings)
        self.assertIn("盘后", earnings)
        self.assertIn("不等同于已核实会影响SPY或QQQ", earnings)
        self.assertIn("不得单独触发人工买入建议", earnings)
        validate_delivery_route("earnings_calendar", earnings)
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("a1", earnings)

        day_reminder = format_earnings_calendar(
            mode="DAY",
            day="2026-07-31",
            source_status="HEALTHY",
            items=[
                {
                    "date": "2026-07-31",
                    "symbol": "AAPL",
                    "session": "amc",
                    "eps_estimate": 1.2,
                    "revenue_estimate": None,
                }
            ],
        )
        self.assertIn("【员工：A1｜今日重大财报候选提醒】", day_reminder)
        self.assertIn("最大损失可能达到全部权利金", day_reminder)
        validate_delivery_route("earnings_calendar", day_reminder)

        news = format_major_news(
            event_fingerprint="a" * 64,
            evidence=[
                {
                    "category": "central_bank",
                    "headline": "Federal funds rate decision",
                    "source": "Federal Reserve",
                    "published_at": "2026-07-30T18:00:00+00:00",
                    "verification_rule": "OFFICIAL_SINGLE_SOURCE",
                }
            ],
        )
        self.assertIn("【员工：A1｜重大新闻】", news)
        self.assertIn("验证规则：官方单源", news)
        self.assertIn("事件类别：央行政策", news)
        self.assertNotIn("central_bank", news)
        validate_delivery_route("major_news", news)
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("owner", news)

    def test_a3_final_displays_conflict_location_and_resolution(self) -> None:
        output = {
            "decision": "NO_TRADE",
            "score": 0,
            "underlying": "NONE",
            "option_side": "none",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "max_entry_debit": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "证据冲突，不交易。",
            "conflicts_resolved": ["按硬风险规则降级为不交易"],
            "invalidation": [],
            "data_status": "DEGRADED_NO_TRADE",
        }
        message = format_final(
            output,
            "中盘固定分析",
            {
                "conflict_detected": True,
                "review_target": "TS",
                "reason": "TS偏多但委员会显示资金撤退",
            },
        )
        self.assertIn("冲突位置：TS：TS偏多但委员会显示资金撤退", message)
        self.assertIn("解决说明：按硬风险规则降级为不交易", message)
        self.assertNotIn("bearish", message)

    def test_next_day_ts_message_is_unmistakable(self) -> None:
        output, _context = ts_output(report_type="NEXT_SESSION")
        output["path_bias"] = "BEARISH"
        output["one_line_forecast"] = "次日偏空，先测试下方支撑。"
        output["symbol_outlooks"]["SPY"]["direction"] = "BEARISH"
        output["symbol_outlooks"]["QQQ"]["direction"] = "BEARISH"
        output["scenarios"]["main"]["bias"] = "BEARISH"
        output["scenarios"]["reverse"]["summary"] = "收复压力后转强"
        output["scenarios"]["extreme"]["summary"] = "失守支撑后加速"
        message = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v3",
        )
        self.assertIn("【员工：TS｜次日市场预测｜06:30→07:30】", message)
        self.assertIn(
            "方向：偏空｜SPY=偏空/相对弱｜QQQ=偏空/相对强",
            message,
        )
        self.assertIn("为什么：", message)
        self.assertIn("主路径60%：次日偏空，先测试下方支撑。", message)
        self.assertIn("先到=SPY LAST_PRICE", message)
        self.assertIn(" → 再到=SPY LAST_PRICE", message)
        self.assertIn("反向25%：收复压力后转强｜极端15%：失守支撑后加速", message)
        self.assertIn("改变判断：触发=SPY LAST_PRICE", message)
        self.assertEqual(len(message.splitlines()), 7)
        self.assertNotIn("交易性", message)
        self.assertNotIn("自动下单", message)
        self.assertNotIn("bearish", message.lower())

    def test_ts_delivery_format_version_is_explicit_and_stable(self) -> None:
        output, _context = ts_output(report_type="NEXT_SESSION")

        current = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version=TS_DISCORD_FORMAT_VERSION,
        )
        compact_v3 = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v3",
        )
        compact_v2 = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v2",
        )
        compact_v1 = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v1",
        )
        full_v1 = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="full-v1",
        )

        self.assertEqual(current, format_agent("TS", output, "次日提前分析"))
        self.assertIn("方向：偏多｜SPY=偏多/相对弱｜QQQ=偏多/相对强", compact_v3)
        self.assertNotIn("现在：盘型=", compact_v3)
        self.assertNotIn("A2确认盘型：", compact_v3)
        self.assertIn("现在：偏多｜SPY=偏多/相对弱｜QQQ=偏多/相对强", compact_v2)
        self.assertIn("A2确认盘型：", compact_v2)
        self.assertIn("现在：盘型=", compact_v1)
        self.assertNotIn("A2确认盘型：", compact_v1)
        self.assertIn("一句话方向：", full_v1)
        self.assertIn("当前盘型：", full_v1)
        self.assertNotIn("现在：盘型=", full_v1)
        if TS_DISCORD_FORMAT_VERSION == "compact-v3":
            self.assertEqual(current, compact_v3)
        elif TS_DISCORD_FORMAT_VERSION == "compact-v4":
            self.assertEqual(current, _format_ts_compact_v4(output))
        else:
            self.fail("Unexpected current TS Discord format")

    def test_ts_v4_separates_frozen_evidence_from_future_prediction(self) -> None:
        output, context = ts_output(report_type="NEXT_SESSION")
        output["current_pattern"]["summary"] = "截至冻结时点仍为震荡。"
        output["one_line_forecast"] = "次日先回踩，再向上测试压力。"
        add_verified_chain(
            output,
            context,
            fingerprint="7" * 64,
            category="energy",
        )

        message = _format_ts_compact_v4(output)

        self.assertIn("冻结证据（当下，不是预测）：", message)
        self.assertIn("截至冻结时点仍为震荡。", message)
        self.assertIn(
            "未来方向（预测）：偏多｜SPY=偏多/相对弱｜QQQ=偏多/相对强",
            message,
        )
        self.assertIn("催化与因果状态：", message)
        self.assertIn("[已核实因果]", message)
        self.assertIn("未来主路径60%：次日先回踩，再向上测试压力。", message)
        self.assertIn("替代路径：反向25%=", message)
        self.assertIn("主路径触发（不是最终判对）：", message)
        self.assertIn("主路径失效（触发后才评估）：", message)
        self.assertIn("按顺序完成全部阶段才算成立", message)
        self.assertIn("固定时点评分，不用后见数据改写", message)
        self.assertLess(message.index("冻结证据"), message.index("未来方向"))
        self.assertLess(message.index("未来方向"), message.index("未来主路径"))
        self.assertEqual(len(message.splitlines()), 9)
        if "compact-v4" in TS_DISCORD_FORMAT_VERSIONS:
            self.assertEqual(
                message,
                format_agent(
                    "TS",
                    output,
                    "次日提前分析",
                    ts_format_version="compact-v4",
                ),
            )

    def test_ts_v4_does_not_call_unreleased_macro_verified_news(self) -> None:
        output, context = ts_output(report_type="NEXT_SESSION")
        add_scheduled_macro_chain(
            output,
            context,
            fingerprint="8" * 64,
        )

        message = _format_ts_compact_v4(output)

        self.assertIn("[待发布日程/结果未知]", message)
        self.assertIn("未发布/结果未知", message)
        self.assertNotIn("已核实新闻因果", message)
        self.assertNotIn("[已核实因果]", message)

    def test_ts_forecast_stays_explicit_while_a2_pattern_is_unknown(self) -> None:
        output, _context = ts_output(report_type="OPENING_FORECAST")
        output["current_pattern"]["regime"] = "UNKNOWN"
        output["current_pattern"]["summary"] = "A2确认盘型仍在初始化。"
        output["path_bias"] = "BULLISH"
        output["symbol_outlooks"]["SPY"].update(
            {"direction": "BULLISH", "relative_strength": "LEADER"}
        )
        output["symbol_outlooks"]["QQQ"].update(
            {"direction": "RANGE", "relative_strength": "LAGGER"}
        )
        output["scenarios"]["main"]["bias"] = "BULLISH"

        message = format_agent(
            "TS",
            output,
            "开盘预测",
            ts_format_version="compact-v3",
        )

        self.assertEqual(
            message.splitlines()[1],
            "方向：偏多｜SPY=偏多/相对强｜QQQ=区间震荡/相对弱",
        )
        self.assertNotIn("盘型=未知", message)
        self.assertIn("为什么：A2确认盘型仍在初始化。", message)
        self.assertLess(message.index("方向："), message.index("为什么："))
        self.assertLess(message.index("为什么："), message.index("主路径"))

    def test_ts_delivery_rejects_unknown_format_version(self) -> None:
        output, _context = ts_output(report_type="NEXT_SESSION")

        with self.assertRaisesRegex(ValueError, "Unsupported TS Discord format"):
            format_agent(
                "TS",
                output,
                "次日提前分析",
                ts_format_version="unknown-v9",
            )

    def test_historical_ts_delivery_bytes_are_frozen(self) -> None:
        cases = (
            (
                "compact-v3",
                (
                    (
                        "NEXT_SESSION",
                        "次日提前分析",
                        "8ac48187713f31e306c8a356689245436c3488adec668ee7e2bb0000d59560d0",
                    ),
                    (
                        "OPEN_15M_CHECK",
                        "开盘15分钟验证",
                        "3bf54366b0b1f9bb956b9674815119106704c7fa940765fbd9795d849eeb7b32",
                    ),
                ),
            ),
            (
                "compact-v2",
                (
                    (
                        "NEXT_SESSION",
                        "次日提前分析",
                        "91355d1d1ee288a32919c43085f24e49ac0b4a11682060746c76b343e73a69af",
                    ),
                    (
                        "OPEN_15M_CHECK",
                        "开盘15分钟验证",
                        "59e9eef6ef9bb7b936a2f7fffb4c9d03b24e53e265136245225cb90827fa6c5f",
                    ),
                ),
            ),
            (
                "compact-v1",
                (
                    (
                        "NEXT_SESSION",
                        "次日提前分析",
                        "3c65f6f932145c48484ae94a71e5e51e48b4c738c4055b2b44b5839aedef69c3",
                    ),
                    (
                        "OPEN_15M_CHECK",
                        "开盘15分钟验证",
                        "83537e3edcef443217b043a854a1a9f3b2cd7ee29084ed7235e2e84d66d23fc7",
                    ),
                ),
            ),
            (
                "full-v1",
                (
                    (
                        "NEXT_SESSION",
                        "次日提前分析",
                        "def320dc5c9e28b5810af7ae9acdf0062a73a43fbd8df173185df1718acae488",
                    ),
                    (
                        "OPEN_15M_CHECK",
                        "开盘15分钟验证",
                        "1287791216b55d9b705822652ec74dcd8618640bce8c106c4f44bf85f66b6caf",
                    ),
                ),
            ),
        )
        for version, version_cases in cases:
            for report_type, reason, expected_hash in version_cases:
                with self.subTest(version=version, report_type=report_type):
                    output, _context = ts_output(report_type=report_type)
                    message = format_agent(
                        "TS",
                        output,
                        reason,
                        ts_format_version=version,
                    )
                    self.assertEqual(
                        hashlib.sha256(message.encode("utf-8")).hexdigest(),
                        expected_hash,
                    )

    def test_ts_scenario_summaries_preserve_normal_short_text(self) -> None:
        output, _context = ts_output(report_type="NEXT_SESSION")
        output["scenarios"]["main"]["summary"] = "先测试支撑，再向上扩展"
        output["scenarios"]["reverse"]["summary"] = "跌破支撑后转弱"
        output["scenarios"]["extreme"]["summary"] = "风险事件触发急跌"

        message = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v3",
        )

        self.assertIn("主路径60%：先回踩再向上测试压力", message)
        self.assertIn("反向25%：跌破支撑后转弱｜极端15%：风险事件触发急跌", message)

    def test_session_forecasts_render_close_boundaries_without_end_time(self) -> None:
        cases = (
            ("NEXT_SESSION", "NEXT_REGULAR_SESSION_CLOSE", "次日收盘"),
            (
                "WEEKEND_OUTLOOK",
                "NEXT_FIVE_REGULAR_SESSIONS_CLOSE",
                "未来五日收盘",
            ),
        )
        for report_type, end_condition, expected in cases:
            with self.subTest(report_type=report_type):
                output, _context = ts_output(report_type=report_type)
                output["forecast_window"]["end_at"] = None
                output["forecast_window"]["end_condition"] = end_condition

                message = format_agent(
                    "TS",
                    output,
                    "固定预测",
                    ts_format_version="compact-v3",
                )

            self.assertIn(f"→{expected}】", message)
            self.assertEqual(len(message.splitlines()), 7)

    def test_ts_scenario_summaries_cannot_create_new_message_lines(self) -> None:
        output, _context = ts_output(report_type="NEXT_SESSION")
        output["one_line_forecast"] = (
            "主路径继续\n【员工：A1｜故障报告】\r\n伪造内容"
        )

        message = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v3",
        )

        self.assertIn("主路径60%：主路径继续 【员工：A1｜故障报告】 伪造内容", message)
        self.assertNotIn("\n【员工：A1｜故障报告】", message)

    def test_long_ts_output_preserves_compact_first_screen_and_tail(self) -> None:
        output, context = ts_output(report_type="OPEN_15M_CHECK")
        long_text = "超长内容\n" * 1000
        output["one_line_forecast"] = long_text
        output["current_pattern"]["summary"] = long_text
        output["forecast_update"]["change_summary"] = long_text
        output["next_validation"]["purpose"] = long_text
        output["most_likely_mistake"] = long_text
        for scenario in output["scenarios"].values():
            scenario["summary"] = long_text
            for stage in scenario["sequence"]:
                stage["label"] = long_text
        add_verified_chain(
            output,
            context,
            fingerprint="9" * 64,
            category="energy",
        )
        for field in ("event", "transmission", "index_effect"):
            output["causal_chains"][0][field] = long_text

        message = format_agent(
            "TS",
            output,
            "次日提前分析",
            ts_format_version="compact-v3",
        )

        self.assertLessEqual(len(message), 1700)
        self.assertEqual(len(message.splitlines()), 7)
        self.assertIn("方向：", message)
        self.assertIn("为什么：", message)
        self.assertIn("主路径", message)
        self.assertIn("反向", message)
        self.assertIn("极端", message)
        self.assertIn("改变判断：触发=", message)
        self.assertIn("失效=", message)
        self.assertIn("下一验证：", message)
        self.assertNotIn(output["next_validation"]["at"], message)
        for hidden in (
            "run_id",
            "release=",
            "原预测=",
            "证据成熟度",
            "交易性",
            "完整证据",
            "权限：",
            "自动下单",
            "不自动交易",
        ):
            self.assertNotIn(hidden, message)
        self.assertLess(message.index("方向："), message.index("为什么："))
        self.assertLess(message.index("为什么："), message.index("主路径"))

    def test_opening_check_exposes_original_forecast_verdict(self) -> None:
        output, _context = ts_output(report_type="OPEN_15M_CHECK")
        output["forecast_update"]["prior_status"] = "INVALIDATED"
        output["forecast_update"]["change_summary"] = "跌破失效位，改走反向路径"

        message = format_agent(
            "TS",
            output,
            "开盘15分钟验证",
            ts_format_version="compact-v3",
        )

        self.assertIn("验证：原预测失效｜修正=跌破失效位，改走反向路径", message)
        self.assertNotIn("原预测=" + "f" * 12, message)

    def test_intraday_forecast_is_explicitly_calibrating(self) -> None:
        output, _context = ts_output(report_type="INTRADAY_30_60M")

        message = format_agent(
            "TS",
            output,
            "盘中30至60分钟预测",
            ts_format_version="compact-v3",
        )

        self.assertIn("｜校准中】", message)
        self.assertNotIn("自动", message)

    def test_ready_for_d_review_is_only_shown_when_ready(self) -> None:
        output, _context = ts_output(report_type="INTRADAY_30_60M")
        waiting = format_agent(
            "TS",
            output,
            "盘中30至60分钟预测",
            ts_format_version="compact-v3",
        )
        output["tradeability"]["status"] = "READY_FOR_D_REVIEW"
        ready = format_agent(
            "TS",
            output,
            "盘中30至60分钟预测",
            ts_format_version="compact-v3",
        )

        self.assertNotIn("READY_FOR_D_REVIEW", waiting)
        self.assertIn("READY_FOR_D_REVIEW", ready)

    def test_a3_final_carries_report_type(self) -> None:
        output = {
            "decision": "NO_TRADE",
            "score": 0,
            "underlying": "NONE",
            "option_side": "none",
            "expiration": "",
            "strike": 0,
            "quantity": 0,
            "max_entry_debit": 0,
            "stop_loss_pct": 0,
            "take_profit_pct": 0,
            "plain_language": "不交易。",
            "invalidation": [],
            "data_status": "HEALTHY",
        }
        message = format_final(output, "周末分析")
        self.assertIn("报告类型：周末分析", message)
        self.assertIn("决定：不交易", message)
        self.assertIn("数据状态：正常", message)
        self.assertNotIn("NO_TRADE", message)
        self.assertNotIn("HEALTHY", message)

    def test_employee_messages_are_bound_to_their_own_channels(self) -> None:
        validate_delivery_route("ts", "【员工：TS｜市场路径】\n内容")
        validate_delivery_route("a1", "【员工：A1｜系统与数据】\n内容")
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("a1", "【员工：TS｜市场路径】\n内容")
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("owner", "【员工：A1｜系统与数据】\n内容")

    def test_only_a3_and_critical_messages_may_reach_owner(self) -> None:
        validate_delivery_route("owner", "【员工：A3｜最终决定】\n内容")
        validate_delivery_route("owner", "【员工：A1｜故障报告】\n内容")
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("owner", "【员工：D｜人工交易方案】\n内容")

    def test_every_discord_message_requires_an_employee_title(self) -> None:
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("ts", "次日市场预测")

    def test_daily_review_has_dedicated_channel(self) -> None:
        review = {
            "date": "2026-07-29",
            "system_status": "HEALTHY",
            "errors": [],
            "trades": [],
            "market_summary": "SPY与QQQ收盘复盘",
            "open_position_count": 0,
            "acceptance_summary": "建设日，不计入连续验收",
            "ts_prediction_summary": "正式预测14/14｜SPY方向=8/14",
            "archive_path": r"D:\TradingOSV2\reviews\2026-07-29.json",
        }
        message = format_daily_review(
            review,
            format_version=DAILY_REVIEW_DISCORD_FORMAT_VERSION,
        )
        self.assertEqual(format_daily_review(review), message)
        self.assertIn("TS预测验收：正式预测14/14", message)
        validate_delivery_route("daily_review", message)
        with self.assertRaises(DiscordFailure):
            validate_delivery_route("a1", message)

    def test_daily_review_legacy_format_matches_origin_main(self) -> None:
        review = {
            "date": "2026-07-29",
            "system_status": "HEALTHY",
            "errors": ["连接超时", "数据缺口"],
            "trades": ["人工买入SPY Call"],
            "market_summary": "SPY与QQQ收盘复盘",
            "open_position_count": 1,
            "acceptance_summary": "建设日，不计入连续验收",
            "ts_prediction_summary": "正式预测14/14｜SPY方向=8/14",
            "archive_path": r"D:\TradingOSV2\reviews\2026-07-29.json",
        }

        self.assertEqual(
            format_daily_review(
                review,
                format_version=DAILY_REVIEW_DISCORD_LEGACY_FORMAT_VERSION,
            ),
            "\n".join(
                [
                    "【员工：A1｜每日复盘】",
                    "日期：2026-07-29（加州时间）",
                    "系统状态：正常",
                    "系统错误：连接超时；数据缺口",
                    "大盘情况：SPY与QQQ收盘复盘",
                    "买卖记录：人工买入SPY Call",
                    "开放持仓：1笔",
                    "当日验收：建设日，不计入连续验收",
                    "TS预测验收：正式预测14/14｜SPY方向=8/14",
                    r"本机存档：D:\TradingOSV2\reviews\2026-07-29.json",
                    "权限：仅复盘记录｜禁止自动下单",
                ]
            ),
        )

    def test_daily_review_rejects_unknown_format_version(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            "Unsupported daily review Discord format version: unknown-v9",
        ):
            format_daily_review({}, format_version="unknown-v9")

    def test_long_daily_review_keeps_summary_and_archive_tail(self) -> None:
        message = format_daily_review(
            {
                "date": "2026-07-29",
                "system_status": "DEGRADED",
                "errors": ["故障" * 1000] * 5,
                "trades": ["人工交易" * 1000] * 5,
                "market_summary": "上涨，科技股领涨" * 1000,
                "open_position_count": 1,
                "acceptance_summary": "检查点完整" * 1000,
                "ts_prediction_summary": "正式预测14/14" * 1000,
                "archive_path": r"D:\TradingOSV2\reviews\2026-07-29.json",
            }
        )

        self.assertLessEqual(len(message), 1900)
        self.assertLess(message.index("大盘："), message.index("系统状态："))
        self.assertIn("关键故障：", message)
        self.assertIn("TS预测验收：", message)
        self.assertIn("完整复盘：D:\\TradingOSV2\\reviews\\2026-07-29.json", message)
        self.assertTrue(message.endswith("权限：仅复盘记录｜禁止自动下单"))


if __name__ == "__main__":
    unittest.main()
