import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LOG_LEVEL = 'error';

const { closeDb, initDb, DatabaseUnavailableError } = await import('../src/server/db/index.js');
const { seedDefaults } = await import('../src/server/db/seed.js');
const { settings, strategies } = await import('../src/server/db/schema.js');

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memetrader-db-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  closeDb();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database initialisation', () => {
  it('creates the file, applies migrations and seeds structural rows only', () => {
    const db = initDb(join(freshDir(), 'nested', 'app.db'));
    seedDefaults(db);

    const settingsRows = db.select().from(settings).all();
    expect(settingsRows).toHaveLength(1);

    const strategyRows = db.select().from(strategies).all();
    expect(strategyRows).toHaveLength(5);

    // Nothing else is seeded: no trades, no market data, no results.
    const raw = db.$client;
    for (const table of ['paper_trades', 'market_data', 'backtests', 'trade_journal', 'performance']) {
      const count = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(count.n).toBe(0);
    }
  });

  it('records each migration exactly once, even across reopens', () => {
    const path = join(freshDir(), 'app.db');
    const first = initDb(path);
    const applied = first.$client.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    closeDb();

    const second = initDb(path);
    const reapplied = second.$client.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(reapplied.n).toBe(applied.n);
  });

  it('seeding twice does not duplicate rows', () => {
    const db = initDb(join(freshDir(), 'app.db'));
    seedDefaults(db);
    seedDefaults(db);
    expect(db.select().from(settings).all()).toHaveLength(1);
    expect(db.select().from(strategies).all()).toHaveLength(5);
  });

  it('throws a typed error when the database path cannot be opened', () => {
    expect(() => initDb('/proc/self/mem/impossible/app.db')).toThrow(DatabaseUnavailableError);
  });

  it('enforces the unique constraint that prevents duplicate paper trades', () => {
    const db = initDb(join(freshDir(), 'app.db'));
    const raw = db.$client;
    const insert = raw.prepare(
      `INSERT INTO paper_trades (created_at, status, asset_id, symbol, asset_class, timeframe, direction, entry, stop, position_size, fomo_flagged, dedupe_key)
       VALUES (?, 'open', 'a:b', 'X', 'meme', '1h', 'long', 100, 95, 1, 0, ?)`,
    );
    insert.run(Date.now(), 'same-key');
    expect(() => insert.run(Date.now(), 'same-key')).toThrow(/UNIQUE/i);
  });

  it('allows many trades with a null dedupe key, since SQLite treats nulls as distinct', () => {
    const db = initDb(join(freshDir(), 'app.db'));
    const raw = db.$client;
    const insert = raw.prepare(
      `INSERT INTO paper_trades (created_at, status, asset_id, symbol, asset_class, timeframe, direction, entry, stop, position_size, fomo_flagged, dedupe_key)
       VALUES (?, 'open', 'a:b', 'X', 'meme', '1h', 'long', 100, 95, 1, 0, NULL)`,
    );
    insert.run(Date.now());
    expect(() => insert.run(Date.now())).not.toThrow();
  });
});
