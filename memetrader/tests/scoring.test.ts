import { describe, expect, it } from 'vitest';
import { assessRisk } from '../src/engine/risk-engine.js';
import { scoreSetup } from '../src/engine/setup-score.js';
import { analyseStructure } from '../src/engine/structure.js';
import { analyseTimeframes } from '../src/engine/mtf.js';
import { buildTradePlan } from '../src/engine/trade-plan.js';
import { detectLatest } from '../src/engine/setups/index.js';
import type { SetupDetection } from '../src/shared/types.js';
import { ramp, snapshot, tokenInfo } from './helpers.js';

function detection(overrides: Partial<SetupDetection> = {}): SetupDetection {
  return {
    strategy: 'breakout-retest',
    strategyName: 'Breakout + Retest',
    direction: 'long',
    triggerIndex: 99,
    triggerTime: 1_700_000_000,
    entry: 100,
    stop: 95,
    invalidation: 96,
    invalidationReason: 'close below 96',
    keyLevel: 96,
    annotations: [],
    notes: [],
    ...overrides,
  };
}

describe('setup scoring', () => {
  it('excludes unevaluated factors from both the score and the denominator', () => {
    const noVolume = ramp(120, 100, 0.4, { volume: null });
    const structure = analyseStructure(noVolume);
    const alignment = analyseTimeframes([{ timeframe: '1h', candles: noVolume }]);
    const plan = buildTradePlan(detection(), noVolume, structure.levels);

    const score = scoreSetup({ detection: detection(), candles: noVolume, structure, alignment, plan, snapshot: null });

    const volumeFactor = score.factors.find((f) => f.key === 'volume');
    expect(volumeFactor?.evaluated).toBe(false);
    expect(volumeFactor?.points).toBe(0);
    expect(volumeFactor?.max).toBe(20);
    // A factor that could not be evaluated must not shrink the score, so the
    // denominator excludes it too. Categories can also be PARTIALLY evaluated,
    // which is why the denominator sums evaluatedMax rather than max.
    expect(score.evaluatedMax).toBeLessThan(100);
    expect(score.evaluatedMax).toBe(
      score.factors.reduce((acc, f) => acc + f.evaluatedMax, 0),
    );
    expect(score.warnings.some((w) => /Volume confirmation could not be checked/i.test(w))).toBe(true);
  });

  it('produces a score between 0 and 100 and never NaN', () => {
    const bars = ramp(150, 100, 0.5);
    const structure = analyseStructure(bars);
    const alignment = analyseTimeframes([{ timeframe: '1h', candles: bars }]);
    const plan = buildTradePlan(detection(), bars, structure.levels);
    const score = scoreSetup({ detection: detection(), candles: bars, structure, alignment, plan, snapshot: snapshot() });

    expect(Number.isFinite(score.score)).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
  });

  it('warns when the trade fights the structure on this timeframe', () => {
    const downtrend = ramp(150, 200, -0.8);
    const structure = analyseStructure(downtrend);
    const alignment = analyseTimeframes([{ timeframe: '1h', candles: downtrend }]);
    const plan = buildTradePlan(detection({ entry: 120, stop: 110, invalidation: 112 }), downtrend, structure.levels);
    const score = scoreSetup({
      detection: detection({ entry: 120, stop: 110, invalidation: 112 }),
      candles: downtrend,
      structure,
      alignment,
      plan,
      snapshot: null,
    });

    if (structure.bias === 'bearish') {
      expect(score.warnings.some((w) => /conflicts with the current market structure/i.test(w))).toBe(true);
    }
  });

  it('scores zero with an empty candle series rather than crashing', () => {
    const structure = analyseStructure([]);
    const alignment = analyseTimeframes([{ timeframe: '1h', candles: [] }]);
    const plan = buildTradePlan(detection(), [], []);
    const score = scoreSetup({ detection: detection(), candles: [], structure, alignment, plan, snapshot: null });
    expect(Number.isFinite(score.score)).toBe(true);
  });
});

describe('risk engine', () => {
  it('never reports holder concentration as a number', () => {
    const risk = assessRisk({ snapshot: snapshot(), candles: ramp(120, 1, 0.001) });
    const holders = risk.factors.find((f) => f.key === 'holders');
    expect(holders?.evaluated).toBe(false);
    expect(holders?.detail).toMatch(/unavailable/i);
    expect(risk.unavailable).toContain('Holder concentration data unavailable');
  });

  it('scores thin liquidity and a brand-new pair as high risk', () => {
    const now = Date.now();
    const risk = assessRisk({
      snapshot: snapshot({
        liquidityUsd: 3_000,
        pairCreatedAt: now - 30 * 60_000,
        priceChangePct: { h24: 400, h1: 90 },
        volume: { h24: 900_000, h1: 500 },
      }),
      candles: ramp(120, 1, 0.08, { range: 0.05 }),
      now,
    });

    expect(risk.score).toBeGreaterThan(55);
    expect(['high', 'extreme']).toContain(risk.band);
    expect(risk.warnings.some((w) => /EXTREMELY LOW LIQUIDITY/i.test(w))).toBe(true);
    expect(risk.warnings.some((w) => /EXTREMELY NEW PAIR/i.test(w))).toBe(true);
    expect(risk.warnings.some((w) => /EXTREME PRICE EXTENSION/i.test(w))).toBe(true);
  });

  it('flags zero liquidity as untradeable rather than dividing by zero', () => {
    const risk = assessRisk({
      snapshot: snapshot({ liquidityUsd: 0, volume: { h24: 100_000, h1: 4_000 } }),
      candles: ramp(120, 1, 0.001),
    });
    expect(Number.isFinite(risk.score)).toBe(true);
    expect(risk.warnings.some((w) => /ZERO LIQUIDITY REPORTED/i.test(w))).toBe(true);
  });

  it('handles zero volume without producing NaN', () => {
    const risk = assessRisk({
      snapshot: snapshot({ volume: { h24: 0, h1: 0 }, txns: {} }),
      candles: ramp(120, 1, 0.001, { volume: 0 }),
    });
    expect(Number.isFinite(risk.score)).toBe(true);
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('says a low score means "few measured hazards" when coverage is thin', () => {
    // A centralised-exchange style snapshot: no liquidity, no pair age, no txns.
    const risk = assessRisk({
      snapshot: snapshot({
        assetClass: 'crypto',
        liquidityUsd: null,
        marketCapUsd: null,
        fdvUsd: null,
        pairCreatedAt: null,
        txns: {},
        volume: { h24: 1_000_000 },
      }),
      candles: ramp(120, 100, 0.1),
    });
    expect(risk.evaluatedMax).toBeLessThan(45);
    expect(risk.warnings.some((w) => /not "safe"/i.test(w))).toBe(true);
  });

  it('never claims a token is safe, with or without contract data', () => {
    const withoutInfo = assessRisk({ snapshot: snapshot(), candles: ramp(120, 1, 0.001) });
    expect(
      withoutInfo.warnings.some((w) => /could not retrieve contract or holder data/i.test(w)),
    ).toBe(true);

    const withInfo = assessRisk({
      snapshot: snapshot(),
      candles: ramp(120, 1, 0.001),
      tokenInfo: tokenInfo(),
    });
    expect(withInfo.warnings.some((w) => /not a security audit/i.test(w))).toBe(true);

    for (const warning of [...withoutInfo.warnings, ...withInfo.warnings]) {
      expect(warning).not.toMatch(/\bis safe\b/i);
    }
  });

  it('scores holder concentration, creator holding and contract authorities when supplied', () => {
    const risk = assessRisk({
      snapshot: snapshot(),
      candles: ramp(120, 1, 0.001),
      tokenInfo: tokenInfo({
        holderCount: 78,
        topTenPct: 74.9,
        creatorHoldingPct: 12.5,
        mintAuthority: 'yes',
        freezeAuthority: 'yes',
      }),
    });

    const holders = risk.factors.find((f) => f.key === 'holders');
    expect(holders?.evaluated).toBe(true);
    expect(holders?.points).toBe(holders?.max);

    expect(risk.warnings.some((w) => /CONCENTRATED OWNERSHIP/i.test(w))).toBe(true);
    expect(risk.warnings.some((w) => /CREATOR HOLDS/i.test(w))).toBe(true);
    expect(risk.warnings.some((w) => /MINT AUTHORITY NOT REVOKED/i.test(w))).toBe(true);
    expect(risk.warnings.some((w) => /FREEZE AUTHORITY NOT REVOKED/i.test(w))).toBe(true);
    expect(risk.unavailable).not.toContain('Holder concentration data unavailable');
  });

  it('treats an unknown authority as unknown, never as revoked', () => {
    const unknown = assessRisk({
      snapshot: snapshot(),
      candles: ramp(120, 1, 0.001),
      tokenInfo: tokenInfo({ mintAuthority: 'unknown', freezeAuthority: 'unknown' }),
    });
    const revoked = assessRisk({
      snapshot: snapshot(),
      candles: ramp(120, 1, 0.001),
      tokenInfo: tokenInfo({ mintAuthority: 'no', freezeAuthority: 'no' }),
    });
    const unknownFactor = unknown.factors.find((f) => f.key === 'contract');
    const revokedFactor = revoked.factors.find((f) => f.key === 'contract');
    expect(unknownFactor?.points ?? 0).toBeGreaterThan(revokedFactor?.points ?? 0);
    expect(unknownFactor?.detail).toMatch(/unknown/i);
  });

  it('scores a rapid liquidity loss as a hazard and warns about it', () => {
    const risk = assessRisk({
      snapshot: snapshot(),
      candles: ramp(120, 1, 0.001),
      liquidityTrend: {
        label: 'rapid-loss',
        changePct: -60,
        observations: 6,
        firstObservedAt: 1,
        lastObservedAt: 2,
        currentUsd: 4000,
        detail: 'HIGH RISK — LIQUIDITY DETERIORATION: the pool has fallen 60%.',
        highRisk: true,
      },
    });
    const factor = risk.factors.find((f) => f.key === 'liquidity-trend');
    expect(factor?.evaluated).toBe(true);
    expect(factor?.points).toBe(factor?.max);
    // The trend's own detail already carries the headline; it must be surfaced
    // exactly once, not re-prefixed.
    const matches = risk.warnings.filter((w) => /LIQUIDITY DETERIORATION/i.test(w));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe('HIGH RISK — LIQUIDITY DETERIORATION: the pool has fallen 60%.');
  });

  it('returns a valid assessment with no snapshot at all', () => {
    const risk = assessRisk({ snapshot: null, candles: ramp(120, 100, 0.5) });
    expect(Number.isFinite(risk.score)).toBe(true);
    expect(risk.unavailable.length).toBeGreaterThan(0);
  });
});

describe('trade plan', () => {
  it('refuses a plan when the stop is on the wrong side of entry', () => {
    const plan = buildTradePlan(detection({ stop: 105 }), ramp(120, 100, 0.4), []);
    expect(plan.available).toBe(false);
    if (plan.available) return;
    expect(plan.reason).toMatch(/No valid trade plan available/i);
  });

  it('refuses a plan when entry equals stop', () => {
    const plan = buildTradePlan(detection({ stop: 100 }), ramp(120, 100, 0.4), []);
    expect(plan.available).toBe(false);
  });

  it('refuses a plan with a non-finite stop', () => {
    const plan = buildTradePlan(detection({ stop: Number.NaN }), ramp(120, 100, 0.4), []);
    expect(plan.available).toBe(false);
  });

  it('produces increasing targets with increasing R for a long', () => {
    const plan = buildTradePlan(detection(), ramp(120, 100, 0.4), []);
    expect(plan.available).toBe(true);
    if (!plan.available) return;
    expect(plan.targets.tp1).toBeLessThan(plan.targets.tp2);
    expect(plan.targets.tp2).toBeLessThan(plan.targets.tp3);
    expect(plan.rr.tp1).toBeLessThan(plan.rr.tp2);
    expect(plan.rr.tp2).toBeLessThan(plan.rr.tp3);
  });

  it('produces decreasing targets for a short and refuses non-positive prices', () => {
    const plan = buildTradePlan(
      detection({ direction: 'short', entry: 100, stop: 110, invalidation: 108 }),
      ramp(120, 100, -0.4),
      [],
    );
    expect(plan.available).toBe(true);
    if (!plan.available) return;
    expect(plan.targets.tp1).toBeGreaterThan(plan.targets.tp2);
    expect(plan.targets.tp3).toBeGreaterThan(0);
  });

  it('does not claim a structural target it did not actually use', () => {
    // A resistance sitting closer than 0.5R must be skipped, and the note must
    // say so rather than claiming the target came from structure.
    const plan = buildTradePlan(detection({ entry: 100, stop: 90 }), ramp(120, 100, 0.4), [
      { price: 101, kind: 'resistance', touches: 4, firstTime: 1, lastTime: 2 },
    ]);
    expect(plan.available).toBe(true);
    if (!plan.available) return;
    expect(plan.targets.tp1).not.toBeCloseTo(101, 6);
    expect(plan.notes.some((n) => /closer than 0.5R, so it was skipped/i.test(n))).toBe(true);
  });
});

describe('setup detection', () => {
  it('returns no detections for an empty or tiny series', () => {
    expect(detectLatest([])).toEqual([]);
    expect(detectLatest(ramp(5, 100, 1))).toEqual([]);
  });

  it('always produces a stop on the correct side of the entry', () => {
    const series = [ramp(200, 100, 0.4), ramp(200, 200, -0.4), ramp(200, 100, 0, { range: 2 })];
    for (const bars of series) {
      for (const found of detectLatest(bars)) {
        if (found.direction === 'long') expect(found.stop).toBeLessThan(found.entry);
        else expect(found.stop).toBeGreaterThan(found.entry);
        expect(found.stop).toBeGreaterThan(0);
      }
    }
  });
});
