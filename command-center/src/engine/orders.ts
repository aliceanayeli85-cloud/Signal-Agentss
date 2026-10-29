import { applySlippage, limitSellFilled, sellFees } from './costs.js';
import type { RiskSettings } from './settings.js';

/**
 * Order lifecycle. `preview` exists so every order is seen before it is
 * approved; only an explicit approval moves it forward. Terminal states can
 * never change again, which is what makes re-sending an approval harmless.
 */
export type OrderStatus = 'preview' | 'working' | 'filled' | 'cancelled' | 'rejected' | 'expired';

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  preview: ['working', 'filled', 'cancelled', 'rejected', 'expired'],
  working: ['filled', 'cancelled', 'rejected', 'expired'],
  filled: [],
  cancelled: [],
  rejected: [],
  expired: [],
};

export class InvalidTransitionError extends Error {
  constructor(readonly from: OrderStatus, readonly to: OrderStatus) {
    super(`An order cannot move from "${from}" to "${to}".`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export const isTerminal = (s: OrderStatus) => TRANSITIONS[s].length === 0;

/** How long a preview stays approvable. After this the price may have moved too much. */
export const PREVIEW_TTL_MS = 5 * 60_000;

/** A paper limit buy fills only when the observed price is at or below the limit. */
export function paperBuyFill(orderType: 'market' | 'limit', limit: number | null, observed: number, s: RiskSettings): number | null {
  if (orderType === 'limit') {
    if (limit === null || observed > limit) return null;
    return Math.min(limit, applySlippage(observed, 'buy', s));
  }
  return applySlippage(observed, 'buy', s);
}

// ---------------------------------------------------------------------------
// Simulated position management
// ---------------------------------------------------------------------------

export interface PaperPosition {
  qtyOpen: number;
  qtyInitial: number;
  entryPrice: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp1Done: boolean;
  fractional: boolean;
}

export interface PositionAction {
  kind: 'STOP' | 'BREAKEVEN_STOP' | 'TP1' | 'TP2';
  qty: number;
  fillPrice: number;
  fees: number;
  reason: string;
}

/**
 * What a simulated stop/target would do at the observed price. Stops are
 * treated as market orders once touched, so a price that gapped below the
 * stop fills BELOW it — the same way a real stop behaves. Targets are limit
 * orders and fill at the target price.
 */
export function evaluatePosition(p: PaperPosition, price: number, s: RiskSettings): PositionAction[] {
  if (p.qtyOpen <= 0) return [];
  const actions: PositionAction[] = [];
  const stopLevel = p.tp1Done ? Math.max(p.stop, p.entryPrice) : p.stop;

  if (price <= stopLevel) {
    const fill = applySlippage(price, 'sell', s);
    const kind = p.tp1Done ? 'BREAKEVEN_STOP' : 'STOP';
    actions.push({
      kind,
      qty: p.qtyOpen,
      fillPrice: fill,
      fees: sellFees(p.qtyOpen, fill, s),
      reason:
        price < stopLevel
          ? `Price $${price.toFixed(2)} is below the ${kind === 'STOP' ? 'stop' : 'breakeven stop'} of $${stopLevel.toFixed(2)}; simulated fill at $${fill.toFixed(2)} (worse than the stop, as can happen in real markets).`
          : `Price reached the ${kind === 'STOP' ? 'stop' : 'breakeven stop'} at $${stopLevel.toFixed(2)}.`,
    });
    return actions;
  }

  let remaining = p.qtyOpen;
  if (!p.tp1Done && limitSellFilled(price, p.tp1)) {
    let half = p.fractional ? Math.floor((p.qtyInitial / 2) * 1e6) / 1e6 : Math.floor(p.qtyInitial / 2);
    if (half <= 0 || half >= remaining) half = remaining;
    actions.push({ kind: 'TP1', qty: half, fillPrice: p.tp1, fees: sellFees(half, p.tp1, s), reason: `Price reached take-profit 1 at $${p.tp1.toFixed(2)}. Sold ${half === remaining ? 'all' : 'half'}; stop moves to breakeven.` });
    remaining -= half;
  }
  if (remaining > 1e-9 && limitSellFilled(price, p.tp2)) {
    actions.push({ kind: 'TP2', qty: remaining, fillPrice: p.tp2, fees: sellFees(remaining, p.tp2, s), reason: `Price reached take-profit 2 at $${p.tp2.toFixed(2)}.` });
  }
  return actions;
}

export function unrealizedPnl(qtyOpen: number, entry: number, price: number): number {
  return qtyOpen * (price - entry);
}

// ---------------------------------------------------------------------------
// Price alerts — these NEVER place or simulate orders.
// ---------------------------------------------------------------------------

export interface AlertRule {
  kind: 'price_above' | 'price_below';
  price: number;
}

export function alertTriggered(rule: AlertRule, price: number): boolean {
  return rule.kind === 'price_above' ? price >= rule.price : price <= rule.price;
}

/** True when price is within 25% of the risk distance from the stop. */
export function nearStop(p: PaperPosition, price: number): boolean {
  const stopLevel = p.tp1Done ? Math.max(p.stop, p.entryPrice) : p.stop;
  const risk = p.entryPrice - p.stop;
  return risk > 0 && price > stopLevel && price - stopLevel <= risk * 0.25;
}
