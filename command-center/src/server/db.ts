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
  // v2: C1 experimental strategy. Its own tables, so it can never mix with the baseline
  // paper account ("positions"/"fills") or with real-money records.
  `
  CREATE TABLE c1_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_date TEXT NOT NULL,
    last_processed_date TEXT,
    last_run_at INTEGER,
    last_success_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    warnings_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE c1_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('entry','exit')),
    symbol TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    signal_close REAL NOT NULL,
    level REAL NOT NULL,
    stop REAL,
    trade_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','executed','skipped')),
    status_reason TEXT,
    resolved_date TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, symbol, signal_date)
  );
  CREATE TABLE c1_trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    signal_date TEXT NOT NULL,
    entry_date TEXT NOT NULL,
    entry_time INTEGER NOT NULL,
    entry_raw REAL NOT NULL,
    entry_fill REAL NOT NULL,
    shares REAL NOT NULL,
    stop REAL NOT NULL,
    planned_risk REAL NOT NULL,
    entry_slippage REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed')),
    exit_date TEXT,
    exit_time INTEGER,
    exit_raw REAL,
    exit_fill REAL,
    exit_slippage REAL,
    fees REAL NOT NULL DEFAULT 0,
    pnl REAL,
    r_multiple REAL,
    exit_reason TEXT,
    regime TEXT NOT NULL,
    mae REAL NOT NULL DEFAULT 0,
    mfe REAL NOT NULL DEFAULT 0,
    bars_held INTEGER NOT NULL DEFAULT 0,
    last_close REAL,
    last_close_date TEXT
  );
  CREATE TABLE c1_daily (
    date TEXT PRIMARY KEY,
    equity REAL NOT NULL,
    cash REAL NOT NULL,
    invested REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    bench_full_equity REAL NOT NULL,
    bench_matched_equity REAL NOT NULL,
    bench_close REAL NOT NULL
  );
  `,
  // v3: Trading Intelligence agent. Real holdings are entered by the user; nothing here can place an order.
  `
  CREATE TABLE holdings (
    symbol TEXT PRIMARY KEY,
    shares REAL NOT NULL CHECK (shares > 0),
    cost_basis REAL NOT NULL CHECK (cost_basis >= 0),
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    data_through TEXT,
    scanned INTEGER NOT NULL DEFAULT 0,
    model_version TEXT,
    market_json TEXT,
    briefing_json TEXT,
    meta_json TEXT
  );
  CREATE TABLE agent_opportunities (
    run_id INTEGER NOT NULL REFERENCES agent_runs(id),
    symbol TEXT NOT NULL,
    rank INTEGER NOT NULL,
    classification TEXT NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (run_id, symbol)
  );
  CREATE TABLE agent_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    asof_date TEXT NOT NULL,
    horizon INTEGER NOT NULL,
    status TEXT NOT NULL,
    p_up REAL,
    base_rate REAL NOT NULL,
    shadow_p REAL,
    shadow_bucket INTEGER,
    classification TEXT NOT NULL,
    price REAL NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    outcome_date TEXT,
    actual_return REAL,
    UNIQUE (symbol, asof_date, horizon)
  );
  CREATE TABLE agent_tickets (
    id TEXT PRIMARY KEY,
    run_id INTEGER,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','expired')),
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE TABLE alert_events_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL CHECK (category IN ('PRICE_ALERT','SIMULATED_ORDER','SYSTEM','AGENT')),
    mode TEXT,
    symbol TEXT,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    price REAL,
    price_at INTEGER,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  INSERT INTO alert_events_v3 SELECT * FROM alert_events;
  DROP TABLE alert_events;
  ALTER TABLE alert_events_v3 RENAME TO alert_events;
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
