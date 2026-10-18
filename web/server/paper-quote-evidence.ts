import { robinhoodSessionAt } from "../app/market-time.ts";
import { validatePaperQuoteProof, type PaperChartIssue, type PaperChartPoint, type PaperChartSnapshot, type PaperPlan, type PaperQuoteProof } from "../app/paper-plan.ts";
import { robinhoodResponseBody, type McpSession } from "./robinhood-mcp.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const rawNumber = (value: unknown) => typeof value === "string" || typeof value === "number" ? value : null;
const number = (value: unknown) => typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
const rows = (body: Record<string, unknown>, key: string) => {
  const data = object(body.data), value = data[key] ?? body[key] ?? data.results ?? body.results;
  if (!Array.isArray(value)) throw Error("PAPER_RESPONSE_INVALID");
  return value.map(object);
};

/** A PAPER-only wrapper: retain selected public fields, never accounts or full batches. */
export function capturePaperQuoteEvidence(session: McpSession, now: () => Date) {
  const instruments = new Map<string, PaperQuoteProof["instrument"]>(), quotes = new Map<string, Omit<PaperQuoteProof, "instrument">>();
  return {
    raw() { return { instruments: [...instruments.values()], quotes: [...quotes.values()] }; },
    session: { listTools: () => session.listTools(), async call(tool: string, args: unknown) {
      const requested_at = now().toISOString(), response = await session.call(tool, args), received_at = now().toISOString();
      if (tool === "get_option_instruments" || tool === "get_option_quotes") {
        const values = rows(robinhoodResponseBody(response), tool === "get_option_instruments" ? "instruments" : "results"), seen = new Set<string>();
        for (const value of values) {
          const row = tool === "get_option_quotes" ? object(value.quote) : value, id = text(row.id ?? row.instrument_id);
          if (!id || seen.has(id)) throw Error("PAPER_DUPLICATE_OR_MISSING_IDENTITY");
          seen.add(id);
          if (tool === "get_option_instruments") instruments.set(id, {
            id, chain_id: text(row.chain_id), chain_symbol: text(row.chain_symbol), underlying_type: text(row.underlying_type), expiration_date: text(row.expiration_date), strike_price: rawNumber(row.strike_price),
            type: text(row.type), state: text(row.state), tradability: text(row.tradability), trade_value_multiplier: rawNumber(row.trade_value_multiplier),
          });
          else quotes.set(id, { requested_at, received_at, quote: { instrument_id: id, bid_price: rawNumber(row.bid_price), ask_price: rawNumber(row.ask_price), mark_price: rawNumber(row.mark_price), updated_at: text(row.updated_at) } });
        }
      }
      return response;
    } } satisfies McpSession,
    proof(plan: Pick<PaperPlan, "symbol" | "contract">, quote: { bid: number; ask: number; mark?: number; quoted_at: string }, recordedAt: string): PaperQuoteProof | undefined {
      const instrument = instruments.get(plan.contract.contract_id), value = quotes.get(plan.contract.contract_id);
      if (!instrument || !value) return undefined;
      const proof = { ...value, instrument };
      try { validatePaperQuoteProof({ ...quote, proof }, plan, recordedAt); return proof; } catch { return undefined; }
    },
  };
}

export const paperChartStart = (quotedAt: string) => Math.floor(Date.parse(quotedAt) / 300_000) * 300_000;

/** Each query is exactly one completed five-minute bucket, with at most eight IDs. */
async function chartBucket(session: McpSession, plans: PaperPlan[], start: number, now: () => Date) {
  const points = new Map<string, PaperChartPoint | PaperChartIssue>(), end = start + 300_000;
  if (!plans.length) return points;
  if (plans.length > 8 || !Number.isFinite(start)) return new Map(plans.map((plan) => [plan.plan_id, "INVALID_BAR" as const]));
  if (end > now().getTime() || robinhoodSessionAt(new Date(start)).phase !== "REGULAR") return new Map(plans.map((plan) => [plan.plan_id, "NO_COMPLETED_BAR" as const]));
  try {
    const body = robinhoodResponseBody(await session.call("get_option_historicals", { instrument_ids: plans.map((plan) => plan.contract.contract_id), start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), interval: "5minute", bounds: "regular" }));
    const retrieved_at = now().toISOString(), results = rows(body, "results"), notFound = object(body.data).not_found;
    for (const plan of plans) {
      const matches = results.filter((row) => row.instrument_id === plan.contract.contract_id);
      points.set(plan.plan_id, "NOT_FOUND");
      if (!matches.length || Array.isArray(notFound) && notFound.includes(plan.contract.contract_id)) continue;
      points.set(plan.plan_id, "INVALID_BAR");
      if (matches.length !== 1) continue;
      const row = matches[0];
      const occ = `${plan.symbol}${plan.contract.expiration.slice(2).replaceAll("-", "")}${plan.contract.option_type === "call" ? "C" : "P"}${String(Math.round(plan.contract.strike * 1_000)).padStart(8, "0")}`;
      if (row.symbol !== plan.symbol || text(row.occ_symbol).replaceAll(" ", "") !== occ || row.interval !== "5minute" || row.bounds !== "regular" || !Array.isArray(row.bars)) continue;
      const matching = row.bars.map(object).filter((bar) => Date.parse(text(bar.begins_at)) === start);
      if (!matching.length) { points.set(plan.plan_id, "NOT_FOUND"); continue; }
      if (matching.length !== 1) continue;
      const bar = matching[0], open = number(bar.open_price), high = number(bar.high_price), low = number(bar.low_price), close = number(bar.close_price);
      if (bar.interpolated === true || bar.session !== "reg" || ![open, high, low, close].every((value) => Number.isFinite(value) && value >= 0) || low > Math.min(open, close) || high < Math.max(open, close) || low > high || end > Date.parse(retrieved_at) || end > Date.parse(plan.expires_at)) continue;
      points.set(plan.plan_id, { contract_id: plan.contract.contract_id, begins_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), close, retrieved_at, source: "ROBINHOOD", interval: "5minute" });
    }
  } catch {
    for (const plan of plans) points.set(plan.plan_id, "READ_FAILED");
  }
  return points;
}

export async function collectPaperCharts(session: McpSession, plans: PaperPlan[], entries: Map<string, PaperChartPoint>, rotation: number, now: () => Date): Promise<Map<string, PaperChartSnapshot>> {
  const latestStart = paperChartStart(now().toISOString()) - 300_000, groups = new Map<number, PaperPlan[]>();
  for (const plan of plans) {
    const start = paperChartStart(plan.reference.quoted_at);
    if (!entries.has(plan.plan_id) && start <= latestStart && robinhoodSessionAt(new Date(start)).phase === "REGULAR") groups.set(start, [...(groups.get(start) ?? []), plan]);
  }
  const missing = [...groups.entries()].sort(([left], [right]) => left - right), group = missing.length ? missing[rotation % missing.length] : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // ponytail: two bounded history queries share ten seconds, below the existing 20-second RPC ceiling; no retries or per-contract requests.
  const requests = [chartBucket(session, plans, latestStart, now), group && group[0] !== latestStart ? chartBucket(session, group[1], group[0], now) : Promise.resolve(new Map<string, PaperChartPoint | PaperChartIssue>())];
  let latest: Map<string, PaperChartPoint | PaperChartIssue>, historical: Map<string, PaperChartPoint | PaperChartIssue>;
  const timedOut = new Promise<Map<string, PaperChartPoint | PaperChartIssue>>((resolve) => { timer = setTimeout(() => resolve(new Map(plans.map((plan) => [plan.plan_id, "TIMEOUT"]))), 10_000); });
  try { [latest, historical] = await Promise.all(requests.map((request) => Promise.race([request, timedOut]))); }
  finally { clearTimeout(timer); }
  const checked_at = now().toISOString();
  return new Map(plans.map((plan) => {
    const start = paperChartStart(plan.reference.quoted_at);
    const entryResult = entries.get(plan.plan_id) ?? (start === latestStart ? latest.get(plan.plan_id) : group?.[0] === start ? historical.get(plan.plan_id) : undefined)
      ?? (start > latestStart || robinhoodSessionAt(new Date(start)).phase !== "REGULAR" ? "NO_COMPLETED_BAR" : "WAIT_ROTATION");
    const latestResult = latest.get(plan.plan_id) ?? "NOT_FOUND";
    const entry = typeof entryResult === "string" ? null : entryResult, point = typeof latestResult === "string" ? null : latestResult;
    return [plan.plan_id, { entry, latest: point, checked_at, status: entry && point ? "AVAILABLE" : entry || point ? "PARTIAL" : "UNAVAILABLE",
      ...(typeof entryResult === "string" ? { entry_issue: entryResult } : {}), ...(typeof latestResult === "string" ? { latest_issue: latestResult } : {}) }];
  }));
}
