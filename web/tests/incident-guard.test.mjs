import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const baselineRoot = process.env.SQLITE_MAINTENANCE_BASELINE_ROOT;
const { openSnapshotDatabase } = await import(baselineRoot ? pathToFileURL(join(baselineRoot, "build/local-data-core.ts")) : new URL("../build/local-data-core.ts", import.meta.url));
const { collectLocalMaintenanceFindings, createIncidentGuard, gthBarContinuityFinding, scanDesktopCrashes } = await import(baselineRoot ? pathToFileURL(join(baselineRoot, "server/incident-guard.ts")) : new URL("../server/incident-guard.ts", import.meta.url));
const { collectRobinhoodMarketChart, selectChartSessions } = await import("../server/robinhood-mcp.ts");
const { cleanEnvironment, offlineDoctor } = await import("../../tools/public-entry.mjs");
const { publicAutomationEnabled } = await import("../server/public-runtime.ts");

const closedMarket = { source: "ROBINHOOD", symbol: "SPY", interval: "5m", status: "MARKET_CLOSED", as_of: "2026-08-12T20:00:00.000Z", freshness_seconds: 0, market_session: "POSTMARKET", current_price: 1, bars: [], error: null };

test("guard freshness uses completed check time while finding and source times stay at observation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-completion-")), store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const startedAt = "2026-09-27T21:50:06.823Z", completedAt = "2026-09-27T21:52:06.314Z";
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse(startedAt) });
  store.backup = async () => {};
  store.reconcileIncidents([], "test", "2026-09-27T21:45:00.000Z");
  let expectedBefore = "2026-09-27T21:45:00.000Z";
  const guard = createIncidentGuard({ store, dataRoot: directory, siteVersion: "test", pageProbe: async () => false, marketProbe: async () => closedMarket, desktopProbe: async () => {
    assert.equal(store.getSelfCheck().checked_at, expectedBefore, "incomplete check cannot renew evidence");
    if (expectedBefore !== completedAt) context.mock.timers.setTime(Date.parse(completedAt)); return [];
  } });
  await guard.runOnce();
  assert.equal(store.getSelfCheck().checked_at, completedAt);
  assert.equal(store.getSelfCheck().active.find((item) => item.code === "PAGE_API_FAILED").first_detected_at, startedAt);
  assert.equal(store.getDataSources().find((item) => item.source === "ROBINHOOD").checked_at, startedAt);
  assert.equal(store.getCodexManagerState().online_status, "ONLINE");
  context.mock.timers.setTime(Date.parse(completedAt) + 180_001);
  assert.equal(store.getCodexManagerState().online_status, "OFFLINE", "truly stale completed evidence still warns");
  const stateBeforeFailure = store.getSelfCheck().checked_at;
  expectedBefore = completedAt;
  const reconcile = store.reconcileIncidents;
  store.reconcileIncidents = () => { throw new Error("test storage failure"); };
  await guard.runOnce();
  store.reconcileIncidents = reconcile;
  assert.equal(store.getSelfCheck().checked_at, stateBeforeFailure, "failed completion must not renew the timestamp");
});

test("guard reads fresh snapshots off-thread and checks opening data without rebuilding the site", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-responsive-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const slotId = "live-shadow:20260825T133000Z", at = new Date("2026-08-25T13:32:01.000Z");
  store.claimTsCoreSlot(slotId, slotId, "scheduler", "2026-08-25T13:30:00.000Z");
  const events = [], getActive = store.getActive.bind(store), getDataSources = store.getDataSources?.bind(store);
  let snapshots = 0, synchronousReads = 0, sourceReads = 0, recoveries = 0;
  store.getActive = (...args) => { synchronousReads++; return getActive(...args); };
  store.getDataSources = (...args) => { sourceReads++; return getDataSources(...args); };
  for (const method of ["getActiveAsync", "getScheduleLedgerSupervisionAsync"]) {
    const read = store[method]?.bind(store);
    store[method] = async (...args) => {
      const index = ++snapshots;
      events.push(`snapshot:${index}`);
      const state = await read(...args);
      setImmediate(() => events.push(`heartbeat:${index}`));
      return state;
    };
  }
  const guard = createIncidentGuard({
    store, siteVersion: "test", dataRoot: directory, now: () => at,
    pageProbe: async () => true, desktopProbe: async () => [],
    marketProbe: async () => {
      setImmediate(() => events.push("heartbeat:0"));
      return { ...closedMarket, status: "LIVE", as_of: at.toISOString(), quote_freshness_seconds: 1, bar_freshness_seconds: 421 };
    },
    recoverShadow: async () => { recoveries += 1; return { status: "COMPLETED" }; },
  });
  const result = await guard.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synchronousReads, 0, "no full projection may run on Guard's event loop");
  assert.equal(snapshots, 3, "truth, current state and schedule supervision must each read a fresh full snapshot");
  assert.equal(sourceReads, 1, "opening lease must read its current data-source fields directly");
  for (let index = 1; index <= snapshots; index += 1) {
    const heartbeat = events.indexOf(`heartbeat:${index - 1}`);
    assert.ok(heartbeat >= 0 && heartbeat < events.indexOf(`snapshot:${index}`), `heartbeat ${index - 1} must run before snapshot ${index}: ${events.join(", ")}`);
  }
  assert.equal(result.findings.find((item) => item.code === "SOURCE_GAP")?.details.core_running_blocked, true);
  assert.equal(recoveries, 0, "yielding must not bypass the opening data contract");
  assert.equal(store.getTsCoreSlotOwnership(slotId).status, "LEASED");
});

test("Windows desktop crash probe accepts an empty event window", { skip: process.platform !== "win32" }, async () => assert.ok(Array.isArray(await scanDesktopCrashes())));

test("GTH continuity uses the actual prior session across weekdays, weekends and holidays without extra requests", async () => {
  for (const [day, priorDay] of [["2026-08-13", "2026-08-12"], ["2026-08-17", "2026-08-14"], ["2026-09-08", "2026-09-04"]]) {
    const at = new Date(`${day}T00:15:00.000Z`), calls = [];
    const bars = [`${priorDay}T19:55:00.000Z`, `${priorDay}T23:55:00.000Z`, `${day}T00:10:00.000Z`].map((begins_at) => ({ begins_at, open_price: "1", high_price: "1", low_price: "1", close_price: "1", volume: "10" }));
    const session = { async call(tool, args) {
      calls.push({ tool, args });
      const symbol = args.symbols[0];
      return { content: [], structuredContent: { results: tool === "get_equity_quotes" ? [{ quote: { symbol, last_trade_price: "1", venue_last_trade_time: at.toISOString() } }] : [{ symbol, bars }] } };
    } };
    const complete = await Promise.all(["SPY", "QQQ"].map((symbol) => collectRobinhoodMarketChart(session, symbol, "5m", at.toISOString(), "5d")));
    assert.equal(calls.length, 4, "one quote and one history request per symbol; no new batch");
    assert.ok(calls.filter((call) => call.tool === "get_equity_historicals").every((call) => Date.parse(call.args.start_time) === at.getTime() - 10 * 86_400_000));
    assert.equal(gthBarContinuityFinding(complete, at), null, day);
    assert.deepEqual(complete[0].session_dates, [priorDay, day]);
    const oneDay = complete.map((chart) => ({ ...chart, bars: selectChartSessions(chart.bars, "1d").bars }));
    assert.deepEqual(gthBarContinuityFinding(oneDay, at)?.details.symbols, ["SPY", "QQQ"], "one trading-date view loses the required prior sessions");
    for (const phase of ["REGULAR", "AFTER_HOURS", "OVERNIGHT"]) {
      const missing = structuredClone(complete); missing[0].bars = missing[0].bars.filter((bar) => bar.session !== phase);
      assert.deepEqual(gthBarContinuityFinding(missing, at)?.details.symbols, ["SPY"], `${day} missing ${phase}`);
    }
    const old = structuredClone(complete); old[0].bars[0].trading_date = "2026-08-03";
    assert.equal(gthBarContinuityFinding(old, at)?.details.previous_trading_date, priorDay, "arbitrary older RTH cannot substitute for the previous session");
    const stale = structuredClone(complete); stale[0].status = "STALE";
    assert.deepEqual(gthBarContinuityFinding(stale, at)?.details.symbols, ["SPY"]);
    assert.ok(gthBarContinuityFinding(complete, new Date(at.getTime() + 420_001)), "stale bars cannot prove recovery even with a LIVE label");
    const future = structuredClone(complete); future[0].bars.at(-1).begins_at = new Date(at.getTime()).toISOString();
    assert.deepEqual(gthBarContinuityFinding(future, at)?.details.symbols, ["SPY"], "an unfinished GTH bar is not evidence");
  }
});

test("GTH incident remains pending outside its detection window and through probe errors until evidence recovers", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-continuity-")), store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let at = new Date("2026-08-13T00:15:00.000Z"), mode = "missing", priorDay = "2026-08-12", tradingDay = "2026-08-13";
  const bar = (session, trading_date, begins_at) => ({ begins_at, open: 1, high: 1, low: 1, close: 1, volume: 1, session, trading_date, data_grade: "OFFICIAL_OHLCV" });
  const guard = createIncidentGuard({ store, dataRoot: directory, siteVersion: "test", now: () => at, pageProbe: async () => true, desktopProbe: async () => [], marketProbe: async () => {
    if (mode === "throw") throw Error("read unavailable");
    return ["SPY", "QQQ"].map((symbol) => ({ ...closedMarket, symbol, status: "LIVE", as_of: at.toISOString(), bar_as_of: at.toISOString(), quote_freshness_seconds: 0, bar_freshness_seconds: 0,
      bars: [...(mode === "complete" ? [bar("REGULAR", priorDay, `${priorDay}T19:55:00.000Z`)] : []), bar("AFTER_HOURS", priorDay, `${priorDay}T23:55:00.000Z`), bar("OVERNIGHT", tradingDay, `${tradingDay}T00:10:00.000Z`), bar(at.getUTCHours() >= 14 ? "REGULAR" : "OVERNIGHT", tradingDay, new Date(at.getTime() - 300_000).toISOString())] }));
  } });
  await guard.runOnce();
  const first = store.getSelfCheck().active.find((item) => item.code === "GTH_BAR_CONTINUITY_BROKEN");
  assert.ok(first);
  at = new Date("2026-08-13T01:15:00.000Z");
  await guard.runOnce();
  assert.equal(store.getSelfCheck().active.find((item) => item.code === first.code)?.first_detected_at, first.first_detected_at, "leaving 20:00 ET must not imply recovery");
  mode = "throw"; await guard.runOnce();
  assert.equal(store.getSelfCheck().active.find((item) => item.code === first.code)?.details.recovery_verification, "PENDING_RECHECK");
  at = new Date("2026-09-28T14:00:00.000Z"); priorDay = "2026-09-25"; tradingDay = "2026-09-28";
  mode = "missing"; await guard.runOnce();
  const rechecked = store.getSelfCheck().active.find((item) => item.code === first.code);
  assert.equal(rechecked.details.trading_date, tradingDay, "long-offline recovery checks the current expected rollover, even outside 20 ET");
  assert.equal(rechecked.details.first_detected_trading_date, first.details.trading_date, "original affected date survives later verification");
  assert.equal(rechecked.first_detected_at, first.first_detected_at);
  mode = "complete"; await guard.runOnce();
  assert.equal(store.getSelfCheck().active.some((item) => item.code === first.code), false);
  const resolved = store.getSelfCheck().recent.find((item) => item.code === first.code);
  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.details.first_detected_trading_date, first.details.trading_date, "recovery retains the original affected date");
  const complaint = store.listComplaints().find((item) => item.problem.includes("交易日期切换"));
  assert.equal(complaint.status, "SHADOW_FIXED");
  assert.equal(complaint.history[0].recorded_at, first.first_detected_at, "original incident history remains present");
});

test("GTH recovery requires the latest expected rollover and keeps the ten-minute opening grace", () => {
  const bar = (session, trading_date, begins_at) => ({ begins_at, open: 1, high: 1, low: 1, close: 1, volume: 1, session, trading_date, data_grade: "OFFICIAL_OHLCV" });
  const prior = gthBarContinuityFinding([], new Date("2026-09-17T00:15:00.000Z"));
  assert.equal(gthBarContinuityFinding([], new Date("2026-09-28T00:04:00.000Z"), prior)?.details.trading_date, "2026-09-25", "Sunday opening grace still targets the last completed rollover");
  for (const [time, expectedDay, previousDay, freshPhase] of [
    ["2026-09-28T14:00:00.000Z", "2026-09-28", "2026-09-25", "REGULAR"],
    ["2026-09-28T01:15:00.000Z", "2026-09-28", "2026-09-25", "OVERNIGHT"],
    ["2026-09-29T00:04:00.000Z", "2026-09-28", "2026-09-25", "AFTER_HOURS"],
    ["2026-09-29T00:10:00.000Z", "2026-09-29", "2026-09-28", "OVERNIGHT"],
  ]) {
    const at = new Date(time), bars = [bar("REGULAR", previousDay, `${previousDay}T19:55:00.000Z`), bar("AFTER_HOURS", previousDay, `${previousDay}T23:55:00.000Z`), bar("OVERNIGHT", expectedDay, `${expectedDay}T00:00:00.000Z`), bar(freshPhase, expectedDay, freshPhase === "AFTER_HOURS" ? `${expectedDay}T23:55:00.000Z` : new Date(at.getTime() - 300_000).toISOString())];
    const charts = ["SPY", "QQQ"].map((symbol) => ({ ...closedMarket, symbol, status: "LIVE", bars }));
    assert.equal(gthBarContinuityFinding(charts, at, prior), null, time);
    for (const phase of ["REGULAR", "AFTER_HOURS", "OVERNIGHT"]) {
      const missing = charts.map((chart) => ({ ...chart, bars: bars.filter((item) => item.session !== phase) }));
      const finding = gthBarContinuityFinding(missing, at, prior);
      assert.equal(finding?.details.trading_date, expectedDay, `${time}: missing ${phase} cannot recover`);
      assert.equal(finding?.details.previous_trading_date, previousDay);
    }
    const stale = charts.map((chart) => ({ ...chart, bars: bars.filter((item) => Date.parse(item.begins_at) + 300_000 < at.getTime() - 420_000) }));
    assert.ok(gthBarContinuityFinding(stale, at, prior), "a LIVE label without a fresh complete bar cannot recover");
  }
});

test("guard suppresses a false missed slot during an active Shadow run and waits on shutdown", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-shutdown-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  let releasePage;
  const pageStarted = new Promise((resolve) => {
    releasePage = resolve;
  });
  let enteredPage;
  const entered = new Promise((resolve) => {
    enteredPage = resolve;
  });
  let recoveries = 0;
  const guard = createIncidentGuard({
    store,
    siteVersion: "test",
    dataRoot: directory,
    now: () => new Date("2026-08-12T14:10:00.000Z"),
    pageProbe: async () => { enteredPage(); await pageStarted; return true; },
    marketProbe: async () => ({ ...closedMarket, status: "LIVE", freshness_seconds: 10 }),
    desktopProbe: async () => [],
    recoverShadow: async () => { recoveries += 1; return { status: "COMPLETED" }; },
    shadowRunning: (slotId) => slotId === "live-shadow:20260812T140000Z",
  });
  const run = guard.runOnce();
  await entered;
  let stopped = false;
  const stopping = guard.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releasePage();
  const result = await run;
  await stopping;
  assert.equal(result.findings.some((item) => item.code === "SCHEDULE_MISSED"), false);
  assert.equal(recoveries, 0);
});

test("opening data reservation waits through stale bars and recovers once only after the 420-second contract is ready", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-opening-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const slotId = "live-shadow:20260825T133000Z";
  store.claimTsCoreSlot(slotId, slotId, "scheduler", "2026-08-25T13:30:00.000Z");
  let at = new Date("2026-08-25T13:32:01.000Z"), barAge = 421, recoveries = 0;
  const guard = createIncidentGuard({
    store, siteVersion: "test", dataRoot: directory, now: () => at,
    pageProbe: async () => true, desktopProbe: async () => [],
    marketProbe: async () => ({ ...closedMarket, status: "LIVE", as_of: at.toISOString(), freshness_seconds: 1, quote_freshness_seconds: 1, bar_freshness_seconds: barAge }),
    recoverShadow: async () => { recoveries += 1; return { status: "COMPLETED" }; },
  });
  await guard.runOnce();
  assert.equal(recoveries, 0);
  const openingGap = store.getSelfCheck().active.find((item) => item.code === "SOURCE_GAP");
  assert.deepEqual([openingGap.severity, openingGap.details.core_running_blocked], ["CRITICAL", true]);
  barAge = 1;
  at = new Date("2026-08-25T13:32:02.000Z");
  await guard.runOnce();
  await guard.runOnce();
  assert.equal(recoveries, 1);
  assert.equal(store.getCodexManagerEventPayloads("TS_CORE_RECOVERY_ATTEMPTED", "recovery").length, 1);
});

test("expired TS Core lease resumes a slot interrupted after Run Ledger start", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-interrupted-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const slotId = "live-shadow:20260812T140000Z";
  store.claimTsCoreSlot(slotId, slotId, "interrupted", "2026-08-12T14:00:00.000Z");
  for (const [status, eventAt] of [["STARTED", "2026-08-12T14:00:01.000Z"], ["RUNNING", "2026-08-12T14:00:02.000Z"]]) store.importRunEventRaw(JSON.stringify(liveEvent("A1", status, eventAt)));
  let recoveries = 0;
  const guard = createIncidentGuard({
    store, siteVersion: "test", dataRoot: directory, now: () => new Date("2026-08-12T14:10:00.000Z"),
    pageProbe: async () => true, desktopProbe: async () => [], marketProbe: async () => ({ ...closedMarket, status: "LIVE", freshness_seconds: 10 }),
    recoverShadow: async () => {
      recoveries += 1;
      store.claimTsCoreSlot(slotId, slotId, "recovery", "2026-08-12T14:10:00.000Z");
      store.completeTsCoreSlot(slotId, "recovery", "SYSTEM_BLOCKED", null, null, "2026-08-12T14:10:01.000Z");
      return { status: "SYSTEM_BLOCKED", runId: slotId, slotId };
    },
  });
  await guard.runOnce();
  await guard.runOnce();
  assert.deepEqual([recoveries, store.getTsCoreSlotOwnership(slotId).status, store.getCodexManagerEventPayloads("TS_CORE_RECOVERY_ATTEMPTED", "recovery").length], [1, "TERMINAL", 1]);
});

test("overnight stale Quote with live Bar is one non-blocking provider-session limitation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-overnight-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const at = new Date("2026-08-26T05:49:00.000Z");
  const guard = createIncidentGuard({
    store, siteVersion: "test", dataRoot: directory, now: () => at, pageProbe: async () => true, desktopProbe: async () => [],
    marketProbe: async () => ["SPY", "QQQ"].map((symbol) => ({ ...closedMarket, symbol, status: "LIVE", as_of: "2026-08-26T05:45:00.000Z", quote_as_of: "2026-08-25T19:59:59.000Z", quote_freshness_seconds: 35_941, bar_as_of: "2026-08-26T05:45:00.000Z", bar_freshness_seconds: 240, gap_status: null })),
  });
  await guard.runOnce();
  const source = store.getActive().dataSources.find((item) => item.source === "ROBINHOOD"), active = store.getSelfCheck().active;
  assert.deepEqual([source.status, source.capabilities.market_quotes, source.capabilities.intraday_bars], ["DEGRADED", false, true]);
  assert.deepEqual(active.map((item) => item.code), ["EXPECTED_PROVIDER_SESSION_LIMIT"]);
  assert.equal(active[0].severity, "WARNING");
  assert.equal(active[0].details.owner_required, false);
});

test("overnight stale Bar without an active formal slot degrades without a red global block", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-overnight-gap-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const at = new Date("2026-08-26T06:19:00.000Z");
  const guard = createIncidentGuard({
    store, siteVersion: "test", dataRoot: directory, now: () => at, pageProbe: async () => true, desktopProbe: async () => [],
    marketProbe: async () => ["SPY", "QQQ"].map((symbol) => ({ ...closedMarket, symbol, status: "LIVE", quote_freshness_seconds: 36_000, bar_freshness_seconds: 421, gap_status: null })),
  });
  await guard.runOnce();
  const gap = store.getSelfCheck().active.find((item) => item.code === "SOURCE_GAP");
  assert.deepEqual([gap.severity, gap.details.core_running_blocked, gap.details.owner_required], ["WARNING", false, false]);
});

test("NEXT_SESSION forecast uses its target trading date in the deterministic truth probe", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-next-session-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const forecast = { report_type: "NEXT_SESSION", evidence_snapshot: { run_id: "next-session", market_time: { market_date: "2026-08-25" } } };
  const getActive = store.getActive.bind(store);
  store.getActive = () => { const state = getActive(); return { ...state, currentTruth: { forecast_id: "next-session", trading_date: "2026-08-26" }, outputs: { ...state.outputs, TS_SHADOW_OUTPUT: [forecast] } }; };
  const guard = createIncidentGuard({ store, siteVersion: "test", dataRoot: directory, now: () => new Date("2026-08-26T05:49:00.000Z"), pageProbe: async () => true, marketProbe: async () => closedMarket, desktopProbe: async () => [] });
  await guard.runOnce();
  assert.equal(store.getSelfCheck().active.some((item) => item.code === "CURRENT_FORECAST_TRUTH_CONTRADICTION"), false);
});

function liveEvent(component, status, at, overrides = {}) {
  const skills = { A1: "A1_LIVE_SHADOW", A2: "A2_LIVE_SHADOW", TS: "TS_LIVE_SHADOW", CODEX_GUARD: "CODEX_GUARD_LIVE_SHADOW" };
  return {
    ledger_format: "TRADING_OS_AGENT_RUN_EVENT",
    ledger_version: 1,
    event_id: `${component}-${status}-${at}`,
    agent_id: component,
    skill_id: skills[component],
    run_id: "live-shadow:20260812T140000Z",
    slot_id: "live-shadow:20260812T140000Z",
    channel: "SHADOW",
    version: "4070-live-shadow-v1",
    data_cutoff_at: "2026-08-12T14:00:00.000Z",
    event_at: at,
    status,
    output_status: "NOT_PRODUCED",
    error: null,
    evidence_refs: [],
    website_delivery: "NOT_ATTEMPTED",
    discord_delivery: "NOT_APPLICABLE",
    ...overrides,
  };
}

test("self-check records, deduplicates and resolves service, API, auth and database incidents", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-"));
  const dataRoot = join(directory, "data");
  const databasePath = join(dataRoot, "guard.sqlite");
  context.after(() => rm(directory, { recursive: true, force: true }));
  let store = openSnapshotDatabase(databasePath);
  let at = new Date("2026-08-12T14:10:00.000Z");
  let healthy = false;
  let desktop = true;
  let recoveries = 0;
  const pending = join(dataRoot, "incidents", "pending");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, "service-exit.json"), JSON.stringify({ fingerprint: "WEBSITE_PROCESS_EXIT", layer: "SERVICE", code: "WEBSITE_PROCESS_EXIT", severity: "CRITICAL", title: "Trading OS 网站进程异常退出", run_id: null, suggestion: "监督器自动恢复", details: { exit_code: 1, automatic_action: "监督器已重启网站", owner_required: false, forecast_impact: "恢复期间短暂不可用", history_impact: "SQLite 未删除" } }));
  const guard = createIncidentGuard({
    store,
    siteVersion: "test",
    dataRoot,
    now: () => at,
    pageProbe: async () => healthy,
    marketProbe: async () => healthy ? closedMarket : { ...closedMarket, status: "DATA_BLOCKED", error: "401 authorization expired" },
    desktopProbe: async () => desktop ? [{ event_id: 1000, time: at.toISOString(), provider: "Application Error", message: "Codex stopped" }] : [],
    recoverShadow: async () => { recoveries += 1; return { status: "DATA_BLOCKED" }; },
  });

  const first = await guard.runOnce();
  assert.equal(first.status, "CRITICAL");
  const codes = store.getSelfCheck().active.map((item) => item.code);
  for (const code of ["WEBSITE_PROCESS_EXIT", "PAGE_API_FAILED", "ROBINHOOD_AUTH_EXPIRED", "SCHEDULE_MISSED", "CODEX_DESKTOP_EXIT"]) assert.ok(codes.includes(code));
  assert.equal(store.getSelfCheck().active.find((item) => item.code === "ROBINHOOD_AUTH_EXPIRED").details.owner_required, true);
  assert.equal(store.getSelfCheck().active.find((item) => item.code === "ROBINHOOD_AUTH_EXPIRED").details.codex_required, false);
  assert.equal(recoveries, 1);
  assert.equal(store.listComplaints().length, codes.length);
  assert.equal(store.getSelfCheck().active.find((item) => item.code === "WEBSITE_PROCESS_EXIT").details.automatic_action, "监督器已重启网站");
  assert.match(store.listComplaints().find((item) => item.problem.includes("网站进程异常退出")).history[0].note, /系统动作：监督器已重启网站/);
  assert.equal((await readdir(pending)).length, 0);
  assert.equal((await readdir(join(dataRoot, "backups"))).length, 1);

  await guard.runOnce();
  assert.equal(recoveries, 1);
  assert.equal(store.listComplaints().length, codes.length);
  assert.ok(store.getSelfCheck().active.every((item) => item.occurrences === 2));

  store.close();
  store = openSnapshotDatabase(databasePath);
  assert.equal(store.getSelfCheck().active.length, codes.length - 1);
  at = new Date("2026-08-12T22:00:00.000Z");
  healthy = true;
  desktop = false;
  const recovered = createIncidentGuard({ store, siteVersion: "test", dataRoot, now: () => at, pageProbe: async () => true, marketProbe: async () => closedMarket, desktopProbe: async () => [] });
  assert.equal((await recovered.runOnce()).status, "HEALTHY");
  assert.equal(store.getSelfCheck().active.length, 0);
  assert.ok(store.listComplaints().every((complaint) => complaint.status === "SHADOW_FIXED" && complaint.history.length === 2));
  store.close();
});

test("self-check detects write, backup, stale data, agent, ledger and gateway failures", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-guard-failures-"));
  const dataRoot = join(directory, "data");
  const store = openSnapshotDatabase(join(dataRoot, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const originalCheck = store.checkDatabase;
  const originalBackup = store.backup;
  store.checkDatabase = () => { throw new Error("SQLITE_READONLY"); };
  store.backup = () => { throw new Error("disk full"); };
  const afterHours = createIncidentGuard({
    store,
    siteVersion: "test",
    dataRoot,
    now: () => new Date("2026-08-12T22:00:00.000Z"),
    pageProbe: async () => true,
    marketProbe: async () => ({ ...closedMarket, status: "LIVE", freshness_seconds: 421, quote_freshness_seconds: 421, bar_freshness_seconds: 421 }),
    desktopProbe: async () => [],
  });
  await afterHours.runOnce();
  for (const code of ["SQLITE_READ_WRITE_FAILED", "SQLITE_BACKUP_FAILED", "SOURCE_GAP"]) assert.ok(store.getSelfCheck().active.some((item) => item.code === code));
  assert.equal(store.getSelfCheck().active.filter((item) => item.layer === "DATA").length, 1);
  store.checkDatabase = originalCheck;
  store.backup = originalBackup;

  const sequences = {
    A1: [["STARTED", "2026-08-12T14:00:01.000Z"], ["RUNNING", "2026-08-12T14:00:02.000Z"]],
    A2: [["STARTED", "2026-08-12T14:00:03.000Z"], ["RUNNING", "2026-08-12T14:00:04.000Z"], ["FAILED", "2026-08-12T14:01:00.000Z"]],
    TS: [["STARTED", "2026-08-12T14:00:05.000Z"], ["RUNNING", "2026-08-12T14:00:06.000Z"], ["TIMED_OUT", "2026-08-12T14:08:00.000Z"]],
    CODEX_GUARD: [["STARTED", "2026-08-12T14:00:07.000Z"], ["RUNNING", "2026-08-12T14:00:08.000Z"], ["SUCCEEDED", "2026-08-12T14:01:10.000Z"]],
  };
  for (const [component, events] of Object.entries(sequences)) for (const [status, eventAt] of events) {
    const overrides = status === "FAILED" || status === "TIMED_OUT" ? { error: status } : status === "SUCCEEDED" ? { output_status: "PRODUCED", evidence_refs: ["sqlite://missing"], website_delivery: "FAILED", error: "gateway down" } : {};
    store.importRunEventRaw(JSON.stringify(liveEvent(component, status, eventAt, overrides)));
  }
  const cycles = join(dataRoot, "live-shadow", "cycles");
  await mkdir(cycles, { recursive: true });
  const cyclePath = join(cycles, "current.json");
  await writeFile(cyclePath, JSON.stringify({ runId: "live-shadow:20260812T140000Z", steps: { A1: { events: [JSON.stringify({ event_id: "missing-ledger-event" })], envelope: JSON.stringify({ record_id: "missing-output" }) } } }));
  await utimes(cyclePath, new Date("2026-08-12T14:09:00.000Z"), new Date("2026-08-12T14:09:00.000Z"));

  const marketHours = createIncidentGuard({ store, siteVersion: "test", dataRoot, now: () => new Date("2026-08-12T14:10:00.000Z"), pageProbe: async () => true, marketProbe: async () => ({ ...closedMarket, status: "LIVE", freshness_seconds: 10 }), desktopProbe: async () => [] });
  await marketHours.runOnce();
  const activeCodes = store.getSelfCheck().active.map((item) => item.code);
  for (const code of ["AGENT_STUCK", "AGENT_FAILED", "AGENT_TIMED_OUT", "WEBSITE_DELIVERY_FAILED", "RUN_LEDGER_WRITE_FAILED", "OUTPUT_GATEWAY_WRITE_FAILED"]) assert.ok(activeCodes.includes(code), code);
});

test("self-check keeps partial official macro outages distinct without declaring the whole company stopped", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-macro-guard-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const at = "2026-08-12T22:00:00.000Z", snapshotHash = "b".repeat(64);
  const officialMacro = {
    contract_version: "v1", component: "OFFICIAL_MACRO_CONTEXT", mode: "SHADOW", status: "DEGRADED", collected_at: at, as_of: at, context_hash: "c".repeat(64),
    providers: { BLS: { schedule_status: "DATA_BLOCKED", results_status: "LIVE", as_of: at, error: "calendar unavailable" }, BEA: { schedule_status: "LIVE", results_status: "NOT_OBSERVED", as_of: at, error: null } },
    events: [], results: [{ status: "MISSING", schedule_event_fingerprint: "d".repeat(64), release_name: "Consumer Price Index", scheduled_at: "2026-08-12T12:30:00.000Z" }], bls_macro_watch: {}, bls_official_news: {}, official_items: [], errors: ["calendar unavailable"],
  };
  store.importOutputRaw(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1, record_id: "macro-a1", output_type: "A1_SHADOW_RESULT", channel: "SHADOW", observed_at: at, payload: { contract_version: "v1", component: "A1", mode: "SHADOW", actionable: false, source_mode: "LIVE", status: "DEGRADED", observed_at: at, data_cutoff_at: at, freshness_seconds: 0, result_hash: "a".repeat(64), evidence_ref: "data/live-shadow/evidence/a1.json", market_snapshot_id: `market-${snapshotHash.slice(0, 24)}`, market_snapshot_hash: snapshotHash, data_gaps: ["OFFICIAL_MACRO_DEGRADED"], official_macro: officialMacro, v2_result: {} } }));
  const guard = createIncidentGuard({ store, siteVersion: "test", dataRoot: directory, now: () => new Date(at), pageProbe: async () => true, marketProbe: async () => closedMarket, desktopProbe: async () => [] });
  await guard.runOnce();
  const active = store.getSelfCheck().active;
  assert.equal(active.find((item) => item.code === "OFFICIAL_MACRO_CALENDAR_BLOCKED").severity, "WARNING");
  assert.equal(active.find((item) => item.code === "OFFICIAL_MACRO_RESULT_MISSING").severity, "WARNING");
});

test("self-check separates an upstream block from an Agent failure and escalates only after repeated recovery checks", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-upstream-guard-"));
  const store = openSnapshotDatabase(join(directory, "guard.sqlite"));
  context.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const [status, eventAt] of [["STARTED", "2026-08-12T14:00:01.000Z"], ["RUNNING", "2026-08-12T14:00:02.000Z"], ["DATA_BLOCKED", "2026-08-12T14:01:00.000Z"]]) {
    store.importRunEventRaw(JSON.stringify(liveEvent("A2", status, eventAt, status === "DATA_BLOCKED" ? { error: "market snapshot unavailable" } : {})));
  }
  const guard = createIncidentGuard({ store, siteVersion: "test", dataRoot: directory, now: () => new Date("2026-08-12T14:10:00.000Z"), pageProbe: async () => true, marketProbe: async () => ({ ...closedMarket, status: "LIVE", freshness_seconds: 10 }), desktopProbe: async () => [] });

  await guard.runOnce();
  let incident = store.getSelfCheck().active.find((item) => item.code === "AGENT_UPSTREAM_BLOCKED");
  assert.equal(incident.details.fault_origin, "UPSTREAM_DATA");
  assert.equal(incident.details.capability, "AGENT_INPUT");
  assert.equal(incident.details.owner_required, false);
  assert.equal(incident.details.codex_repair_task, null);
  assert.match(incident.details.next_check_at, /^2026-08-12T14:11:00/);

  await guard.runOnce();
  await guard.runOnce();
  incident = store.getSelfCheck().active.find((item) => item.code === "AGENT_UPSTREAM_BLOCKED");
  assert.equal(incident.details.owner_required, false);
  assert.equal(incident.details.codex_required, true);
  assert.match(incident.details.codex_repair_task, /影响模块：A2、本槽下游部门/);
  assert.match(incident.details.codex_repair_task, /market snapshot unavailable/);
  const complaint = store.listComplaints().find((item) => item.complaint_id === incident.complaint_id);
  assert.ok(complaint.history.some((item) => item.note.includes("已形成 Codex 维修任务")));
});

test("public readiness inspection cannot enable automation or production supervision", async (context) => {
  const original = process.env.TRADING_OS_PUBLIC_AUTOMATION;
  context.after(() => { if (original === undefined) delete process.env.TRADING_OS_PUBLIC_AUTOMATION; else process.env.TRADING_OS_PUBLIC_AUTOMATION = original; });
  for (const value of ["0", "false", "true", "yes", ""]) {
    process.env.TRADING_OS_PUBLIC_AUTOMATION = value;
    assert.equal(publicAutomationEnabled(), false);
    const before = offlineDoctor();
    assert.equal(before.external_requests, 0);
    assert.equal(before.mode, "BLANK_BY_DEFAULT");
    assert.equal(offlineDoctor().authorizationStepsComplete, before.authorizationStepsComplete);
    assert.equal(process.env.TRADING_OS_PUBLIC_AUTOMATION, value);
  }
  process.env.TRADING_OS_PUBLIC_AUTOMATION = "1";
  assert.equal(publicAutomationEnabled(), true);
  assert.equal(cleanEnvironment().TRADING_OS_PUBLIC_AUTOMATION, "0", "inherited consent cannot silently enable a new local run");
  await assert.rejects(readFile(new URL("../scripts/owner-service.ps1", import.meta.url)), { code: "ENOENT" });
});

test("local maintenance audits supervisor, scheduler, version, retention and disk without touching current data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-maintenance-"));
  const dataRoot = join(directory, "data");
  const runtimeEntry = join(directory, "runtime", "server", "index.js");
  const at = new Date("2026-08-13T06:00:00.000Z");
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(dataRoot, "maintenance"), { recursive: true });
  await mkdir(join(dataRoot, "logs"), { recursive: true });
  await mkdir(join(dataRoot, "backups"), { recursive: true });
  await mkdir(join(directory, "runtime", "server"), { recursive: true });
  await writeFile(runtimeEntry, "healthy-runtime");
  const runtimeSha256 = createHash("sha256").update("healthy-runtime").digest("hex");
  await writeFile(join(dataRoot, "maintenance", "supervisor-heartbeat.json"), JSON.stringify({ checked_at: at.toISOString(), server_pid: 4070, task_registered: true, runtime_sha256: runtimeSha256, deployed_commit: "abc123" }));
  const old = new Date("2026-06-01T00:00:00.000Z");
  const oldLog = join(dataRoot, "logs", "owner-service-2026-06-01.log");
  await writeFile(oldLog, "old");
  await utimes(oldLog, old, old);
  for (let index = 1; index <= 8; index += 1) {
    const backup = join(dataRoot, "backups", `trading-os-web-2026-06-0${index}.sqlite`);
    await writeFile(backup, "old");
    await utimes(backup, new Date(old.getTime() + index * 1000), new Date(old.getTime() + index * 1000));
  }

  const healthy = collectLocalMaintenanceFindings({ dataRoot, now: at, schedulerCheckedAt: at.toISOString(), runtimeEntry, diskFreeBytes: 10 * 1024 ** 3, diskTotalBytes: 50 * 1024 ** 3 });
  assert.deepEqual(healthy.map((item) => item.code), ["MAINTENANCE_RETENTION_CLEANUP"]);
  assert.equal((await readdir(join(dataRoot, "backups"))).length, 7);
  assert.equal((await readdir(join(dataRoot, "logs"))).length, 0);

  await writeFile(join(dataRoot, "maintenance", "supervisor-heartbeat.json"), JSON.stringify({ checked_at: at.toISOString(), server_pid: 4070, task_registered: true, runtime_sha256: runtimeSha256, deployed_commit: "UNKNOWN" }));
  const unknown = collectLocalMaintenanceFindings({ dataRoot, now: at, schedulerCheckedAt: at.toISOString(), runtimeEntry, diskFreeBytes: 10 * 1024 ** 3, diskTotalBytes: 50 * 1024 ** 3 });
  assert.ok(unknown.some((item) => item.code === "DEPLOYMENT_VERSION_UNKNOWN"));

  await writeFile(join(dataRoot, "maintenance", "supervisor-heartbeat.json"), JSON.stringify({ checked_at: at.toISOString(), server_pid: 0, task_registered: true, runtime_sha256: runtimeSha256, deployed_commit: "abc123", restart_attempts: 3, circuit_state: "BACKOFF", next_retry_at: "2026-08-13T06:00:30.000Z" }));
  const recovering = collectLocalMaintenanceFindings({ dataRoot, now: at, schedulerCheckedAt: at.toISOString(), runtimeEntry, diskFreeBytes: 10 * 1024 ** 3, diskTotalBytes: 50 * 1024 ** 3 });
  assert.equal(recovering.find((item) => item.code === "WEBSITE_RECOVERY_IN_PROGRESS")?.details.owner_required, false);

  await writeFile(join(dataRoot, "maintenance", "supervisor-heartbeat.json"), JSON.stringify({ checked_at: at.toISOString(), server_pid: 0, task_registered: true, runtime_sha256: runtimeSha256, deployed_commit: "abc123", restart_attempts: 6, circuit_state: "OPEN", next_retry_at: "2026-08-13T06:05:00.000Z" }));
  const circuit = collectLocalMaintenanceFindings({ dataRoot, now: at, schedulerCheckedAt: at.toISOString(), runtimeEntry, diskFreeBytes: 10 * 1024 ** 3, diskTotalBytes: 50 * 1024 ** 3 });
  assert.equal(circuit.find((item) => item.code === "WEBSITE_RESTART_CIRCUIT_OPEN")?.severity, "CRITICAL");

  await writeFile(runtimeEntry, "drifted-runtime");
  await writeFile(join(dataRoot, "maintenance", "supervisor-heartbeat.json"), JSON.stringify({ checked_at: "2026-08-13T05:55:00.000Z", server_pid: 4070, task_registered: false, runtime_sha256: runtimeSha256, deployed_commit: "abc123" }));
  const failed = collectLocalMaintenanceFindings({ dataRoot, now: at, schedulerCheckedAt: "2026-08-13T05:55:00.000Z", runtimeEntry, diskFreeBytes: 512 * 1024 ** 2, diskTotalBytes: 50 * 1024 ** 3 });
  for (const code of ["SUPERVISOR_HEARTBEAT_STALE", "STARTUP_TASK_MISSING", "DEPLOYMENT_VERSION_DRIFT", "TIMELINE_SCHEDULER_HEARTBEAT_STALE", "DISK_SPACE_CRITICAL"]) assert.ok(failed.some((item) => item.code === code), code);
  assert.ok(failed.every((item) => item.details.history_impact));
});
