import { createHash, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { startProdServer } from "vinext/server/prod-server";
import { handleComplaintApi, handleOutputGatewayApi, handleRunLedgerApi, handleSnapshotApi, openSnapshotDatabase } from "../build/local-data-core.ts";
import { createLiveShadowRuntime, type LiveShadowRuntimeOptions } from "./live-shadow-runtime.ts";
import { classifySpxContractQuote, collectExternalOptionQuote, collectRobinhoodAccount, collectSpxOptionChains, collectSpxOptionContracts, collectSpxOptionContractsById, collectSpxOptionHistory, collectSpxOptionQuotes, robinhoodMarketSession, selectChartSessions, withRobinhoodMcp, type RobinhoodChartData, type RobinhoodChartInterval, type RobinhoodChartRange, type SpxOptionChain } from "./robinhood-mcp.ts";
import { ownerObservationRows } from "../app/owner-market-decisions.ts";
import { spxContractIdentity } from "../app/spx-convexity-ledger.ts";
import type { PositionMonitorV1, ShadowComponentResult, SnapshotState, SpxContractQuoteStatus, SpxOptionContract, SpxOptionQuote } from "../app/snapshot-import.ts";
import { isOwnerSnapshotFresh } from "../app/snapshot-import.ts";
import { assessPositionRisks } from "./position-copilot.ts";
import type { InvestmentProfileMode } from "../app/investment-kernel.ts";
import { createIncidentGuard } from "./incident-guard.ts";
import { collectFinnhubOfficial } from "./finnhub.ts";
import { projectCompanyEvidence } from "../app/company-evidence.ts";
import { APPROVED_STOCKS } from "../app/snapshot-import.ts";
import { createTimelineScheduler } from "./timeline-scheduler.ts";
import { createCodexProductionManager, type CodexManagerInvoker } from "./codex-production-manager.ts";
import { runStartupRecovery } from "./startup-recovery.ts";
import { CODEX_MANAGER_TRIGGERS, codexManagerCommandReceipt, type CodexManagerActionKind, type CodexManagerOperation, type CodexManagerTrigger, type CodexRecoveryAttribution } from "../app/codex-production-manager.ts";
import { createExternalExpertMonitor } from "./external-expert-monitor.ts";
import { OwnerPositionPlanError } from "../app/owner-position-plan.ts";
import { createStockManualRuntime } from "./stock-manual-runtime.ts";
import { readEventDisclosureObservation, renderEventDisclosureObservation } from "./event-disclosure-observation.ts";
import { createPaperPlanRuntime } from "./paper-plan-runtime.ts";
import { createSpxPaperRuntime } from "./spx-paper-runtime.ts";
import { publicAutomationEnabled, publicProfile, publicResearchConfigured } from "./public-runtime.ts";
import { activeSourceSelection, collectSelectedMarket, selectedMarketChart } from "./selected-sources.ts";

const OWNER = "owner";
const OWNER_PORT = 4160;
const COOKIE = "trading_os_owner";
const PBKDF2_ITERATIONS = 210_000;
const DEFAULT_SESSION_TTL_MINUTES = 8 * 60;
const LOGIN_WINDOW_MS = 10 * 60_000;
const MAX_LOGIN_FAILURES = 5;
const PROJECT_ID = "trading-os-stock-web";

function unavailableSpxQuote(observedAt: string, status?: Extract<SpxContractQuoteStatus, "SOURCE_UNAVAILABLE">): SpxOptionQuote {
  const classified = classifySpxContractQuote({ bid: null, ask: null, mark: null, quoted_at: null, freshness_seconds: null }, observedAt);
  return { bid: null, ask: null, mark: null, iv: null, delta: null, gamma: null, theta: null, vega: null, quoted_at: null, freshness_seconds: null, status: "DATA_BLOCKED", contract_quote_status: status ?? classified.status, source_session: classified.source_session, observed_session: classified.observed_session };
}

type OwnerCredentials = {
  version: 1;
  username: typeof OWNER;
  salt: string;
  password_hash: string;
  iterations: number;
  session_ttl_minutes: number;
};

type OwnerSessionFile = {
  version: 1;
  credential_fingerprint: string;
  sessions: Array<{ token_hash: string; expires_at: number }>;
};

type TrustedHomeAccess = {
  enabled: boolean;
  trusted_cidrs: string[];
};

type OwnerServerOptions = {
  projectRoot?: string;
  host?: string;
  port?: number;
  outDir?: string;
  databasePath?: string;
  credentialsPath?: string;
  gatewayKeyPath?: string;
  lockPath?: string;
  sessionTtlMs?: number;
  shadowRuntime?: false | Partial<Omit<LiveShadowRuntimeOptions, "origin" | "gatewayKey">>;
  incidentGuard?: false;
  codexManager?: false | { invoke?: CodexManagerInvoker; now?: () => Date };
  finnhubCredentialPath?: string;
  dataRoot?: string;
  trustedHomeAccessPath?: string;
  investmentProfile?: InvestmentProfileMode;
  ownerActionTimeoutMs?: number;
  runtimeRole?: "COMBINED" | "WEB" | "TIER0";
  tier0Origin?: string;
  snapshotWorker?: false;
  spxOptionProvider?: {
    chains(): Promise<SpxOptionChain[]>;
    contracts(filter: { chain_symbol: "SPX" | "SPXW"; expiration_date: string; strike: number; option_type: "call" | "put" }): Promise<SpxOptionContract[]>;
    contractsById(ids: string[]): Promise<SpxOptionContract[]>;
    quotes(contracts: SpxOptionContract[], observedAt?: string): Promise<Array<{ contract: SpxOptionContract; quote: SpxOptionQuote }>>;
    history?(contractIds: string[], startTime: string, endTime: string): Promise<unknown>;
  };
};

class OwnerActionTimeout extends Error {}

async function beforeDeadline<T>(value: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new OwnerActionTimeout(`Owner动作超过${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveStockProjectPaths(projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), configuredDataRoot = process.env.TRADING_OS_DATA_ROOT, configuredProjectId = process.env.TRADING_OS_PROJECT_ID) {
  const root = resolve(projectRoot), markerPath = resolve(root, "PROJECT_BOUNDARY.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { project_id?: unknown; data_root?: unknown };
  if (marker.project_id !== PROJECT_ID || marker.data_root !== "data") throw new Error(`Trading OS 股票网站项目边界无效：${markerPath}`);
  if (configuredProjectId && configuredProjectId !== PROJECT_ID) throw new Error(`拒绝跨项目运行：${configuredProjectId}`);
  const dataRoot = resolve(configuredDataRoot ?? resolve(root, "data"));
  if (dataRoot !== resolve(root, "data")) throw new Error(`拒绝跨项目数据目录：${dataRoot}`);
  return { projectRoot: root, dataRoot };
}

function credentialFile(path = resolve(resolveStockProjectPaths().dataRoot, "owner-access.json")) {
  return path;
}

function restrictLocalSecret(path: string) {
  if (process.platform !== "win32") return chmodSync(path, 0o600);
  const identity = execFileSync("whoami.exe", { encoding: "utf8", windowsHide: true }).trim();
  if (!identity) throw new Error("无法确认本机 Owner 身份，拒绝保存秘密文件");
  execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], { stdio: "ignore", windowsHide: true });
}

function writeLocalSecret(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    restrictLocalSecret(temporary);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* not created or already renamed */ }
    throw error;
  }
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" }); renameSync(temporary, path); }
  catch (error) { try { unlinkSync(temporary); } catch { /* not created or already renamed */ } throw error; }
}

export function writeOwnerCredentials(path: string, password: string) {
  if (password.length < 12) throw new Error("Owner 密码至少需要 12 个字符");
  if (existsSync(path)) throw new Error(`Owner 凭据已存在：${path}`);
  const salt = randomBytes(16);
  const credentials: OwnerCredentials = {
    version: 1,
    username: OWNER,
    salt: salt.toString("base64url"),
    password_hash: pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("base64url"),
    iterations: PBKDF2_ITERATIONS,
    session_ttl_minutes: DEFAULT_SESSION_TTL_MINUTES,
  };
  writeLocalSecret(path, `${JSON.stringify(credentials, null, 2)}\n`);
  return path;
}

function loadOwnerCredentials(path: string): OwnerCredentials {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`无法读取 Owner 凭据。请先运行 pnpm owner:setup（${path}）`);
  }
  if (!value || typeof value !== "object") throw new Error("Owner 凭据格式无效");
  const credentials = value as Partial<OwnerCredentials>;
  const salt = typeof credentials.salt === "string" ? Buffer.from(credentials.salt, "base64url") : Buffer.alloc(0);
  const hash = typeof credentials.password_hash === "string" ? Buffer.from(credentials.password_hash, "base64url") : Buffer.alloc(0);
  if (credentials.version !== 1 || credentials.username !== OWNER || !Number.isInteger(credentials.iterations) || (credentials.iterations ?? 0) < 100_000 || !Number.isInteger(credentials.session_ttl_minutes) || (credentials.session_ttl_minutes ?? 0) < 1 || salt.length !== 16 || hash.length !== 32) {
    throw new Error("Owner 凭据格式无效");
  }
  return credentials as OwnerCredentials;
}

function passwordMatches(password: string, credentials: OwnerCredentials) {
  // ponytail: one local Owner keeps synchronous PBKDF2 simple; switch to async if concurrent accounts are ever added.
  const actual = pbkdf2Sync(password, Buffer.from(credentials.salt, "base64url"), credentials.iterations, 32, "sha256");
  return timingSafeEqual(actual, Buffer.from(credentials.password_hash, "base64url"));
}

function credentialFingerprint(credentials: OwnerCredentials) {
  return createHash("sha256").update(`${credentials.username}\0${credentials.salt}\0${credentials.password_hash}\0${credentials.iterations}`).digest("base64url");
}

function sessionHash(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

function loadOwnerSessions(path: string, credentials: OwnerCredentials) {
  const sessions = new Map<string, number>();
  if (!existsSync(path)) return sessions;
  restrictLocalSecret(path);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnerSessionFile>;
    if (value.version !== 1 || value.credential_fingerprint !== credentialFingerprint(credentials) || !Array.isArray(value.sessions)) return sessions;
    for (const row of value.sessions) if (/^[A-Za-z0-9_-]{43}$/.test(row.token_hash) && Number.isSafeInteger(row.expires_at) && row.expires_at > Date.now()) sessions.set(row.token_hash, row.expires_at);
  } catch { /* A damaged session file fails closed; the Owner can log in again. */ }
  return sessions;
}

function saveOwnerSessions(path: string, credentials: OwnerCredentials, sessions: Map<string, number>) {
  const value: OwnerSessionFile = { version: 1, credential_fingerprint: credentialFingerprint(credentials), sessions: [...sessions].map(([token_hash, expires_at]) => ({ token_hash, expires_at })) };
  writeLocalSecret(path, `${JSON.stringify(value)}\n`);
}

function processExists(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireProcessLock(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch { /* already removed */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const activePid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (processExists(activePid)) throw new Error(`Trading OS 已在运行（PID ${activePid}）`);
      unlinkSync(path);
    }
  }
  throw new Error("无法取得 Trading OS 单进程锁");
}

function loadOrCreateGatewayKey(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeLocalSecret(path, `${randomBytes(32).toString("base64url")}\n`);
  else restrictLocalSecret(path);
  const key = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("本地写入密钥格式无效");
  return key;
}

function gatewayAuthorized(request: IncomingMessage, key: string) {
  const header = request.headers.authorization;
  const candidate = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(createHash("sha256").update(candidate).digest(), createHash("sha256").update(key).digest());
}

export function isPrivateClient(address: string | undefined) {
  if (!address) return false;
  const value = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (value === "127.0.0.1" || value === "::1") return true;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

export function isLoopbackClient(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function ipv4Number(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function trustedCidr(value: string) {
  const [address, prefixText, ...rest] = value.split("/"), prefix = Number(prefixText), network = ipv4Number(address);
  if (rest.length || network === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) return null;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  if ((network & mask) >>> 0 !== network) return null;
  const privateRange = (network >>> 24) === 10 && prefix >= 8
    || (network >>> 20) === 0xac1 && prefix >= 12
    || (network >>> 16) === 0xc0a8 && prefix >= 16;
  return privateRange ? { network, mask } : null;
}

export function isTrustedHomeClient(address: string | undefined, cidrs: string[]) {
  if (!address || !Array.isArray(cidrs) || cidrs.length === 0) return false;
  const ranges = cidrs.map(trustedCidr);
  if (ranges.some((range) => range === null)) return false;
  if (isLoopbackClient(address)) return true;
  const client = ipv4Number(address.startsWith("::ffff:") ? address.slice(7) : address);
  return client !== null && ranges.some((range) => range !== null && ((client & range.mask) >>> 0) === range.network);
}

function loadTrustedHomeAccess(path: string): TrustedHomeAccess {
  if (!existsSync(path)) return { enabled: false, trusted_cidrs: [] };
  restrictLocalSecret(path);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustedHomeAccess> & { version?: unknown };
    if (value.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.trusted_cidrs) || value.trusted_cidrs.some((cidr) => typeof cidr !== "string")) throw new Error("invalid config");
    if (value.enabled && !isTrustedHomeClient("127.0.0.1", value.trusted_cidrs)) throw new Error("invalid trusted CIDR");
    return { enabled: value.enabled, trusted_cidrs: value.trusted_cidrs };
  } catch { return { enabled: false, trusted_cidrs: [] }; }
}

function sameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  const referer = request.headers.referer;
  const expected = typeof host === "string" ? `http://${host}` : "";
  let refererOrigin = "";
  try { refererOrigin = typeof referer === "string" ? new URL(referer).origin : ""; } catch { /* invalid source */ }
  return (typeof origin === "string" && origin === expected)
    || (refererOrigin === expected && expected !== "")
    || (origin === undefined && request.headers["sec-fetch-site"] === "same-origin");
}

async function readForm(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("登录请求过大");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 16_384) throw new Error("请求过大"); chunks.push(buffer); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效");
  return value as Record<string, unknown>;
}

function securityHeaders(contentType: string) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function safeReturnPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  const target = new URL(value, "http://local");
  return target.origin === "http://local" ? `${target.pathname}${target.search}${target.hash}` : "/";
}

function loginPage(message = "", returnTo = "/") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owner 登录 | Trading OS</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1012;color:#eef1f3;font:15px system-ui,sans-serif}.card{width:min(440px,calc(100% - 32px));border:1px solid #2a3035;border-radius:12px;background:#15191c;padding:28px;box-shadow:0 24px 70px #0008}h1{margin:0 0 6px;font-size:24px}.note{margin:0 0 18px;color:#929da5}.access{margin:0 0 20px;border:1px solid #303a40;border-radius:8px;background:#101417;padding:12px;color:#b8c2c8;line-height:1.55}.access b{color:#edf3f6}.access code{color:#cce8a8;overflow-wrap:anywhere}.error{border-left:3px solid #de725b;background:#2a1815;padding:10px;margin:0 0 16px;color:#ffb8a8}label{display:block;margin:14px 0 6px;color:#b8c0c5}input{width:100%;border:1px solid #374047;border-radius:7px;background:#0d1012;color:#fff;padding:11px}button{width:100%;min-height:44px;margin-top:22px;border:0;border-radius:7px;background:#b7df69;color:#11170b;font-weight:800;padding:12px;cursor:pointer}small{display:block;margin-top:18px;color:#6f7a82;line-height:1.5}
</style></head><body><main class="card"><h1>Trading OS</h1><p class="note">独立本地工作区</p><p class="access"><b>本机访问入口</b><br><code>http://127.0.0.1:4160</code><br>此版本仅允许本机访问，不开放家庭网络或公网。</p>${message ? `<p class="error" role="alert">${message}</p>` : ""}<form method="post" action="/login"><input name="return_to" type="hidden" value="${returnTo.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"><label for="username">账号</label><input id="username" name="username" value="owner" autocomplete="username" readonly><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form><small>使用首次设置时创建的本地密码；不需要邮箱注册。</small></main></body></html>`;
}

function sendHtml(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, securityHeaders("text/html; charset=utf-8"));
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  const value = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { ...securityHeaders("application/json; charset=utf-8"), "content-length": value.length });
  response.end(value);
}

function sendSerializedJson(response: ServerResponse, status: number, value: string) {
  response.writeHead(status, { ...securityHeaders("application/json; charset=utf-8"), "content-length": Buffer.byteLength(value) });
  response.end(value);
}

type OwnerSnapshotView = "home" | "forecast" | "options" | "company" | "health" | "settlements" | "issues";

function compactA1(output: SnapshotState["outputs"]["A1_SHADOW_RESULT"]) {
  if (!output?.market_sources) return output;
  const market = output.market_sources;
  return { ...output, market_sources: { ...market, approved_capabilities: undefined, bars: [], options: [], account: { ...market.account, positions: market.account.positions === null ? null : [], orders: [] } } };
}

function compactHomeMarketRadar(marketRadar: SnapshotState["marketRadar"]) {
  if (!marketRadar.snapshot) return marketRadar;
  const snapshot = marketRadar.snapshot;
  const candidates = ownerObservationRows(snapshot).map((row) => row.symbol);
  const candidateSet = new Set(candidates);
  const retainedSymbols = new Set([...candidates, "SPY", "QQQ"]);
  return { ...marketRadar, snapshot: {
    ...snapshot,
    fixed_pool: { ...snapshot.fixed_pool, candidates, missing_symbols: [], rows: snapshot.fixed_pool.rows.filter((row) => retainedSymbols.has(row.symbol)) },
    earnings_center: { ...snapshot.earnings_center, items: snapshot.earnings_center.items.filter((item) => candidateSet.has(item.symbol)).slice(0, 5) },
    event_scan: { ...snapshot.event_scan, items: snapshot.event_scan.items.filter((item) => item.affected_symbols.some((symbol) => candidateSet.has(symbol))).slice(0, 5) },
    provenance: [],
  } };
}

export function ownerSnapshotView(state: SnapshotState, view: OwnerSnapshotView) {
  if (state.spxConvexity) {
    // Archived candidate contracts can contain whole watches; page views need only contract identity.
    const compactCandidate = <T extends { contract: SpxOptionContract }>(candidate: T): T => ({ ...candidate, contract: spxContractIdentity(candidate.contract) });
    const compactOpportunity = (opportunity: NonNullable<SnapshotState["spxConvexity"]["current"]>) => ({ ...opportunity, frozen_candidates: opportunity.frozen_candidates.map(compactCandidate), candidates: opportunity.candidates.map(compactCandidate) });
    state = { ...state, spxConvexity: { ...state.spxConvexity, current: state.spxConvexity.current ? compactOpportunity(state.spxConvexity.current) : null, history: state.spxConvexity.history.map(compactOpportunity) } };
  }
  if (view === "forecast") return {
    ...state,
    spxwProxy: { ...state.spxwProxy, watches: state.spxwProxy.watches.map((watch) => ({ ...watch,
      quote_snapshot_count: watch.quote_snapshot_count ?? watch.events.filter((event) => event.event_type === "QUOTE").length,
      // The page needs the count and first ending, not the growing quote history. Full events remain in the source.
      events: watch.events.filter((event) => event.event_type === "ENDED").slice(0, 1).map((event) => ({ ...event, spy_snapshot: null, quote: null })),
    })) },
    payload: null,
    recentOutputs: [],
    runLedger: { ...state.runLedger, runs: [] },
    selfCheck: { ...state.selfCheck, recent: [] },
    marketIntelligence: { ...state.marketIntelligence, events: [], causalChains: [] },
    scheduler: { ...state.scheduler, groups: [], recent: [] },
    marketRadar: { snapshot: null, source_record_id: null, market_snapshot_id: null, market_snapshot_hash: null, archived_at: null },
    tsSettlement: { ...state.tsSettlement, exclusions: [], recent: [], review_evidence: null },
    optionLifecycle: { ...state.optionLifecycle, recent_settlements: [] },
    externalExpert: { ...state.externalExpert, cases: [] },
    paperPlans: undefined,
    outputs: { ...state.outputs, TS_OUTPUT: [], A1_SHADOW_RESULT: null, A2_SHADOW_RESULT: null, CODEX_GUARD_SHADOW: null, COMMITTEE_SHADOW_OUTPUT: null, D_SHADOW_OUTPUT: null, A3_REVIEW_SHADOW: null, A3_FINAL_SHADOW: null, SCHEDULE_CHECKPOINT: state.outputs.SCHEDULE_CHECKPOINT.filter((item) => item.kind === "EVENING_ANALYSIS").slice(0, 1), OPTION_STRATEGY_SIGNAL: [], STOCK_MANUAL_PLAN: [], POSITION_COPILOT_STATE: [] },
  } satisfies SnapshotState;
  const outputs = { ...state.outputs, A1_SHADOW_RESULT: compactA1(state.outputs.A1_SHADOW_RESULT), STOCK_MANUAL_PLAN: view === "home" || view === "options" ? (state.outputs.STOCK_MANUAL_PLAN ?? []).slice(0, 3) : [] };
  if (view === "home") {
    outputs.TS_OUTPUT = outputs.TS_OUTPUT.slice(0, 1); outputs.TS_SHADOW_OUTPUT = outputs.TS_SHADOW_OUTPUT.slice(0, 2);
    outputs.OPTION_STRATEGY_SIGNAL = outputs.OPTION_STRATEGY_SIGNAL.slice(0, 1); outputs.POSITION_COPILOT_STATE = outputs.POSITION_COPILOT_STATE.slice(0, 1);
    const latestEvening = outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "EVENING_ANALYSIS");
    const latestPositionMonitor = outputs.SCHEDULE_CHECKPOINT.find((item) => item.kind === "POSITION_MONITOR");
    outputs.SCHEDULE_CHECKPOINT = [...outputs.SCHEDULE_CHECKPOINT.slice(0, 5), ...(latestEvening ? [latestEvening] : []), ...(latestPositionMonitor ? [latestPositionMonitor] : [])].filter((item, index, items) => items.findIndex((candidate) => candidate.slot_id === item.slot_id) === index);
  } else if (view === "options") {
    outputs.TS_OUTPUT = []; outputs.TS_SHADOW_OUTPUT = outputs.TS_SHADOW_OUTPUT.slice(0, 2); outputs.SCHEDULE_CHECKPOINT = outputs.SCHEDULE_CHECKPOINT.filter((item) => item.kind === "POSITION_MONITOR").slice(0, 1);
    const market = outputs.A1_SHADOW_RESULT?.market_sources;
    if (market) market.account = { ...market.account, orders: state.outputs.A1_SHADOW_RESULT?.market_sources?.account.orders?.slice(0, 10) ?? [] };
  } else if (view === "company") {
    outputs.TS_OUTPUT = []; outputs.TS_SHADOW_OUTPUT = outputs.TS_SHADOW_OUTPUT.slice(0, 2); outputs.OPTION_STRATEGY_SIGNAL = []; outputs.POSITION_COPILOT_STATE = [];
  } else if (view === "health") {
    outputs.TS_OUTPUT = []; outputs.TS_SHADOW_OUTPUT = outputs.TS_SHADOW_OUTPUT.slice(0, 1); outputs.A1_SHADOW_RESULT = null; outputs.A2_SHADOW_RESULT = null; outputs.OPTION_STRATEGY_SIGNAL = []; outputs.POSITION_COPILOT_STATE = []; outputs.SCHEDULE_CHECKPOINT = outputs.SCHEDULE_CHECKPOINT.slice(0, 5);
  } else if (view === "settlements") {
    outputs.A1_SHADOW_RESULT = null; outputs.A2_SHADOW_RESULT = null; outputs.SCHEDULE_CHECKPOINT = []; outputs.OPTION_STRATEGY_SIGNAL = []; outputs.POSITION_COPILOT_STATE = [];
  } else {
    outputs.TS_OUTPUT = outputs.TS_OUTPUT.slice(0, 1); outputs.TS_SHADOW_OUTPUT = outputs.TS_SHADOW_OUTPUT.slice(0, 2); outputs.OPTION_STRATEGY_SIGNAL = []; outputs.POSITION_COPILOT_STATE = outputs.POSITION_COPILOT_STATE.slice(0, 1);
  }
  if (view === "home" || view === "health") {
    const latestManager = state.outputs.SCHEDULE_CHECKPOINT.find((item) => item.manager_review);
    if (latestManager && !outputs.SCHEDULE_CHECKPOINT.some((item) => item.slot_id === latestManager.slot_id)) outputs.SCHEDULE_CHECKPOINT = [...outputs.SCHEDULE_CHECKPOINT, latestManager];
  }
  const keepMarket = view === "company" || view === "issues";
  const keepSettlement = view === "home" || view === "settlements" || view === "issues";
  const keepOptionLifecycle = view === "options" || view === "settlements";
  const keepExternalExpert = view === "settlements";
  const planSignal = view === "home" || view === "options" ? outputs.OPTION_STRATEGY_SIGNAL[0] : null;
  const planRunId = planSignal?.source_mode === "LIVE" && planSignal.owner_action === "EXECUTABLE" ? planSignal.source_run_id : null;
  const planAgents = ["A1", "A2", "TS", "D", "A3"];
  const planRecords = planRunId ? state.recentOutputs.filter((row) => planAgents.some((agent) => row.record_id === `${planRunId}:${agent}`) && row.channel === "SHADOW") : [];
  const planRuns = planRunId ? state.runLedger.runs.filter((row) => row.run_id === planRunId && row.slot_id === planSignal?.slot_id && row.channel === "SHADOW" && planAgents.includes(row.agent_id) && row.skill_id === (row.agent_id === "A3" ? "A3_FINAL_LIVE_SHADOW" : `${row.agent_id}_LIVE_SHADOW`)) : [];
  const runs = [...state.runLedger.runs.slice(0, view === "company" ? 100 : 30), ...planRuns].filter((row, index, rows) => rows.findIndex((item) => item.run_id === row.run_id && item.skill_id === row.skill_id) === index);
  return {
    ...state,
    outputs,
    paperPlans: view === "home" || view === "options" ? state.paperPlans : undefined,
    recentOutputs: view === "company" || view === "issues" ? state.recentOutputs.slice(0, 20) : planRecords,
    runLedger: { ...state.runLedger, runs },
    marketIntelligence: keepMarket ? state.marketIntelligence : { ...state.marketIntelligence, events: [], causalChains: [] },
    marketRadar: view === "home" ? compactHomeMarketRadar(state.marketRadar) : keepMarket ? state.marketRadar : { snapshot: null, source_record_id: null, market_snapshot_id: null, market_snapshot_hash: null, archived_at: null },
    tsSettlement: keepSettlement ? state.tsSettlement : { ...state.tsSettlement, exclusions: [], recent: [], review_evidence: null },
    ownerTrigger: { current: { SPY: null, QQQ: null }, recent: [] },
    spxwProxy: { ...state.spxwProxy, watches: [], real_holdings: [], owner_observations: [] },
    optionLifecycle: keepOptionLifecycle ? state.optionLifecycle : { ...state.optionLifecycle, recent_settlements: [] },
    externalExpert: view === "home" ? { ...state.externalExpert, cases: state.externalExpert.cases.filter((item) => item.status === "OPEN" || item.status === "PARTIAL_EXIT").slice(0, 1) } : keepExternalExpert ? state.externalExpert : { ...state.externalExpert, cases: [] },
  } satisfies SnapshotState;
}

function redirect(response: ServerResponse, location: string, cookie?: string) {
  response.writeHead(303, { ...securityHeaders("text/plain; charset=utf-8"), location, ...(cookie ? { "set-cookie": cookie } : {}) });
  response.end("See Other");
}

function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function startOwnerServer(options: OwnerServerOptions = {}) {
  const runtimeStartedAt = new Date();
  const runtimeRole = options.runtimeRole ?? "COMBINED";
  const tier0Origin = options.tier0Origin ?? "http://127.0.0.1:4161";
  const { projectRoot, dataRoot } = resolveStockProjectPaths(options.projectRoot, options.dataRoot);
  const credentialsPath = credentialFile(options.credentialsPath ?? resolve(dataRoot, "owner-access.json"));
  if (existsSync(credentialsPath)) restrictLocalSecret(credentialsPath);
  const credentials = loadOwnerCredentials(credentialsPath);
  const trustedHomeAccess = loadTrustedHomeAccess(options.trustedHomeAccessPath ?? resolve(dataRoot, "trusted-home-access.json"));
  const packageMetadata = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageMetadata.version !== "string" || !packageMetadata.version) throw new Error("package.json 缺少网站版本");
  const siteVersion = packageMetadata.version;
  const lockPath = options.lockPath ?? resolve(dataRoot, "local-owner.pid");
  const releaseLock = acquireProcessLock(lockPath);
  let gatewayKey: string;
  let snapshots: ReturnType<typeof openSnapshotDatabase>;
  try {
    gatewayKey = loadOrCreateGatewayKey(options.gatewayKeyPath ?? resolve(dataRoot, "local-output-gateway.key"));
    snapshots = openSnapshotDatabase(options.databasePath ?? resolve(dataRoot, "trading-os-web.sqlite"), { investmentProfile: options.investmentProfile, sourceSelection: process.env.TRADING_OS_SOURCE_SETTINGS ? activeSourceSelection(resolve(projectRoot, "..")) : null });
  } catch (error) {
    releaseLock();
    throw error;
  }
  const ttl = options.sessionTtlMs ?? credentials.session_ttl_minutes * 60_000;
  const sessionPath = resolve(dirname(credentialsPath), "owner-sessions.json");
  const sessions = loadOwnerSessions(sessionPath, credentials);
  const failures = new Map<string, { count: number; resetAt: number }>();
  let internal: Awaited<ReturnType<typeof startProdServer>> | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  let shadowRuntime: ReturnType<typeof createLiveShadowRuntime> | null = null;
  let timelineScheduler: ReturnType<typeof createTimelineScheduler> | null = null;
  let incidentGuard: ReturnType<typeof createIncidentGuard> | null = null;
  let codexManager: ReturnType<typeof createCodexProductionManager> | null = null;
  let startupRecovery: Promise<unknown> | null = null;
  let businessHeartbeatTimer: NodeJS.Timeout | null = null;
  let snapshotWorker: Worker | null = null;
  let prebuiltSnapshots: { generatedAt: string; values: Record<string, string> } | null = null;
  let closed = false;
  let performanceEvidenceEnabled = false;
  const snapshotCache = new Map<"full" | "forecast" | "settlements", { expiresAt: number; generatedAt: string; value: Promise<SnapshotState> }>();
  const chartCache = new Map<string, { expiresAt: number; value: Promise<RobinhoodChartData> }>();
  let finnhubCache: { expiresAt: number; value: ReturnType<typeof collectFinnhubOfficial> } | null = null;

  const activeSnapshot = async (view: OwnerSnapshotView | null) => {
    const key = view === "forecast" ? "forecast" : view === "settlements" ? "settlements" : "full", cached = snapshotCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { value: await cached.value, generatedAt: cached.generatedAt, cache: "HIT" as const };
    const entry = { expiresAt: Date.now() + 10_000, generatedAt: new Date().toISOString(), value: snapshots.getActiveAsync(view === "forecast" ? "forecast" : view === "settlements" ? "settlements" : undefined) };
    snapshotCache.set(key, entry);
    try { const value = await entry.value; entry.generatedAt = new Date().toISOString(); entry.expiresAt = Date.now() + 10_000; return { value, generatedAt: entry.generatedAt, cache: "MISS" as const }; }
    catch (error) { if (snapshotCache.get(key) === entry) snapshotCache.delete(key); throw error; }
  };
  const invalidateSnapshot = () => { snapshotCache.clear(); snapshotWorker?.postMessage("refresh"); };
  const externalExpertMonitor = createExternalExpertMonitor(snapshots, (filter) => withRobinhoodMcp({ projectRoot, timeoutMs: 20_000, allowlist: ["get_option_instruments", "get_option_quotes"] }, (session) => collectExternalOptionQuote(session, filter)));
  const logPerformance = (body: Record<string, unknown>) => {
    if (!performanceEvidenceEnabled) return;
    const path = resolve(dataRoot, "logs", `owner-server-performance-${new Date().toISOString().slice(0, 10)}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
  };

  const marketChart = (symbol: "SPY" | "QQQ", interval: RobinhoodChartInterval, range: RobinhoodChartRange) => {
    const settings = activeSourceSelection(resolve(projectRoot, ".."));
    const key = `${settings?.selection_id ?? "none"}:${symbol}:${interval}:${range}`;
    const cached = chartCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = selectedMarketChart(symbol, interval, range, resolve(projectRoot, ".."));
    chartCache.set(key, { expiresAt: Date.now() + 45_000, value });
    void value.catch(() => { if (chartCache.get(key)?.value === value) chartCache.delete(key); });
    return value;
  };
  const spxOptions = options.spxOptionProvider ?? {
    chains: () => withRobinhoodMcp({ projectRoot, allowlist: ["get_option_chains"] }, collectSpxOptionChains),
    contracts: (filter: { chain_symbol: "SPX" | "SPXW"; expiration_date: string; strike: number; option_type: "call" | "put" }) => withRobinhoodMcp({ projectRoot, allowlist: ["get_option_chains", "get_option_instruments"] }, (session) => collectSpxOptionContracts(session, filter)),
    contractsById: (ids: string[]) => withRobinhoodMcp({ projectRoot, allowlist: ["get_option_chains", "get_option_instruments"] }, (session) => collectSpxOptionContractsById(session, ids)),
    quotes: (contracts: SpxOptionContract[], observedAt = new Date().toISOString()) => withRobinhoodMcp({ projectRoot, allowlist: ["get_option_quotes"] }, (session) => collectSpxOptionQuotes(session, contracts, observedAt)),
    history: (contractIds: string[], startTime: string, endTime: string) => withRobinhoodMcp({ projectRoot, allowlist: ["get_option_historicals"] }, (session) => collectSpxOptionHistory(session, contractIds, startTime, endTime)),
  };
  const ownerActionTimeoutMs = options.ownerActionTimeoutMs ?? 30_000;
  const ownerActionTasks = new Map<string, Promise<void>>();
  const readSpxContract = async (filter: { chain_symbol: "SPX" | "SPXW"; expiration_date: string; strike: number; option_type: "call" | "put" }) => {
    const contracts = await spxOptions.contracts(filter);
    if (!contracts.length) return { action_status: "FAILED" as const, status: "CONTRACT_NOT_FOUND" as const, source: "ROBINHOOD_OFFICIAL_READONLY" as const, quoted_at: null, source_session: null, observed_session: null, contracts: [], error: "CONTRACT_NOT_FOUND · 精确条件没有返回真实合约；未自动改选Strike" };
    const observedAt = new Date().toISOString(), values = await spxOptions.quotes(contracts, observedAt), first = values[0] ?? { contract: contracts[0], quote: unavailableSpxQuote(observedAt) }, details = classifySpxContractQuote(first.quote, observedAt);
    const classified = first.quote.contract_quote_status ?? details.status, quote = { ...first.quote, contract_quote_status: classified, source_session: first.quote.source_session ?? details.source_session, observed_session: first.quote.observed_session ?? details.observed_session }, quotedAt = quote.quoted_at;
    const messages: Partial<Record<SpxContractQuoteStatus, string>> = {
      CONTRACT_FOUND_QUOTE_STALE: "合约已找到；Bid/Ask为过期快照，不作为当前入场或盈亏证据",
      CONTRACT_FOUND_NO_TWO_SIDED_QUOTE: "合约已找到；当前没有完整双边Bid/Ask",
      PROVIDER_GTH_UNAVAILABLE: "合约已找到；Robinhood当前未返回可验证的GTH期权报价",
    };
    return { action_status: "SUCCEEDED" as const, status: classified, source: "ROBINHOOD_OFFICIAL_READONLY" as const, quoted_at: quotedAt, source_session: quote.source_session ?? null, observed_session: quote.observed_session ?? null, contracts: [{ contract: first.contract, quote }], ...(messages[classified] ? { message: messages[classified] } : {}) };
  };
  const startSpxContractRead = (actionId: string) => {
    if (ownerActionTasks.has(actionId)) return;
    const task = (async () => {
      const receipt = snapshots.getOwnerAction(actionId);
      if (!receipt || ["SUCCEEDED", "FAILED", "TIMED_OUT"].includes(receipt.status)) return;
      snapshots.recordOwnerActionStatus(actionId, "RUNNING");
      try {
        const result = await beforeDeadline(readSpxContract(receipt.request as { chain_symbol: "SPX" | "SPXW"; expiration_date: string; strike: number; option_type: "call" | "put" }), ownerActionTimeoutMs);
        snapshots.recordOwnerActionStatus(actionId, result.action_status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED", result, result.action_status === "FAILED" ? result.error : null);
      } catch (error) {
        const timedOut = error instanceof OwnerActionTimeout;
        snapshots.recordOwnerActionStatus(actionId, timedOut ? "TIMED_OUT" : "FAILED", { action_status: timedOut ? "TIMED_OUT" : "FAILED", status: timedOut ? "TIMED_OUT" : "SOURCE_UNAVAILABLE", source: "ROBINHOOD_OFFICIAL_READONLY", quoted_at: null, source_session: null, observed_session: null, contracts: [] }, timedOut ? `TIMED_OUT · Robinhood精确合约读取达到后台${ownerActionTimeoutMs}ms权威超时` : "SOURCE_UNAVAILABLE · Robinhood官方合约或报价读取失败");
      }
    })().finally(() => ownerActionTasks.delete(actionId));
    ownerActionTasks.set(actionId, task);
  };
  for (const action of snapshots.getPendingOwnerActions()) startSpxContractRead(action.action_id);

  const finnhubNews = () => {
    if (!publicAutomationEnabled() || activeSourceSelection(resolve(projectRoot, ".."))?.selected.news.provider !== "FINNHUB") return collectFinnhubOfficial({ token: "", credentialPath: "", approvedCapabilities: null });
    if (finnhubCache && finnhubCache.expiresAt > Date.now()) return finnhubCache.value;
    const value = (async () => {
      // Read already archived candidates; never wait for or start an A1 collection from the news check.
      const radar = (() => { try { return snapshots.getMarketRadar(); } catch { return null; } })();
      const result = await collectFinnhubOfficial({ credentialPath: options.finnhubCredentialPath ?? resolve(dataRoot, "finnhub-credentials.json"), approvedCapabilities: radar?.snapshot });
      if (!radar) result.source = { ...result.source, status: result.source.status === "LIVE" ? "DEGRADED" : result.source.status, error: [result.source.error, "已批准个股候选读取失败；本轮未采集公司新闻"].filter(Boolean).join("；") };
      return result;
    })();
    finnhubCache = { expiresAt: Date.now() + 300_000, value };
    void value.then((result) => { if (result.source.status === "NOT_CONFIGURED" && finnhubCache?.value === value) finnhubCache.expiresAt = Date.now() + 60_000; }).catch(() => { if (finnhubCache?.value === value) finnhubCache = null; });
    return value;
  };

  const sessionFor = (request: IncomingMessage) => {
    const token = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token) return null;
    const key = sessionHash(token);
    const expiresAt = sessions.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
      if (expiresAt) {
        sessions.delete(key);
        saveOwnerSessions(sessionPath, credentials, sessions);
      }
      return null;
    }
    return token;
  };

  try {
    if (runtimeRole === "WEB" && options.snapshotWorker !== false) {
      snapshotWorker = new Worker(new URL("./owner-snapshot-worker.ts", import.meta.url), { workerData: { databasePath: options.databasePath ?? resolve(dataRoot, "trading-os-web.sqlite"), sourceSelection: process.env.TRADING_OS_SOURCE_SETTINGS ? activeSourceSelection(resolve(projectRoot, "..")) : null } });
      await new Promise<void>((resolveReady, rejectReady) => {
        const unavailable = (error: Error) => { prebuiltSnapshots = null; clearTimeout(timeout); rejectReady(error); };
        const timeout = setTimeout(() => unavailable(new Error("owner snapshot worker startup timed out")), 20_000);
        snapshotWorker!.on("error", unavailable);
        snapshotWorker!.once("exit", (code) => { if (!closed) unavailable(new Error(`owner snapshot worker exited (${code})`)); });
        snapshotWorker!.on("message", (message: { type?: string; generatedAt?: string; values?: Record<string, string>; message?: string }) => {
          if (closed) return;
          if (message.type === "error") return unavailable(new Error(message.message ?? "owner snapshot worker failed"));
          if (message.type !== "snapshots" || !message.generatedAt || !message.values) return;
          prebuiltSnapshots = { generatedAt: message.generatedAt, values: message.values };
          clearTimeout(timeout); resolveReady();
        });
      });
    }
    internal = await startProdServer({ host: "127.0.0.1", port: 0, outDir: options.outDir ?? resolve(projectRoot, "dist"), silent: true });
    server = createServer((request, response) => {
      void (async () => {
        if (!isPrivateClient(request.socket.remoteAddress)) return sendJson(response, 403, { error: "只允许家庭私有网络访问" });
        const url = new URL(request.url ?? "/", "http://local");
        const pathname = url.pathname;
        const correlationId = randomUUID(), startedAt = new Date(), startedMs = Date.now();
        const trace = { operation: pathname, cache: "N/A", external: false, caller: String(request.headers["x-trading-os-caller"] ?? (request.headers.accept?.includes("text/html") ? "browser_navigation" : "unknown")), route: String(request.headers["x-trading-os-route"] ?? pathname), blocks_first_frame: request.headers["x-trading-os-blocking"] === "1" };
        const proxyCodexManager = async (target: URL, method: string | undefined, body?: unknown) => {
          trace.operation = "tier0_codex_manager_proxy";
          try {
            const upstream = await fetch(new URL(`${target.pathname}${target.search}`, tier0Origin), { method, headers: { authorization: `Bearer ${gatewayKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
            return sendJson(response, upstream.status, await upstream.json());
          } catch {
            return sendJson(response, 503, { error: "Codex Manager核心暂不可达；确定性系统继续运行" });
          }
        };
        let performanceLogged = false;
        response.setHeader("x-request-id", correlationId);
        const finishPerformance = (aborted: boolean) => {
          if (performanceLogged) return;
          performanceLogged = true;
          const endedAt = new Date();
          logPerformance({ correlation_id: correlationId, endpoint: pathname, operation: trace.operation, route: trace.route, caller: trace.caller, started_at: startedAt.toISOString(), ended_at: endedAt.toISOString(), duration_ms: Date.now() - startedMs, cache: trace.cache, external: trace.external, blocks_first_frame: trace.blocks_first_frame, outcome: aborted ? "ABORTED" : response.statusCode === 408 || response.statusCode === 504 ? "TIMED_OUT" : response.statusCode >= 500 ? "FAILED" : "SUCCEEDED", status_code: response.statusCode, response_bytes: Number(response.getHeader("content-length") ?? 0) || null });
        };
        response.once("finish", () => finishPerformance(false));
        response.once("close", () => { if (!response.writableFinished) finishPerformance(true); });
        const token = sessionFor(request);
        const trustedHome = trustedHomeAccess.enabled && isTrustedHomeClient(request.socket.remoteAddress, trustedHomeAccess.trusted_cidrs);

        if (pathname === "/api/output-gateway" || pathname === "/api/run-ledger" || pathname === "/api/health" || pathname === "/api/runtime-context" || pathname === "/api/owner-action-probe") {
          if (!isLoopbackClient(request.socket.remoteAddress)) return sendJson(response, 403, { error: "本地写入接口只允许此工作区本机调用" });
          if (!gatewayAuthorized(request, gatewayKey)) return sendJson(response, 401, { error: "本地写入密钥无效" });
          if (pathname === "/api/health") {
            if (request.method !== "GET") return sendJson(response, 405, { error: "健康接口只支持 GET" });
            trace.operation = "sqlite_health";
            snapshots.ping();
            return sendJson(response, 200, { ok: true, service: "Trading OS", checked_at: new Date().toISOString() });
          }
          if (pathname === "/api/runtime-context") {
            if (request.method !== "GET") return sendJson(response, 405, { error: "运行上下文只支持 GET" });
            return sendJson(response, 200, await snapshots.getRuntimeContextAsync());
          }
          if (pathname === "/api/owner-action-probe") {
            if (request.method !== "POST") return sendJson(response, 405, { error: "Owner动作探针只支持POST" });
            return sendJson(response, 200, { ok: true, action_status: "SUCCEEDED", command_id: `owner-probe:${correlationId}`, dry_run: true, persisted: false, broker_write_tools: 0, broker_write_calls: 0 });
          }
          if (request.method === "POST") invalidateSnapshot();
          return pathname === "/api/output-gateway" ? handleOutputGatewayApi(request, response, snapshots) : handleRunLedgerApi(request, response, snapshots);
        }

        if (pathname === "/login" && request.method === "GET") {
          const returnTo = safeReturnPath(url.searchParams.get("return_to"));
          return token || trustedHome ? redirect(response, returnTo) : sendHtml(response, 200, loginPage("", returnTo));
        }
        if (pathname === "/login" && request.method === "POST") {
          const address = request.socket.remoteAddress ?? "unknown";
          const now = Date.now();
          const current = failures.get(address);
          if (current && current.resetAt > now && current.count >= MAX_LOGIN_FAILURES) return sendHtml(response, 429, loginPage("登录尝试过多，请 10 分钟后重试"));
          const form = await readForm(request);
          const returnTo = safeReturnPath(form.get("return_to"));
          if (form.get("username") !== OWNER || !passwordMatches(form.get("password") ?? "", credentials)) {
            failures.set(address, current && current.resetAt > now ? { ...current, count: current.count + 1 } : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
            return sendHtml(response, 401, loginPage("用户名或密码错误", returnTo));
          }
          failures.delete(address);
          const newToken = randomBytes(32).toString("base64url");
          sessions.set(sessionHash(newToken), now + ttl);
          saveOwnerSessions(sessionPath, credentials, sessions);
          return redirect(response, returnTo, `${COOKIE}=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor(ttl / 1000))}`);
        }
        if (pathname === "/logout" && request.method === "POST") {
          if (!token || !sameOrigin(request)) return sendJson(response, 403, { error: "退出请求无效" });
          sessions.delete(sessionHash(token));
          saveOwnerSessions(sessionPath, credentials, sessions);
          return redirect(response, "/login", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        }
        const internalManagerRequest = pathname.startsWith("/api/codex-manager") && isLoopbackClient(request.socket.remoteAddress) && gatewayAuthorized(request, gatewayKey);
        if (!token && !trustedHome && !internalManagerRequest) {
          if (pathname === "/api/snapshot" || pathname === "/api/market-chart" || pathname === "/api/codex-manager" || pathname.startsWith("/api/complaints")) return sendJson(response, 401, { error: "Owner 登录已过期" });
          if (request.method === "GET" && request.headers.accept?.includes("text/html")) return redirect(response, `/login?return_to=${encodeURIComponent(`${pathname}${url.search}`)}`);
          return sendJson(response, 401, { error: "Owner 登录已过期" });
        }
        if (pathname === "/api/company-evidence") {
          if (request.method !== "GET") return sendJson(response, 405, { error: "公司资料只支持读取" });
          const symbol = url.searchParams.get("symbol") ?? "";
          if (!APPROVED_STOCKS.includes(symbol)) return sendJson(response, 400, { error: "标的不在现有股票范围内" });
          const at = new Date().toISOString();
          trace.operation = "company_evidence";
          let intelligence: SnapshotState["marketIntelligence"];
          if (runtimeRole === "WEB") {
            const company = prebuiltSnapshots?.values.company;
            if (!company || !isOwnerSnapshotFresh(prebuiltSnapshots?.generatedAt)) return sendJson(response, 503, { error: "公司资料暂不可用，请稍后重试" });
            intelligence = (JSON.parse(company) as SnapshotState).marketIntelligence;
            trace.cache = "PREBUILT";
            response.setHeader("x-owner-snapshot-at", prebuiltSnapshots!.generatedAt);
          } else {
            intelligence = (await activeSnapshot("company")).value.marketIntelligence;
          }
          const report = projectCompanyEvidence(symbol, intelligence, at);
          const observation = readEventDisclosureObservation(dataRoot, at, null);
          const events = observation.cards.filter((item) => item.symbol === symbol).slice(0, 2).map((card) => ({ id: card.evidence_ref, title: card.title, url: "/research/event-disclosure", time: card.timeline.find((item) => item.role === "EVENT")?.value ?? null }));
          return sendJson(response, 200, { report, events });
        }
        if (pathname === "/research/event-disclosure") {
          if (request.method !== "GET") return sendJson(response, 405, { error: "事件观察报告只支持GET" });
          try {
            const report = readFileSync(resolve(dataRoot, "research/event-disclosure-phase1-20260927/REPORT-dc9c6ce78f09da3cc1c8c716e3ee80678e8592ddaedfe5340466aaf849bfe3fc.html"), "utf8");
            const radar = (() => { try { return snapshots.getMarketRadar(); } catch { return null; } })();
            return sendHtml(response, 200, renderEventDisclosureObservation(report, readEventDisclosureObservation(dataRoot, new Date().toISOString(), radar)));
          } catch (error) {
            return sendHtml(response, (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 503, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>事件观察报告暂不可用</title><main><h1>事件观察报告暂不可用</h1><a href="/settlements">返回研究与复盘</a></main></html>');
          }
        }
        if (pathname.startsWith("/api/external-expert-evidence/")) {
          if (request.method !== "GET") return sendJson(response, 405, { error: "原始证据只支持GET" });
          const evidenceId = decodeURIComponent(pathname.slice("/api/external-expert-evidence/".length));
          if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) return sendJson(response, 400, { error: "证据ID无效" });
          const evidence = snapshots.getExternalExpertEvidence(evidenceId);
          if (!evidence) return sendJson(response, 404, { error: "原始证据不存在" });
          response.writeHead(200, { "content-type": evidence.mime, "content-length": String(evidence.bytes.length), "cache-control": "private, no-store", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" });
          return response.end(evidence.bytes);
        }
        if (pathname === "/api/codex-manager") {
          if (request.method === "GET") {
            if (!codexManager && runtimeRole === "WEB") return proxyCodexManager(url, request.method);
            if (!codexManager) return sendJson(response, 503, { error: "Codex Production Manager Shadow 未在该实例启用" });
            const commandId = url.searchParams.get("command_id");
            if (!commandId) return sendJson(response, 200, codexManager.state);
            const command = codexManager.state.recent_runs.find((item) => item.manager_run_id === commandId);
            return command ? sendJson(response, 200, codexManagerCommandReceipt(command)) : sendJson(response, 404, { error: "经理任务不存在" });
          }
          if (request.method !== "POST") return sendJson(response, 405, { error: "Codex Manager 只支持 GET / POST" });
          const internalAuthorized = isLoopbackClient(request.socket.remoteAddress) && gatewayAuthorized(request, gatewayKey);
          if (!internalAuthorized && !sameOrigin(request)) return sendJson(response, 403, { error: "Codex Manager 请求来源无效" });
          const body = await readJson(request), requestedTrigger = typeof body.trigger === "string" ? body.trigger : "OWNER_MANUAL";
          if (!CODEX_MANAGER_TRIGGERS.includes(requestedTrigger as CodexManagerTrigger)) return sendJson(response, 400, { error: "Codex Manager 触发原因无效" });
          if (!internalAuthorized && requestedTrigger !== "OWNER_MANUAL") return sendJson(response, 403, { error: "Owner页面只允许手动经理检查" });
          if (!codexManager && runtimeRole === "WEB") return proxyCodexManager(url, request.method, body);
          if (!codexManager) return sendJson(response, 503, { error: "Codex Production Manager Shadow 未在该实例启用" });
          const context = typeof body.context === "string" && body.context.trim() ? body.context.trim().slice(0, 8_000) : null;
          const command = codexManager.queue(requestedTrigger as CodexManagerTrigger, context, body.resume !== false);
          invalidateSnapshot();
          return sendJson(response, 202, { accepted: true, command_id: command.manager_run_id, status: codexManagerCommandReceipt(command).status, requested_at: command.requested_at, trigger: requestedTrigger, mode: "NON_TRADING_PRODUCTION_MANAGER_ACTIVE" });
        }
        if (pathname === "/api/codex-manager/action") {
          if (request.method !== "POST") return sendJson(response, 405, { error: "受控经理动作只支持POST" });
          if (!isLoopbackClient(request.socket.remoteAddress) || !gatewayAuthorized(request, gatewayKey)) return sendJson(response, 403, { error: "受控经理动作仅允许本机Gateway" });
          const body = await readJson(request), kind = body.kind;
          if (!codexManager && runtimeRole === "WEB") return proxyCodexManager(url, request.method, body);
          if (!codexManager) return sendJson(response, 503, { error: "Codex Production Manager未启用" });
          if (kind === "MANAGER_ACTION") return sendJson(response, 200, await codexManager.executeAction(body.action as { manager_run_id: string; action: CodexManagerActionKind; target: string; reason: string; evidence_refs: string[]; idempotency_key?: string }));
          if (kind === "RELEASE_AUDIT") return sendJson(response, 200, codexManager.recordPrivilegedOperation(body.operation as CodexManagerOperation));
          if (kind === "RECOVERY_ATTRIBUTION") return sendJson(response, 200, codexManager.recordRecoveryAttribution(body.attribution as CodexRecoveryAttribution));
          return sendJson(response, 400, { error: "受控经理动作类型无效" });
        }
        if (pathname === "/api/market-chart") {
          trace.operation = "selected_market_chart"; trace.external = true;
          if (request.method !== "GET") return sendJson(response, 405, { error: "图表接口只支持 GET" });
          const symbol = url.searchParams.get("symbol");
          const interval = url.searchParams.get("interval");
          const range = url.searchParams.get("range") ?? "24h";
          if (symbol !== "SPY" && symbol !== "QQQ") return sendJson(response, 400, { error: "symbol 只支持 SPY / QQQ" });
          if (interval !== "1m" && interval !== "5m" && interval !== "15m") return sendJson(response, 400, { error: "interval 只支持 1m / 5m / 15m" });
          if (range !== "1d" && range !== "24h" && range !== "rth" && range !== "gth" && range !== "5d") return sendJson(response, 400, { error: "range 只支持 1d / 24h / rth / gth / 5d" });
          const choice = activeSourceSelection(resolve(projectRoot, ".."));
          const cachedChart = chartCache.get(`${choice?.selection_id ?? "none"}:${symbol}:${interval}:${range}`);
          trace.cache = cachedChart && cachedChart.expiresAt > Date.now() ? "HIT" : "MISS";
          try { return sendJson(response, 200, await marketChart(symbol, interval, range)); }
          catch {
            const observedAt = new Date().toISOString();
            return sendJson(response, 200, { source: choice?.selected.market.provider ?? "NOT_CONFIGURED", source_selection_id: choice?.selection_id ?? null, environment: choice?.selected.market.environment ?? null, symbol, interval, range, session_bounds: "NOT_OBSERVED", data_grade: "READ_FAILED", session_dates: [], status: "DATA_BLOCKED", as_of: null, freshness_seconds: null, quote_as_of: null, quote_freshness_seconds: null, bar_as_of: null, bar_freshness_seconds: null, gap_status: "SOURCE_GAP", market_session: robinhoodMarketSession(observedAt), current_price: null, bars: [], error: "SOURCE_GAP：所选来源尚未接通、未授权或不提供此周期；未切换其他来源或使用样本" });
          }
        }
        if (pathname.startsWith("/api/spxw-proxy")) {
          trace.operation = pathname === "/api/spxw-proxy/chains" ? "robinhood_spxw_chains" : pathname === "/api/spxw-proxy/contracts" || pathname === "/api/spxw-proxy/contract-reads" ? "robinhood_spxw_contract_quote" : pathname.includes("/history") ? "robinhood_spxw_history" : "spxw_local_observation";
          trace.external = pathname === "/api/spxw-proxy/chains" || pathname === "/api/spxw-proxy/contracts" || pathname === "/api/spxw-proxy/contract-reads" || pathname.includes("/history") || request.method === "POST" && pathname === "/api/spxw-proxy/watches";
          trace.cache = trace.external ? "MISS" : "N/A";
          if (request.method !== "GET" && !sameOrigin(request)) return sendJson(response, 403, { error: "SPXW 观察请求来源无效" });
          const actionMatch = pathname.match(/^\/api\/spxw-proxy\/actions\/(spx-contract-read-[0-9a-f-]{36})$/i);
          if (actionMatch && request.method === "GET") {
            const action = snapshots.getOwnerAction(actionMatch[1]);
            return action ? sendJson(response, 200, action) : sendJson(response, 404, { error: "Owner动作不存在" });
          }
          if (pathname === "/api/spxw-proxy/contract-reads" && request.method === "POST") {
            const body = await readJson(request), chain_symbol = body.chain_symbol, expiration_date = body.expiration_date, option_type = body.option_type, strike = Number(body.strike), idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
            const missing = [...(chain_symbol === "SPX" || chain_symbol === "SPXW" ? [] : ["SPX/SPXW链"]), ...(/^\d{4}-\d{2}-\d{2}$/.test(typeof expiration_date === "string" ? expiration_date : "") ? [] : ["到期日"]), ...(Number.isFinite(strike) && strike > 0 ? [] : ["Strike"]), ...(option_type === "call" || option_type === "put" ? [] : ["Put/Call"])];
            if (missing.length) return sendJson(response, 400, { action_status: "FAILED", error: `缺少或无效字段：${missing.join("、")}`, status: "INVALID_INPUT", missing_fields: missing });
            try {
              const action = snapshots.queueOwnerAction({ action_kind: "SPX_CONTRACT_READ", idempotency_key: idempotencyKey, request: { chain_symbol, expiration_date, strike, option_type } });
              startSpxContractRead(action.action_id);
              return sendJson(response, action.status === "QUEUED" || action.status === "RUNNING" ? 202 : 200, action);
            } catch (error) { return sendJson(response, 409, { action_status: "FAILED", error: error instanceof Error ? error.message : "Owner动作身份冲突", status: "INVALID_INPUT" }); }
          }
          if (pathname === "/api/spxw-proxy/chains" && request.method === "GET") {
            const requestId = url.searchParams.get("request_id"), actionId = `spx-chain-read-${requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : randomUUID()}`;
            try { return sendJson(response, 200, { action_id: actionId, action_status: "SUCCEEDED", chains: await spxOptions.chains(), spx_spot_status: "DATA_BLOCKED" }); }
            catch { return sendJson(response, 502, { action_id: actionId, action_status: "FAILED", error: "Robinhood 官方 SPX/SPXW 只读链不可用", status: "SOURCE_UNAVAILABLE" }); }
          }
          if (pathname === "/api/spxw-proxy/contracts" && request.method === "GET") {
            const requestId = url.searchParams.get("request_id"), actionId = `spx-contract-read-${requestId && /^[0-9a-f-]{36}$/i.test(requestId) ? requestId : randomUUID()}`;
            const chain_symbol = url.searchParams.get("chain_symbol"), expiration_date = url.searchParams.get("expiration_date"), option_type = url.searchParams.get("option_type"), strike = Number(url.searchParams.get("strike"));
            const missing = [...(chain_symbol === "SPX" || chain_symbol === "SPXW" ? [] : ["SPX/SPXW链"]), ...(/^\d{4}-\d{2}-\d{2}$/.test(expiration_date ?? "") ? [] : ["到期日"]), ...(Number.isFinite(strike) && strike > 0 ? [] : ["Strike"]), ...(option_type === "call" || option_type === "put" ? [] : ["Put/Call"])];
            if (missing.length) return sendJson(response, 400, { action_id: actionId, action_status: "FAILED", error: `缺少或无效字段：${missing.join("、")}`, status: "INVALID_INPUT", missing_fields: missing });
            try {
              const result = await readSpxContract({ chain_symbol: chain_symbol as "SPX" | "SPXW", expiration_date: expiration_date!, strike, option_type: option_type as "call" | "put" });
              return sendJson(response, result.action_status === "SUCCEEDED" ? 200 : 404, { action_id: actionId, ...result });
            }
            catch { return sendJson(response, 502, { action_id: actionId, action_status: "FAILED", error: "SOURCE_UNAVAILABLE · Robinhood 官方合约或报价读取失败", status: "SOURCE_UNAVAILABLE" }); }
          }
          if (pathname === "/api/spxw-proxy/history" && request.method === "GET") {
            const contractId = url.searchParams.get("contract_id") ?? "", start = url.searchParams.get("start") ?? "", end = url.searchParams.get("end") ?? "";
            if (!/^[0-9a-f-]{36}$/i.test(contractId) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 31 * 86_400_000) return sendJson(response, 400, { error: "期权历史范围无效（最多31天）" });
            try { const contracts = await spxOptions.contractsById([contractId]); if (contracts.length !== 1 || !spxOptions.history) throw new Error("blocked"); return sendJson(response, 200, { contract: contracts[0], history: await spxOptions.history([contractId], start, end), source: "ROBINHOOD_OFFICIAL_READONLY", replay_eligible: false }); }
            catch { return sendJson(response, 502, { error: "Robinhood 官方期权历史不可用", status: "DATA_BLOCKED" }); }
          }
          if (pathname === "/api/spxw-proxy/watches" && request.method === "POST") {
            invalidateSnapshot();
            const body = await readJson(request), contractId = typeof body.contract_id === "string" ? body.contract_id : "", note = typeof body.owner_note === "string" ? body.owner_note : null, idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null, validUntil = typeof body.valid_until === "string" ? body.valid_until : null;
            if (body.forecast_run_id !== undefined && body.forecast_run_id !== null && (typeof body.forecast_run_id !== "string" || body.forecast_run_id.length > 200)) return sendJson(response, 400, { error: "关联预测身份无效" });
            const forecastRunId = typeof body.forecast_run_id === "string" ? body.forecast_run_id : null;
            if (!/^[0-9a-f-]{36}$/i.test(contractId)) return sendJson(response, 400, { error: "合约唯一标识无效" });
            if (!validUntil || !Number.isFinite(Date.parse(validUntil))) return sendJson(response, 400, { action_status: "FAILED", error: "请填写有效期" });
            try {
              const contracts = await spxOptions.contractsById([contractId]);
              if (contracts.length !== 1 || contracts[0].contract_id !== contractId) return sendJson(response, 409, { error: "无法稳定确认该 SPX/SPXW 合约身份", status: "DATA_BLOCKED" });
              const observedAt = new Date().toISOString(); let value: { contract: SpxOptionContract; quote: SpxOptionQuote };
              try { value = (await spxOptions.quotes(contracts, observedAt))[0] ?? { contract: contracts[0], quote: unavailableSpxQuote(observedAt) }; }
              catch { value = { contract: contracts[0], quote: unavailableSpxQuote(observedAt, "SOURCE_UNAVAILABLE") }; }
              const details = classifySpxContractQuote(value.quote, observedAt); value = { contract: value.contract, quote: { ...value.quote, contract_quote_status: value.quote.contract_quote_status ?? details.status, source_session: value.quote.source_session ?? details.source_session, observed_session: value.quote.observed_session ?? details.observed_session } };
              const result = snapshots.createSpxOptionWatch(value.contract, value.quote, note, observedAt, forecastRunId, idempotencyKey, validUntil);
              return sendJson(response, result.duplicate ? 200 : 201, result);
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              if (/Owner Profile|预测身份/.test(message)) return sendJson(response, 409, { error: message, status: "DATA_BLOCKED" });
              return sendJson(response, 502, { error: "Robinhood 官方合约复核失败", status: "DATA_BLOCKED" });
            }
          }
          const endMatch = pathname.match(/^\/api\/spxw-proxy\/watches\/([^/]+)\/end$/);
          if (endMatch && request.method === "POST") {
            invalidateSnapshot();
            try { return sendJson(response, 200, snapshots.endSpxOptionWatch(decodeURIComponent(endMatch[1]))); }
            catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "结束观察失败" }); }
          }
          if (pathname === "/api/spxw-proxy/owner-levels" && request.method === "POST") {
            invalidateSnapshot();
            try {
              const body = await readJson(request), kind = body.kind, low = Number(body.low), high = Number(body.high ?? body.low), validUntil = typeof body.valid_until === "string" && body.valid_until ? body.valid_until : null, note = typeof body.owner_note === "string" ? body.owner_note : null, idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
              if (kind !== "SUPPORT" && kind !== "RESISTANCE" && kind !== "LEVEL") return sendJson(response, 400, { error: "SPX 人工区域类型无效" });
              if (!Number.isFinite(low) || low <= 0) return sendJson(response, 400, { action_status: "FAILED", error: "请填写有效的SPX低点" });
              if (!Number.isFinite(high) || high < low) return sendJson(response, 400, { action_status: "FAILED", error: "SPX高点必须有效且不得低于低点" });
              if (!validUntil || !Number.isFinite(Date.parse(validUntil))) return sendJson(response, 400, { action_status: "FAILED", error: "请填写有效期" });
              const result = snapshots.recordOwnerObservedSpxLevel({ kind, low, high, valid_until: validUntil, owner_note: note, idempotency_key: idempotencyKey });
              return sendJson(response, result.duplicate ? 200 : 201, result);
            } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : "Owner SPX 观察输入无效" }); }
          }
          return sendJson(response, 405, { error: "SPXW 观察接口方法不支持" });
        }
        if (pathname === "/api/owner-position-plans") {
          trace.operation = "sqlite_owner_position_plans";
          try {
            if (request.method === "GET") return sendJson(response, 200, snapshots.getOwnerPositionPlans(url.searchParams.get("request_id") ?? undefined));
            if (request.method !== "POST") return sendJson(response, 405, { error: "持仓补录只支持GET/POST" });
            if (!sameOrigin(request)) return sendJson(response, 403, { error: "Owner持仓补录请求来源无效" });
            let input: unknown;
            try { input = await readJson(request); } catch { return sendJson(response, 400, { error: "Owner持仓补录请求格式或大小无效" }); }
            const result = snapshots.recordOwnerPositionPlan(input);
            return sendJson(response, result.duplicate ? 200 : 201, result);
          } catch (error) {
            if (error instanceof OwnerPositionPlanError) return sendJson(response, error.status, { error: error.message });
            throw error;
          }
        }
        if (pathname === "/api/snapshot") {
          if (request.method === "POST" && !sameOrigin(request)) return sendJson(response, 403, { error: "Snapshot 请求来源无效" });
          if (request.method === "GET") {
            trace.operation = "sqlite_owner_snapshot";
            const selectedView = url.searchParams.get("view");
            const view = selectedView && ["home", "forecast", "options", "company", "health", "settlements", "issues"].includes(selectedView) ? selectedView as OwnerSnapshotView : null;
            if (runtimeRole === "WEB") {
              const serialized = prebuiltSnapshots?.values[view ?? "full"];
              if (!serialized || !isOwnerSnapshotFresh(prebuiltSnapshots?.generatedAt)) return sendJson(response, 503, { error: "Owner快照未就绪或已过期，等待刷新；核心运行不受影响" });
              trace.cache = "PREBUILT";
              response.setHeader("x-owner-snapshot-at", prebuiltSnapshots!.generatedAt);
              return sendSerializedJson(response, 200, serialized);
            }
            const current = await activeSnapshot(view); trace.cache = current.cache;
            response.setHeader("x-owner-snapshot-at", current.generatedAt);
            return sendJson(response, 200, view ? ownerSnapshotView(current.value, view) : current.value);
          }
          invalidateSnapshot();
          return handleSnapshotApi(request, response, snapshots);
        }
        if (pathname.startsWith("/api/complaints")) {
          if ((request.method === "POST" || request.method === "PATCH") && !sameOrigin(request)) return sendJson(response, 403, { error: "投诉请求来源无效" });
          if (request.method !== "GET") invalidateSnapshot();
          return handleComplaintApi(request, response, snapshots, siteVersion);
        }

        const upstream = proxyRequest({
          hostname: "127.0.0.1",
          port: internal!.port,
          method: request.method,
          path: request.url,
          headers: request.headers,
        }, (upstreamResponse) => {
          const headers = { ...upstreamResponse.headers, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" };
          if (!pathname.startsWith("/_next/static/")) headers["cache-control"] = "no-store";
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
        });
        upstream.on("error", (error) => {
          if (!response.headersSent) sendJson(response, 502, { error: `正式构建服务不可用：${error.message}` });
          else response.destroy(error);
        });
        request.pipe(upstream);
      })().catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : "本地服务错误" });
        else response.destroy(error instanceof Error ? error : undefined);
      });
    });
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? OWNER_PORT;
    if (host !== "127.0.0.1" || port >= 4070 && port <= 4076) throw new Error("PUBLIC_BINDING_FORBIDDEN：仅允许独立本机端口");
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(port, host, () => {
        server!.off("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const productionRuntime = publicAutomationEnabled() && (runtimeRole === "TIER0" || runtimeRole === "COMBINED" && actualPort === OWNER_PORT);
    performanceEvidenceEnabled = runtimeRole !== "TIER0" && actualPort === OWNER_PORT;
    if (productionRuntime && options.codexManager !== false) {
      codexManager = createCodexProductionManager({
        store: snapshots, dataRoot, projectRoot, siteVersion,
        runtimeIdentity: { deployedCommit: process.env.TRADING_OS_DEPLOYED_COMMIT ?? "UNRESOLVED", runtimeSha256: process.env.TRADING_OS_RUNTIME_SHA256 ?? "UNRESOLVED" },
        invoke: options.codexManager?.invoke, now: options.codexManager?.now,
        runReadonlyProbe: async (target) => {
          if (target === "FINNHUB") {
            const result = await finnhubNews();
            return { source: result.source.source, status: result.source.status, authorization: result.source.authorization, checked_at: result.source.checked_at, as_of: result.source.as_of, capability_count: Object.values(result.source.capabilities).filter(Boolean).length };
          }
          const result = await collectSelectedMarket(new Date().toISOString(), undefined, resolve(projectRoot, ".."));
          return { source: activeSourceSelection(resolve(projectRoot, ".."))?.selected.market.provider ?? "NOT_CONFIGURED", snapshot_id: result.snapshot_id, generated_at: result.generated_at, status: result.status, broker_access: "READ_ONLY", broker_write_calls: 0 };
        },
        requestDepartmentRecheck: async (target, reason) => {
          const requestedAt = new Date().toISOString(), requestId = `department-recheck:${createHash("sha256").update(`${target}:${reason}:${requestedAt}`).digest("hex").slice(0, 24)}`;
          snapshots.recordCodexManagerEvent({ event_id: `${requestId}:requested`, manager_run_id: requestId, event_type: "DEPARTMENT_RECHECK_REQUESTED", recorded_at: requestedAt, payload: { contract_version: "CODEX_PRODUCTION_MANAGER_ACTIVE_V1", request: { request_id: requestId, target, reason, requested_at: requestedAt, eligibility: "NEXT_NATURAL_SLOT_ONLY" } } });
          return { target, status: "QUEUED_FOR_NEXT_NATURAL_SLOT", request_id: requestId, requested_at: requestedAt };
        },
      });
    }
    if (options.shadowRuntime !== false && (options.shadowRuntime || productionRuntime)) {
      const tsCoreOwnerId = `runtime:${randomUUID()}`;
      shadowRuntime = createLiveShadowRuntime({
        origin: `http://127.0.0.1:${actualPort}`,
        gatewayKey,
        priorTsForecasts: (before) => snapshots.getPriorTsForecasts(before),
        runtimeContext: () => snapshots.getRuntimeContextAsync(),
        runStockPlans: productionRuntime && activeSourceSelection(resolve(projectRoot, ".."))?.selected.market.provider === "ROBINHOOD" ? createStockManualRuntime({ projectRoot, dataRoot, v2Root: options.shadowRuntime?.v2Root, activatedAt: runtimeStartedAt, readCurrent: () => snapshots.getActiveAsync(), publish: (raw, receivedAt) => { snapshots.importOutputRaw(raw, receivedAt, true, true); invalidateSnapshot(); } }) : undefined,
        importOutputRaw: (raw, receivedAt) => { snapshots.importOutputRaw(raw, receivedAt, true); invalidateSnapshot(); },
        importRunEventRaw: (raw, receivedAt) => { snapshots.importRunEventRaw(raw, receivedAt, true); invalidateSnapshot(); },
        ...options.shadowRuntime,
        tsCoreOwnership: {
          ownerId: tsCoreOwnerId,
          get: (slotId) => snapshots.getTsCoreSlotOwnership(slotId),
          claim: (slotId, runId, ownerId, at) => snapshots.claimTsCoreSlot(slotId, runId, ownerId, at),
          renew: (slotId, ownerId, at) => snapshots.renewTsCoreSlot(slotId, ownerId, at),
          complete: (slotId, ownerId, outcome, forecastId, deliveryRecordId, at) => snapshots.completeTsCoreSlot(slotId, ownerId, outcome, forecastId, deliveryRecordId, at),
        },
        dataRoot: options.shadowRuntime?.dataRoot ?? (productionRuntime ? resolve(dataRoot, "live-shadow") : undefined),
        v2Root: options.shadowRuntime?.v2Root ?? (productionRuntime ? resolve(projectRoot, "..", "v2-reference") : undefined),
      });
      if (productionRuntime) {
        const readyAt = new Date();
        const downtimeKind = process.env.TRADING_OS_DOWNTIME_KIND;
        const downtimeStartedAt = process.env.TRADING_OS_DOWNTIME_STARTED_AT;
        const windowsBootAt = process.env.TRADING_OS_WINDOWS_BOOT_AT;
        if ((downtimeKind === "PLANNED_OWNER_SHUTDOWN" || downtimeKind === "UNPLANNED_INTERRUPTION") && downtimeStartedAt && windowsBootAt && Date.parse(downtimeStartedAt) < Date.parse(windowsBootAt)) {
          snapshots.recordOperationalAnnotation({ kind: downtimeKind, started_at: downtimeStartedAt, ended_at: windowsBootAt, recorded_at: readyAt.toISOString(), actor: downtimeKind === "PLANNED_OWNER_SHUTDOWN" ? "OWNER" : "SYSTEM", note: `${downtimeKind === "PLANNED_OWNER_SHUTDOWN" ? "Owner预先登记的计划停机" : "未预先登记的中断"}；使用停机前最后监督器心跳至本次Windows启动时间，事后登记时间单独保留，不计自然运行、交付或绩效。` });
          if (downtimeKind === "PLANNED_OWNER_SHUTDOWN") {
            const marker = resolve(dataRoot, "maintenance", "planned-shutdown-pending.json");
            try { if (existsSync(marker)) renameSync(marker, resolve(dataRoot, "maintenance", `planned-shutdown-${windowsBootAt.replace(/[^0-9]/g, "")}.consumed.json`)); } catch { /* Annotation is authoritative; marker cleanup retries on a later service start. */ }
          }
        }
        if (process.env.TRADING_OS_START_REASON === "WINDOWS_STARTUP" && windowsBootAt) snapshots.recordOperationalAnnotation({ kind: "STARTUP_RECOVERY", started_at: windowsBootAt, ended_at: new Date(Date.parse(windowsBootAt) + 1).toISOString(), recorded_at: readyAt.toISOString(), actor: "SYSTEM", note: "Windows冷启动恢复边界；实际各阶段耗时由STARTUP_RECOVERY_V1经理账本追加留证，不计自然运行、送达或部门履职统计。" });
        const paperPlanRuntime = createPaperPlanRuntime({ projectRoot, dataRoot, v2Root: options.shadowRuntime?.v2Root, store: snapshots, readCurrent: () => snapshots.getActiveAsync() });
        const spxPaperRuntime = createSpxPaperRuntime({ projectRoot, dataRoot, store: snapshots, readCurrent: () => snapshots.getActiveAsync() });
        timelineScheduler = createTimelineScheduler({ store: snapshots, runShadow: (at, reason) => shadowRuntime!.runOnce("LIVE", at, reason), runTsCore: (at, reason) => shadowRuntime!.runTsCore("LIVE", at, reason), reserveTsCore: (at) => shadowRuntime!.reserveTsCore(at), completeReservedTsCore: (at, outcome) => shadowRuntime!.completeReservedTsCore(at, outcome), runtimeStartedAt,
          monitorPositions: async () => {
            const rawA2 = snapshots.getLatestOutputRaw("A2_SHADOW_RESULT", "LIVE");
            const a2 = rawA2 ? JSON.parse(rawA2) as { record_id: string; payload: ShadowComponentResult } : null;
            const rawA1 = a2 && /^live-shadow:\d{8}T\d{6}Z:A2$/.test(a2.record_id) ? snapshots.getOutputRaw(a2.record_id.replace(/:A2$/, ":A1")) : null;
            const a1 = rawA1 ? (JSON.parse(rawA1) as { payload: ShadowComponentResult }).payload : null;
            const sameSnapshot = a1?.source_mode === "LIVE" && a2?.payload.source_mode === "LIVE" && a1.market_snapshot_id === a2.payload.market_snapshot_id && a1.market_snapshot_hash === a2.payload.market_snapshot_hash;
            const monitor = sameSnapshot ? (a2?.payload.v2_result as { position_monitor?: PositionMonitorV1 } | undefined)?.position_monitor ?? null : null;
            const account = await withRobinhoodMcp({ projectRoot, timeoutMs: 35_000, allowlist: ["get_accounts", "get_option_positions", "get_option_instruments", "get_option_quotes"] }, (session) => collectRobinhoodAccount(session, undefined, "POSITIONS"));
            return assessPositionRisks(account, monitor, new Date().toISOString(), a1?.market_sources?.account ?? null);
          },
          monitorExternalExperts: async (at) => {
            const results = await Promise.allSettled([externalExpertMonitor.runOnce(at), paperPlanRuntime.runOnce(at)]);
            if (results.some((result) => result.status === "fulfilled" && result.value.recorded)) invalidateSnapshot();
            // Auxiliary research starts after the existing checks; it never delays TS or the position monitor.
            if ((await spxPaperRuntime.runOnce(at)).recorded) invalidateSnapshot();
          }, runCodexManager: codexManager ? (trigger, context) => { void codexManager!.run(trigger, context).then(invalidateSnapshot).catch(() => undefined); } : undefined });
      } else shadowRuntime.start();
    }
    // This legacy guard includes provider-specific options/account probes; do not relabel another adapter's data as that provider.
    if (options.incidentGuard !== false && productionRuntime && activeSourceSelection(resolve(projectRoot, ".."))?.selected.market.provider === "ROBINHOOD") {
      const origin = `http://127.0.0.1:${actualPort}`;
      incidentGuard = createIncidentGuard({
        store: snapshots,
        siteVersion,
        marketProbe: async () => {
          const charts = await Promise.all([marketChart("SPY", "5m", "1d"), marketChart("QQQ", "5m", "1d")]);
          // Wider history is diagnostic only; preserve the existing one-session input to triggers and settlement.
          const currentCharts = charts.map((chart) => { const selected = selectChartSessions(chart.bars, "1d"); return { ...chart, range: "1d" as const, bars: selected.bars, session_dates: selected.dates }; });
          const recorded = snapshots.recordTsMarketCharts(currentCharts), watches = snapshots.getActiveSpxOptionWatches();
          if (watches.length) {
            try { const contracts = await spxOptions.contractsById(watches.map((watch) => watch.contract_id)); snapshots.recordSpxOptionQuotes(await spxOptions.quotes(contracts), recorded.insertedTriggerEvents); }
            catch { snapshots.recordSpxOptionQuotes([], recorded.insertedTriggerEvents); }
          }
          snapshots.recordSpxConvexityEvents(recorded.insertedIntradayEvents);
          return charts;
        },
        newsProbe: activeSourceSelection(resolve(projectRoot, ".."))?.selected.news.provider === "FINNHUB" ? finnhubNews : undefined,
        pageProbe: async () => {
          const response = await fetch(`${origin}/api/health`, { headers: { authorization: `Bearer ${gatewayKey}` }, signal: AbortSignal.timeout(10_000) });
          return response.ok;
        },
        ownerActionProbe: async () => {
          const response = await fetch(`${origin}/api/owner-action-probe`, { method: "POST", headers: { authorization: `Bearer ${gatewayKey}` }, signal: AbortSignal.timeout(10_000) });
          const result = await response.json() as { ok?: boolean; action_status?: string; command_id?: string; dry_run?: boolean; persisted?: boolean; broker_write_calls?: number };
          return response.ok && result.ok === true && result.action_status === "SUCCEEDED" && Boolean(result.command_id) && result.dry_run === true && result.persisted === false && result.broker_write_calls === 0;
        },
        recoverShadow: shadowRuntime ? (at) => shadowRuntime!.runTsCore("LIVE", at, "Manager deterministic TS Core recovery") : undefined,
        shadowRunning: (slotId) => shadowRuntime?.isRunning(slotId) ?? false,
        // A foreground portable copy has no Windows supervisor/task contract and does not inspect unrelated desktop crashes.
        desktopProbe: async () => [],
        intervalMs: 30_000,
        onCodexEscalation: codexManager ? (context) => { void codexManager!.run("INCIDENT_ESCALATION", context).then(invalidateSnapshot).catch(() => undefined); } : undefined,
      });
    }
    if (productionRuntime && !(await snapshots.getActiveAsync()).marketRadar.snapshot) {
      try {
        const sources = await collectSelectedMarket(new Date().toISOString(), undefined, resolve(projectRoot, ".."));
        snapshots.recordApprovedCapabilities(sources, `bootstrap:${sources.snapshot_id}`);
      } catch { /* Incident Guard records official-source failures; never replace them with samples. */ }
    }
    if (timelineScheduler) {
      await timelineScheduler.runOnce(new Date(), true);
      if (incidentGuard) await incidentGuard.runOnce();
      timelineScheduler.start();
      const writeBusinessHeartbeat = () => atomicJson(resolve(dataRoot, "maintenance", "owner-business-heartbeat.json"), { contract_version: "TS_CORE_BUSINESS_HEARTBEAT_V1", updated_at: new Date().toISOString(), server_pid: process.pid, scheduler_checked_at: timelineScheduler?.checkedAt ?? null, ts_core_running: shadowRuntime?.running ?? false, active_slot_id: shadowRuntime?.activeSlotId ?? null });
      writeBusinessHeartbeat();
      businessHeartbeatTimer = setInterval(writeBusinessHeartbeat, 15_000);
      businessHeartbeatTimer.unref();
    }
    incidentGuard?.start();
    if (productionRuntime && codexManager && timelineScheduler) {
      const readyAt = new Date();
      await snapshots.checkDatabase(readyAt.toISOString());
      startupRecovery = runStartupRecovery({
        store: snapshots,
        windowsBootAt: process.env.TRADING_OS_WINDOWS_BOOT_AT ?? runtimeStartedAt.toISOString(),
        supervisorStartedAt: process.env.TRADING_OS_SUPERVISOR_STARTED_AT ?? runtimeStartedAt.toISOString(),
        serviceReadyAt: readyAt.toISOString(),
        startReason: process.env.TRADING_OS_START_REASON === "WINDOWS_STARTUP" ? "WINDOWS_STARTUP" : "SERVICE_RESTART",
        supervisorRestartAttempts: Math.max(0, Number(process.env.TRADING_OS_SUPERVISOR_RESTART_ATTEMPTS) || 0),
        supervisorCircuitState: (["CLOSED", "BACKOFF", "HALF_OPEN", "OPEN"].includes(process.env.TRADING_OS_SUPERVISOR_CIRCUIT_STATE ?? "") ? process.env.TRADING_OS_SUPERVISOR_CIRCUIT_STATE : "CLOSED") as "CLOSED" | "BACKOFF" | "HALF_OPEN" | "OPEN",
        databaseStatus: "READY",
        schedulerStatus: timelineScheduler ? "READY" : "BLOCKED",
        runManager: (context, timeoutMs) => codexManager!.run("STARTUP_RECOVERY", context, false, timeoutMs),
      }).then(invalidateSnapshot).catch(() => undefined).finally(() => { startupRecovery = null; });
    }
    return {
      port: actualPort,
      url: `http://${host}:${actualPort}`,
      async close() {
        if (closed) return;
        closed = true;
        if (businessHeartbeatTimer) clearInterval(businessHeartbeatTimer);
        await incidentGuard?.stop();
        await timelineScheduler?.stop();
        await startupRecovery;
        await codexManager?.stop();
        shadowRuntime?.stop();
        await closeServer(server!);
        await Promise.allSettled([...ownerActionTasks.values()]);
        await closeServer(internal!.server);
        await snapshotWorker?.terminate();
        snapshots.close();
        releaseLock();
      },
    };
  } catch (error) {
    if (businessHeartbeatTimer) clearInterval(businessHeartbeatTimer);
    await incidentGuard?.stop();
    await timelineScheduler?.stop();
    await startupRecovery;
    await codexManager?.stop();
    shadowRuntime?.stop();
    if (server?.listening) await closeServer(server);
    await Promise.allSettled([...ownerActionTasks.values()]);
    if (internal?.server.listening) await closeServer(internal.server);
    await snapshotWorker?.terminate();
    snapshots.close();
    releaseLock();
    throw error;
  }
}

async function main() {
  if (process.argv.includes("--setup")) {
    const password = process.env.TRADING_OS_OWNER_SETUP_PASSWORD;
    if (!password) throw new Error("缺少安全输入的 Owner 密码");
    const path = writeOwnerCredentials(credentialFile(), password);
    process.stdout.write(`Owner 凭据已保存到本机：${path}\n`);
    return;
  }
  const { projectRoot } = resolveStockProjectPaths();
  process.env.CODEX_HOME = publicProfile(projectRoot, "model");
  const enabled = publicAutomationEnabled();
  const instance = await startOwnerServer({
    projectRoot, host: "127.0.0.1", port: OWNER_PORT, runtimeRole: "COMBINED", codexManager: false,
    investmentProfile: publicResearchConfigured(projectRoot) ? "OWNER" : "BLANK",
    ...(enabled ? { shadowRuntime: { v2Root: resolve(projectRoot, "..", "v2-reference") } } : { shadowRuntime: false as const, incidentGuard: false as const }),
  });
  process.stdout.write(`Trading OS Owner Access 正在运行：${instance.url}\n`);
  const stop = () => void instance.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
