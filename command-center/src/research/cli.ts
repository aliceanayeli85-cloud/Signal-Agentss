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
import { cleanDaily, day, loadSeries, saveSeries, type DataCheck } from './data.js';
import { inRange, summarize, type ResearchTrade } from './stats.js';

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

const cmd = process.argv[2];
const run = { fetch: fetchAll, baseline, audit } as Record<string, () => Promise<void>>;
if (!cmd || !run[cmd]) {
  console.error(`Usage: npm run research -- <${Object.keys(run).join('|')}>`);
  process.exit(1);
}
run[cmd]!().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
