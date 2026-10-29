import { randomUUID } from 'node:crypto';
import { applySlippage, estimateRoundTripCosts, sellFees, sizePosition } from '../../engine/costs.js';
import { sma } from '../../engine/indicators.js';
import { checkEntry, type AccountState } from '../../engine/risk.js';
import { effectiveRiskPerTrade, type RiskSettings } from '../../engine/settings.js';
import { nyParts } from '../../engine/time.js';
import type { Candle } from '../../engine/types.js';
import { RESEARCH_TICKERS } from '../../research/config.js';
import { buildCtx, TREND_FOLLOW, type Ctx } from '../../research/strategies.js';
import type { Db } from '../db.js';

/**
 * C1 — trend following, EXPERIMENTAL paper portfolio.
 *
 * Rules are the pre-registered research code (`TREND_FOLLOW.signal`), reused
 * as-is; nothing here re-implements the entry rule. Exits replicate the
 * audited research exit order (`simulateChannelExit`). Everything lives in the
 * c1_* tables: it can never touch the baseline paper account or real records.
 */
export const C1 = {
  strategyId: TREND_FOLLOW.id,
  label: 'EXPERIMENTAL — NOT PROVEN PROFITABLE',
  rules: TREND_FOLLOW.rules,
  universe: [...RESEARCH_TICKERS] as string[],
  /** Predefined before any paper result existed. Never change it after results are observed. */
  benchmark: 'SPY',
  /** First day processed: the day after the research data ended (2026-10-27). */
  startDate: '2026-10-28',
  lookback: 10,
  maxHoldBars: 120,
  minTradesForEvaluation: 30,
} as const;

export interface C1Options {
  universe: string[];
  benchmark: string;
  startDate: string;
  killSwitchOn: boolean;
  now: number;
  /** Live use: pause (with a warning) rather than process a day without enough history for the rules. */
  requireWarmup?: boolean;
}

export interface C1Event {
  kind: 'entry' | 'exit' | 'signal' | 'warning';
  symbol: string | null;
  date: string;
  title: string;
  detail: string;
}

export interface C1TradeRow {
  id: string;
  symbol: string;
  signal_date: string;
  entry_date: string;
  entry_time: number;
  entry_raw: number;
  entry_fill: number;
  shares: number;
  stop: number;
  planned_risk: number;
  entry_slippage: number;
  status: 'open' | 'closed';
  exit_date: string | null;
  exit_time: number | null;
  exit_raw: number | null;
  exit_fill: number | null;
  exit_slippage: number | null;
  fees: number;
  pnl: number | null;
  r_multiple: number | null;
  exit_reason: string | null;
  regime: string;
  mae: number;
  mfe: number;
  bars_held: number;
  last_close: number | null;
  last_close_date: string | null;
}

const dateOf = (t: number) => nyParts(t).dateKey;
/** Daily candles are stamped at New York midnight; the session opens 9h30 later and closes at 16h00. */
const openTime = (bar: Candle) => bar.t + 9.5 * 3_600_000;
const closeTime = (bar: Candle) => bar.t + 16 * 3_600_000;

export function ensureState(db: Db, startDate: string) {
  db.prepare('INSERT OR IGNORE INTO c1_state (id, start_date) VALUES (1, ?)').run(startDate);
}

export function c1State(db: Db) {
  return db.prepare('SELECT * FROM c1_state WHERE id = 1').get() as
    | { start_date: string; last_processed_date: string | null; last_run_at: number | null; last_success_at: number | null; last_error: string | null; last_error_at: number | null; warnings_json: string }
    | undefined;
}

const openTrades = (db: Db) => db.prepare("SELECT * FROM c1_trades WHERE status = 'open' ORDER BY entry_time, symbol").all() as C1TradeRow[];

/** Cash = starting capital + realized P&L − money currently tied up in open positions (cost + fees paid). */
export function c1Cash(db: Db, startingCapital: number): number {
  const r = db.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'closed' THEN pnl ELSE -(shares * entry_fill + fees) END), 0) AS x FROM c1_trades").get() as { x: number };
  return startingCapital + r.x;
}

function accountFor(db: Db, s: RiskSettings, day: string, killSwitchOn: boolean, markPrice: (t: C1TradeRow) => number): AccountState {
  const open = openTrades(db);
  const cash = c1Cash(db, s.startingCapitalUsd);
  const closedToday = db.prepare("SELECT symbol, pnl, exit_time FROM c1_trades WHERE status = 'closed' AND exit_date = ? ORDER BY exit_time DESC, rowid DESC").all(day) as { symbol: string; pnl: number; exit_time: number }[];
  let consecutive = 0;
  for (const t of closedToday) {
    if (t.pnl < 0) consecutive++;
    else break;
  }
  const lastLoss = db.prepare("SELECT symbol, exit_time FROM c1_trades WHERE status = 'closed' AND pnl < 0 ORDER BY exit_time DESC LIMIT 1").get() as { symbol: string; exit_time: number } | undefined;
  return {
    equity: cash + open.reduce((a, t) => a + t.shares * markPrice(t), 0),
    cash,
    openRiskUsd: open.reduce((a, t) => a + t.shares * Math.max(0, t.entry_fill - t.stop), 0),
    openSymbols: open.map((t) => t.symbol),
    workingOrders: [],
    todayRealizedPnl: closedToday.reduce((a, t) => a + t.pnl, 0),
    tradesToday: (db.prepare('SELECT COUNT(*) AS n FROM c1_trades WHERE entry_date = ?').get(day) as { n: number }).n,
    consecutiveLossesToday: consecutive,
    lastLoss: lastLoss ? { symbol: lastLoss.symbol, at: lastLoss.exit_time } : null,
    lossSymbolsToday: [...new Set(closedToday.filter((t) => t.pnl < 0).map((t) => t.symbol))],
    killSwitch: killSwitchOn,
  };
}

/**
 * Processes every completed trading day after the last processed one, in
 * order. Each day is processed exactly once (append-only), so a paused
 * server catches up later without missing or double-counting anything.
 * Returns early — without advancing — if any symbol is missing that day.
 */
export function processC1(db: Db, series: Record<string, Candle[]>, s: RiskSettings, o: C1Options): { processed: string[]; events: C1Event[]; warnings: string[] } {
  ensureState(db, o.startDate);
  const state = c1State(db)!;
  const events: C1Event[] = [];
  const warnings: string[] = [];
  const ref = series[o.benchmark];
  if (!ref?.length) return { processed: [], events, warnings: [`No ${o.benchmark} candles: cannot build the trading calendar.`] };

  const idx: Record<string, Map<string, number>> = {};
  const ctx: Record<string, Ctx> = {};
  for (const sym of o.universe) {
    const cs = series[sym] ?? [];
    idx[sym] = new Map(cs.map((c, i) => [dateOf(c.t), i]));
    ctx[sym] = buildCtx(cs);
  }
  const refIdx = new Map(ref.map((c, i) => [dateOf(c.t), i]));
  const refSma200 = sma(ref.map((c) => c.c), 200);
  const bps = s.slippageBps / 10_000;
  const days = ref.map((c) => dateOf(c.t)).filter((d) => d >= state.start_date && (state.last_processed_date === null || d > state.last_processed_date));
  const processed: string[] = [];

  for (const day of days) {
    const missing = o.universe.filter((sym) => !idx[sym]!.has(day));
    if (missing.length) {
      warnings.push(`Missing ${day} candle for ${missing.join(', ')}. Processing paused at this day until the data arrives.`);
      break;
    }
    const short = o.requireWarmup === false ? [] : o.universe.filter((sym) => idx[sym]!.get(day)! < TREND_FOLLOW.warmupBars);
    if (short.length) {
      warnings.push(`Not enough history before ${day} for ${short.join(', ')} (the rules need ${TREND_FOLLOW.warmupBars} earlier daily candles). Processing paused rather than skipping signals.`);
      break;
    }
    const barOf = (sym: string) => series[sym]![idx[sym]!.get(day)!]!;
    const prevClose = (t: C1TradeRow) => t.last_close ?? t.entry_fill;
    const exitedToday = new Set<string>();

    const close = (t: C1TradeRow, raw: number, fill: number, when: number, reason: string, bar: Candle) => {
      const fees = t.fees + sellFees(t.shares, fill, s);
      const pnl = t.shares * (fill - t.entry_fill) - fees;
      db.prepare("UPDATE c1_trades SET status = 'closed', exit_date = ?, exit_time = ?, exit_raw = ?, exit_fill = ?, exit_slippage = ?, fees = ?, pnl = ?, r_multiple = ?, exit_reason = ?, last_close = ?, last_close_date = ? WHERE id = ?").run(
        day, when, raw, fill, t.shares * Math.abs(raw - fill), fees, pnl, t.planned_risk > 0 ? pnl / t.planned_risk : 0, reason, bar.c, day, t.id,
      );
      exitedToday.add(t.symbol);
      events.push({ kind: 'exit', symbol: t.symbol, date: day, title: `C1 PAPER SELL — ${t.symbol} (simulated)`, detail: `${reason}. ${t.shares} sh at $${fill.toFixed(2)}; P&L ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)} (${(t.planned_risk > 0 ? pnl / t.planned_risk : 0).toFixed(2)}R).` });
    };
    const excursion = (t: C1TradeRow, low: number, high: number) => {
      db.prepare('UPDATE c1_trades SET mae = MIN(mae, ?), mfe = MAX(mfe, ?) WHERE id = ?').run(t.shares * (low - t.entry_fill), t.shares * (high - t.entry_fill), t.id);
    };

    db.transaction(() => {
      // 1) At the open: pending channel exits, then gaps through the stop.
      for (const t of openTrades(db)) {
        const bar = barOf(t.symbol);
        const pendingExit = db.prepare("SELECT id FROM c1_signals WHERE kind = 'exit' AND trade_id = ? AND status = 'pending'").get(t.id) as { id: number } | undefined;
        if (pendingExit) {
          excursion(t, bar.o, bar.o);
          close(t, bar.o, applySlippage(bar.o, 'sell', s), openTime(bar), 'channel exit (next open)', bar);
          db.prepare("UPDATE c1_signals SET status = 'executed', resolved_date = ? WHERE id = ?").run(day, pendingExit.id);
        } else if (bar.o <= t.stop) {
          excursion(t, bar.o, bar.o);
          close(t, bar.o, applySlippage(bar.o, 'sell', s), openTime(bar), `stop (gap below stop: opened $${bar.o.toFixed(2)}, stop $${t.stop.toFixed(2)})`, bar);
        }
      }

      // 2) At the open: entry signals from the previous session, in fixed universe order.
      const pending = db.prepare("SELECT * FROM c1_signals WHERE kind = 'entry' AND status = 'pending'").all() as { id: number; symbol: string; signal_date: string; stop: number }[];
      pending.sort((a, b) => o.universe.indexOf(a.symbol) - o.universe.indexOf(b.symbol));
      for (const sig of pending) {
        const skip = (why: string) => db.prepare("UPDATE c1_signals SET status = 'skipped', status_reason = ?, resolved_date = ? WHERE id = ?").run(why, day, sig.id);
        const bar = barOf(sig.symbol);
        const raw = bar.o;
        if (raw <= sig.stop) {
          skip(`Opened at $${raw.toFixed(2)}, at or below the stop $${sig.stop.toFixed(2)}.`);
          continue;
        }
        const acct = accountFor(db, s, day, o.killSwitchOn, prevClose);
        const size = sizePosition(raw, sig.stop, effectiveRiskPerTrade(s, acct.equity), acct.cash, s);
        if (size.problem !== null) {
          skip(size.problem);
          continue;
        }
        const guard = checkEntry(s, acct, { symbol: sig.symbol, qty: size.shares, notionalUsd: size.shares * raw * (1 + bps), maxLossUsd: size.maxLossAtStop }, openTime(bar));
        if (!guard.allowed) {
          skip(`Risk rules: ${guard.blocks.map((b) => b.message).join(' ')}`);
          continue;
        }
        const fill = applySlippage(raw, 'buy', s);
        const r = refIdx.get(day);
        const ma = r !== undefined ? refSma200[r] : null;
        const id = randomUUID();
        db.prepare(
          `INSERT INTO c1_trades (id, symbol, signal_date, entry_date, entry_time, entry_raw, entry_fill, shares, stop, planned_risk, entry_slippage, status, fees, regime, mae, mfe, bars_held, last_close, last_close_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, 0, 0, ?, ?)`,
        ).run(
          id, sig.symbol, sig.signal_date, day, openTime(bar), raw, fill, size.shares, sig.stop,
          size.shares * (raw - sig.stop) + estimateRoundTripCosts(size.shares, raw, sig.stop, s).total,
          size.shares * (fill - raw), s.commissionPerOrderUsd,
          ma == null ? 'unknown (under 200 days of benchmark data)' : ref[r!]!.c >= ma ? `${o.benchmark} above 200-day average` : `${o.benchmark} below 200-day average`,
          bar.c, day,
        );
        db.prepare("UPDATE c1_signals SET status = 'executed', trade_id = ?, resolved_date = ? WHERE id = ?").run(id, day, sig.id);
        events.push({ kind: 'entry', symbol: sig.symbol, date: day, title: `C1 PAPER BUY — ${sig.symbol} (simulated)`, detail: `${size.shares} sh at $${fill.toFixed(2)} (open $${raw.toFixed(2)} + slippage). Stop $${sig.stop.toFixed(2)}; planned risk about $${size.maxLossAtStop.toFixed(2)} — more if price gaps through the stop.` });
      }

      // 3) During the session: the stop. 4) At the close: time exit, then the channel-exit signal.
      for (const t of openTrades(db)) {
        const cs = series[t.symbol]!;
        const j = idx[t.symbol]!.get(day)!;
        const fillIdx = idx[t.symbol]!.get(t.entry_date);
        const bar = cs[j]!;
        if (fillIdx === undefined) {
          warnings.push(`${t.symbol}: entry day ${t.entry_date} is outside the loaded history; cannot manage the position.`);
          continue;
        }
        if (bar.l <= t.stop) {
          excursion(t, t.stop, Math.max(bar.o, t.entry_fill));
          close(t, t.stop, applySlippage(t.stop, 'sell', s), closeTime(bar), 'stop', bar);
          continue;
        }
        excursion(t, bar.l, bar.h);
        db.prepare('UPDATE c1_trades SET bars_held = ?, last_close = ?, last_close_date = ? WHERE id = ?').run(j - fillIdx, bar.c, day, t.id);
        if (j - fillIdx >= C1.maxHoldBars) {
          close(t, bar.c, applySlippage(bar.c, 'sell', s), closeTime(bar), `time exit (${C1.maxHoldBars} days)`, bar);
          continue;
        }
        if (j > fillIdx && j >= C1.lookback) {
          let low = Infinity;
          for (let k = j - C1.lookback; k < j; k++) low = Math.min(low, cs[k]!.l);
          if (bar.c < low) {
            db.prepare("INSERT OR IGNORE INTO c1_signals (kind, symbol, signal_date, signal_close, level, trade_id, status, created_at) VALUES ('exit', ?, ?, ?, ?, ?, 'pending', ?)").run(t.symbol, day, bar.c, low, t.id, o.now);
            events.push({ kind: 'signal', symbol: t.symbol, date: day, title: `C1 EXIT SIGNAL — ${t.symbol} (not yet a trade)`, detail: `Closed $${bar.c.toFixed(2)} below the 10-day low $${low.toFixed(2)}. Simulated sale at the next open.` });
          }
        }
      }

      // 5) At the close: new entry signals (not for a ticker that is held or was sold today — as in the research).
      const held = new Set(openTrades(db).map((t) => t.symbol));
      for (const sym of o.universe) {
        if (held.has(sym) || exitedToday.has(sym)) continue;
        const j = idx[sym]!.get(day)!;
        if (j < TREND_FOLLOW.warmupBars) continue;
        const sig = TREND_FOLLOW.signal(ctx[sym]!, j);
        if (!sig) continue;
        const cs = series[sym]!;
        let hh = -Infinity;
        for (let k = j - 20; k < j; k++) hh = Math.max(hh, cs[k]!.h);
        db.prepare("INSERT OR IGNORE INTO c1_signals (kind, symbol, signal_date, signal_close, level, stop, status, created_at) VALUES ('entry', ?, ?, ?, ?, ?, 'pending', ?)").run(sym, day, cs[j]!.c, hh, sig.stop, o.now);
        events.push({ kind: 'signal', symbol: sym, date: day, title: `C1 ENTRY SIGNAL — ${sym} (not yet a trade)`, detail: `Closed $${cs[j]!.c.toFixed(2)} above the 20-day high $${hh.toFixed(2)} and above its 100-day average. Simulated buy at the next open if the risk rules allow it.` });
      }

      // 6) Daily snapshot and benchmarks (defined in C1_PAPER_PROTOCOL.md).
      const open = openTrades(db);
      const invested = open.reduce((a, t) => a + t.shares * barOf(t.symbol).c, 0);
      const cash = c1Cash(db, s.startingCapitalUsd);
      const refBar = barOf(o.benchmark);
      const prev = db.prepare('SELECT * FROM c1_daily ORDER BY date DESC LIMIT 1').get() as { invested: number; bench_full_equity: number; bench_matched_equity: number; bench_close: number } | undefined;
      const benchFull = prev ? prev.bench_full_equity * (refBar.c / prev.bench_close) : s.startingCapitalUsd / (1 + bps);
      const benchMatched = prev ? prev.bench_matched_equity + prev.invested * (refBar.c / prev.bench_close - 1) : s.startingCapitalUsd;
      db.prepare('INSERT INTO c1_daily (date, equity, cash, invested, open_positions, bench_full_equity, bench_matched_equity, bench_close) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(day, cash + invested, cash, invested, open.length, benchFull, benchMatched, refBar.c);
      db.prepare('UPDATE c1_state SET last_processed_date = ? WHERE id = 1').run(day);
    }).immediate();
    processed.push(day);

    for (const sym of o.universe) {
      const j = idx[sym]!.get(day)!;
      if (j > 0) {
        const g = series[sym]![j]!.o / series[sym]![j - 1]!.c - 1;
        if (Math.abs(g) > 0.08) warnings.push(`${sym} gapped ${(g * 100).toFixed(1)}% on ${day}. Check whether this is real news or an unadjusted corporate action (split, spin-off).`);
      }
    }
  }
  return { processed, events, warnings };
}

// ---------------------------------------------------------------------------
// Runner, overview and metrics
// ---------------------------------------------------------------------------

export interface C1Deps {
  db: Db;
  market: { candles(symbol: string, tf: '1Day', limit: number): Promise<{ completed: Candle[] }>; provider: { lastDailyFeed?: string | null } };
  now: () => number;
}

/** Fetches completed daily candles for the universe and processes any new days. Safe to call often. */
export async function runC1(deps: C1Deps, s: RiskSettings, killSwitchOn: boolean): Promise<{ processed: string[]; events: C1Event[]; warnings: string[]; error: string | null }> {
  const { db } = deps;
  ensureState(db, C1.startDate);
  db.prepare('UPDATE c1_state SET last_run_at = ? WHERE id = 1').run(deps.now());
  const series: Record<string, Candle[]> = {};
  const warnings: string[] = [];
  try {
    for (const sym of C1.universe) series[sym] = (await deps.market.candles(sym, '1Day', 520)).completed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare('UPDATE c1_state SET last_error = ?, last_error_at = ? WHERE id = 1').run(msg, deps.now());
    return { processed: [], events: [], warnings: [], error: msg };
  }
  if (deps.market.provider.lastDailyFeed === 'iex') {
    warnings.push('Daily candles came from the IEX feed (the consolidated feed was refused). IEX volume and prices differ slightly from what C1 was researched on.');
  }
  const r = processC1(db, series, s, { universe: C1.universe, benchmark: C1.benchmark, startDate: C1.startDate, killSwitchOn, now: deps.now(), requireWarmup: true });
  const all = [...warnings, ...r.warnings];
  db.prepare('UPDATE c1_state SET last_success_at = ?, last_error = NULL, warnings_json = ? WHERE id = 1').run(deps.now(), JSON.stringify(all));
  return { ...r, warnings: all, error: null };
}

export interface SeriesStats {
  days: number;
  netReturnPct: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  /** Annualised standard deviation of daily returns, %. Null below 20 days. */
  volatilityPct: number | null;
  /** Annualised mean ÷ volatility. Null below 60 days — not meaningful on less. */
  sharpeLike: number | null;
}

export function seriesStats(values: number[], start: number): SeriesStats {
  let peak = start;
  let dd = 0;
  let ddPct = 0;
  const rets: number[] = [];
  let prev = start;
  for (const v of values) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, peak - v);
    ddPct = Math.max(ddPct, peak > 0 ? (peak - v) / peak : 0);
    rets.push(prev > 0 ? v / prev - 1 : 0);
    prev = v;
  }
  const n = rets.length;
  const mean = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    days: n,
    netReturnPct: n ? (values[n - 1]! / start - 1) * 100 : null,
    maxDrawdownPct: ddPct * 100,
    maxDrawdownUsd: dd,
    volatilityPct: n >= 20 ? sd * Math.sqrt(252) * 100 : null,
    sharpeLike: n >= 60 && sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
  };
}

/** Recorded once, from `npm run research -- c1-feasibility` (2026-10-29). Planning context only. */
export const C1_FEASIBILITY = {
  medianTradesPerYear: 14,
  shareOfSignalsSkippedForOpenRisk: 0.88,
  note: 'In one $100 account with the $2 max-open-risk limit, at most two C1 positions fit at once. Replaying 2016–2026 gave a median of 14 trades a year, so 30 trades will likely take about two years. Risk limits are not raised to speed this up.',
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function c1Metrics(closed: C1TradeRow[]) {
  const pnl = closed.map((t) => t.pnl ?? 0);
  const wins = pnl.filter((x) => x > 0);
  const losses = pnl.filter((x) => x <= 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const rs = closed.map((t) => t.r_multiple ?? 0);
  return {
    trades: closed.length,
    netPnl: pnl.reduce((a, b) => a + b, 0),
    expectancy: mean(pnl),
    avgR: mean(rs),
    winRate: closed.length ? wins.length / closed.length : null,
    profitFactor: grossLoss > 0 ? wins.reduce((a, b) => a + b, 0) / grossLoss : null,
    avgWin: mean(wins),
    avgLoss: mean(losses),
    totalSlippage: closed.reduce((a, t) => a + t.entry_slippage + (t.exit_slippage ?? 0), 0),
    totalFees: closed.reduce((a, t) => a + t.fees, 0),
    avgMae: mean(closed.map((t) => t.mae)),
    avgMfe: mean(closed.map((t) => t.mfe)),
    gapStops: closed.filter((t) => (t.exit_reason ?? '').startsWith('stop (gap')).length,
    worstR: rs.length ? Math.min(...rs) : null,
  };
}

/** Everything the C1 page shows. Candles come from the cached market service; the ledger from the c1_* tables. */
export async function c1Overview(deps: C1Deps, s: RiskSettings) {
  const { db } = deps;
  ensureState(db, C1.startDate);
  const state = c1State(db)!;
  const now = deps.now();
  const series: Record<string, Candle[]> = {};
  let dataError: string | null = null;
  try {
    for (const sym of C1.universe) series[sym] = (await deps.market.candles(sym, '1Day', 520)).completed;
  } catch (e) {
    dataError = e instanceof Error ? e.message : String(e);
  }

  const trades = db.prepare('SELECT * FROM c1_trades ORDER BY entry_time DESC').all() as C1TradeRow[];
  const open = trades.filter((t) => t.status === 'open');
  const closed = trades.filter((t) => t.status === 'closed').reverse();
  const daily = db.prepare('SELECT * FROM c1_daily ORDER BY date').all() as { date: string; equity: number; invested: number; open_positions: number; bench_full_equity: number; bench_matched_equity: number }[];
  const start = s.startingCapitalUsd;

  const warnings: string[] = JSON.parse(state.warnings_json);
  if (dataError) warnings.unshift(`Could not load daily candles: ${dataError}`);
  const latestRef = series[C1.benchmark]?.at(-1);
  if (latestRef && state.last_processed_date && dateOf(latestRef.t) > state.last_processed_date) warnings.unshift(`Processing is behind: data exists through ${dateOf(latestRef.t)} but C1 has processed through ${state.last_processed_date}.`);
  if (state.last_success_at && now - state.last_success_at > 36 * 3_600_000) warnings.unshift(`No successful C1 update for ${Math.round((now - state.last_success_at) / 3_600_000)} hours. Is the monitor running?`);
  if (!state.last_success_at) warnings.unshift('C1 has not processed any data yet. It updates when the monitor runs (or press "Process now").');

  const watch = C1.universe.map((sym) => {
    const cs = series[sym];
    if (!cs || cs.length < 120) return { symbol: sym, available: false };
    const j = cs.length - 1;
    const c = cs[j]!;
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = j - 19; k <= j; k++) hh = Math.max(hh, cs[k]!.h);
    for (let k = j - 9; k <= j; k++) ll = Math.min(ll, cs[k]!.l);
    const ma100 = sma(cs.map((x) => x.c), 100)[j] ?? null;
    const pos = open.find((t) => t.symbol === sym) ?? null;
    return {
      symbol: sym,
      available: true,
      date: dateOf(c.t),
      close: c.c,
      sma100: ma100,
      trendFilter: ma100 !== null && c.c > ma100,
      /** The next completed close must be ABOVE this for an entry signal. */
      entryLevel: hh,
      distanceToEntryPct: ((hh - c.c) / c.c) * 100,
      held: pos !== null,
      /** For a held position: the next close must stay at or above this, or it exits at the following open. */
      exitLevel: pos ? ll : null,
      stop: pos?.stop ?? null,
    };
  });

  const eq = daily.map((d) => d.equity);
  const exposureDays = daily.filter((d) => d.open_positions > 0).length;
  return {
    label: C1.label,
    strategyId: C1.strategyId,
    rules: C1.rules,
    universe: C1.universe,
    benchmark: { symbol: C1.benchmark, definitions: BENCHMARK_DEFINITIONS },
    protocol: { startDate: state.start_date, minTrades: C1.minTradesForEvaluation, closedTrades: closed.length, feasibility: C1_FEASIBILITY },
    status: { lastProcessedDate: state.last_processed_date, lastRunAt: state.last_run_at, lastSuccessAt: state.last_success_at, lastError: state.last_error, lastErrorAt: state.last_error_at, warnings },
    signals: {
      pending: db.prepare("SELECT * FROM c1_signals WHERE status = 'pending' ORDER BY signal_date DESC, symbol").all(),
      recent: db.prepare("SELECT * FROM c1_signals WHERE status != 'pending' ORDER BY resolved_date DESC, id DESC LIMIT 30").all(),
    },
    watch,
    open: open.map((t) => ({ ...t, unrealizedPnl: t.last_close !== null ? t.shares * (t.last_close - t.entry_fill) - t.fees : null, marketValue: t.last_close !== null ? t.shares * t.last_close : null })),
    closed: closed.slice().reverse(),
    metrics: c1Metrics(closed),
    byRegime: Object.entries(
      closed.reduce<Record<string, C1TradeRow[]>>((m, t) => ((m[t.regime] ??= []).push(t), m), {}),
    ).map(([regime, ts]) => ({ regime, ...c1Metrics(ts) })),
    account: {
      cash: c1Cash(db, start),
      equity: eq.at(-1) ?? start,
      realizedPnl: closed.reduce((a, t) => a + (t.pnl ?? 0), 0),
      unrealizedPnl: open.reduce((a, t) => a + (t.last_close !== null ? t.shares * (t.last_close - t.entry_fill) - t.fees : 0), 0),
    },
    comparison: {
      days: daily.length,
      c1: { ...seriesStats(eq, start), exposureDaysPct: daily.length ? (exposureDays / daily.length) * 100 : null, avgInvestedPct: mean(daily.map((d) => (d.equity > 0 ? (d.invested / d.equity) * 100 : 0))) },
      buyAndHold: seriesStats(daily.map((d) => d.bench_full_equity), start),
      sameExposure: seriesStats(daily.map((d) => d.bench_matched_equity), start),
      equityCurve: daily.map((d) => ({ date: d.date, c1: d.equity, buyAndHold: d.bench_full_equity, sameExposure: d.bench_matched_equity })),
      note: 'Daily-close values. Too few days or trades make every number here unreliable; nothing is shown as risk-adjusted until there are 60 trading days.',
    },
  };
}

export const BENCHMARK_DEFINITIONS = [
  'Buy-and-hold: the full starting capital put into SPY at the close of the start date (5 bps slippage), held, cash 0%.',
  'Same exposure: each day holds SPY worth exactly what C1 had invested at the previous close; the rest sits in cash at 0%. This asks whether C1\'s picks beat simply being in SPY with the same money.',
  'Both use split-adjusted closes without dividends, like C1 itself. Same-exposure ignores the cost of rebalancing (slightly flatters the benchmark).',
];
