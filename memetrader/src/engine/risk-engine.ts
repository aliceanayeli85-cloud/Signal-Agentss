import type {
  Candle,
  LiquidityTrend,
  MarketSnapshot,
  RiskAssessment,
  RiskFactor,
  TokenInfo,
} from '../shared/types.js';
import { atrPercent, isFiniteNumber, mean, safeDivide } from './indicators.js';

export interface RiskInput {
  snapshot: MarketSnapshot | null;
  candles: Candle[];
  /** Contract- and holder-level facts, when a provider supplied them. */
  tokenInfo?: TokenInfo | null;
  /** Observed liquidity direction, when the app has recorded enough history. */
  liquidityTrend?: LiquidityTrend | null;
  /** Wall-clock now, injectable so tests are deterministic. */
  now?: number;
}

/**
 * MEME COIN RISK ENGINE - 0 to 100 where higher is more hazardous.
 *
 * This is explicitly NOT a probability of loss and NOT a scam detector. It is an
 * aggregate of measurable hazards: how thin the pool is, how new the pair is, how
 * violently it moves, whether volume is collapsing, whether the price move is
 * plausible given the liquidity behind it.
 *
 * Factors whose data is missing are excluded from the denominator and listed in
 * `unavailable`. Holder concentration is always listed there: this app has no
 * on-chain holder data source, and estimating it would be fabrication.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  const { snapshot, candles } = input;
  const now = input.now ?? Date.now();
  const factors: RiskFactor[] = [];
  const warnings: string[] = [];
  const unavailable: string[] = [];

  // Liquidity depth ----------------------------------------------------------
  {
    const max = 20;
    const liquidity = snapshot?.liquidityUsd ?? null;
    if (liquidity === null) {
      factors.push({
        key: 'liquidity',
        label: 'Liquidity depth',
        points: 0,
        max,
        detail: 'No liquidity figure was returned for this market.',
        evaluated: false,
      });
      unavailable.push('Liquidity depth');
    } else {
      const points =
        liquidity < 5_000
          ? max
          : liquidity < 25_000
            ? max * 0.8
            : liquidity < 100_000
              ? max * 0.5
              : liquidity < 500_000
                ? max * 0.25
                : 0;
      factors.push({
        key: 'liquidity',
        label: 'Liquidity depth',
        points,
        max,
        detail: `Pool holds $${Math.round(liquidity).toLocaleString('en-US')}.`,
        evaluated: true,
      });
      if (liquidity < 25_000) {
        warnings.push(
          `EXTREMELY LOW LIQUIDITY: $${Math.round(liquidity).toLocaleString('en-US')}. A modest order moves the price against you, and the pool can be withdrawn.`,
        );
      }
    }
  }

  // Pair age -----------------------------------------------------------------
  {
    const max = 15;
    const created = snapshot?.pairCreatedAt ?? null;
    if (created === null) {
      factors.push({
        key: 'pair-age',
        label: 'Pair age',
        points: 0,
        max,
        detail: 'Pair creation time was not reported by the data source.',
        evaluated: false,
      });
      unavailable.push('Pair age');
    } else {
      const ageHours = (now - created) / 3_600_000;
      const points =
        ageHours < 1 ? max : ageHours < 6 ? max * 0.85 : ageHours < 24 ? max * 0.6 : ageHours < 24 * 7 ? max * 0.3 : 0;
      factors.push({
        key: 'pair-age',
        label: 'Pair age',
        points,
        max,
        detail: `Pair is ${formatAge(ageHours)} old.`,
        evaluated: true,
      });
      if (ageHours < 24) {
        warnings.push(
          `EXTREMELY NEW PAIR: created ${formatAge(ageHours)} ago. There is no established structure here and no history for any level to mean anything.`,
        );
      }
    }
  }

  // Volatility ---------------------------------------------------------------
  {
    const max = 15;
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
      unavailable.push('Volatility (ATR)');
    } else {
      const points =
        volatility > 20 ? max : volatility > 10 ? max * 0.75 : volatility > 5 ? max * 0.45 : volatility > 2 ? max * 0.2 : 0;
      factors.push({
        key: 'volatility',
        label: 'Volatility',
        points,
        max,
        detail: `One average bar moves ${volatility.toFixed(2)}% of price.`,
        evaluated: true,
      });
      if (volatility > 10) {
        warnings.push(
          `EXTREME VOLATILITY: an average bar moves ${volatility.toFixed(1)}% of price. Any stop wide enough to survive is wide enough to demand a very small position.`,
        );
      }
    }
  }

  // Volume behaviour ---------------------------------------------------------
  {
    const max = 12;
    const h24 = snapshot?.volume.h24 ?? null;
    const h6 = snapshot?.volume.h6 ?? null;
    const h1 = snapshot?.volume.h1 ?? null;
    if (h24 === null || h1 === null) {
      factors.push({
        key: 'volume-trend',
        label: 'Volume trend',
        points: 0,
        max,
        detail: 'Windowed volume figures were not available for this market.',
        evaluated: false,
      });
      unavailable.push('Volume trend');
    } else {
      // Expected hourly volume if the last 24h were evenly spread.
      const expectedHourly = h24 / 24;
      const ratio = safeDivide(h1, expectedHourly);
      let points = 0;
      let detail: string;
      if (ratio === null) {
        points = max * 0.5;
        detail = 'Reported 24h volume is zero, so recent activity cannot be compared to it.';
      } else if (ratio < 0.15) {
        points = max;
        detail = `Last hour traded ${(ratio * 100).toFixed(0)}% of its 24h average hourly volume - activity is collapsing.`;
        warnings.push(
          'SUDDEN VOLUME COLLAPSE: the last hour traded a small fraction of the recent average. Exits get harder as participation dries up.',
        );
      } else if (ratio < 0.4) {
        points = max * 0.6;
        detail = `Last hour traded ${(ratio * 100).toFixed(0)}% of its 24h average hourly volume - activity is fading.`;
      } else if (ratio > 5) {
        points = max * 0.45;
        detail = `Last hour traded ${ratio.toFixed(1)}x its 24h average hourly volume - a sharp, unusual spike.`;
      } else {
        points = 0;
        detail = `Last hour traded ${ratio.toFixed(2)}x its 24h average hourly volume - activity is steady.`;
      }
      factors.push({ key: 'volume-trend', label: 'Volume trend', points, max, detail, evaluated: true });

      if (h6 !== null && h6 > 0 && h1 / (h6 / 6) > 8) {
        warnings.push(
          `Volume acceleration: the last hour is running at ${(h1 / (h6 / 6)).toFixed(1)}x the 6-hour pace. Sharp spikes cut both ways.`,
        );
      }
    }
  }

  // Buy / sell imbalance -----------------------------------------------------
  {
    const max = 8;
    const txns = snapshot?.txns.h1 ?? snapshot?.txns.h6 ?? null;
    const total = txns ? txns.buys + txns.sells : 0;
    // Small transaction counts produce meaningless ratios.
    if (!txns || total < 30) {
      factors.push({
        key: 'imbalance',
        label: 'Buy / sell imbalance',
        points: 0,
        max,
        detail: txns
          ? `Only ${total} transactions in the window - too few for the ratio to mean anything.`
          : 'Transaction counts were not available for this market.',
        evaluated: false,
      });
      unavailable.push('Buy/sell imbalance (insufficient transaction count)');
    } else {
      const sellShare = txns.sells / total;
      const points = sellShare > 0.75 ? max : sellShare > 0.65 ? max * 0.6 : sellShare < 0.25 ? max * 0.4 : 0;
      factors.push({
        key: 'imbalance',
        label: 'Buy / sell imbalance',
        points,
        max,
        detail: `${txns.buys} buys vs ${txns.sells} sells (${(sellShare * 100).toFixed(0)}% sells) across ${total} transactions.`,
        evaluated: true,
      });
      if (sellShare > 0.75) {
        warnings.push(`Sell-dominated flow: ${(sellShare * 100).toFixed(0)}% of recent transactions were sells.`);
      }
    }
  }

  // Price extension ----------------------------------------------------------
  {
    const max = 12;
    const change24 = snapshot?.priceChangePct.h24 ?? null;
    const change1 = snapshot?.priceChangePct.h1 ?? null;
    if (change24 === null && change1 === null) {
      factors.push({
        key: 'extension',
        label: 'Price extension',
        points: 0,
        max,
        detail: 'No price-change figures were available.',
        evaluated: false,
      });
      unavailable.push('Price extension');
    } else {
      const magnitude = Math.max(Math.abs(change24 ?? 0), Math.abs(change1 ?? 0) * 3);
      const points = magnitude > 300 ? max : magnitude > 100 ? max * 0.75 : magnitude > 40 ? max * 0.45 : 0;
      const parts: string[] = [];
      if (change1 !== null) parts.push(`${change1 > 0 ? '+' : ''}${change1.toFixed(1)}% in 1h`);
      if (change24 !== null) parts.push(`${change24 > 0 ? '+' : ''}${change24.toFixed(1)}% in 24h`);
      factors.push({
        key: 'extension',
        label: 'Price extension',
        points,
        max,
        detail: parts.join(', '),
        evaluated: true,
      });
      if ((change24 ?? 0) > 100) {
        warnings.push(
          `EXTREME PRICE EXTENSION: ${(change24 as number).toFixed(0)}% in 24h. Entering after a move of this size means your stop has to sit a long way down.`,
        );
      }
      if ((change1 ?? 0) < -30) {
        warnings.push(
          `Sharp decline: ${(change1 as number).toFixed(0)}% in the last hour. Falling markets with thin liquidity gap through stops.`,
        );
      }
    }
  }

  // Price move vs liquidity backing -----------------------------------------
  {
    const max = 10;
    const liquidity = snapshot?.liquidityUsd ?? null;
    const volume24 = snapshot?.volume.h24 ?? null;
    const marketCap = snapshot?.marketCapUsd ?? null;
    if (liquidity === null || volume24 === null) {
      factors.push({
        key: 'liquidity-vs-flow',
        label: 'Price move vs liquidity',
        points: 0,
        max,
        detail: 'Needs both liquidity and 24h volume; at least one was missing.',
        evaluated: false,
      });
      unavailable.push('Price move relative to liquidity');
    } else {
      const turnover = safeDivide(volume24, liquidity);
      let points = 0;
      let detail: string;
      if (turnover === null) {
        points = max;
        detail = 'Liquidity is zero, so any quoted price is not backed by a tradable pool.';
        warnings.push('ZERO LIQUIDITY REPORTED: the quoted price cannot be traded against in any meaningful size.');
      } else if (turnover > 50) {
        points = max;
        detail = `24h volume is ${turnover.toFixed(0)}x the pool size - the price is being moved by flow far larger than the liquidity backing it.`;
        warnings.push(
          `Abnormal price movement relative to liquidity: 24h volume is ${turnover.toFixed(0)}x the pool. Price marks here are fragile.`,
        );
      } else if (turnover > 15) {
        points = max * 0.6;
        detail = `24h volume is ${turnover.toFixed(1)}x the pool size - high turnover relative to depth.`;
      } else if (turnover < 0.05) {
        points = max * 0.5;
        detail = `24h volume is only ${(turnover * 100).toFixed(1)}% of the pool - almost nothing is trading.`;
      } else {
        detail = `24h volume is ${turnover.toFixed(2)}x the pool size, which is a normal turnover range.`;
      }
      factors.push({
        key: 'liquidity-vs-flow',
        label: 'Price move vs liquidity',
        points,
        max,
        detail,
        evaluated: true,
      });

      if (marketCap !== null && liquidity > 0) {
        const depth = safeDivide(liquidity, marketCap);
        if (depth !== null && depth < 0.02) {
          warnings.push(
            `Liquidity is only ${(depth * 100).toFixed(1)}% of market cap - the valuation rests on a very thin pool.`,
          );
        }
      }
    }
  }

  // Liquidity trend ----------------------------------------------------------
  // No provider exposes a liquidity time series on the endpoints this app uses,
  // so the trend comes from snapshots the app itself recorded. Until it has
  // enough of them there is no trend to score.
  {
    const max = 10;
    const trend = input.liquidityTrend ?? null;
    if (!trend || trend.label === 'insufficient-history') {
      factors.push({
        key: 'liquidity-trend',
        label: 'Liquidity trend (rug watch)',
        points: 0,
        max,
        detail:
          trend?.detail ??
          'No liquidity history has been recorded for this market yet, so a falling-liquidity check cannot be run.',
        evaluated: false,
      });
      unavailable.push('Liquidity trend over time');
    } else {
      const points =
        trend.label === 'rapid-loss' ? max : trend.label === 'falling' ? max * 0.6 : 0;
      factors.push({
        key: 'liquidity-trend',
        label: 'Liquidity trend (rug watch)',
        points,
        max,
        detail: trend.detail,
        evaluated: true,
      });
      if (trend.label === 'rapid-loss') {
        // `detail` already carries the HIGH RISK headline and the do-not-enter
        // line, so prefixing it again would read as a stutter.
        warnings.push(trend.detail);
      } else if (trend.label === 'falling') {
        warnings.push(`RAPID LIQUIDITY LOSS WATCH: ${trend.detail}`);
      }
    }
  }

  // Holder concentration -----------------------------------------------------
  {
    const max = 10;
    const info = input.tokenInfo ?? null;
    const topTen = info?.topTenPct ?? null;
    if (topTen === null) {
      factors.push({
        key: 'holders',
        label: 'Holder concentration',
        points: 0,
        max,
        detail:
          'Holder concentration data unavailable for this token from the connected sources.',
        evaluated: false,
      });
      unavailable.push('Holder concentration data unavailable');
    } else {
      const points = topTen > 60 ? max : topTen > 40 ? max * 0.7 : topTen > 25 ? max * 0.4 : 0;
      const holderCount = info?.holderCount ?? null;
      factors.push({
        key: 'holders',
        label: 'Holder concentration',
        points,
        max,
        detail: `Top 10 wallets hold ${topTen.toFixed(1)}% of supply${holderCount !== null ? ` across ${holderCount.toLocaleString('en-US')} holders` : ''}.`,
        evaluated: true,
      });
      if (topTen > 40) {
        warnings.push(
          `CONCENTRATED OWNERSHIP: the top 10 wallets hold ${topTen.toFixed(1)}% of supply. One of them selling can end the move regardless of the chart.`,
        );
      }
      if (holderCount !== null && holderCount < 500) {
        warnings.push(
          `Only ${holderCount.toLocaleString('en-US')} holders. There is very little distribution behind this price.`,
        );
      }
    }
  }

  // Creator holding ----------------------------------------------------------
  {
    const max = 8;
    const creator = input.tokenInfo?.creatorHoldingPct ?? null;
    if (creator === null) {
      factors.push({
        key: 'creator-holding',
        label: 'Creator holding',
        points: 0,
        max,
        detail: 'Creator holding data unavailable for this token.',
        evaluated: false,
      });
      unavailable.push('Creator holding');
    } else {
      const points = creator > 20 ? max : creator > 10 ? max * 0.7 : creator > 3 ? max * 0.4 : 0;
      factors.push({
        key: 'creator-holding',
        label: 'Creator holding',
        points,
        max,
        detail: `The deployer wallet holds ${creator.toFixed(2)}% of supply.`,
        evaluated: true,
      });
      if (creator > 10) {
        warnings.push(
          `CREATOR HOLDS ${creator.toFixed(1)}% of supply. That is a single wallet able to sell into any rally.`,
        );
      }
    }
  }

  // Contract authorities -----------------------------------------------------
  {
    const max = 10;
    const info = input.tokenInfo ?? null;
    const mint = info?.mintAuthority ?? null;
    const freeze = info?.freezeAuthority ?? null;
    if (mint === null && freeze === null) {
      factors.push({
        key: 'contract',
        label: 'Contract authorities',
        points: 0,
        max,
        detail: 'Mint and freeze authority data unavailable for this token.',
        evaluated: false,
      });
      unavailable.push('Contract mint/freeze authority');
    } else {
      let points = 0;
      const notes: string[] = [];
      // "unknown" is not "no". An unrevoked authority scores full risk; an
      // unknown one scores partial, because absence of evidence is not evidence.
      if (mint === 'yes') {
        points += max * 0.5;
        notes.push('mint authority is NOT revoked - more supply can be created');
        warnings.push(
          'MINT AUTHORITY NOT REVOKED: the deployer can still create new supply, diluting every holder.',
        );
      } else if (mint === 'no') {
        notes.push('mint authority revoked');
      } else {
        points += max * 0.25;
        notes.push('mint authority unknown');
      }
      if (freeze === 'yes') {
        points += max * 0.5;
        notes.push('freeze authority is NOT revoked - transfers can be blocked');
        warnings.push(
          'FREEZE AUTHORITY NOT REVOKED: the deployer can freeze token accounts, which can prevent you selling.',
        );
      } else if (freeze === 'no') {
        notes.push('freeze authority revoked');
      } else {
        points += max * 0.25;
        notes.push('freeze authority unknown');
      }
      factors.push({
        key: 'contract',
        label: 'Contract authorities',
        points,
        max,
        detail: notes.join('; ') + '.',
        evaluated: true,
      });
    }

    const honeypot = info?.honeypot ?? null;
    if (honeypot === 'yes') {
      warnings.push(
        'The data source flags this token as a possible honeypot. Treat that as a hard stop, not a discount.',
      );
    } else if (honeypot === null || honeypot === 'unknown') {
      unavailable.push('Honeypot check (provider reported unknown)');
    }
  }

  // FDV / market cap gap -----------------------------------------------------
  {
    const max = 8;
    const fdv = snapshot?.fdvUsd ?? null;
    const marketCap = snapshot?.marketCapUsd ?? null;
    if (fdv === null || marketCap === null || marketCap <= 0) {
      factors.push({
        key: 'fdv-gap',
        label: 'Unlocked supply overhang',
        points: 0,
        max,
        detail: 'FDV or market cap was not reported, so supply overhang cannot be assessed.',
        evaluated: false,
      });
      unavailable.push('FDV vs market cap');
    } else {
      const ratio = fdv / marketCap;
      const points = ratio > 5 ? max : ratio > 2 ? max * 0.6 : ratio > 1.25 ? max * 0.3 : 0;
      factors.push({
        key: 'fdv-gap',
        label: 'Unlocked supply overhang',
        points,
        max,
        detail: `FDV is ${ratio.toFixed(2)}x market cap.`,
        evaluated: true,
      });
      if (ratio > 2) {
        warnings.push(
          `FDV is ${ratio.toFixed(1)}x market cap - a large amount of supply has not entered circulation yet.`,
        );
      }
    }
  }

  const evaluated = factors.filter((f) => f.evaluated);
  const evaluatedMax = evaluated.reduce((acc, f) => acc + f.max, 0);
  const totalMax = factors.reduce((acc, f) => acc + f.max, 0);
  const earned = evaluated.reduce((acc, f) => acc + f.points, 0);
  const score = evaluatedMax > 0 ? Math.round((earned / evaluatedMax) * 100) : 0;

  if (evaluatedMax === 0) {
    warnings.push('No risk factor could be evaluated with the data available. Treat this market as unassessed.');
  } else if (evaluatedMax < totalMax * 0.45) {
    // A low score computed from a third of the checklist is not "low risk", it is
    // "mostly unmeasured", and the UI must not let those read the same.
    warnings.push(
      `Only ${evaluatedMax} of ${totalMax} hazard points could be evaluated for this market - ${unavailable.length} factor(s) had no data. A low score here means "few measured hazards", not "safe".`,
    );
  }

  if (snapshot && snapshot.assetClass === 'meme') {
    warnings.push(
      input.tokenInfo
        ? 'Mint/freeze authority and holder figures come from the data provider and are not a security audit. There is no LP-lock check here, and nothing on this screen should be read as a token being safe.'
        : 'This app could not retrieve contract or holder data for this token, so nothing here should be read as a token being safe.',
    );
  }

  return {
    score,
    evaluatedMax,
    totalMax,
    band: band(score, evaluatedMax),
    factors,
    warnings,
    unavailable,
  };
}

function band(score: number, evaluatedMax: number): RiskAssessment['band'] {
  if (evaluatedMax === 0) return 'extreme';
  if (score >= 80) return 'extreme';
  if (score >= 60) return 'high';
  if (score >= 40) return 'elevated';
  if (score >= 20) return 'moderate';
  return 'low';
}

function formatAge(hours: number): string {
  if (!isFiniteNumber(hours) || hours < 0) return 'an unknown amount of time';
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Volume acceleration across the candle series: current bar volume against the
 * mean of the preceding window. Used by the scanner's "Unusual Volume" tab.
 */
export function volumeAcceleration(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1];
  if (!last || !isFiniteNumber(last.volume) || last.volume <= 0) return null;
  const prior = candles
    .slice(candles.length - 1 - lookback, candles.length - 1)
    .map((c) => c.volume)
    .filter(isFiniteNumber);
  const avg = mean(prior);
  if (avg === null || avg <= 0) return null;
  return last.volume / avg;
}
