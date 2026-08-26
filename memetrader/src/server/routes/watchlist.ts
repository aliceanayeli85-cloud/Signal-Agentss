import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { WatchlistItem } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { watchlists } from '../db/schema.js';
import { NotFoundError } from '../lib/errors.js';
import { assetIdSchema, parse, timeframeSchema } from '../lib/validate.js';
import { analyseAsset } from '../services/analysis.js';

export const watchlistRouter: Router = Router();

const STATUSES = ['WATCH', 'SETUP FORMING', 'ENTRY CONDITIONS MET', 'INVALIDATED', 'NO TRADE'] as const;

function toItem(row: typeof watchlists.$inferSelect): WatchlistItem {
  return {
    id: row.id,
    assetId: row.assetId,
    symbol: row.symbol,
    assetClass: row.assetClass as WatchlistItem['assetClass'],
    chain: row.chain,
    pairAddress: row.pairAddress,
    timeframe: row.timeframe as WatchlistItem['timeframe'],
    status: row.status as WatchlistItem['status'],
    note: row.note,
    createdAt: row.createdAt,
  };
}

watchlistRouter.get('/', (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db.select().from(watchlists).orderBy(desc(watchlists.createdAt)).all();
    res.json({ items: rows.map(toItem) });
  } catch (error) {
    next(error);
  }
});

/**
 * Watchlist rows with live analysis attached. Each row is evaluated
 * independently and a row whose data failed carries its own error, so one dead
 * pair does not blank the whole list.
 */
watchlistRouter.get('/live', async (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db.select().from(watchlists).orderBy(desc(watchlists.createdAt)).all();
    const items = await Promise.all(
      rows.map(async (row) => {
        const item = toItem(row);
        try {
          const report = await analyseAsset({
            assetId: item.assetId,
            timeframe: item.timeframe,
            includeMtf: false,
            candleLimit: 200,
          });
          return {
            item,
            status: 'ok' as const,
            price: report.snapshot?.priceUsd ?? null,
            changePct24h: report.snapshot?.priceChangePct.h24 ?? null,
            volume24h: report.snapshot?.volume.h24 ?? null,
            setupScore: report.setupScore?.score ?? null,
            riskScore: report.risk?.score ?? null,
            structure: report.structure.label,
            derivedStatus: deriveStatus(report),
            dataNotes: report.dataNotes,
          };
        } catch (error) {
          return {
            item,
            status: 'unavailable' as const,
            reason: error instanceof Error ? error.message : 'Analysis failed.',
          };
        }
      }),
    );
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

/** Maps the computed report onto the five watchlist states. */
function deriveStatus(report: Awaited<ReturnType<typeof analyseAsset>>): WatchlistItem['status'] {
  if (report.candles.length === 0) return 'NO TRADE';
  if (report.detections.length > 0 && report.plan.available) return 'ENTRY CONDITIONS MET';
  if (report.structure.label === 'failed-breakout' || report.structure.label === 'breakdown') {
    return 'INVALIDATED';
  }
  if (
    report.structure.label === 'consolidation' ||
    report.structure.label === 'higher-highs-higher-lows' ||
    report.structure.label === 'breakout'
  ) {
    return 'SETUP FORMING';
  }
  return 'WATCH';
}

const addSchema = z.object({
  assetId: assetIdSchema,
  symbol: z.string().min(1).max(40),
  assetClass: z.enum(['meme', 'crypto', 'stock']),
  chain: z.string().max(40).nullable().optional(),
  pairAddress: z.string().max(120).nullable().optional(),
  timeframe: timeframeSchema,
  note: z.string().max(1000).nullable().optional(),
});

watchlistRouter.post('/', (req, res, next) => {
  try {
    const body = parse(addSchema, req.body, 'watchlist entry');
    const db = getDb();
    const row = db
      .insert(watchlists)
      .values({
        assetId: body.assetId,
        symbol: body.symbol,
        assetClass: body.assetClass,
        chain: body.chain ?? null,
        pairAddress: body.pairAddress ?? null,
        timeframe: body.timeframe,
        status: 'WATCH',
        note: body.note ?? null,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: watchlists.assetId,
        set: { timeframe: body.timeframe, note: body.note ?? null, symbol: body.symbol },
      })
      .returning()
      .get();
    res.status(201).json(toItem(row));
  } catch (error) {
    next(error);
  }
});

watchlistRouter.patch('/:id', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'watchlist id');
    const body = parse(
      z.object({
        status: z.enum(STATUSES).optional(),
        note: z.string().max(1000).nullable().optional(),
        timeframe: timeframeSchema.optional(),
      }),
      req.body,
      'watchlist update',
    );
    const db = getDb();
    const row = db
      .update(watchlists)
      .set({
        ...(body.status ? { status: body.status } : {}),
        ...(body.timeframe ? { timeframe: body.timeframe } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(watchlists.id, id))
      .returning()
      .get();
    if (!row) throw new NotFoundError(`No watchlist entry with id ${id}.`);
    res.json(toItem(row));
  } catch (error) {
    next(error);
  }
});

watchlistRouter.delete('/:id', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'watchlist id');
    const db = getDb();
    const row = db.delete(watchlists).where(eq(watchlists.id, id)).returning().get();
    if (!row) throw new NotFoundError(`No watchlist entry with id ${id}.`);
    res.json({ deleted: id });
  } catch (error) {
    next(error);
  }
});
