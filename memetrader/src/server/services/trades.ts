import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type {
  LimitState,
  PaperTradeRecord,
  Settings,
  Timeframe,
} from '../../shared/types.js';
import { DEFAULT_SETTINGS, evaluateLimits } from '../../engine/discipline.js';
import { rMultiple, realisedPnl } from '../../engine/position-size.js';
import { getDb } from '../db/index.js';
import { paperTrades, settings as settingsTable } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

export function readSettings(): Settings {
  const db = getDb();
  const row = db.select().from(settingsTable).where(eq(settingsTable.id, 1)).get();
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    accountSize: row.accountSize,
    defaultRiskPct: row.defaultRiskPct,
    maxRiskPctPerTrade: row.maxRiskPctPerTrade,
    maxTradesPerDay: row.maxTradesPerDay,
    maxDailyLossPct: row.maxDailyLossPct,
    maxConsecutiveLosses: row.maxConsecutiveLosses,
    simulationOverride: row.simulationOverride,
  };
}

export function writeSettings(next: Settings): Settings {
  const db = getDb();
  db.insert(settingsTable)
    .values({ id: 1, ...next, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { ...next, updatedAt: Date.now() },
    })
    .run();
  return readSettings();
}

type Row = typeof paperTrades.$inferSelect;

function toRecord(row: Row): PaperTradeRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    status: row.status as PaperTradeRecord['status'],
    assetId: row.assetId,
    symbol: row.symbol,
    assetClass: row.assetClass as PaperTradeRecord['assetClass'],
    timeframe: row.timeframe as Timeframe,
    strategy: row.strategy,
    direction: row.direction as 'long' | 'short',
    entry: row.entry,
    stop: row.stop,
    tp1: row.tp1,
    tp2: row.tp2,
    tp3: row.tp3,
    positionSize: row.positionSize,
    accountSize: row.accountSize,
    riskPct: row.riskPct,
    riskAmount: row.riskAmount,
    exitPrice: row.exitPrice,
    exitReason: row.exitReason,
    pnl: row.pnl,
    rMultiple: row.rMultiple,
    setupScore: row.setupScore,
    riskScore: row.riskScore,
    marketConditions: row.marketConditions,
    fomoFlagged: row.fomoFlagged,
    notes: row.notes,
  };
}

export function listTrades(status?: PaperTradeRecord['status']): PaperTradeRecord[] {
  const db = getDb();
  const rows = status
    ? db.select().from(paperTrades).where(eq(paperTrades.status, status)).orderBy(desc(paperTrades.createdAt)).all()
    : db.select().from(paperTrades).orderBy(desc(paperTrades.createdAt)).all();
  return rows.map(toRecord);
}

export function getTrade(id: number): PaperTradeRecord {
  const db = getDb();
  const row = db.select().from(paperTrades).where(eq(paperTrades.id, id)).get();
  if (!row) throw new NotFoundError(`No paper trade with id ${id}.`);
  return toRecord(row);
}

/** Local midnight, so "trades today" matches what the user sees on their clock. */
export function startOfToday(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function currentLimits(now = Date.now()): LimitState {
  const db = getDb();
  const dayStart = startOfToday(now);
  const openedToday = db
    .select()
    .from(paperTrades)
    .where(gte(paperTrades.createdAt, dayStart))
    .all()
    .map(toRecord);
  const closedToday = db
    .select()
    .from(paperTrades)
    .where(and(eq(paperTrades.status, 'closed'), gte(paperTrades.closedAt, dayStart)))
    .all()
    .map(toRecord);
  const recentClosed = db
    .select()
    .from(paperTrades)
    .where(eq(paperTrades.status, 'closed'))
    .orderBy(desc(paperTrades.closedAt))
    .limit(20)
    .all()
    .map(toRecord);

  return evaluateLimits({
    settings: readSettings(),
    tradesOpenedToday: openedToday,
    tradesClosedToday: closedToday,
    recentClosedTrades: recentClosed,
  });
}

export interface OpenTradeInput {
  assetId: string;
  symbol: string;
  assetClass: PaperTradeRecord['assetClass'];
  timeframe: Timeframe;
  strategy: string | null;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  positionSize: number;
  accountSize: number | null;
  riskPct: number | null;
  riskAmount: number | null;
  setupScore: number | null;
  riskScore: number | null;
  marketConditions: string | null;
  fomoFlagged: boolean;
  notes: string | null;
}

export function openTrade(input: OpenTradeInput): PaperTradeRecord {
  if (input.direction === 'long' && input.stop >= input.entry) {
    throw new ValidationError('For a long paper trade the stop must sit below the entry.');
  }
  if (input.direction === 'short' && input.stop <= input.entry) {
    throw new ValidationError('For a short paper trade the stop must sit above the entry.');
  }
  if (input.entry <= 0 || input.stop <= 0 || input.positionSize <= 0) {
    throw new ValidationError('Entry, stop and position size must all be greater than zero.');
  }

  const db = getDb();
  const now = Date.now();
  // Same asset, direction, entry and stop within a minute is a double submit, not
  // a second trade. The unique index enforces it at the storage layer too.
  const dedupeKey = `${input.assetId}|${input.direction}|${input.entry}|${input.stop}|${Math.floor(now / 60_000)}`;

  const existing = db.select().from(paperTrades).where(eq(paperTrades.dedupeKey, dedupeKey)).get();
  if (existing) return toRecord(existing);

  const inserted = db
    .insert(paperTrades)
    .values({
      createdAt: now,
      closedAt: null,
      status: 'open',
      assetId: input.assetId,
      symbol: input.symbol,
      assetClass: input.assetClass,
      timeframe: input.timeframe,
      strategy: input.strategy,
      direction: input.direction,
      entry: input.entry,
      stop: input.stop,
      tp1: input.tp1,
      tp2: input.tp2,
      tp3: input.tp3,
      positionSize: input.positionSize,
      accountSize: input.accountSize,
      riskPct: input.riskPct,
      riskAmount: input.riskAmount,
      setupScore: input.setupScore,
      riskScore: input.riskScore,
      marketConditions: input.marketConditions,
      fomoFlagged: input.fomoFlagged ? 1 : 0,
      notes: input.notes,
      dedupeKey,
    })
    .returning()
    .get();

  return toRecord(inserted);
}

export function closeTrade(
  id: number,
  exitPrice: number,
  exitReason: string,
  now = Date.now(),
): PaperTradeRecord {
  const trade = getTrade(id);
  if (trade.status !== 'open') {
    throw new ValidationError(`Paper trade ${id} is already ${trade.status}.`);
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new ValidationError('Exit price must be a positive number.');
  }

  const pnl = realisedPnl(trade.direction, trade.entry, exitPrice, trade.positionSize);
  const r = rMultiple(trade.direction, trade.entry, trade.stop, exitPrice);

  const db = getDb();
  const updated = db
    .update(paperTrades)
    .set({
      status: 'closed',
      closedAt: now,
      exitPrice,
      exitReason,
      pnl,
      rMultiple: r,
    })
    .where(eq(paperTrades.id, id))
    .returning()
    .get();

  return toRecord(updated);
}

export function cancelTrade(id: number, reason: string): PaperTradeRecord {
  const trade = getTrade(id);
  if (trade.status !== 'open') {
    throw new ValidationError(`Paper trade ${id} is already ${trade.status}.`);
  }
  const db = getDb();
  const updated = db
    .update(paperTrades)
    .set({ status: 'cancelled', closedAt: Date.now(), exitReason: reason })
    .where(eq(paperTrades.id, id))
    .returning()
    .get();
  return toRecord(updated);
}

/** Most recent closed trades, used by the FOMO detector. */
export function recentTrades(limit = 20): PaperTradeRecord[] {
  const db = getDb();
  return db
    .select()
    .from(paperTrades)
    .orderBy(desc(sql`COALESCE(${paperTrades.closedAt}, ${paperTrades.createdAt})`))
    .limit(limit)
    .all()
    .map(toRecord);
}
