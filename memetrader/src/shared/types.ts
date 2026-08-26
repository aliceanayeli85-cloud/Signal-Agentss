/**
 * Domain vocabulary shared by the server, the analysis engine and the UI.
 *
 * A guiding rule runs through these types: anything that comes from outside the
 * process is optional. A missing field is represented as `null`/`undefined` and
 * surfaces in the UI as DATA UNAVAILABLE. Nothing in this codebase substitutes a
 * placeholder number for a value a provider did not return.
 */

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Minutes per timeframe bar. Used for ATR windows, pair-age checks and backtests. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

export type AssetClass = 'meme' | 'crypto' | 'stock';

/** A single OHLCV bar. `time` is a Unix timestamp in seconds at the bar OPEN. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Everything a provider was able to tell us about a tradable market.
 * Fields are nullable because provider coverage genuinely differs: DexScreener
 * has liquidity and transaction counts, Coinbase has neither.
 */
export interface MarketSnapshot {
  /** Stable id used across the app: `${provider}:${chain}:${address}` or `${provider}:${symbol}`. */
  id: string;
  provider: string;
  assetClass: AssetClass;
  symbol: string;
  name: string | null;
  chain: string | null;
  pairAddress: string | null;
  baseTokenAddress: string | null;
  quoteSymbol: string | null;
  dex: string | null;
  url: string | null;

  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;

  volume: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChangePct: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  txns: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>>;

  /** Unix ms when the pair was created, when the provider reports it. */
  pairCreatedAt: number | null;
  /** Unix ms when this snapshot was fetched from the provider. */
  fetchedAt: number;
}

/** Wraps any provider result so "we could not get this" is a first-class value. */
export type DataResult<T> =
  | { status: 'ok'; data: T; fetchedAt: number; source: string; stale?: boolean }
  | { status: 'unavailable'; reason: string; source: string; fetchedAt: number };

export type StructureLabel =
  | 'higher-highs-higher-lows'
  | 'lower-highs-lower-lows'
  | 'consolidation'
  | 'breakout'
  | 'breakdown'
  | 'reclaim'
  | 'failed-breakout'
  | 'insufficient-data';

export type Bias = 'bullish' | 'bearish' | 'neutral' | 'unknown';

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

export interface Level {
  price: number;
  kind: 'support' | 'resistance' | 'supply' | 'demand';
  /** How many swing points formed this level. More touches = more meaningful. */
  touches: number;
  firstTime: number;
  lastTime: number;
}

export interface LiquiditySweep {
  time: number;
  price: number;
  direction: 'above-highs' | 'below-lows';
  reclaimed: boolean;
}

export interface StructureAnalysis {
  label: StructureLabel;
  bias: Bias;
  swings: Swing[];
  levels: Level[];
  sweeps: LiquiditySweep[];
  notes: string[];
}

export interface ScoreFactor {
  key: string;
  label: string;
  /** Points contributed toward the score. */
  points: number;
  /** Maximum points this factor can contribute. */
  max: number;
  detail: string;
  /** False when the input data required for this factor was not available. */
  evaluated: boolean;
}

export interface SetupScore {
  /** 0-100. Counts satisfied preconditions. NOT a probability and NOT a forecast. */
  score: number;
  /** Portion of the 100 points that could actually be evaluated with available data. */
  evaluatedMax: number;
  factors: ScoreFactor[];
  reasons: string[];
  warnings: string[];
}

export interface RiskFactor {
  key: string;
  label: string;
  /** Points of RISK contributed (higher = riskier). */
  points: number;
  max: number;
  detail: string;
  evaluated: boolean;
}

export interface RiskAssessment {
  /** 0-100 where 100 is the most hazardous. NOT a probability of loss. */
  score: number;
  evaluatedMax: number;
  band: 'low' | 'moderate' | 'elevated' | 'high' | 'extreme';
  factors: RiskFactor[];
  warnings: string[];
  unavailable: string[];
}

export interface TradePlan {
  available: true;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  invalidation: number;
  invalidationReason: string;
  targets: { tp1: number; tp2: number; tp3: number };
  /** Reward-to-risk at each target, computed from entry/stop distance. */
  rr: { tp1: number; tp2: number; tp3: number };
  riskPerUnit: number;
  notes: string[];
}

export interface NoTradePlan {
  available: false;
  reason: string;
}

export type TradePlanResult = TradePlan | NoTradePlan;

export interface PositionSizing {
  available: true;
  /** The direction the size was computed for. */
  direction: 'long' | 'short';
  /** True when the direction was inferred from which side of entry the stop sits. */
  directionInferred: boolean;
  accountSize: number;
  riskPct: number;
  maxDollarRisk: number;
  /** Units of the asset (tokens/shares/coins). */
  positionSize: number;
  positionValue: number;
  potentialLoss: number;
  potentialProfit: number | null;
  rr: number | null;
  warnings: string[];
}

export interface NoPositionSizing {
  available: false;
  reason: string;
  warnings: string[];
}

export type PositionSizingResult = PositionSizing | NoPositionSizing;

export interface TimeframeView {
  timeframe: Timeframe;
  status: 'ok' | 'unavailable';
  reason?: string;
  bias: Bias;
  structure: StructureLabel;
  candleCount: number;
  lastClose: number | null;
}

export interface TimeframeAlignment {
  views: TimeframeView[];
  /** HIGH when the evaluated timeframes agree, MIXED when they conflict. */
  alignment: 'HIGH' | 'MODERATE' | 'MIXED' | 'UNKNOWN';
  dominantBias: Bias;
  detail: string;
}

export interface SetupDetection {
  strategy: StrategyId;
  strategyName: string;
  direction: 'long' | 'short';
  /** Index of the candle on which the setup triggered. */
  triggerIndex: number;
  triggerTime: number;
  entry: number;
  stop: number;
  invalidation: number;
  invalidationReason: string;
  /** Level that was broken/defended, drawn on the chart. */
  keyLevel: number | null;
  annotations: ChartAnnotation[];
  notes: string[];
}

export type StrategyId =
  | 'breakout-retest'
  | 'support-bounce'
  | 'trend-continuation'
  | 'range-breakout'
  | 'failed-breakout';

export interface ChartAnnotation {
  kind:
    | 'support'
    | 'resistance'
    | 'supply'
    | 'demand'
    | 'breakout'
    | 'retest'
    | 'confirmation'
    | 'liquidity-sweep'
    | 'entry'
    | 'stop'
    | 'tp1'
    | 'tp2'
    | 'tp3';
  label: string;
  /** Educational one-liner rendered next to the marker. */
  explain: string;
  price: number | null;
  time: number | null;
}

export interface AnalysisReport {
  snapshot: MarketSnapshot | null;
  timeframe: Timeframe;
  candles: Candle[];
  candleSource: string;
  structure: StructureAnalysis;
  alignment: TimeframeAlignment;
  detections: SetupDetection[];
  setupScore: SetupScore | null;
  risk: RiskAssessment | null;
  plan: TradePlanResult;
  annotations: ChartAnnotation[];
  indicators: {
    atr14: number | null;
    rsi14: number | null;
    vwapSession: number | null;
    relativeVolume: number | null;
    ema20: number | null;
    ema50: number | null;
    ema200: number | null;
  };
  dataNotes: string[];
  generatedAt: number;
}

export type PaperTradeStatus = 'open' | 'closed' | 'cancelled';

export interface PaperTradeRecord {
  id: number;
  createdAt: number;
  closedAt: number | null;
  status: PaperTradeStatus;
  assetId: string;
  symbol: string;
  assetClass: AssetClass;
  timeframe: Timeframe;
  strategy: string | null;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  positionSize: number;
  accountSize: number | null;
  riskPct: number | null;
  riskAmount: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  pnl: number | null;
  rMultiple: number | null;
  setupScore: number | null;
  riskScore: number | null;
  marketConditions: string | null;
  fomoFlagged: number;
  notes: string | null;
}

export interface JournalEntry {
  id: number;
  tradeId: number;
  createdAt: number;
  phase: 'pre' | 'post';
  /** Answers keyed by question id; see shared/journal-questions.ts. */
  answers: Record<string, string>;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
}

export interface PerformanceStats {
  sampleSize: number;
  confidence: 'NONE' | 'LOW' | 'MODERATE' | 'REASONABLE';
  confidenceNote: string;
  wins: number;
  losses: number;
  breakEven: number;
  winRatePct: number | null;
  averageWinner: number | null;
  averageLoser: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  averageR: number | null;
  medianR: number | null;
  maxDrawdownR: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  averageHoldingMinutes: number | null;
  totalPnl: number;
  byStrategy: GroupedPerformance[];
  byTimeframe: GroupedPerformance[];
  equityCurveR: { index: number; cumulativeR: number; time: number }[];
}

export interface GroupedPerformance {
  key: string;
  trades: number;
  winRatePct: number | null;
  averageR: number | null;
  expectancyR: number | null;
  totalR: number;
}

export interface BacktestConfig {
  assetId: string;
  symbol: string;
  timeframe: Timeframe;
  strategies: StrategyId[];
  /** Stop placement rule. */
  stopRule: 'structure' | 'atr';
  atrMultiple: number;
  /** Target placement rule, expressed in R. */
  targetR: number;
  riskPct: number;
  accountSize: number;
  feesPct: number;
  slippagePct: number;
  /** Fraction of the series reserved for in-sample (training) evaluation. */
  trainFraction: number;
  maxBarsInTrade: number;
}

export interface BacktestTrade {
  strategy: StrategyId;
  direction: 'long' | 'short';
  entryTime: number;
  entryIndex: number;
  entryPrice: number;
  stop: number;
  target: number;
  exitTime: number;
  exitIndex: number;
  exitPrice: number;
  exitReason: 'target' | 'stop' | 'time' | 'end-of-data';
  rMultiple: number;
  pnl: number;
  barsHeld: number;
  segment: 'in-sample' | 'out-of-sample';
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  averageReturnPct: number | null;
  averageR: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  sharpe: number | null;
  sharpeNote: string;
  largestWinR: number | null;
  largestLossR: number | null;
  longestLosingStreak: number;
  totalR: number;
  totalPnl: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  barsUsed: number;
  firstBarTime: number | null;
  lastBarTime: number | null;
  splitTime: number | null;
  trades: BacktestTrade[];
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
  combined: BacktestMetrics;
  warnings: string[];
  disclaimer: string;
}

export interface HistoricalSetupStats {
  matchingSetups: number;
  winRatePct: number | null;
  averageR: number | null;
  medianR: number | null;
  worstR: number | null;
  bestR: number | null;
  maxDrawdownR: number | null;
  distribution: { bucket: string; count: number }[];
  /** The mandated phrasing: an observed frequency, never a forward probability. */
  statement: string;
  sufficient: boolean;
}

export interface WatchlistItem {
  id: number;
  assetId: string;
  symbol: string;
  assetClass: AssetClass;
  chain: string | null;
  pairAddress: string | null;
  timeframe: Timeframe;
  status: 'WATCH' | 'SETUP FORMING' | 'ENTRY CONDITIONS MET' | 'INVALIDATED' | 'NO TRADE';
  note: string | null;
  createdAt: number;
}

export interface AlertRule {
  id: number;
  assetId: string;
  symbol: string;
  kind:
    | 'breakout'
    | 'retest'
    | 'volume-spike'
    | 'setup-score'
    | 'risk-warning'
    | 'price-level'
    | 'invalidation';
  threshold: number | null;
  direction: 'above' | 'below' | null;
  timeframe: Timeframe;
  enabled: number;
  createdAt: number;
  lastFiredAt: number | null;
  lastMessage: string | null;
}

export interface Settings {
  accountSize: number;
  defaultRiskPct: number;
  maxRiskPctPerTrade: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  maxConsecutiveLosses: number;
  simulationOverride: number;
}

export interface LimitState {
  locked: boolean;
  reasons: string[];
  tradesToday: number;
  dailyPnl: number;
  dailyLossPct: number;
  consecutiveLosses: number;
  overrideActive: boolean;
}

export interface FomoAssessment {
  triggered: boolean;
  flags: { key: string; label: string; detail: string }[];
  message: string;
}

export interface AiAnalysis {
  available: true;
  model: string;
  bullCase: { summary: string; requirements: string[] };
  bearCase: { summary: string; invalidations: string[] };
  neutralCase: { summary: string; implications: string[] };
  setupQuality: number;
  /** Evidence-completeness rating. Explicitly NOT a calibrated probability. */
  evidenceConfidence: 'low' | 'medium' | 'high';
  evidenceConfidenceReason: string;
  keyRisks: string[];
  missingData: string[];
  disclaimer: string;
  generatedAt: number;
}

export interface AiUnavailable {
  available: false;
  reason: string;
}

export type AiAnalysisResult = AiAnalysis | AiUnavailable;
