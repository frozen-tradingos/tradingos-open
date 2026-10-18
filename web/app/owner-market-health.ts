import { MARKET_5M_MAX_AGE_SECONDS, type RobinhoodSessionPhase } from "./market-time.ts";

export type OwnerMarketHealthCode = "BAR_LIVE_QUOTE_LIVE" | "BAR_LIVE_QUOTE_STALE" | "EXPECTED_PROVIDER_SESSION_LIMIT" | "MARKET_CLOSED" | "GENUINE_DATA_BLOCKED" | "SYSTEM_BLOCKED" | "SOURCE_GAP";

export function classifyOwnerMarketHealth(input: {
  status: string;
  phase: RobinhoodSessionPhase;
  quote_freshness_seconds: number | null;
  bar_freshness_seconds: number | null;
  gap_status?: "SOURCE_GAP" | null;
  system_blocked?: boolean;
}) {
  const quote_live = input.quote_freshness_seconds !== null && input.quote_freshness_seconds <= MARKET_5M_MAX_AGE_SECONDS;
  const bar_live = input.bar_freshness_seconds !== null && input.bar_freshness_seconds <= MARKET_5M_MAX_AGE_SECONDS;
  const raw_pair = bar_live && quote_live ? "BAR_LIVE_QUOTE_LIVE" as const : bar_live ? "BAR_LIVE_QUOTE_STALE" as const : null;
  const code: OwnerMarketHealthCode = input.system_blocked ? "SYSTEM_BLOCKED"
    : input.gap_status === "SOURCE_GAP" ? "SOURCE_GAP"
      : input.status === "DATA_BLOCKED" && !bar_live ? "GENUINE_DATA_BLOCKED"
        : input.status === "MARKET_CLOSED" && input.phase === "CLOSED" && [input.quote_freshness_seconds, input.bar_freshness_seconds].some((age) => age !== null && Number.isFinite(age) && age >= 0) ? "MARKET_CLOSED"
        : raw_pair === "BAR_LIVE_QUOTE_STALE" && input.phase === "OVERNIGHT" ? "EXPECTED_PROVIDER_SESSION_LIMIT"
          : raw_pair ?? "SOURCE_GAP";
  return { code, raw_pair, quote_live, bar_live };
}
