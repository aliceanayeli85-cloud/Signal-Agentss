import { randomUUID } from 'node:crypto';
import { applySlippage, sellFees } from '../../engine/costs.js';
import { assertTransition, paperBuyFill, PREVIEW_TTL_MS, type OrderStatus } from '../../engine/orders.js';
import { formatShares, type TradePlan } from '../../engine/plan.js';
import { checkEntry, type Block } from '../../engine/risk.js';
import type { Timeframe } from '../../engine/types.js';
import { getKillSwitch, getSettings, logRiskEvent, setKv, type Db, type Mode } from '../db.js';
import { accountState, type PositionRow } from './account.js';
import { analyzeSymbol, type Deps } from './analysis.js';
import { describeError } from './market.js';

export class TradingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export interface OrderRow {
  id: string;
  idempotency_key: string;
  mode: Mode;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  order_type: 'market' | 'limit';
  limit_price: number | null;
  est_price: number;
  stop: number;
  tp1: number;
  tp2: number;
  invalidation_price: number | null;
  planned_loss: number;
  timeframe: Timeframe;
  setup_type: string | null;
  plan_json: string;
  status: OrderStatus;
  status_reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  approved_at: number | null;
}

interface StoredPlan {
  plan: TradePlan;
  maxFillPrice: number;
}

export const PROTECTIVE_ORDER_NOTES = [
  'In PAPER mode the stop and targets are simulated by the monitor. They are checked periodically, not continuously, and only during regular market hours.',
  'A real stop order becomes a market order when triggered and can fill below the stop price, especially on a gap.',
  'On Robinhood, place any protective stop yourself and confirm it shows as "Queued" or "Placed". Stop orders may not be available for fractional quantities; if not, you must watch the position.',
];

export interface OrderPreview {
  id: string;
  idempotencyKey: string;
  mode: Mode;
  status: OrderStatus;
  symbol: string;
  side: 'buy';
  qty: number;
  qtyLabel: string;
  orderType: 'market' | 'limit';
  limitPrice: number | null;
  estimatedPrice: number;
  estimatedValue: number;
  stop: number;
  tp1: number;
  tp2: number;
  plannedRisk: number;
  potentialLoss: string;
  warnings: string[];
  protectiveOrders: string[];
  expiresAt: number;
  plan: TradePlan;
}

export function getOrder(db: Db, id: string): OrderRow | null {
  return (db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined) ?? null;
}

function setStatus(db: Db, order: OrderRow, to: OrderStatus, reason: string | null, now: number) {
  assertTransition(order.status, to);
  db.prepare('UPDATE orders SET status = ?, status_reason = ?, updated_at = ?, approved_at = CASE WHEN ? IN (\'working\',\'filled\') THEN COALESCE(approved_at, ?) ELSE approved_at END WHERE id = ?').run(to, reason, now, to, now, order.id);
  order.status = to;
}

export function toPreview(order: OrderRow): OrderPreview {
  const stored = JSON.parse(order.plan_json) as StoredPlan;
  return {
    id: order.id,
    idempotencyKey: order.idempotency_key,
    mode: order.mode,
    status: order.status,
    symbol: order.symbol,
    side: 'buy',
    qty: order.qty,
    qtyLabel: formatShares(order.qty),
    orderType: order.order_type,
    limitPrice: order.limit_price,
    estimatedPrice: order.est_price,
    estimatedValue: order.qty * order.est_price,
    stop: order.stop,
    tp1: order.tp1,
    tp2: order.tp2,
    plannedRisk: order.planned_loss,
    potentialLoss: `About $${order.planned_loss.toFixed(2)} if the stop at $${order.stop.toFixed(2)} fills as planned. More if price gaps below the stop.`,
    warnings: stored.plan.warnings,
    protectiveOrders: PROTECTIVE_ORDER_NOTES,
    expiresAt: order.expires_at,
    plan: stored.plan,
  };
}

function blocked(blocks: Block[]): never {
  throw new TradingError(409, 'RISK_BLOCKED', blocks.map((b) => b.message).join(' '), { blocks });
}

/**
 * Step 1: build a paper order preview. Nothing is bought here. The preview
 * expires after 5 minutes because the price it was built on goes stale.
 */
export async function previewOrder(deps: Deps, input: { symbol: string; timeframe: Timeframe; orderType: 'market' | 'limit'; idempotencyKey: string }): Promise<OrderPreview> {
  const { db } = deps;
  const existing = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(input.idempotencyKey) as OrderRow | undefined;
  if (existing) return toPreview(existing);
  if (getKillSwitch(db).on) throw new TradingError(423, 'KILL_SWITCH', 'The kill switch is ON. No orders can be created.');

  const report = await analyzeSymbol(deps, input.symbol, input.timeframe, 'paper');
  const plan = report.plan;
  if (!plan || plan.status !== 'TRADE_PLAN') {
    throw new TradingError(422, 'NO_TRADE', 'NO TRADE — CONDITIONS NOT MET', { plan, quoteError: report.quoteError, analysisError: report.analysisError });
  }
  if (plan.entryStatus !== 'in_entry_zone') {
    throw new TradingError(409, 'NOT_CONFIRMED', `Confirmation has not happened yet: price must trade at $${plan.entryLow!.toFixed(2)} or higher first. Set a price alert instead of buying early.`, { plan });
  }
  const now = deps.now();
  const s = getSettings(db);
  const state = accountState(db, 'paper', s, now);
  const guard = checkEntry(s, state, { symbol: input.symbol, qty: plan.shares!, notionalUsd: plan.positionValue!, maxLossUsd: plan.maxPlannedLoss! }, now);
  if (!guard.allowed) blocked(guard.blocks);

  const order: OrderRow = {
    id: randomUUID(),
    idempotency_key: input.idempotencyKey,
    mode: 'paper',
    symbol: input.symbol,
    side: 'buy',
    qty: plan.shares!,
    order_type: input.orderType,
    limit_price: input.orderType === 'limit' ? round2(plan.entryHigh!) : null,
    est_price: report.quote!.price,
    stop: plan.stop!,
    tp1: plan.tp1!.price,
    tp2: plan.tp2!.price,
    invalidation_price: plan.invalidationPrice,
    planned_loss: plan.maxPlannedLoss!,
    timeframe: input.timeframe,
    setup_type: plan.setupType,
    plan_json: JSON.stringify({ plan, maxFillPrice: plan.entryHigh! + (report.analysis?.atr14 ?? 0) * 0.25 } satisfies StoredPlan),
    status: 'preview',
    status_reason: null,
    created_at: now,
    updated_at: now,
    expires_at: now + PREVIEW_TTL_MS,
    approved_at: null,
  };
  db.transaction(() => {
    // Only one live preview per symbol: older ones are superseded.
    for (const old of db.prepare("SELECT * FROM orders WHERE mode = 'paper' AND symbol = ? AND status = 'preview'").all(input.symbol) as OrderRow[]) {
      setStatus(db, old, 'cancelled', 'Replaced by a newer preview.', now);
    }
    db.prepare(
      `INSERT INTO orders (id, idempotency_key, mode, symbol, side, qty, order_type, limit_price, est_price, stop, tp1, tp2, invalidation_price, planned_loss, timeframe, setup_type, plan_json, status, status_reason, created_at, updated_at, expires_at, approved_at)
       VALUES (@id, @idempotency_key, @mode, @symbol, @side, @qty, @order_type, @limit_price, @est_price, @stop, @tp1, @tp2, @invalidation_price, @planned_loss, @timeframe, @setup_type, @plan_json, @status, @status_reason, @created_at, @updated_at, @expires_at, @approved_at)`,
    ).run(order);
  })();
  return toPreview(order);
}

/**
 * Step 2: the user's explicit approval. Re-checks every rule against a fresh
 * price. Approving the same order twice is harmless: the second call returns
 * the order as it already is.
 */
export async function approveOrder(deps: Deps, id: string, confirm: unknown): Promise<{ order: OrderPreview; alreadyProcessed: boolean; message: string }> {
  const { db } = deps;
  if (confirm !== true) throw new TradingError(400, 'CONFIRM_REQUIRED', 'Approval needs an explicit confirmation.');
  const first = getOrder(db, id);
  if (!first) throw new TradingError(404, 'NOT_FOUND', 'Order not found.');
  if (first.status !== 'preview') return { order: toPreview(first), alreadyProcessed: true, message: `This order is already ${first.status}. Nothing was done again.` };

  let quote;
  try {
    quote = await deps.market.quote(first.symbol, { fresh: true });
  } catch (e) {
    throw new TradingError(503, 'DATA_UNAVAILABLE', `Cannot approve without a current price: ${describeError(e).message}`);
  }
  const clock = await deps.market.clock();

  return db.transaction(() => {
    const now = deps.now();
    const order = getOrder(db, id)!;
    if (order.status !== 'preview') return { order: toPreview(order), alreadyProcessed: true, message: `This order is already ${order.status}. Nothing was done again.` };
    const reject = (code: string, msg: string, status = 409): never => {
      setStatus(db, order, 'rejected', msg, now);
      logRiskEvent(db, code, `${order.symbol}: ${msg}`, now);
      throw new TradingError(status, code, msg);
    };
    if (now > order.expires_at) {
      setStatus(db, order, 'expired', 'Preview expired before approval.', now);
      throw new TradingError(410, 'EXPIRED', 'This preview expired (older than 5 minutes). Create a new one with a fresh price.');
    }
    const s = getSettings(db);
    const guard = checkEntry(s, accountState(db, 'paper', s, now), { symbol: order.symbol, qty: order.qty, notionalUsd: order.qty * quote.price, maxLossUsd: order.planned_loss }, now);
    if (!guard.allowed) reject('RISK_BLOCKED', guard.blocks.map((b) => b.message).join(' '));
    if ((now - quote.time) / 1000 > s.maxQuoteAgeSeconds && clock?.isOpen) reject('STALE_DATA', 'The latest price is stale. Not approving on old data.');
    const { maxFillPrice } = JSON.parse(order.plan_json) as StoredPlan;
    if (quote.price <= order.stop) reject('BELOW_STOP', `Price ($${quote.price.toFixed(2)}) is at or below the stop. The setup is invalid.`);
    if (quote.price > maxFillPrice) reject('PRICE_MOVED', `Price moved to $${quote.price.toFixed(2)}, above the planned entry zone (max $${maxFillPrice.toFixed(2)}). Not chasing.`);

    if (order.order_type === 'market') {
      if (!clock?.isOpen) reject('MARKET_CLOSED', clock ? 'The market is closed, so a market order cannot fill now. Use a limit order to wait for the open.' : 'Could not confirm the market is open. Not filling a market order blind.');
      const fill = paperBuyFill('market', null, quote.price, s)!;
      setStatus(db, order, 'working', 'Approved by user.', now);
      openPaperPosition(db, order, fill, now, `Simulated market buy at $${fill.toFixed(2)} (last trade $${quote.price.toFixed(2)} + slippage).`);
      return { order: toPreview(getOrder(db, id)!), alreadyProcessed: false, message: `PAPER order filled (simulated) at $${fill.toFixed(2)}. No real money was used.` };
    }
    setStatus(db, order, 'working', 'Approved by user. Waiting for price to reach the limit.', now);
    // Valid until the close of the current (or, after hours, the next) session.
    const until = clock?.nextClose ?? now + 8 * 3_600_000;
    db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run(until, order.id);
    return { order: toPreview(getOrder(db, id)!), alreadyProcessed: false, message: `PAPER limit order working at $${order.limit_price!.toFixed(2)}. It fills only if the monitor sees the price at or below the limit. It expires at today's close.` };
  }).immediate();
}

/** Records a simulated buy and opens the position. Called inside a transaction. */
export function openPaperPosition(db: Db, order: OrderRow, fillPrice: number, now: number, reason: string): PositionRow {
  const s = getSettings(db);
  const cash = accountState(db, 'paper', s, now).cash;
  let qty = order.qty;
  if (qty * fillPrice > cash) qty = s.allowFractional ? Math.floor((cash / fillPrice) * 1e6) / 1e6 : Math.floor(cash / fillPrice);
  if (qty <= 0) {
    setStatus(db, order, 'rejected', 'Not enough simulated cash at fill time.', now);
    throw new TradingError(409, 'INSUFFICIENT_CASH', 'Not enough simulated cash at fill time.');
  }
  const pos: PositionRow = {
    id: randomUUID(),
    mode: 'paper',
    order_id: order.id,
    symbol: order.symbol,
    timeframe: order.timeframe,
    setup_type: order.setup_type,
    qty_initial: qty,
    qty_open: qty,
    entry_price: fillPrice,
    stop: order.stop,
    tp1: order.tp1,
    tp2: order.tp2,
    tp1_done: 0,
    invalidation_price: order.invalidation_price,
    planned_loss: order.planned_loss,
    status: 'open',
    realized_pnl: 0,
    exit_reason: null,
    opened_at: now,
    closed_at: null,
    last_price: fillPrice,
    last_price_at: now,
  };
  insertPosition(db, pos);
  db.prepare('INSERT INTO fills (mode, position_id, side, qty, price, fees, realized_pnl, reason, at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)').run('paper', pos.id, 'buy', qty, fillPrice, s.commissionPerOrderUsd, reason, now);
  setStatus(db, order, 'filled', reason, now);
  const plan = (JSON.parse(order.plan_json) as StoredPlan).plan;
  createJournalDraft(db, pos, `${plan.setupLabel ?? 'Setup'} on ${order.timeframe}. Entry ≈ $${fillPrice.toFixed(2)}, stop $${order.stop.toFixed(2)}, TP1 $${order.tp1.toFixed(2)}, TP2 $${order.tp2.toFixed(2)}. Planned max loss $${order.planned_loss.toFixed(2)}.`, now);
  return pos;
}

function insertPosition(db: Db, p: PositionRow) {
  db.prepare(
    `INSERT INTO positions (id, mode, order_id, symbol, timeframe, setup_type, qty_initial, qty_open, entry_price, stop, tp1, tp2, tp1_done, invalidation_price, planned_loss, status, realized_pnl, exit_reason, opened_at, closed_at, last_price, last_price_at)
     VALUES (@id, @mode, @order_id, @symbol, @timeframe, @setup_type, @qty_initial, @qty_open, @entry_price, @stop, @tp1, @tp2, @tp1_done, @invalidation_price, @planned_loss, @status, @realized_pnl, @exit_reason, @opened_at, @closed_at, @last_price, @last_price_at)`,
  ).run(p);
}

function createJournalDraft(db: Db, p: PositionRow, summary: string, now: number) {
  db.prepare('INSERT OR IGNORE INTO journal (mode, position_id, symbol, plan_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(p.mode, p.id, p.symbol, summary, now, now);
}

/** Records a (simulated or real) sale against a position and closes it when nothing is left. */
export function recordSell(db: Db, p: PositionRow, qty: number, price: number, fees: number, reason: string, now: number, closeReason?: string): number {
  const q = Math.min(qty, p.qty_open);
  const realized = q * (price - p.entry_price) - fees;
  db.prepare('INSERT INTO fills (mode, position_id, side, qty, price, fees, realized_pnl, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(p.mode, p.id, 'sell', q, price, fees, realized, reason, now);
  const remaining = p.qty_open - q < 1e-9 ? 0 : p.qty_open - q;
  db.prepare("UPDATE positions SET qty_open = ?, realized_pnl = realized_pnl + ?, status = CASE WHEN ? = 0 THEN 'closed' ELSE status END, closed_at = CASE WHEN ? = 0 THEN ? ELSE closed_at END, exit_reason = CASE WHEN ? = 0 THEN ? ELSE exit_reason END WHERE id = ?").run(
    remaining,
    realized,
    remaining,
    remaining,
    now,
    remaining,
    closeReason ?? reason,
    p.id,
  );
  p.qty_open = remaining;
  p.realized_pnl += realized;
  if (remaining === 0) {
    p.status = 'closed';
    if (p.realized_pnl < 0) logRiskEvent(db, 'LOSS', `${p.symbol} closed with a loss of $${(-p.realized_pnl).toFixed(2)} (${p.mode}).`, now);
  }
  return realized;
}

export function cancelOrder(db: Db, id: string, now: number, reason = 'Cancelled by user.'): OrderPreview {
  const order = getOrder(db, id);
  if (!order) throw new TradingError(404, 'NOT_FOUND', 'Order not found.');
  if (order.status === 'cancelled') return toPreview(order);
  if (order.status !== 'preview' && order.status !== 'working') throw new TradingError(409, 'NOT_CANCELLABLE', `A ${order.status} order cannot be cancelled.`);
  setStatus(db, order, 'cancelled', reason, now);
  return toPreview(order);
}

/** Expires previews past their 5-minute TTL and working limit orders past their session close. */
export function expireOrders(db: Db, now: number): number {
  const due = db.prepare("SELECT * FROM orders WHERE status IN ('preview','working') AND expires_at < ?").all(now) as OrderRow[];
  for (const o of due) setStatus(db, o, 'expired', o.status === 'preview' ? 'Preview expired.' : 'Limit order expired at the end of its session.', now);
  return due.length;
}

export async function closePaperPosition(deps: Deps, id: string): Promise<PositionRow> {
  const { db } = deps;
  const p = db.prepare("SELECT * FROM positions WHERE id = ? AND mode = 'paper'").get(id) as PositionRow | undefined;
  if (!p) throw new TradingError(404, 'NOT_FOUND', 'Paper position not found.');
  if (p.status !== 'open') return p;
  let quote;
  try {
    quote = await deps.market.quote(p.symbol, { fresh: true });
  } catch (e) {
    throw new TradingError(503, 'DATA_UNAVAILABLE', `Cannot close without a current price: ${describeError(e).message}`);
  }
  const s = getSettings(db);
  const price = applySlippage(quote.price, 'sell', s);
  db.transaction(() => recordSell(db, p, p.qty_open, price, sellFees(p.qty_open, price, s), `Closed manually (simulated) at $${price.toFixed(2)}.`, deps.now(), 'manual close'))();
  return p;
}

// ---------------------------------------------------------------------------
// Real-money records. The app never places these trades; the user does, in
// Robinhood, then records what actually happened here.
// ---------------------------------------------------------------------------

export function setLiveCapital(db: Db, amount: number, now: number) {
  if (!(amount > 0) || amount > 1_000_000) throw new TradingError(400, 'INVALID', 'Enter the real cash you have set aside for trading.');
  setKv(db, 'live_capital_usd', amount, now);
}

export interface LiveEntryInput {
  symbol: string;
  qty: number;
  price: number;
  stop: number;
  tp1: number;
  tp2: number;
  timeframe: Timeframe;
  filledAt: number;
  invalidationPrice: number | null;
}

export function recordLiveEntry(db: Db, input: LiveEntryInput, now: number): { position: PositionRow; warnings: string[] } {
  if (!(input.qty > 0 && input.price > 0 && input.stop > 0 && input.stop < input.price && input.tp1 > input.price && input.tp2 >= input.tp1)) {
    throw new TradingError(400, 'INVALID', 'Check the numbers: quantity and prices must be positive, stop below entry, targets above entry.');
  }
  const s = getSettings(db);
  const planned = input.qty * (input.price - input.stop);
  const guard = checkEntry(s, accountState(db, 'live', s, now), { symbol: input.symbol, qty: input.qty, notionalUsd: input.qty * input.price, maxLossUsd: planned }, now);
  const pos: PositionRow = {
    id: randomUUID(),
    mode: 'live',
    order_id: null,
    symbol: input.symbol,
    timeframe: input.timeframe,
    setup_type: null,
    qty_initial: input.qty,
    qty_open: input.qty,
    entry_price: input.price,
    stop: input.stop,
    tp1: input.tp1,
    tp2: input.tp2,
    tp1_done: 0,
    invalidation_price: input.invalidationPrice,
    planned_loss: planned,
    status: 'open',
    realized_pnl: 0,
    exit_reason: null,
    opened_at: input.filledAt,
    closed_at: null,
    last_price: input.price,
    last_price_at: now,
  };
  db.transaction(() => {
    insertPosition(db, pos);
    db.prepare('INSERT INTO fills (mode, position_id, side, qty, price, fees, realized_pnl, reason, at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)').run('live', pos.id, 'buy', input.qty, input.price, 'Real Robinhood fill recorded by user.', input.filledAt);
    createJournalDraft(db, pos, `Real trade recorded. Entry $${input.price.toFixed(2)}, stop $${input.stop.toFixed(2)}, TP1 $${input.tp1.toFixed(2)}, TP2 $${input.tp2.toFixed(2)}.`, now);
    if (!guard.allowed) logRiskEvent(db, 'LIVE_RULE_BREACH', `Real ${input.symbol} trade recorded while rules said no: ${guard.blocks.map((b) => b.message).join(' ')}`, now);
  })();
  return { position: pos, warnings: guard.blocks.map((b) => b.message) };
}

export function recordLiveExit(db: Db, id: string, input: { qty: number; price: number; fees: number; at: number }): PositionRow {
  const p = db.prepare("SELECT * FROM positions WHERE id = ? AND mode = 'live'").get(id) as PositionRow | undefined;
  if (!p) throw new TradingError(404, 'NOT_FOUND', 'Real position not found.');
  if (p.status !== 'open') throw new TradingError(409, 'CLOSED', 'This position is already closed.');
  if (!(input.qty > 0 && input.qty <= p.qty_open + 1e-9 && input.price > 0 && input.fees >= 0)) throw new TradingError(400, 'INVALID', 'Check the quantity, price and fees.');
  db.transaction(() => recordSell(db, p, input.qty, input.price, input.fees, 'Real Robinhood sale recorded by user.', input.at, 'recorded by user'))();
  return p;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
