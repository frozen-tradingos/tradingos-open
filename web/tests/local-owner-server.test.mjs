import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isLoopbackClient, isPrivateClient, isTrustedHomeClient, ownerSnapshotView, resolveStockProjectPaths, startOwnerServer, writeOwnerCredentials } from "../server/local-owner-server.ts";
import { fetchActiveSnapshot, isOwnerSnapshotFresh, uploadSnapshot } from "../app/snapshot-import.ts";
import { openSnapshotDatabase } from "../build/local-data-core.ts";
import { spxWatchLifecycle } from "../app/spx-observation-lifecycle.ts";
import { cleanEnvironment, data as publicData, offlineDoctor } from "../../tools/public-entry.mjs";

test("Owner snapshot route rejects absent, invalid, future and expired prebuilt snapshots", async () => {
  const source = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  const route = source.match(/if \(runtimeRole === "WEB"\) \{\r?\n\s+const serialized[\s\S]+?return sendSerializedJson\(response, 200, serialized\);\r?\n\s+\}/)?.[0];
  assert.ok(route);
  const read = new Function(`return ${stripTypeScriptTypes(`function read(runtimeRole, prebuiltSnapshots, view, response, trace, isOwnerSnapshotFresh, sendJson, sendSerializedJson) { ${route} }`)}`)();
  const now = Date.parse("2026-09-27T12:00:30.000Z"), response = { setHeader() {} };
  const send = (_, status, value) => ({ status, value });
  const readAt = (generatedAt, view = "home") => read("WEB", generatedAt === null ? null : { generatedAt, values: { home: "home payload", full: "full payload" } }, view, response, {}, (at) => isOwnerSnapshotFresh(at, now), send, send);
  for (const at of [null, "invalid", "2026-09-27T12:00:30.001Z", "2026-09-27T11:59:59.999Z"]) assert.equal(readAt(at).status, 503);
  assert.deepEqual(readAt("2026-09-27T12:00:00.000Z"), { status: 200, value: "home payload" });
  assert.equal(readAt("2026-09-27T12:00:30.000Z", "options").status, 503);
  assert.equal(readAt("2026-09-27T12:00:30.000Z", null).value, "full payload");
});

test("company evidence reuses fresh WEB snapshots without a second full database read", async () => {
  const source = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  const route = source.match(/let intelligence: SnapshotState\["marketIntelligence"\];[\s\S]+?(?=\s+const report = projectCompanyEvidence)/)?.[0];
  assert.ok(route);
  const read = new Function(`return ${stripTypeScriptTypes(`async function read(runtimeRole, prebuiltSnapshots, activeSnapshot, response, trace, isOwnerSnapshotFresh, sendJson) { ${route} return intelligence; }`)}`)();
  const now = Date.parse("2026-09-30T15:00:30Z"), intelligence = { events: [{ published_at: "2026-09-30T14:00:00Z", response_received_at: "2026-09-30T14:01:00Z" }] };
  const response = { setHeader(name, value) { assert.equal(name, "x-owner-snapshot-at"); assert.equal(value, "2026-09-30T15:00:00Z"); } };
  const fullRead = () => { throw new Error("unexpected full database read"); };
  const readAt = (generatedAt, values = { company: JSON.stringify({ marketIntelligence: intelligence }) }) => read("WEB", generatedAt === null ? null : { generatedAt, values }, fullRead, response, {}, (at) => isOwnerSnapshotFresh(at, now), (_, status) => status);
  for (const at of [null, "invalid", "2026-09-30T15:00:30.001Z", "2026-09-30T14:59:59.999Z"]) assert.equal(await readAt(at), 503);
  assert.equal(await readAt("2026-09-30T15:00:00Z", { full: "not a company snapshot" }), 503);
  assert.deepEqual(await readAt("2026-09-30T15:00:00Z"), intelligence);
  assert.deepEqual(await read("COMBINED", null, async (view) => { assert.equal(view, "company"); return { value: { marketIntelligence: intelligence } }; }, response, {}, () => false, () => assert.fail()), intelligence);
});

test("Owner snapshot worker failure invalidates old data and the next natural success restores it", async () => {
  const source = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  const setup = source.match(/await new Promise<void>\(\(resolveReady, rejectReady\) => \{[\s\S]*?\r?\n {6}\}\);/)?.[0];
  assert.ok(setup);
  const attach = new Function(`return ${stripTypeScriptTypes(`function attach(snapshotWorker) { let prebuiltSnapshots = null, closed = false; ${setup.replace("await ", "const ready = ")} return { ready, current: () => prebuiltSnapshots, close: () => { closed = true; } }; }`)}`)();
  const worker = new EventEmitter(), state = attach(worker);
  const good = { type: "snapshots", generatedAt: "2026-09-27T12:00:00.000Z", values: { full: "old" } };
  worker.emit("message", good); await state.ready;
  assert.equal(state.current().values.full, "old");
  worker.emit("message", { type: "error", message: "database read failed" });
  assert.equal(state.current(), null);
  worker.emit("message", { ...good, values: { full: "recovered" } });
  assert.equal(state.current().values.full, "recovered");
  worker.emit("error", new Error("worker failed")); assert.equal(state.current(), null);
  worker.emit("message", good); worker.emit("exit", 1); assert.equal(state.current(), null);
  state.close(); worker.emit("message", good); assert.equal(state.current(), null);
  const initialFailure = new EventEmitter(), failed = attach(initialFailure);
  initialFailure.emit("message", { type: "error", message: "initial read failed" });
  await assert.rejects(failed.ready, /initial read failed/);
});

test("Owner snapshot client preserves generation time and rejects stale successful responses", async (context) => {
  let at = "2026-09-27T12:00:10.123Z", status = 200;
  context.mock.method(globalThis, "fetch", async (_, init) => {
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers.get("x-trading-os-caller"), "owner_snapshot");
    return Response.json({ marker: "snapshot", error: "not ready" }, { status, headers: { date: "Sun, 27 Sep 2026 12:00:15 GMT", "x-owner-snapshot-at": at } });
  });
  assert.equal((await fetchActiveSnapshot("home")).snapshotGeneratedAt, at);
  for (const invalid of ["", "invalid", "2026-09-27T11:59:00.000Z", "2026-09-27T12:01:00.000Z"]) {
    at = invalid; await assert.rejects(fetchActiveSnapshot("home"), /快照已过期/);
  }
  status = 503; await assert.rejects(fetchActiveSnapshot("home"), /not ready/);
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /setSnapshotUpdatedAt\(restored\.snapshotGeneratedAt \? Date\.parse\(restored\.snapshotGeneratedAt\) : Date\.now\(\)\)/);
  assert.match(page, /finally\(\(\) => \{ refreshing = false; \}\)/);
});

test("Owner snapshot client timeout covers fetch and body, recovers next read and never retries an upload", async (context) => {
  let controller, ready, attempts = 0, phase = "fetch";
  context.mock.method(AbortSignal, "timeout", (ms) => { assert.equal(ms, 10_000); return controller.signal; });
  context.mock.method(globalThis, "fetch", async (_, init) => {
    attempts += 1;
    const stall = () => new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); ready(); });
    if (phase === "fetch") return stall();
    if (phase === "body") return { status: 200, ok: true, json: stall };
    return Response.json({ marker: "recovered" });
  });
  for (phase of ["fetch", "body", "fetch"]) {
    controller = new AbortController();
    const started = new Promise((resolve) => { ready = resolve; });
    const uploading = attempts === 2;
    const request = uploading ? uploadSnapshot("{}") : fetchActiveSnapshot("home");
    await started; controller.abort(new DOMException("timeout", "TimeoutError"));
    await assert.rejects(request, uploading ? /结果尚未确认/ : /读取超时/);
  }
  assert.equal(attempts, 3, "no automatic write retry");
  phase = "success"; controller = new AbortController();
  assert.equal((await fetchActiveSnapshot("home")).marker, "recovered");
});

test("all Owner views strip archived watch payloads from convexity contracts without changing identities, amounts or source", () => {
  const contract = { contract_id: "contract-1", chain_id: "chain-1", chain_symbol: "SPXW", settlement: "PM", expiration_date: "2026-10-02", strike: 6500, option_type: "put", state: "active", tradability: "tradable", contract_multiplier: 100, multiplier_source: "CBOE_SPX_CONTRACT_SPEC" };
  const legacyContract = { ...contract, contract_id: "legacy-contract", chain_id: null };
  delete legacyContract.multiplier_source;
  const frozen = [contract, legacyContract].map((identity, index) => ({ candidate_id: `candidate-${index}`, contract: identity, frozen_quote: { bid: 1.1, ask: 1.2 }, capital_assessment: { one_contract_ask_cost_usd: 120, capital_pct: 12, fit: "NORMAL_FIT" }, blockers: [] }));
  const opportunity = (id) => ({ opportunity_id: id, trading_date: "2026-09-21", direction: "DOWN", state: "WINDOW_CLOSED", primary_miss_reason: "OWNER_DID_NOT_EXECUTE", executable_multiple_status: "VERIFIED", owner_invested_usd: 0, owner_realized_pnl: 0, frozen_candidates: frozen, candidates: frozen.map((candidate) => ({ ...candidate, initial_valid_ask: 1.2, highest_valid_bid: 2.4, executable_multiple: 2, executable_return_pct: 100, max_favorable_change_usd: 120 })) });
  const expected = {
    contract_version: "SPX_CONVEXITY_LEDGER_V1", status: "ACTIVE", data_mode: "SPY_PROXY", spx_spot_status: "DATA_BLOCKED", capital_context: { available_capital_usd: 1000 },
    current: { ...opportunity("current"), state: "WINDOW_OPEN" }, history: [opportunity("history-1"), opportunity("history-2")], statistics: { path_candidates: 3, owner_executions: 0, broker_profit_or_loss_events: 0 },
  };
  const spxConvexity = structuredClone(expected);
  for (const item of [spxConvexity.current, ...spxConvexity.history]) for (const candidates of [item.frozen_candidates, item.candidates]) for (const candidate of candidates) {
    Object.assign(candidate.contract, { events: [{ spy_snapshot: { raw: "RAW_WATCH_ARCHIVE".repeat(65_536) } }], strategy_context: { contracts: ["archived only"], pending_gateway: "archived only" } });
  }
  const state = {
    payload: null, archiveCount: 7, recentOutputs: [], runLedger: { runs: [] }, selfCheck: { recent: [] },
    marketIntelligence: { events: [], causalChains: [] }, scheduler: { groups: [], recent: [] }, marketRadar: { snapshot: null },
    tsSettlement: { exclusions: [], recent: [], review_evidence: null }, optionLifecycle: { recent_settlements: [] },
    ownerTrigger: { current: { SPY: null, QQQ: null }, recent: [] }, spxwProxy: { watches: [false, true].map((ended) => ({ ...contract, watch_id: `watch-${ended}`, created_at: "2026-10-02T13:30:00Z", valid_until: null,
      created_quote: { bid: 1, ask: 1.1 }, current_quote: { bid: 1.1, ask: 1.2 }, trigger_quote: null, highest_mark: 1.15, lowest_mark: 1.05,
      events: [...Array.from({ length: 10_000 }, (_, index) => ({ event_id: `event-${index}`, event_type: index % 2 ? "QUOTE" : "DATA_BLOCKED", recorded_at: "2026-10-02T14:00:00Z", quote: { bid: 1.1, ask: 1.2 }, spy_snapshot: null })),
        ...(ended ? [{ event_id: "ended-1", event_type: "ENDED", reason: "Owner ended", spy_snapshot: { raw: "archived" }, quote: { bid: 1.1, ask: 1.2 } }, { event_id: "ended-2", event_type: "ENDED", reason: "Later reason", spy_snapshot: null, quote: null }] : [])],
    })), real_holdings: [], owner_observations: [] },
    externalExpert: { cases: [] }, spxConvexity,
    outputs: { TS_OUTPUT: [], TS_SHADOW_OUTPUT: [], A1_SHADOW_RESULT: null, A2_SHADOW_RESULT: null, SCHEDULE_CHECKPOINT: [], OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [], POSITION_COPILOT_STATE: [] },
  };
  const original = JSON.stringify(state);
  for (const view of ["home", "forecast", "options", "company", "health", "settlements", "issues"]) {
    const projected = ownerSnapshotView(state, view);
    assert.deepEqual(projected.spxConvexity, expected, `${view}: retain all identities, candidates, monetary measurements and statistics`);
    if (view === "forecast") {
      for (const [index, watch] of projected.spxwProxy.watches.entries()) {
        const source = state.spxwProxy.watches[index];
        assert.equal(watch.quote_snapshot_count, 5_000);
        assert.ok(watch.events.length <= 1, "display size stays bounded as quote and blocked history grows");
        assert.deepEqual(spxWatchLifecycle(watch, "2026-10-02T14:05:00Z"), spxWatchLifecycle(source, "2026-10-02T14:05:00Z"));
        for (const field of ["created_quote", "current_quote", "trigger_quote", "highest_mark", "lowest_mark"]) assert.deepEqual(watch[field], source[field]);
      }
      assert.deepEqual(ownerSnapshotView(projected, "forecast"), projected, "reprojection preserves snapshot counts");
      assert.ok(JSON.stringify(projected.spxwProxy).length < 5_000);
    }
    assert.equal(projected.archiveCount, state.archiveCount);
    assert.ok(JSON.stringify(projected).length < original.length / 100, `${view}: do not serialize archived watch payloads`);
    assert.equal(JSON.stringify(state), original, `${view}: full source and archived payloads remain unchanged`);
  }
  const noCurrent = { ...state, spxConvexity: { ...spxConvexity, current: null } };
  assert.equal(ownerSnapshotView(noCurrent, "home").spxConvexity.current, null);
});

function runEvent(name, overrides = {}) {
  return {
    ledger_format: "TRADING_OS_AGENT_RUN_EVENT",
    ledger_version: 1,
    event_id: `server-${name}-start`,
    agent_id: "TS",
    skill_id: "TS_FORECAST",
    run_id: `server-${name}-run`,
    slot_id: "15:00",
    channel: "PRODUCTION",
    version: "ts-output-v2",
    data_cutoff_at: "2026-08-11T14:59:00.000Z",
    event_at: "2026-08-11T15:00:00.000Z",
    status: "STARTED",
    output_status: "NOT_PRODUCED",
    error: null,
    evidence_refs: [],
    website_delivery: "NOT_ATTEMPTED",
    discord_delivery: "NOT_ATTEMPTED",
    ...overrides,
  };
}

test("public launcher owns isolated profiles and never installs personal production tasks", async () => {
  const environment = cleanEnvironment({ PATH: "synthetic-path", CODEX_HOME: "unrelated-profile", TRADING_OS_DATA_ROOT: "unrelated-data", TRADING_OS_PUBLIC_AUTOMATION: "1", OPENAI_API_KEY: "synthetic-not-a-key", ROBINHOOD_ACCOUNT_ID: "synthetic-other-account" });
  assert.equal(environment.TRADING_OS_DATA_ROOT, publicData);
  assert.equal(environment.CODEX_HOME, join(publicData, "model-codex-home"));
  assert.equal(environment.TRADING_OS_PUBLIC_AUTOMATION, "0");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.ROBINHOOD_ACCOUNT_ID, undefined);
  assert.equal(offlineDoctor().external_requests, 0);
  const launcher = await readFile(new URL("../../tools/public-entry.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /New-ScheduledTask|Register-ScheduledTask|schtasks|owner-service\.ps1|:\/\/127\.0\.0\.1:407[0-6]/);
  for (const name of ["owner-service.ps1", "setup-robinhood-mcp.ps1"]) await assert.rejects(readFile(new URL(`../scripts/${name}`, import.meta.url)), { code: "ENOENT" });
  const server = await readFile(new URL("../server/local-owner-server.ts", import.meta.url), "utf8");
  assert.match(server, /TRADING_OS_START_REASON === "WINDOWS_STARTUP".*recordOperationalAnnotation/);
  assert.match(server, /runtimeRole === "TIER0".*runtimeRole === "COMBINED"/);
  assert.match(server, /runtimeRole === "WEB".*owner-snapshot-worker\.ts/s);
  assert.doesNotMatch(server, /kind: "STARTUP_RECOVERY", started_at: runtimeStartedAt/);
  assert.match(await readFile(new URL("../scripts/setup-finnhub.ps1", import.meta.url), "utf8"), /stock_site_project_boundary_invalid/);
  assert.match(await readFile(new URL("../scripts/setup-finnhub.ps1", import.meta.url), "utf8"), /icacls\.exe .*\/inheritance:r .*\/grant:r/);
});

function assertOwnerOnlyWindowsAcl(path) {
  if (process.platform !== "win32") return;
  const powershell = "$a=(Get-Acl -LiteralPath $env:TRADING_OS_ACL_TEST).Access; @($a | ForEach-Object { [pscustomobject]@{ Identity=[string]$_.IdentityReference; Rights=[string]$_.FileSystemRights; Inherited=$_.IsInherited } }) | ConvertTo-Json -Compress";
  const windowsModules = `${process.env.WINDIR}\\System32\\WindowsPowerShell\\v1.0\\Modules;${process.env.ProgramFiles}\\WindowsPowerShell\\Modules`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", powershell], { encoding: "utf8", env: { ...process.env, PSModulePath: windowsModules, TRADING_OS_ACL_TEST: path }, windowsHide: true });
  const entries = JSON.parse(raw);
  const list = Array.isArray(entries) ? entries : [entries];
  assert.equal(list.length, 1);
  assert.equal(list[0].Inherited, false);
  assert.match(list[0].Rights, /FullControl/);
  assert.equal(list[0].Identity.toLowerCase(), execFileSync("whoami.exe", { encoding: "utf8", windowsHide: true }).trim().toLowerCase());
}

test("stock project boundary rejects another project id or data directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "trading-os-stock-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "PROJECT_BOUNDARY.json"), JSON.stringify({ project_id: "trading-os-stock-web", data_root: "data" }));
  assert.equal(resolveStockProjectPaths(root, resolve(root, "data"), "trading-os-stock-web").dataRoot, resolve(root, "data"));
  assert.throws(() => resolveStockProjectPaths(root, join(root, "other-data")), /拒绝跨项目数据目录/);
  assert.throws(() => resolveStockProjectPaths(root, undefined, "other-project"), /拒绝跨项目运行/);
});

test("event disclosure report is authenticated, fixed-path and read-only", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-event-report-"));
  let running;
  context.after(async () => { await running?.close(); await rm(directory, { recursive: true, force: true }); });
  const dataRoot = join(directory, "data"), reportDirectory = join(dataRoot, "research/event-disclosure-phase1-20260927");
  const reportPath = join(reportDirectory, "REPORT-dc9c6ce78f09da3cc1c8c716e3ee80678e8592ddaedfe5340466aaf849bfe3fc.html");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(directory, "PROJECT_BOUNDARY.json"), JSON.stringify({ project_id: "trading-os-stock-web", data_root: "data" }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  const fetchedAt = new Date(Date.now() - 120_000).toISOString(), receivedAt = new Date(Date.now() - 60_000).toISOString();
  const publishedAt = new Date(Date.now() - 180_000).toISOString();
  const archive = openSnapshotDatabase(join(dataRoot, "trading-os-web.sqlite"));
  try {
    archive.importMarketIntelligence({ source: { source: "FINNHUB", status: "LIVE", configured: true, authorization: "VALID", last_success_at: fetchedAt,
      as_of: fetchedAt, freshness_seconds: 0, error: null, checked_at: fetchedAt, capabilities: { news: true, earnings_calendar: false } },
    events: ["NVIDIA fixture product announcement", "Apple fixture earnings announcement"].map((title, index) => {
      const raw = JSON.stringify({ request: { path: "/company-news", symbol: "NVDA" }, response: { headline: title } });
      return { event_id: `company-evidence-fixture-${index}`, event_fingerprint: null, kind: "NEWS", title, source: "Fixture Wire",
        source_url: `https://example.test/company-news/${index}`, published_at: publishedAt, scheduled_for: null, fetched_at: fetchedAt,
        response_received_at: receivedAt, affected_symbols: ["NVDA"], industry: null, event_type: "company", event_category: null,
        novelty: "NEW", importance: "NOT_VERIFIED", event_evidence_state: "UNVERIFIED", expires_at: null,
        raw_json: raw, raw_sha256: createHash("sha256").update(raw).digest("hex") };
    }) });
  } finally { archive.close(); }
  const options = { host: "127.0.0.1", port: 0, projectRoot: directory, outDir: resolve("dist"), dataRoot, shadowRuntime: false, incidentGuard: false, codexManager: false, runtimeRole: "WEB" };
  writeOwnerCredentials(join(dataRoot, "owner-access.json"), "Local-Owner-Test-Only!");
  running = await startOwnerServer(options);
  const route = `${running.url}/research/event-disclosure`;
  assert.equal((await fetch(route)).status, 401);
  const denied = await fetch(route, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get("location"), "/login?return_to=%2Fresearch%2Fevent-disclosure");
  const login = await fetch(`${running.url}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: running.url }, body: new URLSearchParams({ username: "owner", password: "Local-Owner-Test-Only!" }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie };
  const companyUrl = `${running.url}/api/company-evidence?symbol=NVDA`;
  assert.equal((await fetch(companyUrl)).status, 401);
  assert.equal((await fetch(companyUrl, { method: "POST", headers: { ...headers, origin: "https://untrusted.test" } })).status, 405);
  assert.equal((await fetch(companyUrl, { method: "POST", headers: { ...headers, origin: running.url } })).status, 405);
  assert.equal((await fetch(`${running.url}/api/company-evidence?symbol=../../owner-access.json`, { headers })).status, 400);
  assert.equal((await fetch(companyUrl, { method: "DELETE", headers })).status, 405);
  const company = await fetch(companyUrl, { headers });
  assert.equal(company.status, 200);
  const companyResult = await company.json();
  assert.equal(companyResult.report.symbol, "NVDA");
  assert.deepEqual(companyResult.report.news, [{ evidence_ref: "news:company-evidence-fixture-0", title: "NVIDIA fixture product announcement",
    source: "Fixture Wire", url: "https://example.test/company-news/0", published_at: publishedAt, received_at: receivedAt }], "GET must read actual archived news rather than the empty forecast projection");
  const apple = await fetch(`${running.url}/api/company-evidence?symbol=AAPL`, { headers });
  assert.equal(apple.status, 200);
  assert.deepEqual((await apple.json()).report.news.map((item) => item.title), ["Apple fixture earnings announcement"], "old NVDA query association cannot misclassify an Apple headline");
  assert.deepEqual(companyResult.report.earnings, [], "missing earnings coverage stays empty");
  assert.deepEqual(companyResult.events, []);
  const missing = await fetch(route, { headers });
  assert.equal(missing.status, 404);
  assert.doesNotMatch(await missing.text(), /REPORT-|ENOENT|event-disclosure-phase1|trading-os-event-report/);
  const html = '<!doctype html><html><head><style>body{color:#123}</style></head><body>FROZEN_SYNTHETIC_REPORT</body></html>';
  await writeFile(reportPath, html);
  await writeFile(join(reportDirectory, "other.html"), "UNAPPROVED_REPORT");
  const report = await fetch(`${route}?path=other.html&file=../../owner-access.json`, { headers });
  assert.equal(report.status, 200);
  const reportText = await report.text();
  assert.match(reportText, /公司消息与股价反应/);
  assert.match(reportText, /事件观察证据缺失、未到登记时间或未通过核验/);
  assert.match(reportText, /<details id="phase-one-static-report"><summary>查看一期原始静态报告与历史修订<\/summary>FROZEN_SYNTHETIC_REPORT<\/details>/);
  assert.match(report.headers.get("content-type"), /text\/html; charset=utf-8/);
  assert.equal(report.headers.get("cache-control"), "no-store");
  assert.equal(report.headers.get("x-content-type-options"), "nosniff");
  assert.equal(report.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal((await fetch(route, { method, headers })).status, 405);
  for (const path of ["/research/event-disclosure/other.html", "/data/research/event-disclosure-phase1-20260927/other.html"]) {
    const response = await fetch(`${running.url}${path}`, { headers });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /UNAPPROVED_REPORT|FROZEN_SYNTHETIC_REPORT/);
  }
  assert.equal(await readFile(reportPath, "utf8"), html);
  await rm(reportPath);
  await mkdir(reportPath);
  const unreadable = await fetch(route, { headers });
  assert.equal(unreadable.status, 503);
  assert.doesNotMatch(await unreadable.text(), /REPORT-|EISDIR|EPERM|event-disclosure-phase1|trading-os-event-report/);
});

test("WEB runtime securely proxies Codex Manager control to Tier 0", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-manager-proxy-"));
  const requests = [];
  const tier0 = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const body = request.url === "/api/codex-manager/action" ? { action_status: "SUCCEEDED" } : request.method === "POST" ? { accepted: true, command_id: "manager-proxy-test", status: "QUEUED" } : { online_status: "ONLINE", marker: "TIER0" };
      response.writeHead(request.method === "POST" && request.url === "/api/codex-manager" ? 202 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolveListen) => tier0.listen(0, "127.0.0.1", resolveListen));
  const tier0Address = tier0.address();
  const options = {
    host: "127.0.0.1", port: 0, outDir: resolve("dist"), shadowRuntime: false, incidentGuard: false, codexManager: false, runtimeRole: "WEB", snapshotWorker: false,
    tier0Origin: `http://127.0.0.1:${tier0Address.port}`, databasePath: join(directory, "snapshots.sqlite"), credentialsPath: join(directory, "owner.json"), gatewayKeyPath: join(directory, "gateway.key"), lockPath: join(directory, "owner.pid"), trustedHomeAccessPath: join(directory, "trusted-home.json"),
  };
  writeOwnerCredentials(options.credentialsPath, "Local-Owner-Test-Only!");
  await writeFile(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: true, trusted_cidrs: ["10.0.0.0/24"] }));
  const running = await startOwnerServer(options);
  context.after(async () => {
    await running.close();
    await new Promise((resolveClose) => tier0.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  });

  const state = await fetch(`${running.url}/api/codex-manager`), stateBody = await state.json();
  assert.deepEqual([state.status, stateBody.online_status, stateBody.marker], [200, "ONLINE", "TIER0"]);
  const ownerRun = await fetch(`${running.url}/api/codex-manager`, { method: "POST", headers: { origin: running.url, "content-type": "application/json" }, body: JSON.stringify({ trigger: "OWNER_MANUAL" }) });
  assert.deepEqual([ownerRun.status, (await ownerRun.json()).command_id], [202, "manager-proxy-test"]);
  assert.equal((await fetch(`${running.url}/api/codex-manager`, { method: "POST", headers: { origin: running.url, "content-type": "application/json" }, body: JSON.stringify({ trigger: "SCHEDULE_DAILY_REVIEW" }) })).status, 403);
  assert.equal((await fetch(`${running.url}/api/codex-manager/action`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  const gatewayKey = (await readFile(options.gatewayKeyPath, "utf8")).trim();
  const action = await fetch(`${running.url}/api/codex-manager/action`, { method: "POST", headers: { authorization: `Bearer ${gatewayKey}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "MANAGER_ACTION", action: { action: "CLOSE_INCIDENT" } }) });
  assert.deepEqual([action.status, (await action.json()).action_status], [200, "SUCCEEDED"]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((item) => item.authorization === `Bearer ${gatewayKey}`));
});

test("trusted home access is explicit, CIDR-bound and fails closed", async (context) => {
  assert.equal(isTrustedHomeClient("127.0.0.1", ["10.0.0.0/24"]), true);
  assert.equal(isTrustedHomeClient("::1", ["10.0.0.0/24"]), true);
  assert.equal(isTrustedHomeClient("10.0.0.50", ["10.0.0.0/24"]), true);
  assert.equal(isTrustedHomeClient("10.0.1.50", ["10.0.0.0/24"]), false);
  assert.equal(isTrustedHomeClient("8.8.8.8", ["10.0.0.0/24"]), false);
  assert.equal(isTrustedHomeClient("10.0.0.50", ["0.0.0.0/0"]), false);
  assert.equal(isTrustedHomeClient("10.0.0.50", ["10.0.0.1/24"]), false);

  const directory = await mkdtemp(join(tmpdir(), "trading-os-trusted-home-"));
  let running = null;
  context.after(async () => {
    await running?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    host: "127.0.0.1", port: 0, outDir: resolve("dist"), shadowRuntime: false, incidentGuard: false, runtimeRole: "WEB",
    databasePath: join(directory, "snapshots.sqlite"), credentialsPath: join(directory, "owner.json"), gatewayKeyPath: join(directory, "gateway.key"), lockPath: join(directory, "owner.pid"), trustedHomeAccessPath: join(directory, "trusted-home.json"),
  };
  writeOwnerCredentials(options.credentialsPath, "Local-Owner-Test-Only!");
  await writeFile(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: true, trusted_cidrs: ["10.0.0.0/24"] }));
  running = await startOwnerServer(options);
  assert.equal((await fetch(`${running.url}/forecast`)).status, 200);
  const fullSnapshot = await fetch(`${running.url}/api/snapshot`), forecastSnapshot = await fetch(`${running.url}/api/snapshot?view=forecast`);
  assert.equal(fullSnapshot.status, 200);
  assert.equal(forecastSnapshot.status, 200);
  assert.ok(Number(forecastSnapshot.headers.get("content-length")) <= Number(fullSnapshot.headers.get("content-length")));
  assert.match(forecastSnapshot.headers.get("x-owner-snapshot-at"), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(forecastSnapshot.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
  assert.equal((await fetch(`${running.url}/login`, { redirect: "manual" })).headers.get("location"), "/");
  await running.close();
  running = null;

  await writeFile(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: false, trusted_cidrs: [] }));
  running = await startOwnerServer(options);
  assert.equal((await fetch(`${running.url}/forecast`, { redirect: "manual", headers: { accept: "text/html", "x-forwarded-for": "127.0.0.1" } })).headers.get("location"), "/login?return_to=%2Fforecast");
  await running.close();
  running = null;

  await writeFile(options.trustedHomeAccessPath, JSON.stringify({ version: 1, enabled: true, trusted_cidrs: ["0.0.0.0/0"] }));
  running = await startOwnerServer(options);
  assert.equal((await fetch(`${running.url}/api/snapshot`, { headers: { "x-forwarded-for": "10.0.0.50" } })).status, 401);
  await running.close();
  running = null;
});

test("Owner gate protects one persistent SQLite service and one process", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "trading-os-owner-"));
  const options = {
    host: "127.0.0.1",
    port: 0,
    outDir: resolve("dist"),
    databasePath: join(directory, "snapshots.sqlite"),
    credentialsPath: join(directory, "owner.json"),
    gatewayKeyPath: join(directory, "gateway.key"),
    lockPath: join(directory, "owner.pid"),
    trustedHomeAccessPath: join(directory, "trusted-home.json"),
    sessionTtlMs: 3_000,
  };
  writeOwnerCredentials(options.credentialsPath, "Local-Owner-Test-Only!");
  let running = await startOwnerServer(options);
  context.after(async () => {
    await running?.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(isPrivateClient("127.0.0.1"), true);
  assert.equal(isPrivateClient("192.168.1.22"), true);
  assert.equal(isPrivateClient("8.8.8.8"), false);
  assert.equal(isLoopbackClient("127.0.0.1"), true);
  assert.equal(isLoopbackClient("192.168.1.22"), false);
  await assert.rejects(startOwnerServer(options), /已在运行/);

  const origin = running.url;
  const gatewayKey = (await readFile(options.gatewayKeyPath, "utf8")).trim();
  const raw = await readFile(new URL("../public/samples/v2-snapshot-import-v1.sanitized.json", import.meta.url), "utf8");
  const sample = JSON.parse(raw);
  const ts = sample.contracts.TS_OUTPUT[0];
  const tsEnvelope = {
    gateway_format: "TRADING_OS_LOCAL_OUTPUT",
    gateway_version: 1,
    record_id: "server-ts-normal",
    output_type: "TS_OUTPUT",
    channel: "PRODUCTION",
    observed_at: ts.evidence_snapshot.market_time.observed_at,
    payload: ts,
  };
  const sendOutput = (body, key = gatewayKey) => fetch(`${origin}/api/output-gateway`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body });
  assert.equal((await fetch(`${origin}/api/health`)).status, 401);
  const health = await fetch(`${origin}/api/health`, { headers: { authorization: `Bearer ${gatewayKey}` } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await fetch(`${origin}/api/owner-action-probe`, { method: "POST" })).status, 401);
  const ownerProbe = await fetch(`${origin}/api/owner-action-probe`, { method: "POST", headers: { authorization: `Bearer ${gatewayKey}` } }), ownerProbeBody = await ownerProbe.json();
  assert.deepEqual([ownerProbe.status, ownerProbeBody.action_status, ownerProbeBody.dry_run, ownerProbeBody.persisted, ownerProbeBody.broker_write_calls], [200, "SUCCEEDED", true, false, 0]);
  assert.match(ownerProbeBody.command_id, /^owner-probe:[0-9a-f-]{36}$/i);
  assert.equal((await fetch(`${origin}/api/output-gateway`, { method: "POST", body: JSON.stringify(tsEnvelope) })).status, 401);
  const acceptedOutput = await sendOutput(JSON.stringify(tsEnvelope));
  assert.equal(acceptedOutput.status, 201);
  assert.equal((await acceptedOutput.json()).outputCount, 1);
  assert.equal((await sendOutput(JSON.stringify(tsEnvelope))).status, 200);
  assert.equal((await sendOutput(JSON.stringify(tsEnvelope, null, 2))).status, 409);
  assert.equal((await sendOutput("{")).status, 400);
  assert.equal((await sendOutput(JSON.stringify({ ...tsEnvelope, record_id: "server-ts-shadow", channel: "SHADOW" }))).status, 400);

  const committeeEnvelope = (record_id, observed_at, summary) => JSON.stringify({
    gateway_format: "TRADING_OS_LOCAL_OUTPUT",
    gateway_version: 1,
    record_id,
    output_type: "COMMITTEE_OUTPUT",
    channel: "PRODUCTION",
    observed_at,
    payload: { contract_version: "v1", role: "COMMITTEE", flow_state: "unknown", direction: "unknown", confidence: 0, summary, evidence_for: [], evidence_against: [], reversal_signals: [], data_gaps: [] },
  });
  assert.equal((await sendOutput(committeeEnvelope("server-committee-new", "2026-08-11T12:00:00.000Z", "new"))).status, 201);
  assert.equal((await sendOutput(committeeEnvelope("server-committee-old", "2026-08-11T11:00:00.000Z", "old"))).status, 201);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => sendOutput(committeeEnvelope(`server-concurrent-${index}`, `2026-08-11T13:00:${String(index).padStart(2, "0")}.000Z`, `concurrent-${index}`))));
  assert.ok(concurrent.every((response) => response.status === 201));

  const sendRun = (body, key = gatewayKey) => fetch(`${origin}/api/run-ledger`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body });
  const restartRun = runEvent("restart");
  assert.equal((await fetch(`${origin}/api/run-ledger`, { method: "POST", body: JSON.stringify(restartRun) })).status, 401);
  assert.equal((await sendRun(JSON.stringify(restartRun))).status, 201);
  assert.equal((await sendRun(JSON.stringify(restartRun, null, 2))).status, 200);
  assert.equal((await sendRun(JSON.stringify({ ...restartRun, version: "conflict" }))).status, 409);
  assert.equal((await sendRun("{}")).status, 400);
  const concurrentRuns = await Promise.all(Array.from({ length: 8 }, (_, index) => sendRun(JSON.stringify(runEvent(`concurrent-${index}`, {
    event_at: `2026-08-11T15:00:${String(index).padStart(2, "0")}.000Z`,
    slot_id: `15:${String(index).padStart(2, "0")}`,
  })))));
  assert.ok(concurrentRuns.every((response) => response.status === 201));
  assert.equal((await sendRun(JSON.stringify({
    ...restartRun,
    event_id: "server-restart-direct-success",
    event_at: "2026-08-11T15:01:00.000Z",
    status: "SUCCEEDED",
    output_status: "PRODUCED",
    evidence_refs: ["sqlite://outputs/server-ts-normal"],
    website_delivery: "DELIVERED",
    discord_delivery: "DELIVERED",
  }))).status, 409);

  const login = (password, returnTo = "/") => fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ username: "owner", password, return_to: returnTo }),
  });

  assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
  assert.equal((await fetch(`${origin}/api/complaints`)).status, 401);
  const protectedPage = await fetch(`${origin}/forecast`, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get("location"), "/login?return_to=%2Fforecast");
  assert.match(await (await fetch(`${origin}/login?return_to=%2Fforecast`)).text(), /name="return_to" type="hidden" value="\/forecast"/);
  assert.match(await (await fetch(`${origin}/login?return_to=%2F%2Fevil.example`)).text(), /name="return_to" type="hidden" value="\/"/);
  assert.doesNotMatch(await (await fetch(`${origin}/login`)).text(), /autofocus/i);
  assert.equal((await login("wrong-password")).status, 401);
  const loginResponse = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${origin}/login` },
    body: new URLSearchParams({ username: "owner", password: "Local-Owner-Test-Only!", return_to: "/forecast" }),
  });
  assert.equal(loginResponse.status, 303);
  assert.equal(loginResponse.headers.get("location"), "/forecast");
  const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("trading_os_owner="));

  const page = await fetch(`${origin}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Trading OS/);

  const imported = await fetch(`${origin}/api/snapshot`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: raw });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).archiveCount, 1);
  assert.equal((await fetch(`${origin}/api/snapshot`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: raw })).status, 409);

  const invalidComplaint = await fetch(`${origin}/api/complaints`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ problem: "坏截图不应覆盖记录", category: "DISPLAY", severity: "HIGH", page: "/#complaints", screenshot: { name: "fake.png", mime: "image/png", base64: Buffer.from("not an image").toString("base64") } }),
  });
  assert.equal(invalidComplaint.status, 400);
  assert.equal((await (await fetch(`${origin}/api/complaints`, { headers: { cookie } })).json()).complaints.length, 0);

  const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const createdResponse = await fetch(`${origin}/api/complaints`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ problem: "TS 图在小屏幕上需要调查", category: "DISPLAY", severity: "HIGH", page: "/#forecast", screenshot: { name: "screen.png", mime: "image/png", base64: screenshot.toString("base64") } }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.status, "NEW");
  assert.equal(created.snapshot_id, "public-synthetic-import-v1");
  assert.equal(created.site_version, JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(created.history.length, 1);
  assert.equal(created.has_screenshot, true);

  const storedScreenshot = await fetch(`${origin}/api/complaints/${created.complaint_id}/screenshot`, { headers: { cookie } });
  assert.equal(storedScreenshot.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await storedScreenshot.arrayBuffer()), screenshot);

  const updatedResponse = await fetch(`${origin}/api/complaints/${created.complaint_id}`, {
    method: "PATCH",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ status: "INVESTIGATING", note: "已复现，等待 Shadow 验证" }),
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  assert.equal(updated.status, "INVESTIGATING");
  assert.deepEqual(updated.history.map((item) => item.status), ["NEW", "INVESTIGATING"]);

  const logout = await fetch(`${origin}/logout`, { method: "POST", redirect: "manual", headers: { cookie, origin } });
  assert.equal(logout.status, 303);
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { cookie } })).status, 401);

  const expiringLogin = await login("Local-Owner-Test-Only!");
  const expiringCookie = expiringLogin.headers.get("set-cookie")?.split(";", 1)[0];
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_100));
  assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { cookie: expiringCookie } })).status, 401);

  // Check Windows ACLs before issuing the short-lived restart cookie.
  for (const path of [options.credentialsPath, options.gatewayKeyPath, join(directory, "owner-sessions.json")]) assertOwnerOnlyWindowsAcl(path);
  const persistentLogin = await login("Local-Owner-Test-Only!");
  const persistentCookie = persistentLogin.headers.get("set-cookie")?.split(";", 1)[0];
  const rawSessionToken = persistentCookie?.split("=", 2)[1];
  assert.ok(rawSessionToken);
  assert.doesNotMatch(await readFile(join(directory, "owner-sessions.json"), "utf8"), new RegExp(rawSessionToken));

  await running.close();
  running = null;
  running = await startOwnerServer(options);
  assert.equal((await fetch(`${running.url}/api/snapshot`, { headers: { cookie: persistentCookie } })).status, 200);
  const resumedRun = await fetch(`${running.url}/api/run-ledger`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...restartRun, event_id: "server-restart-running", event_at: "2026-08-11T15:02:00.000Z", status: "RUNNING" }),
  });
  assert.equal(resumedRun.status, 201);
  const restartedLogin = await fetch(`${running.url}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: running.url },
    body: new URLSearchParams({ username: "owner", password: "Local-Owner-Test-Only!" }),
  });
  const restartedCookie = restartedLogin.headers.get("set-cookie")?.split(";", 1)[0];
  const restored = await fetch(`${running.url}/api/snapshot`, { headers: { cookie: restartedCookie } });
  assert.equal(restored.status, 200);
  const restoredData = await restored.json();
  assert.equal(restoredData.payload.snapshot_id, "public-synthetic-import-v1");
  assert.equal(restoredData.outputCount, 11);
  assert.equal(restoredData.outputs.COMMITTEE_OUTPUT.summary, "concurrent-7");
  assert.equal(restoredData.runLedger.eventCount, 10);
  assert.equal(restoredData.runLedger.runs.find((run) => run.run_id === restartRun.run_id).status, "RUNNING");
  const restoredComplaints = await fetch(`${running.url}/api/complaints`, { headers: { cookie: restartedCookie } });
  assert.equal(restoredComplaints.status, 200);
  const persisted = (await restoredComplaints.json()).complaints[0];
  assert.equal(persisted.complaint_id, created.complaint_id);
  assert.equal(persisted.status, "INVESTIGATING");
  assert.equal(persisted.history.length, 2);
});
