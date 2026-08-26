import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import type { AlertRule } from '../../shared/types.js';
import { relativeVolume } from '../../engine/indicators.js';
import { getDb } from '../db/index.js';
import { alerts } from '../db/schema.js';
import { NotFoundError } from '../lib/errors.js';
import { assetIdSchema, parse, timeframeSchema } from '../lib/validate.js';
import { analyseAsset } from '../services/analysis.js';

export const alertsRouter: Router = Router();

const KINDS = [
  'breakout',
  'retest',
  'volume-spike',
  'setup-score',
  'risk-warning',
  'price-level',
  'invalidation',
] as const;

function toRule(row: typeof alerts.$inferSelect): AlertRule {
  return {
    id: row.id,
    assetId: row.assetId,
    symbol: row.symbol,
    kind: row.kind as AlertRule['kind'],
    threshold: row.threshold,
    direction: row.direction as AlertRule['direction'],
    timeframe: row.timeframe as AlertRule['timeframe'],
    enabled: row.enabled,
    createdAt: row.createdAt,
    lastFiredAt: row.lastFiredAt,
    lastMessage: row.lastMessage,
  };
}

alertsRouter.get('/', (_req, res, next) => {
  try {
    const db = getDb();
    res.json({
      alerts: db.select().from(alerts).orderBy(desc(alerts.createdAt)).all().map(toRule),
      note: 'Alerts are local notifications only. This application never places, signs or executes a trade.',
    });
  } catch (error) {
    next(error);
  }
});

const createSchema = z.object({
  assetId: assetIdSchema,
  symbol: z.string().min(1).max(40),
  kind: z.enum(KINDS),
  threshold: z.number().finite().nullable().optional(),
  direction: z.enum(['above', 'below']).nullable().optional(),
  timeframe: timeframeSchema,
});

alertsRouter.post('/', (req, res, next) => {
  try {
    const body = parse(createSchema, req.body, 'alert');
    const db = getDb();
    const row = db
      .insert(alerts)
      .values({
        assetId: body.assetId,
        symbol: body.symbol,
        kind: body.kind,
        threshold: body.threshold ?? null,
        direction: body.direction ?? null,
        timeframe: body.timeframe,
        enabled: 1,
        createdAt: Date.now(),
        lastFiredAt: null,
        lastMessage: null,
      })
      .returning()
      .get();
    res.status(201).json(toRule(row));
  } catch (error) {
    next(error);
  }
});

alertsRouter.patch('/:id', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'alert id');
    const body = parse(z.object({ enabled: z.boolean() }), req.body, 'alert update');
    const db = getDb();
    const row = db
      .update(alerts)
      .set({ enabled: body.enabled ? 1 : 0 })
      .where(eq(alerts.id, id))
      .returning()
      .get();
    if (!row) throw new NotFoundError(`No alert with id ${id}.`);
    res.json(toRule(row));
  } catch (error) {
    next(error);
  }
});

alertsRouter.delete('/:id', (req, res, next) => {
  try {
    const id = parse(z.coerce.number().int().positive(), req.params.id, 'alert id');
    const db = getDb();
    const row = db.delete(alerts).where(eq(alerts.id, id)).returning().get();
    if (!row) throw new NotFoundError(`No alert with id ${id}.`);
    res.json({ deleted: id });
  } catch (error) {
    next(error);
  }
});

/**
 * Evaluates every enabled rule against current data. The client polls this; there
 * is no background job, so nothing runs when the app is closed - and, by
 * construction, nothing here can place an order.
 */
alertsRouter.post('/check', async (_req, res, next) => {
  try {
    const db = getDb();
    const rules = db.select().from(alerts).where(eq(alerts.enabled, 1)).all().map(toRule);
    const triggered: { rule: AlertRule; message: string; at: number }[] = [];
    const skipped: { rule: AlertRule; reason: string }[] = [];

    // Group by asset+timeframe so one analysis serves every rule on that market.
    const groups = new Map<string, AlertRule[]>();
    for (const rule of rules) {
      const key = `${rule.assetId}|${rule.timeframe}`;
      const list = groups.get(key);
      if (list) list.push(rule);
      else groups.set(key, [rule]);
    }

    for (const [key, groupRules] of groups) {
      const [assetId, timeframe] = key.split('|');
      if (!assetId || !timeframe) continue;
      let report: Awaited<ReturnType<typeof analyseAsset>>;
      try {
        report = await analyseAsset({
          assetId,
          timeframe: timeframe as AlertRule['timeframe'],
          includeMtf: false,
          candleLimit: 200,
        });
      } catch (error) {
        for (const rule of groupRules) {
          skipped.push({
            rule,
            reason: error instanceof Error ? error.message : 'Analysis failed.',
          });
        }
        continue;
      }

      for (const rule of groupRules) {
        const evaluation = evaluateRule(rule, report);
        if (evaluation.status === 'skipped') {
          skipped.push({ rule, reason: evaluation.reason });
          continue;
        }
        if (!evaluation.fired) continue;
        const at = Date.now();
        db.update(alerts)
          .set({ lastFiredAt: at, lastMessage: evaluation.message })
          .where(eq(alerts.id, rule.id))
          .run();
        triggered.push({ rule, message: evaluation.message, at });
      }
    }

    res.json({ triggered, skipped, checked: rules.length, at: Date.now() });
  } catch (error) {
    next(error);
  }
});

type Evaluation =
  | { status: 'evaluated'; fired: boolean; message: string }
  | { status: 'skipped'; reason: string };

function evaluateRule(rule: AlertRule, report: Awaited<ReturnType<typeof analyseAsset>>): Evaluation {
  const price = report.snapshot?.priceUsd ?? report.candles[report.candles.length - 1]?.close ?? null;

  switch (rule.kind) {
    case 'price-level': {
      if (rule.threshold === null || rule.direction === null) {
        return { status: 'skipped', reason: 'Price-level alerts need a threshold and a direction.' };
      }
      if (price === null) return { status: 'skipped', reason: 'No current price available.' };
      const fired = rule.direction === 'above' ? price >= rule.threshold : price <= rule.threshold;
      return {
        status: 'evaluated',
        fired,
        message: `${rule.symbol} is ${price.toPrecision(6)}, ${rule.direction} the ${rule.threshold.toPrecision(6)} level you set.`,
      };
    }
    case 'breakout': {
      if (report.candles.length === 0) return { status: 'skipped', reason: 'No chart data.' };
      const fired = report.structure.label === 'breakout';
      return {
        status: 'evaluated',
        fired,
        message: `${rule.symbol} (${rule.timeframe}) has closed above its prior swing high.`,
      };
    }
    case 'retest': {
      const fired = report.detections.some((d) =>
        d.annotations.some((a) => a.kind === 'retest'),
      );
      return {
        status: 'evaluated',
        fired,
        message: `${rule.symbol} (${rule.timeframe}) is showing a retest of a broken level.`,
      };
    }
    case 'volume-spike': {
      const relVol = relativeVolume(report.candles, 20);
      if (relVol === null) {
        return { status: 'skipped', reason: 'Volume data unavailable for this market.' };
      }
      const threshold = rule.threshold ?? 2;
      return {
        status: 'evaluated',
        fired: relVol >= threshold,
        message: `${rule.symbol} (${rule.timeframe}) is trading at ${relVol.toFixed(2)}x its 20-bar average volume.`,
      };
    }
    case 'setup-score': {
      if (!report.setupScore) {
        return { status: 'skipped', reason: 'No setup is currently detected, so there is no score.' };
      }
      const threshold = rule.threshold ?? 70;
      return {
        status: 'evaluated',
        fired: report.setupScore.score >= threshold,
        message: `${rule.symbol} (${rule.timeframe}) setup score is ${report.setupScore.score}/100, at or above your ${threshold} threshold.`,
      };
    }
    case 'risk-warning': {
      if (!report.risk) return { status: 'skipped', reason: 'Risk could not be assessed.' };
      const threshold = rule.threshold ?? 70;
      return {
        status: 'evaluated',
        fired: report.risk.score >= threshold,
        message: `${rule.symbol} risk score is ${report.risk.score}/100 (${report.risk.band}). ${report.risk.warnings[0] ?? ''}`.trim(),
      };
    }
    case 'invalidation': {
      const fired =
        report.structure.label === 'failed-breakout' || report.structure.label === 'breakdown';
      return {
        status: 'evaluated',
        fired,
        message: `${rule.symbol} (${rule.timeframe}) structure is now ${report.structure.label} - setups in the opposite direction are invalidated.`,
      };
    }
    default:
      return { status: 'skipped', reason: 'Unknown alert kind.' };
  }
}
