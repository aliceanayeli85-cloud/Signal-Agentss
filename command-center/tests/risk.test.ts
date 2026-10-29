import { describe, expect, it } from 'vitest';
import { estimateRoundTripCosts, sellFees, sizePosition } from '../src/engine/costs.js';
import { checkEntry } from '../src/engine/risk.js';
import { DEFAULT_SETTINGS, effectiveRiskPerTrade, validateSettingsChange, type RiskSettings } from '../src/engine/settings.js';
import { account } from './helpers.js';

const S: RiskSettings = { ...DEFAULT_SETTINGS };
const NOW = Date.UTC(2026, 2, 2, 16);

describe('transaction costs', () => {
  it('charges slippage on both sides and regulatory fees only on the sell, rounded up', () => {
    const c = estimateRoundTripCosts(1, 50, 49, S);
    expect(c.entrySlippage).toBeCloseTo(0.025, 10);
    expect(c.exitSlippage).toBeCloseTo(0.0245, 10);
    expect(c.regulatoryFees).toBeCloseTo(0.02, 10); // $0.01 SEC + $0.01 TAF minimums after rounding up
    expect(c.commissions).toBe(0);
  });
  it('caps the FINRA TAF', () => {
    expect(sellFees(1_000_000, 1, { ...S, secFeePerMillion: 0 })).toBe(8.3);
  });
  it('is zero for zero shares', () => {
    expect(estimateRoundTripCosts(0, 50, 49, S).total).toBe(0);
  });
});

describe('position sizing', () => {
  it('keeps the loss at the stop within a $1 budget, costs included', () => {
    const r = sizePosition(50, 49, 1, 100, S);
    expect(r.problem).toBeNull();
    expect(r.shares).toBeGreaterThan(0.9);
    expect(r.shares).toBeLessThan(1);
    expect(r.maxLossAtStop).toBeLessThanOrEqual(1.0000001);
    expect(r.limitedBy).toBe('risk_budget');
  });
  it('rounds down to whole shares when fractional is off, and refuses if one share is too risky', () => {
    const whole = { ...S, allowFractional: false };
    expect(sizePosition(10, 9.5, 1, 100, whole).shares).toBe(1);
    const r = sizePosition(50, 48, 1, 100, whole);
    expect(r.shares).toBe(0);
    expect(r.problem).toMatch(/One whole share risks/);
  });
  it('is capped by the max position size and by cash (no borrowing)', () => {
    const tight = sizePosition(100, 99.9, 1, 100, S);
    expect(tight.limitedBy).toBe('max_position');
    expect(tight.notional).toBeLessThanOrEqual(50.0000001);
    const poor = sizePosition(100, 99.9, 1, 20, S);
    expect(poor.limitedBy).toBe('cash');
    expect(poor.notional).toBeLessThanOrEqual(20.0000001);
    // Cash actually spent, including entry slippage, also stays within the limits (audit fix).
    expect(tight.shares * 100 * (1 + S.slippageBps / 10_000)).toBeLessThanOrEqual(50.0000001);
    expect(poor.shares * 100 * (1 + S.slippageBps / 10_000)).toBeLessThanOrEqual(20.0000001);
  });
  it('rejects stops at or above entry, zero prices and zero budgets', () => {
    expect(sizePosition(50, 50, 1, 100, S).problem).toMatch(/below the entry/);
    expect(sizePosition(50, 51, 1, 100, S).problem).toMatch(/below the entry/);
    expect(sizePosition(0, -1, 1, 100, S).problem).toMatch(/positive/);
    expect(sizePosition(50, 49, 0, 100, S).problem).toMatch(/zero/);
  });
  it('refuses positions below the minimum order value', () => {
    // A $60 stock with a $20 stop distance: $1 of risk buys ~0.05 share ≈ $3 — fine; with a $5 minimum it is not.
    expect(sizePosition(60, 40, 1, 100, { ...S, minOrderUsd: 5 }).problem).toMatch(/minimum order/);
  });
});

describe('risk guard', () => {
  const req = { symbol: 'SPY', qty: 0.1, notionalUsd: 40, maxLossUsd: 1 };
  it('allows a normal trade', () => {
    const g = checkEntry(S, account(), req, NOW);
    expect(g.allowed).toBe(true);
    expect(g.riskBudgetUsd).toBe(1);
  });
  const cases: [string, Parameters<typeof account>[0], string][] = [
    ['kill switch', { killSwitch: true }, 'KILL_SWITCH'],
    ['daily loss limit', { todayRealizedPnl: -3 }, 'DAILY_LOSS_LIMIT'],
    ['consecutive losses', { consecutiveLossesToday: 2 }, 'CONSECUTIVE_LOSSES'],
    ['max trades', { tradesToday: 3 }, 'MAX_TRADES'],
    ['loss cooldown', { lastLoss: { symbol: 'QQQ', at: NOW - 10 * 60_000 } }, 'LOSS_COOLDOWN'],
    ['revenge on same symbol', { lossSymbolsToday: ['SPY'] }, 'REVENGE_SAME_SYMBOL'],
    ['open position duplicate', { openSymbols: ['SPY'] }, 'DUPLICATE_POSITION'],
    ['working order duplicate', { workingOrders: [{ symbol: 'SPY', side: 'buy', qty: 0.1, createdAt: NOW - 5000 }] }, 'DUPLICATE_ORDER'],
    ['open risk', { openRiskUsd: 1.5 }, 'OPEN_RISK'],
    ['cash', { cash: 10 }, 'INSUFFICIENT_CASH'],
  ];
  for (const [name, state, code] of cases) {
    it(`blocks: ${name}`, () => {
      const g = checkEntry(S, account(state), req, NOW);
      expect(g.allowed).toBe(false);
      expect(g.blocks.map((b) => b.code)).toContain(code);
    });
  }
  it('blocks trades whose planned loss exceeds the budget, or whose size exceeds the cap', () => {
    expect(checkEntry(S, account(), { ...req, maxLossUsd: 1.5 }, NOW).blocks.map((b) => b.code)).toContain('RISK_BUDGET');
    expect(checkEntry(S, account(), { ...req, notionalUsd: 60 }, NOW).blocks.map((b) => b.code)).toContain('POSITION_SIZE');
  });
  it('marks daily limits as a shutdown, and the cooldown expires', () => {
    expect(checkEntry(S, account({ todayRealizedPnl: -3 }), req, NOW).dailyShutdown).toBe(true);
    expect(checkEntry(S, account({ lastLoss: { symbol: 'QQQ', at: NOW - 61 * 60_000 } }), req, NOW).allowed).toBe(true);
  });
  it('shrinks the risk budget automatically as equity falls (2% hard cap)', () => {
    expect(effectiveRiskPerTrade(S, 100)).toBe(1);
    expect(effectiveRiskPerTrade(S, 40)).toBeCloseTo(0.8, 10);
    expect(checkEntry(S, account({ equity: 40, cash: 40 }), { ...req, notionalUsd: 30, maxLossUsd: 0.9 }, NOW).blocks.map((b) => b.code)).toContain('RISK_BUDGET');
  });
});

describe('settings changes', () => {
  const ok = { equity: 100, todayRealizedPnl: 0, lastClosedTradeWasLoss: false };
  it('allows lowering risk at any time', () => {
    expect(validateSettingsChange(S, { ...S, riskPerTradeUsd: 0.5 }, { ...ok, todayRealizedPnl: -2 })).toEqual([]);
  });
  it('refuses to raise risk after a loss', () => {
    const errs = validateSettingsChange({ ...S, riskPerTradeUsd: 0.5 }, { ...S, riskPerTradeUsd: 1 }, { ...ok, lastClosedTradeWasLoss: true });
    expect(errs.join(' ')).toMatch(/cannot be increased after a loss/);
    expect(validateSettingsChange(S, { ...S, lossCooldownMinutes: 0 }, { ...ok, todayRealizedPnl: -1 }).length).toBe(1);
  });
  it('enforces hard caps: 2% per trade, 5% per day, no position larger than equity', () => {
    expect(validateSettingsChange(S, { ...S, riskPerTradeUsd: 5, maxOpenRiskUsd: 5 }, ok).join(' ')).toMatch(/2%/);
    expect(validateSettingsChange(S, { ...S, maxDailyLossUsd: 10 }, ok).join(' ')).toMatch(/5%/);
    expect(validateSettingsChange(S, { ...S, maxPositionUsd: 500 }, ok).join(' ')).toMatch(/No borrowed money/);
  });
});
