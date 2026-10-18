export type DataSourceName = "ROBINHOOD" | "FINNHUB" | "TRADIER";
export type DataSourceState = {
  source: DataSourceName;
  status: "LIVE" | "MARKET_CLOSED" | "STALE" | "DEGRADED" | "DATA_BLOCKED" | "NOT_CONFIGURED" | "NOT_VERIFIED" | "DISABLED_BACKUP";
  configured: boolean;
  authorization: "VALID" | "EXPIRED" | "NOT_CONFIGURED" | "NOT_VERIFIED" | "NOT_APPLICABLE";
  last_success_at: string | null;
  as_of: string | null;
  freshness_seconds: number | null;
  error: string | null;
  checked_at: string;
  capabilities: Record<string, boolean>;
};

export type MarketEvent = {
  event_id: string;
  event_fingerprint: string | null;
  kind: "NEWS" | "EARNINGS";
  title: string;
  source: string;
  source_url: string | null;
  published_at: string | null;
  scheduled_for: string | null;
  fetched_at: string;
  affected_symbols: string[];
  industry: string | null;
  event_type: string;
  novelty: "NEW";
  importance: "MARKET_MOVING" | "SCHEDULED" | "NOT_VERIFIED";
  event_evidence_state: "VERIFIED" | "PARTIAL" | "UNVERIFIED";
  earnings_result?: {
    session: "BMO" | "AMC" | "DMH" | "UNKNOWN";
    eps_actual: number | null;
    eps_estimate: number | null;
    revenue_actual: number | null;
    revenue_estimate: number | null;
    reported: boolean;
  };
};

export type CausalChain = {
  chain_id: string;
  event_fingerprint: string;
  event_category: string;
  what_happened: string;
  affected: string[];
  mechanism: string;
  expected_direction: string;
  expected_duration: string;
  supporting_evidence: Array<{ source: string; title: string; url: string | null; published_at: string | null }>;
  opposing_evidence: Array<{ source: string; summary: string }>;
  market_confirmation: "CONFIRMED" | "NOT_CONFIRMED" | "NOT_OBSERVED" | "CONTESTED";
  confidence: number | null;
  invalidation_condition: string;
  expires_at: string;
  evidence_state: "待验证假设";
  event_evidence_state: "VERIFIED" | "PARTIAL";
  updated_at: string;
};

export type MarketIntelligenceState = {
  eventCount: number;
  events: MarketEvent[];
  causalChains: CausalChain[];
  eventResponseReceivedAt?: Record<string, string | null>;
  currentEarnings?: MarketEvent[];
  earningsCalendar?: { checked_at: string; response_received_at: string; event_ids: string[] } | null;
};

export type MarketIntelligenceUpdate = {
  source: DataSourceState;
  events: Array<MarketEvent & { raw_json: string; raw_sha256: string; event_category: string | null; expires_at: string | null; response_received_at?: string | null }>;
};

const NEWS_SYMBOL_ALIASES: Record<string, readonly string[]> = {
  AAPL: ["apple", "aapl"], MSFT: ["microsoft"], GOOGL: ["google", "alphabet"], AMZN: ["amazon"], META: ["meta platforms", "facebook"],
  NVDA: ["nvidia"], AVGO: ["broadcom"], MRVL: ["marvell"], AMD: ["advanced micro devices"], ARM: ["arm holdings"], MU: ["micron"], ANET: ["arista networks"],
  DELL: ["dell technologies", "dell"], ORCL: ["oracle"], CRM: ["salesforce"], NOW: ["servicenow", "service now"], PLTR: ["palantir"], CRWV: ["coreweave"],
  PANW: ["palo alto networks"], CRWD: ["crowdstrike"], NET: ["cloudflare"], DDOG: ["datadog"], SNOW: ["snowflake"], POET: ["poet technologies"],
  RKLB: ["rocket lab"], ASTS: ["ast spacemobile"], LUNR: ["intuitive machines"], LMT: ["lockheed martin"], NOC: ["northrop grumman"], RTX: ["raytheon", "rtx corporation"],
  GD: ["general dynamics"], CEG: ["constellation energy"], VST: ["vistra"], GEV: ["ge vernova"], ETN: ["eaton"], PWR: ["quanta services"], OKLO: ["oklo"],
  SMR: ["nuscale"], CCJ: ["cameco"], ISRG: ["intuitive surgical"], TMO: ["thermo fisher"], VEEV: ["veeva"], TEM: ["tempus ai"], RXRX: ["recursion pharmaceuticals"],
  JPM: ["jpmorgan", "jp morgan"], WMT: ["walmart"], CAT: ["caterpillar"], XOM: ["exxon mobil", "exxon"], UBER: ["uber"], TSLA: ["tesla", "tsla"],
  MP: ["mp materials"], USAR: ["usa rare earth"], UUUU: ["energy fuels"], UAMY: ["united states antimony"], LAC: ["lithium americas"], FCX: ["freeport mcmoran"],
  CVX: ["chevron"], COP: ["conocophillips"], OXY: ["occidental petroleum"], SLB: ["schlumberger", "slb limited"], BKR: ["baker hughes"], LNG: ["cheniere energy"], KMI: ["kinder morgan"],
  UEC: ["uranium energy"], LEU: ["centrus energy"], BWXT: ["bwx technologies"], NRG: ["nrg energy"], VRT: ["vertiv"], HUBB: ["hubbell"], INTC: ["intel"],
};

export function inferNewsSymbols(title: string, related: readonly string[] = []) {
  const normalized = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const inferred = Object.entries(NEWS_SYMBOL_ALIASES).flatMap(([symbol, aliases]) => aliases.some((alias) => normalized.includes(` ${alias} `)) ? [symbol] : []);
  return [...new Set([...related.filter((symbol) => /^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)), ...inferred])];
}
