import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Schema notes:
 *  - Every timestamp is Unix milliseconds stored as an integer, in UTC. Storing
 *    formatted strings invites timezone bugs that silently corrupt performance
 *    statistics.
 *  - Nullable price/size columns are genuinely nullable: a trade that has not
 *    closed has no exit price, and writing 0 there would be a fabricated fill.
 *  - Records are preserved. Closing a trade updates it in place; nothing is
 *    deleted by the app except rows the user explicitly removes.
 */

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  accountSize: real('account_size').notNull(),
  defaultRiskPct: real('default_risk_pct').notNull(),
  maxRiskPctPerTrade: real('max_risk_pct_per_trade').notNull(),
  maxTradesPerDay: integer('max_trades_per_day').notNull(),
  maxDailyLossPct: real('max_daily_loss_pct').notNull(),
  maxConsecutiveLosses: integer('max_consecutive_losses').notNull(),
  simulationOverride: integer('simulation_override').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    symbol: text('symbol').notNull(),
    name: text('name'),
    assetClass: text('asset_class').notNull(),
    provider: text('provider').notNull(),
    chain: text('chain'),
    pairAddress: text('pair_address'),
    baseTokenAddress: text('base_token_address'),
    url: text('url'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [index('assets_symbol_idx').on(table.symbol)],
);

/** Point-in-time snapshots, kept so historical context can be reconstructed later. */
export const marketData = sqliteTable(
  'market_data',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: text('asset_id').notNull(),
    capturedAt: integer('captured_at').notNull(),
    priceUsd: real('price_usd'),
    liquidityUsd: real('liquidity_usd'),
    marketCapUsd: real('market_cap_usd'),
    fdvUsd: real('fdv_usd'),
    volume24h: real('volume_24h'),
    volume1h: real('volume_1h'),
    priceChange24h: real('price_change_24h'),
    priceChange1h: real('price_change_1h'),
    buys1h: integer('buys_1h'),
    sells1h: integer('sells_1h'),
    source: text('source').notNull(),
    raw: text('raw'),
  },
  (table) => [index('market_data_asset_time_idx').on(table.assetId, table.capturedAt)],
);

export const strategies = sqliteTable('strategies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

/** A setup detected at a point in time. Preserved so statistics can be rebuilt. */
export const setups = sqliteTable(
  'setups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    strategyId: text('strategy_id').notNull(),
    timeframe: text('timeframe').notNull(),
    direction: text('direction').notNull(),
    detectedAt: integer('detected_at').notNull(),
    triggerTime: integer('trigger_time').notNull(),
    entry: real('entry').notNull(),
    stop: real('stop').notNull(),
    invalidation: real('invalidation'),
    tp1: real('tp1'),
    tp2: real('tp2'),
    tp3: real('tp3'),
    setupScore: integer('setup_score'),
    riskScore: integer('risk_score'),
    alignment: text('alignment'),
    structure: text('structure'),
    reasons: text('reasons'),
    warnings: text('warnings'),
  },
  (table) => [index('setups_asset_idx').on(table.assetId, table.detectedAt)],
);

export const paperTrades = sqliteTable(
  'paper_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: integer('created_at').notNull(),
    closedAt: integer('closed_at'),
    status: text('status').notNull().default('open'),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    assetClass: text('asset_class').notNull(),
    timeframe: text('timeframe').notNull(),
    strategy: text('strategy'),
    direction: text('direction').notNull(),
    entry: real('entry').notNull(),
    stop: real('stop').notNull(),
    tp1: real('tp1'),
    tp2: real('tp2'),
    tp3: real('tp3'),
    positionSize: real('position_size').notNull(),
    accountSize: real('account_size'),
    riskPct: real('risk_pct'),
    riskAmount: real('risk_amount'),
    exitPrice: real('exit_price'),
    exitReason: text('exit_reason'),
    pnl: real('pnl'),
    rMultiple: real('r_multiple'),
    setupScore: integer('setup_score'),
    riskScore: integer('risk_score'),
    marketConditions: text('market_conditions'),
    fomoFlagged: integer('fomo_flagged').notNull().default(0),
    notes: text('notes'),
    /** Guards against the same setup being entered twice by a double submit. */
    dedupeKey: text('dedupe_key'),
  },
  (table) => [
    index('paper_trades_status_idx').on(table.status),
    index('paper_trades_created_idx').on(table.createdAt),
    uniqueIndex('paper_trades_dedupe_idx').on(table.dedupeKey),
  ],
);

export const tradeJournal = sqliteTable(
  'trade_journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tradeId: integer('trade_id').notNull(),
    createdAt: integer('created_at').notNull(),
    phase: text('phase').notNull(),
    answers: text('answers').notNull(),
    grade: text('grade'),
  },
  (table) => [uniqueIndex('journal_trade_phase_idx').on(table.tradeId, table.phase)],
);

export const backtests = sqliteTable(
  'backtests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: integer('created_at').notNull(),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    timeframe: text('timeframe').notNull(),
    config: text('config').notNull(),
    barsUsed: integer('bars_used').notNull(),
    firstBarTime: integer('first_bar_time'),
    lastBarTime: integer('last_bar_time'),
    result: text('result').notNull(),
    tradeCount: integer('trade_count').notNull(),
    oosTradeCount: integer('oos_trade_count').notNull(),
  },
  (table) => [index('backtests_created_idx').on(table.createdAt)],
);

/** Snapshots of the performance engine output, so progress over time is visible. */
export const performance = sqliteTable('performance', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  capturedAt: integer('captured_at').notNull(),
  sampleSize: integer('sample_size').notNull(),
  winRatePct: real('win_rate_pct'),
  expectancyR: real('expectancy_r'),
  profitFactor: real('profit_factor'),
  maxDrawdownR: real('max_drawdown_r'),
  totalPnl: real('total_pnl').notNull(),
  payload: text('payload').notNull(),
});

export const alerts = sqliteTable(
  'alerts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    kind: text('kind').notNull(),
    threshold: real('threshold'),
    direction: text('direction'),
    timeframe: text('timeframe').notNull(),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    lastFiredAt: integer('last_fired_at'),
    lastMessage: text('last_message'),
  },
  (table) => [index('alerts_enabled_idx').on(table.enabled)],
);

export const watchlists = sqliteTable(
  'watchlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Resolved pair id. Empty until a token address has been resolved. */
    assetId: text('asset_id').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name'),
    assetClass: text('asset_class').notNull(),
    chain: text('chain'),
    pairAddress: text('pair_address'),
    /** Token CONTRACT address for token-identified rows; null for pair rows. */
    tokenAddress: text('token_address'),
    listName: text('list_name').notNull().default('Default'),
    pinned: integer('pinned').notNull().default(0),
    timeframe: text('timeframe').notNull(),
    status: text('status').notNull().default('WATCH'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('watchlist_token_idx').on(table.listName, table.tokenAddress),
    uniqueIndex('watchlist_pair_idx').on(table.listName, table.assetId),
    index('watchlist_list_idx').on(table.listName),
  ],
);

/**
 * Stored OHLCV. The primary key is (asset, timeframe, bar time) so re-fetching
 * an overlapping window updates the bars it already has instead of duplicating
 * them - which matters because the most recent bar is still forming and its
 * high, low and close legitimately change between fetches.
 */
export const candles = sqliteTable(
  'candles',
  {
    assetId: text('asset_id').notNull(),
    timeframe: text('timeframe').notNull(),
    barTime: integer('bar_time').notNull(),
    open: real('open').notNull(),
    high: real('high').notNull(),
    low: real('low').notNull(),
    close: real('close').notNull(),
    volume: real('volume'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.timeframe, table.barTime] }),
    index('candles_lookup_idx').on(table.assetId, table.timeframe, table.barTime),
  ],
);

/** Schema version bookkeeping for the hand-rolled migrator. */
export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: integer('applied_at').notNull().default(sql`0`),
});
