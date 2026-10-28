import type { AccountState } from '../../engine/risk.js';
import type { RiskSettings } from '../../engine/settings.js';
import { nyParts } from '../../engine/time.js';
import { getKillSwitch, getKv, type Db, type Mode } from '../db.js';

export interface PositionRow {
  id: string;
  mode: Mode;
  order_id: string | null;
  symbol: string;
  timeframe: string;
  setup_type: string | null;
  qty_initial: number;
  qty_open: number;
  entry_price: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp1_done: number;
  invalidation_price: number | null;
  planned_loss: number;
  status: 'open' | 'closed';
  realized_pnl: number;
  exit_reason: string | null;
  opened_at: number;
  closed_at: number | null;
  last_price: number | null;
  last_price_at: number | null;
}

export interface AccountSummary {
  mode: Mode;
  startingCapital: number;
  cash: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  todayRealizedPnl: number;
  openPositions: number;
  openRiskUsd: number;
  /** Real-money capital is only known once the user enters it. */
  capitalKnown: boolean;
}

export function startingCapital(db: Db, mode: Mode, s: RiskSettings): number | null {
  if (mode === 'paper') return s.startingCapitalUsd;
  return getKv<number>(db, 'live_capital_usd');
}

export function openPositions(db: Db, mode: Mode): PositionRow[] {
  return db.prepare("SELECT * FROM positions WHERE mode = ? AND status = 'open' ORDER BY opened_at").all(mode) as PositionRow[];
}

/** Money at stake right now if every open stop were hit at its price. */
export function positionRisk(p: PositionRow): number {
  const stop = p.tp1_done ? Math.max(p.stop, p.entry_price) : p.stop;
  return Math.max(0, p.entry_price - stop) * p.qty_open;
}

export function summarize(db: Db, mode: Mode, s: RiskSettings, now: number): AccountSummary {
  const start = startingCapital(db, mode, s);
  const flows = db
    .prepare("SELECT COALESCE(SUM(CASE WHEN side = 'sell' THEN qty * price - fees ELSE -(qty * price + fees) END), 0) AS net, COALESCE(SUM(realized_pnl), 0) AS realized FROM fills WHERE mode = ?")
    .get(mode) as { net: number; realized: number };
  const open = openPositions(db, mode);
  const marketValue = open.reduce((sum, p) => sum + p.qty_open * (p.last_price ?? p.entry_price), 0);
  const unrealized = open.reduce((sum, p) => sum + p.qty_open * ((p.last_price ?? p.entry_price) - p.entry_price), 0);
  const cash = (start ?? 0) + flows.net;
  return {
    mode,
    startingCapital: start ?? 0,
    cash,
    equity: cash + marketValue,
    realizedPnl: flows.realized,
    unrealizedPnl: unrealized,
    todayRealizedPnl: todayRealized(db, mode, now),
    openPositions: open.length,
    openRiskUsd: open.reduce((sum, p) => sum + positionRisk(p), 0),
    capitalKnown: start !== null,
  };
}

function todayBounds(now: number): (t: number) => boolean {
  const today = nyParts(now).dateKey;
  return (t: number) => nyParts(t).dateKey === today;
}

function todayRealized(db: Db, mode: Mode, now: number): number {
  const isToday = todayBounds(now);
  const rows = db.prepare("SELECT realized_pnl, at FROM fills WHERE mode = ? AND side = 'sell' AND at > ?").all(mode, now - 2 * 86_400_000) as { realized_pnl: number; at: number }[];
  return rows.filter((r) => isToday(r.at)).reduce((sum, r) => sum + r.realized_pnl, 0);
}

/** Builds the state the risk guard needs, entirely from recorded data. */
export function accountState(db: Db, mode: Mode, s: RiskSettings, now: number): AccountState {
  const sum = summarize(db, mode, s, now);
  const isToday = todayBounds(now);
  const recent = now - 2 * 86_400_000;
  const entries = db.prepare("SELECT at FROM fills WHERE mode = ? AND side = 'buy' AND at > ?").all(mode, recent) as { at: number }[];
  const closedToday = (db.prepare("SELECT symbol, realized_pnl, closed_at FROM positions WHERE mode = ? AND status = 'closed' AND closed_at > ? ORDER BY closed_at DESC").all(mode, recent) as { symbol: string; realized_pnl: number; closed_at: number }[]).filter((p) => isToday(p.closed_at));
  let consecutive = 0;
  for (const p of closedToday) {
    if (p.realized_pnl < 0) consecutive++;
    else break;
  }
  const lastLoss = db.prepare("SELECT symbol, closed_at FROM positions WHERE mode = ? AND status = 'closed' AND realized_pnl < 0 ORDER BY closed_at DESC LIMIT 1").get(mode) as { symbol: string; closed_at: number } | undefined;
  const working = db.prepare("SELECT symbol, side, qty, created_at FROM orders WHERE mode = ? AND status = 'working'").all(mode) as { symbol: string; side: 'buy' | 'sell'; qty: number; created_at: number }[];

  return {
    equity: sum.equity,
    cash: sum.cash,
    openRiskUsd: sum.openRiskUsd,
    openSymbols: openPositions(db, mode).map((p) => p.symbol),
    workingOrders: working.map((o) => ({ symbol: o.symbol, side: o.side, qty: o.qty, createdAt: o.created_at })),
    todayRealizedPnl: sum.todayRealizedPnl,
    tradesToday: entries.filter((e) => isToday(e.at)).length,
    consecutiveLossesToday: consecutive,
    lastLoss: lastLoss ? { symbol: lastLoss.symbol, at: lastLoss.closed_at } : null,
    lossSymbolsToday: [...new Set(closedToday.filter((p) => p.realized_pnl < 0).map((p) => p.symbol))],
    killSwitch: getKillSwitch(db).on,
  };
}

export function lastClosedWasLoss(db: Db): boolean {
  const row = db.prepare("SELECT realized_pnl FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 1").get() as { realized_pnl: number } | undefined;
  return row ? row.realized_pnl < 0 : false;
}
