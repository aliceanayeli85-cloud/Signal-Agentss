import { describe, expect, it } from 'vitest';
import { classify, sizeFor, type AgentPlan } from '../src/agent/classify.js';
import type { Forecast } from '../src/agent/model.js';
import type { Signal, Technicals } from '../src/agent/signals.js';
import { analyze } from '../src/engine/analysis.js';
import { DEFAULT_SETTINGS } from '../src/engine/settings.js';
import { openDb, setKv } from '../src/server/db.js';
import { lastScheduledSlot, nextScheduledScan, nyTime, runAgentIfDue, runAgentScan, DEFAULT_AGENT_CONFIG, latestRun } from '../src/server/services/agent.js';
import { aiHistory, createTicket, decideTicket } from '../src/server/services/agent-actions.js';
import { MarketService } from '../src/server/services/market.js';
import { FakeProvider, NOW, pullbackSeries } from './fake-provider.js';
import { seriesFromCloses, trendingCloses } from './helpers.js';

const S = { ...DEFAULT_SETTINGS };
const noModel = (h: 1 | 5 | 20 = 20): Forecast => ({ horizon: h, status: 'INSUFFICIENT EVIDENCE', reason: 'not validated', pUp: null, pDown: null, pUpCi: null, expectedReturn: null, downside: null, upside: null, targetFirst: null, baseRate: 0.55, bucketSamples: 0, testCheck: null });
const validated = (pUp: number): Forecast => ({ ...noModel(), status: 'OK', reason: null, pUp, pDown: 1 - pUp, pUpCi: [pUp - 0.02, pUp + 0.02], expectedReturn: 0.03, downside: -0.05, upside: 0.08, targetFirst: 0.4, bucketSamples: 5000 });
const plan: AgentPlan = { source: 'breakout', label: '20-day breakout', entryLow: 100, entryHigh: 100.5, stop: 96, tp1: 109.5, tp2: 114, rewardRisk: 2, invalidation: 'x', confirmation: [] };
const up = analyze(seriesFromCloses(trendingCloses(260, 40, 0.25)), '1Day');
const down = analyze(seriesFromCloses(trendingCloses(260, 120, -0.25)), '1Day');
const t = (o: Partial<Technicals> = {}): Technicals => ({ close: 100, date: 0, sma20: 99, sma50: 95, sma200: 90, ema20: 99, rsi14: 60, macdHist: 0.1, bbUpper: 104, bbLower: 94, bbPctB: 0.6, bbWidthPercentile: 0.5, atr14: 2, atrPct: 0.02, relVolume: 1, avgDollarVolume: 1e8, ret20: 0.04, relStrength20: 0.01, high20: 99, low20: 92, low10: 95, dailyVwap: null, ...o });
const sig = (id: string, direction: Signal['direction'] = 'bullish'): Signal => ({ id, label: id, direction, detail: id });

describe('measurable recommendation rules', () => {
  const fits = sizeFor(plan, { cash: 50, equity: 100 }, S, null);
  it('BUY WATCHLIST, not STRONG BUY, when the forecast is not validated', () => {
    const r = classify({ held: false, t: t(), an: up, signals: [], plan, sizing: fits, f20: noModel(), dataOk: true });
    expect(r.classification).toBe('BUY WATCHLIST');
    expect(r.reasons.join(' ')).toMatch(/no forecast horizon has passed validation/);
  });
  it('STRONG BUY SETUP only with a validated, above-base forecast and a plan that fits', () => {
    expect(classify({ held: false, t: t(), an: up, signals: [], plan, sizing: fits, f20: validated(0.65), dataOk: true }).classification).toBe('STRONG BUY SETUP');
    expect(classify({ held: false, t: t(), an: up, signals: [], plan, sizing: fits, f20: validated(0.57), dataOk: true }).classification).toBe('BUY WATCHLIST');
  });
  it('AVOID on a downtrend below the 200-day, a breakdown, or a failed breakout', () => {
    expect(classify({ held: false, t: t({ close: 80, sma200: 90 }), an: down, signals: [], plan, sizing: fits, f20: noModel(), dataOk: true }).classification).toBe('AVOID');
    expect(classify({ held: false, t: t(), an: up, signals: [sig('breakdown_20d', 'bearish')], plan, sizing: fits, f20: noModel(), dataOk: true }).classification).toBe('AVOID');
    expect(classify({ held: false, t: t(), an: up, signals: [sig('failed_breakout', 'bearish')], plan, sizing: fits, f20: noModel(), dataOk: true }).classification).toBe('AVOID');
  });
  it('NO TRADE without a plan, with too little data, or with RSI above 75', () => {
    expect(classify({ held: false, t: t(), an: up, signals: [], plan: null, sizing: null, f20: noModel(), dataOk: true }).classification).toBe('NO TRADE');
    expect(classify({ held: false, t: t(), an: up, signals: [], plan, sizing: fits, f20: noModel(), dataOk: false }).classification).toBe('NO TRADE');
    expect(classify({ held: false, t: t({ rsi14: 80 }), an: up, signals: [], plan, sizing: fits, f20: noModel(), dataOk: true }).classification).toBe('NO TRADE');
  });
  it('holdings: HOLD unless an exit condition is met, then SELL WATCH', () => {
    expect(classify({ held: true, t: t(), an: up, signals: [], plan: null, sizing: null, f20: noModel(), dataOk: true }).classification).toBe('HOLD');
    expect(classify({ held: true, t: t(), an: up, signals: [sig('breakdown_20d', 'bearish')], plan: null, sizing: null, f20: noModel(), dataOk: true }).classification).toBe('SELL WATCH');
    expect(classify({ held: true, t: t({ close: 90, sma50: 95 }), an: down, signals: [], plan: null, sizing: null, f20: noModel(), dataOk: true }).classification).toBe('SELL WATCH');
  });
});

describe('small-account sizing (your account: about $5.28 in TSLA, $0 cash)', () => {
  it('with no cash it says keep your money', () => {
    const s = sizeFor(plan, { cash: 0, equity: 5.28 }, S, null);
    expect(s.fit).toBe('NO CASH');
    expect(s.message).toMatch(/Keep your money/);
    expect(s.capitalNeededForFullSize).toBeGreaterThan(20);
  });
  it('risk budget is 2% of equity (about 11 cents), and costs that eat the reward are refused', () => {
    const s = sizeFor(plan, { cash: 5, equity: 5.28 }, S, null);
    expect(s.riskBudget).toBeCloseTo(0.1056, 4);
    expect(['COSTS TOO HIGH', 'RISK BUDGET TOO SMALL']).toContain(s.fit);
  });
  it('with enough capital it fits and keeps the loss within budget', () => {
    const s = sizeFor(plan, { cash: 50, equity: 100 }, S, 0.0005);
    expect(s.fit).toBe('FITS');
    expect(s.maxLoss).toBeLessThanOrEqual(1.02);
    expect(s.notional).toBeLessThanOrEqual(50.0000001);
  });
});

describe('schedule (New York time, weekdays only)', () => {
  it('converts New York times across daylight saving', () => {
    expect(new Date(nyTime('2026-07-15', '16:30')).toISOString()).toBe('2026-07-15T20:30:00.000Z');
    expect(new Date(nyTime('2026-01-15', '16:30')).toISOString()).toBe('2026-01-15T21:30:00.000Z');
  });
  it('finds the next and the last slots and skips weekends', () => {
    const fri5pm = nyTime('2026-10-30', '17:00');
    expect(new Date(nextScheduledScan(DEFAULT_AGENT_CONFIG, fri5pm)!).toISOString()).toBe(new Date(nyTime('2026-11-02', '08:45')).toISOString());
    expect(lastScheduledSlot(DEFAULT_AGENT_CONFIG, fri5pm)).toBe(nyTime('2026-10-30', '16:30'));
    expect(nextScheduledScan({ ...DEFAULT_AGENT_CONFIG, enabled: false }, fri5pm)).toBeNull();
  });
});

describe('agent scan end to end (test data)', () => {
  function setup() {
    const db = openDb(':memory:');
    const fake = new FakeProvider();
    fake.bars_['1Day'] = pullbackSeries();
    for (const s of ['SPY', 'TSLA', 'KO']) fake.quotes_.set(s, { price: 67.8, time: NOW - 1000, source: 'fake', bid: 67.79, ask: 67.81 });
    fake.news_ = [{ id: '1', headline: 'Real headline from the feed', summary: null, source: 'benzinga', url: null, symbols: ['TSLA'], time: NOW - 3600_000 }];
    const clock = { now: NOW };
    const deps = { db, market: new MarketService(fake, db, () => clock.now), now: () => clock.now };
    db.prepare("INSERT INTO holdings (symbol, shares, cost_basis, updated_at) VALUES ('TSLA', 0.013363, 5, 0)").run();
    setKv(db, 'agent_config', { ...DEFAULT_AGENT_CONFIG, useScreener: false });
    return { db, fake, deps, clock };
  }

  it('scans, ranks, classifies, writes a briefing and logs predictions — without inventing probabilities', async () => {
    const { db, deps } = setup();
    const r = await runAgentScan(deps, 'manual');
    expect(r.error).toBeNull();
    expect(r.status).toBe('ok');
    const latest = latestRun(db)!;
    expect(latest.opportunities.length).toBeGreaterThan(50);
    const tsla = latest.opportunities.find((o) => o.symbol === 'TSLA')!;
    expect(tsla.held?.shares).toBe(0.013363);
    expect(['HOLD', 'SELL WATCH']).toContain(tsla.classification);
    expect(tsla.news[0]!.headline).toBe('Real headline from the feed');
    for (const o of latest.opportunities) {
      expect(o.classification).not.toBe('STRONG BUY SETUP'); // no validated horizon in the shipped model
      for (const h of [1, 5, 20]) {
        expect(o.forecasts[h]!.status).not.toBe('OK');
        expect(o.forecasts[h]!.pUp).toBeNull();
      }
    }
    expect(latest.briefing.headline).toMatch(/keep your money/); // $0 cash recorded
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_predictions').get() as { n: number }).n).toBe(latest.opportunities.length * 3);
    expect(latest.market.breadth.scanned).toBe(latest.opportunities.length);
  });

  it('scores predictions only after their horizon has passed', async () => {
    const { db, deps, fake, clock } = setup();
    await runAgentScan(deps, 'manual');
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_predictions WHERE resolved = 1').get() as { n: number }).n).toBe(0);
    const base = pullbackSeries();
    const extra = Array.from({ length: 6 }, (_, k) => ({ ...base.at(-1)!, t: base.at(-1)!.t + (k + 1) * 86_400_000, c: base.at(-1)!.c * (1 + 0.01 * (k + 1)) }));
    fake.bars_['1Day'] = [...base, ...extra];
    clock.now = NOW + 8 * 86_400_000;
    await runAgentScan(deps, 'manual');
    const resolved = db.prepare('SELECT horizon, actual_return FROM agent_predictions WHERE resolved = 1').all() as { horizon: number; actual_return: number }[];
    expect(resolved.some((p) => p.horizon === 1)).toBe(true);
    expect(resolved.some((p) => p.horizon === 5)).toBe(true);
    expect(resolved.some((p) => p.horizon === 20)).toBe(false);
    expect(aiHistory(db).live.find((l) => l.horizon === 5)!.resolved).toBeGreaterThan(0);
  });

  it('runs on schedule once per slot', async () => {
    const { deps } = setup();
    expect((await runAgentIfDue(deps))?.status).toBe('ok');
    expect(await runAgentIfDue(deps)).toBeNull();
  });

  it('tickets: real-money plans need typed approval, are never sent, and respect the kill switch', async () => {
    const { db, deps } = setup();
    await runAgentScan(deps, 'manual');
    const sell = await createTicket(deps, 'TSLA', 'sell');
    expect(sell.ticket.side).toBe('SELL');
    expect(sell.ticket.agentPrompt).toMatch(/Do not place anything until I reply with the single word CONFIRM/);
    expect(() => decideTicket(db, sell.id, 'approve', 'yes', NOW)).toThrow(/Type APPROVE/);
    const ok = decideTicket(db, sell.id, 'approve', 'APPROVE', NOW);
    expect(ok.status).toBe('approved');
    expect(ok.message).toMatch(/place it yourself/);
    await expect(createTicket(deps, 'KO', 'sell')).rejects.toThrow(/no recorded KO holding/);
    // With $0 cash no buy ticket can be prepared.
    const buyable = latestRun(db)!.opportunities.find((o) => o.classification === 'BUY WATCHLIST');
    if (buyable) await expect(createTicket(deps, buyable.symbol, 'buy')).rejects.toThrow(/Keep your money|available/);
    setKv(db, 'kill_switch', { on: true, at: NOW, reason: 'test' });
    if (buyable) await expect(createTicket(deps, buyable.symbol, 'buy')).rejects.toThrow(/kill switch/i);
  });
});

import { isLeveragedOrInverse } from '../src/agent/universe.js';
import { technicalChecksPass } from '../src/agent/classify.js';
describe('scanner hygiene', () => {
  it('excludes leveraged and inverse funds by name', () => {
    expect(isLeveragedOrInverse('ProShares UltraPro QQQ')).toBe(true);
    expect(isLeveragedOrInverse('Direxion Daily Semiconductor Bull 3X Shares')).toBe(true);
    expect(isLeveragedOrInverse('ProShares Short S&P500')).toBe(true);
    expect(isLeveragedOrInverse('SPDR S&P 500 ETF Trust')).toBe(false);
    expect(isLeveragedOrInverse('Tesla, Inc. Common Stock')).toBe(false);
  });
  it('a pattern plan is only used when its technical checks pass (account-specific checks are judged by sizing)', () => {
    const checks = (names: [string, boolean][]) => ({ checks: names.map(([name, pass]) => ({ name, pass, detail: '' })) }) as never;
    expect(technicalChecksPass(checks([['Position size possible', false], ['Account risk rules', false], ['RSI not overheated', true]]))).toBe(true);
    expect(technicalChecksPass(checks([['Not over-extended', false]]))).toBe(false);
  });
});
