import type {
  Candle,
  MarketSnapshot,
  ScoreFactor,
  SetupDetection,
  SetupScore,
  StructureAnalysis,
  TimeframeAlignment,
  TradePlanResult,
} from '../shared/types.js';
import { atrPercent, relativeVolume, rsi } from './indicators.js';

export interface SetupScoreInput {
  detection: SetupDetection;
  candles: Candle[];
  structure: StructureAnalysis;
  alignment: TimeframeAlignment;
  plan: TradePlanResult;
  snapshot: MarketSnapshot | null;
}

/**
 * SETUP SCORE - a checklist total, not a forecast.
 *
 * Each factor is a predefined condition with a maximum number of points. A factor
 * whose input data is missing is marked `evaluated: false` and is excluded from
 * BOTH the earned points and the denominator, so a market with no volume data
 * cannot be silently penalised or silently rewarded. The published score is
 * earned/evaluatable scaled to 100, and `evaluatedMax` tells the user how much of
 * the checklist could actually be checked.
 */
export function scoreSetup(input: SetupScoreInput): SetupScore {
  const { detection, candles, structure, alignment, plan, snapshot } = input;
  const factors: ScoreFactor[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 1. Trend structure -------------------------------------------------------
  {
    const max = 15;
    let points = 0;
    let detail: string;
    const favourable =
      (detection.direction === 'long' && structure.bias === 'bullish') ||
      (detection.direction === 'short' && structure.bias === 'bearish');
    if (structure.label === 'insufficient-data') {
      factors.push({
        key: 'structure',
        label: 'Trend structure',
        points: 0,
        max,
        detail: 'Not enough bars to classify structure.',
        evaluated: false,
      });
    } else {
      if (favourable) {
        points = max;
        detail = `Structure is ${structure.label}, which points the same way as the trade.`;
        reasons.push(readableStructure(structure.label));
      } else if (structure.bias === 'neutral') {
        points = max * 0.4;
        detail = 'Structure is range-bound - it neither supports nor contradicts the direction.';
      } else {
        points = 0;
        detail = `Structure is ${structure.label}, which points against the trade direction.`;
        warnings.push('Trade direction conflicts with the current market structure on this timeframe.');
      }
      factors.push({ key: 'structure', label: 'Trend structure', points, max, detail, evaluated: true });
    }
  }

  // 2. Timeframe alignment ---------------------------------------------------
  {
    const max = 10;
    if (alignment.alignment === 'UNKNOWN') {
      factors.push({
        key: 'alignment',
        label: 'Timeframe alignment',
        points: 0,
        max,
        detail: 'No other timeframe could be evaluated.',
        evaluated: false,
      });
    } else {
      const agrees =
        (detection.direction === 'long' && alignment.dominantBias === 'bullish') ||
        (detection.direction === 'short' && alignment.dominantBias === 'bearish');
      const points =
        alignment.alignment === 'HIGH' && agrees
          ? max
          : alignment.alignment === 'MODERATE' && agrees
            ? max * 0.6
            : alignment.alignment === 'MIXED'
              ? max * 0.2
              : 0;
      factors.push({
        key: 'alignment',
        label: 'Timeframe alignment',
        points,
        max,
        detail: `${alignment.alignment}: ${alignment.detail}`,
        evaluated: true,
      });
      if (alignment.alignment === 'HIGH' && agrees) {
        reasons.push('Higher timeframes agree with the trade direction');
      }
      if (alignment.alignment === 'MIXED') {
        warnings.push('Timeframes conflict - the higher timeframe does not support this direction.');
      }
    }
  }

  // 3. Volume confirmation ---------------------------------------------------
  {
    const max = 12;
    const relVol = relativeVolume(candles, 20);
    if (relVol === null) {
      factors.push({
        key: 'volume',
        label: 'Volume confirmation',
        points: 0,
        max,
        detail: 'Volume data unavailable for this series - not evaluated.',
        evaluated: false,
      });
      warnings.push('Volume confirmation could not be checked: this data source did not supply volume.');
    } else {
      const points = relVol >= 2 ? max : relVol >= 1.5 ? max * 0.75 : relVol >= 1 ? max * 0.4 : 0;
      const detail = `Trigger bar traded ${relVol.toFixed(2)}x the 20-bar average volume.`;
      factors.push({ key: 'volume', label: 'Volume confirmation', points, max, detail, evaluated: true });
      if (relVol >= 1.5) reasons.push(`Volume expansion (${relVol.toFixed(2)}x average)`);
      if (relVol < 1) {
        warnings.push('The move happened on below-average volume - few participants actually took the level.');
      }
    }
  }

  // 4. Support / resistance quality -----------------------------------------
  {
    const max = 10;
    const key = detection.keyLevel;
    if (key === null) {
      factors.push({
        key: 'level',
        label: 'Level quality',
        points: 0,
        max,
        detail: 'This setup has no single defining level.',
        evaluated: false,
      });
    } else {
      const match = structure.levels
        .filter((l) => Math.abs((l.price - key) / (key || 1)) < 0.01)
        .sort((a, b) => b.touches - a.touches)[0];
      const touches = match?.touches ?? 1;
      const points = touches >= 4 ? max : touches === 3 ? max * 0.8 : touches === 2 ? max * 0.6 : max * 0.25;
      factors.push({
        key: 'level',
        label: 'Level quality',
        points,
        max,
        detail: `The defining level at ${key.toPrecision(6)} has ${touches} recorded touch${touches === 1 ? '' : 'es'}.`,
        evaluated: true,
      });
      if (touches >= 3) reasons.push(`Level tested ${touches} times before it mattered`);
    }
  }

  // 5. Momentum --------------------------------------------------------------
  {
    const max = 10;
    const value = rsi(candles.map((c) => c.close), 14);
    if (value === null) {
      factors.push({
        key: 'momentum',
        label: 'Momentum',
        points: 0,
        max,
        detail: 'Not enough bars for a 14-period RSI.',
        evaluated: false,
      });
    } else {
      // Momentum in the trade direction is good; already-extreme momentum is not.
      let points: number;
      let detail: string;
      if (detection.direction === 'long') {
        points = value >= 55 && value <= 72 ? max : value > 72 ? max * 0.3 : value >= 45 ? max * 0.6 : max * 0.2;
        detail = `RSI(14) is ${value.toFixed(1)}.${value > 72 ? ' Price is already extended - entering here means buying after the move.' : ''}`;
      } else {
        points = value <= 45 && value >= 28 ? max : value < 28 ? max * 0.3 : value <= 55 ? max * 0.6 : max * 0.2;
        detail = `RSI(14) is ${value.toFixed(1)}.${value < 28 ? ' Price is already extended to the downside.' : ''}`;
      }
      factors.push({ key: 'momentum', label: 'Momentum', points, max, detail, evaluated: true });
      if (value > 78 && detection.direction === 'long') {
        warnings.push(`RSI at ${value.toFixed(1)} - this is a chase, not an early entry.`);
      }
    }
  }

  // 6 & 7. Breakout and retest quality --------------------------------------
  {
    const hasBreakout = detection.annotations.some((a) => a.kind === 'breakout');
    const hasRetest = detection.annotations.some((a) => a.kind === 'retest');
    const hasConfirmation = detection.annotations.some((a) => a.kind === 'confirmation');

    factors.push({
      key: 'breakout-quality',
      label: 'Breakout quality',
      points: hasBreakout ? (hasConfirmation ? 10 : 6) : 0,
      max: 10,
      detail: hasBreakout
        ? hasConfirmation
          ? 'A breakout occurred and a confirmation close followed.'
          : 'A breakout occurred but no confirmation close is present.'
        : 'This setup does not involve a breakout.',
      evaluated: hasBreakout,
    });

    factors.push({
      key: 'retest-quality',
      label: 'Retest quality',
      points: hasRetest ? (hasConfirmation ? 10 : 5) : 0,
      max: 10,
      detail: hasRetest
        ? 'Price returned to the level and the entry is taken on the reaction, not the initial break.'
        : 'This setup does not involve a retest.',
      evaluated: hasRetest,
    });

    if (hasBreakout && hasConfirmation) reasons.push('Breakout with a confirming close');
    if (hasRetest) reasons.push('Successful retest of the broken level');
  }

  // 8. Liquidity quality (only meaningful for on-chain markets) --------------
  {
    const max = 8;
    const liquidity = snapshot?.liquidityUsd ?? null;
    if (snapshot === null || snapshot.assetClass !== 'meme' || liquidity === null) {
      factors.push({
        key: 'liquidity',
        label: 'Liquidity quality',
        points: 0,
        max,
        detail:
          snapshot && snapshot.assetClass !== 'meme'
            ? 'Not applicable to this asset class.'
            : 'Liquidity data unavailable.',
        evaluated: false,
      });
    } else {
      const points =
        liquidity >= 500_000 ? max : liquidity >= 100_000 ? max * 0.7 : liquidity >= 25_000 ? max * 0.4 : 0;
      factors.push({
        key: 'liquidity',
        label: 'Liquidity quality',
        points,
        max,
        detail: `Pool liquidity is $${Math.round(liquidity).toLocaleString('en-US')}.`,
        evaluated: true,
      });
      if (liquidity < 25_000) {
        warnings.push(
          `Low liquidity ($${Math.round(liquidity).toLocaleString('en-US')}) - slippage and price manipulation risk are high.`,
        );
      }
    }
  }

  // 9. Risk / reward ---------------------------------------------------------
  {
    const max = 15;
    if (!plan.available) {
      factors.push({
        key: 'risk-reward',
        label: 'Risk / reward',
        points: 0,
        max,
        detail: plan.reason,
        evaluated: false,
      });
    } else {
      const rr = plan.rr.tp2;
      const points = rr >= 3 ? max : rr >= 2 ? max * 0.85 : rr >= 1.5 ? max * 0.6 : rr >= 1 ? max * 0.3 : 0;
      factors.push({
        key: 'risk-reward',
        label: 'Risk / reward',
        points,
        max,
        detail: `TP1 is ${plan.rr.tp1.toFixed(2)}R, TP2 is ${rr.toFixed(2)}R, TP3 is ${plan.rr.tp3.toFixed(2)}R.`,
        evaluated: true,
      });
      if (rr >= 2) reasons.push(`${rr.toFixed(1)}R potential reward at TP2`);
      if (plan.rr.tp1 < 1) {
        warnings.push(
          `TP1 is only ${plan.rr.tp1.toFixed(2)}R - you would need to win well over half the time just to break even.`,
        );
      }
    }
  }

  // 10. Volatility -----------------------------------------------------------
  {
    const max = 10;
    const volatility = atrPercent(candles, 14);
    if (volatility === null) {
      factors.push({
        key: 'volatility',
        label: 'Volatility',
        points: 0,
        max,
        detail: 'Not enough bars to compute ATR.',
        evaluated: false,
      });
    } else {
      // Some volatility is required for the target to be reachable; too much and
      // the stop is noise.
      const points =
        volatility >= 0.5 && volatility <= 4
          ? max
          : volatility > 4 && volatility <= 10
            ? max * 0.5
            : volatility > 10
              ? 0
              : max * 0.5;
      factors.push({
        key: 'volatility',
        label: 'Volatility',
        points,
        max,
        detail: `ATR(14) is ${volatility.toFixed(2)}% of price per bar.`,
        evaluated: true,
      });
      if (volatility > 10) {
        warnings.push(
          `Extreme volatility: one average bar moves ${volatility.toFixed(1)}% of price. Size must be far smaller than usual.`,
        );
      }
    }
  }

  const evaluatedFactors = factors.filter((f) => f.evaluated);
  const evaluatedMax = evaluatedFactors.reduce((acc, f) => acc + f.max, 0);
  const earned = evaluatedFactors.reduce((acc, f) => acc + f.points, 0);
  const score = evaluatedMax > 0 ? Math.round((earned / evaluatedMax) * 100) : 0;

  if (evaluatedMax < 60) {
    warnings.push(
      `Only ${evaluatedMax} of 110 checklist points could be evaluated with the data available - treat this score as provisional.`,
    );
  }

  return { score, evaluatedMax, factors, reasons, warnings };
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
