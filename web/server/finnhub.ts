import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { inferNewsSymbols, type MarketIntelligenceUpdate } from "../app/market-intelligence.ts";
import { utcIso } from "../app/market-time.ts";
import { APPROVED_STOCKS, APPROVED_UNIVERSE, type ApprovedCapabilitySnapshot } from "../app/snapshot-import.ts";

const execFileAsync = promisify(execFile);
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";
const OFFICIAL_SINGLE_SOURCES = new Set(["Federal Reserve", "BLS", "BEA", "SEC"]);
const MARKET_MOVING_EVENTS = [
  ["central_bank", "fomc_decision", ["fomc statement"], 6],
  ["central_bank", "rate_decision", ["federal funds rate", "interest rate decision", "monetary policy decision"], 6],
  ["central_bank", "emergency_lending", ["emergency lending"], 6],
  ["inflation", "cpi", ["consumer price index"], 6],
  ["inflation", "ppi", ["producer price index"], 6],
  ["inflation", "pce", ["pce price index"], 6],
  ["inflation", "inflation_report", ["inflation report"], 6],
  ["employment", "employment_report", ["employment situation", "nonfarm payroll", "unemployment rate"], 6],
  ["employment", "job_openings", ["job openings"], 6],
  ["growth", "gdp", ["gross domestic product", "gdp release"], 6],
  ["growth", "personal_income", ["personal income and outlays"], 6],
  ["systemic_event", "market_halt", ["market-wide trading halt"], 30],
  ["systemic_event", "government_shutdown", ["government shutdown"], 30],
  ["systemic_event", "debt_ceiling", ["debt ceiling"], 30],
  ["systemic_event", "military_attack", ["military attack"], 30],
  ["systemic_event", "war_declaration", ["declares war"], 30],
  ["systemic_event", "banking_emergency", ["banking emergency"], 30],
] as const;
const UNIVERSE = new Set<string>(APPROVED_UNIVERSE);

type Request = typeof fetch;
type FinnhubOptions = { credentialPath: string; request?: Request; token?: string; timeoutMs?: number; approvedCapabilities?: ApprovedCapabilitySnapshot | null };

class FinnhubError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) { super(message); this.status = status; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/([?&](?:token|apikey|api_key)=)[^&\s]+/gi, "$1[REDACTED]").slice(0, 1_000);
}

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function number(value: unknown) { if (value === null || value === undefined || value === "") return null; const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : null; }

function symbols(value: unknown) {
  return [...new Set(text(value).toUpperCase().split(/[\s,]+/).filter((item) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(item)))];
}

function marketMoving(headline: string) {
  const normalized = headline.toLowerCase();
  for (const [category, eventKey, phrases, maxAgeHours] of MARKET_MOVING_EVENTS) {
    if (phrases.some((phrase) => normalized.includes(phrase))) return { category, eventKey, maxAgeHours };
  }
  return null;
}

async function protectedToken(path: string) {
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const legacy = file.version === 1 && typeof file.protected_token === "string" && /^[0-9a-f]+$/i.test(file.protected_token);
  const machine = file.version === 2 && file.protection_scope === "LOCAL_MACHINE" && typeof file.protected_token === "string" && file.protected_token.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(file.protected_token);
  if (file.provider !== "FINNHUB" || (!legacy && !machine)) throw new FinnhubError("Finnhub 本机凭证格式无效");
  const escaped = path.replaceAll("'", "''");
  const command = machine
    ? `Add-Type -AssemblyName System.Security;$v=Get-Content -Raw -LiteralPath '${escaped}'|ConvertFrom-Json;$b=[Convert]::FromBase64String($v.protected_token);$u=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine);try{[Text.Encoding]::UTF8.GetString($u)}finally{[Array]::Clear($u,0,$u.Length)}`
    : `$v=Get-Content -Raw -LiteralPath '${escaped}'|ConvertFrom-Json;$s=ConvertTo-SecureString $v.protected_token;$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 10_000, maxBuffer: 8_192 });
  const token = stdout.trim();
  if (!token) throw new FinnhubError("Finnhub 本机凭证无法解密");
  return token;
}

async function json(request: Request, token: string, path: string, params: Record<string, string>, signal: AbortSignal) {
  const url = new URL(`${FINNHUB_BASE_URL}${path}`);
  for (const [key, value] of Object.entries({ ...params, token })) url.searchParams.set(key, value);
  const response = await request(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new FinnhubError(`Finnhub ${path} 返回 HTTP ${response.status}`, response.status);
  const value = await response.json();
  const responseReceivedAt = new Date().toISOString();
  if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) throw new FinnhubError(`Finnhub ${path} 返回错误`);
  return { value, responseReceivedAt };
}

type StoredEvent = MarketIntelligenceUpdate["events"][number];

function normalizeNews(value: unknown, fetchedAt: string, responseReceivedAt: string, companySymbol?: string): StoredEvent[] {
  if (!Array.isArray(value)) throw new FinnhubError("Finnhub /news 返回格式无效");
  return value.slice(0, 50).map((raw): StoredEvent => {
    if (!raw || typeof raw !== "object") throw new FinnhubError("Finnhub /news 含无效项目");
    const item = raw as Record<string, unknown>;
    const title = text(item.headline), source = text(item.source);
    const timestamp = number(item.datetime);
    if (!title || !source || timestamp === null) throw new FinnhubError("Finnhub /news 含不完整项目");
    const publishedAt = utcIso(timestamp * 1_000);
    if (companySymbol && Date.parse(publishedAt) > Date.parse(responseReceivedAt)) throw new FinnhubError("Finnhub /company-news 含未来发布时间");
    const match = marketMoving(title);
    const eventFingerprint = match ? hash({ contract_version: "v1", category: match.category, event_key: match.eventKey, event_identity: match.eventKey, publication_date_utc: publishedAt.slice(0, 10) }) : null;
    const providerId = text(item.id) || (typeof item.id === "number" ? String(item.id) : "");
    const identity = providerId ? { provider: "Finnhub", provider_event_id: providerId } : { provider: "Finnhub", headline: title, source, published_at: publishedAt, url: text(item.url) };
    const eventId = hash(companySymbol ? { ...identity, endpoint: "/company-news", symbol: companySymbol } : identity);
    const rawJson = JSON.stringify(companySymbol ? { request: { path: "/company-news", symbol: companySymbol }, response: raw } : raw);
    return {
      event_id: eventId,
      event_fingerprint: eventFingerprint,
      kind: "NEWS",
      title,
      source,
      source_url: text(item.url) || null,
      published_at: publishedAt,
      scheduled_for: null,
      fetched_at: fetchedAt,
      response_received_at: responseReceivedAt,
      affected_symbols: inferNewsSymbols(title, symbols(item.related)),
      industry: null,
      event_type: match?.eventKey ?? (text(item.category) || "general"),
      novelty: "NEW",
      importance: match ? "MARKET_MOVING" : "NOT_VERIFIED",
      event_evidence_state: match ? (OFFICIAL_SINGLE_SOURCES.has(source) ? "VERIFIED" : "PARTIAL") : "UNVERIFIED",
      raw_json: rawJson,
      raw_sha256: createHash("sha256").update(rawJson).digest("hex"),
      event_category: match?.category ?? null,
      expires_at: match ? utcIso(Date.parse(publishedAt) + match.maxAgeHours * 3_600_000) : null,
    };
  }).filter((event) => !companySymbol || Date.parse(event.published_at!) >= Date.parse(fetchedAt) - 86_400_000);
}

function earningsSession(value: unknown) {
  const normalized = text(value).toLowerCase();
  return normalized === "bmo" ? "BMO" : normalized === "amc" ? "AMC" : normalized === "dmh" ? "DMH" : "UNKNOWN";
}

function earningsWindowOpen(date: string, session: "BMO" | "AMC" | "DMH" | "UNKNOWN", fetchedAt: string) {
  const eastern = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(fetchedAt)).map(({ type, value }) => [type, value]));
  const currentDate = `${eastern.year}-${eastern.month}-${eastern.day}`;
  if (date !== currentDate) return date < currentDate;
  const minutes = Number(eastern.hour) * 60 + Number(eastern.minute);
  return session === "BMO" ? minutes >= 570 : session === "AMC" ? minutes >= 960 : session === "DMH" ? minutes >= 960 : false;
}

function normalizeEarnings(value: unknown, fetchedAt: string, responseReceivedAt: string): StoredEvent[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).earningsCalendar)) throw new FinnhubError("Finnhub /calendar/earnings 返回格式无效");
  const rows = (value as { earningsCalendar: unknown[] }).earningsCalendar;
  let rejected = 0;
  const normalized = rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object") { rejected += 1; return []; }
    const item = raw as Record<string, unknown>;
    const symbol = text(item.symbol).toUpperCase(), scheduledFor = text(item.date);
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor) || Number.isNaN(Date.parse(`${scheduledFor}T00:00:00Z`))) { rejected += 1; return []; }
    const session = earningsSession(item.hour), epsActual = number(item.epsActual), revenueActual = number(item.revenueActual);
    const reported = earningsWindowOpen(scheduledFor, session, fetchedAt) && (epsActual !== null || revenueActual !== null);
    const result = {
      session,
      eps_actual: reported ? epsActual : null,
      eps_estimate: number(item.epsEstimate),
      revenue_actual: reported ? revenueActual : null,
      revenue_estimate: number(item.revenueEstimate),
      reported,
    } as const;
    return [{ raw, item, symbol, scheduledFor, result, revenue: Math.abs(result.revenue_estimate ?? 0) }];
  }).sort((a, b) => Number(UNIVERSE.has(b.symbol)) - Number(UNIVERSE.has(a.symbol)) || Number(b.result.reported) - Number(a.result.reported) || b.revenue - a.revenue).slice(0, 100);
  const events: StoredEvent[] = normalized.map(({ raw, symbol, scheduledFor, result }) => {
    const eventId = hash({ contract_version: "v1", component: "A1_EARNINGS_WATCH", symbol, date: scheduledFor, session: result.session, phase: result.reported ? "REPORTED" : "SCHEDULED" });
    return {
      event_id: eventId,
      event_fingerprint: null,
      kind: "EARNINGS",
      title: `${symbol} ${result.reported ? "财报结果" : "财报日历"}`,
      source: "Finnhub Earnings Calendar",
      source_url: null,
      published_at: null,
      scheduled_for: scheduledFor,
      fetched_at: fetchedAt,
      response_received_at: responseReceivedAt,
      affected_symbols: [symbol],
      industry: null,
      event_type: result.reported ? "earnings_result" : "earnings",
      novelty: "NEW",
      importance: "SCHEDULED",
      event_evidence_state: result.reported ? "VERIFIED" : "UNVERIFIED",
      earnings_result: result,
      raw_json: JSON.stringify(raw),
      raw_sha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      event_category: null,
      expires_at: null,
    };
  });
  return Object.assign(events, { rejected });
}

export async function collectFinnhubOfficial(options: FinnhubOptions, observedAt = new Date().toISOString()): Promise<MarketIntelligenceUpdate> {
  const fetchedAt = utcIso(observedAt);
  let token: string | null;
  try { token = options.token ?? await protectedToken(options.credentialPath); }
  catch (error) {
    return { source: { source: "FINNHUB", status: "NOT_VERIFIED", configured: true, authorization: "NOT_VERIFIED", last_success_at: null, as_of: null, freshness_seconds: null, error: safeError(error), checked_at: fetchedAt, capabilities: { news: false, earnings_calendar: false, earnings_results: false } }, events: [] };
  }
  if (!token) return { source: { source: "FINNHUB", status: "NOT_CONFIGURED", configured: false, authorization: "NOT_CONFIGURED", last_success_at: null, as_of: null, freshness_seconds: null, error: "尚未在此独立副本配置所选新闻源；请使用 Start.cmd 菜单11", checked_at: fetchedAt, capabilities: { news: false, earnings_calendar: false, earnings_results: false } }, events: [] };

  const request = options.request ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const day = fetchedAt.slice(0, 10);
  const start = utcIso(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).slice(0, 10);
  const end = utcIso(Date.parse(`${day}T00:00:00Z`) + 6 * 86_400_000).slice(0, 10);
  const fixedPool = options.approvedCapabilities?.fixed_pool;
  const ownerWatchlist = options.approvedCapabilities?.owner_watchlist;
  const ownerSymbols = ownerWatchlist?.status === "OBSERVED" ? ownerWatchlist.items.filter((symbol) => APPROVED_STOCKS.includes(symbol)) : [];
  const candidateSymbols = (fixedPool?.candidates ?? []).filter((symbol) => {
    const row = fixedPool?.rows.find((entry) => entry.symbol === symbol);
    return APPROVED_STOCKS.includes(symbol) && row?.status === "LIVE" && ["EARLY_WATCH", "CONFIRMED"].includes(row.swing.stage) && ["BULLISH", "BEARISH"].includes(row.swing.direction);
  });
  const companySymbols = [...new Set([...ownerSymbols, ...candidateSymbols])].slice(0, 3);
  const companyFrom = utcIso(Date.parse(fetchedAt) - 86_400_000).slice(0, 10);
  // ponytail: existing news check, at most three companies and one shared deadline; broader coverage needs a separate budget.
  const [newsResult, earningsResult, ...companyResults] = await Promise.allSettled([
    json(request, token, "/news", { category: "general", minId: "0" }, signal).then(({ value, responseReceivedAt }) => normalizeNews(value, fetchedAt, responseReceivedAt)),
    json(request, token, "/calendar/earnings", { from: start, to: end, international: "false" }, signal).then(({ value, responseReceivedAt }) => normalizeEarnings(value, fetchedAt, responseReceivedAt)),
    ...companySymbols.map((symbol) => json(request, token!, "/company-news", { symbol, from: companyFrom, to: day }, signal)
      .then(({ value, responseReceivedAt }) => normalizeNews(value, fetchedAt, responseReceivedAt, symbol))
      .catch((error) => { throw new FinnhubError(`Finnhub /company-news ${symbol}: ${safeError(error)}`, error instanceof FinnhubError ? error.status : null); })),
  ]);
  token = null;
  const newsOk = newsResult.status === "fulfilled", earningsEndpointOk = earningsResult.status === "fulfilled", earningsRejected = earningsEndpointOk ? Number((earningsResult.value as StoredEvent[] & { rejected?: number }).rejected ?? 0) : 0, earningsOk = earningsEndpointOk && earningsRejected === 0;
  const failures = [newsResult, earningsResult, ...companyResults].filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const authExpired = failures.some((result) => result.reason instanceof FinnhubError && [401, 403].includes(result.reason.status ?? 0));
  const anySuccess = newsOk || earningsEndpointOk || companyResults.some((result) => result.status === "fulfilled");
  return {
    source: {
      source: "FINNHUB",
      status: newsOk && earningsOk && companyResults.every((result) => result.status === "fulfilled") ? "LIVE" : anySuccess ? "DEGRADED" : "DATA_BLOCKED",
      configured: true,
      authorization: authExpired ? "EXPIRED" : anySuccess ? "VALID" : "NOT_VERIFIED",
      last_success_at: anySuccess ? fetchedAt : null,
      as_of: anySuccess ? fetchedAt : null,
      freshness_seconds: anySuccess ? 0 : null,
      error: [...failures.map((result) => safeError(result.reason)), ...(earningsRejected ? [`Finnhub财报日历隔离${earningsRejected}条不完整记录`] : [])].join("；") || null,
      checked_at: fetchedAt,
      capabilities: { news: newsOk, earnings_calendar: earningsEndpointOk, earnings_results: earningsEndpointOk },
    },
    events: [...(newsOk ? newsResult.value : []), ...(earningsEndpointOk ? earningsResult.value : []), ...companyResults.flatMap((result) => result.status === "fulfilled" ? result.value : [])],
  };
}
