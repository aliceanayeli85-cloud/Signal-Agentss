import type {
  FomoAssessment,
  LimitState,
  PaperTradeRecord,
  SetupDetection,
  Settings,
} from '../shared/types.js';
import { isFiniteNumber } from './indicators.js';

export const DEFAULT_SETTINGS: Settings = {
  accountSize: 10_000,
  defaultRiskPct: 1,
  maxRiskPctPerTrade: 1,
  maxTradesPerDay: 3,
  maxDailyLossPct: 3,
  maxConsecutiveLosses: 3,
  simulationOverride: 0,
};

export interface FomoInput {
  /** Percent move over the recent window on the entry timeframe, when known. */
  recentMovePct: number | null;
  /** Trades closed today, most recent first. */
  recentTrades: PaperTradeRecord[];
  /** The setup the entry claims to be taking, if any was detected. */
  detection: SetupDetection | null;
  /** Risk the user is about to take, as a percent of account. */
  riskPct: number;
  /** The user's normal risk from settings. */
  baselineRiskPct: number;
  /** Asset the user is about to enter, so we can spot re-entering something just missed. */
  assetId: string;
  now?: number;
}

/**
 * FOMO DETECTION.
 *
 * These are behavioural checks, not market predictions. Each flag corresponds to
 * a documented way traders lose money faster than their edge can compensate for:
 * chasing a vertical move, re-entering something they just missed, trading after
 * consecutive losses, quietly increasing size, or entering with no defined setup.
 */
export function assessFomo(input: FomoInput): FomoAssessment {
  const now = input.now ?? Date.now();
  const flags: FomoAssessment['flags'] = [];

  if (isFiniteNumber(input.recentMovePct) && input.recentMovePct > 25) {
    flags.push({
      key: 'vertical-move',
      label: 'Entering after a vertical move',
      detail: `Price is up ${input.recentMovePct.toFixed(1)}% over the recent window. Entering here puts your stop far below and the buyers who caused the move above you.`,
    });
  }

  const twoHoursAgo = now - 2 * 3_600_000;
  const justMissed = input.recentTrades.find(
    (t) =>
      t.assetId === input.assetId &&
      t.status === 'closed' &&
      (t.closedAt ?? 0) > twoHoursAgo,
  );
  if (justMissed) {
    flags.push({
      key: 're-entry',
      label: 'Re-entering something you just exited',
      detail: `You closed ${justMissed.symbol} within the last two hours. Getting back in immediately is usually about the previous trade, not this setup.`,
    });
  }

  const closed = input.recentTrades.filter((t) => t.status === 'closed');
  let streak = 0;
  for (const trade of closed) {
    if ((trade.rMultiple ?? 0) < 0) streak += 1;
    else break;
  }
  if (streak >= 2) {
    flags.push({
      key: 'losing-streak',
      label: `Trading after ${streak} consecutive losses`,
      detail:
        'Consecutive losses are when position sizing discipline breaks down most often. The next trade is where revenge trading starts.',
    });
  }

  if (input.riskPct > input.baselineRiskPct * 1.5) {
    flags.push({
      key: 'size-increase',
      label: 'Increasing risk above your baseline',
      detail: `You normally risk ${input.baselineRiskPct}% and this trade risks ${input.riskPct}%. Increasing size does not increase edge.`,
    });
  }

  if (!input.detection) {
    flags.push({
      key: 'no-setup',
      label: 'No predefined setup detected',
      detail:
        'None of your five defined strategies currently fire on this market and timeframe. This entry is discretionary.',
    });
  }

  return {
    triggered: flags.length > 0,
    flags,
    message:
      flags.length > 0
        ? 'FOMO WARNING - This trade does not currently satisfy your predefined rules.'
        : 'No FOMO flags raised for this entry.',
  };
}

export interface LimitInput {
  settings: Settings;
  /** Trades opened today (used for the trade-count limit). */
  tradesOpenedToday: PaperTradeRecord[];
  /** Trades closed today (used for the daily loss limit). */
  tradesClosedToday: PaperTradeRecord[];
  /** All closed trades, most recent first, for the consecutive-loss check. */
  recentClosedTrades: PaperTradeRecord[];
}

/**
 * DAILY TRADING LIMITS.
 *
 * When a limit is hit the app locks new paper entries. The user can lift the lock
 * only by enabling the explicit simulation override in Settings - which is
 * recorded, so the journal shows when the rules were set aside.
 */
export function evaluateLimits(input: LimitInput): LimitState {
  const { settings } = input;
  const reasons: string[] = [];

  const tradesToday = input.tradesOpenedToday.length;
  const dailyPnl = input.tradesClosedToday.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  // `+ 0` normalises the -0 that falls out of negating a zero loss, so a
  // profitable day is never rendered as "-0.00%".
  const dailyLossPct =
    settings.accountSize > 0 ? (Math.min(0, dailyPnl) / settings.accountSize) * -100 + 0 : 0;

  let consecutiveLosses = 0;
  for (const trade of input.recentClosedTrades) {
    if ((trade.rMultiple ?? 0) < 0) consecutiveLosses += 1;
    else break;
  }

  if (tradesToday >= settings.maxTradesPerDay) {
    reasons.push(
      `Maximum trades per day reached (${tradesToday}/${settings.maxTradesPerDay}).`,
    );
  }
  if (dailyLossPct >= settings.maxDailyLossPct) {
    reasons.push(
      `Daily loss limit reached: down ${dailyLossPct.toFixed(2)}% against a ${settings.maxDailyLossPct}% limit.`,
    );
  }
  if (consecutiveLosses >= settings.maxConsecutiveLosses) {
    reasons.push(
      `Consecutive loss limit reached (${consecutiveLosses}/${settings.maxConsecutiveLosses}).`,
    );
  }

  const overrideActive = settings.simulationOverride === 1;

  return {
    locked: reasons.length > 0 && !overrideActive,
    reasons,
    tradesToday,
    dailyPnl,
    dailyLossPct,
    consecutiveLosses,
    overrideActive,
  };
}

/** Message shown when the lock engages. Kept here so server and UI agree exactly. */
export const TRADING_LOCKED_MESSAGE =
  'TRADING LOCKED - Your predefined risk limit has been reached.';
