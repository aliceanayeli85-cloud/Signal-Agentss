import { Router } from 'express';
import { desc } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { BacktestConfig, StrategyId } from '../../shared/types.js';
import { DEFAULT_BACKTEST_CONFIG, runBacktest } from '../../engine/backtest/engine.js';
import { STRATEGIES, STRATEGY_IDS } from '../../engine/setups/index.js';
import { getDb } from '../db/index.js';
import { backtests } from '../db/schema.js';
import { UpstreamError } from '../lib/errors.js';
import { assetIdSchema, parse, positiveFinite, timeframeSchema } from '../lib/validate.js';
import { getCandles, getSnapshot } from '../providers/registry.js';

export const backtestRouter: Router = Router();

backtestRouter.get('/strategies', (_req, res) => {
  res.json({
    strategies: STRATEGIES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      minBars: s.minBars,
    })),
    defaults: DEFAULT_BACKTEST_CONFIG,
  });
});

const configSchema = z.object({
  assetId: assetIdSchema,
  timeframe: timeframeSchema,
  strategies: z.array(z.enum(STRATEGY_IDS as [StrategyId, ...StrategyId[]])).min(1),
  stopRule: z.enum(['structure', 'atr']),
  atrMultiple: z.number().min(0.2).max(10),
  targetR: z.number().min(0.25).max(20),
  riskPct: z.number().min(0.01).max(10),
  accountSize: positiveFinite,
  feesPct: z.number().min(0).max(5),
  slippagePct: z.number().min(0).max(5),
  trainFraction: z.number().min(0.1).max(0.9),
  maxBarsInTrade: z.number().int().min(2).max(2000),
  bars: z.number().int().min(100).max(1000).optional(),
});

backtestRouter.post('/', async (req, res, next) => {
  try {
    const body = parse(configSchema, req.body, 'backtest configuration');
    const limit = body.bars ?? 1000;

    const [candleResult, snapshotResult] = await Promise.all([
      getCandles(body.assetId, body.timeframe, limit),
      getSnapshot(body.assetId),
    ]);

    if (candleResult.status === 'unavailable') {
      throw new UpstreamError(
        `Backtest cannot run: ${candleResult.reason}`,
        candleResult.source,
      );
    }

    const symbol = snapshotResult.status === 'ok' ? snapshotResult.data.symbol : body.assetId;
    const config: BacktestConfig = {
      assetId: body.assetId,
      symbol,
      timeframe: body.timeframe,
      strategies: body.strategies,
      stopRule: body.stopRule,
      atrMultiple: body.atrMultiple,
      targetR: body.targetR,
      riskPct: body.riskPct,
      accountSize: body.accountSize,
      feesPct: body.feesPct,
      slippagePct: body.slippagePct,
      trainFraction: body.trainFraction,
      maxBarsInTrade: body.maxBarsInTrade,
    };

    const result = runBacktest(candleResult.data, config);

    const db = getDb();
    db.insert(backtests)
      .values({
        createdAt: Date.now(),
        assetId: config.assetId,
        symbol: config.symbol,
        timeframe: config.timeframe,
        config: JSON.stringify(config),
        barsUsed: result.barsUsed,
        firstBarTime: result.firstBarTime,
        lastBarTime: result.lastBarTime,
        result: JSON.stringify(result),
        tradeCount: result.trades.length,
        oosTradeCount: result.outOfSample.trades,
      })
      .run();

    res.json({ ...result, candleSource: candleResult.source });
  } catch (error) {
    next(error);
  }
});

backtestRouter.get('/history', (_req, res, next) => {
  try {
    const db = getDb();
    const rows = db
      .select({
        id: backtests.id,
        createdAt: backtests.createdAt,
        symbol: backtests.symbol,
        assetId: backtests.assetId,
        timeframe: backtests.timeframe,
        barsUsed: backtests.barsUsed,
        tradeCount: backtests.tradeCount,
        oosTradeCount: backtests.oosTradeCount,
      })
      .from(backtests)
      .orderBy(desc(backtests.createdAt))
      .limit(50)
      .all();
    res.json({ backtests: rows });
  } catch (error) {
    next(error);
  }
});
