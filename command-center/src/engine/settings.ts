import { z } from 'zod';

/**
 * Every risk rule lives here. Defaults match a $100 starting account with a
 * $1 simulated risk per trade. Hard caps are enforced on top of whatever the
 * user configures, so a typo cannot turn into a 20% bet.
 */
export const RiskSettingsSchema = z.object({
  startingCapitalUsd: z.number().positive().max(1_000_000),
  riskPerTradeUsd: z.number().positive(),
  maxDailyLossUsd: z.number().positive(),
  maxOpenRiskUsd: z.number().positive(),
  maxPositionUsd: z.number().positive(),
  maxTradesPerDay: z.number().int().min(1).max(20),
  maxConsecutiveLosses: z.number().int().min(1).max(10),
  lossCooldownMinutes: z.number().int().min(0).max(24 * 60),
  minRewardRisk: z.number().min(1).max(10),
  allowFractional: z.boolean(),
  minOrderUsd: z.number().min(0),
  slippageBps: z.number().min(0).max(500),
  commissionPerOrderUsd: z.number().min(0),
  secFeePerMillion: z.number().min(0),
  tafPerShareUsd: z.number().min(0),
  tafMaxUsd: z.number().min(0),
  maxQuoteAgeSeconds: z.number().int().min(5).max(3600),
});

export type RiskSettings = z.infer<typeof RiskSettingsSchema>;

export const DEFAULT_SETTINGS: RiskSettings = {
  startingCapitalUsd: 100,
  riskPerTradeUsd: 1,
  maxDailyLossUsd: 3,
  maxOpenRiskUsd: 2,
  maxPositionUsd: 50,
  maxTradesPerDay: 3,
  maxConsecutiveLosses: 2,
  lossCooldownMinutes: 60,
  minRewardRisk: 1.5,
  allowFractional: true,
  // Robinhood's documented minimum for a dollar-based fractional order.
  minOrderUsd: 1,
  slippageBps: 5,
  // Robinhood charges no commission on stock and ETF trades.
  commissionPerOrderUsd: 0,
  // Regulatory pass-through fees on SELLS. These rates change; overestimating is the safe direction.
  secFeePerMillion: 27.8,
  tafPerShareUsd: 0.000166,
  tafMaxUsd: 8.3,
  maxQuoteAgeSeconds: 120,
};

/** Absolute ceilings, as a fraction of current equity. Not user-configurable. */
export const HARD_CAPS = {
  riskPerTradePct: 0.02,
  dailyLossPct: 0.05,
  /** Position value can never exceed equity: no borrowed money. */
  positionPct: 1,
};

/** The risk-per-trade actually used: the configured value, cut by the hard cap. */
export function effectiveRiskPerTrade(settings: RiskSettings, equity: number): number {
  return Math.max(0, Math.min(settings.riskPerTradeUsd, equity * HARD_CAPS.riskPerTradePct));
}

export function effectiveDailyLoss(settings: RiskSettings, equity: number): number {
  return Math.max(0, Math.min(settings.maxDailyLossUsd, equity * HARD_CAPS.dailyLossPct));
}

const RISK_INCREASING_KEYS = ['riskPerTradeUsd', 'maxDailyLossUsd', 'maxOpenRiskUsd', 'maxPositionUsd', 'maxTradesPerDay', 'maxConsecutiveLosses'] as const;

export interface SettingsChangeContext {
  equity: number;
  todayRealizedPnl: number;
  lastClosedTradeWasLoss: boolean;
}

/**
 * Rejects a settings change that would raise risk right after a loss (the
 * classic way small accounts blow up), or that exceeds a hard cap.
 */
export function validateSettingsChange(current: RiskSettings, next: RiskSettings, ctx: SettingsChangeContext): string[] {
  const errors: string[] = [];
  const raised = RISK_INCREASING_KEYS.filter((k) => next[k] > current[k]);
  const lowered = next.lossCooldownMinutes < current.lossCooldownMinutes || next.minRewardRisk < current.minRewardRisk;
  if ((raised.length || lowered) && (ctx.todayRealizedPnl < 0 || ctx.lastClosedTradeWasLoss)) {
    errors.push(
      `Risk cannot be increased after a loss (${[...raised, ...(lowered ? ['cooldown/reward-to-risk'] : [])].join(', ')}). Wait for the next trading day and a non-losing last trade.`,
    );
  }
  if (next.riskPerTradeUsd > ctx.equity * HARD_CAPS.riskPerTradePct) {
    errors.push(`Risk per trade cannot exceed ${HARD_CAPS.riskPerTradePct * 100}% of equity ($${(ctx.equity * HARD_CAPS.riskPerTradePct).toFixed(2)}).`);
  }
  if (next.maxDailyLossUsd > ctx.equity * HARD_CAPS.dailyLossPct) {
    errors.push(`Daily loss limit cannot exceed ${HARD_CAPS.dailyLossPct * 100}% of equity ($${(ctx.equity * HARD_CAPS.dailyLossPct).toFixed(2)}).`);
  }
  if (next.maxPositionUsd > ctx.equity * HARD_CAPS.positionPct) {
    errors.push(`A single position cannot be larger than your equity ($${ctx.equity.toFixed(2)}). No borrowed money.`);
  }
  if (next.maxOpenRiskUsd < next.riskPerTradeUsd) errors.push('Max open risk must be at least the risk per trade.');
  return errors;
}
