import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, ".."), roles = ["market", "news", "broker"];
const maxAge = { market: 420_000, news: 420_000, broker: 120_000 };

function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error("SOURCE_SETTINGS_FORMAT_INVALID");
}

function selectedSources(value) {
  exact(value, roles); exact(value.market, ["provider", "environment"]); exact(value.news, ["provider"]); exact(value.broker, ["provider"]);
  if (!["ROBINHOOD", "TRADIER"].includes(value.market.provider) || !["LIVE", "SANDBOX"].includes(value.market.environment) || !["OFFICIAL_ONLY", "FINNHUB", "NONE"].includes(value.news.provider) || !["ROBINHOOD", "NONE"].includes(value.broker.provider)) throw new Error("SOURCE_SELECTION_UNSUPPORTED");
  if (value.market.provider === "ROBINHOOD" && value.market.environment !== "LIVE") throw new Error("SOURCE_ENVIRONMENT_UNSUPPORTED");
  return { market: { provider: value.market.provider, environment: value.market.environment }, news: { provider: value.news.provider }, broker: { provider: value.broker.provider } };
}

function identity(revision, selected) { return createHash("sha256").update(JSON.stringify({ version: 1, revision, selected })).digest("hex"); }

export function sourceSettingsPath(packageRoot = root) {
  const base = resolve(packageRoot), work = join(root, "_工作文件");
  if (base !== root && !base.startsWith(work + sep)) throw new Error("SOURCE_SETTINGS_PATH_OUTSIDE_PACKAGE");
  const file = join(base, "web", "data", "source-settings.json");
  for (let path = file; ; path = dirname(path)) {
    try { const stat = lstatSync(path); if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error("SOURCE_SETTINGS_LINK_FORBIDDEN"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path === root) break;
  }
  return file;
}

export function readSourceSettings(packageRoot = root) {
  const file = sourceSettingsPath(packageRoot);
  if (!existsSync(file)) return null;
  return validateSourceSettings(JSON.parse(readFileSync(file, "utf8")));
}

export function validateSourceSettings(value) {
  exact(value, ["version", "revision", "selection_id", "selected"]);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("SOURCE_SETTINGS_VERSION_INVALID");
  const selected = selectedSources(value.selected);
  if (value.selection_id !== identity(value.revision, selected)) throw new Error("SOURCE_SETTINGS_IDENTITY_INVALID");
  return { version: 1, revision: value.revision, selection_id: value.selection_id, selected };
}

/** Choosing never authorizes, probes, stores credentials or asserts VERIFIED. */
export function saveSourceSettings(selected, { packageRoot = root, confirmed = false, expectedRevision = null } = {}) {
  if (confirmed !== true) throw new Error("SOURCE_SETTINGS_CONFIRMATION_REQUIRED");
  const clean = selectedSources(selected), file = sourceSettingsPath(packageRoot), directory = dirname(file);
  mkdirSync(directory, { recursive: true }); sourceSettingsPath(packageRoot);
  const lock = `${file}.lock`, temporary = `${file}.${randomUUID()}.tmp`;
  let lockFd, temporaryFd;
  try {
    lockFd = openSync(lock, "wx", 0o600);
    const previous = readSourceSettings(packageRoot);
    if ((previous?.revision ?? null) !== expectedRevision) throw new Error("SOURCE_SETTINGS_REVISION_CONFLICT: existing settings were not overwritten");
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("SOURCE_SETTINGS_REVISION_INVALID");
    const value = { version: 1, revision, selection_id: identity(revision, clean), selected: clean };
    temporaryFd = openSync(temporary, "wx", 0o600);
    writeFileSync(temporaryFd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(temporaryFd); closeSync(temporaryFd); temporaryFd = undefined;
    sourceSettingsPath(packageRoot); renameSync(temporary, file);
    return value;
  } finally {
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
  }
}

/** Projection of trusted collector receipts only, never of a user's configuration claims. */
export function sourceReadiness(settings, role, evidence, { now = Date.now() } = {}) {
  if (!roles.includes(role)) throw new Error("SOURCE_ROLE_INVALID");
  const result = (status, reason, optional = false) => ({ role, status, ready: status === "VERIFIED", optional, reason });
  if (!settings) return result("NOT_CONFIGURED", "SOURCE_SELECTION_REQUIRED");
  if (settings.version !== 1 || !Number.isSafeInteger(settings.revision) || settings.revision < 1) return result("BLOCKED", "SOURCE_SETTINGS_VERSION_INVALID");
  const selected = selectedSources(settings.selected), choice = selected[role];
  if (choice.provider === "NONE") return result("NOT_CONFIGURED", "DISABLED_BY_USER", true);
  if (role === "market" && choice.environment !== "LIVE") return result("BLOCKED", "SANDBOX_NOT_NATURAL_MARKET_DATA");
  if (!evidence) return result("NOT_VERIFIED", "ACTUAL_READ_REQUIRED");
  if (settings.selection_id !== identity(settings.revision, selected) || evidence.selection_id !== settings.selection_id || evidence.revision !== settings.revision || evidence.role !== role || evidence.provider !== choice.provider || role === "market" && evidence.environment !== choice.environment) return result("BLOCKED", "SOURCE_EVIDENCE_SELECTION_MISMATCH");
  if (evidence.source_mode !== "LIVE" || evidence.status !== "SUCCESS" || evidence.access !== "READ_ONLY" || !/^[a-f0-9]{64}$/.test(evidence.evidence_sha256 ?? "")) return result("BLOCKED", "SOURCE_EVIDENCE_UNVERIFIED");
  const checked = Date.parse(evidence.checked_at), expires = Date.parse(evidence.expires_at), at = typeof now === "number" ? now : Date.parse(now);
  if (![checked, expires, at].every(Number.isFinite) || checked > at || expires <= checked || at > expires || at - checked > maxAge[role] || expires - checked > maxAge[role]) return result("BLOCKED", "SOURCE_EVIDENCE_EXPIRED_OR_INVALID_TIME");
  const capability = evidence.capabilities ?? {};
  if (role === "market" && (!(capability.quotes === true && capability.intraday_bars === true && capability.daily_bars === true) || !["LIVE", "MARKET_CLOSED"].includes(evidence.market_status)) || role === "broker" && capability.account_read !== true || role === "news" && !(capability.news === true || capability.earnings_calendar === true)) return result("BLOCKED", "SOURCE_REQUIRED_CAPABILITY_MISSING");
  return result("VERIFIED", "ACTUAL_SOURCE_RECEIPT_VALID");
}
