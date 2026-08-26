import type { AnalysisReport, MarketSnapshot } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import { assets, marketData, setups } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { sql } from 'drizzle-orm';

/**
 * Persists what the app observed, so that over time it accumulates its own
 * history rather than depending on a provider's retention. Recording is
 * best-effort: a write failure must never break the request that produced the
 * data, but it is logged rather than swallowed silently.
 */
export function recordSnapshot(snapshots: MarketSnapshot[]): void {
  if (snapshots.length === 0) return;
  try {
    const db = getDb();
    const now = Date.now();
    db.transaction((tx) => {
      for (const snapshot of snapshots) {
        tx.insert(assets)
          .values({
            id: snapshot.id,
            symbol: snapshot.symbol,
            name: snapshot.name,
            assetClass: snapshot.assetClass,
            provider: snapshot.provider,
            chain: snapshot.chain,
            pairAddress: snapshot.pairAddress,
            baseTokenAddress: snapshot.baseTokenAddress,
            url: snapshot.url,
            firstSeenAt: now,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: assets.id,
            set: { lastSeenAt: now, symbol: snapshot.symbol, name: snapshot.name },
          })
          .run();

        tx.insert(marketData)
          .values({
            assetId: snapshot.id,
            capturedAt: snapshot.fetchedAt,
            priceUsd: snapshot.priceUsd,
            liquidityUsd: snapshot.liquidityUsd,
            marketCapUsd: snapshot.marketCapUsd,
            fdvUsd: snapshot.fdvUsd,
            volume24h: snapshot.volume.h24 ?? null,
            volume1h: snapshot.volume.h1 ?? null,
            priceChange24h: snapshot.priceChangePct.h24 ?? null,
            priceChange1h: snapshot.priceChangePct.h1 ?? null,
            buys1h: snapshot.txns.h1?.buys ?? null,
            sells1h: snapshot.txns.h1?.sells ?? null,
            source: snapshot.provider,
            raw: null,
          })
          .run();
      }
    });
  } catch (error) {
    logger.warn('failed to record market snapshots', { error });
  }
}

/**
 * Records a detected setup with the scores that were live at detection time.
 * These rows are what the statistics engine later matches against, so writing
 * them at the moment of detection (rather than reconstructing them afterwards)
 * is what keeps those statistics free of hindsight.
 */
export function recordSetup(assetId: string, report: AnalysisReport): void {
  const detection = report.detections[0];
  if (!detection) return;
  try {
    const db = getDb();
    const symbol = report.snapshot?.symbol ?? assetId;
    // One row per strategy per trigger bar; re-analysing the same bar must not
    // inflate the sample the statistics engine reads.
    const existing = db
      .select({ id: setups.id })
      .from(setups)
      .where(
        sql`${setups.assetId} = ${assetId} AND ${setups.strategyId} = ${detection.strategy} AND ${setups.timeframe} = ${report.timeframe} AND ${setups.triggerTime} = ${detection.triggerTime}`,
      )
      .all();
    if (existing.length > 0) return;

    db.insert(setups)
      .values({
        assetId,
        symbol,
        strategyId: detection.strategy,
        timeframe: report.timeframe,
        direction: detection.direction,
        detectedAt: Date.now(),
        triggerTime: detection.triggerTime,
        entry: detection.entry,
        stop: detection.stop,
        invalidation: detection.invalidation,
        tp1: report.plan.available ? report.plan.targets.tp1 : null,
        tp2: report.plan.available ? report.plan.targets.tp2 : null,
        tp3: report.plan.available ? report.plan.targets.tp3 : null,
        setupScore: report.setupScore?.score ?? null,
        riskScore: report.risk?.score ?? null,
        alignment: report.alignment.alignment,
        structure: report.structure.label,
        reasons: JSON.stringify(report.setupScore?.reasons ?? []),
        warnings: JSON.stringify(report.setupScore?.warnings ?? []),
      })
      .run();
  } catch (error) {
    logger.warn('failed to record setup', { error, assetId });
  }
}
