import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { readSourceSettings, sourceReadiness } from "../../tools/source-settings.mjs";
import { assertPublicAutomation } from "./public-runtime.ts";
import { collectTradierReadonly } from "./market-providers.ts";
import { collectRobinhoodMarketChart, collectRobinhoodReadonly, ROBINHOOD_READONLY_TOOLS, withRobinhoodMcp, type RobinhoodChartData, type RobinhoodChartInterval, type RobinhoodChartRange } from "./robinhood-mcp.ts";
import type { ReadonlyMarketSources } from "../app/snapshot-import.ts";
import { exchangeDateKey } from "../app/market-time.ts";

export type SourceSelection = { version: 1; revision: number; selection_id: string; selected: { market: { provider: "ROBINHOOD" | "TRADIER"; environment: "LIVE" | "SANDBOX" }; news: { provider: "OFFICIAL_ONLY" | "FINNHUB" | "NONE" }; broker: { provider: "ROBINHOOD" | "NONE" } } };
const exec = promisify(execFile);

/** The launcher freezes the selection. Editing it while running cannot reuse old caches or authorization. */
export function activeSourceSelection(packageRoot = resolve(process.cwd(), "..")): SourceSelection | null {
  const stored = readSourceSettings(packageRoot) as SourceSelection | null;
  const raw = process.env.TRADING_OS_SOURCE_SETTINGS;
  if (raw) {
    let frozen: unknown;
    try { frozen = JSON.parse(raw); } catch { throw new Error("SOURCE_SELECTION_INVALID"); }
    if (!stored || JSON.stringify(frozen) !== JSON.stringify(stored)) throw new Error("SOURCE_SELECTION_CHANGED_RESTART_REQUIRED");
    return stored;
  }
  if (process.env.TRADING_OS_PUBLIC_AUTOMATION === "1") throw new Error("SOURCE_SELECTION_REQUIRED: choose sources in Start.cmd first");
  return stored;
}

export async function readSelectedMarketToken(packageRoot: string, environment: "LIVE" | "SANDBOX") {
  const path = resolve(packageRoot, "web", "data", `tradier-${environment.toLowerCase()}-credentials.json`);
  for (let current = path; ; current = dirname(current)) {
    try { const stat = lstatSync(current); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error("CREDENTIAL_LINK_FORBIDDEN"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === packageRoot) break;
    if (dirname(current) === current) throw new Error("CREDENTIAL_PATH_INVALID");
  }
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("MARKET_KEY_NOT_CONFIGURED"); }
  if (process.platform !== "win32" || stored.version !== 1 || stored.provider !== "TRADIER" || stored.environment !== environment || stored.protection_scope !== "LOCAL_MACHINE" || typeof stored.protected_token !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored.protected_token)) throw new Error("MARKET_KEY_FORMAT_INVALID");
  const script = `Add-Type -AssemblyName System.Security;$v=[IO.File]::ReadAllText('${path.replaceAll("'", "''")}')|ConvertFrom-Json;$b=[Convert]::FromBase64String($v.protected_token);$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine);try{[Text.Encoding]::UTF8.GetString($u)}finally{[Array]::Clear($u,0,$u.Length)}`;
  try {
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10_000, maxBuffer: 8_192 });
    const token = stdout.trim();
    if (token.length < 8 || token.length > 2048 || /\s/.test(token)) throw new Error();
    return token;
  } catch { throw new Error("MARKET_KEY_DECRYPT_FAILED"); }
}

export async function collectSelectedMarket(observedAt = new Date().toISOString(), freezeDeadlineAt?: string, packageRoot = resolve(process.cwd(), ".."), scope: "FULL" | "MARKET_ONLY" = "FULL"): Promise<ReadonlyMarketSources> {
  assertPublicAutomation();
  const settings = activeSourceSelection(packageRoot);
  if (!settings) throw new Error("SOURCE_SELECTION_REQUIRED");
  const choice = settings.selected.market;
  const deadline = freezeDeadlineAt ?? new Date(Date.now() + 60_000).toISOString();
  const result = choice.provider === "TRADIER"
    ? await collectTradierReadonly({ token: await readSelectedMarketToken(packageRoot, choice.environment), environment: choice.environment === "LIVE" ? "production" : "sandbox" }, observedAt, deadline)
    : await withRobinhoodMcp({ projectRoot: resolve(packageRoot, "web"), allowlist: scope === "MARKET_ONLY" ? ["get_equity_quotes", "get_equity_historicals"] : ROBINHOOD_READONLY_TOOLS }, (session) => collectRobinhoodReadonly(session, observedAt, undefined, undefined, deadline, undefined, scope));
  activeSourceSelection(packageRoot); // Reject an in-flight switch, including a switch back to the same provider.
  return result;
}

export async function selectedMarketChart(symbol: "SPY" | "QQQ", interval: RobinhoodChartInterval, range: RobinhoodChartRange, packageRoot = resolve(process.cwd(), "..")): Promise<RobinhoodChartData> {
  assertPublicAutomation();
  const settings = activeSourceSelection(packageRoot);
  if (!settings) throw new Error("SOURCE_SELECTION_REQUIRED");
  const binding = { source_selection_id: settings.selection_id, source_revision: settings.revision, environment: settings.selected.market.environment };
  if (settings.selected.market.provider === "ROBINHOOD") {
    const chart = await withRobinhoodMcp({ projectRoot: resolve(packageRoot, "web"), allowlist: ["get_equity_quotes", "get_equity_historicals"] }, (session) => collectRobinhoodMarketChart(session, symbol, interval, new Date().toISOString(), range));
    activeSourceSelection(packageRoot);
    return { ...chart, ...binding };
  }
  if (interval !== "5m" || !["1d", "24h", "rth"].includes(range)) throw new Error("SOURCE_CHART_RANGE_NOT_CONNECTED: this adapter currently collects one regular session of 5-minute bars only");
  const snapshot = await collectSelectedMarket(new Date().toISOString(), undefined, packageRoot);
  const quotes = snapshot.quotes.find((row) => row.symbol === symbol), bars = snapshot.bars.find((row) => row.symbol === symbol);
  const values = (bars?.values ?? []).filter((row): row is typeof row & { open: number; high: number; low: number; close: number } => [row.open, row.high, row.low, row.close].every((value) => typeof value === "number" && Number.isFinite(value)));
  return {
    ...binding, source: "TRADIER", symbol, interval, range,
    session_bounds: values.length ? "REGULAR_ONLY" : "NOT_OBSERVED", data_grade: values.length ? "OFFICIAL_OHLCV" : "READ_FAILED",
    session_dates: [...new Set(values.map((row) => exchangeDateKey(row.begins_at)))],
    status: ["LIVE", "MARKET_CLOSED", "STALE"].includes(snapshot.status) ? snapshot.status as "LIVE" | "MARKET_CLOSED" | "STALE" : "DATA_BLOCKED",
    as_of: snapshot.as_of, freshness_seconds: snapshot.freshness_seconds,
    quote_as_of: quotes?.as_of ?? null, quote_freshness_seconds: quotes?.freshness_seconds ?? null,
    bar_as_of: bars?.as_of ?? null, bar_freshness_seconds: bars?.freshness_seconds ?? null,
    gap_status: snapshot.status === "DATA_BLOCKED" ? "SOURCE_GAP" : null, market_session: snapshot.market_session,
    current_price: quotes?.last ?? null,
    bars: values.map((row) => ({ ...row, trading_date: exchangeDateKey(row.begins_at), session: "REGULAR", data_grade: "OFFICIAL_OHLCV" })),
    error: settings.selected.market.environment === "SANDBOX" ? "SANDBOX_DELAYED_NOT_LIVE" : snapshot.status === "DATA_BLOCKED" ? "所选行情未通过权限、完整性或新鲜度检查" : null,
  };
}

/** Only a real collection can produce this diagnostic receipt. It never authorizes trades or asserts forecast quality. */
export function marketConnectionReceipt(settings: SourceSelection, snapshot: ReadonlyMarketSources, checkedAt = new Date().toISOString()) {
  const choice = settings.selected.market;
  const rows = [...snapshot.quotes, ...snapshot.bars];
  const matches = rows.length >= 4 && rows.every((row) => row.source === choice.provider) && snapshot.providers.some((row) => row.source === choice.provider && ["LIVE", "MARKET_CLOSED"].includes(row.status));
  const receipt = { selection_id: settings.selection_id, revision: settings.revision, role: "market", provider: choice.provider, environment: choice.environment, source_mode: "LIVE", status: matches && ["LIVE", "MARKET_CLOSED"].includes(snapshot.status) ? "SUCCESS" : "BLOCKED", access: "READ_ONLY", checked_at: checkedAt, expires_at: new Date(Date.parse(checkedAt) + 420_000).toISOString(), evidence_sha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), market_status: snapshot.status, capabilities: snapshot.capabilities };
  return { ...sourceReadiness(settings, "market", receipt, { now: Date.parse(checkedAt) }), provider: choice.provider, environment: choice.environment, checked_at: checkedAt, capabilities: snapshot.capabilities, broker_write_calls: 0, forecast_verified: false, evidence: receipt };
}
