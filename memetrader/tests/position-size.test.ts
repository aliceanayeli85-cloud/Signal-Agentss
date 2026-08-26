import { describe, expect, it } from 'vitest';
import {
  calculatePositionSize,
  realisedPnl,
  riskReward,
  rMultiple,
  unrealisedPnl,
} from '../src/engine/position-size.js';

describe('calculatePositionSize', () => {
  it('sizes a long from account, risk percentage and stop distance', () => {
    const result = calculatePositionSize({ accountSize: 10_000, riskPct: 1, entry: 100, stop: 95 });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.maxDollarRisk).toBe(100);
    expect(result.positionSize).toBe(20);
    expect(result.positionValue).toBe(2000);
    expect(result.potentialLoss).toBe(100);
  });

  it('computes reward and R:R when a target is supplied', () => {
    const result = calculatePositionSize({
      accountSize: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 95,
      target: 112,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.potentialProfit).toBeCloseTo(240, 6);
    expect(result.rr).toBeCloseTo(2.4, 6);
  });

  it('sizes a short and rejects a stop below the entry', () => {
    const good = calculatePositionSize({
      accountSize: 5_000,
      riskPct: 2,
      entry: 50,
      stop: 55,
      direction: 'short',
    });
    expect(good.available).toBe(true);
    if (good.available) expect(good.positionSize).toBe(20);

    const bad = calculatePositionSize({
      accountSize: 5_000,
      riskPct: 2,
      entry: 50,
      stop: 45,
      direction: 'short',
    });
    expect(bad.available).toBe(false);
  });

  it('refuses a zero stop distance instead of dividing by zero', () => {
    const result = calculatePositionSize({ accountSize: 10_000, riskPct: 1, entry: 100, stop: 100 });
    expect(result.available).toBe(false);
    if (result.available) return;
    expect(result.reason).toMatch(/risk per unit is zero/i);
  });

  it('refuses non-finite, zero and negative inputs rather than producing NaN', () => {
    const cases = [
      { accountSize: Number.NaN, riskPct: 1, entry: 100, stop: 95 },
      { accountSize: 10_000, riskPct: 0, entry: 100, stop: 95 },
      { accountSize: 10_000, riskPct: 1, entry: 0, stop: 95 },
      { accountSize: 10_000, riskPct: 1, entry: 100, stop: -5 },
      { accountSize: -10_000, riskPct: 1, entry: 100, stop: 95 },
      { accountSize: 10_000, riskPct: Number.POSITIVE_INFINITY, entry: 100, stop: 95 },
    ];
    for (const input of cases) {
      expect(calculatePositionSize(input).available).toBe(false);
    }
  });

  it('rejects a stop on the wrong side of an explicitly long entry', () => {
    const result = calculatePositionSize({
      accountSize: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 105,
      direction: 'long',
    });
    expect(result.available).toBe(false);
  });

  it('infers direction from the stop when none is given, and says so', () => {
    const result = calculatePositionSize({ accountSize: 10_000, riskPct: 1, entry: 100, stop: 105 });
    expect(result.available).toBe(true);
    if (!result.available) return;
    // A stop above entry can only be a short - but the user must be told, since
    // the far more likely explanation is that they mistyped a long's stop.
    expect(result.direction).toBe('short');
    expect(result.directionInferred).toBe(true);
    expect(result.warnings.some((w) => /sized as a SHORT/.test(w))).toBe(true);
  });

  it('does not claim an inference when the direction was supplied', () => {
    const result = calculatePositionSize({
      accountSize: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 95,
      direction: 'long',
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.directionInferred).toBe(false);
  });

  it('warns above 2% risk and warns harder for volatile markets', () => {
    const aggressive = calculatePositionSize({
      accountSize: 10_000,
      riskPct: 5,
      entry: 100,
      stop: 95,
      highVolatility: true,
    });
    expect(aggressive.available).toBe(true);
    expect(aggressive.warnings.some((w) => /above the 2% ceiling/i.test(w))).toBe(true);
    expect(aggressive.warnings.some((w) => /high volatility/i.test(w))).toBe(true);
  });

  it('handles meme-coin scale prices without losing precision', () => {
    const result = calculatePositionSize({
      accountSize: 1_000,
      riskPct: 0.5,
      entry: 0.00000123,
      stop: 0.00000110,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.positionSize).toBeGreaterThan(0);
    expect(Number.isFinite(result.positionSize)).toBe(true);
    expect(result.potentialLoss).toBeCloseTo(5, 6);
  });

  it('flags a notional larger than the account', () => {
    const result = calculatePositionSize({
      accountSize: 1_000,
      riskPct: 1,
      entry: 100,
      stop: 99.9,
    });
    expect(result.available).toBe(true);
    expect(result.warnings.some((w) => /exceeds the account size/i.test(w))).toBe(true);
  });
});

describe('rMultiple', () => {
  it('returns +2 when a long reaches twice its risk', () => {
    expect(rMultiple('long', 100, 95, 110)).toBeCloseTo(2, 9);
  });

  it('returns -1 at the stop', () => {
    expect(rMultiple('long', 100, 95, 95)).toBeCloseTo(-1, 9);
    expect(rMultiple('short', 100, 105, 105)).toBeCloseTo(-1, 9);
  });

  it('handles shorts, where a lower exit is a win', () => {
    expect(rMultiple('short', 100, 105, 90)).toBeCloseTo(2, 9);
  });

  it('returns null when the initial risk was zero or an input is not finite', () => {
    expect(rMultiple('long', 100, 100, 110)).toBeNull();
    expect(rMultiple('long', Number.NaN, 95, 110)).toBeNull();
  });
});

describe('P&L', () => {
  it('computes realised P&L for both directions', () => {
    expect(realisedPnl('long', 100, 110, 5)).toBeCloseTo(50, 9);
    expect(realisedPnl('short', 100, 90, 5)).toBeCloseTo(50, 9);
    expect(realisedPnl('long', 100, 90, 5)).toBeCloseTo(-50, 9);
  });

  it('computes unrealised P&L the same way as realised', () => {
    expect(unrealisedPnl('long', 100, 105, 2)).toBe(realisedPnl('long', 100, 105, 2));
  });

  it('returns null for non-finite inputs rather than NaN', () => {
    expect(realisedPnl('long', 100, Number.NaN, 5)).toBeNull();
  });
});

describe('riskReward', () => {
  it('returns null when the target is on the wrong side of entry', () => {
    expect(riskReward('long', 100, 95, 90)).toBeNull();
    expect(riskReward('short', 100, 105, 110)).toBeNull();
  });

  it('returns the reward-to-risk ratio', () => {
    expect(riskReward('long', 100, 90, 130)).toBeCloseTo(3, 9);
  });
});
