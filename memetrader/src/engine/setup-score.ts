import type {
  Candle,
  LiquidityTrend,
  MarketSnapshot,
  MomentumAnalysis,
  ScoreFactor,
  SetupDetection,
  SetupScore,
  StructureAnalysis,
  TimeframeAlignment,
  TradePlanResult,
  VolumeAnalysis,
} from '../shared/types.js';
import { rsi } from './indicators.js';
import { analyseVolume } from './volume.js';

export interface SetupScoreInput {
  detection: SetupDetection;
  candles: Candle[];
  structure: StructureAnalysis;
  alignment: TimeframeAlignment;
  plan: TradePlanResult;
  snapshot: MarketSnapshot | null;
  /** Precomputed to avoid duplicate work; derived from the candles when omitted. */
  volume?: VolumeAnalysis;
  momentum?: MomentumAnalysis;
  liquidity?: LiquidityTrend;
}

/**
 * SETUP SCORE - a checklist total out of 100, not a forecast.
 *
 * Seven weighted categories:
 *   Market structure 20 | Volume 20 | Momentum 15 | Liquidity 15
 *   Support/resistance 10 | Risk/reward 10 | Multi-timeframe alignment 10
 *
 * Within a category, a sub-check whose data is missing reduces that category's
 * `evaluatedMax` instead of scoring zero. The published score is
 * earned / total-evaluatable, scaled to 100, and every category carries the
 * individual reasons behind its points.
 */
export function scoreSetup(input: SetupScoreInput): SetupScore {
  const { detection, candles, structure, alignment, plan, snapshot } = input;
  const volume = input.volume ?? analyseVolume(candles, snapshot);
  const factors: ScoreFactor[] = [
    scoreStructure(detection, structure),
    scoreVolume(volume),
    scoreMomentum(detection, candles, input.momentum),
    scoreLiquidity(snapshot, input.liquidity),
    scoreLevels(detection, structure),
    scoreRiskReward(plan),
    scoreAlignment(detection, alignment),
  ];

  const reasons: string[] = [];
  const warnings: string[] = [];

  const evaluatedMax = factors.reduce((acc, f) => acc + f.evaluatedMax, 0);
  const earned = factors.reduce((acc, f) => acc + f.points, 0);
  const score = evaluatedMax > 0 ? Math.round((earned / evaluatedMax) * 100) : 0;

  // Positives worth surfacing at the top of the panel.
  if (structure.bias === directionBias(detection) && structure.label !== 'insufficient-data') {
    reasons.push(readableStructure(structure.label));
  }
  if (volume.flag === 'bullish-confirmation') reasons.push('Volume confirms the price expansion');
  if (detection.annotations.some((a) => a.kind === 'retest')) {
    reasons.push('Successful retest of the broken level');
  }
  if (plan.available && plan.rr.tp2 >= 2) {
    reasons.push(`${plan.rr.tp2.toFixed(1)}R potential reward at TP2`);
  }
  if (alignment.alignment === 'HIGH' && alignment.dominantBias === directionBias(detection)) {
    reasons.push('Higher timeframes agree with the trade direction');
  }

  // Warnings.
  if (structure.bias !== 'neutral' && structure.bias !== directionBias(detection) && structure.label !== 'insufficient-data') {
    warnings.push('Trade direction conflicts with the current market structure on this timeframe.');
  }
  if (volume.flag === 'warning') warnings.push(volume.headline);
  if (volume.flag === 'unavailable') {
    warnings.push('Volume confirmation could not be checked: this series carried no usable volume.');
  }
  if (alignment.alignment === 'MIXED') {
    warnings.push('Timeframes conflict — the higher timeframe does not support this direction.');
  }
  if (plan.available && plan.rr.tp1 < 1) {
    warnings.push(
      `TP1 is only ${plan.rr.tp1.toFixed(2)}R — you would need to win well over half the time just to break even.`,
    );
  }
  if (input.liquidity?.highRisk) warnings.push(input.liquidity.detail);
  if (evaluatedMax < 60) {
    warnings.push(
      `Only ${evaluatedMax} of 100 checklist points could be evaluated with the data available — treat this score as provisional.`,
    );
  }

  return { score, evaluatedMax, factors, reasons, warnings };
}

function directionBias(detection: SetupDetection): 'bullish' | 'bearish' {
  return detection.direction === 'long' ? 'bullish' : 'bearish';
}

// --- Market structure /20 ---------------------------------------------------
function scoreStructure(detection: SetupDetection, structure: StructureAnalysis): ScoreFactor {
  const subReasons: string[] = [];
  let points = 0;
  let evaluatedMax = 0;

  // Structure agreement, worth 12.
  if (structure.label === 'insufficient-data') {
    subReasons.push('Structure classification: NOT EVALUATED — not enough bars.');
  } else {
    evaluatedMax += 12;
    const wanted = directionBias(detection);
    if (structure.bias === wanted) {
      points += 12;
      subReasons.push(`+12/12 structure is ${structure.label}, pointing the same way as the trade.`);
    } else if (structure.bias === 'neutral') {
      points += 5;
      subReasons.push('+5/12 structure is range-bound — neither supports nor contradicts the direction.');
    } else {
      subReasons.push(`+0/12 structure is ${structure.label}, which points against the trade.`);
    }
  }

  // Breakout / retest quality, worth 8.
  const hasBreakout = detection.annotations.some((a) => a.kind === 'breakout');
  const hasRetest = detection.annotations.some((a) => a.kind === 'retest');
  const hasConfirmation = detection.annotations.some((a) => a.kind === 'confirmation');
  if (!hasBreakout && !hasRetest) {
    subReasons.push('Breakout/retest quality: NOT EVALUATED — this setup involves neither.');
  } else {
    evaluatedMax += 8;
    if (hasBreakout && hasRetest && hasConfirmation) {
      points += 8;
      subReasons.push('+8/8 breakout, retest and a confirming close are all present.');
    } else if (hasRetest && hasConfirmation) {
      points += 6;
      subReasons.push('+6/8 retest with a confirming close.');
    } else if (hasBreakout && hasConfirmation) {
      points += 5;
      subReasons.push('+5/8 breakout with a confirming close, but no retest yet.');
    } else {
      points += 2;
      subReasons.push('+2/8 the pattern is present but unconfirmed.');
    }
  }

  return {
    key: 'structure',
    label: 'Market structure',
    points,
    max: 20,
    evaluatedMax,
    detail: structure.label === 'insufficient-data' ? 'Insufficient bars to classify structure.' : structure.label,
    subReasons,
    evaluated: evaluatedMax > 0,
  };
}

// --- Volume /20 -------------------------------------------------------------
function scoreVolume(volume: VolumeAnalysis): ScoreFactor {
  const subReasons: string[] = [];
  let points = 0;
  let evaluatedMax = 0;

  if (volume.flag === 'unavailable') {
    return {
      key: 'volume',
      label: 'Volume',
      points: 0,
      max: 20,
      evaluatedMax: 0,
      detail: volume.headline,
      subReasons: volume.reasons,
      evaluated: false,
    };
  }

  // Relative volume, worth 8.
  if (volume.relativeVolume === null) {
    subReasons.push('Relative volume: NOT EVALUATED.');
  } else {
    evaluatedMax += 8;
    const rv = volume.relativeVolume;
    const earned = rv >= 2 ? 8 : rv >= 1.5 ? 6 : rv >= 1 ? 3 : 0;
    points += earned;
    subReasons.push(`+${earned}/8 current bar is ${rv.toFixed(2)}x the 20-bar average volume.`);
  }

  // Trend / acceleration, worth 7.
  if (volume.trend === 'unavailable') {
    subReasons.push('Volume trend: NOT EVALUATED.');
  } else {
    evaluatedMax += 7;
    const earned = volume.trend === 'expanding' ? 7 : volume.trend === 'steady' ? 4 : 0;
    points += earned;
    subReasons.push(`+${earned}/7 participation is ${volume.trend}.`);
  }

  // Price/volume agreement, worth 5.
  if (volume.priceVolumeDivergence === null) {
    subReasons.push('Price/volume divergence: NOT EVALUATED.');
  } else {
    evaluatedMax += 5;
    const earned = volume.priceVolumeDivergence > 0 ? 5 : volume.priceVolumeDivergence === 0 ? 2 : 0;
    points += earned;
    subReasons.push(
      earned === 5
        ? '+5/5 price and volume are moving together.'
        : `+${earned}/5 price and volume are diverging — ${volume.headline}`,
    );
  }

  return {
    key: 'volume',
    label: 'Volume',
    points,
    max: 20,
    evaluatedMax,
    detail: volume.headline,
    subReasons,
    evaluated: evaluatedMax > 0,
  };
}

// --- Momentum /15 -----------------------------------------------------------
function scoreMomentum(
  detection: SetupDetection,
  candles: Candle[],
  momentum: MomentumAnalysis | undefined,
): ScoreFactor {
  const subReasons: string[] = [];
  let points = 0;
  let evaluatedMax = 0;

  // RSI, worth 8.
  const value = rsi(candles.map((c) => c.close), 14);
  if (value === null) {
    subReasons.push('RSI(14): NOT EVALUATED — not enough bars.');
  } else {
    evaluatedMax += 8;
    let earned: number;
    if (detection.direction === 'long') {
      earned = value >= 55 && value <= 72 ? 8 : value > 72 ? 2 : value >= 45 ? 5 : 1;
    } else {
      earned = value <= 45 && value >= 28 ? 8 : value < 28 ? 2 : value <= 55 ? 5 : 1;
    }
    points += earned;
    subReasons.push(
      `+${earned}/8 RSI(14) is ${value.toFixed(1)}${value > 72 ? ' — already extended, entering here is buying after the move' : ''}.`,
    );
  }

  // Multi-timeframe momentum agreement, worth 7.
  if (!momentum || momentum.evaluated === 0 || momentum.bias === 'unknown') {
    subReasons.push('Multi-timeframe momentum: NOT EVALUATED — no timeframe had enough history.');
  } else {
    evaluatedMax += 7;
    const wanted = directionBias(detection);
    const earned = momentum.bias === wanted ? 7 : momentum.bias === 'neutral' ? 3 : 0;
    points += earned;
    subReasons.push(`+${earned}/7 ${momentum.detail}`);
  }

  return {
    key: 'momentum',
    label: 'Momentum',
    points,
    max: 15,
    evaluatedMax,
    detail: momentum?.detail ?? 'Measured from RSI only.',
    subReasons,
    evaluated: evaluatedMax > 0,
  };
}

// --- Liquidity /15 ----------------------------------------------------------
function scoreLiquidity(
  snapshot: MarketSnapshot | null,
  liquidity: LiquidityTrend | undefined,
): ScoreFactor {
  const subReasons: string[] = [];
  let points = 0;
  let evaluatedMax = 0;

  // Depth, worth 9.
  const depth = snapshot?.liquidityUsd ?? null;
  if (depth === null) {
    subReasons.push(
      snapshot && snapshot.assetClass !== 'meme'
        ? 'Pool depth: NOT EVALUATED — not applicable to this asset class.'
        : 'Pool depth: NOT EVALUATED — no liquidity figure was returned.',
    );
  } else {
    evaluatedMax += 9;
    const earned = depth >= 500_000 ? 9 : depth >= 100_000 ? 7 : depth >= 25_000 ? 4 : 0;
    points += earned;
    subReasons.push(
      `+${earned}/9 pool holds $${Math.round(depth).toLocaleString('en-US')}${depth < 25_000 ? ' — thin enough that slippage and manipulation are real risks' : ''}.`,
    );
  }

  // Trend, worth 6.
  if (!liquidity || liquidity.label === 'insufficient-history') {
    subReasons.push(
      `Liquidity trend: NOT EVALUATED — ${liquidity?.detail ?? 'no recorded observations yet.'}`,
    );
  } else {
    evaluatedMax += 6;
    const earned =
      liquidity.label === 'increasing' ? 6 : liquidity.label === 'stable' ? 5 : liquidity.label === 'falling' ? 1 : 0;
    points += earned;
    subReasons.push(`+${earned}/6 liquidity is ${liquidity.label}. ${liquidity.detail}`);
  }

  return {
    key: 'liquidity',
    label: 'Liquidity',
    points,
    max: 15,
    evaluatedMax,
    detail: liquidity?.detail ?? 'Liquidity depth only.',
    subReasons,
    evaluated: evaluatedMax > 0,
  };
}

// --- Support / resistance /10 -----------------------------------------------
function scoreLevels(detection: SetupDetection, structure: StructureAnalysis): ScoreFactor {
  const key = detection.keyLevel;
  if (key === null) {
    return {
      key: 'levels',
      label: 'Support / resistance',
      points: 0,
      max: 10,
      evaluatedMax: 0,
      detail: 'This setup has no single defining level.',
      subReasons: ['NOT EVALUATED — no defining level for this setup.'],
      evaluated: false,
    };
  }
  const match = structure.levels
    .filter((l) => Math.abs((l.price - key) / (key || 1)) < 0.01)
    .sort((a, b) => b.touches - a.touches)[0];
  const touches = match?.touches ?? 1;
  const points = touches >= 4 ? 10 : touches === 3 ? 8 : touches === 2 ? 6 : 2;

  return {
    key: 'levels',
    label: 'Support / resistance',
    points,
    max: 10,
    evaluatedMax: 10,
    detail: `Defining level at ${key.toPrecision(6)}.`,
    subReasons: [
      `+${points}/10 the level at ${key.toPrecision(6)} has ${touches} recorded touch${touches === 1 ? '' : 'es'}. More touches mean more traders are watching it.`,
    ],
    evaluated: true,
  };
}

// --- Risk / reward /10 ------------------------------------------------------
function scoreRiskReward(plan: TradePlanResult): ScoreFactor {
  if (!plan.available) {
    return {
      key: 'risk-reward',
      label: 'Risk / reward',
      points: 0,
      max: 10,
      evaluatedMax: 0,
      detail: plan.reason,
      subReasons: [`NOT EVALUATED — ${plan.reason}`],
      evaluated: false,
    };
  }
  const rr = plan.rr.tp2;
  const points = rr >= 3 ? 10 : rr >= 2 ? 8 : rr >= 1.5 ? 6 : rr >= 1 ? 3 : 0;
  return {
    key: 'risk-reward',
    label: 'Risk / reward',
    points,
    max: 10,
    evaluatedMax: 10,
    detail: `TP1 ${plan.rr.tp1.toFixed(2)}R · TP2 ${rr.toFixed(2)}R · TP3 ${plan.rr.tp3.toFixed(2)}R.`,
    subReasons: [
      `+${points}/10 TP2 sits at ${rr.toFixed(2)}R from the entry, measured against the actual stop distance.`,
    ],
    evaluated: true,
  };
}

// --- Multi-timeframe alignment /10 ------------------------------------------
function scoreAlignment(detection: SetupDetection, alignment: TimeframeAlignment): ScoreFactor {
  if (alignment.alignment === 'UNKNOWN') {
    return {
      key: 'alignment',
      label: 'Multi-timeframe alignment',
      points: 0,
      max: 10,
      evaluatedMax: 0,
      detail: alignment.detail,
      subReasons: ['NOT EVALUATED — no other timeframe could be loaded.'],
      evaluated: false,
    };
  }
  const agrees = alignment.dominantBias === directionBias(detection);
  const points =
    alignment.alignment === 'HIGH' && agrees
      ? 10
      : alignment.alignment === 'MODERATE' && agrees
        ? 6
        : alignment.alignment === 'MIXED'
          ? 2
          : 0;
  return {
    key: 'alignment',
    label: 'Multi-timeframe alignment',
    points,
    max: 10,
    evaluatedMax: 10,
    detail: `${alignment.alignment}: ${alignment.detail}`,
    subReasons: [`+${points}/10 ${alignment.detail}`],
    evaluated: true,
  };
}

function readableStructure(label: StructureAnalysis['label']): string {
  switch (label) {
    case 'higher-highs-higher-lows':
      return 'Higher-high / higher-low structure';
    case 'lower-highs-lower-lows':
      return 'Lower-high / lower-low structure';
    case 'breakout':
      return 'Resistance breakout';
    case 'breakdown':
      return 'Support breakdown';
    case 'reclaim':
      return 'Reclaim of a lost level';
    case 'failed-breakout':
      return 'Failed breakout';
    case 'consolidation':
      return 'Consolidation range';
    default:
      return 'Structure unclear';
  }
}
