/**
 * Strategy research CLI. Run from command-center/:
 *   npm run research -- fetch      download + fingerprint the datasets
 *   npm run research -- baseline   record the immutable baseline (refuses to overwrite)
 * Later stages are added as the research protocol proceeds.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBacktest } from '../engine/backtest.js';
import { DEFAULT_SETTINGS } from '../engine/settings.js';
import { filterRegularSession, normalizeCandles } from '../engine/time.js';
import type { Timeframe } from '../engine/types.js';
import { env } from '../server/env.js';
import { AlpacaProvider } from '../server/providers/alpaca.js';
import { DATA_RANGE, PERIODS, RESEARCH_TICKERS } from './config.js';
import { readFileSync } from 'node:fs';
import type { Candle } from '../engine/types.js';
import { cleanDaily, day, loadSeries, saveSeries, type DataCheck } from './data.js';
import { stage1, stage2, type Stage1 } from './decision.js';
import { runStrategy } from './harness.js';
import { buyAndHoldPct, inRange, summarize, type ResearchTrade, type Summary } from './stats.js';
import { CANDIDATES } from './strategies.js';
import { SLIPPAGE_BPS } from './config.js';

const RESULTS = resolve(process.cwd(), 'research/results');

function provider() {
  const p = new AlpacaProvider({ keyId: env.alpacaKeyId, secret: env.alpacaSecret, dataUrl: env.alpacaDataUrl, clockUrl: env.alpacaClockUrl, feed: env.alpacaFeed, timeoutMs: 30_000 });
  if (!p.isConfigured()) throw new Error('Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY first.');
  return p;
}

function writeOnce(file: string, content: string) {
  const p = resolve(RESULTS, file);
  if (existsSync(p)) throw new Error(`${file} already exists and is immutable. Delete it deliberately (and explain why in git) if it must be regenerated.`);
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(p, content);
  console.log(`wrote research/results/${file}`);
}

/** The exact runs reported to the user on 2026-10-29 (IEX feed, the last N completed bars up to 2026-10-28). */
export const REPORTED_BASELINE = [
  { symbol: 'SPY', timeframe: '1Day', bars: 1500, trades: 16, winRatePct: 19, profitFactor: 0.44, totalPnl: -5.66 },
  { symbol: 'SPY', timeframe: '1Hour', bars: 1740, trades: 17, winRatePct: 24, profitFactor: 0.49, totalPnl: -2.16 },
  { symbol: 'QQQ', timeframe: '1Day', bars: 1500, trades: 7, winRatePct: 29, profitFactor: 0.78, totalPnl: -0.95 },
  { symbol: 'QQQ', timeframe: '1Hour', bars: 1704, trades: 11, winRatePct: 27, profitFactor: 0.72, totalPnl: -0.99 },
  { symbol: 'AAPL', timeframe: '1Day', bars: 1500, trades: 9, winRatePct: 44, profitFactor: 1.07, totalPnl: 0.36 },
  { symbol: 'AAPL', timeframe: '1Hour', bars: 1775, trades: 14, winRatePct: 29, profitFactor: 0.48, totalPnl: -3.32 },
] as const;

async function fetchAll() {
  const p = provider();
  const manifest: Record<string, { sha256: string; check: DataCheck }> = {};
  for (const sym of RESEARCH_TICKERS) {
    for (const adjustment of ['split', 'all'] as const) {
      const raw = await p.historicalBars(sym, '1Day', { ...DATA_RANGE, feed: 'sip', adjustment });
      const { candles, check } = cleanDaily(raw);
      manifest[`sip-daily-${adjustment}/${sym}`] = { sha256: saveSeries(`sip-daily-${adjustment}`, sym, candles), check };
      console.log(`${sym} sip ${adjustment}: ${check.bars} bars ${check.first}→${check.last} gaps=${check.longGaps.length} invalid=${check.invalidOhlc}`);
    }
  }
  // Replication data for the originally reported baseline (IEX feed).
  for (const r of REPORTED_BASELINE) {
    const tf = r.timeframe as Timeframe;
    const start = tf === '1Day' ? '2020-01-01T00:00:00Z' : '2025-06-01T00:00:00Z';
    const raw = await p.historicalBars(r.symbol, tf, { start, end: '2026-10-29T00:00:00Z', feed: 'iex', adjustment: 'split' });
    const candles = filterRegularSession(normalizeCandles(raw), tf).slice(-r.bars);
    manifest[`iex-replication/${r.symbol}-${tf}`] = { sha256: saveSeries('iex-replication', `${r.symbol}-${tf}`, candles), check: { bars: candles.length, first: day(candles[0]!.t), last: day(candles.at(-1)!.t), duplicatesRemoved: 0, invalidOhlc: 0, longGaps: [] } };
  }
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(resolve(RESULTS, 'data-manifest.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'Alpaca Market Data v2', range: DATA_RANGE, datasets: manifest }, null, 2));
  console.log('wrote research/results/data-manifest.json');
}

const toResearch = (symbol: string, strategy: string, ts: ReturnType<typeof runBacktest>['trades']): ResearchTrade[] =>
  ts.map((t) => ({ symbol, strategy, entryTime: t.entryTime, exitTime: t.exitTime, entryPrice: t.entryPrice, exitReason: t.exitReason, shares: t.shares, plannedRisk: t.plannedRisk, pnl: t.pnl, rMultiple: t.rMultiple }));

async function baseline() {
  const settings = { ...DEFAULT_SETTINGS };
  const params = { maxHoldBars: 20, warmupBars: 60, outOfSampleFraction: 0.3 };

  // A) Replicate the numbers already reported, to prove the baseline is captured exactly.
  const replication = REPORTED_BASELINE.map((r) => {
    const candles = loadSeries('iex-replication', `${r.symbol}-${r.timeframe}`);
    const res = runBacktest(candles, { timeframe: r.timeframe as Timeframe, settings, ...params });
    return {
      ...r,
      replicated: { bars: candles.length, trades: res.all.trades, winRatePct: Math.round((res.all.winRate ?? 0) * 100), profitFactor: res.all.profitFactor === null ? null : Math.round(res.all.profitFactor * 100) / 100, totalPnl: Math.round(res.all.totalPnl * 100) / 100 },
      trades: toResearch(r.symbol, 'BASELINE', res.trades),
    };
  });

  // B) The same, unmodified baseline on the full 2016–2026 research dataset, by period.
  const research = RESEARCH_TICKERS.map((sym) => {
    const candles = loadSeries('sip-daily-split', sym);
    const res = runBacktest(candles, { timeframe: '1Day', settings, ...params });
    const trades = toResearch(sym, 'BASELINE', res.trades);
    return {
      symbol: sym,
      bars: candles.length,
      all: summarize(trades, candles, settings.startingCapitalUsd),
      periods: Object.fromEntries(
        PERIODS.map((pd) => [pd.id, summarize(trades.filter((t) => inRange(t.entryTime, pd.start, pd.end)), candles.filter((b) => inRange(b.t, pd.start, pd.end)), settings.startingCapitalUsd)]),
      ),
      trades,
    };
  });

  writeOnce(
    'baseline-v1.json',
    JSON.stringify(
      {
        version: 1,
        recordedAt: new Date().toISOString(),
        codeCommit: '5bbefc1 (engine as delivered; before any audit fix)',
        settings,
        params,
        replication,
        research,
      },
      null,
      2,
    ),
  );
}

/**
 * Checks every baseline trade against the raw candles, using the CURRENT
 * (audited) engine. Each invariant is something a correct backtester must
 * never violate; any violation is listed with the offending trade.
 */
async function audit() {
  const settings = { ...DEFAULT_SETTINGS };
  const bps = settings.slippageBps / 10_000;
  const violations: Record<string, string[]> = {
    entryNotAfterSignal: [],
    entryPriceOutsideEntryCandle: [],
    triggerNotReached: [],
    overlappingTrades: [],
    nonGapStopOverBudget: [],
    positionOverCap: [],
    targetFilledWithoutTradeThrough: [],
    tradeInMoreThanOnePeriod: [],
    lookAheadTruncation: [],
  };
  const counts = { trades: 0, gapStops: 0, worstGapLossR: 0 };
  for (const sym of RESEARCH_TICKERS) {
    const candles = loadSeries('sip-daily-split', sym);
    const byTime = new Map(candles.map((c, i) => [c.t, i]));
    const res = runBacktest(candles, { timeframe: '1Day', settings, maxHoldBars: 20, warmupBars: 60, outOfSampleFraction: 0.3 });
    let prevExit = -Infinity;
    for (const t of res.trades) {
      counts.trades++;
      const id = `${sym} ${day(t.entryTime)}`;
      const e = candles[byTime.get(t.entryTime)!]!;
      const raw = t.entryPrice / (1 + bps);
      if (!(t.entryTime > t.signalTime)) violations.entryNotAfterSignal!.push(id);
      if (raw < e.l - 1e-6 || raw > e.h + 1e-6) violations.entryPriceOutsideEntryCandle!.push(id);
      if (t.setupType !== 'BREAKOUT' && raw < e.o - 1e-6 && e.h < raw - 1e-6) violations.triggerNotReached!.push(id);
      if (t.entryTime <= prevExit) violations.overlappingTrades!.push(id);
      prevExit = t.exitTime;
      if (t.exitReason === 'stop' && t.pnl < -(settings.riskPerTradeUsd + 0.005)) violations.nonGapStopOverBudget!.push(`${id} pnl ${t.pnl.toFixed(3)}`);
      if (t.shares * t.entryPrice > settings.maxPositionUsd + 0.01) violations.positionOverCap!.push(id);
      if (t.exitReason.startsWith('take-profit')) {
        const x = candles[byTime.get(t.exitTime)!]!;
        const target = t.exitReason === 'take-profit 2' ? t.tp2 : t.tp1;
        if (x.h < target + 0.01 - 1e-9) violations.targetFilledWithoutTradeThrough!.push(id);
      }
      const periods = PERIODS.filter((pd) => inRange(t.entryTime, pd.start, pd.end)).length;
      if (periods !== 1) violations.tradeInMoreThanOnePeriod!.push(id);
      if (t.exitReason.includes('gap') && !t.exitReason.includes('breakeven')) {
        counts.gapStops++;
        counts.worstGapLossR = Math.min(counts.worstGapLossR, t.rMultiple);
      }
    }
    // Look-ahead: cutting the data at a date must not change any trade that closed before it.
    for (const cut of ['2018-06-29', '2021-06-30', '2024-06-28']) {
      const idx = candles.findIndex((c) => day(c.t) > cut);
      const cutT = candles[idx]!.t;
      const truncated = runBacktest(candles.slice(0, idx), { timeframe: '1Day', settings, maxHoldBars: 20, warmupBars: 60, outOfSampleFraction: 0.3 });
      const a = res.trades.filter((t) => t.exitTime < cutT && !t.exitReason.startsWith('open at end')).map((t) => `${t.entryTime}:${t.pnl.toFixed(6)}`);
      const b = truncated.trades.filter((t) => t.exitTime < cutT && !t.exitReason.startsWith('open at end')).map((t) => `${t.entryTime}:${t.pnl.toFixed(6)}`);
      if (JSON.stringify(a) !== JSON.stringify(b)) violations.lookAheadTruncation!.push(`${sym} cut ${cut}`);
    }
    console.log(`${sym}: ${res.trades.length} trades checked`);
  }
  const out = { checkedAt: new Date().toISOString(), engine: 'audited (resize at fill, trade-through targets)', counts, violations };
  writeFileSync(resolve(RESULTS, 'audit.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ counts, violations: Object.fromEntries(Object.entries(violations).map(([k, v]) => [k, v.length])) }, null, 2));
}

// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------

const STRATEGY_IDS = ['C0_BASELINE_AUDITED', ...CANDIDATES.map((c) => c.id)];
const STRATEGY_NAMES: Record<string, string> = { C0_BASELINE_AUDITED: 'Baseline (audited engine)', ...Object.fromEntries(CANDIDATES.map((c) => [c.id, c.name])) };

function runOne(id: string, sym: string, candles: Candle[], slippageBps: number): ResearchTrade[] {
  const settings = { ...DEFAULT_SETTINGS, slippageBps };
  if (id === 'C0_BASELINE_AUDITED') return toResearch(sym, id, runBacktest(candles, { timeframe: '1Day', settings, maxHoldBars: 20, warmupBars: 60, outOfSampleFraction: 0.3 }).trades);
  return runStrategy(sym, candles, CANDIDATES.find((c) => c.id === id)!, settings);
}

type Range = { start: string; end: string };
const yearRanges = (from: number, to: number): (Range & { id: string })[] => Array.from({ length: to - from + 1 }, (_, k) => ({ id: String(from + k), start: `${from + k}-01-01`, end: `${from + k}-12-31` }));

/** Pooled = every ticker's trades together. Exposure is the average of per-ticker exposure; return is on the combined $100 × tickers. */
function pooled(byTicker: Record<string, ResearchTrade[]>, bars: Record<string, Candle[]>, r: Range): Summary & { perTicker: Record<string, Summary> } {
  const perTicker: Record<string, Summary> = {};
  const all: ResearchTrade[] = [];
  for (const [sym, ts] of Object.entries(byTicker)) {
    const inP = ts.filter((t) => inRange(t.entryTime, r.start, r.end));
    perTicker[sym] = summarize(inP, bars[sym]!.filter((b) => inRange(b.t, r.start, r.end)), DEFAULT_SETTINGS.startingCapitalUsd);
    all.push(...inP);
  }
  const syms = Object.keys(byTicker);
  const sum = summarize(all, [], DEFAULT_SETTINGS.startingCapitalUsd * syms.length);
  sum.exposurePct = syms.reduce((a, k) => a + perTicker[k]!.exposurePct, 0) / syms.length;
  return { ...sum, perTicker };
}

function benchmarks(r: Range) {
  return Object.fromEntries(RESEARCH_TICKERS.map((sym) => [sym, buyAndHoldPct(loadSeries('sip-daily-all', sym), r.start, r.end)]));
}

async function validate() {
  const cutoff = Date.parse('2023-01-01T00:00:00Z');
  const train = PERIODS[0];
  const val = PERIODS[1];
  const bars: Record<string, Candle[]> = {};
  for (const sym of RESEARCH_TICKERS) bars[sym] = loadSeries('sip-daily-split', sym).filter((b) => b.t < cutoff); // final-test candles are not even loaded
  const strategies: Record<string, unknown> = {};
  const decisions: Record<string, Stage1> = {};
  for (const id of STRATEGY_IDS) {
    const res: Record<string, Record<string, ResearchTrade[]>> = {};
    for (const bps of [SLIPPAGE_BPS.base, SLIPPAGE_BPS.stressed]) {
      res[bps] = {};
      for (const sym of RESEARCH_TICKERS) res[bps]![sym] = runOne(id, sym, bars[sym]!, bps);
    }
    const base = res[SLIPPAGE_BPS.base]!;
    const stressed = res[SLIPPAGE_BPS.stressed]!;
    const out = {
      name: STRATEGY_NAMES[id],
      train: pooled(base, bars, train),
      validation: pooled(base, bars, val),
      trainStressed: pooled(stressed, bars, train),
      validationStressed: pooled(stressed, bars, val),
      years: Object.fromEntries(yearRanges(2016, 2022).map((y) => [y.id, pooled(base, bars, y)])),
      trades: Object.values(base).flat(),
    };
    decisions[id] = stage1({ defects: [], train: out.train, validation: out.validation, validationStressed: out.validationStressed });
    strategies[id] = { ...out, decision: decisions[id] };
    const v = out.validation;
    console.log(`${id}: train ${out.train.trades}t ${fmt(out.train.expectancyR)} | validation ${v.trades}t ${fmt(v.expectancyR)} PF ${v.profitFactor?.toFixed(2)} | @15bps ${fmt(out.validationStressed.expectancyR)} → ${decisions[id]!.rejected ? 'REJECTED' : decisions[id]!.advance ? 'ADVANCES' : 'does not advance'}`);
  }
  writeOnce('validation-v1.json', JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), dataCutoff: '2022-12-31', benchmarks: { train: benchmarks(train), validation: benchmarks(val) }, decisions, strategies }, null, 2));
}

async function final() {
  const vpath = resolve(RESULTS, 'validation-v1.json');
  if (!existsSync(vpath)) throw new Error('Run validate first: the final test may only be evaluated after validation decisions are recorded.');
  const decisions = JSON.parse(readFileSync(vpath, 'utf8')).decisions as Record<string, Stage1>;
  const bars: Record<string, Candle[]> = {};
  for (const sym of RESEARCH_TICKERS) bars[sym] = loadSeries('sip-daily-split', sym);
  const [train, val, test] = PERIODS;
  const valPlusTest = { start: val.start, end: test.end };
  const strategies: Record<string, unknown> = {};
  for (const id of STRATEGY_IDS) {
    const res: Record<number, Record<string, ResearchTrade[]>> = {};
    for (const bps of [SLIPPAGE_BPS.base, SLIPPAGE_BPS.stressed]) {
      res[bps] = {};
      for (const sym of RESEARCH_TICKERS) res[bps]![sym] = runOne(id, sym, bars[sym]!, bps);
    }
    const base = res[SLIPPAGE_BPS.base]!;
    const stressed = res[SLIPPAGE_BPS.stressed]!;
    const testSum = pooled(base, bars, test);
    const combined = pooled(base, bars, valPlusTest);
    const verdict = stage2({
      stage1: decisions[id]!,
      test: testSum,
      testStressed: pooled(stressed, bars, test),
      perTickerExpectancyR: Object.entries(combined.perTicker).map(([symbol, s]) => ({ symbol, trades: s.trades, expectancyR: s.expectancyR })),
    });
    strategies[id] = {
      name: STRATEGY_NAMES[id],
      stage1: decisions[id],
      verdict,
      periods: { train: pooled(base, bars, train), validation: pooled(base, bars, val), test: testSum, all: pooled(base, bars, { start: train.start, end: test.end }) },
      stressed: { train: pooled(stressed, bars, train), validation: pooled(stressed, bars, val), test: pooled(stressed, bars, test) },
      validationPlusTest: combined,
      years: Object.fromEntries(yearRanges(2016, 2026).map((y) => [y.id, pooled(base, bars, y)])),
      trades: Object.values(base).flat(),
    };
    console.log(`${id}: test ${testSum.trades}t ${fmt(testSum.expectancyR)} PF ${testSum.profitFactor?.toFixed(2)} → ${verdict.verdict}`);
  }
  writeOnce('final-v1.json', JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), benchmarks: { train: benchmarks(train), validation: benchmarks(val), test: benchmarks(test) }, strategies }, null, 2));
}

const fmt = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}R`);

const cmd = process.argv[2];
const run = { fetch: fetchAll, baseline, audit, validate, final } as Record<string, () => Promise<void>>;
if (!cmd || !run[cmd]) {
  console.error(`Usage: npm run research -- <${Object.keys(run).join('|')}>`);
  process.exit(1);
}
run[cmd]!().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
