import { latestCompletedNyseSession, MARKET_5M_MAX_AGE_SECONDS, robinhoodSessionAt } from "../app/market-time.ts";
import type { openSnapshotDatabase } from "../build/local-data-core.ts";
import type { ExternalOptionFilter, ExternalOptionQuote } from "./robinhood-mcp.ts";

type Store = ReturnType<typeof openSnapshotDatabase>;
type MonitorResult = { checked: number; recorded: number; expired: number };

function text(value: unknown) { return typeof value === "string" && value ? value : null; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }

export function createExternalExpertMonitor(store: Store, readQuote: (filter: ExternalOptionFilter, at: Date) => Promise<ExternalOptionQuote | null>) {
  let running: Promise<MonitorResult> | null = null;
  const run = async (at: Date): Promise<MonitorResult> => {
    let recorded = 0, expired = 0;
    const cases = store.getExternalExpertOverview().cases.filter((item) => item.status === "OPEN" || item.status === "PARTIAL_EXIT");
    for (const item of cases) {
      const symbol = text(item.expert.symbol)?.toUpperCase(), expiration = text(item.expert.expiration), strike = number(item.expert.strike), instrument = text(item.expert.instrument)?.toUpperCase();
      if (!symbol || !expiration || strike === null || (instrument !== "CALL" && instrument !== "PUT")) continue;
      if (latestCompletedNyseSession(at) >= expiration) {
        store.recordExternalExpertEvent({ case_id: item.case_id, event_type: "MARKET_UPDATE", status: "EXPIRED", realtime_class: item.realtime_class, received_at: at.toISOString(), raw_text: "结构化到期日已结束；案例转为EXPIRED并永久保留", market: { expiration, expiry_status: "EXPIRED", source: "NYSE_CALENDAR" } });
        recorded += 1; expired += 1; continue;
      }
      if (robinhoodSessionAt(at).phase !== "REGULAR") continue;
      const quote = await readQuote({ symbol, expiration, strike, option_type: instrument.toLowerCase() as "call" | "put" }, at);
      if (!quote || text(item.market.quoted_at) === quote.quoted_at) continue;
      const receivedAt = quote.received_at ?? at.toISOString(), receivedMs = Date.parse(receivedAt), quotedMs = Date.parse(quote.quoted_at), age = (receivedMs - quotedMs) / 1_000;
      if (!Number.isFinite(age) || age < 0 || age > MARKET_5M_MAX_AGE_SECONDS || receivedMs < at.getTime() || !Number.isFinite(quote.mark) || quote.mark < 0) continue;
      const cost = number(item.expert.cost_basis), currentReturn = cost === null || cost <= 0 ? null : (quote.mark / cost - 1) * 100;
      const priorMfe = number(item.market.mfe_pct), priorMae = number(item.market.mae_pct);
      store.recordExternalExpertEvent({
        case_id: item.case_id, event_type: "MARKET_UPDATE", realtime_class: item.realtime_class, received_at: receivedAt, source_published_at: quote.quoted_at,
        raw_text: "Robinhood只读期权报价持续观察",
        market: { source: "ROBINHOOD_OFFICIAL_READONLY", contract_id: quote.contract_id, bid: quote.bid, ask: quote.ask, mark: quote.mark, iv: quote.iv, delta: quote.delta, gamma: quote.gamma, theta: quote.theta, vega: quote.vega, quoted_at: quote.quoted_at, freshness_seconds: age, current_return_pct: currentReturn, mfe_pct: currentReturn === null ? priorMfe : Math.max(priorMfe ?? currentReturn, currentReturn), mae_pct: currentReturn === null ? priorMae : Math.min(priorMae ?? currentReturn, currentReturn) },
      });
      recorded += 1;
    }
    return { checked: cases.length, recorded, expired };
  };
  return { runOnce(at = new Date()) { if (!running) running = run(at).finally(() => { running = null; }); return running; } };
}
