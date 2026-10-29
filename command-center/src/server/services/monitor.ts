import { randomUUID } from 'node:crypto';
import { alertTriggered, evaluatePosition, nearStop, paperBuyFill, type PaperPosition } from '../../engine/orders.js';
import type { Quote } from '../../engine/plan.js';
import { nyParts } from '../../engine/time.js';
import type { Timeframe } from '../../engine/types.js';
import { getKillSwitch, getSettings, type Db } from '../db.js';
import { logger } from '../logger.js';
import { openPositions, type PositionRow } from './account.js';
import { runC1 } from './c1.js';
import type { Deps } from './analysis.js';
import { describeError } from './market.js';
import { expireOrders, getOrder, openPaperPosition, recordSell, type OrderRow } from './trading.js';

export type AlertCategory = 'PRICE_ALERT' | 'SIMULATED_ORDER' | 'SYSTEM';

export interface NewAlert {
  dedupKey: string;
  category: AlertCategory;
  mode: 'paper' | 'live' | null;
  symbol: string | null;
  title: string;
  reason: string;
  price: number | null;
  priceAt: number | null;
}

export type Notifier = (alert: NewAlert) => Promise<void>;

/** Stores an alert once. Returns false when the same event was already recorded. */
export function recordAlert(db: Db, a: NewAlert, now: number): boolean {
  const res = db
    .prepare('INSERT OR IGNORE INTO alert_events (dedup_key, category, mode, symbol, title, reason, price, price_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.dedupKey, a.category, a.mode, a.symbol, a.title, a.reason, a.price, a.priceAt, now);
  return res.changes > 0;
}

export interface MonitorStatus {
  state: 'ok' | 'stale' | 'never_ran' | 'error';
  message: string;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  nextRunAt: number | null;
  intervalSec: number | null;
  marketOpen: boolean | null;
  symbolsChecked: number | null;
  owner: string | null;
}

export function monitorStatus(db: Db, now: number): MonitorStatus {
  const r = db.prepare('SELECT * FROM monitor_state WHERE id = 1').get() as Record<string, number | string | null>;
  const lastSuccess = (r.last_success_at as number | null) ?? null;
  const interval = (r.interval_sec as number | null) ?? null;
  const base = {
    lastRunAt: (r.last_run_at as number | null) ?? null,
    lastSuccessAt: lastSuccess,
    lastError: (r.last_error as string | null) ?? null,
    lastErrorAt: (r.last_error_at as number | null) ?? null,
    nextRunAt: (r.next_run_at as number | null) ?? null,
    intervalSec: interval,
    marketOpen: r.market_open === null || r.market_open === undefined ? null : r.market_open === 1,
    symbolsChecked: (r.symbols_checked as number | null) ?? null,
    owner: (r.owner as string | null) ?? null,
  };
  if (!base.lastRunAt) return { ...base, state: 'never_ran', message: 'The monitor has never run. Positions and alerts are NOT being checked.' };
  const allowed = Math.max(3 * (interval ?? 60), 180) * 1000;
  if (now - base.lastRunAt > allowed) {
    return { ...base, state: 'stale', message: `The monitor has not run since ${new Date(base.lastRunAt).toISOString()}. It may have stopped. Positions and alerts are NOT being checked.` };
  }
  if (base.lastErrorAt && (!lastSuccess || base.lastErrorAt > lastSuccess)) {
    return { ...base, state: 'error', message: `The last check failed: ${base.lastError}` };
  }
  return { ...base, state: 'ok', message: `Checking every ${interval}s. Checks are periodic, not continuous.` };
}

const LEASE_MS = 5 * 60_000;

/** Only one monitor may work at a time, so an in-process monitor and a separate worker never double-fill. */
export function acquireLease(db: Db, owner: string, now: number): boolean {
  const res = db.prepare('UPDATE monitor_state SET owner = ?, lease_until = ? WHERE id = 1 AND (owner IS NULL OR owner = ? OR lease_until < ?)').run(owner, now + LEASE_MS, owner, now);
  return res.changes > 0;
}

export function releaseLease(db: Db, owner: string) {
  db.prepare('UPDATE monitor_state SET owner = NULL, lease_until = NULL WHERE id = 1 AND owner = ?').run(owner);
}

export interface CycleResult {
  ran: boolean;
  marketOpen: boolean | null;
  symbols: number;
  alerts: NewAlert[];
  error: string | null;
}

/**
 * One monitoring pass. Simulated exits only happen on fresh prices during
 * regular hours — a stale or after-hours price never moves paper money.
 */
export async function runMonitorCycle(deps: Deps, owner: string, notify: Notifier | null = null): Promise<CycleResult> {
  const { db } = deps;
  const start = deps.now();
  if (!acquireLease(db, owner, start)) return { ran: false, marketOpen: null, symbols: 0, alerts: [], error: 'Another monitor holds the lease.' };
  db.prepare('UPDATE monitor_state SET last_run_at = ? WHERE id = 1').run(start);

  const created: NewAlert[] = [];
  const emit = (a: NewAlert) => {
    if (recordAlert(db, a, deps.now())) created.push(a);
  };
  const s = getSettings(db);
  const clock = await deps.market.clock();
  const marketOpen = clock ? clock.isOpen : null;

  db.transaction(() => expireOrders(db, deps.now()))();
  if (getKillSwitch(db).on) {
    for (const o of db.prepare("SELECT * FROM orders WHERE status = 'working'").all() as OrderRow[]) {
      db.prepare("UPDATE orders SET status = 'cancelled', status_reason = 'Kill switch is on.', updated_at = ? WHERE id = ? AND status = 'working'").run(deps.now(), o.id);
    }
  }

  const positions = [...openPositions(db, 'paper'), ...openPositions(db, 'live')];
  const working = db.prepare("SELECT * FROM orders WHERE status = 'working'").all() as OrderRow[];
  const rules = db.prepare("SELECT * FROM alert_rules WHERE status = 'armed'").all() as { id: number; symbol: string; kind: 'price_above' | 'price_below'; price: number; note: string | null }[];
  const symbols = [...new Set([...positions.map((p) => p.symbol), ...working.map((o) => o.symbol), ...rules.map((r) => r.symbol)])];

  let quotes = new Map<string, Quote>();
  let error: string | null = null;
  if (symbols.length) {
    try {
      quotes = await deps.market.quotes(symbols, { fresh: true });
    } catch (e) {
      error = describeError(e).message;
      const hour = Math.floor(deps.now() / 3_600_000);
      emit({ dedupKey: `system:data:${hour}`, category: 'SYSTEM', mode: null, symbol: null, title: 'Market data unavailable', reason: `${error} Positions could not be checked.`, price: null, priceAt: null });
    }
  }

  const now = deps.now();
  const slot = Math.floor(now / (15 * 60_000));
  const freshQuote = (sym: string): Quote | null => {
    const q = quotes.get(sym);
    if (!q) return null;
    if (marketOpen && (now - q.time) / 1000 > s.maxQuoteAgeSeconds) {
      emit({ dedupKey: `system:stale:${sym}:${slot}`, category: 'SYSTEM', mode: null, symbol: sym, title: `${sym} price is stale`, reason: `The latest ${sym} trade is ${Math.round((now - q.time) / 1000)}s old. No simulated orders were processed on it.`, price: q.price, priceAt: q.time });
      return null;
    }
    return q;
  };
  if (!error) for (const sym of symbols) if (!quotes.has(sym)) emit({ dedupKey: `system:missing:${sym}:${slot}`, category: 'SYSTEM', mode: null, symbol: sym, title: `No price for ${sym}`, reason: `The data source returned no price for ${sym}.`, price: null, priceAt: null });

  const canSimulate = marketOpen === true;

  // 1) Working paper limit orders.
  for (const o of working) {
    const q = freshQuote(o.symbol);
    if (!q || !canSimulate || o.mode !== 'paper') continue;
    const fill = paperBuyFill('limit', o.limit_price, q.price, s);
    if (fill === null) continue;
    try {
      db.transaction(() => {
        const cur = getOrder(db, o.id);
        if (cur?.status !== 'working') return;
        openPaperPosition(db, cur, fill, now, `Simulated limit buy at $${fill.toFixed(2)}: price $${q.price.toFixed(2)} reached the $${o.limit_price!.toFixed(2)} limit.`);
      }).immediate();
      emit({ dedupKey: `order:${o.id}:filled`, category: 'SIMULATED_ORDER', mode: 'paper', symbol: o.symbol, title: `PAPER BUY FILLED — ${o.symbol}`, reason: `Simulated limit buy of ${o.qty} at $${fill.toFixed(2)}. No real money was used.`, price: q.price, priceAt: q.time });
    } catch (e) {
      emit({ dedupKey: `order:${o.id}:fillerror`, category: 'SYSTEM', mode: 'paper', symbol: o.symbol, title: `Paper fill failed — ${o.symbol}`, reason: describeError(e).message, price: q.price, priceAt: q.time });
    }
  }

  // 2) Open positions: P&L, stops, targets, thesis.
  for (const p of positions) {
    const q = freshQuote(p.symbol);
    if (!q) continue;
    db.prepare('UPDATE positions SET last_price = ?, last_price_at = ? WHERE id = ?').run(q.price, q.time, p.id);
    const pp: PaperPosition = { qtyOpen: p.qty_open, qtyInitial: p.qty_initial, entryPrice: p.entry_price, stop: p.stop, tp1: p.tp1, tp2: p.tp2, tp1Done: p.tp1_done === 1, fractional: s.allowFractional };

    if (p.mode === 'paper') {
      if (canSimulate) {
        for (const act of evaluatePosition(pp, q.price, s)) {
          db.transaction(() => {
            const cur = db.prepare("SELECT * FROM positions WHERE id = ? AND status = 'open'").get(p.id) as PositionRow | undefined;
            if (!cur) return;
            recordSell(db, cur, act.qty, act.fillPrice, act.fees, `${act.kind}: ${act.reason}`, now, act.kind.toLowerCase());
            if (act.kind === 'TP1') db.prepare('UPDATE positions SET tp1_done = 1, stop = MAX(stop, entry_price) WHERE id = ?').run(p.id);
          }).immediate();
          emit({ dedupKey: `pos:${p.id}:${act.kind}`, category: 'SIMULATED_ORDER', mode: 'paper', symbol: p.symbol, title: `PAPER ${act.kind.replace('_', ' ')} — ${p.symbol}`, reason: `${act.reason} Simulated sale of ${act.qty} share(s). No real money was used.`, price: q.price, priceAt: q.time });
        }
      }
    } else {
      // Real positions: alerts only. The app cannot see or touch your Robinhood orders.
      const stopLevel = pp.tp1Done ? Math.max(p.stop, p.entry_price) : p.stop;
      if (q.price <= stopLevel) emit({ dedupKey: `pos:${p.id}:stop`, category: 'PRICE_ALERT', mode: 'live', symbol: p.symbol, title: `STOP LEVEL REACHED — ${p.symbol} (alert, not an order)`, reason: `Price $${q.price.toFixed(2)} is at or below your stop $${stopLevel.toFixed(2)}. Check Robinhood: did your stop order fill? If you had no stop order, your plan says exit.`, price: q.price, priceAt: q.time });
      if (q.price >= p.tp1) emit({ dedupKey: `pos:${p.id}:tp1`, category: 'PRICE_ALERT', mode: 'live', symbol: p.symbol, title: `TP1 REACHED — ${p.symbol} (alert, not an order)`, reason: `Price $${q.price.toFixed(2)} reached take-profit 1 ($${p.tp1.toFixed(2)}). Your plan: consider selling part and moving the stop to breakeven.`, price: q.price, priceAt: q.time });
      if (q.price >= p.tp2) emit({ dedupKey: `pos:${p.id}:tp2`, category: 'PRICE_ALERT', mode: 'live', symbol: p.symbol, title: `TP2 REACHED — ${p.symbol} (alert, not an order)`, reason: `Price $${q.price.toFixed(2)} reached take-profit 2 ($${p.tp2.toFixed(2)}).`, price: q.price, priceAt: q.time });
    }
    if (nearStop(pp, q.price)) emit({ dedupKey: `pos:${p.id}:nearstop:${nyParts(now).dateKey}`, category: 'PRICE_ALERT', mode: p.mode, symbol: p.symbol, title: `${p.symbol} is near its stop`, reason: `Price $${q.price.toFixed(2)} is close to the stop. This is a price alert, not an order.`, price: q.price, priceAt: q.time });

    if (p.invalidation_price !== null) {
      try {
        const set = await deps.market.candles(p.symbol, p.timeframe as Timeframe, 40);
        const last = set.completed.at(-1);
        if (last && last.t >= p.opened_at && last.c < p.invalidation_price) {
          emit({ dedupKey: `pos:${p.id}:thesis`, category: 'PRICE_ALERT', mode: p.mode, symbol: p.symbol, title: `THESIS INVALID — ${p.symbol}`, reason: `A completed ${p.timeframe} candle closed at $${last.c.toFixed(2)}, below the invalidation level $${p.invalidation_price.toFixed(2)}. The reason for the trade no longer holds. Consider exiting. (Alert only — nothing was sold.)`, price: last.c, priceAt: last.t });
        }
      } catch (e) {
        logger.warn('thesis check failed', { symbol: p.symbol, error: describeError(e).message });
      }
    }
  }

  // 3) Price alert rules (one-shot).
  for (const r of rules) {
    const q = freshQuote(r.symbol);
    if (!q || !alertTriggered(r, q.price)) continue;
    db.prepare("UPDATE alert_rules SET status = 'triggered', triggered_at = ? WHERE id = ? AND status = 'armed'").run(now, r.id);
    emit({ dedupKey: `rule:${r.id}`, category: 'PRICE_ALERT', mode: null, symbol: r.symbol, title: `PRICE ALERT — ${r.symbol} ${r.kind === 'price_above' ? '≥' : '≤'} $${r.price.toFixed(2)}`, reason: `${r.symbol} traded at $${q.price.toFixed(2)}.${r.note ? ` Note: ${r.note}` : ''} This is an alert, not an order.`, price: q.price, priceAt: q.time });
  }

  // 4) C1 experimental paper portfolio (daily candles; isolated c1_* tables).
  try {
    const c1 = await runC1(deps, s, getKillSwitch(db).on);
    for (const ev of c1.events.filter((e) => e.kind === 'entry' || e.kind === 'exit')) {
      emit({ dedupKey: `c1:${ev.kind}:${ev.symbol}:${ev.date}`, category: 'SIMULATED_ORDER', mode: 'paper', symbol: ev.symbol, title: `[C1 EXPERIMENTAL] ${ev.title}`, reason: `${ev.detail} Simulated market-on-open/stop fill from completed daily candles. No real money was used.`, price: null, priceAt: null });
    }
    const today = nyParts(now).dateKey;
    for (const w of c1.warnings) emit({ dedupKey: `c1:warn:${today}:${w.slice(0, 80)}`, category: 'SYSTEM', mode: null, symbol: null, title: 'C1 data-quality warning', reason: w, price: null, priceAt: null });
    if (c1.error) emit({ dedupKey: `c1:error:${today}`, category: 'SYSTEM', mode: null, symbol: null, title: 'C1 could not update', reason: c1.error, price: null, priceAt: null });
  } catch (e) {
    logger.warn('C1 processing failed', { error: describeError(e).message });
  }

  const end = deps.now();
  db.prepare('UPDATE monitor_state SET last_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_success_at END, last_error = ?, last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END, market_open = ?, symbols_checked = ? WHERE id = 1').run(
    error,
    end,
    error,
    error,
    end,
    marketOpen === null ? null : marketOpen ? 1 : 0,
    symbols.length,
  );

  if (notify) for (const a of created) await notify(a).catch((e) => logger.warn('notification failed', { error: String(e) }));
  return { ran: true, marketOpen, symbols: symbols.length, alerts: created, error };
}

/** Optional push notifications through ntfy (https://ntfy.sh), which has a free phone app. */
export function ntfyNotifier(url: string, fetchImpl: typeof fetch = fetch): Notifier {
  return async (a) => {
    await fetchImpl(url, {
      method: 'POST',
      headers: { Title: a.title.replace(/[^\x20-\x7E]/g, '-'), Tags: a.category === 'SIMULATED_ORDER' ? 'memo' : a.category === 'SYSTEM' ? 'warning' : 'bell', Priority: a.title.includes('STOP') || a.title.includes('THESIS') ? 'high' : 'default' },
      body: `[${a.category.replace('_', ' ')}] ${a.reason}`,
      signal: AbortSignal.timeout(5000),
    });
  };
}

export interface Scheduler {
  stop(): void;
  owner: string;
}

/**
 * Runs cycles on a schedule: every MONITOR_INTERVAL_SECONDS while the market
 * is open, less often when it is closed. Each cycle is awaited before the next
 * is scheduled, so cycles never overlap.
 */
export function startScheduler(deps: Deps, opts: { intervalSec: number; offHoursSec: number; notify: Notifier | null; owner?: string }): Scheduler {
  const owner = opts.owner ?? `monitor-${process.pid}-${randomUUID().slice(0, 8)}`;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const tick = async () => {
    let delay = opts.intervalSec;
    try {
      const r = await runMonitorCycle(deps, owner, opts.notify);
      if (r.ran && r.marketOpen === false) delay = opts.offHoursSec;
      if (!r.ran) delay = Math.max(opts.intervalSec, 60);
    } catch (e) {
      const msg = describeError(e).message;
      logger.error('monitor cycle crashed', { error: msg });
      deps.db.prepare('UPDATE monitor_state SET last_error = ?, last_error_at = ? WHERE id = 1').run(msg, deps.now());
    }
    if (stopped) return;
    deps.db.prepare('UPDATE monitor_state SET next_run_at = ?, interval_sec = ? WHERE id = 1').run(deps.now() + delay * 1000, delay);
    timer = setTimeout(tick, delay * 1000);
  };
  void tick();
  return {
    owner,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      releaseLease(deps.db, owner);
    },
  };
}
