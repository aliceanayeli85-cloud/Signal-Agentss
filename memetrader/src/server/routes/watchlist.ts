import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { WatchlistItem } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { watchlists } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { assetIdSchema, parse, timeframeSchema } from '../lib/validate.js';
import { analyseAsset } from '../services/analysis.js';
import { buildTokenReport } from '../services/token-report.js';
import { analyseWithAi } from '../services/ai.js';
import { computeHistoricalStats } from '../../engine/stats.js';
import { listTrades } from '../services/trades.js';
import { MY_MEME_COINS } from '../db/seed-watchlist.js';

export const watchlistRouter: Router = Router();

const STATUSES = ['WATCH', 'SETUP FORMING', 'ENTRY CONDITIONS MET', 'INVALIDATED', 'NO TRADE'] as const;

function toItem(row: typeof watchlists.$inferSelect): WatchlistItem {
  return {
    id: row.id,
    assetId: row.assetId,
    symbol: row.symbol,
    name: row.name,
    tokenAddress: row.tokenAddress,
    listName: row.listName,
    pinned: row.pinned,
    assetClass: row.assetClass as WatchlistItem['assetClass'],
    chain: row.chain,
    pairAddress: row.pairAddress,
    timeframe: row.timeframe as WatchlistItem['timeframe'],
    status: row.status as WatchlistItem['status'],
    note: row.note,
    createdAt: row.createdAt,
  };
}

watchlistRouter.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const list = typeof req.query.list === 'string' ? req.query.list : null;
    const rows = list
      ? db.select().from(watchlists).where(eq(watchlists.listName, list)).orderBy(desc(watchlists.createdAt)).all()
      : db.select().from(watchlists).orderBy(desc(watchlists.createdAt)).all();
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
    // Token-identified rows have their own richer endpoint; this one covers the
    // pair-identified rows the scanner adds.
    const rows = db
      .select()
      .from(watchlists)
      .where(and(sql`${watchlists.tokenAddress} IS NULL`, sql`${watchlists.assetId} <> ''`))
      .orderBy(desc(watchlists.createdAt))
      .all();
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
        tokenAddress: null,
        listName: 'Default',
        timeframe: body.timeframe,
        status: 'WATCH',
        note: body.note ?? null,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [watchlists.listName, watchlists.assetId],
        targetWhere: sql`token_address IS NULL`,
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

/**
 * The token watchlist: contract-address-identified rows with a full report each.
 *
 * Reports are built sequentially rather than in parallel. GeckoTerminal allows
 * roughly 30 requests a minute and one report costs several, so a parallel fan
 * out across the whole list would rate-limit itself and return errors for the
 * later tokens - which would look exactly like the tokens being broken.
 */
watchlistRouter.get('/tokens', async (req, res, next) => {
  try {
    const list = typeof req.query.list === 'string' ? req.query.list : MY_MEME_COINS;
    const timeframe = parse(timeframeSchema, req.query.timeframe ?? '15m', 'timeframe');
    const includeMomentumLadder = req.query.ladder !== 'false';

    const db = getDb();
    const rows = db
      .select()
      .from(watchlists)
      .where(and(eq(watchlists.listName, list), sql`${watchlists.tokenAddress} IS NOT NULL`))
      .orderBy(watchlists.createdAt)
      .all();

    const reports = [];
    for (const row of rows) {
      const tokenAddress = row.tokenAddress as string;
      try {
        reports.push({
          watchlistId: row.id,
          report: await buildTokenReport({
            chain: row.chain ?? 'solana',
            tokenAddress,
            timeframe,
            includeMomentumLadder,
          }),
        });
      } catch (error) {
        reports.push({
          watchlistId: row.id,
          report: null,
          error: error instanceof Error ? error.message : 'Report failed.',
          requestedAddress: tokenAddress,
        });
      }
    }

    res.json({ list, timeframe, count: rows.length, tokens: reports, fetchedAt: Date.now() });
  } catch (error) {
    next(error);
  }
});

/** One token's full report, for the detail page. */
watchlistRouter.get('/tokens/:address', async (req, res, next) => {
  try {
    const address = parse(
      z.string().min(20).max(120).regex(/^[A-Za-z0-9]+$/, 'Not a valid contract address.'),
      req.params.address,
      'token address',
    );
    const timeframe = parse(timeframeSchema, req.query.timeframe ?? '15m', 'timeframe');
    const chain = typeof req.query.chain === 'string' ? req.query.chain : 'solana';
    res.json(await buildTokenReport({ chain, tokenAddress: address, timeframe, includeFineGrained: true }));
  } catch (error) {
    next(error);
  }
});

/** Adds a token by CONTRACT address to a named list. */
watchlistRouter.post('/tokens', async (req, res, next) => {
  try {
    const body = parse(
      z.object({
        address: z.string().min(20).max(120).regex(/^[A-Za-z0-9]+$/),
        chain: z.string().min(2).max(40).default('solana'),
        list: z.string().min(1).max(60).default(MY_MEME_COINS),
        timeframe: timeframeSchema.default('15m'),
      }),
      req.body,
      'token watchlist entry',
    );

    // Resolve before storing, so a typo is rejected instead of becoming a
    // permanently broken row.
    const report = await buildTokenReport({
      chain: body.chain,
      tokenAddress: body.address,
      timeframe: body.timeframe,
      includeMomentumLadder: false,
    });
    if (!report.resolved) {
      throw new ValidationError(report.unavailableReason ?? 'That address could not be resolved.');
    }

    const db = getDb();
    const row = db
      .insert(watchlists)
      .values({
        assetId: report.assetId ?? '',
        symbol: report.snapshot?.symbol ?? body.address,
        name: report.snapshot?.name ?? null,
        assetClass: 'meme',
        chain: body.chain,
        pairAddress: report.pairAddress,
        tokenAddress: body.address,
        listName: body.list,
        pinned: 0,
        timeframe: body.timeframe,
        status: 'WATCH',
        note: null,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [watchlists.listName, watchlists.tokenAddress],
        targetWhere: sql`token_address IS NOT NULL`,
        set: { timeframe: body.timeframe, assetId: report.assetId ?? '' },
      })
      .returning()
      .get();

    res.status(201).json({ item: toItem(row), report });
  } catch (error) {
    next(error);
  }
});

/**
 * AI explanation for one token, with the app's own historical evidence attached.
 *
 * The matching statistics are computed HERE, from recorded paper trades, and
 * passed to the model as facts. The model is never asked to produce a win rate,
 * and none is published unless the sample clears the minimum.
 */
watchlistRouter.post('/tokens/:address/ai', async (req, res, next) => {
  try {
    const address = parse(
      z.string().min(20).max(120).regex(/^[A-Za-z0-9]+$/),
      req.params.address,
      'token address',
    );
    const body = parse(
      z.object({ timeframe: timeframeSchema.default('15m'), chain: z.string().default('solana') }),
      req.body ?? {},
      'AI request',
    );

    const report = await buildTokenReport({
      chain: body.chain,
      tokenAddress: address,
      timeframe: body.timeframe,
      includeFineGrained: true,
    });

    const strategy = report.detections[0]?.strategy ?? null;
    const matching = listTrades('closed').filter(
      (trade) =>
        trade.rMultiple !== null &&
        trade.timeframe === report.timeframe &&
        (strategy === null || trade.strategy === strategy),
    );
    const evidence = computeHistoricalStats({
      rMultiples: matching.map((t) => t.rMultiple as number),
      ruleSetLabel: `${strategy ?? 'any strategy'} / ${report.timeframe}`,
    });

    res.json(await analyseWithAi(report, evidence));
  } catch (error) {
    next(error);
  }
});
