import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyCorporateActions } from '../../agent/corporate-actions.js';
import { CLASS_ORDER, classify, planFor, rankScore, riskOf, sizeFor, stanceOf, type AgentPlan, type Classification, type Sizing } from '../../agent/classify.js';
import { computeFeatures, dateKey, marketContext } from '../../agent/features.js';
import { bucketFor, design, forecast, HORIZONS, rawScore, type Forecast, type HorizonModel } from '../../agent/model.js';
import { detectSignals, runAnalysis, technicals, type Signal, type Technicals } from '../../agent/signals.js';
import { DEFAULT_UNIVERSE, isLeveragedOrInverse, LIQUIDITY, plausibleCommonTicker, sectorOf } from '../../agent/universe.js';
import { buildTradePlan, type Quote } from '../../engine/plan.js';
import { checkEntry } from '../../engine/risk.js';
import type { RiskSettings } from '../../engine/settings.js';
import { isCandleComplete, normalizeCandles, nyParts } from '../../engine/time.js';
import type { Candle } from '../../engine/types.js';
import { getKillSwitch, getKv, getSettings, setKv, type Db } from '../db.js';
import { logger } from '../logger.js';
import type { NewsItem } from '../providers/alpaca.js';
import type { Deps } from './analysis.js';
import { describeError } from './market.js';
import { recordAlert, type NewAlert } from './monitor.js';

// ---------------------------------------------------------------------------
// Configuration, holdings, model
// ---------------------------------------------------------------------------

export interface AgentConfig {
  enabled: boolean;
  /** New York times (HH:MM) for scheduled scans on weekdays. */
  scheduleET: string[];
  extraSymbols: string[];
  removedSymbols: string[];
  useScreener: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = { enabled: true, scheduleET: ['08:45', '16:30'], extraSymbols: [], removedSymbols: [], useScreener: true };

export function agentConfig(db: Db): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...(getKv<Partial<AgentConfig>>(db, 'agent_config') ?? {}) };
}

export interface Holding {
  symbol: string;
  shares: number;
  cost_basis: number;
  source: string;
  note: string | null;
  updated_at: number;
}

export const holdings = (db: Db) => db.prepare('SELECT * FROM holdings ORDER BY symbol').all() as Holding[];

/** Cash available in the real Robinhood account, as entered by the user. Never assumed. */
export const robinhoodCash = (db: Db): number | null => getKv<number>(db, 'robinhood_cash');

export interface LoadedModel {
  version: string;
  trainedAt: string;
  splits: Record<string, string>;
  models: Record<string, HorizonModel>;
}

let cachedModel: LoadedModel | null | undefined;
export function loadModel(path = resolve(process.cwd(), 'research/results/forecast-model-v1.json')): LoadedModel | null {
  if (cachedModel !== undefined) return cachedModel;
  cachedModel = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LoadedModel) : null;
  return cachedModel;
}
export function setModelForTests(m: LoadedModel | null) {
  cachedModel = m;
}

function forecastsFor(model: LoadedModel | null, x: number[] | null): Record<number, Forecast> {
  const out: Record<number, Forecast> = {};
  for (const h of HORIZONS) {
    const m = model?.models[h];
    out[h] = m
      ? forecast(m, x)
      : { horizon: h, status: 'INSUFFICIENT EVIDENCE', reason: 'No trained model file was found.', pUp: null, pDown: null, pUpCi: null, expectedReturn: null, downside: null, upside: null, targetFirst: null, baseRate: 0.5, bucketSamples: 0, testCheck: null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation of one symbol
// ---------------------------------------------------------------------------

export interface Opportunity {
  symbol: string;
  name: string | null;
  sector: string;
  source: 'universe' | 'screener' | 'holding' | 'lookup';
  price: number | null;
  priceTime: number | null;
  priceSource: string | null;
  spreadPct: number | null;
  dataThrough: string;
  classification: Classification;
  classReasons: string[];
  stance: 'bullish' | 'bearish' | 'neutral';
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  forecasts: Record<number, Forecast>;
  technicals: Technicals & { trend: string; weeklyTrend: string; support: number | null; resistance: number | null };
  signals: Signal[];
  plan: AgentPlan | null;
  sizing: Sizing | null;
  rankScore: number;
  rank: number;
  explanation: { what: string; whyRise: string[]; whyFall: string[]; entry: string[]; capital: string; loss: string; targets: string; invalidation: string };
  evidence: string;
  held: { shares: number; costBasis: number; value: number | null; pnl: number | null; pnlPct: number | null } | null;
  news: NewsItem[];
  earnings: string | null;
  shadow: Record<number, { rawP: number; bucket: number } | null>;
}

export interface EvalContext {
  settings: RiskSettings;
  capital: { cash: number; equity: number };
  model: LoadedModel | null;
  market: ReturnType<typeof marketContext>;
  spy: Candle[];
  now: number;
  marketOpen: boolean | null;
  killSwitch: boolean;
}

const EVIDENCE: Record<string, string> = {
  pattern: 'Research record: the app\'s pattern setups were REJECTED in out-of-sample testing (they lost money in 2020–2022). Treat as practice only.',
  breakout: 'Research record: 20-day breakouts in an uptrend (C1-style) were positive in all research periods but showed no timing skill, and remain EXPERIMENTAL in paper testing.',
  none: 'No setup with a tested track record applies.',
};

export function evaluateSymbol(symbol: string, cs: Candle[], quote: Quote | null, hold: Holding | null, ctx: EvalContext, source: Opportunity['source'], name: string | null): Opportunity {
  const t = technicals(cs, ctx.spy);
  const an = runAnalysis(cs);
  const signals = detectSignals(cs, t, an);
  const rows = computeFeatures(cs, ctx.market);
  const last = rows.at(-1);
  const x = last && last.index === cs.length - 1 ? last.x : null;
  const forecasts = forecastsFor(ctx.model, x);
  const shadow: Opportunity['shadow'] = {};
  for (const h of HORIZONS) {
    const m = ctx.model?.models[h];
    shadow[h] = m && x ? { rawP: rawScore(m.weights, design(x, m.mean, m.sd)), bucket: m.buckets.indexOf(bucketFor(m, x)) + 1 } : null;
  }
  const guard = checkEntry(ctx.settings, { equity: ctx.capital.equity, cash: ctx.capital.cash, openRiskUsd: 0, openSymbols: [], workingOrders: [], todayRealizedPnl: 0, tradesToday: 0, consecutiveLossesToday: 0, lastLoss: null, lossSymbolsToday: [], killSwitch: ctx.killSwitch }, null, ctx.now);
  const q = quote ?? { price: t.close, time: t.date, source: 'last completed daily close' };
  const pattern = an.setups.length ? buildTradePlan({ symbol, analysis: an, quote: q, settings: ctx.settings, cashUsd: ctx.capital.cash, guard, now: ctx.now, marketOpen: ctx.marketOpen }) : null;
  const plan = planFor(t, an, pattern, signals);
  const spreadPct = quote?.bid && quote.ask ? (quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2) : null;
  const spreadUsed = spreadPct !== null && spreadPct < 0.05 ? spreadPct : null;
  const sizing = plan ? sizeFor(plan, ctx.capital, ctx.settings, spreadUsed) : null;
  const dataOk = cs.length >= LIQUIDITY.minHistory && t.sma200 !== null;
  const { classification, reasons } = classify({ held: hold !== null, t, an, signals, plan, sizing, f20: forecasts[20]!, dataOk });
  const costPct = sizing && sizing.notional > 0 ? sizing.costs / sizing.notional : (ctx.settings.slippageBps * 2) / 10_000 + (spreadUsed ?? 0);
  const price = quote?.price ?? null;
  const held = hold ? { shares: hold.shares, costBasis: hold.cost_basis, value: price !== null ? hold.shares * price : null, pnl: price !== null ? hold.shares * price - hold.cost_basis : null, pnlPct: price !== null && hold.cost_basis > 0 ? (hold.shares * price) / hold.cost_basis - 1 : null } : null;
  const f20 = forecasts[20]!;
  const fx = (f: Forecast) => (f.status === 'OK' ? `a validated ${f.horizon}-day forecast gives ${(f.pUp! * 100).toFixed(0)}% chance of being higher (base rate ${(f.baseRate * 100).toFixed(0)}%)` : null);
  return {
    symbol,
    name,
    sector: sectorOf(symbol),
    source,
    price,
    priceTime: quote?.time ?? null,
    priceSource: quote?.source ?? null,
    spreadPct,
    dataThrough: dateKey(t.date),
    classification,
    classReasons: reasons,
    stance: stanceOf(signals, an.trend.trend),
    risk: riskOf(t, plan),
    forecasts,
    technicals: { ...t, trend: an.trend.trend, weeklyTrend: an.higherTimeframe?.trend.trend ?? 'unknown', support: an.support?.price ?? null, resistance: an.resistance?.price ?? null },
    signals,
    plan,
    sizing,
    rankScore: classification === 'BUY WATCHLIST' || classification === 'STRONG BUY SETUP' ? rankScore(plan, f20, costPct) : -Infinity,
    rank: 0,
    explanation: {
      what: plan ? `${plan.label} in ${symbol}.` : `${symbol}: no tradable setup right now.`,
      whyRise: [...signals.filter((s) => s.direction === 'bullish').map((s) => s.detail), ...(fx(f20) ? [fx(f20)!] : [])].slice(0, 5),
      whyFall: [
        ...signals.filter((s) => s.direction === 'bearish').map((s) => s.detail),
        ...(an.trend.trend !== 'uptrend' ? [`The daily trend is ${an.trend.trend}.`] : []),
        ...(t.rsi14 !== null && t.rsi14 > 70 ? ['RSI is stretched above 70; buyers may be exhausted.'] : []),
        'Earnings, news or a market sell-off can gap the price through any stop.',
      ].slice(0, 5),
      entry: plan ? [`Buy only between $${plan.entryLow.toFixed(2)} and $${plan.entryHigh.toFixed(2)}.`, ...plan.confirmation] : ['No entry: conditions are not met.'],
      capital: sizing ? (sizing.fit === 'FITS' ? `About $${sizing.notional.toFixed(2)} (${sizing.shares} shares). A full $1-risk position would need about $${sizing.capitalNeededForFullSize.toFixed(2)}.` : `${sizing.message} A full $1-risk position would need about $${sizing.capitalNeededForFullSize.toFixed(2)}.`) : 'n/a',
      loss: sizing && sizing.fit === 'FITS' ? `About $${sizing.maxLoss.toFixed(2)} if the stop fills as planned — more if price gaps below it.` : plan ? `Up to $${ctx.settings.riskPerTradeUsd.toFixed(2)} at full size if the stop fills as planned — more on a gap.` : 'n/a',
      targets: plan ? `Target 1 $${plan.tp1.toFixed(2)} (+${(((plan.tp1 - plan.entryHigh) / plan.entryHigh) * 100).toFixed(1)}%), target 2 $${plan.tp2.toFixed(2)}. These are plan levels, not forecasts; they are only reached if the move happens.` : 'n/a',
      invalidation: plan ? `${plan.invalidation} Stop $${plan.stop.toFixed(2)}.` : 'n/a',
    },
    evidence: EVIDENCE[plan?.source ?? 'none']!,
    held,
    news: [],
    earnings: null,
    shadow,
  };
}

/** 20-day return ÷ (daily volatility × √20): trend strength per unit of risk. Measurable, not a validated predictor. */
export const riskAdjustedMomentum = (o: Opportunity) => (o.technicals.ret20 !== null && o.technicals.atrPct ? o.technicals.ret20 / (o.technicals.atrPct * Math.sqrt(20)) : -9);

export const RANKING_RULE = 'Ranked by class, then by cost-adjusted planned reward-to-risk (rounded to 0.1), then by 20-day return ÷ volatility. While no forecast is validated, neither measure is evidence that a stock will rise.';

export function rankOpportunities(list: Opportunity[]): Opportunity[] {
  const r = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : -1e9);
  const sorted = [...list].sort((a, b) => CLASS_ORDER.indexOf(a.classification) - CLASS_ORDER.indexOf(b.classification) || r(b.rankScore) - r(a.rankScore) || riskAdjustedMomentum(b) - riskAdjustedMomentum(a));
  return sorted.map((o, i) => ({ ...o, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// Market conditions and briefing
// ---------------------------------------------------------------------------

export interface MarketConditions {
  asOf: string;
  spy: { close: number; trend: string; above200: boolean | null; ret20: number | null; realizedVol20: number | null };
  breadth: { above50: number | null; above200: number | null; scanned: number };
  regime: string;
  baseRates: Record<number, number | null>;
  modelStatus: Record<number, string>;
}

export function marketConditions(spy: Candle[], opps: Opportunity[], model: LoadedModel | null): MarketConditions {
  const t = technicals(spy, spy);
  const an = runAnalysis(spy);
  const rets = spy.slice(-21).map((c, i, a) => (i ? Math.log(c.c / a[i - 1]!.c) : 0)).slice(1);
  const m = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const vol = rets.length > 2 ? Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) : null;
  const known50 = opps.filter((o) => o.technicals.sma50 !== null);
  const known200 = opps.filter((o) => o.technicals.sma200 !== null);
  const above50 = known50.length ? known50.filter((o) => o.technicals.close > o.technicals.sma50!).length / known50.length : null;
  const above200 = known200.length ? known200.filter((o) => o.technicals.close > o.technicals.sma200!).length / known200.length : null;
  const spyAbove = t.sma200 !== null ? t.close > t.sma200 : null;
  const regime = spyAbove === null ? 'Unknown' : spyAbove && an.trend.trend === 'uptrend' && (above50 ?? 0) >= 0.5 ? 'Risk-on: SPY uptrend above its 200-day average with broad participation' : spyAbove ? 'Mixed: SPY above its 200-day average but trend or breadth is weak' : 'Risk-off: SPY below its 200-day average';
  return {
    asOf: dateKey(t.date),
    spy: { close: t.close, trend: an.trend.trend, above200: spyAbove, ret20: t.ret20, realizedVol20: vol },
    breadth: { above50, above200, scanned: opps.length },
    regime,
    baseRates: Object.fromEntries(HORIZONS.map((h) => [h, model?.models[h]?.baseRate ?? null])),
    modelStatus: Object.fromEntries(HORIZONS.map((h) => [h, model?.models[h]?.report.status ?? 'NO MODEL'])),
  };
}

export interface Briefing {
  date: string;
  headline: string;
  sections: { title: string; lines: string[] }[];
}

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);

export function buildBriefing(mc: MarketConditions, ranked: Opportunity[], held: Opportunity[], changes: string[], cash: number | null, marketNews: NewsItem[]): Briefing {
  const buys = ranked.filter((o) => o.classification === 'STRONG BUY SETUP' || o.classification === 'BUY WATCHLIST');
  const fitting = buys.filter((o) => o.sizing?.fit === 'FITS');
  const validated = Object.values(mc.modelStatus).some((s) => s === 'VALIDATED');
  const headline =
    `${mc.regime}. ${buys.length} stock(s) meet the BUY WATCHLIST rules${buys.some((b) => b.classification === 'STRONG BUY SETUP') ? ', including STRONG BUY setups' : ''}; ` +
    (fitting.length ? `${fitting.length} fit your available cash.` : `none fits your available cash ($${(cash ?? 0).toFixed(2)}) — keep your money.`);
  return {
    date: mc.asOf,
    headline,
    sections: [
      {
        title: 'Market conditions',
        lines: [
          `SPY closed $${mc.spy.close.toFixed(2)} (${mc.spy.trend}; ${mc.spy.above200 ? 'above' : 'below'} its 200-day average; ${pct(mc.spy.ret20)} over 20 days).`,
          `Breadth: ${pct(mc.breadth.above50, 0)} of ${mc.breadth.scanned} scanned symbols are above their 50-day average, ${pct(mc.breadth.above200, 0)} above their 200-day.`,
          `SPY 20-day realised volatility: ${pct(mc.spy.realizedVol20, 0)} a year.`,
        ],
      },
      {
        title: 'Best opportunities (ranked by rule — see Ideas)',
        lines: buys.slice(0, 3).length
          ? buys.slice(0, 3).map((o) => `${o.symbol} — ${o.classification}: ${o.plan?.label ?? ''}; entry $${o.plan?.entryLow.toFixed(2)}–$${o.plan?.entryHigh.toFixed(2)}, stop $${o.plan?.stop.toFixed(2)}, target $${o.plan?.tp1.toFixed(2)}. ${o.sizing?.fit === 'FITS' ? 'Fits your cash.' : (o.sizing?.message ?? '')}`)
          : ['Nothing meets the rules today. Not trading is the recommendation.'],
      },
      {
        title: 'Your holdings',
        lines: held.length ? held.map((o) => `${o.symbol}: ${o.classification} — ${o.classReasons.join(' ')} ${o.held?.pnl != null ? `P&L ${o.held.pnl >= 0 ? '+' : '−'}$${Math.abs(o.held.pnl).toFixed(2)} (${pct(o.held.pnlPct)}).` : ''}`) : ['No holdings entered. Add them under My Robinhood.'],
      },
      { title: 'Changes since the last scan', lines: changes.length ? changes : ['No classification changes.'] },
      {
        title: 'Forecast model',
        lines: validated
          ? ['At least one forecast horizon is validated; its probabilities are shown with their test record.']
          : ['No forecast horizon passed validation on unseen data, so no probabilities are shown — only historical base rates. The model keeps running in shadow mode and its predictions are scored in AI History.'],
      },
      { title: 'Market headlines (Benzinga via Alpaca)', lines: marketNews.slice(0, 5).map((n) => `${n.headline} — ${n.source}, ${new Date(n.time).toISOString().slice(0, 16).replace('T', ' ')} UTC`) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

let running = false;

/** Days of daily history the scan downloads (≈ 340 trading days: enough for 200-day averages and the analysis window). */
const LOOKBACK_DAYS = 500;

export interface ScanResult {
  runId: number;
  status: 'ok' | 'error' | 'busy';
  error: string | null;
  scanned: number;
  alerts: NewAlert[];
}

export async function runAgentScan(deps: Deps, trigger: 'schedule' | 'manual'): Promise<ScanResult> {
  if (running) return { runId: 0, status: 'busy', error: 'A scan is already running.', scanned: 0, alerts: [] };
  running = true;
  const { db } = deps;
  const startedAt = deps.now();
  const runId = Number(db.prepare("INSERT INTO agent_runs (trigger, status, started_at) VALUES (?, 'running', ?)").run(trigger, startedAt).lastInsertRowid);
  const alerts: NewAlert[] = [];
  try {
    const provider = deps.market.provider;
    const cfg = agentConfig(db);
    const settings = getSettings(db);
    const model = loadModel();
    const hold = holdings(db);
    const cash = robinhoodCash(db) ?? 0;

    const base = [...new Set([...DEFAULT_UNIVERSE, ...cfg.extraSymbols])].filter((s) => !cfg.removedSymbols.includes(s));
    let discovered: string[] = [];
    if (cfg.useScreener) {
      try {
        const sc = await provider.screener();
        discovered = [...new Set([...sc.mostActive, ...sc.gainers, ...sc.losers])].filter((s) => plausibleCommonTicker(s) && !base.includes(s));
      } catch (e) {
        logger.warn('screener unavailable', { error: describeError(e).message });
      }
    }
    const symbols = [...new Set([...base, ...hold.map((h) => h.symbol), ...discovered])];
    const start = new Date(startedAt - LOOKBACK_DAYS * 86_400_000).toISOString();
    const raw = await provider.dailyBarsMulti(symbols, start);
    const series: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const cs = normalizeCandles(applyCorporateActions(s, raw[s] ?? [])).filter((c) => isCandleComplete(c, '1Day', startedAt));
      if (cs.length) series[s] = cs;
    }
    const spy = series.SPY;
    if (!spy || spy.length < 220) throw new Error('SPY history unavailable — cannot assess the market.');
    const market = marketContext(spy);
    const clock = await deps.market.clock();
    const quotes = new Map<string, Quote>();
    for (let k = 0; k < symbols.length; k += 100) {
      try {
        for (const [s, q] of await provider.quotes(symbols.slice(k, k + 100))) quotes.set(s, q);
      } catch (e) {
        logger.warn('quotes unavailable', { error: describeError(e).message });
      }
    }
    const names = getKv<Record<string, string>>(db, 'asset_names') ?? {};
    const missingNames = symbols.filter((s) => !(s in names)).slice(0, 150);
    await Promise.all(missingNames.map(async (s) => {
      const n = await provider.assetName(s);
      if (n) names[s] = n;
    }));
    setKv(db, 'asset_names', names, deps.now());

    const holdValue = hold.reduce((a, h) => a + h.shares * (quotes.get(h.symbol)?.price ?? series[h.symbol]?.at(-1)?.c ?? 0), 0);
    const ctx: EvalContext = { settings, capital: { cash, equity: cash + holdValue }, model, market, spy, now: deps.now(), marketOpen: clock ? clock.isOpen : null, killSwitch: getKillSwitch(db).on };
    const evaluated: Opportunity[] = [];
    for (const s of symbols) {
      const cs = series[s];
      const h = hold.find((x) => x.symbol === s) ?? null;
      if (!cs) continue;
      const t = cs.at(-1)!;
      const avgDollar = cs.slice(-20).reduce((a, c) => a + c.c * c.v, 0) / Math.min(20, cs.length);
      const liquid = t.c >= LIQUIDITY.minPrice && avgDollar >= LIQUIDITY.minAvgDollarVolume && cs.length >= LIQUIDITY.minHistory;
      if (!liquid && !h) continue;
      if (!h && isLeveragedOrInverse(names[s] ?? null)) continue;
      evaluated.push(evaluateSymbol(s, cs, quotes.get(s) ?? null, h, ctx, h ? 'holding' : discovered.includes(s) ? 'screener' : 'universe', names[s] ?? null));
    }
    const ranked = rankOpportunities(evaluated);

    // News for the best candidates and every holding (verbatim headlines; not used by the model).
    const newsSymbols = [...new Set([...ranked.slice(0, 15).map((o) => o.symbol), ...hold.map((h) => h.symbol)])];
    let marketNews: NewsItem[] = [];
    try {
      const items = await provider.news({ symbols: newsSymbols, startIso: new Date(startedAt - 3 * 86_400_000).toISOString(), limit: 50 });
      for (const o of ranked) o.news = items.filter((n) => n.symbols.includes(o.symbol)).slice(0, 5);
      marketNews = await provider.news({ symbols: ['SPY', 'QQQ', 'DIA', 'IWM'], startIso: new Date(startedAt - 3 * 86_400_000).toISOString(), limit: 10 });
    } catch (e) {
      logger.warn('news unavailable', { error: describeError(e).message });
    }

    // Changes vs the previous successful run → alerts.
    const prevRun = db.prepare("SELECT id FROM agent_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    const prev = new Map(prevRun ? (db.prepare('SELECT symbol, classification FROM agent_opportunities WHERE run_id = ?').all(prevRun.id) as { symbol: string; classification: string }[]).map((r) => [r.symbol, r.classification]) : []);
    const changes: string[] = [];
    const today = nyParts(startedAt).dateKey;
    for (const o of ranked) {
      const before = prev.get(o.symbol);
      const isBuy = o.classification === 'STRONG BUY SETUP' || o.classification === 'BUY WATCHLIST';
      if (prevRun && before !== o.classification && (isBuy || o.held || before === 'BUY WATCHLIST' || before === 'STRONG BUY SETUP')) {
        changes.push(`${o.symbol}: ${before ?? 'not scanned'} → ${o.classification}.`);
        const a: NewAlert = {
          dedupKey: `agent:class:${o.symbol}:${o.classification}:${today}`,
          category: 'AGENT',
          mode: o.held ? 'live' : null,
          symbol: o.symbol,
          title: o.held ? `${o.symbol} (you own it): ${o.classification}` : isBuy ? `New opportunity: ${o.symbol} — ${o.classification}` : `${o.symbol} dropped to ${o.classification}`,
          reason: `${o.classReasons.join(' ')} This is research, not an order.`,
          price: o.price,
          priceAt: o.priceTime,
        };
        if (recordAlert(db, a, deps.now())) alerts.push(a);
      }
      if (o.held && o.classification === 'SELL WATCH') {
        const a: NewAlert = { dedupKey: `agent:exit:${o.symbol}:${today}`, category: 'AGENT', mode: 'live', symbol: o.symbol, title: `EXIT CONDITION — ${o.symbol} (you own it)`, reason: `${o.classReasons.join(' ')} Review in My Robinhood. Nothing has been sold.`, price: o.price, priceAt: o.priceTime };
        if (recordAlert(db, a, deps.now())) alerts.push(a);
      }
    }

    const mc = marketConditions(spy, ranked, model);
    const briefing = buildBriefing(mc, ranked, ranked.filter((o) => o.held), changes, robinhoodCash(db), marketNews);
    db.transaction(() => {
      const ins = db.prepare('INSERT INTO agent_opportunities (run_id, symbol, rank, classification, json) VALUES (?, ?, ?, ?, ?)');
      const pred = db.prepare('INSERT OR IGNORE INTO agent_predictions (run_id, symbol, asof_date, horizon, status, p_up, base_rate, shadow_p, shadow_bucket, classification, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const o of ranked) {
        ins.run(runId, o.symbol, o.rank, o.classification, JSON.stringify(o));
        const close = series[o.symbol]!.at(-1)!.c;
        for (const h of HORIZONS) {
          const f = o.forecasts[h]!;
          pred.run(runId, o.symbol, o.dataThrough, h, f.status, f.pUp, f.baseRate, o.shadow[h]?.rawP ?? null, o.shadow[h]?.bucket ?? null, o.classification, close);
        }
      }
      resolvePredictions(db, series);
      db.prepare("UPDATE agent_runs SET status = 'ok', finished_at = ?, data_through = ?, scanned = ?, model_version = ?, market_json = ?, briefing_json = ?, meta_json = ? WHERE id = ?").run(
        deps.now(), mc.asOf, ranked.length, model?.version ?? null, JSON.stringify(mc), JSON.stringify(briefing),
        JSON.stringify({ universe: base.length, discovered: discovered.length, discoveredKept: ranked.filter((o) => o.source === 'screener').map((o) => o.symbol), quotes: quotes.size, newsSymbols: newsSymbols.length, marketNews, earnings: 'Earnings dates are not connected (needs a free Alpha Vantage key). Check them yourself.' }),
        runId,
      );
    })();
    const done: NewAlert = { dedupKey: `agent:briefing:${today}`, category: 'AGENT', mode: null, symbol: null, title: 'Daily briefing ready', reason: briefing.headline, price: null, priceAt: null };
    if (recordAlert(db, done, deps.now())) alerts.push(done);
    return { runId, status: 'ok', error: null, scanned: ranked.length, alerts };
  } catch (e) {
    const msg = describeError(e).message;
    db.prepare("UPDATE agent_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(deps.now(), msg, runId);
    return { runId, status: 'error', error: msg, scanned: 0, alerts };
  } finally {
    running = false;
  }
}

/** Scores past predictions once their horizon has passed, using the same completed daily candles. */
export function resolvePredictions(db: Db, series: Record<string, Candle[]>): number {
  const open = db.prepare('SELECT id, symbol, asof_date, horizon, price FROM agent_predictions WHERE resolved = 0').all() as { id: number; symbol: string; asof_date: string; horizon: number; price: number }[];
  const upd = db.prepare('UPDATE agent_predictions SET resolved = 1, outcome_date = ?, actual_return = ? WHERE id = ?');
  let n = 0;
  for (const p of open) {
    const cs = series[p.symbol];
    if (!cs) continue;
    const i = cs.findIndex((c) => dateKey(c.t) === p.asof_date);
    if (i < 0 || i + p.horizon >= cs.length) continue;
    const later = cs[i + p.horizon]!;
    upd.run(dateKey(later.t), later.c / cs[i]!.c - 1, p.id);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Schedule and status
// ---------------------------------------------------------------------------

/** Converts a New York wall-clock time on a given New York date to a UTC timestamp. */
export function nyTime(dateKeyNY: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.parse(`${dateKeyNY}T${hhmm}:00Z`);
  for (const off of [4, 5]) {
    const t = guess + off * 3_600_000;
    const p = nyParts(t);
    if (p.dateKey === dateKeyNY && p.minutes === h! * 60 + m!) return t;
  }
  return guess + 5 * 3_600_000;
}

export function nextScheduledScan(cfg: AgentConfig, now: number): number | null {
  if (!cfg.enabled || !cfg.scheduleET.length) return null;
  for (let d = 0; d < 8; d++) {
    const day = nyParts(now + d * 86_400_000);
    if (day.weekday === 'Sat' || day.weekday === 'Sun') continue;
    const times = cfg.scheduleET.map((x) => nyTime(day.dateKey, x)).filter((t) => t > now).sort((a, b) => a - b);
    if (times.length) return times[0]!;
  }
  return null;
}

/** The most recent scheduled time that has passed (today or earlier), or null. */
export function lastScheduledSlot(cfg: AgentConfig, now: number): number | null {
  if (!cfg.enabled) return null;
  for (let d = 0; d < 8; d++) {
    const day = nyParts(now - d * 86_400_000);
    if (day.weekday === 'Sat' || day.weekday === 'Sun') continue;
    const past = cfg.scheduleET.map((x) => nyTime(day.dateKey, x)).filter((t) => t <= now).sort((a, b) => b - a);
    if (past.length) return past[0]!;
  }
  return null;
}

/** Called by the monitor every cycle: runs a scan if a scheduled slot passed since the last scan started. */
export async function runAgentIfDue(deps: Deps): Promise<ScanResult | null> {
  const cfg = agentConfig(deps.db);
  const slot = lastScheduledSlot(cfg, deps.now());
  if (slot === null) return null;
  const last = deps.db.prepare('SELECT started_at FROM agent_runs ORDER BY id DESC LIMIT 1').get() as { started_at: number } | undefined;
  if (last && last.started_at >= slot) return null;
  return runAgentScan(deps, 'schedule');
}

/** Intraday: alerts when a holding trades below the exit level from the latest scan. Alerts only — never sells. */
export async function monitorHoldings(deps: Deps): Promise<NewAlert[]> {
  const { db } = deps;
  const hold = holdings(db);
  if (!hold.length) return [];
  const run = db.prepare("SELECT id FROM agent_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (!run) return [];
  const quotes = await deps.market.quotes(hold.map((h) => h.symbol));
  const out: NewAlert[] = [];
  const today = nyParts(deps.now()).dateKey;
  for (const h of hold) {
    const row = db.prepare('SELECT json FROM agent_opportunities WHERE run_id = ? AND symbol = ?').get(run.id, h.symbol) as { json: string } | undefined;
    const q = quotes.get(h.symbol);
    if (!row || !q) continue;
    const o = JSON.parse(row.json) as Opportunity;
    const level = o.technicals.low20;
    if (level !== null && q.price < level) {
      const a: NewAlert = { dedupKey: `agent:hold-below:${h.symbol}:${today}`, category: 'AGENT', mode: 'live', symbol: h.symbol, title: `${h.symbol} is trading below its 20-day low (you own it)`, reason: `Price $${q.price.toFixed(2)} < 20-day low $${level.toFixed(2)}. If it closes there, the agent will mark it SELL WATCH. This is an alert, not an order.`, price: q.price, priceAt: q.time };
      if (recordAlert(db, a, deps.now())) out.push(a);
    }
  }
  return out;
}

export function agentStatus(db: Db, now: number) {
  const cfg = agentConfig(db);
  const last = db.prepare('SELECT id, trigger, status, started_at, finished_at, error, data_through, scanned FROM agent_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  const lastOk = db.prepare("SELECT id, finished_at, data_through FROM agent_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as { id: number; finished_at: number; data_through: string } | undefined;
  return { config: cfg, running, lastRun: last ?? null, lastSuccessfulRun: lastOk ?? null, nextScheduledAt: nextScheduledScan(cfg, now) };
}

export function latestRun(db: Db) {
  const run = db.prepare("SELECT * FROM agent_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  if (!run) return null;
  const opps = (db.prepare('SELECT json FROM agent_opportunities WHERE run_id = ? ORDER BY rank').all(run.id) as { json: string }[]).map((r) => JSON.parse(r.json) as Opportunity);
  return { run: { id: Number(run.id), trigger: String(run.trigger), startedAt: Number(run.started_at), finishedAt: Number(run.finished_at), dataThrough: String(run.data_through), scanned: Number(run.scanned), modelVersion: (run.model_version as string | null) ?? null }, market: JSON.parse(String(run.market_json)) as MarketConditions, briefing: JSON.parse(String(run.briefing_json)) as Briefing, meta: JSON.parse(String(run.meta_json ?? '{}')), opportunities: opps };
}
