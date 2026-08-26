import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The database path is read at import time, so it must be set before anything
// under src/server is loaded. Each run gets a throwaway file.
const dataDir = mkdtempSync(join(tmpdir(), 'memetrader-test-'));
process.env.DATABASE_PATH = join(dataDir, 'test.db');
process.env.LOG_LEVEL = 'error';

const { createApp } = await import('../src/server/app.js');
const { initDb, closeDb, DatabaseUnavailableError } = await import('../src/server/db/index.js');
const { seedDefaults } = await import('../src/server/db/seed.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const db = initDb(process.env.DATABASE_PATH as string);
  seedDefaults(db);
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  // The daily limits are real and would otherwise block later fixtures. The
  // "settings and limits" block sets them back down to exercise the lock.
  const permissive = await fetch(`${base}/api/desk/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountSize: 10_000,
      defaultRiskPct: 1,
      maxRiskPctPerTrade: 1,
      maxTradesPerDay: 100,
      maxDailyLossPct: 100,
      maxConsecutiveLosses: 50,
      simulationOverride: 0,
    }),
  });
  if (!permissive.ok) {
    throw new Error(`Test fixture could not relax the risk limits: ${await permissive.text()}`);
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * These helpers deliberately return a loosely typed body: the point of the
 * integration tests is to assert the JSON the server actually emits, not to
 * re-declare its shape here and risk the declaration drifting from reality.
 */
interface JsonResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function get(path: string): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

async function send(method: string, path: string, payload?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe('health and provider status', () => {
  it('reports which providers are configured and that execution is disabled', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.execution.liveTradingEnabled).toBe(false);
    expect(body.execution.note).toMatch(/no wallet connection/i);
    expect(Array.isArray(body.providers)).toBe(true);
  });

  it('returns a reason for every provider that is not configured', async () => {
    const { body } = await get('/api/health');
    for (const provider of body.providers) {
      if (!provider.configured) expect(provider.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('validation', () => {
  it('rejects an unknown scanner tab with a 400 and an explanation', async () => {
    const { status, body } = await get('/api/market/scan?tab=not-a-tab');
    expect(status).toBe(400);
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/Invalid tab/i);
  });

  it('rejects an asset id containing unexpected characters', async () => {
    const { status } = await get('/api/market/candles?assetId=' + encodeURIComponent("'; DROP TABLE assets;--"));
    expect(status).toBe(400);
  });

  it('rejects a candle limit outside the supported range', async () => {
    const { status } = await get('/api/market/candles?assetId=coinbase:BTC-USD&limit=999999');
    expect(status).toBe(400);
  });

  it('returns 404 with a message for an unknown route', async () => {
    const { status, body } = await get('/api/does-not-exist');
    expect(status).toBe(404);
    expect(body.message).toMatch(/No route for GET/);
  });

  it('reports an unregistered provider prefix as unavailable, not as an error', async () => {
    const { status, body } = await get('/api/market/candles?assetId=madeup:thing&timeframe=1h');
    expect(status).toBe(200);
    expect(body.status).toBe('unavailable');
    expect(body.reason).toMatch(/No data provider is registered/i);
  });
});

describe('empty state', () => {
  it('returns an empty watchlist rather than failing', async () => {
    const { status, body } = await get('/api/watchlist');
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('returns zeroed but valid performance with no trades', async () => {
    const { status, body } = await get('/api/performance');
    expect(status).toBe(200);
    expect(body.sampleSize).toBe(0);
    expect(body.confidence).toBe('NONE');
    expect(body.winRatePct).toBeNull();
  });

  it('publishes no win rate from an empty statistics sample', async () => {
    const { body } = await get('/api/performance/stats');
    expect(body.winRatePct).toBeNull();
    expect(body.sufficient).toBe(false);
    expect(body.statement).toMatch(/Insufficient observations/i);
  });
});

describe('position sizing endpoint', () => {
  it('sizes a valid request', async () => {
    const { body } = await send('POST', '/api/trading/position-size', {
      accountSize: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 95,
    });
    expect(body.available).toBe(true);
    expect(body.positionSize).toBe(20);
  });

  it('rejects a zero entry at the validation layer', async () => {
    const { status } = await send('POST', '/api/trading/position-size', {
      accountSize: 10_000,
      riskPct: 1,
      entry: 0,
      stop: 95,
    });
    expect(status).toBe(400);
  });

  it('reports an unusable stop as unavailable with a reason', async () => {
    const { body } = await send('POST', '/api/trading/position-size', {
      accountSize: 10_000,
      riskPct: 1,
      entry: 100,
      stop: 100,
    });
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/risk per unit is zero/i);
  });
});

describe('paper trades', () => {
  const entry = {
    assetId: 'coinbase:BTC-USD',
    symbol: 'BTC',
    assetClass: 'crypto',
    timeframe: '1h',
    strategy: 'breakout-retest',
    direction: 'long',
    entry: 100,
    stop: 95,
    tp1: 105,
    tp2: 110,
    tp3: 115,
    positionSize: 20,
    accountSize: 10_000,
    riskPct: 1,
    riskAmount: 100,
  };

  it('records a trade and returns it', async () => {
    const { status, body } = await send('POST', '/api/trading/paper-trades', entry);
    expect(status).toBe(201);
    expect(body.id).toBeGreaterThan(0);
    expect(body.status).toBe('open');
  });

  it('collapses a duplicate submission instead of creating a second position', async () => {
    const first = await send('POST', '/api/trading/paper-trades', { ...entry, entry: 200, stop: 190 });
    const second = await send('POST', '/api/trading/paper-trades', { ...entry, entry: 200, stop: 190 });
    expect(second.body.id).toBe(first.body.id);

    const { body } = await get('/api/trading/paper-trades');
    const matching = body.trades.filter((t: { entry: number }) => t.entry === 200);
    expect(matching).toHaveLength(1);
  });

  it('refuses a stop on the wrong side of the entry', async () => {
    const { status, body } = await send('POST', '/api/trading/paper-trades', {
      ...entry,
      entry: 300,
      stop: 310,
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/stop must sit below the entry/i);
  });

  it('computes P&L and R on close', async () => {
    const opened = await send('POST', '/api/trading/paper-trades', { ...entry, entry: 400, stop: 380 });
    const closed = await send('POST', `/api/trading/paper-trades/${opened.body.id}/close`, {
      exitPrice: 440,
      exitReason: 'TP2 hit',
    });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    // Risk was 20 per unit; the exit is 40 above entry, so exactly +2R.
    expect(closed.body.rMultiple).toBeCloseTo(2, 9);
    expect(closed.body.pnl).toBeCloseTo(40 * entry.positionSize, 9);
  });

  it('refuses to close the same trade twice', async () => {
    const opened = await send('POST', '/api/trading/paper-trades', { ...entry, entry: 500, stop: 480 });
    await send('POST', `/api/trading/paper-trades/${opened.body.id}/close`, {
      exitPrice: 520,
      exitReason: 'first close',
    });
    const again = await send('POST', `/api/trading/paper-trades/${opened.body.id}/close`, {
      exitPrice: 530,
      exitReason: 'second close',
    });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already closed/i);
  });

  it('refuses a non-positive exit price', async () => {
    const opened = await send('POST', '/api/trading/paper-trades', { ...entry, entry: 600, stop: 580 });
    const { status } = await send('POST', `/api/trading/paper-trades/${opened.body.id}/close`, {
      exitPrice: 0,
      exitReason: 'bad',
    });
    expect(status).toBe(400);
  });

  it('returns 404 for a trade that does not exist', async () => {
    const { status, body } = await get('/api/trading/paper-trades/999999');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});

describe('journal', () => {
  it('refuses an entry for a trade that does not exist', async () => {
    const { status } = await send('POST', '/api/journal', {
      tradeId: 999999,
      phase: 'pre',
      answers: { why: 'test' },
    });
    expect(status).toBe(404);
  });

  it('upserts rather than duplicating one phase per trade', async () => {
    const opened = await send('POST', '/api/trading/paper-trades', {
      assetId: 'coinbase:ETH-USD',
      symbol: 'ETH',
      assetClass: 'crypto',
      timeframe: '4h',
      direction: 'long',
      entry: 2000,
      stop: 1900,
      positionSize: 1,
    });
    await send('POST', '/api/journal', {
      tradeId: opened.body.id,
      phase: 'pre',
      answers: { why: 'first' },
    });
    await send('POST', '/api/journal', {
      tradeId: opened.body.id,
      phase: 'pre',
      answers: { why: 'revised' },
    });

    const { body } = await get(`/api/journal/${opened.body.id}`);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].answers.why).toBe('revised');
  });

  it('exposes the pre- and post-trade question sets', async () => {
    const { body } = await get('/api/journal/questions');
    expect(body.pre.length).toBeGreaterThan(0);
    expect(body.post.some((q: { id: string }) => q.id === 'followed_plan')).toBe(true);
    expect(body.grades).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
});

describe('watchlist', () => {
  it('adds, updates and deletes an entry', async () => {
    const added = await send('POST', '/api/watchlist', {
      assetId: 'coinbase:SOL-USD',
      symbol: 'SOL',
      assetClass: 'crypto',
      timeframe: '1h',
    });
    expect(added.status).toBe(201);
    expect(added.body.status).toBe('WATCH');

    const updated = await send('PATCH', `/api/watchlist/${added.body.id}`, { status: 'INVALIDATED' });
    expect(updated.body.status).toBe('INVALIDATED');

    const deleted = await send('DELETE', `/api/watchlist/${added.body.id}`);
    expect(deleted.status).toBe(200);

    const missing = await send('DELETE', `/api/watchlist/${added.body.id}`);
    expect(missing.status).toBe(404);
  });

  it('does not create a second row for the same asset', async () => {
    await send('POST', '/api/watchlist', {
      assetId: 'coinbase:LINK-USD',
      symbol: 'LINK',
      assetClass: 'crypto',
      timeframe: '1h',
    });
    await send('POST', '/api/watchlist', {
      assetId: 'coinbase:LINK-USD',
      symbol: 'LINK',
      assetClass: 'crypto',
      timeframe: '4h',
    });
    const { body } = await get('/api/watchlist');
    const matching = body.items.filter((i: { assetId: string }) => i.assetId === 'coinbase:LINK-USD');
    expect(matching).toHaveLength(1);
    expect(matching[0].timeframe).toBe('4h');
  });
});

describe('settings and limits', () => {
  it('rejects settings outside the permitted ranges', async () => {
    const { status } = await send('PUT', '/api/desk/settings', {
      accountSize: -1,
      defaultRiskPct: 1,
      maxRiskPctPerTrade: 1,
      maxTradesPerDay: 3,
      maxDailyLossPct: 3,
      maxConsecutiveLosses: 3,
      simulationOverride: 0,
    });
    expect(status).toBe(400);
  });

  it('warns when the default risk exceeds the 2% ceiling', async () => {
    const { body } = await send('PUT', '/api/desk/settings', {
      accountSize: 10_000,
      defaultRiskPct: 5,
      maxRiskPctPerTrade: 5,
      maxTradesPerDay: 50,
      maxDailyLossPct: 50,
      maxConsecutiveLosses: 50,
      simulationOverride: 0,
    });
    expect(body.warnings.some((w: string) => /above the 2% ceiling/i.test(w))).toBe(true);
  });

  it('locks trading once the daily trade limit is reached, then unlocks under the override', async () => {
    await send('PUT', '/api/desk/settings', {
      accountSize: 10_000,
      defaultRiskPct: 1,
      maxRiskPctPerTrade: 1,
      maxTradesPerDay: 1,
      maxDailyLossPct: 3,
      maxConsecutiveLosses: 3,
      simulationOverride: 0,
    });

    const locked = await get('/api/trading/limits');
    expect(locked.body.locked).toBe(true);
    expect(locked.body.message).toMatch(/TRADING LOCKED/);

    const blocked = await send('POST', '/api/trading/paper-trades', {
      assetId: 'coinbase:BTC-USD',
      symbol: 'BTC',
      assetClass: 'crypto',
      timeframe: '1h',
      direction: 'long',
      entry: 700,
      stop: 690,
      positionSize: 1,
    });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error).toBe('risk_limit_reached');
    expect(Array.isArray(blocked.body.reasons)).toBe(true);

    await send('PUT', '/api/desk/settings', {
      accountSize: 10_000,
      defaultRiskPct: 1,
      maxRiskPctPerTrade: 1,
      maxTradesPerDay: 1,
      maxDailyLossPct: 3,
      maxConsecutiveLosses: 3,
      simulationOverride: 1,
    });

    const overridden = await get('/api/trading/limits');
    expect(overridden.body.locked).toBe(false);
    expect(overridden.body.overrideActive).toBe(true);
    expect(overridden.body.reasons.length).toBeGreaterThan(0);

    // Restore permissive settings so later assertions are not affected.
    await send('PUT', '/api/desk/settings', {
      accountSize: 10_000,
      defaultRiskPct: 1,
      maxRiskPctPerTrade: 1,
      maxTradesPerDay: 100,
      maxDailyLossPct: 100,
      maxConsecutiveLosses: 50,
      simulationOverride: 0,
    });
  });
});

describe('AI availability', () => {
  it('reports AI as unconfigured without an API key rather than inventing analysis', async () => {
    const { body } = await get('/api/market/ai/status');
    if (!body.configured) {
      expect(body.reason).toMatch(/ANTHROPIC_API_KEY/);
    }
  });
});

describe('database layer', () => {
  it('is idempotent across repeated initialisation', () => {
    const again = initDb(process.env.DATABASE_PATH as string);
    expect(again).toBeDefined();
  });

  it('exports a typed error for an unusable database', () => {
    expect(DatabaseUnavailableError.prototype).toBeInstanceOf(Error);
  });
});
