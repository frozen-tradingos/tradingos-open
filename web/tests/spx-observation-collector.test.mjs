import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessExecutableQuote } from "../app/spx-convexity-ledger.ts";
import { collectSpxObservationCandidate } from "../server/robinhood-mcp.ts";
import { SYNTHETIC_CAPITAL_CONTEXT as OWNER_CAPITAL_CONTEXT_V1, openSyntheticInvestmentStore as openSnapshotDatabase } from "./synthetic-investment.mjs";

const at = "2026-09-14T17:00:00.000Z", dates = ["2026-09-21", "2026-10-14"];
const chainId = "11111111-1111-4111-8111-111111111111";
const instrument = (index, expiration = dates[0], type = "call") => ({ id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`, chain_id: chainId, chain_symbol: "SPXW", expiration_date: expiration, strike_price: String(6000 + index * 5), type, state: "active", tradability: "tradable", trade_value_multiplier: "100" });
const quote = (row) => ({ instrument_id: row.id, bid_price: "1.00", ask_price: "1.04", mark_price: "1.02", updated_at: at, delta: row.type === "call" ? ".45" : "-.45", volume: "10", open_interest: "100" });
function fixture({ expirations = dates, pages = [[instrument(1)] , [instrument(2, dates[1])]], override = (_tool, _args, response) => response } = {}) {
  const calls = [], chains = [
    { id: chainId, symbol: "SPXW", settle_on_open: false, expiration_dates: expirations },
    { id: "33333333-3333-4333-8333-333333333333", symbol: "SPX", settle_on_open: true, expiration_dates: dates },
  ];
  const byExpiry = new Map(dates.map((date, index) => [date, Array.isArray(pages[index]?.[0]) ? pages[index] : [pages[index] ?? []]]));
  const all = [...byExpiry.values()].flat(2), byId = new Map(all.map((row) => [row.id, row]));
  const session = { async listTools() { throw Error("collector must not broaden tool discovery"); }, async call(tool, args) {
    calls.push({ tool, args: structuredClone(args) });
    let response;
    if (tool === "get_option_chains") { assert.deepEqual(args, { underlying_symbol: "SPX" }); response = { structuredContent: { data: { chains } } }; }
    else if (tool === "get_option_instruments") {
      assert.equal(args.chain_id, chainId); assert.equal("strike_price" in args, false);
      assert.equal(args.state, "active"); assert.equal(args.tradability, "tradable");
      const index = args.cursor ? Number(args.cursor) : 0, list = byExpiry.get(args.expiration_dates) ?? [[]];
      response = { structuredContent: { data: { instruments: list[index] ?? [], next: index + 1 < list.length ? `https://api.robinhood.com/options/instruments/?cursor=${index + 1}` : null } } };
    } else if (tool === "get_option_quotes") {
      assert.ok(args.instrument_ids.length <= 100);
      response = { structuredContent: { data: { results: args.instrument_ids.map((id) => ({ quote: quote(byId.get(id)) })) } } };
    } else throw Error(`Unexpected provider call ${tool}`);
    return override(tool, args, response);
  } };
  return { calls, session };
}
function setup(context) { context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) }); }
const select = (mcp, extra = {}) => collectSpxObservationCandidate(mcp.session, { direction: "BULLISH", capitalContext: OWNER_CAPITAL_CONTEXT_V1, observedAt: at, ...extra });

test("SPXW research selects real 7/30-day identities and Delta before cheap or tighter-spread tails", async (context) => {
  setup(context);
  const mcp = fixture({ expirations: ["2026-09-14", "2026-09-15", ...dates.toReversed(), "2026-10-15", "2026-12-14"], override(tool, _args, response) {
    if (tool === "get_option_quotes") {
      Object.assign(response.structuredContent.data.results[0].quote, { bid_price: ".20", ask_price: ".205", delta: ".02", volume: "999" });
      Object.assign(response.structuredContent.data.results[1].quote, { delta: ".49", volume: "22", open_interest: "120" });
    }
    return response;
  } });
  const capital = structuredClone(OWNER_CAPITAL_CONTEXT_V1), result = await select(mcp, { capitalContext: capital });
  assert.equal(result.candidate.contract.contract_id, instrument(2).id);
  assert.deepEqual([result.candidate.contract.chain_symbol, result.candidate.contract.settlement, result.candidate.contract.option_type], ["SPXW", "PM", "call"]);
  assert.deepEqual([result.candidate.volume, result.candidate.open_interest], [22, 120]);
  assert.equal(result.candidate.capital_assessment.fit, "NORMAL_FIT");
  assert.equal(result.candidate.quote_assessment.status, "PASS");
  assert.deepEqual(result.selection, { rule: "SPXW_PAPER_7_30_V1", dte_min: 7, dte_max: 30, expirations: dates, scanned_contracts: 2, quoted_contracts: 2, rpc_calls: 4, scope: "EARLIEST_TWO_VERIFIED_SPXW_PM_EXPIRIES", complete: true });
  assert.ok(result.reasons.includes("OWNER_RISK_LIMIT_UNCONFIGURED")); assert.ok(result.reasons.includes("RESEARCH_ONLY_NOT_APPROVAL_OR_FILL"));
  assert.doesNotMatch(JSON.stringify(mcp.calls), /7650|7695|SPY|underlying_price|spot_price|review_|place_/);
  assert.deepEqual(capital, OWNER_CAPITAL_CONTEXT_V1);
});

test("complete pagination includes later-page contracts; clean empty dates and exclusions never invent substitutes", async (context) => {
  setup(context);
  const mcp = fixture({ pages: [[[instrument(1)], [instrument(2)]], []], override(tool, _args, response) {
    if (tool === "get_option_quotes") response.structuredContent.data.results[1].quote.delta = ".5";
    return response;
  } });
  assert.equal((await select(mcp)).candidate.contract.contract_id, instrument(2).id);
  assert.deepEqual(mcp.calls.filter((call) => call.tool === "get_option_instruments").map((call) => call.args.cursor), [undefined, "1", undefined]);
  const emptyFirst = fixture({ pages: [[], [instrument(3, dates[1])]] });
  assert.equal((await select(emptyFirst)).candidate.contract.expiration_date, dates[1]);
  const empty = fixture({ pages: [[], []] }), excluded = fixture();
  for (const [source, extra] of [[empty, {}], [excluded, { excludeContractIds: [instrument(1).id, instrument(2).id] }]]) {
    const result = await select(source, extra); assert.equal(result.candidate, null);
    assert.ok(result.reasons.includes("SPXW_NO_NEW_VERIFIED_CONTRACT"));
    assert.equal(source.calls.some((call) => call.tool === "get_option_quotes"), false);
  }
  const noDate = fixture({ expirations: ["2026-09-14", "2026-09-15", "2026-10-15", "2026-12-14"] });
  assert.ok((await select(noDate)).reasons.includes("SPXW_NO_7_30_DTE_EXPIRATION")); assert.equal(noDate.calls.length, 1);
  const oneDate = fixture({ expirations: [dates[0], "2026-12-14"] }), one = await select(oneDate);
  assert.deepEqual(one.selection.expirations, [dates[0]]); assert.equal(one.candidate.contract.expiration_date, dates[0]);
});

test("SPXW follows the observed bare cursor verbatim and preserves its verified chain filters", async (context) => {
  setup(context);
  const cursor = "cD03ODcuMDAwMA==", mcp = fixture({ expirations: [dates[0]], pages: [[instrument(1), instrument(2)]], override(tool, args, response) {
    if (tool === "get_option_instruments") {
      response.structuredContent.data.instruments = [instrument(args.cursor ? 2 : 1)];
      response.structuredContent.data.next = args.cursor ? "" : cursor;
    }
    if (tool === "get_option_quotes") response.structuredContent.data.results[1].quote.delta = ".5";
    return response;
  } });
  const result = await select(mcp);
  assert.equal(result.candidate.contract.contract_id, instrument(2).id); assert.equal(result.selection.complete, true);
  const calls = mcp.calls.filter((call) => call.tool === "get_option_instruments");
  assert.deepEqual(calls.map((call) => call.args.cursor), [undefined, cursor]);
  assert.deepEqual(calls[1].args, { ...calls[0].args, cursor });
  assert.equal(result.selection.rpc_calls, 4);
});

test("malformed, mismatched and unfinished instrument sources block before quotes", async (context) => {
  setup(context);
  for (const fault of ["bad-chain", "chain-next", "duplicate-chain", "wrong-chain", "wrong-expiry", "wrong-type", "untradable", "bad-id", "bad-strike", "bad-row", "duplicate-id", "bad-next", "bad-raw-next", "repeat-cursor", "raw-repeat-cursor", "page-limit", "raw-page-limit"]) {
    const mcp = fixture({ override(tool, args, response) {
      const data = response.structuredContent.data;
      if (tool === "get_option_chains") {
        if (fault === "bad-chain") data.chains[0].settle_on_open = true;
        if (fault === "chain-next") data.next = "https://provider.invalid/?cursor=next";
        if (fault === "duplicate-chain") data.chains.push({ ...data.chains[0] });
      }
      if (tool === "get_option_instruments") {
        const row = data.instruments[0];
        if (fault === "wrong-chain") row.chain_symbol = "SPY";
        if (fault === "wrong-expiry") row.expiration_date = "2026-12-18";
        if (fault === "wrong-type") row.type = "put";
        if (fault === "untradable") row.tradability = "untradable";
        if (fault === "bad-id") row.id = "invented";
        if (fault === "bad-strike") row.strike_price = "0";
        if (fault === "bad-row") data.instruments.push(null);
        if (fault === "duplicate-id") data.instruments.push({ ...row });
        if (fault === "bad-next") data.next = "https://provider.invalid/no-cursor";
        if (fault === "bad-raw-next") data.next = "bad\ncursor";
        if (["repeat-cursor", "raw-repeat-cursor", "page-limit", "raw-page-limit"].includes(fault)) {
          const cursor = fault.endsWith("repeat-cursor") ? "1" : String(Number(args.cursor ?? 0) + 1);
          data.instruments = []; data.next = fault.startsWith("raw-") ? cursor : `https://provider.invalid/?cursor=${cursor}`;
        }
      }
      return response;
    } });
    const result = await select(mcp);
    assert.equal(result.candidate, null, fault); assert.equal(result.selection.complete, false, fault);
    assert.ok(result.reasons.includes("SPXW_COLLECTION_BLOCKED"), fault);
    assert.equal(mcp.calls.some((call) => call.tool === "get_option_quotes"), false, fault);
    assert.ok(mcp.calls.length <= 4, fault);
  }
});

test("real direction, fresh exact BBO and Owner capital remain necessary research evidence", async (context) => {
  setup(context);
  for (const fault of ["missing", "duplicate", "wrong-id", "future", "stale", "zero-bid", "crossed", "no-mark", "no-delta", "zero-delta", "unit-delta", "wrong-sign", "wide-relative", "capital-unfit", "no-capital", "provider-error"]) {
    const mcp = fixture({ override(tool, _args, response) {
      if (tool !== "get_option_quotes") return response;
      const data = response.structuredContent.data;
      if (fault === "missing") data.results = [];
      if (fault === "duplicate") data.results.push(structuredClone(data.results[0]));
      if (fault === "provider-error") return { isError: true, content: [{ type: "text", text: "private provider details" }] };
      for (const { quote: q } of data.results) {
        if (fault === "wrong-id") q.instrument_id = instrument(99).id;
        if (fault === "future") q.updated_at = "2026-09-14T17:00:00.001Z";
        if (fault === "stale") q.updated_at = "2026-09-14T16:57:59.000Z";
        if (fault === "zero-bid") q.bid_price = "0";
        if (fault === "crossed") q.bid_price = "2";
        if (fault === "no-mark") q.mark_price = null;
        if (fault === "no-delta") q.delta = null;
        if (fault === "zero-delta") q.delta = "0";
        if (fault === "unit-delta") q.delta = "1";
        if (fault === "wrong-sign") q.delta = "-.4";
        if (fault === "wide-relative") q.ask_price = "1.2";
        if (fault === "capital-unfit") { q.bid_price = "2.98"; q.ask_price = "3"; }
      }
      return response;
    } });
    const result = await select(mcp, fault === "no-capital" ? { capitalContext: null } : {});
    assert.equal(result.candidate, null, fault); assert.ok(result.reasons.length > 0, fault);
    assert.doesNotMatch(JSON.stringify(result), /private provider details/);
  }
  const puts = fixture({ pages: [[instrument(1, dates[0], "put")], [instrument(2, dates[1], "put")]] });
  assert.ok((await select(puts, { direction: "BEARISH" })).candidate.quote.delta < 0);
  const invalid = fixture(); assert.equal((await select(invalid, { direction: "RANGE" })).candidate, null); assert.equal(invalid.calls.length, 0);
  const partial = fixture({ override(tool, _args, response) { if (tool === "get_option_quotes") response.structuredContent.data.results.pop(); return response; } });
  const partialResult = await select(partial);
  assert.ok(partialResult.candidate); assert.equal(partialResult.selection.complete, false);
  assert.equal(partialResult.selection.quoted_contracts, 1); assert.ok(partialResult.reasons.includes("SPXW_QUOTES_MISSING"));
});

test("research can retain a wider absolute spread without changing the formal blocked assessment", async (context) => {
  setup(context);
  const capital = { ...OWNER_CAPITAL_CONTEXT_V1, available_capital_usd: 10_000, normal_premium_usd: { min: 500, max: 2000, max_capital_pct: 25 }, strong_opportunity_usd: { max: 3000, max_capital_pct: 30 } };
  const mcp = fixture({ override(tool, _args, response) {
    if (tool === "get_option_quotes") for (const { quote: q } of response.structuredContent.data.results) Object.assign(q, { bid_price: "10", ask_price: "10.30", mark_price: "10.15" });
    return response;
  } });
  const result = await select(mcp, { capitalContext: capital });
  assert.ok(result.candidate); assert.equal(result.candidate.quote_assessment.status, "BLOCKED");
  assert.equal(result.candidate.quote_assessment.reason, "SPREAD_TOO_WIDE");
  assert.ok(result.reasons.includes("FORMAL_QUOTE_BLOCKED:SPREAD_TOO_WIDE"));
  assert.ok(result.reasons.includes("OWNER_RISK_LIMIT_UNCONFIGURED"));
  assert.equal(result.candidate.capital_assessment.position_recommendation, "NOT_PROVIDED");
  const directory = await mkdtemp(join(tmpdir(), "spx-collector-store-")), store = openSnapshotDatabase(join(directory, "check.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.recordOwnerCapitalContext({ ...capital, version: "9.0.0", effective_at: at, change_reason: "Isolated collector/store regression" }, at);
  const charts = [["SPY", 100, .2], ["QQQ", 200, .4]].map(([symbol, start, step]) => ({ source: "ROBINHOOD", symbol, interval: "5m", status: "LIVE", bars: Array.from({ length: 42 }, (_, index) => { const close = start + step * index; return { begins_at: new Date(Date.parse("2026-09-14T13:30:00Z") + index * 300_000).toISOString(), open: close - step / 2, high: close + step / 2, low: close - step / 2, close, volume: 10_000 + index }; }) }));
  const regime = store.recordTsMarketCharts(charts, at).insertedIntradayEvents[0];
  const auto = { rule: "SPXW_PAPER_7_30_V1", regime_event_id: regime.event_id, created_from: "NATURAL_A1_HEARTBEAT", observed_at: at };
  const { contract, quote: selectedQuote } = result.candidate;
  const create = (bbo) => store.createSpxOptionWatch(contract, bbo, "Isolated collector/store regression", at, null, null, null, auto);
  for (const bbo of [{ ...selectedQuote, delta: -.5 }, { ...selectedQuote, delta: null }, { ...selectedQuote, mark: null }, { ...selectedQuote, quoted_at: "2026-09-14T16:57:59.999Z" }, { ...selectedQuote, ask: 20 }, { ...selectedQuote, bid: 100, ask: 101 }]) assert.throws(() => create(bbo));
  const watch = create(selectedQuote).watches[0];
  assert.equal(watch.strategy_context.signal_source.source_mode, "SYSTEM_SIMULATED_RESEARCH");
  assert.deepEqual(watch.created_quote, selectedQuote);
  assert.equal(assessExecutableQuote(watch.created_quote, at, at).reason, "SPREAD_TOO_WIDE");
  assert.equal(watch.is_real_holding, false);
});

test("two complete three-page expiries and 1000 quotes fit the 17-RPC ceiling; excess never selects a partial chain", async (context) => {
  setup(context);
  const pages = dates.map((expiration, half) => [0, 1, 2].map((page) => Array.from({ length: page < 2 ? 166 : 168 }, (_, index) => instrument(1 + half * 500 + page * 166 + index, expiration))));
  const mcp = fixture({ pages }), result = await select(mcp);
  assert.ok(result.candidate); assert.equal(result.selection.scanned_contracts, 1000); assert.equal(result.selection.quoted_contracts, 1000);
  assert.equal(mcp.calls.length, 17); assert.equal(result.selection.rpc_calls, 17);
  assert.equal(mcp.calls.filter((call) => call.tool === "get_option_quotes").length, 10);
  const excess = fixture({ pages: [Array.from({ length: 1001 }, (_, index) => instrument(index + 1)), []] }), blocked = await select(excess);
  assert.equal(blocked.candidate, null); assert.ok(blocked.reasons.includes("SPXW_INSTRUMENT_LIMIT_EXCEEDED"));
  assert.equal(excess.calls.some((call) => call.tool === "get_option_quotes"), false);
});

test("a slow later batch cannot return an earlier quote that aged out during collection", async (context) => {
  setup(context);
  let batches = 0;
  const mcp = fixture({ pages: [Array.from({ length: 101 }, (_, index) => instrument(index + 1)), []], override(tool, _args, response) {
    if (tool === "get_option_quotes" && ++batches === 2) context.mock.timers.setTime(Date.parse(at) + 121_000);
    return response;
  } });
  const result = await select(mcp);
  assert.equal(result.candidate, null); assert.ok(result.reasons.includes("SPXW_QUOTE_NOT_CURRENT_BBO"));
});
