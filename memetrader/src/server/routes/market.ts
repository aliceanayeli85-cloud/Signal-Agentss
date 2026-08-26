import { Router } from 'express';
import * as z from 'zod/v4';
import { analyseAsset } from '../services/analysis.js';
import { analyseWithAi, AI_UNAVAILABLE_REASON, aiConfigured } from '../services/ai.js';
import { assetIdSchema, parse, timeframeSchema } from '../lib/validate.js';
import { getCandles, providerStatuses, scan, search } from '../providers/registry.js';
import { recordSnapshot, recordSetup } from '../services/recorder.js';
import type { ScannerTab } from '../providers/types.js';

const scannerTabs = [
  'meme',
  'crypto',
  'stocks',
  'new-pairs',
  'top-momentum',
  'unusual-volume',
  'potential-breakouts',
] as const satisfies readonly ScannerTab[];

export const marketRouter: Router = Router();

marketRouter.get('/providers', (_req, res) => {
  res.json({ providers: providerStatuses() });
});

marketRouter.get('/scan', async (req, res, next) => {
  try {
    const tab = parse(z.enum(scannerTabs), req.query.tab ?? 'meme', 'tab');
    const result = await scan(tab);
    // Snapshots are persisted so the app builds its own history over time.
    recordSnapshot(result.results);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/search', async (req, res, next) => {
  try {
    const query = parse(z.string().min(1).max(64), req.query.q, 'search query');
    const result = await search(query);
    recordSnapshot(result.results);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/candles', async (req, res, next) => {
  try {
    const assetId = parse(assetIdSchema, req.query.assetId, 'assetId');
    const timeframe = parse(timeframeSchema, req.query.timeframe ?? '15m', 'timeframe');
    const limit = parse(
      z.coerce.number().int().min(20).max(1000),
      req.query.limit ?? 300,
      'limit',
    );
    const result = await getCandles(assetId, timeframe, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/analysis', async (req, res, next) => {
  try {
    const assetId = parse(assetIdSchema, req.query.assetId, 'assetId');
    const timeframe = parse(timeframeSchema, req.query.timeframe ?? '15m', 'timeframe');
    const includeMtf = req.query.mtf !== 'false';
    const report = await analyseAsset({ assetId, timeframe, includeMtf });
    if (report.snapshot) recordSnapshot([report.snapshot]);
    recordSetup(assetId, report);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

marketRouter.get('/ai/status', (_req, res) => {
  res.json({ configured: aiConfigured(), reason: aiConfigured() ? '' : AI_UNAVAILABLE_REASON });
});

marketRouter.post('/ai/analysis', async (req, res, next) => {
  try {
    const body = parse(
      z.object({ assetId: assetIdSchema, timeframe: timeframeSchema }),
      req.body,
      'AI analysis request',
    );
    const report = await analyseAsset({ ...body, includeMtf: true });
    const analysis = await analyseWithAi(report);
    res.json(analysis);
  } catch (error) {
    next(error);
  }
});
