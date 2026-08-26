import type {
  LiquidityTrend,
  RiskAssessment,
  SetupDetection,
  StructureAnalysis,
  TradePlanResult,
  TradeStatusResult,
  VolumeAnalysis,
} from '../shared/types.js';

export interface TradeStatusInput {
  /** False when the address could not be resolved or no market data loaded. */
  hasMarketData: boolean;
  hasCandles: boolean;
  structure: StructureAnalysis | null;
  detections: SetupDetection[];
  plan: TradePlanResult;
  risk: RiskAssessment | null;
  liquidity: LiquidityTrend;
  volume: VolumeAnalysis;
  setupScore: number | null;
}

/**
 * Maps the analysis onto exactly one status.
 *
 * Order is deliberate and is the whole design: data availability first, then
 * hazard, then structure, then opportunity. A market can be technically perfect
 * and still return HIGH RISK, because a setup on a pool that is being drained is
 * not an opportunity.
 *
 * There is no BUY state. The app reports conditions; the person decides.
 */
export function resolveTradeStatus(input: TradeStatusInput): TradeStatusResult {
  const reasons: string[] = [];

  if (!input.hasMarketData) {
    return {
      status: 'DATA UNAVAILABLE',
      reasons: ['No market data could be retrieved for this token.'],
    };
  }
  if (!input.hasCandles || !input.structure) {
    return {
      status: 'DATA UNAVAILABLE',
      reasons: ['No price history could be retrieved, so no analysis is possible.'],
    };
  }

  // 1. Hazard gates. These override any technical picture.
  if (input.liquidity.highRisk) {
    reasons.push(input.liquidity.detail);
    return { status: 'HIGH RISK', reasons };
  }
  if (input.risk && input.risk.band === 'extreme') {
    reasons.push(`Risk score is ${input.risk.score}/100 (extreme).`);
    if (input.risk.warnings[0]) reasons.push(input.risk.warnings[0]);
    return { status: 'HIGH RISK', reasons };
  }

  // 2. Structure that invalidates long setups outright.
  if (input.structure.label === 'failed-breakout') {
    reasons.push('The most recent breakout failed — price closed back inside the range.');
    return { status: 'INVALIDATED', reasons };
  }
  if (input.structure.label === 'breakdown') {
    reasons.push('Price has broken down through its prior swing low.');
    return { status: 'INVALIDATED', reasons };
  }

  // 3. A live, tradable setup.
  if (input.detections.length > 0 && input.plan.available) {
    const detection = input.detections[0] as SetupDetection;
    reasons.push(`${detection.strategyName} conditions are satisfied on this timeframe.`);
    reasons.push(
      `Entry ${detection.entry.toPrecision(6)}, stop ${detection.stop.toPrecision(6)}, ${input.plan.rr.tp2.toFixed(2)}R to TP2.`,
    );
    if (input.volume.flag === 'bullish-confirmation') {
      reasons.push(input.volume.headline);
    } else if (input.volume.flag === 'warning') {
      // The setup's conditions genuinely are met, so the status stands - but a
      // rally on shrinking participation is the precursor to a failed breakout
      // and must not be left off the card.
      reasons.push(`${input.volume.headline} The setup conditions are met, but participation is not backing them.`);
    } else if (input.volume.flag === 'unavailable') {
      reasons.push('Volume confirmation could not be checked for this series.');
    }
    if (input.risk && (input.risk.band === 'high' || input.risk.band === 'elevated')) {
      reasons.push(`Risk score is ${input.risk.score}/100 (${input.risk.band}) — size accordingly.`);
    }
    return { status: 'ENTRY CONDITIONS MET', reasons };
  }

  // 4. A setup fired but produced no usable plan.
  if (input.detections.length > 0 && !input.plan.available) {
    reasons.push(`${input.detections[0]?.strategyName} fired, but ${input.plan.available ? '' : input.plan.reason}`);
    return { status: 'NO TRADE', reasons };
  }

  // 5. A breakout with no retest yet — the setup this app most wants you to wait for.
  if (input.structure.label === 'breakout' || input.structure.label === 'reclaim') {
    reasons.push(
      input.structure.label === 'breakout'
        ? 'Price has broken out but has not yet come back to test the level it broke.'
        : 'Price has reclaimed a level it lost, but has not yet retested it from above.',
    );
    reasons.push('Entering here means a stop far below; the retest is what makes the risk definable.');
    return { status: 'WAIT FOR RETEST', reasons };
  }

  // 6. Constructive but not yet actionable.
  if (
    input.structure.label === 'higher-highs-higher-lows' ||
    input.structure.label === 'consolidation'
  ) {
    reasons.push(
      input.structure.label === 'consolidation'
        ? 'Price is ranging. The edges are tradable; the middle is not.'
        : 'The uptrend structure is intact but no defined setup is triggering right now.',
    );
    if (input.setupScore !== null) reasons.push(`Setup score is ${input.setupScore}/100.`);
    return { status: 'SETUP FORMING', reasons };
  }

  if (input.structure.label === 'insufficient-data') {
    reasons.push('Not enough price history to classify structure on this timeframe.');
    return { status: 'DATA UNAVAILABLE', reasons };
  }

  reasons.push(`Structure is ${input.structure.label}; none of the defined setups apply.`);
  return { status: 'WATCH', reasons };
}

/** Percent move over the recent window that counts as "already moved". */
const CHASE_THRESHOLDS: { key: 'm5' | 'h1' | 'h6' | 'h24'; label: string; pct: number }[] = [
  { key: 'm5', label: '5 minutes', pct: 20 },
  { key: 'h1', label: '1 hour', pct: 35 },
  { key: 'h6', label: '6 hours', pct: 80 },
  { key: 'h24', label: '24 hours', pct: 150 },
];

/**
 * CHASING WARNING.
 *
 * Does not block anything - it requires acknowledgement. The distinction
 * matters: the app's job is to make sure you saw the move before you entered,
 * not to decide for you.
 */
export function assessChasing(
  priceChangePct: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>,
): {
  triggered: boolean;
  movePct: number | null;
  window: string | null;
  headline: string;
  message: string;
} {
  for (const threshold of CHASE_THRESHOLDS) {
    const move = priceChangePct[threshold.key];
    if (move !== undefined && Number.isFinite(move) && move >= threshold.pct) {
      return {
        triggered: true,
        movePct: move,
        window: threshold.label,
        headline: 'CHASING WARNING',
        message: `This asset has already moved substantially — up ${move.toFixed(1)}% in the last ${threshold.label}. Wait for a defined setup instead of entering because of momentum.`,
      };
    }
  }
  return {
    triggered: false,
    movePct: null,
    window: null,
    headline: '',
    message: 'No extreme recent move detected on the reported price-change windows.',
  };
}
