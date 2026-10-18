export type InvestmentProfileMode = "OWNER" | "BLANK";
export type InvestmentEvidenceLayer = "SYSTEM_PREDICTION" | "SYSTEM_DELIVERY" | "OWNER_OBSERVATION" | "OWNER_EXECUTION" | "BROKER_FILL";

export type OwnerInvestmentConstitution = {
  contract_kind: "OWNER_CONSTITUTION";
  contract_id: string;
  version: string;
  status: "ACTIVE";
  effective_at: string;
  change_reason: string;
  owner_profile_id: string;
  execution_mode: "SHADOW";
  broker_access: "READ_ONLY";
  automated_execution: false;
  principles: string[];
  evidence_layers: Record<InvestmentEvidenceLayer, string>;
};

export type StrategyPack = {
  contract_kind: "STRATEGY_PACK";
  contract_id: string;
  version: string;
  status: "ACTIVE";
  effective_at: string;
  change_reason: string;
  owner_profile_id: string;
  analysis_basis: "SPY";
  reference_index: "SPX";
  observation_products: ["SPX", "SPXW"];
  market_data_contract_version?: string;
  intraday_regime_contract_version?: string;
  convexity_ledger_contract_version?: string;
  owner_capital_context_id?: string;
  contract_identity_fields: string[];
  data_contract: Record<string, { requirement: string; unavailable_action: string }>;
  selection_contract: string[];
  lifecycle: string[];
  risk_contracts: string[];
  history_policy: string;
};

export type OwnerCapitalContext = {
  context_id: "OWNER_CAPITAL_CONTEXT";
  version: string;
  status: "ACTIVE";
  effective_at: string;
  change_reason: string;
  owner_profile_id: string;
  precision: "APPROXIMATE" | "EXACT";
  source: "OWNER_STATED";
  available_capital_usd: number;
  normal_premium_usd: { min: number; max: number; max_capital_pct: number };
  strong_opportunity_usd: { max: number; max_capital_pct: number };
  concentrated_capital_pct: number;
  base_contract_quantity: 1;
  automated_execution: false;
  reserve_cash_usd: "NOT_CONFIGURED" | number;
  daily_loss_limit_usd: "NOT_CONFIGURED" | number;
  portfolio_risk_limit_usd: "NOT_CONFIGURED" | number;
};

export type InvestmentContractSummary = {
  contract_id: string;
  version: string;
  status: "ACTIVE";
  effective_at: string;
  recorded_at: string;
  audit_sha256: string;
};

export type ActiveInvestmentContract<T extends OwnerInvestmentConstitution | StrategyPack> = InvestmentContractSummary & { contract: T };

export type InvestmentKernelContext = {
  profile_id: string;
  profile_mode: InvestmentProfileMode;
  status: "ACTIVE" | "NOT_CONFIGURED";
  execution_mode: "SHADOW";
  broker_access: "READ_ONLY";
  automated_execution: false;
  constitution: ActiveInvestmentContract<OwnerInvestmentConstitution> | null;
  active_strategy_packs: Array<ActiveInvestmentContract<StrategyPack>>;
  capital_context: (InvestmentContractSummary & { context: OwnerCapitalContext }) | null;
};

export type SpxAutomaticSelection = {
  rule: "SPXW_PAPER_7_30_V1";
  regime_event_id: string;
  created_from: "NATURAL_A1_HEARTBEAT";
  observed_at: string;
};

export type FrozenStrategyContext = {
  registered_at: string;
  owner_profile_id: string;
  constitution: Pick<InvestmentContractSummary, "contract_id" | "version" | "audit_sha256">;
  strategy_pack: Pick<InvestmentContractSummary, "contract_id" | "version" | "audit_sha256">;
  contract_identity: {
    contract_id: string;
    chain_id: string;
    chain_symbol: "SPX" | "SPXW";
    settlement: "AM" | "PM";
    expiration_date: string;
    strike: number;
    option_type: "call" | "put";
    contract_multiplier: number;
    multiplier_source: "ROBINHOOD_CONTRACT_METADATA" | "CBOE_SPX_CONTRACT_SPEC";
  };
  signal_source: {
    source_mode: "OWNER_OBSERVED" | "SYSTEM_PREDICTION" | "SYSTEM_SIMULATED_RESEARCH";
    selection?: SpxAutomaticSelection;
    forecast_run_id: string | null;
    forecast_source_mode: "LIVE" | "REPLAY" | null;
    forecast_eligibility: "OFFICIAL_LIVE" | "EXCLUDED_REPLAY" | "EXCLUDED_NON_LIVE" | null;
    delivery_evidence: "NOT_LINKED";
  };
  evidence: Record<InvestmentEvidenceLayer, "RECORDED" | "LINKED" | "NOT_LINKED" | "NOT_REPORTED" | "NOT_OBSERVED" | "READONLY_POSITION_OBSERVED">;
  data_quality: {
    analysis_mode?: "SPY_PROXY" | "SPX_DIRECT";
    market_data_contract_version?: string;
    spy_structure: "PROXY_BASIS";
    spx_spot: "DATA_BLOCKED";
    spx_kline: "DATA_BLOCKED";
    option_chain: "ROBINHOOD_OFFICIAL_READONLY";
    option_quote: "LIVE" | "MARKET_CLOSED" | "DATA_BLOCKED";
    automatic_spx_levels: "DATA_BLOCKED";
  };
};

export const OWNER_CONSTITUTION_V1: OwnerInvestmentConstitution = {
  contract_kind: "OWNER_CONSTITUTION",
  contract_id: "OWNER_INVESTMENT_CONSTITUTION",
  version: "1.0.0",
  status: "ACTIVE",
  effective_at: "2026-08-21T00:00:00.000Z",
  change_reason: "A1.1首次建立可版本化Owner投资方法内核；不回填旧判断。",
  owner_profile_id: "OWNER_PRIMARY",
  execution_mode: "SHADOW",
  broker_access: "READ_ONLY",
  automated_execution: false,
  principles: [
    "原始预测、送达、Owner观察、Owner执行和Broker成交是五层独立证据，不互相推定。",
    "没有Broker成交证据不得生成真实持仓、投入、收益或正式胜率。",
    "缺失市场数据必须降级或DATA_BLOCKED，不用估算值冒充真实行情。",
    "策略版本在登记时冻结；新版本不得覆盖旧判断或历史证据。",
  ],
  evidence_layers: {
    SYSTEM_PREDICTION: "系统形成的原始预测；不证明已经送达、被Owner观察、执行或成交。",
    SYSTEM_DELIVERY: "系统对预测的真实送达证据；不证明Owner观察、执行或成交。",
    OWNER_OBSERVATION: "Owner明确建立或登记观察；不等于执行或成交。",
    OWNER_EXECUTION: "Owner明确报告采取行动；在Broker成交留证前不等于真实成交。",
    BROKER_FILL: "只读Broker成交或持仓证据；只有这一层可支持真实持仓和收益核算。",
  },
};

export const SPX_FOLLOW_V1: StrategyPack = {
  contract_kind: "STRATEGY_PACK",
  contract_id: "SPX_FOLLOW",
  version: "1.0.0",
  status: "ACTIVE",
  effective_at: "2026-08-21T00:00:00.000Z",
  change_reason: "A1.1首次把SPX/SPXW跟单、数据质量与证据边界收口为单一策略合同。",
  owner_profile_id: "OWNER_PRIMARY",
  analysis_basis: "SPY",
  reference_index: "SPX",
  observation_products: ["SPX", "SPXW"],
  contract_identity_fields: ["contract_id", "chain_id", "chain_symbol", "settlement", "expiration_date", "strike", "option_type"],
  data_contract: {
    SPY_5M_STRUCTURE: { requirement: "现有Robinhood官方只读SPY 5分钟结构合同", unavailable_action: "DATA_BLOCKED，不形成自动结构确认" },
    SPX_SPOT: { requirement: "正式授权的真实SPX现货", unavailable_action: "DATA_BLOCKED，不使用SPY乘数或期权价格推算" },
    SPX_KLINE: { requirement: "正式授权的真实SPX K线", unavailable_action: "DATA_BLOCKED，不生成替代K线" },
    SPX_OPTION_CHAIN: { requirement: "Robinhood官方只读SPX/SPXW链与精确合约身份", unavailable_action: "DATA_BLOCKED，不创建或改选合约" },
    SPX_OPTION_QUOTE: { requirement: "Robinhood官方只读Bid/Ask/Mark及时间戳", unavailable_action: "观测单保留，报价证据标记DATA_BLOCKED" },
  },
  selection_contract: [
    "Owner按SPX或SPXW、AM或PM、到期日、Strike和Put或Call手动选择精确合约。",
    "SPX标准链必须为AM结算；SPXW必须为PM结算。",
    "没有真实SPX现货时不得自动标记ATM、ITM、OTM或最近平值。",
  ],
  lifecycle: ["CREATED", "OBSERVING", "TRIGGER_SNAPSHOT", "DATA_BLOCKED", "ENDED", "SETTLEMENT_NOT_APPLICABLE_WITHOUT_BROKER_FILL"],
  risk_contracts: ["EXISTING_DTE_GATE", "EXISTING_IV_SKEW_TERM_IV_CRUSH", "EXISTING_FOUR_LAYER_RISK", "EXISTING_OWNER_TRIGGER"],
  history_policy: "创建时冻结策略与合约身份；仅通过追加事件推进观测，不复用、更新或回填旧观测单。",
};

export const SPX_FOLLOW_V1_1: StrategyPack = {
  ...SPX_FOLLOW_V1,
  version: "1.1.0",
  effective_at: "2026-08-21T23:38:45.213Z",
  change_reason: "A1.2增加真实SPX数据合同、连续日内盘型、趋势重新资格和参与窗口；不重写1.0.0历史。",
  market_data_contract_version: "SPX_MARKET_DATA_V1@1.0.0",
  intraday_regime_contract_version: "OWNER_INTRADAY_REGIME_CONTEXT@v1",
  data_contract: {
    ...SPX_FOLLOW_V1.data_contract,
    SPX_MARKET_DATA_CONTRACT: { requirement: "SPX_MARKET_DATA_V1同时证明真实指数身份、非推算、市场时间、Session、新鲜度和真实5分钟OHLC", unavailable_action: "继续SPY_PROXY并明确DATA_BLOCKED；不生成SPX点位、VWAP、支撑压力、Strike距离或ATM判断" },
    INTRADAY_REGIME_CONTEXT: { requirement: "同一交易日连续追加的SPY/QQQ真实5分钟盘型与参与窗口证据", unavailable_action: "不继承旧槽结论；等待新鲜自然证据重新取得资格" },
  },
  lifecycle: [...SPX_FOLLOW_V1.lifecycle, "TREND_REQUALIFIED", "PARTICIPATION_WINDOW_OPEN", "PARTICIPATION_WINDOW_CLOSED"],
};

// Capital and risk limits are supplied by each local user; no personal defaults are distributed.

export const SPX_FOLLOW_V1_2: StrategyPack = {
  ...SPX_FOLLOW_V1_1,
  version: "1.2.0",
  effective_at: SPX_FOLLOW_V1_1.effective_at,
  change_reason: "A1.3增加当时冻结的SPX期权凸性机会账本、Ask/Bid可执行测量和版本化Owner本金适配；不改写1.0.0或1.1.0历史。",
  convexity_ledger_contract_version: "SPX_CONVEXITY_LEDGER_V1@1.0.0",
  owner_capital_context_id: "OWNER_CAPITAL_CONTEXT@1.0.0",
  contract_identity_fields: [...SPX_FOLLOW_V1_1.contract_identity_fields, "contract_multiplier", "multiplier_source"],
  data_contract: {
    ...SPX_FOLLOW_V1_1.data_contract,
    CONVEXITY_EXECUTABLE_BBO: { requirement: "候选冻结后、系统确认后参与窗口内的新鲜真实Ask/Bid；Mark只作观察", unavailable_action: "EXECUTABLE_MULTIPLE_UNVERIFIED，不用Mark、收盘价或内在价值补造" },
    OWNER_CAPITAL_CONTEXT: { requirement: "带版本、生效时间、来源和金额精度的Owner本金上下文", unavailable_action: "OWNER_RISK_LIMIT_UNCONFIGURED或DATA_BLOCKED；不自动产生仓位建议" },
  },
  selection_contract: [
    ...SPX_FOLLOW_V1_1.selection_contract,
    "只冻结当时已由Owner精确选择、可持续记录报价的本地观测合约；真实持仓只有建立本地观测身份后才进入候选。没有真实SPX现货时不自动寻找更远虚值合约。",
    "所有冻结集合均进入机会分母；允许没有合格合约。",
  ],
  lifecycle: [...SPX_FOLLOW_V1_1.lifecycle, "CONVEXITY_CANDIDATES_FROZEN", "EXECUTABLE_WINDOW_MEASURED", "EXCLUDED_RESEARCH_REVIEW"],
};

export const SPX_FOLLOW_V1_3: StrategyPack = {
  ...SPX_FOLLOW_V1_2,
  version: "1.3.0",
  effective_at: "2026-09-12T07:36:00.000Z",
  change_reason: "Owner授权在自然盘型形成方向后自动建立7–30DTE的SPXW系统模拟研究观察；保留人工观察及所有旧版本，不回填旧机会。",
  selection_contract: [
    ...SPX_FOLLOW_V1.selection_contract,
    "系统可依据当前自然SPY代理盘型，按SPXW_PAPER_7_30_V1选择7–30DTE、方向一致且有新鲜真实双边报价的SPXW PM合约；仅为系统模拟研究观察，不代表Owner观察、真实执行或风险审批通过。",
    "系统选择按真实期权Delta与Ask/Bid筛选，不从SPY代理或期权价格推算SPX点位、价内外或最近平值；仍执行原有资金和风险门禁。",
    "系统来源与自然盘型事件身份在创建时冻结；同方向旧自动观察持续跟踪至结束，同交易日同方向最多新建一张；没有合格真实合约时记录原因。",
    "所有冻结集合均进入机会分母；允许没有合格合约，不补造报价、收益、成交或历史候选。",
    "当前研究关注优先SPY/QQQ，SPXW自动观察为辅助；不得因SPX研究阻塞SPY/QQQ主链或把DC建议当系统审批。",
  ],
};

export function emptyInvestmentKernel(profileMode: InvestmentProfileMode): InvestmentKernelContext {
  return {
    profile_id: profileMode === "OWNER" ? "OWNER_PRIMARY" : "LOCAL_UNCONFIGURED",
    profile_mode: profileMode,
    status: "NOT_CONFIGURED",
    execution_mode: "SHADOW",
    broker_access: "READ_ONLY",
    automated_execution: false,
    constitution: null,
    active_strategy_packs: [],
    capital_context: null,
  };
}
