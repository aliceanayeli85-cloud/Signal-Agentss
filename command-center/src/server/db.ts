import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_SETTINGS, RiskSettingsSchema, type RiskSettings } from '../engine/settings.js';

export type Db = Database.Database;
export type Mode = 'paper' | 'live';

/**
 * Versioned migrations. Paper and live records share tables but every row
 * carries `mode`, and every query filters on it, so simulated and real
 * results are never mixed.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE watchlist (symbol TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    qty REAL NOT NULL,
    order_type TEXT NOT NULL CHECK (order_type IN ('market','limit')),
    limit_price REAL,
    est_price REAL NOT NULL,
    stop REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    invalidation_price REAL,
    planned_loss REAL NOT NULL,
    timeframe TEXT NOT NULL,
    setup_type TEXT,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL,
    status_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER
  );
  CREATE INDEX orders_status ON orders(mode, status);
  CREATE TABLE positions (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
    order_id TEXT UNIQUE,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    setup_type TEXT,
    qty_initial REAL NOT NULL,
    qty_open REAL NOT NULL,
    entry_price REAL NOT NULL,
    stop REAL NOT NULL,
    tp1 REAL NOT NULL,
    tp2 REAL NOT NULL,
    tp1_done INTEGER NOT NULL DEFAULT 0,
    invalidation_price REAL,
    planned_loss REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed')),
    realized_pnl REAL NOT NULL DEFAULT 0,
    exit_reason TEXT,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    last_price REAL,
    last_price_at INTEGER
  );
  CREATE INDEX positions_status ON positions(mode, status);
  CREATE TABLE fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    position_id TEXT NOT NULL REFERENCES positions(id),
    side TEXT NOT NULL,
    qty REAL NOT NULL,
    price REAL NOT NULL,
    fees REAL NOT NULL,
    realized_pnl REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('price_above','price_below')),
    price REAL NOT NULL,
    note TEXT,
    status TEXT NOT NULL CHECK (status IN ('armed','triggered','disabled')),
    created_at INTEGER NOT NULL,
    triggered_at INTEGER
  );
  CREATE TABLE alert_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('PRICE_ALERT','SIMULATED_ORDER','SYSTEM')),
    mode TEXT,
    symbol TEXT,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    price REAL,
    price_at INTEGER,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE TABLE journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    position_id TEXT UNIQUE,
    symbol TEXT NOT NULL,
    plan_summary TEXT,
    why_entered TEXT,
    followed_plan TEXT,
    what_happened TEXT,
    lesson TEXT,
    emotion TEXT,
    grade TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE monitor_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT,
    lease_until INTEGER,
    last_run_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    next_run_at INTEGER,
    interval_sec INTEGER,
    market_open INTEGER,
    symbols_checked INTEGER
  );
  INSERT INTO monitor_state (id) VALUES (1);
  CREATE TABLE quotes (symbol TEXT PRIMARY KEY, price REAL NOT NULL, price_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL, source TEXT NOT NULL);
  CREATE TABLE backtests (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, timeframe TEXT NOT NULL, created_at INTEGER NOT NULL, result_json TEXT NOT NULL);
  CREATE TABLE risk_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);
  INSERT INTO watchlist (symbol, added_at) VALUES ('SPY', 0), ('QQQ', 0), ('IWM', 0);
  `,
];

export function openDb(path: string): Db {
  const file = path === ':memory:' ? path : resolve(path);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // The API server and the monitor worker may share this file.
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    })();
  }
  return db;
}

export function getKv<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function setKv(db: Db, key: string, value: unknown, now = Date.now()): void {
  db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), now);
}

export function getSettings(db: Db): RiskSettings {
  const stored = getKv<Partial<RiskSettings>>(db, 'risk_settings');
  const parsed = RiskSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export interface KillSwitch {
  on: boolean;
  at: number | null;
  reason: string | null;
}

export function getKillSwitch(db: Db): KillSwitch {
  return getKv<KillSwitch>(db, 'kill_switch') ?? { on: false, at: null, reason: null };
}

export function logRiskEvent(db: Db, code: string, message: string, now = Date.now()) {
  db.prepare('INSERT INTO risk_events (at, code, message) VALUES (?, ?, ?)').run(now, code, message);
}
