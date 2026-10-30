import { describe, expect, it } from 'vitest';
import { computeFeatures, label, marketContext } from '../src/agent/features.js';
import { brier, design, fitLogistic, forecast, rawScore, solve, standardizer, trainHorizon, wilson, type Sample } from '../src/agent/model.js';
import { mulberry32 } from '../src/research/stats.js';
import { candle, seriesFromCloses } from './helpers.js';

function walk(n: number, seed: number) {
  const rnd = mulberry32(seed);
  const closes: number[] = [];
  let p = 50;
  for (let i = 0; i < n; i++) closes.push((p *= 1 + (rnd() - 0.49) * 0.03));
  return seriesFromCloses(closes, Date.UTC(2016, 0, 4, 5)).map((c) => ({ ...c, v: 1000 + rnd() * 500 }));
}

describe('model math', () => {
  it('solves linear systems', () => {
    expect(solve([[2, 1], [1, 3]], [3, 5]).map((v) => +v.toFixed(10))).toEqual([0.8, 1.4]);
  });
  it('logistic regression recovers known coefficients', () => {
    const rnd = mulberry32(1);
    const Z: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const a = rnd() * 4 - 2;
      const b = rnd() * 4 - 2;
      const p = 1 / (1 + Math.exp(-(0.5 + 1.5 * a - 1 * b)));
      Z.push([1, a, b]);
      y.push(rnd() < p ? 1 : 0);
    }
    const w = fitLogistic(Z, y, 0.001);
    expect(w[0]).toBeCloseTo(0.5, 1);
    expect(w[1]).toBeCloseTo(1.5, 1);
    expect(w[2]).toBeCloseTo(-1, 1);
    expect(rawScore(w, [1, 0, 0])).toBeGreaterThan(0.55);
  });
  it('standardises and clips inputs', () => {
    const s = standardizer([[1], [3]]);
    expect(design([100], s.mean, s.sd)).toEqual([1, 5]);
  });
  it('scoring helpers', () => {
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25);
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});

describe('features and labels use no future data', () => {
  const cs = walk(400, 3);
  const spy = walk(400, 4);
  const m = marketContext(spy);
  it('a feature row is identical whether or not later candles exist', () => {
    const full = computeFeatures(cs, m);
    const cut = computeFeatures(cs.slice(0, 300), marketContext(spy.slice(0, 300)));
    expect(cut.length).toBeGreaterThan(50);
    for (const r of cut) expect(full.find((f) => f.index === r.index)!.x).toEqual(r.x);
  });
  it('rows only exist once every feature has enough history', () => {
    expect(computeFeatures(cs.slice(0, 150), m)).toEqual([]);
  });
  it('labels: forward return, direction, and target-before-stop (stop first if both in one candle)', () => {
    const c = [candle(0, 10, 10, 10, 10), candle(1, 10, 10.5, 9.5, 10.2), candle(2, 10, 13, 8.5, 11)];
    expect(label(c, 0, 1, 1)).toEqual({ ret: 10.2 / 10 - 1, up: 1, targetFirst: null });
    expect(label(c, 0, 2, 1)!.targetFirst).toBe(0); // candle 2 hits both +2 and −1 ATR: stop assumed first
    expect(label(c, 1, 5, 1)).toBeNull();
  });
});

describe('validation gate', () => {
  it('rejects a model trained on pure noise (shows INSUFFICIENT EVIDENCE, no probability)', () => {
    const rnd = mulberry32(42);
    const mk = (n: number, year: number): Sample[] =>
      Array.from({ length: n }, (_, i) => {
        const x = Array.from({ length: 15 }, () => rnd() - 0.5);
        const ret = (rnd() - 0.5) * 0.04;
        const d = new Date(Date.UTC(year, Math.floor((i / n) * 12), 1 + (i % 27))).toISOString().slice(0, 10);
        return { symbol: 'X', date: d, x, ret, up: ret > 0 ? 1 : 0, targetFirst: null };
      });
    const model = trainHorizon({ train: mk(6000, 2018), validation: mk(4000, 2022), test: mk(4000, 2024) }, 5);
    expect(model.report.status).toBe('INSUFFICIENT EVIDENCE');
    const f = forecast(model, Array(15).fill(0));
    expect(f.status).toBe('INSUFFICIENT EVIDENCE');
    expect(f.pUp).toBeNull();
    expect(f.expectedReturn).toBeNull();
  });
  it('validates a model when a real, stable signal exists, and calibrates it on validation data', () => {
    const rnd = mulberry32(5);
    const mk = (n: number, year: number): Sample[] =>
      Array.from({ length: n }, (_, i) => {
        const x = Array.from({ length: 15 }, () => rnd() - 0.5);
        const p = 1 / (1 + Math.exp(-4 * x[2]!));
        const up = rnd() < p ? 1 : 0;
        const ret = (up ? 1 : -1) * rnd() * 0.03;
        const d = new Date(Date.UTC(year + Math.floor(i / (n / 2)), Math.floor((i % (n / 2)) / (n / 24)), 1 + (i % 27))).toISOString().slice(0, 10);
        return { symbol: 'X', date: d, x, ret, up: up as 0 | 1, targetFirst: up as 0 | 1 };
      });
    const model = trainHorizon({ train: mk(8000, 2016), validation: mk(6000, 2022), test: mk(6000, 2024) }, 20);
    expect(model.report.status).toBe('VALIDATED');
    const bullish = forecast(model, [0, 0, 0.45, ...Array(12).fill(0)]);
    const bearish = forecast(model, [0, 0, -0.45, ...Array(12).fill(0)]);
    expect(bullish.status).toBe('OK');
    expect(bullish.pUp!).toBeGreaterThan(0.6);
    expect(bearish.pUp!).toBeLessThan(0.4);
    expect(bullish.pDown!).toBeCloseTo(1 - bullish.pUp!, 12);
    expect(bullish.bucketSamples).toBeGreaterThan(300);
    expect(forecast(model, null).status).toBe('INSUFFICIENT DATA');
  });
});

import { applyCorporateActions } from '../src/agent/corporate-actions.js';
describe('corporate actions', () => {
  it('removes a spin-off gap and drops pre-listing prints', () => {
    const hon = [candle(Date.UTC(2026, 5, 26, 4), 200, 201, 199, 200), candle(Date.UTC(2026, 5, 29, 4), 104, 106, 103, 105)];
    const a = applyCorporateActions('HON', hon);
    expect(a[1]!.o / a[0]!.c).toBeCloseTo(1, 10);
    const dow = [candle(Date.UTC(2019, 2, 20, 4), 60, 60, 60, 60), candle(Date.UTC(2019, 3, 2, 4), 50, 51, 49, 50)];
    expect(applyCorporateActions('DOW', dow)).toHaveLength(1);
    expect(applyCorporateActions('SPY', hon)).toEqual(hon);
  });
});
