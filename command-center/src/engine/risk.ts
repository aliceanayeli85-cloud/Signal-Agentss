import { effectiveDailyLoss, effectiveRiskPerTrade, type RiskSettings } from './settings.js';

export interface AccountState {
  equity: number;
  cash: number;
  /** Sum of (entry − stop) × shares across open positions, i.e. what is at stake right now. */
  openRiskUsd: number;
  openSymbols: string[];
  workingOrders: { symbol: string; side: 'buy' | 'sell'; qty: number; createdAt: number }[];
  todayRealizedPnl: number;
  tradesToday: number;
  /** Losing trades in a row today, counted from the most recent close backwards. */
  consecutiveLossesToday: number;
  lastLoss: { symbol: string; at: number } | null;
  lossSymbolsToday: string[];
  killSwitch: boolean;
}

export interface EntryRequest {
  symbol: string;
  qty: number;
  notionalUsd: number;
  maxLossUsd: number;
}

export type BlockCode =
  | 'KILL_SWITCH'
  | 'DAILY_LOSS_LIMIT'
  | 'CONSECUTIVE_LOSSES'
  | 'MAX_TRADES'
  | 'LOSS_COOLDOWN'
  | 'REVENGE_SAME_SYMBOL'
  | 'OPEN_RISK'
  | 'RISK_BUDGET'
  | 'POSITION_SIZE'
  | 'INSUFFICIENT_CASH'
  | 'DUPLICATE_POSITION'
  | 'DUPLICATE_ORDER';

export interface Block {
  code: BlockCode;
  message: string;
}

export interface GuardResult {
  allowed: boolean;
  /** True when trading is shut down for the rest of the day, not just this order. */
  dailyShutdown: boolean;
  blocks: Block[];
  riskBudgetUsd: number;
}

const DUPLICATE_WINDOW_MS = 60_000;

/**
 * Runs every rule before a new entry. Any single block stops the trade. The
 * daily shutdown rules exist to stop the most common small-account failure:
 * trading bigger and faster to win back a loss.
 */
export function checkEntry(s: RiskSettings, a: AccountState, req: EntryRequest | null, now: number): GuardResult {
  const blocks: Block[] = [];
  const budget = effectiveRiskPerTrade(s, a.equity);
  const dailyLimit = effectiveDailyLoss(s, a.equity);

  if (a.killSwitch) blocks.push({ code: 'KILL_SWITCH', message: 'The kill switch is ON. No new orders can be created until you turn it off.' });
  if (a.todayRealizedPnl <= -dailyLimit) {
    blocks.push({ code: 'DAILY_LOSS_LIMIT', message: `Today's realized loss ($${(-a.todayRealizedPnl).toFixed(2)}) reached the daily limit ($${dailyLimit.toFixed(2)}). Trading is shut down until the next trading day.` });
  }
  if (a.consecutiveLossesToday >= s.maxConsecutiveLosses) {
    blocks.push({ code: 'CONSECUTIVE_LOSSES', message: `${a.consecutiveLossesToday} losing trades in a row today. Trading is shut down until the next trading day.` });
  }
  if (a.tradesToday >= s.maxTradesPerDay) {
    blocks.push({ code: 'MAX_TRADES', message: `Already ${a.tradesToday} trades today (limit ${s.maxTradesPerDay}).` });
  }
  if (a.lastLoss && now - a.lastLoss.at < s.lossCooldownMinutes * 60_000) {
    const mins = Math.ceil((s.lossCooldownMinutes * 60_000 - (now - a.lastLoss.at)) / 60_000);
    blocks.push({ code: 'LOSS_COOLDOWN', message: `Cooling-off period after a loss: ${mins} more minute(s). This protects against revenge trading.` });
  }

  if (req) {
    const sym = req.symbol.toUpperCase();
    if (a.lossSymbolsToday.includes(sym)) {
      blocks.push({ code: 'REVENGE_SAME_SYMBOL', message: `You already lost on ${sym} today. Re-entering the same stock to win it back is blocked until tomorrow.` });
    }
    if (a.openSymbols.includes(sym)) blocks.push({ code: 'DUPLICATE_POSITION', message: `There is already an open position in ${sym}.` });
    const dup = a.workingOrders.find((o) => o.symbol === sym && o.side === 'buy');
    if (dup) {
      blocks.push({
        code: 'DUPLICATE_ORDER',
        message: now - dup.createdAt < DUPLICATE_WINDOW_MS ? `An identical ${sym} buy order was just created. Duplicate blocked.` : `A ${sym} buy order is already working.`,
      });
    }
    if (req.maxLossUsd > budget + 0.005) {
      blocks.push({ code: 'RISK_BUDGET', message: `Planned max loss $${req.maxLossUsd.toFixed(2)} exceeds the $${budget.toFixed(2)} risk budget.` });
    }
    if (a.openRiskUsd + req.maxLossUsd > s.maxOpenRiskUsd + 0.005) {
      blocks.push({ code: 'OPEN_RISK', message: `Total open risk would be $${(a.openRiskUsd + req.maxLossUsd).toFixed(2)}, above the $${s.maxOpenRiskUsd.toFixed(2)} limit.` });
    }
    if (req.notionalUsd > Math.min(s.maxPositionUsd, a.equity) + 0.005) {
      blocks.push({ code: 'POSITION_SIZE', message: `Position value $${req.notionalUsd.toFixed(2)} exceeds the $${Math.min(s.maxPositionUsd, a.equity).toFixed(2)} limit.` });
    }
    if (req.notionalUsd > a.cash + 0.005) {
      blocks.push({ code: 'INSUFFICIENT_CASH', message: `Needs $${req.notionalUsd.toFixed(2)} but only $${a.cash.toFixed(2)} cash is available. No borrowing.` });
    }
  }

  const shutdownCodes: BlockCode[] = ['KILL_SWITCH', 'DAILY_LOSS_LIMIT', 'CONSECUTIVE_LOSSES', 'MAX_TRADES'];
  return {
    allowed: blocks.length === 0,
    dailyShutdown: blocks.some((b) => shutdownCodes.includes(b.code)),
    blocks,
    riskBudgetUsd: budget,
  };
}
