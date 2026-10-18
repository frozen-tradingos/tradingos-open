import assert from "node:assert/strict";
import test from "node:test";
import { collectExternalOptionQuote, collectRobinhoodAccount, collectRobinhoodReadonly } from "../server/robinhood-mcp.ts";
import { createExternalExpertMonitor } from "../server/external-expert-monitor.ts";
import { parseOutputEnvelope } from "../app/snapshot-import.ts";

const at = "2026-09-04T17:00:00.000Z", instrumentId = "11111111-1111-4111-8111-111111111111";
const response = (data) => ({ content: [], structuredContent: { data } });
const filter = { symbol: "TSLA", expiration: "2026-09-11", strike: 100, option_type: "put" };
function quoteSession(updatedAt, onQuote = () => {}) {
  return { async call(tool) {
    if (tool === "get_option_instruments") return response({ instruments: [{ id: instrumentId, chain_symbol: filter.symbol, expiration_date: filter.expiration, strike_price: "100", type: filter.option_type }] });
    if (tool === "get_option_quotes") {
      onQuote();
      return response({ results: [{ quote: { instrument_id: instrumentId, updated_at: updatedAt, mark_price: "2", bid_price: "1.9", ask_price: "2.1" } }] });
    }
    throw new Error(`unexpected read ${tool}`);
  } };
}

test("future or missing source quote times never become zero-age fresh evidence", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  for (const quoteTime of ["2026-09-04T17:00:01.000Z", null, "invalid"]) {
    assert.equal(await collectExternalOptionQuote(quoteSession(quoteTime), filter), null);
  }
  assert.equal(await collectExternalOptionQuote(quoteSession("2026-09-04T17:00:01.000Z"), filter, at), null);
});

test("external observations preserve actual quote receipt rather than task-start time", async (context) => {
  const finish = Date.parse(at) + 31_000, quoteTime = new Date(finish - 1_000).toISOString();
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const writes = [], store = { getExternalExpertOverview: () => ({ cases: [{ case_id: "synthetic-case", status: "OPEN", realtime_class: "LIVE", expert: { ...filter, instrument: "PUT", cost_basis: 1 }, market: {} }] }), recordExternalExpertEvent: (event) => writes.push(event) };
  const monitor = createExternalExpertMonitor(store, async (facts) => collectExternalOptionQuote(quoteSession(quoteTime, () => context.mock.timers.setTime(finish)), facts));
  await monitor.runOnce(new Date(at));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].received_at, new Date(finish).toISOString());
  assert.equal(writes[0].source_published_at, quoteTime);
  assert.equal(writes[0].market.freshness_seconds, 1);
  const bad = createExternalExpertMonitor(store, async () => ({ contract_id: instrumentId, quoted_at: new Date(finish + 1_000).toISOString(), received_at: new Date(finish).toISOString(), mark: 100, freshness_seconds: 0 }));
  await bad.runOnce(new Date(at));
  assert.equal(writes.length, 1);
});

test("FULL freezes stable redacted orders, exact legs and real fills without inventing execution", async (context) => {
  const orderReceivedAt = Date.parse(at) + 2_000, finish = Date.parse(at) + 122_000;
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const orders = [
    { id: "source-filled-order", chain_symbol: "TSLA", state: "filled", direction: "debit", quantity: "2", processed_quantity: "2", price: "2.1", premium: "420", created_at: at, updated_at: "2026-09-04T17:00:01.000Z", legs: [{ id: "source-leg", option_id: instrumentId, side: "buy", position_effect: "open", ratio_quantity: "1", executions: [{ id: "source-fill-one", timestamp: at, price: "1.95", quantity: "1" }, { id: "source-fill-two", timestamp: "2026-09-04T17:00:01.000Z", price: "2", quantity: "1" }] }] },
    { id: "source-cancelled-order", chain_symbol: "TSLA", state: "cancelled", quantity: "1", processed_quantity: "0", created_at: at, legs: [{ option_id: "https://api.robinhood.com/accounts/private-account/", side: "buy", executions: [] }] },
    { chain_symbol: "TSLA", state: "confirmed", quantity: "1", created_at: at },
  ];
  const calls = [], session = { async call(tool) {
    calls.push(tool);
    if (tool === "get_accounts") return response({ accounts: [{ account_number: "private-account", rhs_account_number: "private-rhs" }] });
    if (tool === "get_option_positions") return response({ positions: [{ option_id: instrumentId, chain_symbol: "TSLA", type: "long", quantity: "2", average_price: "197.5" }] });
    if (tool === "get_option_orders") { context.mock.timers.setTime(orderReceivedAt); return response({ orders }); }
    if (tool === "get_portfolio") return response({ total_value: "1000", options_value: "395" });
    if (tool === "get_realized_pnl") return response({ total_returns: "0" });
    if (tool === "get_option_instruments") return response({ instruments: [{ id: instrumentId, type: "put", expiration_date: filter.expiration, strike_price: "100" }] });
    if (tool === "get_option_quotes") { context.mock.timers.setTime(finish); return response({ results: [{ quote: { instrument_id: instrumentId, updated_at: new Date().toISOString(), bid_price: "1.9", ask_price: "2" } }] }); }
    throw new Error(`unexpected read ${tool}`);
  } };
  const first = await collectRobinhoodAccount(session);
  assert.equal(first.as_of, at);
  const evidence = first.orders[0].evidence;
  assert.ok(evidence?.order_id);
  assert.equal(evidence.received_at, new Date(orderReceivedAt).toISOString());
  assert.equal(evidence.processed_quantity, 2);
  assert.equal(evidence.updated_at, "2026-09-04T17:00:01.000Z");
  assert.equal(evidence.legs[0].contract_id, instrumentId);
  assert.deepEqual(evidence.legs[0].executions.map((fill) => [fill.quantity, fill.price, fill.executed_at]), [[1, 1.95, at], [1, 2, "2026-09-04T17:00:01.000Z"]]);
  assert.notEqual(evidence.legs[0].executions[0].execution_id, evidence.legs[0].executions[1].execution_id);
  assert.equal(first.orders[1].evidence.processed_quantity, 0);
  assert.equal(first.orders[1].evidence.legs[0].contract_id, null);
  assert.deepEqual(first.orders[1].evidence.legs[0].executions, []);
  assert.equal(first.orders[2].evidence.order_id, null);
  assert.equal(first.orders[2].evidence.processed_quantity, null);
  assert.equal(first.orders[2].evidence.legs, null);
  assert.ok(!/private-account|private-rhs|source-filled-order|source-fill-one|https:/.test(JSON.stringify(first)));
  const again = await collectRobinhoodAccount(session, at);
  assert.equal(again.orders[0].evidence.order_id, evidence.order_id);
  assert.equal(again.orders[0].evidence.legs[0].executions[0].execution_id, evidence.legs[0].executions[0].execution_id);
  calls.length = 0;
  assert.equal((await collectRobinhoodAccount(session, at, "POSITIONS")).orders, null);
  assert.ok(!calls.includes("get_option_orders"));
});

test("FULL keeps its existing cutoff contract when the provider responds later, and optional order evidence round-trips", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const projection = await collectRobinhoodReadonly({ async call(tool, args) {
    if (tool === "get_equity_quotes") { context.mock.timers.setTime(Date.parse(at) + 2_000); return response({ results: args.symbols.map((symbol) => ({ quote: { symbol, last_trade_price: "100", previous_close: "99", bid_price: "99", ask_price: "101", updated_at: new Date(Date.parse(at) + 1_000).toISOString() } })) }); }
    if (tool === "get_equity_historicals") return response({ results: args.symbols.map((symbol) => ({ symbol, bars: Array.from({ length: 40 }, (_, index) => ({ begins_at: new Date(Date.parse(at) - (41 - index) * 86_400_000).toISOString(), open_price: "99", high_price: "101", low_price: "98", close_price: "100", volume: "1000" })) })) });
    return response({});
  } }, at);
  assert.equal(projection.capabilities.quotes, true);
  projection.account = { source: "ROBINHOOD", status: "LIVE", as_of: at, freshness_seconds: 0, account_count: 1, portfolio_value: null, option_value: null, realized_pnl: null, positions: [], orders: [{ account_label: "账户-" + "a".repeat(16), symbol: "TSLA", state: "cancelled", direction: null, quantity: 1, price: null, premium: null, created_at: at, evidence: { order_id: "order-" + "a".repeat(32), received_at: at, updated_at: null, processed_quantity: 0, legs: [{ leg_id: null, contract_id: instrumentId, side: "buy", position_effect: "open", ratio_quantity: 1, executions: [] }] } }] };
  const envelope = { gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "synthetic-evidence:A1", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: at, payload: { contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: "LIVE", status: "BLOCKED", observed_at: at, data_cutoff_at: at, freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: "synthetic/evidence", market_snapshot_id: projection.snapshot_id, market_snapshot_hash: projection.snapshot_hash, data_gaps: [], v2_result: {}, market_sources: projection } };
  const parse = () => parseOutputEnvelope(JSON.stringify(envelope)).payload.market_sources.account.orders[0];
  assert.deepEqual(parse(), projection.account.orders[0]);
  projection.account.orders[0].evidence.legs[0].contract_id = "https://api.robinhood.com/accounts/private-account/";
  assert.throws(parse);
  delete projection.account.orders[0].evidence;
  assert.deepEqual(parse(), projection.account.orders[0]);
});
