export const EXTERNAL_EXPERT_STATUSES = ["OPEN", "PARTIAL_EXIT", "CLOSED", "INVALIDATED", "EXPIRED", "RECAP_ONLY"] as const;
export const EXTERNAL_EXPERT_REALTIME = ["LIVE", "DELAYED", "LATE_RECAP", "OFFLINE_RECAP"] as const;
export const EXTERNAL_EXPERT_ORIGINAL_CLASSIFICATIONS = ["LIVE", "LATE", "RECAP"] as const;
export const EXTERNAL_EXPERT_CLASSIFICATION_MAP = { LIVE: "LIVE", LATE: "DELAYED", RECAP: "LATE_RECAP" } as const;
export const EXTERNAL_EXPERT_EVENT_TYPES = ["NEW_SIGNAL", "ADD", "REDUCE", "HOLD", "EXIT", "STOP", "VIEW_CHANGE", "OWNER_EXECUTION", "TS_COMPARISON", "MARKET_UPDATE", "RECAP"] as const;
export const EXTERNAL_EXPERT_WAIT_CLASSES = ["HARD_DATA_BLOCK", "MODEL_EVIDENCE_INSUFFICIENT", "EVIDENCE_CONFLICT", "STALE_OR_EXPIRED", "DELIVERY_OR_OWNERSHIP_FAILURE", "STATE_OR_ENGINEERING_BLOCK", "POSSIBLE_OVERBLOCK", "NOT_APPLICABLE", "UNKNOWN"] as const;
export const EXTERNAL_EXPERT_CONCLUSIONS = ["TS正确等待", "TS等待合理，但输出无用", "TS方向正确，正式确认过晚", "TS疑似错误WAIT", "TS被工程问题阻断", "TS被数据问题阻断", "TS完全漏判", "外部专家信号失败，TS等待避免损失", "Owner执行偏差导致结果不同", "证据不足"] as const;

export type ExternalExpertStatus = typeof EXTERNAL_EXPERT_STATUSES[number];
export type ExternalExpertRealtime = typeof EXTERNAL_EXPERT_REALTIME[number];
export type ExternalExpertOriginalClassification = typeof EXTERNAL_EXPERT_ORIGINAL_CLASSIFICATIONS[number];
export type ExternalExpertEventType = typeof EXTERNAL_EXPERT_EVENT_TYPES[number];
export type ExternalExpertWaitClass = typeof EXTERNAL_EXPERT_WAIT_CLASSES[number];
export type ExternalExpertConclusion = typeof EXTERNAL_EXPERT_CONCLUSIONS[number];
export type ExternalExpertFacts = Record<string, unknown>;

export type ExternalExpertEventInput = {
  case_id?: string;
  event_id?: string;
  event_type: ExternalExpertEventType;
  status?: ExternalExpertStatus;
  realtime_class: ExternalExpertRealtime;
  original_classification?: ExternalExpertOriginalClassification | null;
  received_at?: string;
  source_published_at?: string | null;
  raw_text?: string | null;
  expert?: ExternalExpertFacts | null;
  owner?: ExternalExpertFacts | null;
  ts?: ExternalExpertFacts | null;
  market?: ExternalExpertFacts | null;
  recap?: ExternalExpertFacts | null;
};

export type ExternalExpertEvidence = {
  evidence_id: string;
  kind: "SCREENSHOT" | "DOCUMENT";
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  url: string;
};

export type ExternalExpertEvent = Required<Pick<ExternalExpertEventInput, "event_type" | "realtime_class">> & {
  event_id: string;
  case_id: string;
  status: ExternalExpertStatus;
  original_classification: ExternalExpertOriginalClassification | null;
  received_at: string;
  source_published_at: string | null;
  raw_text: string | null;
  expert: ExternalExpertFacts | null;
  owner: ExternalExpertFacts | null;
  ts: ExternalExpertFacts | null;
  market: ExternalExpertFacts | null;
  recap: ExternalExpertFacts | null;
  evidence: ExternalExpertEvidence[];
};

export type ExternalExpertCase = {
  case_id: string;
  created_at: string;
  updated_at: string;
  status: ExternalExpertStatus;
  realtime_class: ExternalExpertRealtime;
  original_classification: ExternalExpertOriginalClassification | null;
  source: string | null;
  symbol: string | null;
  direction: string | null;
  instrument: string | null;
  wait_classification: ExternalExpertWaitClass | null;
  conclusion: ExternalExpertConclusion | null;
  signal_outcome: string | null;
  ts_comparable: boolean;
  expert: ExternalExpertFacts;
  owner: ExternalExpertFacts;
  ts: ExternalExpertFacts;
  market: ExternalExpertFacts;
  recap: ExternalExpertFacts;
  events: ExternalExpertEvent[];
};

export type ExternalExpertOverview = {
  contract_version: "EXTERNAL_EXPERT_OBSERVER_V1";
  source_mode: "EXTERNAL_EXPERT_RESEARCH";
  statistical_eligibility: "EXCLUDED_FROM_TS_FORWARD_AND_V2_SETTLEMENT";
  automated_execution: false;
  case_count: number;
  open_count: number;
  realtime: Record<ExternalExpertRealtime, number>;
  original_classifications: Record<ExternalExpertOriginalClassification, number>;
  wait_classifications: Partial<Record<ExternalExpertWaitClass, number>>;
  conclusions: Partial<Record<ExternalExpertConclusion, number>>;
  outcomes: Record<string, number>;
  ts_comparable_count: number;
  cases: ExternalExpertCase[];
};

export function emptyExternalExpertOverview(): ExternalExpertOverview {
  return {
    contract_version: "EXTERNAL_EXPERT_OBSERVER_V1",
    source_mode: "EXTERNAL_EXPERT_RESEARCH",
    statistical_eligibility: "EXCLUDED_FROM_TS_FORWARD_AND_V2_SETTLEMENT",
    automated_execution: false,
    case_count: 0,
    open_count: 0,
    realtime: { LIVE: 0, DELAYED: 0, LATE_RECAP: 0, OFFLINE_RECAP: 0 },
    original_classifications: { LIVE: 0, LATE: 0, RECAP: 0 },
    wait_classifications: {}, conclusions: {}, outcomes: {}, ts_comparable_count: 0, cases: [],
  };
}

function record(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const result = value as ExternalExpertFacts;
  if (JSON.stringify(result).length > 50_000) throw new Error(`${label}超过50000字符`);
  return result;
}

function optionalText(value: unknown, label: string, maximum: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${label}必须是字符串且不超过${maximum}字符`);
  return value;
}

function iso(value: unknown, label: string, fallback?: string) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) throw new Error(`${label}必须是有效时间`);
  return new Date(candidate).toISOString();
}

export function normalizeExternalExpertEvent(value: unknown, now = new Date()): ExternalExpertEventInput & { original_classification: ExternalExpertOriginalClassification | null; received_at: string; source_published_at: string | null; raw_text: string | null; expert: ExternalExpertFacts | null; owner: ExternalExpertFacts | null; ts: ExternalExpertFacts | null; market: ExternalExpertFacts | null; recap: ExternalExpertFacts | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("外部专家事件必须是对象");
  const input = value as Record<string, unknown>;
  const eventType = input.event_type as ExternalExpertEventType, realtime = input.realtime_class as ExternalExpertRealtime;
  if (!EXTERNAL_EXPERT_EVENT_TYPES.includes(eventType)) throw new Error("event_type无效");
  if (!EXTERNAL_EXPERT_REALTIME.includes(realtime)) throw new Error("realtime_class无效");
  if (input.status !== undefined && !EXTERNAL_EXPERT_STATUSES.includes(input.status as ExternalExpertStatus)) throw new Error("status无效");
  const caseId = optionalText(input.case_id, "case_id", 40), eventId = optionalText(input.event_id, "event_id", 120);
  if (caseId && !/^(?:TSX-\d{8}-\d{3,6}|EXT-[A-Z0-9]{1,10}-\d{8}-\d{6}-[A-Z0-9]{2,12}-[A-Z0-9]{2,12}-\d{2})$/.test(caseId)) throw new Error("case_id格式无效");
  if (eventId && !/^[A-Za-z0-9][A-Za-z0-9:._-]{5,119}$/.test(eventId)) throw new Error("event_id格式无效");
  if (!caseId && eventType !== "NEW_SIGNAL") throw new Error("新案例必须使用NEW_SIGNAL；后续更新必须提供case_id");
  const originalClassification = optionalText(input.original_classification, "original_classification", 10) as ExternalExpertOriginalClassification | null;
  if (originalClassification && !EXTERNAL_EXPERT_ORIGINAL_CLASSIFICATIONS.includes(originalClassification)) throw new Error("original_classification无效");
  if (originalClassification && eventType !== "NEW_SIGNAL") throw new Error("original_classification只允许在NEW_SIGNAL登记");
  if (caseId?.startsWith("EXT-") && eventType === "NEW_SIGNAL" && !originalClassification) throw new Error("EXT案例必须保留original_classification");
  if (originalClassification && realtime !== EXTERNAL_EXPERT_CLASSIFICATION_MAP[originalClassification]) throw new Error(`original_classification=${originalClassification}必须映射为${EXTERNAL_EXPERT_CLASSIFICATION_MAP[originalClassification]}`);
  const expert = record(input.expert, "expert"), owner = record(input.owner, "owner"), ts = record(input.ts, "ts"), market = record(input.market, "market"), recap = record(input.recap, "recap"), rawText = optionalText(input.raw_text, "raw_text", 20_000);
  if (!rawText && !expert && !owner && !ts && !market && !recap) throw new Error("事件必须保留原话或至少一层事实");
  const waitClass = ts?.wait_classification;
  if (waitClass !== undefined && !EXTERNAL_EXPERT_WAIT_CLASSES.includes(waitClass as ExternalExpertWaitClass)) throw new Error("ts.wait_classification无效");
  const conclusion = recap?.conclusion;
  if (conclusion !== undefined && !EXTERNAL_EXPERT_CONCLUSIONS.includes(conclusion as ExternalExpertConclusion)) throw new Error("recap.conclusion无效");
  return {
    ...(caseId ? { case_id: caseId } : {}), ...(eventId ? { event_id: eventId } : {}), event_type: eventType,
    ...(input.status ? { status: input.status as ExternalExpertStatus } : {}), realtime_class: realtime, original_classification: originalClassification,
    received_at: iso(input.received_at, "received_at", now.toISOString()),
    source_published_at: input.source_published_at ? iso(input.source_published_at, "source_published_at") : null,
    raw_text: rawText, expert, owner, ts, market, recap,
  };
}
