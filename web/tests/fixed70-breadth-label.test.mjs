import assert from "node:assert/strict";
import test from "node:test";
import { applyFixed70SwingManagement } from "../server/robinhood-mcp.ts";

test("fixed70 regime labels name the actual universe without changing compatibility values or thresholds", () => {
  const frame = { timeframe: "1d", direction: "BEARISH", support: 98, resistance: 102, return_pct: -1, pattern: "descending_triangle", state: "breakdown_watch" };
  const row = { symbol: "SPY", direction: "BEARISH", status: "LIVE", last: 100, timeframes: { daily: frame, four_hour: frame, one_hour: frame, thirty_minute: frame }, swing: { stage: "CONFIRMED", direction: "BEARISH", aligned_timeframes: 4, missing_confirmation: [], next_check: "下一自然槽" } };
  const snapshot = { generated_at: "2026-09-08T14:30:40.473Z", fixed_pool: { rows: [row], breadth: { advance_pct: 52.2 }, missing_gates: [], candidates: [] }, real_positions: { status: "NOT_OBSERVED", symbols: [] }, earnings_center: { items: [] }, event_scan: { items: [] } };
  const environment = { rates: { status: "LIVE" }, oil: { status: "LIVE" }, sector_breadth: { advance_pct: 36.4 } };
  const before = structuredClone({ snapshot, environment });
  for (const [breadth, regime] of [[52.2, "CHOPPY"], [40, "CHOPPY"], [60, "CHOPPY"], [39.9, "TRENDING"], [60.1, "TRENDING"]]) {
    const input = structuredClone(snapshot); input.fixed_pool.breadth.advance_pct = breadth;
    const context = applyFixed70SwingManagement(input, null, environment).fixed_pool.rows[0].swing.management.market_context;
    assert.equal(context.sector_breadth_advance_pct, breadth, "legacy field preserves fixed70 value, not the different 11-ETF value");
    assert.equal(context.regime, regime, "40/60 decision boundaries remain unchanged");
    assert.equal(context.reason.includes("固定70上涨占比"), true);
    assert.equal(context.reason.includes("11个板块ETF"), false);
  }
  assert.deepEqual({ snapshot, environment }, before);
});

test("expansion stocks cannot redefine core breadth or overwrite the legacy snapshot", () => {
  const frame = { timeframe: "1d", direction: "BULLISH", support: 98, resistance: 102, return_pct: 1, pattern: "ascending_triangle", state: "breakout_watch" };
  const row = (symbol, change) => ({ symbol, change_pct: change, direction: "BULLISH", status: "LIVE", last: 100, timeframes: { daily: frame, four_hour: frame, one_hour: frame, thirty_minute: frame }, swing: { stage: "CONFIRMED", direction: "BULLISH", aligned_timeframes: 4, missing_confirmation: [], next_check: "next natural slot" } });
  const snapshot = { contract_version: "v3", generated_at: "2026-09-14T15:30:00.000Z", fixed_pool: { rows: [row("SPY", 1), row("QQQ", null), row("MP", 10), row("USAR", 20)], breadth: { advance_pct: 75 }, missing_gates: [], candidates: [] }, real_positions: { status: "NOT_OBSERVED", symbols: [] }, earnings_center: { items: [] }, event_scan: { items: [] } };
  const before = structuredClone(snapshot);
  const result = applyFixed70SwingManagement(snapshot, null);
  for (const item of result.fixed_pool.rows) {
    assert.equal(item.swing.management.market_context.sector_breadth_advance_pct, 50);
    assert.equal(item.swing.management.market_context.regime, "CHOPPY");
    assert.match(item.swing.management.market_context.reason, /核心70上涨占比/);
  }
  assert.equal(result.fixed_pool.breadth.advance_pct, 75, "display coverage retains the complete watch universe");
  assert.deepEqual(snapshot, before);
});
