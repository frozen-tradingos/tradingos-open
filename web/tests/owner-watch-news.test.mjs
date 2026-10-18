import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_EXTRA_STOCKS, APPROVED_STOCKS } from "../app/snapshot-import.ts";
import { inferNewsSymbols } from "../app/market-intelligence.ts";
import { stockPlanEvidenceGaps, validateStockPlanEvidence } from "../app/stock-manual-plan.ts";
import { collectStockPlanEvidence } from "../server/stock-plan-evidence.ts";
import { collectFinnhubOfficial } from "../server/finnhub.ts";

// Synthetic, injected responses only: no credentials, provider traffic or production records.
const at = "2026-09-14T15:30:00.000Z";
const response = (value) => new Response(JSON.stringify(value));
const row = (symbol, stage = "CONFIRMED", status = "LIVE") => ({ symbol, status, swing: { stage, direction: "BULLISH" } });
const names = {
  MP: "MP Materials", USAR: "USA Rare Earth", UUUU: "Energy Fuels", UAMY: "United States Antimony", LAC: "Lithium Americas", FCX: "Freeport-McMoRan",
  CVX: "Chevron Corporation", COP: "ConocoPhillips", OXY: "Occidental Petroleum", SLB: "Schlumberger Limited", BKR: "Baker Hughes", LNG: "Cheniere Energy", KMI: "Kinder Morgan",
  UEC: "Uranium Energy Corp", LEU: "Centrus Energy", BWXT: "BWX Technologies", NRG: "NRG Energy", VRT: "Vertiv Holdings", HUBB: "Hubbell Incorporated", INTC: "Intel Corporation",
};

test("Owner company news precedes mature candidates within the unchanged three-company deadline and evidence boundary", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  const fixed_pool = {
    candidates: ["MP", "USAR", "XOP", "UNKNOWN", "NVDA", "AMD", "CVX", "TSLA"],
    rows: [row("MP", "WAIT"), row("XOP"), row("UNKNOWN"), row("NVDA", "CONFIRMED", "DATA_BLOCKED"), row("AMD", "WAIT"), row("CVX", "EARLY_WATCH"), row("TSLA")],
  };
  for (const [owner_watchlist, expected] of [
    [{ status: "OBSERVED", items: ["XOP", "UNKNOWN", "MP", "USAR", "MP"], reason: "fixture owner interests" }, ["MP", "USAR", "CVX"]],
    [{ status: "NOT_OBSERVED", items: ["MP", "USAR"], reason: "not observed" }, ["CVX", "TSLA"]],
    [{ status: "OBSERVED", items: ["MP", "USAR", "UUUU", "UAMY", "LAC"], reason: "fixture owner interests" }, ["MP", "USAR", "UUUU"]],
    [undefined, ["CVX", "TSLA"]],
  ]) {
    const calls = [], approvedCapabilities = { fixed_pool, ...(owner_watchlist ? { owner_watchlist } : {}) };
    const before = JSON.stringify(approvedCapabilities);
    const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", approvedCapabilities,
      request: async (input, options) => {
        const url = new URL(input); calls.push({ url, signal: options.signal });
        if (url.pathname.endsWith("/calendar/earnings")) return response({ earningsCalendar: [] });
        if (!url.pathname.endsWith("/company-news")) return response([]);
        const symbol = url.searchParams.get("symbol");
        return response([{ id: 1, headline: `${names[symbol] ?? symbol} announces a company update`, source: "Reuters", datetime: Date.parse(at) / 1_000 - 60, related: "", url: `https://example.test/${symbol}` }]);
      },
    }, at);
    assert.deepEqual(calls.filter(({ url }) => url.pathname.endsWith("/company-news")).map(({ url }) => url.searchParams.get("symbol")), expected);
    assert.equal(calls.length, 2 + expected.length);
    assert.ok(calls.length <= 5);
    assert.equal(new Set(calls.map(({ signal }) => signal)).size, 1);
    assert.equal(update.source.status, "LIVE");
    assert.equal(update.events.length, expected.length);
    for (const [index, event] of update.events.entries()) {
      assert.ok(event.affected_symbols.includes(expected[index]));
      assert.equal(JSON.parse(event.raw_json).request.symbol, expected[index]);
      assert.equal(event.event_evidence_state, "UNVERIFIED");
      assert.equal(event.importance, "NOT_VERIFIED");
      assert.equal(event.event_fingerprint, null);
    }
    assert.equal(JSON.stringify(approvedCapabilities), before, "news selection never mutates the original setup or Owner list");
  }
});

test("all twenty expansion company names map to equities and their earnings survive the existing 100-event cap", async () => {
  assert.deepEqual(Object.keys(names).sort(), [...APPROVED_EXTRA_STOCKS].sort());
  for (const [symbol, name] of Object.entries(names)) assert.deepEqual(inferNewsSymbols(`${name.toUpperCase()} announces results`), [symbol], name);
  assert.deepEqual(inferNewsSymbols("LNG prices, a COP meeting and LEU supply"), [], "ambiguous ticker words do not masquerade as company names");
  const earningsCalendar = [
    ...Array.from({ length: 100 }, (_, index) => ({ symbol: `ZZ${index}`, revenueEstimate: 1_000_000 })),
    ...APPROVED_EXTRA_STOCKS.map((symbol) => ({ symbol, revenueEstimate: 1 })),
  ].map((entry) => ({ ...entry, date: "2026-09-15", hour: "amc", epsActual: 1, epsEstimate: 1, revenueActual: 2 }));
  const calls = [];
  const update = await collectFinnhubOfficial({ credentialPath: "unused", token: "fixture-token", request: async (input) => {
    const url = new URL(input); calls.push(url.pathname);
    return response(url.pathname.endsWith("/calendar/earnings") ? { earningsCalendar } : []);
  } }, at);
  assert.equal(calls.length, 2);
  assert.equal(update.events.length, 100);
  assert.deepEqual(update.events.slice(0, 20).map((event) => event.affected_symbols[0]), APPROVED_EXTRA_STOCKS);
  assert.ok(update.events.every((event) => !event.earnings_result.reported && event.earnings_result.eps_actual === null && event.earnings_result.revenue_actual === null), "future earnings stay unreported even when the response contains actual fields");
});

test("expanded stock collection and validation share the equity allowlist without relaxing setup or missing-source gates", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
  assert.equal(APPROVED_STOCKS.length, 70);
  const accepted = [];
  for (let index = 0; index < APPROVED_EXTRA_STOCKS.length; index += 3) {
    const selected = APPROVED_EXTRA_STOCKS.slice(index, index + 3), calls = [];
    const input = {
      run_id: "live-shadow:20260914T153000Z", slot_id: "live-shadow:20260914T153000Z", source_snapshot_id: "fixture-owner-watch", source_snapshot_hash: "a".repeat(64),
      approvedCapabilities: { generated_at: at, source: "ROBINHOOD_OFFICIAL_TRADING_MCP", owner_watchlist: { status: "OBSERVED", items: ["MP", "USAR"], reason: "fixture" },
        fixed_pool: { candidates: ["XOP", "SPY", "UNKNOWN", ...selected, "AAPL"], rows: [row("XOP"), row("SPY"), row("UNKNOWN"), ...selected.map((symbol) => row(symbol)), row("AAPL", "WAIT")] } },
      news: { checked_at: at, status: "LIVE", items: [] }, global_risk: { checked_at: at, critical_blockers: [], new_entry_blockers: [] },
      classifyPatterns: async (batches) => batches.map(() => null),
    };
    const session = { listTools: async () => assert.fail("no discovery"), call: async (tool, args) => { calls.push({ tool, args }); throw Error("synthetic missing provider"); } };
    const evidence = await collectStockPlanEvidence(session, input);
    assert.deepEqual(evidence.map((entry) => entry.symbol), selected);
    assert.deepEqual(calls.find((call) => call.tool === "get_equity_quotes").args.symbols, selected);
    assert.ok(calls.length <= 32);
    assert.ok(calls.every((call) => ["get_equity_quotes", "get_equity_historicals", "get_accounts", "get_option_chains"].includes(call.tool)));
    for (const entry of evidence) {
      assert.equal(validateStockPlanEvidence(entry), entry);
      assert.equal(entry.automated_execution, false);
      assert.equal(entry.mode, "SHADOW");
      assert.equal(entry.contracts.length, 0);
      assert.ok(entry.data_gaps.includes("ACCOUNT_NOT_CURRENT"));
      assert.ok(stockPlanEvidenceGaps(entry, Date.parse(at)).includes("没有仍在有效期内的已核验公司或大盘新闻依据"));
      for (const symbol of ["XOP", "SPY", "XSP", "UNKNOWN"]) assert.throws(() => validateStockPlanEvidence({ ...entry, symbol }), /evidence.stock/);
      accepted.push(entry.symbol);
    }
    for (const entry of input.approvedCapabilities.fixed_pool.rows) entry.swing.stage = "WAIT";
    calls.length = 0;
    assert.deepEqual(await collectStockPlanEvidence(session, input), [], "Owner interest alone cannot enter the formal evidence lane");
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(accepted, APPROVED_EXTRA_STOCKS);
});
