import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";
import type { SnapshotState } from "../app/snapshot-import.ts";
import { exchangeDateKey, MARKET_5M_MAX_AGE_SECONDS, robinhoodSessionAt } from "../app/market-time.ts";
import { spxContractObservationEnd, spxWatchLifecycle } from "../app/spx-observation-lifecycle.ts";
import { collectSpxObservationCandidate, withRobinhoodMcp } from "./robinhood-mcp.ts";

export type SpxPaperStatus = {
  rule: "SPXW_PAPER_7_30_V1"; checked_at: string; simulation_only: true;
  status: "CREATED" | "NO_CANDIDATE" | "WAITING_REGIME" | "ALREADY_TRACKING" | "SOURCE_UNAVAILABLE" | "MARKET_CLOSED";
  reasons: string[]; watch_id?: string; regime_event_id?: string;
  selection?: Awaited<ReturnType<typeof collectSpxObservationCandidate>>["selection"];
};
const RULE = "SPXW_PAPER_7_30_V1";
const statusFile = (dataRoot: string) => resolve(dataRoot, "maintenance/spx-paper-latest.json");

export function readSpxPaperStatus(dataRoot: string): SpxPaperStatus | null {
  try {
    if (!existsSync(statusFile(dataRoot))) return null;
    const value = JSON.parse(readFileSync(statusFile(dataRoot), "utf8")) as SpxPaperStatus;
    return value.rule === RULE && value.simulation_only === true && Number.isFinite(Date.parse(value.checked_at)) && Array.isArray(value.reasons) ? value : null;
  } catch { return null; }
}

function currentRegime(state: SnapshotState, at: Date) {
  const regime = state.intradayRegime?.current;
  const age = at.getTime() - Date.parse(regime?.data_timestamp ?? "");
  return regime?.source_mode === "LIVE" && regime.evidence_eligibility === "NATURAL_STRUCTURE_ONLY" && regime.replay === false
    && regime.trading_date === exchangeDateKey(at) && regime.direction !== "NONE" && ["FORMING", "CONFIRMED"].includes(regime.path_stage)
    && Number.isFinite(age) && age >= 0 && age <= MARKET_5M_MAX_AGE_SECONDS * 1_000 ? regime : null;
}

export function createSpxPaperRuntime(options: {
  projectRoot: string; dataRoot: string;
  store: Pick<ReturnType<typeof openSnapshotDatabase>, "createSpxOptionWatch">;
  readCurrent: () => Promise<SnapshotState>;
  now?: () => Date; session?: typeof withRobinhoodMcp; collect?: typeof collectSpxObservationCandidate;
}) {
  const now = options.now ?? (() => new Date());
  let running = false;
  const record = (value: Omit<SpxPaperStatus, "rule" | "checked_at" | "simulation_only">) => {
    const status: SpxPaperStatus = { ...value, rule: RULE, checked_at: now().toISOString(), simulation_only: true };
    const directory = resolve(options.dataRoot, "maintenance");
    mkdirSync(directory, { recursive: true });
    appendFileSync(resolve(directory, "spx-paper-attempts.jsonl"), JSON.stringify(status) + "\n", { mode: 0o600 });
    const temporary = resolve(directory, `spx-paper-latest-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(status), { flag: "wx", mode: 0o600 });
    renameSync(temporary, statusFile(options.dataRoot));
    return { status: status.status, recorded: 1 };
  };
  return { async runOnce(at = now()) {
    if (running) return { status: "OVERLAP_REJECTED", recorded: 0 };
    const age = now().getTime() - at.getTime();
    if (!Number.isFinite(age) || age < 0 || age > 120_000) return { status: "NOT_CURRENT", recorded: 0 };
    running = true;
    let owner = false;
    try {
      const state = await options.readCurrent(), profile = state.investmentKernel;
      owner = profile.profile_mode === "OWNER" && profile.execution_mode === "SHADOW" && profile.broker_access === "READ_ONLY" && profile.automated_execution === false;
      if (!owner) return { status: "NOT_OWNER", recorded: 0 };
      if (robinhoodSessionAt(now()).phase !== "REGULAR") return record({ status: "MARKET_CLOSED", reasons: ["休市；下一自然盘中检查再选约，不用历史报价建新单。"] });
      const regime = currentRegime(state, now()), capitalContext = profile.capital_context?.context;
      if (!regime || !capitalContext) return record({ status: "WAITING_REGIME", reasons: [!regime ? "等待当前自然盘型形成明确方向；旧人工点位不参与自动选约。" : "Owner资金范围未配置，暂不能按原范围选择研究合约。"] });
      const optionType = regime.direction === "UP" ? "call" : "put";
      const already = state.spxwProxy.watches.find((watch) => watch.strategy_context?.signal_source.source_mode === "SYSTEM_SIMULATED_RESEARCH" && watch.option_type === optionType
        && (spxWatchLifecycle(watch, now()).status === "ACTIVE" || exchangeDateKey(watch.created_at) === regime.trading_date));
      if (already) return record({ status: "ALREADY_TRACKING", watch_id: already.watch_id, regime_event_id: regime.event_id, reasons: ["该方向已有自动模拟观察；保留原合约继续跟踪，每个交易日同方向最多新增一张。"] });
      const result = await (options.session ?? withRobinhoodMcp)({ projectRoot: options.projectRoot, timeoutMs: 60_000, allowlist: ["get_option_chains", "get_option_instruments", "get_option_quotes"] }, (session) => (options.collect ?? collectSpxObservationCandidate)(session, {
        direction: regime.direction === "UP" ? "BULLISH" : "BEARISH", capitalContext, observedAt: now().toISOString(),
        excludeContractIds: state.spxwProxy.watches.filter((watch) => spxWatchLifecycle(watch, now()).status === "ACTIVE").map((watch) => watch.contract_id),
      }));
      if (!result.candidate) {
        const unavailable = result.reasons.some((reason) => /PROVIDER_READ_FAILED|RESPONSE_INVALID|IDENTITY_INVALID|INCOMPLETE|LIMIT_EXCEEDED|BUDGET_EXCEEDED|DUPLICATE_INSTRUMENT|QUOTES_MISSING/.test(reason))
          || (result.reasons.includes("SPXW_COLLECTION_BLOCKED") && !result.reasons.some((reason) => ["SPXW_NO_7_30_DTE_EXPIRATION", "SPXW_NO_NEW_VERIFIED_CONTRACT"].includes(reason)));
        return record({ status: unavailable ? "SOURCE_UNAVAILABLE" : "NO_CANDIDATE", reasons: result.reasons, regime_event_id: regime.event_id, selection: result.selection });
      }
      const latest = await options.readCurrent(), current = currentRegime(latest, now()), createdAt = now().toISOString();
      if (!current || current.direction !== regime.direction || robinhoodSessionAt(createdAt).phase !== "REGULAR") return record({ status: "WAITING_REGIME", reasons: ["选约完成时方向、行情或交易时段已变化，未用过时依据建单。"], selection: result.selection });
      const key = createHash("sha256").update(`${RULE}:${current.trading_date}:${current.direction}`).digest("hex").slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      const { contract, quote } = result.candidate;
      const receipt = options.store.createSpxOptionWatch(contract, quote, "系统自动选择的SPXW模拟观察；按真实Delta和报价筛选，不是Owner手填、真实买入或执行批准。", createdAt, null, key, spxContractObservationEnd(contract), {
        rule: RULE, regime_event_id: current.event_id, created_from: "NATURAL_A1_HEARTBEAT", observed_at: createdAt,
      });
      return record({ status: receipt.duplicate ? "ALREADY_TRACKING" : "CREATED", watch_id: receipt.observation_id, regime_event_id: current.event_id, reasons: result.reasons, selection: result.selection });
    } catch {
      return owner ? record({ status: "SOURCE_UNAVAILABLE", reasons: ["自动选约未完成；真实源、报价、当前盘型或写入校验不可用。下一自然检查再试，不补造旧单。"] }) : { status: "SNAPSHOT_UNAVAILABLE", recorded: 0 };
    } finally { running = false; }
  } };
}
