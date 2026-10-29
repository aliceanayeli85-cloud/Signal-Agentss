import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { openDb, type Db } from '../src/server/db.js';
import { assertSafeConfig, env } from '../src/server/env.js';
import { AlpacaProvider, DataError } from '../src/server/providers/alpaca.js';
import { MarketService } from '../src/server/services/market.js';
import { acquireLease, monitorStatus, runMonitorCycle } from '../src/server/services/monitor.js';
import { FakeProvider, NOW, pullbackSeries } from './fake-provider.js';

interface Ctx {
  url: string;
  db: Db;
  fake: FakeProvider;
  clock: { now: number };
  close: () => Promise<void>;
  api: (path: string, init?: { method?: string; body?: unknown; token?: string }) => Promise<{ status: number; body: any }>;
}

async function start(token: string | null = null): Promise<Ctx> {
  const db = openDb(':memory:');
  const fake = new FakeProvider();
  const clock = { now: NOW };
  fake.bars_['1Day'] = pullbackSeries();
  // Inside the entry zone (trigger ≈ 67.75, zone top ≈ 67.82).
  fake.quotes_.set('SPY', { price: 67.78, time: NOW - 2000, source: 'fake' });
  const deps = { db, market: new MarketService(fake, db, () => clock.now), now: () => clock.now };
  const app = createApp(deps, { accessToken: token, notify: null, monitorOwner: 'test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: Ctx['api'] = async (path, init = {}) => {
    const res = await fetch(url + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(init.token ? { 'x-access-token': init.token } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { url, db, fake, clock, api, close: () => new Promise((r) => server.close(() => r())) };
}

let ctx: Ctx;
beforeEach(async () => {
  ctx = await start();
});
afterEach(async () => {
  await ctx.close();
  ctx.db.close();
});

const runMonitor = () => runMonitorCycle({ db: ctx.db, market: new MarketService(ctx.fake, ctx.db, () => ctx.clock.now), now: () => ctx.clock.now }, 'test');

async function openPaperTrade(key = 'key-00000001') {
  const pv = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: key } });
  expect(pv.status).toBe(200);
  const ap = await ctx.api(`/api/orders/${pv.body.id}/approve`, { body: { confirm: true } });
  expect(ap.status).toBe(200);
  return { preview: pv.body, approval: ap.body };
}

describe('analysis endpoint', () => {
  it('returns a full report with a trade plan, data source and forming-candle notes', async () => {
    const r = await ctx.api('/api/analysis/SPY?tf=1Day');
    expect(r.status).toBe(200);
    expect(r.body.plan.status).toBe('TRADE_PLAN');
    expect(r.body.plan.dataSource).toBe('fake');
    expect(r.body.plan.priceTime).toBe(NOW - 2000);
    expect(r.body.analysis.setups[0].type).toBe('PULLBACK_EMA');
    // Other timeframes are missing in the fake: reported per timeframe, not hidden.
    expect(r.body.multiTimeframe.find((m: any) => m.timeframe === '1Hour').error).toMatch(/no 1Hour bars/);
  });
  it('rejects invalid tickers and reports a missing quote instead of inventing one', async () => {
    expect((await ctx.api('/api/analysis/sp%20y')).status).toBe(400);
    ctx.fake.quotes_.clear();
    const r = await ctx.api('/api/analysis/SPY?tf=1Day');
    expect(r.body.quote).toBeNull();
    expect(r.body.quoteError).toMatch(/No current price/);
    expect(r.body.plan.status).toBe('NO_TRADE');
    expect(r.body.plan.plannedEntry).toBeNull();
  });
  it('a data-source failure yields NO plan and an explanation', async () => {
    ctx.fake.failWith = new DataError('AUTH', 'bad keys');
    const r = await ctx.api('/api/analysis/SPY?tf=1Day');
    expect(r.body.plan).toBeNull();
    expect(r.body.analysisError).toMatch(/bad keys/);
  });
});

describe('paper order flow', () => {
  it('preview → approve → simulated fill, position, fill record and journal draft', async () => {
    const { preview, approval } = await openPaperTrade();
    expect(preview.status).toBe('preview');
    expect(preview.plannedRisk).toBeLessThanOrEqual(1.0000001);
    expect(preview.potentialLoss).toMatch(/gaps below/);
    expect(preview.protectiveOrders.length).toBeGreaterThan(0);
    expect(approval.message).toMatch(/PAPER/);
    const pos = await ctx.api('/api/positions?mode=paper');
    expect(pos.body.positions).toHaveLength(1);
    expect(pos.body.positions[0].fills).toHaveLength(1);
    expect((await ctx.api('/api/journal?mode=paper')).body.entries).toHaveLength(1);
    expect((await ctx.api('/api/positions?mode=live')).body.positions).toHaveLength(0);
  });
  it('approval requires explicit confirmation', async () => {
    const pv = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-confirm1' } });
    expect((await ctx.api(`/api/orders/${pv.body.id}/approve`, { body: {} })).status).toBe(400);
  });
  it('duplicate protection: same idempotency key, double approval, second order on same symbol', async () => {
    const a = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'same-key-123' } });
    const b = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'same-key-123' } });
    expect(b.body.id).toBe(a.body.id);
    const [r1, r2] = await Promise.all([ctx.api(`/api/orders/${a.body.id}/approve`, { body: { confirm: true } }), ctx.api(`/api/orders/${a.body.id}/approve`, { body: { confirm: true } })]);
    expect([r1.body.alreadyProcessed, r2.body.alreadyProcessed].sort()).toEqual([false, true]);
    expect((await ctx.api('/api/positions?mode=paper')).body.positions).toHaveLength(1);
    const again = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'other-key-1' } });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already an open position/);
  });
  it('expired previews cannot be approved', async () => {
    const pv = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-expire1' } });
    ctx.clock.now += 6 * 60_000;
    ctx.fake.quotes_.set('SPY', { price: 67.78, time: ctx.clock.now - 1000, source: 'fake' });
    expect((await ctx.api(`/api/orders/${pv.body.id}/approve`, { body: { confirm: true } })).status).toBe(410);
  });
  it('re-sizes at the actual fill so a worse price never raises the loss above $1 (audit fix)', async () => {
    const pv = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-resize1' } });
    // Still inside the allowed zone, but above the price the preview was sized at.
    ctx.fake.quotes_.set('SPY', { price: 67.95, time: NOW - 1000, source: 'fake' });
    expect((await ctx.api(`/api/orders/${pv.body.id}/approve`, { body: { confirm: true } })).status).toBe(200);
    const p = (await ctx.api('/api/positions?mode=paper')).body.positions[0];
    expect(p.qty_initial).toBeLessThan(pv.body.qty);
    expect(p.planned_loss).toBeLessThanOrEqual(1.0000001);
    expect(p.qty_initial * (p.entry_price - p.stop)).toBeLessThanOrEqual(1);
  });
  it('refuses to fill if price ran away between preview and approval (no chasing)', async () => {
    const pv = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-chase01' } });
    ctx.fake.quotes_.set('SPY', { price: 69, time: NOW - 1000, source: 'fake' });
    const r = await ctx.api(`/api/orders/${pv.body.id}/approve`, { body: { confirm: true } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PRICE_MOVED');
  });
  it('market orders are refused while the market is closed; limit orders wait and the monitor fills them', async () => {
    ctx.fake.clock_ = { isOpen: false, timestamp: NOW, nextOpen: null, nextClose: NOW + 3_600_000 };
    const m = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-closed1' } });
    expect((await ctx.api(`/api/orders/${m.body.id}/approve`, { body: { confirm: true } })).body.error).toBe('MARKET_CLOSED');

    ctx.fake.clock_ = { isOpen: true, timestamp: NOW, nextOpen: null, nextClose: NOW + 3_600_000 };
    const l = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'limit', idempotencyKey: 'key-limit01' } });
    const ap = await ctx.api(`/api/orders/${l.body.id}/approve`, { body: { confirm: true } });
    expect(ap.body.order.status).toBe('working');
    ctx.fake.quotes_.set('SPY', { price: 67.9, time: NOW - 1000, source: 'fake' }); // above the limit
    await runMonitor();
    expect((await ctx.api('/api/positions?mode=paper')).body.positions).toHaveLength(0);
    ctx.fake.quotes_.set('SPY', { price: 67.76, time: NOW - 1000, source: 'fake' });
    await runMonitor();
    expect((await ctx.api('/api/positions?mode=paper')).body.positions).toHaveLength(1);
  });
  it('a waiting setup cannot be ordered before confirmation', async () => {
    ctx.fake.quotes_.set('SPY', { price: 67.5, time: NOW - 1000, source: 'fake' });
    const r = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-wait001' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('NOT_CONFIRMED');
  });
});

describe('monitor', () => {
  it('a stop hit closes the paper position once, records a loss and blocks revenge trading', async () => {
    await openPaperTrade();
    ctx.fake.quotes_.set('SPY', { price: 66.2, time: NOW - 1000, source: 'fake' }); // below the stop
    const r1 = await runMonitor();
    expect(r1.alerts.map((a) => a.title)).toContain('PAPER STOP — SPY');
    const r2 = await runMonitor();
    expect(r2.alerts.filter((a) => a.category === 'SIMULATED_ORDER')).toHaveLength(0);
    const pnl = await ctx.api('/api/pnl?mode=paper');
    expect(pnl.body.summary.realizedPnl).toBeLessThan(0);
    expect(pnl.body.sampleWarning).toMatch(/far too few/);
    expect((await ctx.api('/api/pnl?mode=live')).body.summary.realizedPnl).toBe(0);
    ctx.fake.quotes_.set('SPY', { price: 67.78, time: NOW - 1000, source: 'fake' });
    const again = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-revenge' } });
    expect(again.status).not.toBe(200);
  });
  it('never simulates fills on stale prices or while the market is closed', async () => {
    await openPaperTrade();
    ctx.fake.quotes_.set('SPY', { price: 60, time: NOW - 30 * 60_000, source: 'fake' });
    const r = await runMonitor();
    expect(r.alerts.map((a) => a.category)).toEqual(['SYSTEM']);
    expect(r.alerts[0]!.title).toMatch(/stale/);
    ctx.fake.clock_ = { ...ctx.fake.clock_, isOpen: false };
    ctx.fake.quotes_.set('SPY', { price: 60, time: NOW - 1000, source: 'fake' });
    await runMonitor();
    expect((await ctx.api('/api/positions?mode=paper')).body.positions[0].status).toBe('open');
  });
  it('take-profit 1 sells half and moves the stop to breakeven', async () => {
    const { preview } = await openPaperTrade();
    ctx.fake.quotes_.set('SPY', { price: preview.tp1 + 0.01, time: NOW - 1000, source: 'fake' });
    await runMonitor();
    const p = (await ctx.api('/api/positions?mode=paper')).body.positions[0];
    expect(p.tp1_done).toBe(1);
    expect(p.qty_open).toBeCloseTo(preview.qty / 2, 5);
    expect(p.stop).toBeCloseTo(p.entry_price, 8);
  });
  it('data failures are recorded and shown as monitor errors', async () => {
    await openPaperTrade();
    ctx.fake.failWith = new DataError('RATE_LIMIT', 'slow down');
    const r = await runMonitor();
    expect(r.error).toMatch(/slow down/);
    expect(monitorStatus(ctx.db, ctx.clock.now).state).toBe('error');
    expect(r.alerts[0]!.category).toBe('SYSTEM');
  });
  it('reports a stopped monitor as stale, and only one monitor may hold the lease', async () => {
    expect(monitorStatus(ctx.db, NOW).state).toBe('never_ran');
    await runMonitor();
    expect(monitorStatus(ctx.db, NOW).state).toBe('ok');
    expect(monitorStatus(ctx.db, NOW + 60 * 60_000).state).toBe('stale');
    expect(acquireLease(ctx.db, 'other', NOW)).toBe(false);
    expect(acquireLease(ctx.db, 'other', NOW + 6 * 60_000)).toBe(true);
  });
  it('price alerts fire once and are labelled as alerts, not orders', async () => {
    await ctx.api('/api/alerts/rules', { body: { symbol: 'SPY', kind: 'price_above', price: 67 } });
    const dup = await ctx.api('/api/alerts/rules', { body: { symbol: 'SPY', kind: 'price_above', price: 67 } });
    expect(dup.body.duplicate).toBe(true);
    const r1 = await runMonitor();
    expect(r1.alerts).toHaveLength(1);
    expect(r1.alerts[0]!.reason).toMatch(/not an order/);
    expect((await runMonitor()).alerts).toHaveLength(0);
  });
});

describe('risk controls', () => {
  it('kill switch blocks new orders, cancels working ones, and needs RESUME to turn off', async () => {
    await ctx.api('/api/kill-switch', { body: { on: true } });
    const r = await ctx.api('/api/orders/preview', { body: { symbol: 'SPY', timeframe: '1Day', orderType: 'market', idempotencyKey: 'key-kill001' } });
    expect(r.status).toBe(423);
    expect((await ctx.api('/api/kill-switch', { body: { on: false } })).status).toBe(400);
    expect((await ctx.api('/api/kill-switch', { body: { on: false, confirm: 'RESUME' } })).body.killSwitch.on).toBe(false);
  });
  it('refuses to raise risk after a loss and enforces hard caps', async () => {
    await openPaperTrade();
    ctx.fake.quotes_.set('SPY', { price: 66.2, time: NOW - 1000, source: 'fake' });
    await runMonitor();
    const r = await ctx.api('/api/settings', { method: 'PUT', body: { maxTradesPerDay: 5 } });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/after a loss/);
    expect((await ctx.api('/api/settings', { method: 'PUT', body: { riskPerTradeUsd: 0.5 } })).status).toBe(200);
  });
  it('validates settings input', async () => {
    expect((await ctx.api('/api/settings', { method: 'PUT', body: { riskPerTradeUsd: -1 } })).status).toBe(400);
  });
});

describe('real-money records and Robinhood ticket', () => {
  it('requires real capital before a ticket, then produces a reviewable ticket that waits for CONFIRM', async () => {
    const no = await ctx.api('/api/robinhood/ticket', { body: { symbol: 'SPY', timeframe: '1Day' } });
    expect(no.body.error).toBe('LIVE_CAPITAL_UNKNOWN');
    await ctx.api('/api/live/capital', { body: { amount: 100 } });
    const t = await ctx.api('/api/robinhood/ticket', { body: { symbol: 'SPY', timeframe: '1Day' } });
    expect(t.status).toBe(200);
    expect(t.body.ticket.side).toBe('BUY');
    expect(t.body.ticket.plannedRisk).toBeLessThanOrEqual(1.0000001);
    expect(t.body.agentPrompt).toMatch(/Do NOT place anything until I reply with the single word CONFIRM/);
    expect(t.body.notice).toMatch(/Nothing has been sent/);
    const facts = await ctx.api('/api/robinhood');
    expect(facts.body.liveExecutionInThisApp).toBe(false);
  });
  it('records real trades separately from paper and only alerts on them', async () => {
    await ctx.api('/api/live/capital', { body: { amount: 100 } });
    const e = await ctx.api('/api/live/positions', { body: { symbol: 'SPY', qty: 0.5, price: 67.8, stop: 66.5, tp1: 70, tp2: 72, timeframe: '1Day' } });
    expect(e.status).toBe(200);
    ctx.fake.quotes_.set('SPY', { price: 66, time: NOW - 1000, source: 'fake' });
    const r = await runMonitor();
    expect(r.alerts.find((a) => a.title.startsWith('STOP LEVEL REACHED'))?.category).toBe('PRICE_ALERT');
    expect((await ctx.api('/api/positions?mode=live')).body.positions[0].status).toBe('open'); // never auto-sold
    await ctx.api(`/api/live/positions/${e.body.position.id}/exit`, { body: { qty: 0.5, price: 66.4, fees: 0.01 } });
    const live = await ctx.api('/api/pnl?mode=live');
    expect(live.body.summary.realizedPnl).toBeCloseTo(0.5 * (66.4 - 67.8) - 0.01, 8);
    expect((await ctx.api('/api/pnl?mode=paper')).body.summary.realizedPnl).toBe(0);
  });
});

describe('backtest endpoint and access control', () => {
  it('runs a backtest on the provider history and stores it', async () => {
    const r = await ctx.api('/api/backtest', { body: { symbol: 'SPY', timeframe: '1Day' } });
    expect(r.status).toBe(200);
    expect(r.body.assumptions.length).toBeGreaterThan(3);
    expect((await ctx.api('/api/backtest')).body.runs).toHaveLength(1);
  });
  it('requires the access token when one is configured', async () => {
    const guarded = await start('secret-token-1234');
    expect((await guarded.api('/api/health')).status).toBe(401);
    expect((await guarded.api('/api/health', { token: 'secret-token-1234' })).status).toBe(200);
    await guarded.close();
  });
  it('refuses unsafe startup configurations', () => {
    expect(() => assertSafeConfig({ ...env, enableLiveTrading: true })).toThrow(/no live order code/);
    expect(() => assertSafeConfig({ ...env, host: '0.0.0.0', accessToken: null })).toThrow(/ACCESS_TOKEN/);
    expect(() => assertSafeConfig({ ...env, host: '0.0.0.0', accessToken: 'x'.repeat(24) })).not.toThrow();
  });
});

describe('Alpaca provider parsing and failures', () => {
  const cfg = { keyId: 'k', secret: 's', dataUrl: 'https://data.test', clockUrl: 'https://clock.test', feed: 'iex', timeoutMs: 1000 };
  const respond = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('parses snapshots, skipping symbols without a valid last trade', async () => {
    const p = new AlpacaProvider({ ...cfg, fetchImpl: respond(200, { SPY: { latestTrade: { p: 500.5, t: '2026-03-10T15:00:00Z' } }, BAD: null }) as typeof fetch });
    const q = await p.quotes(['SPY', 'BAD']);
    expect(q.get('SPY')?.price).toBe(500.5);
    expect(q.get('SPY')?.time).toBe(Date.parse('2026-03-10T15:00:00Z'));
    expect(q.has('BAD')).toBe(false);
  });
  it('parses bars newest-first into oldest-first and validates numbers', async () => {
    const p = new AlpacaProvider({ ...cfg, fetchImpl: respond(200, { bars: [{ t: '2026-03-10T05:00:00Z', o: 2, h: 3, l: 1, c: 2.5, v: 10 }, { t: '2026-03-09T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 9 }, { t: 'x', o: 'bad' }] }) as typeof fetch });
    const b = await p.bars('SPY', '1Day', 2);
    expect(b.map((c) => c.c)).toEqual([1.5, 2.5]);
  });
  it('follows next_page_token until it has enough bars', async () => {
    const urls: string[] = [];
    const paged = (async (url: string) => {
      urls.push(url);
      const second = url.includes('page_token=abc');
      const bars = second ? [{ t: '2026-03-08T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1, v: 1 }] : [{ t: '2026-03-10T05:00:00Z', o: 3, h: 4, l: 2, c: 3, v: 1 }, { t: '2026-03-09T05:00:00Z', o: 2, h: 3, l: 1, c: 2, v: 1 }];
      return new Response(JSON.stringify({ bars, next_page_token: second ? null : 'abc' }), { status: 200 });
    }) as typeof fetch;
    const b = await new AlpacaProvider({ ...cfg, fetchImpl: paged }).bars('SPY', '1Day', 10);
    expect(urls).toHaveLength(2);
    expect(b.map((c) => c.c)).toEqual([1, 2, 3]);
  });
  it('daily candles use the consolidated feed ending 16+ minutes ago, falling back to IEX if refused', async () => {
    const urls: string[] = [];
    const deny = (async (url: string) => {
      urls.push(url);
      if (url.includes('feed=sip')) return new Response('subscription does not permit', { status: 403 });
      return new Response(JSON.stringify({ bars: [{ t: '2026-03-10T05:00:00Z', o: 1, h: 2, l: 0.5, c: 1, v: 1 }] }), { status: 200 });
    }) as typeof fetch;
    const b = await new AlpacaProvider({ ...cfg, dailyFeed: 'sip', fetchImpl: deny }).bars('SPY', '1Day', 10);
    expect(b).toHaveLength(1);
    expect(urls[0]).toMatch(/feed=sip&?.*/);
    expect(urls[0]).toMatch(/&end=/);
    expect(urls.at(-1)).toMatch(/feed=iex/);
  });
  it('parses the market clock', async () => {
    const p = new AlpacaProvider({ ...cfg, fetchImpl: respond(200, { is_open: true, timestamp: '2026-03-10T15:00:00Z', next_open: '2026-03-11T13:30:00Z', next_close: '2026-03-10T20:00:00Z' }) as typeof fetch });
    expect((await p.clock()).isOpen).toBe(true);
  });
  it('maps failures to clear errors', async () => {
    await expect(new AlpacaProvider({ ...cfg, keyId: null }).quotes(['SPY'])).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(new AlpacaProvider({ ...cfg, fetchImpl: respond(401, 'no') as typeof fetch }).quotes(['SPY'])).rejects.toMatchObject({ code: 'AUTH' });
    await expect(new AlpacaProvider({ ...cfg, fetchImpl: respond(429, 'slow') as typeof fetch }).quotes(['SPY'])).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    await expect(new AlpacaProvider({ ...cfg, fetchImpl: respond(200, 'not json') as typeof fetch }).quotes(['SPY'])).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(new AlpacaProvider({ ...cfg, fetchImpl: respond(200, { bars: [] }) as typeof fetch }).bars('ZZZZ', '1Day', 10)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const timeout = async () => {
      const e = new Error('t');
      e.name = 'TimeoutError';
      throw e;
    };
    await expect(new AlpacaProvider({ ...cfg, fetchImpl: timeout as typeof fetch }).quotes(['SPY'])).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('retries once on a server error', async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response('x', { status: 503 }) : new Response(JSON.stringify({ SPY: { latestTrade: { p: 1, t: '2026-03-10T15:00:00Z' } } }), { status: 200 }))) as typeof fetch;
    expect((await new AlpacaProvider({ ...cfg, fetchImpl: flaky }).quotes(['SPY'])).size).toBe(1);
    expect(n).toBe(2);
  });
});
