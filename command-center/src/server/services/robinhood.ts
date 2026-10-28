import { formatShares } from '../../engine/plan.js';
import { checkEntry } from '../../engine/risk.js';
import type { Timeframe } from '../../engine/types.js';
import { getSettings } from '../db.js';
import { accountState, summarize } from './account.js';
import { analyzeSymbol, type Deps } from './analysis.js';
import { PROTECTIVE_ORDER_NOTES, round2, TradingError } from './trading.js';

/**
 * What was verified about Robinhood's official integration (checked
 * 2026-10-28 against robinhood.com). Anything not confirmed by Robinhood's
 * own pages is listed as unverified rather than assumed.
 */
export const ROBINHOOD_FACTS = {
  checkedOn: '2026-10-28',
  connectedToThisApp: false,
  liveExecutionInThisApp: false,
  officialEndpoint: 'https://agent.robinhood.com/mcp/trading',
  sources: ['https://robinhood.com/us/en/support/articles/agentic-trading-overview/', 'https://robinhood.com/newsroom/robinhood-is-now-open-to-agents/'],
  verified: [
    'Robinhood runs an official Trading MCP server for AI agents, launched in beta on May 27, 2026.',
    'An agent can READ all your Robinhood accounts (balances, positions, order history), but can only PLACE trades in a separate "Robinhood Agentic" account that you open and fund.',
    'You need a primary individual investing account in good standing to open the agentic account.',
    'Tool groups listed by Robinhood: account/portfolio, watchlist, market data, equities, options, crypto.',
    'Launch announcement: equities only during the beta; other asset classes "coming soon".',
    'You can review what the agent is about to do — but if you tell it to act without approval, it can place trades without your confirmation.',
    'You can disconnect the agent at any time. Robinhood sends a push notification for each trade.',
    'Robinhood states you are responsible for, and assume the risk of, every trade an agent places.',
  ],
  unverified: [
    'The exact tool names and which order types the MCP supports (market, limit, stop, stop-limit, trailing stop, fractional). Robinhood links to a separate order-types article; check what your connected agent actually lists before relying on any protective order.',
    'Whether stop orders are available for fractional-share quantities through the MCP.',
    'Rate limits or size limits for agent orders.',
  ],
  whyNotConnectedHere: [
    'This app runs as its own server; it is not an MCP client and holds no Robinhood login.',
    'Connecting requires you to sign in through Robinhood\'s own authentication flow inside an AI app (for example Claude), on your account. It cannot be done for you, and you should never give anyone your Robinhood password.',
    'Live execution is deliberately not built: the plan is paper trading first.',
  ],
  setupSteps: [
    'Connect an AI app to Robinhood. Claude Code command (from Robinhood\'s support page): claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading — Claude Desktop and others are also listed by Robinhood.',
    'Complete Robinhood\'s sign-in when prompted. During that sign-in Robinhood prompts you to open the separate MCP ("Agentic") account; follow its on-screen steps.',
    'Fund the agentic account with only money you can afford to lose — at most the $100 in your plan.',
    'First ask read-only questions ("list my positions", "which order types can you place?") to confirm what the agent can actually do.',
    'Never say "go ahead without asking me". Always ask for a preview and reply CONFIRM yourself.',
    'If the sign-in cannot be finished on your phone, do it from a computer; Robinhood\'s flow decides which devices work.',
  ],
  platformsListedByRobinhood: ['Claude Code', 'Claude Desktop', 'ChatGPT', 'Codex', 'Cursor', 'Grok'],
};

/**
 * A complete, reviewable order ticket built from the REAL-money account
 * rules. The app does not send it anywhere: you either type it into the
 * Robinhood app, or paste the prompt into an AI session connected to the
 * Robinhood MCP and confirm the preview yourself.
 */
export async function buildRobinhoodTicket(deps: Deps, symbol: string, timeframe: Timeframe) {
  const now = deps.now();
  const s = getSettings(deps.db);
  const state = accountState(deps.db, 'live', s, now);
  if (!summarize(deps.db, 'live', s, now).capitalKnown) throw new TradingError(409, 'LIVE_CAPITAL_UNKNOWN', 'Enter the real cash you set aside (Risk → Real money) before generating a real-money ticket.');
  const report = await analyzeSymbol(deps, symbol, timeframe, 'live');
  const plan = report.plan;
  if (!plan || plan.status !== 'TRADE_PLAN') throw new TradingError(422, 'NO_TRADE', 'NO TRADE — CONDITIONS NOT MET', { plan, quoteError: report.quoteError });
  if (plan.entryStatus !== 'in_entry_zone') throw new TradingError(409, 'NOT_CONFIRMED', `Confirmation has not happened: price must trade at $${plan.entryLow!.toFixed(2)} or higher first.`, { plan });
  const guard = checkEntry(s, state, { symbol, qty: plan.shares!, notionalUsd: plan.positionValue!, maxLossUsd: plan.maxPlannedLoss! }, now);
  if (!guard.allowed) throw new TradingError(409, 'RISK_BLOCKED', guard.blocks.map((b) => b.message).join(' '), { blocks: guard.blocks });

  const qty = formatShares(plan.shares!);
  const limit = round2(plan.entryHigh!);
  const fractional = !Number.isInteger(plan.shares!);
  const ticket = {
    ticker: symbol,
    side: 'BUY',
    quantity: qty,
    orderType: fractional ? 'Market (dollar-based) or limit if Robinhood offers it for fractional shares' : 'Limit',
    limitPrice: limit,
    estimatedPrice: report.quote!.price,
    estimatedValue: plan.positionValue!,
    stopLoss: round2(plan.stop!),
    takeProfit1: round2(plan.tp1!.price),
    takeProfit2: round2(plan.tp2!.price),
    plannedRisk: plan.maxPlannedLoss!,
    potentialLoss: `About $${plan.maxPlannedLoss!.toFixed(2)} if the stop fills at $${plan.stop!.toFixed(2)}; more if price gaps below it.`,
    timeInForce: 'Day',
    warnings: [...plan.warnings, ...PROTECTIVE_ORDER_NOTES, 'Prices move. Re-check the live quote in Robinhood before submitting; if it is above the limit, do not chase.'],
  };
  const agentPrompt = [
    `Using my Robinhood Agentic account, PREVIEW (do not place) this order:`,
    `BUY ${qty} share(s) of ${symbol}, ${fractional ? 'market order (fractional)' : `limit $${limit.toFixed(2)}, time in force Day`}.`,
    `Show me the full preview: estimated cost, buying power after, and any warnings.`,
    `Then list which order types you can place for a protective stop at $${plan.stop!.toFixed(2)} on this exact quantity, and their limitations.`,
    `Do NOT place anything until I reply with the single word CONFIRM. Do not place any other order. If anything differs from this message, stop and tell me.`,
  ].join('\n');
  return { ticket, agentPrompt, plan, generatedAt: now, dataSource: report.quote!.source, mode: 'live' as const, notice: 'Nothing has been sent to Robinhood. You place this order yourself, then record the actual fill under Positions → Real.' };
}
