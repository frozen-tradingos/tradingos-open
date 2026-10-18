import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MarketIntelligenceState, DataSourceState } from "../app/market-intelligence.ts";
import type { LiveShadowRuntimeOptions } from "./live-shadow-runtime.ts";
import type { SnapshotState } from "../app/snapshot-import.ts";
import { robinhoodSessionAt } from "../app/market-time.ts";
import { buildTsRegimeRiskContext } from "../app/ts-regime-risk.ts";
import { projectStockConditionalPlans, projectStockManualPlans, stockPlanAnalysisGaps, stockPlanCurrentGaps, stockPlanEvidenceGaps, type StockManualPlanOutput, type StockPlanEvidence } from "../app/stock-manual-plan.ts";
import { collectStockPlanEvidence } from "./stock-plan-evidence.ts";
import { reviewStockPlan } from "./stock-plan-review.ts";
import { withRobinhoodMcp } from "./robinhood-mcp.ts";

type Input = Parameters<NonNullable<LiveShadowRuntimeOptions["runStockPlans"]>>[0];

// Uses completed natural Core attempts and the existing FULL companion, with one journal per slot.
export function createStockManualRuntime(options: {
  projectRoot: string; dataRoot: string; activatedAt: Date; v2Root?: string;
  publish: (raw: string, receivedAt: string) => void;
  readCurrent?: () => Promise<SnapshotState>;
  now?: () => Date;
  collect?: typeof collectStockPlanEvidence;
  review?: typeof reviewStockPlan;
  session?: typeof withRobinhoodMcp;
}) {
  const now = options.now ?? (() => new Date());
  return async (input: Input) => {
    const match = /^live-shadow:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(input.runId);
    if (!match || input.slotId !== input.runId) return;
    const slot = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
    const at = now();
    if (slot < options.activatedAt.getTime() || at.getTime() < slot || at.getTime() - slot >= 15 * 60_000 || robinhoodSessionAt(at).phase !== "REGULAR") return;
    const directory = resolve(options.dataRoot, "stock-manual-plans", input.runId.replaceAll(":", "-"));
    await mkdir(directory, { recursive: true });
    const resultPath = resolve(directory, "result.json");
    try {
      const prior = JSON.parse(await readFile(resultPath, "utf8")) as { envelopes: string[] };
      for (const raw of prior.envelopes) options.publish(raw, now().toISOString());
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await writeFile(resolve(directory, "started.json"), JSON.stringify({ run_id: input.runId, started_at: at.toISOString() }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
    const envelopes: string[] = [];
    let outcome = "NO_CANDIDATE", errorText: string | null = null;
    try {
      const market = input.a1.market_sources;
      if (!market?.approved_capabilities) throw new Error("同槽固定池证据缺失，未生成个股计划");
      const approvedCapabilities = market.approved_capabilities;
      const risk = buildTsRegimeRiskContext({ market, a2: input.a2, officialMacro: input.a1.official_macro, observedAt: input.a1.observed_at });
      const intelligence = input.context.marketIntelligence as MarketIntelligenceState | undefined;
      const source = (input.context.dataSources as DataSourceState[] | undefined)?.find((row) => row.source === "FINNHUB");
      const verifiedChains = new Map((intelligence?.causalChains ?? []).filter((chain) => chain.event_evidence_state === "VERIFIED" && Date.parse(chain.expires_at) > now().getTime()).map((chain) => [chain.event_fingerprint, chain]));
      const news: StockPlanEvidence["news"] = {
        checked_at: source?.checked_at ?? input.a1.observed_at,
        status: source?.status === "LIVE" && source.authorization === "VALID" ? "LIVE" : "DATA_BLOCKED",
        items: (intelligence?.events ?? []).filter((event) => event.kind === "NEWS" && event.source_url && event.published_at).slice(0, 30).map((event) => ({
          id: event.event_id, headline: event.title, url: event.source_url!, source: event.source, published_at: event.published_at!,
          verified: event.event_evidence_state === "VERIFIED" && verifiedChains.has(event.event_fingerprint ?? ""), market_moving: event.importance === "MARKET_MOVING" && verifiedChains.has(event.event_fingerprint ?? ""), symbols: event.affected_symbols,
          expires_at: verifiedChains.get(event.event_fingerprint ?? "")?.expires_at ?? null,
        })),
      };
      const evidence = await (options.session ?? withRobinhoodMcp)({ projectRoot: options.projectRoot, timeoutMs: 30_000,
        allowlist: ["get_accounts", "get_option_positions", "get_equity_quotes", "get_equity_historicals", "get_option_chains", "get_option_instruments", "get_option_quotes"] },
      (session) => (options.collect ?? collectStockPlanEvidence)(session, {
        run_id: input.runId, slot_id: input.slotId, source_snapshot_id: market.snapshot_id, source_snapshot_hash: market.snapshot_hash,
        approvedCapabilities, news, v2Root: options.v2Root ?? resolve(options.projectRoot, "..", "v2-reference"),
        // Stocks collect their own quote, bars, account and A2 classification; only these two index-only gaps are inapplicable.
        global_risk: { checked_at: risk.observed_at, critical_blockers: risk.risk_layers.core_hard.filter((row) => !["CORE_MARKET_UNAVAILABLE", "A2_FROZEN_EVIDENCE_MISSING"].includes(row.code)).map((row) => row.reason), new_entry_blockers: risk.risk_layers.new_entry.filter((row) => row.scope === "GLOBAL").map((row) => row.reason) },
      }));
      // ponytail: at most three independent reviews in parallel; keep the fixed cap until provider latency permits more.
      const outputs = await Promise.all(evidence.map(async (item): Promise<StockManualPlanOutput> => {
        const v2 = item.contract_version === "stock-plan-v2";
        const gaps = (v2 ? stockPlanAnalysisGaps : stockPlanEvidenceGaps)(item, now().getTime());
        const reviewed = gaps.length ? null : await (options.review ?? reviewStockPlan)({ projectRoot: options.projectRoot, dataRoot: directory, evidence: item }).catch(() => {
          gaps.push("该个股独立复核失败；未批准，不影响其他个股复核"); return null;
        });
        const decisions = [reviewed?.d, reviewed?.a3].filter((row) => row != null);
        const output: StockManualPlanOutput = {
          contract_version: item.contract_version, component: "STOCK_MANUAL_PLAN", mode: "SHADOW", source_mode: "LIVE", automated_execution: false,
          run_id: input.runId, slot_id: input.slotId, observed_at: now().toISOString(), evidence: item, decisions,
          status: gaps.length ? "DATA_BLOCKED" : reviewed?.status !== "REVIEWED" ? "NO_TRADE"
            : reviewed.d?.action === "MANUAL_BUY" && reviewed.a3?.action === "MANUAL_BUY" ? "APPROVED"
              : v2 && reviewed.d?.action === "CONDITIONAL_PLAN" && reviewed.a3?.action === "CONDITIONAL_PLAN" ? "CONDITIONAL" : "NO_TRADE",
          blocked_reasons: gaps.length ? gaps : reviewed?.status !== "REVIEWED" && reviewed?.reason ? [reviewed.reason] : [],
        };
        if (output.status === "APPROVED" || output.status === "CONDITIONAL") {
          const check = (output.status === "CONDITIONAL" ? projectStockConditionalPlans : projectStockManualPlans)([output], now().getTime());
          if (!check.plans.length) { output.status = "DATA_BLOCKED"; output.blocked_reasons = check.blocked_reasons; }
        }
        return output;
      }));
      const current = options.readCurrent && outputs.some((output) => output.status === "APPROVED" || output.status === "CONDITIONAL") ? await options.readCurrent() : null;
      for (const output of outputs) {
        if (output.status === "APPROVED" || output.status === "CONDITIONAL") {
          const checkedAt = now().getTime();
          const gaps = [...(output.status === "CONDITIONAL" ? stockPlanAnalysisGaps : stockPlanEvidenceGaps)(output.evidence, checkedAt), ...(current ? stockPlanCurrentGaps(output.evidence, current, checkedAt) : [])];
          const selectedPlanCurrent = output.status === "CONDITIONAL"
            ? projectStockConditionalPlans([output], checkedAt).plans.some((plan) => plan.stage === "WAITING_TRIGGER")
            : projectStockManualPlans([output], checkedAt).plans.length > 0;
          if (!selectedPlanCurrent) gaps.push("已审核的精确合约或计划已过期/失效，不能沿用其他合约的当前报价");
          if (gaps.length) { output.status = "DATA_BLOCKED"; output.blocked_reasons = gaps; }
        }
        envelopes.push(JSON.stringify({ gateway_format: "TRADING_OS_LOCAL_OUTPUT", gateway_version: 1,
        record_id: `${input.runId}:STOCK:${output.evidence.symbol}`, output_type: "STOCK_MANUAL_PLAN", channel: "SHADOW", observed_at: output.observed_at, payload: output }));
      }
      outcome = outputs.length ? "RECORDED" : "NO_CANDIDATE";
    } catch (error) { outcome = "FAILED"; errorText = error instanceof Error ? error.name : "StockEvidenceError"; }
    await writeFile(resultPath, JSON.stringify({ run_id: input.runId, completed_at: now().toISOString(), outcome, error: errorText, envelopes }), { flag: "wx", mode: 0o600 });
    for (const raw of envelopes) options.publish(raw, now().toISOString());
    if (outcome === "FAILED") throw new Error(`个股人工计划取数或复核失败；独立证据：${directory}`);
  };
}
