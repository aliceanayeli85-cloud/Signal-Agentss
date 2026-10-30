import { mulberry32 } from '../research/stats.js';
import { FEATURE_NAMES } from './features.js';

/**
 * Probability model for "will the close in h trading days be above today's close?".
 *
 *  1. Logistic regression (L2) on standardised features — fitted on TRAIN only.
 *  2. Histogram calibration — fitted on VALIDATION only: predictions are bucketed
 *     into deciles, and each bucket's probability IS the fraction that actually went
 *     up in validation. Expected return and downside come from the same buckets.
 *  3. TEST — never used for fitting or selection — measures whether it works.
 *
 * A horizon is only VALIDATED if it passes the gate below on TEST. Otherwise the
 * app shows INSUFFICIENT EVIDENCE instead of a probability.
 */

export const HORIZONS = [1, 5, 20] as const;
export type Horizon = (typeof HORIZONS)[number];

export const SPLITS = {
  trainEnd: '2021-12-31',
  validationStart: '2022-01-01',
  validationEnd: '2023-12-31',
  testStart: '2024-01-01',
};

/** Fixed before training. */
export const GATE = {
  /** Brier skill vs the constant base rate must be positive on TEST… */
  minTestBrierSkill: 0,
  /** …and beat the simple momentum benchmark on TEST. */
  mustBeatMomentum: true,
  /** Weighted mean |predicted − realised| across buckets on TEST, at most 3 percentage points. */
  maxCalibrationError: 0.03,
  /** Highest bucket must have realised a higher average return than the lowest bucket on TEST. */
  requirePositiveSpread: true,
  /** A bucket needs this many validation samples before its numbers are shown for a stock. */
  minBucketSamples: 300,
};

export interface Sample {
  symbol: string;
  date: string;
  x: number[];
  ret: number;
  up: 0 | 1;
  targetFirst: 0 | 1 | null;
}

export interface Bucket {
  /** Raw-score range [lo, hi) for this bucket. */
  lo: number;
  hi: number;
  n: number;
  /** Validation: share that went up (this is the calibrated probability). */
  pUp: number;
  pUpCi: [number, number];
  meanRet: number;
  q10: number;
  q90: number;
  /** Validation: P(+2 ATR before −1 ATR within h days), among samples where either happened… */
  targetFirst: number | null;
  /** …and the share where neither happened within h days. */
  neitherRate: number;
  test: { n: number; pUp: number | null; meanRet: number | null };
}

export interface HorizonModel {
  horizon: Horizon;
  lambda: number;
  mean: number[];
  sd: number[];
  weights: number[];
  buckets: Bucket[];
  baseRate: number;
  momentum: { upIfPositive: number; upIfNotPositive: number };
  report: HorizonReport;
}

export interface Scores {
  n: number;
  brier: number;
  logLoss: number;
  accuracy: number;
  baseBrier: number;
  momentumBrier: number;
  brierSkill: number;
  brierSkillCi: [number, number];
  momentumSkill: number;
}

export interface HorizonReport {
  status: 'VALIDATED' | 'INSUFFICIENT EVIDENCE';
  reasons: string[];
  samples: { train: number; validation: number; test: number };
  periods: { train: string; validation: string; test: string };
  validation: Scores;
  test: Scores;
  calibrationError: number;
  spread: number | null;
  lambdaCandidates: { lambda: number; validationLogLoss: number }[];
  coefficients: { feature: string; weight: number }[];
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

export function standardizer(X: number[][]): { mean: number[]; sd: number[] } {
  const d = X[0]!.length;
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j]!;
  for (let j = 0; j < d; j++) mean[j] /= X.length;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j]! - mean[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / X.length) || 1;
  return { mean, sd };
}

/** Standardised, clipped to ±5 SD, with a leading 1 for the intercept. */
export function design(x: number[], mean: number[], sd: number[]): number[] {
  return [1, ...x.map((v, j) => Math.max(-5, Math.min(5, (v - mean[j]!) / sd[j]!)))];
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** L2-regularised logistic regression by Newton's method (the intercept is not penalised). */
export function fitLogistic(Z: number[][], y: number[], lambda: number, iterations = 30): number[] {
  const d = Z[0]!.length;
  let w = new Array(d).fill(0);
  for (let it = 0; it < iterations; it++) {
    const g = new Array(d).fill(0);
    const H: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let r = 0; r < Z.length; r++) {
      const z = Z[r]!;
      let s = 0;
      for (let j = 0; j < d; j++) s += w[j] * z[j]!;
      const p = sigmoid(s);
      const e = p - y[r]!;
      const wt = p * (1 - p);
      for (let j = 0; j < d; j++) {
        g[j] += e * z[j]!;
        const a = wt * z[j]!;
        for (let k = j; k < d; k++) H[j]![k]! += a * z[k]!;
      }
    }
    for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[j]![k] = H[k]![j]!;
    for (let j = 1; j < d; j++) {
      g[j] += lambda * w[j];
      H[j]![j]! += lambda;
    }
    const step = solve(H, g);
    w = w.map((v, j) => v - step[j]!);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return w;
}

/** Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]! || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / piv;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k];
    x[r] = s / (M[r]![r]! || 1e-12);
  }
  return x;
}

export function rawScore(w: number[], z: number[]): number {
  let s = 0;
  for (let j = 0; j < w.length; j++) s += w[j]! * z[j]!;
  return sigmoid(s);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function brier(p: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += (p[i]! - y[i]!) ** 2;
  return s / p.length;
}

export function logLoss(p: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i]!));
    s -= y[i]! ? Math.log(q) : Math.log(1 - q);
  }
  return s / p.length;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Wilson score interval (90%) for a proportion. */
export function wilson(k: number, n: number, z = 1.645): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Brier skill vs the base rate, with a 90% interval from resampling whole
 * calendar MONTHS — samples on the same day are correlated, so resampling
 * individual rows would overstate certainty.
 */
export function brierSkillWithCi(rows: { month: string; p: number; base: number; y: number }[], resamples = 500, seed = 7): { skill: number; ci: [number, number] } {
  const months = new Map<string, { m: number; b: number }>();
  for (const r of rows) {
    const e = months.get(r.month) ?? { m: 0, b: 0 };
    e.m += (r.p - r.y) ** 2;
    e.b += (r.base - r.y) ** 2;
    months.set(r.month, e);
  }
  const list = [...months.values()];
  const skillOf = (xs: { m: number; b: number }[]) => {
    let m = 0;
    let b = 0;
    for (const x of xs) {
      m += x.m;
      b += x.b;
    }
    return b > 0 ? 1 - m / b : 0;
  };
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let r = 0; r < resamples; r++) draws.push(skillOf(list.map(() => list[Math.floor(rnd() * list.length)]!)));
  draws.sort((a, b) => a - b);
  return { skill: skillOf(list), ci: [quantile(draws, 0.05), quantile(draws, 0.95)] };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

export function bucketFor(model: HorizonModel, x: number[]): Bucket {
  const p = rawScore(model.weights, design(x, model.mean, model.sd));
  return model.buckets.find((b) => p >= b.lo && p < b.hi) ?? (p < model.buckets[0]!.lo ? model.buckets[0]! : model.buckets.at(-1)!);
}

export interface Forecast {
  horizon: Horizon;
  status: 'OK' | 'INSUFFICIENT EVIDENCE' | 'INSUFFICIENT DATA';
  reason: string | null;
  pUp: number | null;
  pDown: number | null;
  pUpCi: [number, number] | null;
  expectedReturn: number | null;
  downside: number | null;
  upside: number | null;
  /** P(+2 ATR before −1 ATR) — a profit-TARGET probability, not a direction probability. */
  targetFirst: number | null;
  baseRate: number;
  bucketSamples: number;
  testCheck: { n: number; pUp: number | null; meanRet: number | null } | null;
}

export function forecast(model: HorizonModel, x: number[] | null): Forecast {
  const empty = { pUp: null, pDown: null, pUpCi: null, expectedReturn: null, downside: null, upside: null, targetFirst: null, baseRate: model.baseRate, bucketSamples: 0, testCheck: null };
  if (model.report.status !== 'VALIDATED') {
    return { horizon: model.horizon, status: 'INSUFFICIENT EVIDENCE', reason: `The ${model.horizon}-day model did not pass validation: ${model.report.reasons.join(' ')}`, ...empty };
  }
  if (!x) return { horizon: model.horizon, status: 'INSUFFICIENT DATA', reason: 'Not enough price history to compute every model input (needs 200+ completed daily candles).', ...empty };
  const b = bucketFor(model, x);
  if (b.n < GATE.minBucketSamples) {
    return { horizon: model.horizon, status: 'INSUFFICIENT DATA', reason: `Only ${b.n} similar historical cases (need ${GATE.minBucketSamples}).`, ...empty, bucketSamples: b.n };
  }
  return {
    horizon: model.horizon,
    status: 'OK',
    reason: null,
    pUp: b.pUp,
    pDown: 1 - b.pUp,
    pUpCi: b.pUpCi,
    expectedReturn: b.meanRet,
    downside: b.q10,
    upside: b.q90,
    targetFirst: b.targetFirst,
    baseRate: model.baseRate,
    bucketSamples: b.n,
    testCheck: b.test,
  };
}

// ---------------------------------------------------------------------------
// Training pipeline (used by `npm run research -- forecast-train`)
// ---------------------------------------------------------------------------

const month = (d: string) => d.slice(0, 7);

export function trainHorizon(samples: { train: Sample[]; validation: Sample[]; test: Sample[] }, horizon: Horizon): HorizonModel {
  const { train, validation, test } = samples;
  const { mean, sd } = standardizer(train.map((s) => s.x));
  const Ztr = train.map((s) => design(s.x, mean, sd));
  const ytr = train.map((s) => s.up);
  const Zva = validation.map((s) => design(s.x, mean, sd));
  const yva = validation.map((s) => s.up);

  // Regularisation strength chosen on validation log loss (test untouched).
  const candidates = [1, 100, 10_000].map((lambda) => {
    const w = fitLogistic(Ztr, ytr, lambda);
    return { lambda, w, validationLogLoss: logLoss(Zva.map((z) => rawScore(w, z)), yva) };
  });
  const best = candidates.reduce((a, b) => (b.validationLogLoss < a.validationLogLoss ? b : a));
  const w = best.w;

  // Calibration buckets: deciles of the raw score on VALIDATION.
  const rawVa = Zva.map((z) => rawScore(w, z));
  const sortedRaw = [...rawVa].sort((a, b) => a - b);
  const edges = [-Infinity, ...Array.from({ length: 9 }, (_, k) => quantile(sortedRaw, (k + 1) / 10)), Infinity];
  const rawTe = test.map((s) => rawScore(w, design(s.x, mean, sd)));
  const buckets: Bucket[] = [];
  for (let k = 0; k < 10; k++) {
    const lo = edges[k]!;
    const hi = edges[k + 1]!;
    const inV = validation.filter((_, i) => rawVa[i]! >= lo && rawVa[i]! < hi);
    const inT = test.filter((_, i) => rawTe[i]! >= lo && rawTe[i]! < hi);
    const ups = inV.filter((s) => s.up).length;
    const rets = inV.map((s) => s.ret).sort((a, b) => a - b);
    const decided = inV.filter((s) => s.targetFirst !== null);
    buckets.push({
      lo: k === 0 ? 0 : lo,
      hi: k === 9 ? 1.000001 : hi,
      n: inV.length,
      pUp: inV.length ? ups / inV.length : 0.5,
      pUpCi: wilson(ups, inV.length),
      meanRet: inV.length ? rets.reduce((a, b) => a + b, 0) / inV.length : 0,
      q10: quantile(rets, 0.1),
      q90: quantile(rets, 0.9),
      targetFirst: decided.length ? decided.filter((s) => s.targetFirst === 1).length / decided.length : null,
      neitherRate: inV.length ? 1 - decided.length / inV.length : 1,
      test: { n: inT.length, pUp: inT.length ? inT.filter((s) => s.up).length / inT.length : null, meanRet: inT.length ? inT.reduce((a, s) => a + s.ret, 0) / inT.length : null },
    });
  }

  const baseRate = ytr.reduce((a: number, b) => a + b, 0) / ytr.length;
  const pos = train.filter((s) => s.x[2]! > 0);
  const neg = train.filter((s) => s.x[2]! <= 0);
  const momentum = { upIfPositive: pos.filter((s) => s.up).length / Math.max(1, pos.length), upIfNotPositive: neg.filter((s) => s.up).length / Math.max(1, neg.length) };
  const model: HorizonModel = { horizon, lambda: best.lambda, mean, sd, weights: w, buckets, baseRate, momentum, report: null as unknown as HorizonReport };

  const score = (set: Sample[]): Scores => {
    const p = set.map((s) => bucketFor(model, s.x).pUp);
    const y = set.map((s) => s.up);
    const mom = set.map((s) => (s.x[2]! > 0 ? momentum.upIfPositive : momentum.upIfNotPositive));
    const b = brier(p, y);
    const bs = brierSkillWithCi(set.map((s, i) => ({ month: month(s.date), p: p[i]!, base: baseRate, y: s.up })));
    return {
      n: set.length,
      brier: b,
      logLoss: logLoss(p, y),
      accuracy: p.filter((q, i) => (q > 0.5 ? 1 : 0) === y[i]).length / set.length,
      baseBrier: brier(set.map(() => baseRate), y),
      momentumBrier: brier(mom, y),
      brierSkill: bs.skill,
      brierSkillCi: bs.ci,
      momentumSkill: 1 - b / brier(mom, y),
    };
  };
  const vScores = score(validation);
  const tScores = score(test);
  const testN = buckets.reduce((a, b) => a + b.test.n, 0);
  const calibrationError = buckets.reduce((a, b) => a + (b.test.pUp === null ? 0 : Math.abs(b.pUp - b.test.pUp) * b.test.n), 0) / Math.max(1, testN);
  const lowest = buckets[0]!.test.meanRet;
  const highest = buckets[9]!.test.meanRet;
  const spread = lowest !== null && highest !== null ? highest - lowest : null;

  const reasons: string[] = [];
  if (!(tScores.brierSkill > GATE.minTestBrierSkill)) reasons.push(`On unseen test data it was not more accurate than simply using the historical up-rate (Brier skill ${(tScores.brierSkill * 100).toFixed(2)}%).`);
  if (GATE.mustBeatMomentum && !(tScores.momentumSkill > 0)) reasons.push('It did not beat a simple momentum rule on test data.');
  if (calibrationError > GATE.maxCalibrationError) reasons.push(`Its probabilities were off by ${(calibrationError * 100).toFixed(1)} percentage points on average on test data (limit ${GATE.maxCalibrationError * 100}).`);
  if (GATE.requirePositiveSpread && !(spread !== null && spread > 0)) reasons.push('Its most bullish forecasts did not outperform its most bearish ones on test data.');

  model.report = {
    status: reasons.length ? 'INSUFFICIENT EVIDENCE' : 'VALIDATED',
    reasons: reasons.length ? reasons : ['Beat the base rate and momentum benchmarks on unseen test data, with acceptable calibration.'],
    samples: { train: train.length, validation: validation.length, test: test.length },
    periods: { train: `${train[0]?.date ?? '?'} → ${train.at(-1)?.date ?? '?'}`, validation: `${validation[0]?.date ?? '?'} → ${validation.at(-1)?.date ?? '?'}`, test: `${test[0]?.date ?? '?'} → ${test.at(-1)?.date ?? '?'}` },
    validation: vScores,
    test: tScores,
    calibrationError,
    spread,
    lambdaCandidates: candidates.map((c) => ({ lambda: c.lambda, validationLogLoss: c.validationLogLoss })),
    coefficients: FEATURE_NAMES.map((f, j) => ({ feature: f, weight: w[j + 1]! })),
  };
  return model;
}
