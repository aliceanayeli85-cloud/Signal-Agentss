/**
 * Versioned, hand-written DDL.
 *
 * A local single-file app does not need a migration CLI in the dependency tree;
 * it needs migrations that run automatically on boot and are impossible to forget.
 * Each entry runs exactly once, inside a transaction, in version order.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY,
        account_size REAL NOT NULL,
        default_risk_pct REAL NOT NULL,
        max_risk_pct_per_trade REAL NOT NULL,
        max_trades_per_day INTEGER NOT NULL,
        max_daily_loss_pct REAL NOT NULL,
        max_consecutive_losses INTEGER NOT NULL,
        simulation_override INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        asset_class TEXT NOT NULL,
        provider TEXT NOT NULL,
        chain TEXT,
        pair_address TEXT,
        base_token_address TEXT,
        url TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS assets_symbol_idx ON assets (symbol);

      CREATE TABLE IF NOT EXISTS market_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        price_usd REAL,
        liquidity_usd REAL,
        market_cap_usd REAL,
        fdv_usd REAL,
        volume_24h REAL,
        volume_1h REAL,
        price_change_24h REAL,
        price_change_1h REAL,
        buys_1h INTEGER,
        sells_1h INTEGER,
        source TEXT NOT NULL,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS market_data_asset_time_idx ON market_data (asset_id, captured_at);

      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS setups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        detected_at INTEGER NOT NULL,
        trigger_time INTEGER NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        invalidation REAL,
        tp1 REAL,
        tp2 REAL,
        tp3 REAL,
        setup_score INTEGER,
        risk_score INTEGER,
        alignment TEXT,
        structure TEXT,
        reasons TEXT,
        warnings TEXT
      );
      CREATE INDEX IF NOT EXISTS setups_asset_idx ON setups (asset_id, detected_at);

      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        strategy TEXT,
        direction TEXT NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        tp1 REAL,
        tp2 REAL,
        tp3 REAL,
        position_size REAL NOT NULL,
        account_size REAL,
        risk_pct REAL,
        risk_amount REAL,
        exit_price REAL,
        exit_reason TEXT,
        pnl REAL,
        r_multiple REAL,
        setup_score INTEGER,
        risk_score INTEGER,
        market_conditions TEXT,
        fomo_flagged INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        dedupe_key TEXT
      );
      CREATE INDEX IF NOT EXISTS paper_trades_status_idx ON paper_trades (status);
      CREATE INDEX IF NOT EXISTS paper_trades_created_idx ON paper_trades (created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS paper_trades_dedupe_idx ON paper_trades (dedupe_key);

      CREATE TABLE IF NOT EXISTS trade_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        phase TEXT NOT NULL,
        answers TEXT NOT NULL,
        grade TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS journal_trade_phase_idx ON trade_journal (trade_id, phase);

      CREATE TABLE IF NOT EXISTS backtests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        config TEXT NOT NULL,
        bars_used INTEGER NOT NULL,
        first_bar_time INTEGER,
        last_bar_time INTEGER,
        result TEXT NOT NULL,
        trade_count INTEGER NOT NULL,
        oos_trade_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS backtests_created_idx ON backtests (created_at);

      CREATE TABLE IF NOT EXISTS performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at INTEGER NOT NULL,
        sample_size INTEGER NOT NULL,
        win_rate_pct REAL,
        expectancy_r REAL,
        profit_factor REAL,
        max_drawdown_r REAL,
        total_pnl REAL NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        threshold REAL,
        direction TEXT,
        timeframe TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_fired_at INTEGER,
        last_message TEXT
      );
      CREATE INDEX IF NOT EXISTS alerts_enabled_idx ON alerts (enabled);

      CREATE TABLE IF NOT EXISTS watchlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        chain TEXT,
        pair_address TEXT,
        timeframe TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'WATCH',
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS watchlist_asset_idx ON watchlists (asset_id);
    `,
  },
];
