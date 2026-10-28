import { analyze, type Analysis } from '../../engine/analysis.js';
import { ANALYSIS_WINDOW } from '../../engine/backtest.js';
import { ema, sessionVwap } from '../../engine/indicators.js';
import { buildTradePlan, type Quote, type TradePlan } from '../../engine/plan.js';
import { checkEntry } from '../../engine/risk.js';
import { readTrend } from '../../engine/trend.js';
import { TIMEFRAMES, type MarkedCandle, type Timeframe, type Trend } from '../../engine/types.js';
import { getSettings, type Db, type Mode } from '../db.js';
import type { MarketClock } from '../providers/alpaca.js';
import { accountState } from './account.js';
import { describeError, type MarketService } from './market.js';

export interface Deps {
  db: Db;
  market: MarketService;
  now: () => number;
}

export interface TimeframeView {
  timeframe: Timeframe;
  trend: Trend | null;
  explanation: string | null;
  lastCompletedTime: number | null;
  error: string | null;
}

export interface SymbolReport {
  symbol: string;
  timeframe: Timeframe;
  generatedAt: number;
  quote: Quote | null;
  quoteError: string | null;
  clock: MarketClock | null;
  candles: MarkedCandle[];
  overlays: { ema9: (number | null)[]; ema20: (number | null)[]; vwap: (number | null)[] | null };
  formingCandle: MarkedCandle | null;
  analysis: Analysis | null;
  analysisError: string | null;
  multiTimeframe: TimeframeView[];
  plan: TradePlan | null;
  dataNotes: string[];
}

export const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function normalizeSymbol(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

/**
 * Full report for one ticker. Each data piece fails independently and says
 * why, so a missing quote never turns into a made-up price.
 */
export async function analyzeSymbol(deps: Deps, symbol: string, timeframe: Timeframe, mode: Mode = 'paper'): Promise<SymbolReport> {
  const now = deps.now();
  const settings = getSettings(deps.db);
  const [quoteRes, setRes, clock] = await Promise.all([
    deps.market.quote(symbol).then((q) => ({ q, e: null as string | null }), (e) => ({ q: null, e: describeError(e).message })),
    deps.market.candles(symbol, timeframe, ANALYSIS_WINDOW + 20).then((c) => ({ c, e: null as string | null }), (e) => ({ c: null, e: describeError(e).message })),
    deps.market.clock(),
  ]);

  let an: Analysis | null = null;
  let plan: TradePlan | null = null;
  const candles = setRes.c?.all ?? [];
  if (setRes.c) {
    an = analyze(setRes.c.completed.slice(-ANALYSIS_WINDOW), timeframe);
    const state = accountState(deps.db, mode, settings, now);
    const guard = checkEntry(settings, state, null, now);
    plan = buildTradePlan({ symbol, analysis: an, quote: quoteRes.q, settings, cashUsd: state.cash, guard, now, marketOpen: clock ? clock.isOpen : null });
  }

  const mtf: TimeframeView[] = await Promise.all(
    TIMEFRAMES.map(async (tf): Promise<TimeframeView> => {
      if (tf === timeframe) {
        return { timeframe: tf, trend: an?.trend.trend ?? null, explanation: an?.trend.explanation ?? null, lastCompletedTime: an?.lastCompletedTime ?? null, error: setRes.e };
      }
      try {
        const set = await deps.market.candles(symbol, tf, 120);
        const t = readTrend(set.completed);
        return { timeframe: tf, trend: t.trend, explanation: t.explanation, lastCompletedTime: set.completed.at(-1)?.t ?? null, error: null };
      } catch (e) {
        return { timeframe: tf, trend: null, explanation: null, lastCompletedTime: null, error: describeError(e).message };
      }
    }),
  );

  const chart = candles.slice(-200);
  const closes = chart.map((c) => c.c);
  const notes = [...deps.market.provider.notes()];
  if (setRes.c?.forming) notes.push('The last candle on the chart is still forming. Its open/high/low/close can change and it is NOT used in the analysis.');
  if (clock && !clock.isOpen) notes.push('The market is closed right now.');
  if (!clock) notes.push('Market open/closed status could not be read.');

  return {
    symbol,
    timeframe,
    generatedAt: now,
    quote: quoteRes.q,
    quoteError: quoteRes.e,
    clock,
    candles: chart,
    overlays: { ema9: ema(closes, 9), ema20: ema(closes, 20), vwap: timeframe === '1Day' ? null : sessionVwap(chart) },
    formingCandle: setRes.c?.forming ?? null,
    analysis: an,
    analysisError: setRes.e,
    multiTimeframe: mtf,
    plan,
    dataNotes: notes,
  };
}
