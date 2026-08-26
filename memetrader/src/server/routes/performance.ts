import { Router } from 'express';
import * as z from 'zod/v4';
import { bestAndWorst, computePerformance } from '../../engine/performance.js';
import { computeHistoricalStats, MIN_OBSERVATIONS } from '../../engine/stats.js';
import { getDb } from '../db/index.js';
import { performance as performanceTable } from '../db/schema.js';
import { parse, timeframeSchema } from '../lib/validate.js';
import { listTrades } from '../services/trades.js';

export const performanceRouter: Router = Router();

performanceRouter.get('/', (_req, res, next) => {
  try {
    const trades = listTrades();
    const stats = computePerformance(trades);
    res.json({
      ...stats,
      bestStrategy: bestAndWorst(stats.byStrategy),
      bestTimeframe: bestAndWorst(stats.byTimeframe),
      openTrades: trades.filter((t) => t.status === 'open').length,
    });
  } catch (error) {
    next(error);
  }
});

/** Persists a point-in-time snapshot so improvement over months is visible. */
performanceRouter.post('/snapshot', (_req, res, next) => {
  try {
    const stats = computePerformance(listTrades());
    const db = getDb();
    const row = db
      .insert(performanceTable)
      .values({
        capturedAt: Date.now(),
        sampleSize: stats.sampleSize,
        winRatePct: stats.winRatePct,
        expectancyR: stats.expectancyR,
        profitFactor: stats.profitFactor,
        maxDrawdownR: stats.maxDrawdownR,
        totalPnl: stats.totalPnl,
        payload: JSON.stringify(stats),
      })
      .returning()
      .get();
    res.status(201).json({ id: row.id, capturedAt: row.capturedAt });
  } catch (error) {
    next(error);
  }
});

const statsQuery = z.object({
  strategy: z.string().max(60).optional(),
  timeframe: timeframeSchema.optional(),
  direction: z.enum(['long', 'short']).optional(),
});

/**
 * STATISTICAL PROBABILITY ENGINE endpoint.
 *
 * Matches recorded paper trades against a rule set and reports what those
 * observations did. Below the minimum sample the response says so explicitly and
 * publishes no win rate at all.
 */
performanceRouter.get('/stats', (req, res, next) => {
  try {
    const filters = parse(statsQuery, req.query, 'stats filters');
    const closed = listTrades('closed').filter((t) => t.rMultiple !== null);

    const matching = closed.filter((trade) => {
      if (filters.strategy && trade.strategy !== filters.strategy) return false;
      if (filters.timeframe && trade.timeframe !== filters.timeframe) return false;
      if (filters.direction && trade.direction !== filters.direction) return false;
      return true;
    });

    const parts = [
      filters.strategy ?? 'any strategy',
      filters.timeframe ?? 'any timeframe',
      filters.direction ?? 'either direction',
    ];

    res.json({
      ...computeHistoricalStats({
        rMultiples: matching.map((t) => t.rMultiple as number),
        ruleSetLabel: parts.join(' / '),
      }),
      minimumObservations: MIN_OBSERVATIONS,
      filters,
      source: 'closed paper trades recorded by this application',
    });
  } catch (error) {
    next(error);
  }
});
