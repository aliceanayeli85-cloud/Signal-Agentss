import { Router } from 'express';
import * as z from 'zod/v4';
import { assessFomo } from '../../engine/discipline.js';
import { calculatePositionSize } from '../../engine/position-size.js';
import { TRADING_LOCKED_MESSAGE } from '../../engine/discipline.js';
import { RiskLimitError } from '../lib/errors.js';
import {
  assetIdSchema,
  directionSchema,
  nonNegativeFinite,
  parse,
  positiveFinite,
  timeframeSchema,
} from '../lib/validate.js';
import { analyseAsset } from '../services/analysis.js';
import {
  cancelTrade,
  closeTrade,
  currentLimits,
  getTrade,
  listTrades,
  openTrade,
  readSettings,
  recentTrades,
} from '../services/trades.js';
import { getSnapshot } from '../providers/registry.js';
import { unrealisedPnl, rMultiple } from '../../engine/position-size.js';

export const tradingRouter: Router = Router();

const sizingSchema = z.object({
  accountSize: positiveFinite,
  riskPct: positiveFinite,
  entry: positiveFinite,
  stop: positiveFinite,
  target: positiveFinite.nullable().optional(),
  direction: directionSchema.optional(),
  highVolatility: z.boolean().optional(),
});

tradingRouter.post('/position-size', (req, res, next) => {
  try {
    const body = parse(sizingSchema, req.body, 'position size request');
    const settings = readSettings();
    res.json(
      calculatePositionSize({
        ...body,
        target: body.target ?? null,
        maxRiskPct: settings.maxRiskPctPerTrade,
      }),
    );
  } catch (error) {
    next(error);
  }
});

tradingRouter.get('/limits', (_req, res, next) => {
  try {
    const limits = currentLimits();
    res.json({
      ...limits,
      message: limits.locked ? TRADING_LOCKED_MESSAGE : null,
      settings: readSettings(),
    });
  } catch (error) {
    next(error);
  }
});

const preflightSchema = z.object({
  assetId: assetIdSchema,
  timeframe: timeframeSchema,
  riskPct: positiveFinite,
});

/**
 * Runs the discipline checks BEFORE a paper trade is submitted: the FOMO
 * detector and the daily limits. The UI requires the user to acknowledge any
 * flag raised here before the entry is accepted.
 */
tradingRouter.post('/preflight', async (req, res, next) => {
  try {
    const body = parse(preflightSchema, req.body, 'preflight request');
    const settings = readSettings();
    const report = await analyseAsset({ ...body, includeMtf: false });
    const detection = report.detections[0] ?? null;

    const recentMovePct =
      report.snapshot?.priceChangePct.h1 ?? report.snapshot?.priceChangePct.h24 ?? null;

    const fomo = assessFomo({
      recentMovePct,
      recentTrades: recentTrades(20),
      detection,
      riskPct: body.riskPct,
      baselineRiskPct: settings.defaultRiskPct,
      assetId: body.assetId,
    });

    const limits = currentLimits();

    res.json({
      fomo,
      limits: { ...limits, message: limits.locked ? TRADING_LOCKED_MESSAGE : null },
      detection,
      plan: report.plan,
      setupScore: report.setupScore,
      risk: report.risk,
      requiresConfirmation: fomo.triggered,
      blocked: limits.locked,
    });
  } catch (error) {
    next(error);
  }
});

const openSchema = z.object({
  assetId: assetIdSchema,
  symbol: z.string().min(1).max(40),
  assetClass: z.enum(['meme', 'crypto', 'stock']),
  timeframe: timeframeSchema,
  strategy: z.string().max(60).nullable().optional(),
  direction: directionSchema,
  entry: positiveFinite,
  stop: positiveFinite,
  tp1: positiveFinite.nullable().optional(),
  tp2: positiveFinite.nullable().optional(),
  tp3: positiveFinite.nullable().optional(),
  positionSize: positiveFinite,
  accountSize: positiveFinite.nullable().optional(),
  riskPct: nonNegativeFinite.nullable().optional(),
  riskAmount: nonNegativeFinite.nullable().optional(),
  setupScore: z.number().int().min(0).max(100).nullable().optional(),
  riskScore: z.number().int().min(0).max(100).nullable().optional(),
  marketConditions: z.string().max(2000).nullable().optional(),
  /** Set by the UI when the user chose to proceed past a FOMO warning. */
  fomoAcknowledged: z.boolean().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

tradingRouter.post('/paper-trades', (req, res, next) => {
  try {
    const body = parse(openSchema, req.body, 'paper trade');
    const limits = currentLimits();
    if (limits.locked) {
      throw new RiskLimitError(TRADING_LOCKED_MESSAGE, limits.reasons);
    }
    const trade = openTrade({
      assetId: body.assetId,
      symbol: body.symbol,
      assetClass: body.assetClass,
      timeframe: body.timeframe,
      strategy: body.strategy ?? null,
      direction: body.direction,
      entry: body.entry,
      stop: body.stop,
      tp1: body.tp1 ?? null,
      tp2: body.tp2 ?? null,
      tp3: body.tp3 ?? null,
      positionSize: body.positionSize,
      accountSize: body.accountSize ?? null,
      riskPct: body.riskPct ?? null,
      riskAmount: body.riskAmount ?? null,
      setupScore: body.setupScore ?? null,
      riskScore: body.riskScore ?? null,
      marketConditions: body.marketConditions ?? null,
      fomoFlagged: body.fomoAcknowledged === true,
      notes: body.notes ?? null,
    });
    res.status(201).json(trade);
  } catch (error) {
    next(error);
  }
});

tradingRouter.get('/paper-trades', (req, res, next) => {
  try {
    const status = req.query.status;
    const parsed =
      status === undefined
        ? undefined
        : parse(z.enum(['open', 'closed', 'cancelled']), status, 'status');
    res.json({ trades: listTrades(parsed) });
  } catch (error) {
    next(error);
  }
});

/**
 * Open positions marked to the latest available price. Where a live price cannot
 * be fetched the position is returned with `priceStatus: "unavailable"` rather
 * than a stale or assumed mark.
 */
tradingRouter.get('/paper-trades/live', async (_req, res, next) => {
  try {
    const open = listTrades('open');
    const marked = await Promise.all(
      open.map(async (trade) => {
        const snapshot = await getSnapshot(trade.assetId);
        if (snapshot.status !== 'ok' || snapshot.data.priceUsd === null) {
          return {
            trade,
            priceStatus: 'unavailable' as const,
            reason: snapshot.status === 'unavailable' ? snapshot.reason : 'Provider returned no price.',
            currentPrice: null,
            unrealisedPnl: null,
            unrealisedR: null,
            fetchedAt: Date.now(),
          };
        }
        const price = snapshot.data.priceUsd;
        return {
          trade,
          priceStatus: 'ok' as const,
          currentPrice: price,
          unrealisedPnl: unrealisedPnl(trade.direction, trade.entry, price, trade.positionSize),
          unrealisedR: rMultiple(trade.direction, trade.entry, trade.stop, price),
          fetchedAt: snapshot.fetchedAt,
        };
      }),
    );
    res.json({ positions: marked });
  } catch (error) {
    next(error);
  }
});

tradingRouter.get('/paper-trades/:id', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'trade id');
    res.json(getTrade(id));
  } catch (error) {
    next(error);
  }
});

tradingRouter.post('/paper-trades/:id/close', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'trade id');
    const body = parse(
      z.object({ exitPrice: positiveFinite, exitReason: z.string().min(1).max(300) }),
      req.body,
      'close request',
    );
    res.json(closeTrade(id, body.exitPrice, body.exitReason));
  } catch (error) {
    next(error);
  }
});

tradingRouter.post('/paper-trades/:id/cancel', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'trade id');
    const body = parse(
      z.object({ reason: z.string().min(1).max(300) }),
      req.body,
      'cancel request',
    );
    res.json(cancelTrade(id, body.reason));
  } catch (error) {
    next(error);
  }
});
