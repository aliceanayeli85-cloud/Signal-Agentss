import { Router } from 'express';
import * as z from 'zod/v4';
import type { Candle, Timeframe } from '../../shared/types.js';
import { EXPLANATIONS } from '../../shared/education.js';
import { DEFAULT_SETTINGS } from '../../engine/discipline.js';
import { relativeVolume, vwap } from '../../engine/indicators.js';
import { assetIdSchema, parse, positiveFinite, timeframeSchema } from '../lib/validate.js';
import { getCandles } from '../providers/registry.js';
import { analyseAsset } from '../services/analysis.js';
import { readSettings, writeSettings } from '../services/trades.js';

export const deskRouter: Router = Router();

deskRouter.get('/education', (_req, res) => {
  res.json({ explanations: EXPLANATIONS });
});

deskRouter.get('/settings', (_req, res, next) => {
  try {
    res.json({ settings: readSettings(), defaults: DEFAULT_SETTINGS });
  } catch (error) {
    next(error);
  }
});

const settingsSchema = z.object({
  accountSize: positiveFinite,
  defaultRiskPct: z.number().min(0.01).max(10),
  maxRiskPctPerTrade: z.number().min(0.01).max(10),
  maxTradesPerDay: z.number().int().min(1).max(100),
  maxDailyLossPct: z.number().min(0.1).max(100),
  maxConsecutiveLosses: z.number().int().min(1).max(50),
  /** 1 lifts the daily-limit lock. Simulation only; nothing here touches real money. */
  simulationOverride: z.union([z.literal(0), z.literal(1)]),
});

deskRouter.put('/settings', (req, res, next) => {
  try {
    const body = parse(settingsSchema, req.body, 'settings');
    const warnings: string[] = [];
    if (body.defaultRiskPct > 2) {
      warnings.push(
        `A default risk of ${body.defaultRiskPct}% per trade is above the 2% ceiling this app recommends. Three losses in a row costs ${(body.defaultRiskPct * 3).toFixed(1)}% of the account.`,
      );
    }
    if (body.simulationOverride === 1) {
      warnings.push(
        'Simulation override is ON: daily loss limits will not lock paper trading. This is recorded on every trade taken while it is active.',
      );
    }
    res.json({ settings: writeSettings(body), warnings });
  } catch (error) {
    next(error);
  }
});

/**
 * DAY TRADING levels.
 *
 * Everything here is derived from bars that were actually returned. Where a
 * provider gives no extended-hours data the premarket fields report unavailable
 * rather than reusing the regular-session open.
 */
deskRouter.get('/daytrade/levels', async (req, res, next) => {
  try {
    const assetId = parse(assetIdSchema, req.query.assetId, 'assetId');
    const timeframe = parse(timeframeSchema, req.query.timeframe ?? '5m', 'timeframe');

    const [intradayResult, dailyResult] = await Promise.all([
      getCandles(assetId, timeframe, 400),
      getCandles(assetId, '1d', 30),
    ]);

    const notes: string[] = [];
    if (intradayResult.status === 'unavailable') {
      notes.push(`Intraday data unavailable: ${intradayResult.reason}`);
    }
    if (dailyResult.status === 'unavailable') {
      notes.push(`Daily data unavailable: ${dailyResult.reason}`);
    }

    const intraday = intradayResult.status === 'ok' ? intradayResult.data : [];
    const daily = dailyResult.status === 'ok' ? dailyResult.data : [];

    const previousDay = daily.length >= 2 ? daily[daily.length - 2] : null;
    const today = daily.length >= 1 ? daily[daily.length - 1] : null;
    const session = sessionBars(intraday);

    const sessionVwap = vwap(session);
    if (sessionVwap === null && session.length > 0) {
      notes.push('VWAP unavailable: this data source returned no volume for the session bars.');
    }

    const relVol = relativeVolume(intraday, 20);
    if (relVol === null) {
      notes.push('Relative volume unavailable: volume data was missing or too sparse.');
    }

    const analysis =
      intraday.length > 0
        ? await analyseAsset({ assetId, timeframe, includeMtf: false, candleLimit: 300 })
        : null;

    res.json({
      assetId,
      timeframe,
      previousDayHigh: previousDay?.high ?? null,
      previousDayLow: previousDay?.low ?? null,
      previousDayClose: previousDay?.close ?? null,
      openPrice: today?.open ?? session[0]?.open ?? null,
      sessionHigh: session.length > 0 ? Math.max(...session.map((c) => c.high)) : null,
      sessionLow: session.length > 0 ? Math.min(...session.map((c) => c.low)) : null,
      vwap: sessionVwap,
      relativeVolume: relVol,
      sessionVolume: sumVolume(session),
      // Premarket requires a data source that separates extended hours. None of
      // the currently connected providers does, so it is reported, not guessed.
      premarketHigh: null,
      premarketLow: null,
      premarketNote:
        'Premarket levels require an equities feed that separates extended-hours bars. No connected provider supplies that, so premarket high/low are unavailable.',
      structure: analysis?.structure.label ?? null,
      levels: analysis?.structure.levels.slice(0, 8) ?? [],
      detections: analysis?.detections ?? [],
      setupScore: analysis?.setupScore ?? null,
      plan: analysis?.plan ?? null,
      notes,
      sources: { intraday: intradayResult.source, daily: dailyResult.source },
      fetchedAt: Date.now(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * SWING setup: analysed on the 1D/4H/1H ladder, with a holding-time ESTIMATE
 * derived from how long the backtestable move typically takes - explicitly not a
 * guarantee.
 */
deskRouter.get('/swing/setup', async (req, res, next) => {
  try {
    const assetId = parse(assetIdSchema, req.query.assetId, 'assetId');
    const timeframe = parse(
      z.enum(['1d', '4h', '1h'] as const),
      req.query.timeframe ?? '4h',
      'timeframe',
    );

    const report = await analyseAsset({ assetId, timeframe: timeframe as Timeframe, includeMtf: true });
    const holdingEstimate = estimateHoldingTime(report, timeframe as Timeframe);

    res.json({
      report,
      holdingEstimate,
      note: 'The holding-time estimate is arithmetic: distance to target divided by average movement per bar. It is not a guarantee, and a setup can invalidate long before it gets there.',
    });
  } catch (error) {
    next(error);
  }
});

function estimateHoldingTime(
  report: Awaited<ReturnType<typeof analyseAsset>>,
  timeframe: Timeframe,
): { bars: number | null; description: string } {
  const atrValue = report.indicators.atr14;
  if (!report.plan.available || atrValue === null || atrValue <= 0) {
    return {
      bars: null,
      description: 'No holding-time estimate: it needs both a valid trade plan and an ATR value.',
    };
  }
  const distance = Math.abs(report.plan.targets.tp1 - report.plan.entry);
  const bars = Math.ceil(distance / atrValue);
  const minutesPerBar: Record<Timeframe, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
  };
  const totalMinutes = bars * minutesPerBar[timeframe];
  const description =
    totalMinutes >= 1440
      ? `Roughly ${bars} bars, about ${(totalMinutes / 1440).toFixed(1)} days at ${timeframe}, if price advances at its average rate and never pulls back.`
      : `Roughly ${bars} bars, about ${(totalMinutes / 60).toFixed(1)} hours at ${timeframe}, if price advances at its average rate and never pulls back.`;
  return { bars, description };
}

/** Bars belonging to the most recent 24 hours of the series. */
function sessionBars(candles: Candle[]): Candle[] {
  const last = candles[candles.length - 1];
  if (!last) return [];
  const cutoff = last.time - 86_400;
  return candles.filter((c) => c.time >= cutoff);
}

function sumVolume(candles: Candle[]): number | null {
  const volumes = candles.map((c) => c.volume).filter((v): v is number => v !== null);
  if (volumes.length === 0) return null;
  return volumes.reduce((a, b) => a + b, 0);
}
