import type { Candle, MarketSnapshot, VolumeAnalysis } from '../shared/types.js';
import { isFiniteNumber, mean, relativeVolume, safeDivide } from './indicators.js';

/**
 * VOLUME ANALYSIS.
 *
 * Four measurements, each of which can independently be unavailable:
 *  - relative volume: current bar against the recent average
 *  - acceleration:    recent bars against the ones before them
 *  - trend:           whether participation is expanding or drying up
 *  - divergence:      whether price and volume are moving together
 *
 * The two flags this produces are the point of the module. BULLISH CONFIRMATION
 * means a price advance is backed by participation. WARNING means price is
 * rising while volume deteriorates - the pattern behind most failed breakouts,
 * and the one a green candle alone will never show you.
 */
export function analyseVolume(candles: Candle[], snapshot: MarketSnapshot | null): VolumeAnalysis {
  const reasons: string[] = [];

  const withVolume = candles.filter((c) => isFiniteNumber(c.volume) && (c.volume as number) > 0);
  if (candles.length < 25 || withVolume.length < 20) {
    return {
      relativeVolume: null,
      acceleration: null,
      trend: 'unavailable',
      priceVolumeDivergence: null,
      flag: 'unavailable',
      headline: 'VOLUME DATA UNAVAILABLE',
      reasons: [
        candles.length < 25
          ? `Only ${candles.length} bars available; volume analysis needs at least 25.`
          : `Only ${withVolume.length} of ${candles.length} bars carried volume; too sparse to analyse.`,
      ],
    };
  }

  const relVol = relativeVolume(candles, 20);
  if (relVol !== null) {
    reasons.push(`Current bar traded ${relVol.toFixed(2)}x the 20-bar average volume.`);
  }

  // Acceleration: the last 3 bars against the 10 before them. A single bar is
  // too noisy to call a change in participation.
  const recent = candles.slice(-3).map((c) => c.volume).filter(isFiniteNumber);
  const prior = candles.slice(-13, -3).map((c) => c.volume).filter(isFiniteNumber);
  const recentAvg = mean(recent);
  const priorAvg = mean(prior);
  const acceleration = recentAvg !== null && priorAvg !== null ? safeDivide(recentAvg, priorAvg) : null;
  if (acceleration !== null) {
    reasons.push(
      `Last 3 bars averaged ${acceleration.toFixed(2)}x the volume of the 10 bars before them.`,
    );
  }

  let trend: VolumeAnalysis['trend'];
  if (acceleration === null) {
    trend = 'unavailable';
  } else if (acceleration >= 1.35) {
    trend = 'expanding';
  } else if (acceleration <= 0.65) {
    trend = 'contracting';
  } else {
    trend = 'steady';
  }

  // Price/volume divergence: compare the direction of the recent price move with
  // the direction of participation. Positive means they agree.
  const priceNow = candles[candles.length - 1]?.close ?? null;
  const priceThen = candles[candles.length - 11]?.close ?? null;
  let divergence: number | null = null;
  if (
    isFiniteNumber(priceNow) &&
    isFiniteNumber(priceThen) &&
    priceThen > 0 &&
    acceleration !== null
  ) {
    const pricePct = ((priceNow - priceThen) / priceThen) * 100;
    const volumePct = (acceleration - 1) * 100;
    // Same sign -> agreement. The magnitude is the smaller of the two, so a huge
    // price move on flat volume does not read as strong agreement.
    divergence = Math.sign(pricePct) === Math.sign(volumePct)
      ? Math.min(Math.abs(pricePct), Math.abs(volumePct)) * Math.sign(pricePct)
      : -Math.min(Math.abs(pricePct), Math.abs(volumePct));
    reasons.push(
      `Over the last 10 bars price moved ${pricePct > 0 ? '+' : ''}${pricePct.toFixed(2)}% while volume moved ${volumePct > 0 ? '+' : ''}${volumePct.toFixed(0)}%.`,
    );
  }

  // Windowed figures from the market snapshot corroborate the candle series.
  const h1 = snapshot?.volume.h1 ?? null;
  const h24 = snapshot?.volume.h24 ?? null;
  if (h1 !== null && h24 !== null && h24 > 0) {
    const pace = h1 / (h24 / 24);
    reasons.push(`Last hour traded ${pace.toFixed(2)}x its 24h average hourly volume.`);
  }

  const priceRising =
    isFiniteNumber(priceNow) && isFiniteNumber(priceThen) && priceNow > priceThen;

  let flag: VolumeAnalysis['flag'] = 'neutral';
  let headline = 'Volume is unremarkable — no confirmation and no divergence.';

  if (priceRising && trend === 'expanding' && (relVol ?? 0) >= 1.2) {
    flag = 'bullish-confirmation';
    headline = 'BULLISH CONFIRMATION — price expansion is supported by real volume.';
  } else if (priceRising && trend === 'contracting') {
    flag = 'warning';
    headline = 'WARNING — price is rising while volume deteriorates.';
    reasons.push(
      'A rally on shrinking participation means few buyers are actually taking the level; these moves reverse easily.',
    );
  } else if (trend === 'contracting') {
    flag = 'warning';
    headline = 'WARNING — participation is drying up.';
    reasons.push('Falling volume makes exits harder regardless of direction.');
  }

  return {
    relativeVolume: relVol,
    acceleration,
    trend,
    priceVolumeDivergence: divergence,
    flag,
    headline,
    reasons,
  };
}
