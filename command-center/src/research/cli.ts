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
import { cleanDaily, day, loadSeries, saveSeries, setCorporateActionCorrections, type DataCheck } from './data.js';
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

/** v1 = as pre-registered; v1.1 = identical rules and decision rule, with corporate-action corrections. */
const VERSION = process.argv[3] ?? 'v1';
if (VERSION !== 'v1') setCorporateActionCorrections(true);

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
  writeOnce(`validation-${VERSION}.json`, JSON.stringify({ version: VERSION, corporateActionCorrections: VERSION !== 'v1', recordedAt: new Date().toISOString(), dataCutoff: '2022-12-31', benchmarks: { train: benchmarks(train), validation: benchmarks(val) }, decisions, strategies }, null, 2));
}

async function final() {
  const vpath = resolve(RESULTS, `validation-${VERSION}.json`);
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
  writeOnce(`final-${VERSION}.json`, JSON.stringify({ version: VERSION, corporateActionCorrections: VERSION !== 'v1', recordedAt: new Date().toISOString(), benchmarks: { train: benchmarks(train), validation: benchmarks(val), test: benchmarks(test) }, strategies }, null, 2));
}

/**
 * POST-HOC diagnostic (not part of the pre-registered decision rule):
 * does a strategy pick better-than-average days, or does it just collect
 * market drift while it happens to be invested?
 */
async function diagnose() {
  const f = JSON.parse(readFileSync(resolve(RESULTS, `final-${VERSION}.json`), 'utf8')) as { strategies: Record<string, { trades: ResearchTrade[] }> };
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, strat] of Object.entries(f.strategies)) {
    out[id] = {};
    for (const pd of PERIODS) {
      let inSum = 0, inN = 0, allSum = 0, allN = 0, pnl = 0, sameCapitalHold = 0;
      for (const sym of RESEARCH_TICKERS) {
        const adj = loadSeries('sip-daily-all', sym);
        const ts = strat.trades.filter((t) => t.symbol === sym && inRange(t.entryTime, pd.start, pd.end));
        pnl += ts.reduce((a, t) => a + t.pnl, 0);
        for (let i = 1; i < adj.length; i++) {
          const b = adj[i]!;
          if (!inRange(b.t, pd.start, pd.end)) continue;
          const ret = b.c / adj[i - 1]!.c - 1;
          allSum += ret;
          allN++;
          const held = ts.find((t) => b.t > t.entryTime && b.t <= t.exitTime);
          if (held) {
            inSum += ret;
            inN++;
            sameCapitalHold += ret * held.shares * held.entryPrice;
          }
        }
      }
      out[id]![pd.id] = { inMarketAvgDailyBp: inN ? (inSum / inN) * 1e4 : null, allDaysAvgDailyBp: (allSum / allN) * 1e4, strategyPnl: pnl, sameCapitalSameDaysBuyHoldPnl: sameCapitalHold };
    }
  }
  writeFileSync(resolve(RESULTS, `diagnostics-${VERSION}.json`), JSON.stringify({ note: 'POST-HOC diagnostic, not used to change any rule or verdict. Close-to-close total-return approximation over each holding window.', results: out }, null, 2));
  console.log(JSON.stringify(out, null, 1));
}

/** Full result tables as Markdown, regenerated from the recorded JSON (never re-runs anything). */
async function tables() {
  const f = JSON.parse(readFileSync(resolve(RESULTS, `final-${VERSION}.json`), 'utf8'));
  const diag = JSON.parse(readFileSync(resolve(RESULTS, `diagnostics-${VERSION}.json`), 'utf8')).results;
  const n = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? '—' : x.toFixed(d));
  const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`;
  const ci = (c: [number, number] | null) => (c ? `[${n(c[0])}, ${n(c[1])}]` : '—');
  const L: string[] = [`# Full results (${VERSION})`, '', `Generated from \`results/final-${VERSION}.json\`. Each ticker is a separate $100 account; pooled return is on the combined $${100 * RESEARCH_TICKERS.length}. R = profit ÷ planned risk (≈ $1).`, ''];
  L.push('## Buy-and-hold benchmarks (total return, 100% invested)', '', `| Ticker | ${PERIODS.map((p) => p.label).join(' | ')} |`, `| --- | ${PERIODS.map(() => '---').join(' | ')} |`);
  for (const sym of RESEARCH_TICKERS) L.push(`| ${sym} | ${PERIODS.map((p) => `${n(f.benchmarks[p.id][sym], 1)}%`).join(' | ')} |`);
  L.push('', 'No-trade baseline: $0.00 and 0% in every period.', '');
  for (const [id, st] of Object.entries<any>(f.strategies)) {
    L.push(`## ${id} — ${st.name}`, '', `**Verdict: ${st.verdict.verdict}.** ${st.verdict.reasons.join(' ')}`, '');
    L.push('| Period | Trades | Net | Return | Exp. $ | Avg R | 90% CI (R) | PF | Win % | Avg win | Avg loss | Max DD | Exposure | Avg R @15 bps |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of [...PERIODS.map((x) => x.id), 'all']) {
      const q = st.periods[p];
      const sq = st.stressed[p];
      L.push(`| ${p} | ${q.trades} | ${usd(q.netPnl)} | ${n(q.netReturnPct)}% | ${n(q.expectancy)} | ${n(q.expectancyR)} | ${ci(q.expectancyRci)} | ${n(q.profitFactor)} | ${n((q.winRate ?? 0) * 100, 0)} | ${n(q.avgWin)} | ${n(q.avgLoss)} | ${usd(q.maxDrawdownUsd)} | ${n(q.exposurePct, 0)}% | ${sq ? n(sq.expectancyR) : '—'} |`);
    }
    L.push('', '**By calendar year (pooled):** ' + Object.entries<any>(st.years).map(([y, v]) => `${y}: ${v.trades}t ${n(v.expectancyR)}R`).join(' · '), '');
    const d = diag[id];
    L.push('**Timing diagnostic (post-hoc):** ' + PERIODS.map((p) => `${p.id}: in-market ${n(d[p.id].inMarketAvgDailyBp, 1)} bp/day vs all days ${n(d[p.id].allDaysAvgDailyBp, 1)}; strategy ${usd(d[p.id].strategyPnl)} vs same-capital hold ${usd(d[p.id].sameCapitalSameDaysBuyHoldPnl)}`).join(' · '), '');
    L.push('| Ticker | ' + PERIODS.map((p) => `${p.id} trades / net / avg R / PF / DD / exposure`).join(' | ') + ' |', '| --- | ' + PERIODS.map(() => '---').join(' | ') + ' |');
    for (const sym of RESEARCH_TICKERS) {
      L.push(`| ${sym} | ` + PERIODS.map((p) => { const q = st.periods[p.id].perTicker[sym]; return `${q.trades} / ${usd(q.netPnl)} / ${n(q.expectancyR)} / ${n(q.profitFactor)} / ${usd(q.maxDrawdownUsd)} / ${n(q.exposurePct, 0)}%`; }).join(' | ') + ' |');
    }
    L.push('');
  }
  writeFileSync(resolve(RESULTS, `tables-${VERSION}.md`), L.join('\n'));
  console.log(`wrote research/results/tables-${VERSION}.md`);
}

/**
 * Planning estimate for the C1 paper evaluation (does NOT change any rule):
 * replays 2016–2026 through the live C1 processor as ONE $100 account with
 * every live risk limit, to see how often 30 trades is reachable. Also checks,
 * ticker by ticker on real data, that the processor matches the research code.
 */
async function c1Feasibility() {
  setCorporateActionCorrections(true);
  const { openDb } = await import('../server/db.js');
  const { processC1 } = await import('../server/services/c1.js');
  const { runStrategy } = await import('./harness.js');
  const { TREND_FOLLOW } = await import('./strategies.js');
  const settings = { ...DEFAULT_SETTINGS };
  const series: Record<string, Candle[]> = {};
  for (const sym of RESEARCH_TICKERS) series[sym] = loadSeries('sip-daily-split', sym);

  const mismatches: string[] = [];
  for (const sym of RESEARCH_TICKERS) {
    const db = openDb(':memory:');
    processC1(db, { [sym]: series[sym]! }, settings, { universe: [sym], benchmark: sym, startDate: '2016-01-01', killSwitchOn: false, now: 0, requireWarmup: false });
    const paper = (db.prepare("SELECT entry_time, pnl FROM c1_trades WHERE status = 'closed' ORDER BY entry_time").all() as { entry_time: number; pnl: number }[]).map((t) => `${day(t.entry_time)}:${t.pnl.toFixed(6)}`);
    const research = runStrategy(sym, series[sym]!, TREND_FOLLOW, settings).filter((t) => !t.exitReason.startsWith('open at end')).map((t) => `${day(t.entryTime)}:${t.pnl.toFixed(6)}`);
    if (JSON.stringify(paper) !== JSON.stringify(research)) mismatches.push(`${sym}: paper ${paper.length} vs research ${research.length}`);
  }

  const db = openDb(':memory:');
  processC1(db, series, settings, { universe: [...RESEARCH_TICKERS], benchmark: 'SPY', startDate: '2016-01-01', killSwitchOn: false, now: 0, requireWarmup: false });
  const trades = db.prepare("SELECT entry_date, pnl, r_multiple, regime FROM c1_trades WHERE status = 'closed'").all() as { entry_date: string; pnl: number; r_multiple: number; regime: string }[];
  const signals = db.prepare("SELECT status, status_reason FROM c1_signals WHERE kind = 'entry' AND status != 'pending'").all() as { status: string; status_reason: string | null }[];
  const perYear: Record<string, number> = {};
  for (const t of trades) perYear[t.entry_date.slice(0, 4)] = (perYear[t.entry_date.slice(0, 4)] ?? 0) + 1;
  const skipReasons: Record<string, number> = {};
  for (const s of signals.filter((x) => x.status === 'skipped')) {
    const key = /open risk/i.test(s.status_reason ?? '') ? 'max open risk ($2) reached' : /Cooling-off/i.test(s.status_reason ?? '') ? 'cooldown after a loss' : /daily limit|shut down/i.test(s.status_reason ?? '') ? 'daily shutdown' : /below the stop/i.test(s.status_reason ?? '') ? 'opened below the stop' : 'other';
    skipReasons[key] = (skipReasons[key] ?? 0) + 1;
  }
  const years = Object.values(perYear);
  const out = {
    note: 'Planning estimate only. Historical replay of the live C1 processor as one $100 account with all live risk limits. Not a new test of the strategy: these years were already used in research.',
    processorMatchesResearchPerTicker: mismatches.length === 0,
    mismatches,
    portfolio: {
      trades: trades.length,
      tradesPerYear: perYear,
      medianTradesPerYear: years.sort((a, b) => a - b)[Math.floor(years.length / 2)],
      entrySignals: signals.length,
      executed: signals.filter((x) => x.status === 'executed').length,
      skipped: skipReasons,
      netPnl: trades.reduce((a, t) => a + t.pnl, 0),
      avgR: trades.reduce((a, t) => a + t.r_multiple, 0) / trades.length,
    },
  };
  writeFileSync(resolve(RESULTS, 'c1-portfolio-feasibility.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// Forecasting model (Trading Intelligence agent)
// ---------------------------------------------------------------------------

const FORECAST_DATA = 'universe-daily';

async function forecastFetch() {
  const { DEFAULT_UNIVERSE } = await import('../agent/universe.js');
  const p = provider();
  const end = '2026-10-29T00:00:00Z';
  const all = await p.dailyBarsMulti(DEFAULT_UNIVERSE, '2015-01-01T00:00:00Z', end, 'sip');
  const manifest: Record<string, { sha256: string; check: DataCheck }> = {};
  for (const sym of DEFAULT_UNIVERSE) {
    const { candles, check } = cleanDaily(all[sym] ?? []);
    manifest[sym] = { sha256: saveSeries(FORECAST_DATA, sym, candles), check };
    if (check.longGaps.length || check.invalidOhlc || candles.length < 500) console.log(`note ${sym}: ${check.bars} bars ${check.first}→${check.last} gaps=${check.longGaps.length} invalid=${check.invalidOhlc}`);
  }
  writeFileSync(resolve(RESULTS, 'forecast-data-manifest.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), range: { start: '2015-01-01', end }, feed: 'sip', adjustment: 'split', datasets: manifest }, null, 2));
  console.log(`saved ${Object.keys(manifest).length} symbols`);
}

async function forecastTrain() {
  const { DEFAULT_UNIVERSE } = await import('../agent/universe.js');
  const { computeFeatures, dateKey, label, marketContext } = await import('../agent/features.js');
  const { applyCorporateActions } = await import('../agent/corporate-actions.js');
  const { HORIZONS, SPLITS, trainHorizon } = await import('../agent/model.js');
  type Sample = import('../agent/model.js').Sample;
  const spy = loadSeries(FORECAST_DATA, 'SPY');
  const market = marketContext(spy);
  const series = Object.fromEntries(DEFAULT_UNIVERSE.map((sym) => [sym, applyCorporateActions(sym, loadSeries(FORECAST_DATA, sym))]));
  const models: Record<string, unknown> = {};
  for (const h of HORIZONS) {
    const sets = { train: [] as Sample[], validation: [] as Sample[], test: [] as Sample[] };
    for (const sym of DEFAULT_UNIVERSE) {
      const cs = series[sym]!;
      for (const row of computeFeatures(cs, market)) {
        const lb = label(cs, row.index, h, row.x[9]! * cs[row.index]!.c);
        if (!lb) continue;
        // Embargo: a sample belongs to a period only if its whole forward window is inside it.
        const endDate = dateKey(cs[row.index + h]!.t);
        const s: Sample = { symbol: sym, date: row.date, x: row.x, ...lb };
        if (endDate <= SPLITS.trainEnd) sets.train.push(s);
        else if (row.date >= SPLITS.validationStart && endDate <= SPLITS.validationEnd) sets.validation.push(s);
        else if (row.date >= SPLITS.testStart) sets.test.push(s);
      }
    }
    for (const k of ['train', 'validation', 'test'] as const) sets[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const t0 = Date.now();
    const m = trainHorizon(sets, h);
    const r = m.report;
    console.log(`h=${h}: ${r.status} | n train/val/test ${r.samples.train}/${r.samples.validation}/${r.samples.test} | λ=${m.lambda} | test Brier skill ${(r.test.brierSkill * 100).toFixed(2)}% [${(r.test.brierSkillCi[0] * 100).toFixed(2)}, ${(r.test.brierSkillCi[1] * 100).toFixed(2)}] vs momentum ${(r.test.momentumSkill * 100).toFixed(2)}% | calib err ${(r.calibrationError * 100).toFixed(2)}pp | spread ${r.spread === null ? 'n/a' : (r.spread * 100).toFixed(2) + '%'} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    for (const reason of r.reasons) console.log(`   - ${reason}`);
    models[h] = m;
  }
  writeOnce(`forecast-model-${VERSION}.json`, JSON.stringify({ version: VERSION, trainedAt: new Date().toISOString(), data: 'research/results/forecast-data-manifest.json', universe: DEFAULT_UNIVERSE, splits: SPLITS, models }, null, 1));
}

const fmt = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}R`);

const cmd = process.argv[2];
const run = { fetch: fetchAll, baseline, audit, validate, final, diagnose, tables, 'c1-feasibility': c1Feasibility, 'forecast-fetch': forecastFetch, 'forecast-train': forecastTrain } as Record<string, () => Promise<void>>;
if (!cmd || !run[cmd]) {
  console.error(`Usage: npm run research -- <${Object.keys(run).join('|')}>`);
  process.exit(1);
}
run[cmd]!().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
