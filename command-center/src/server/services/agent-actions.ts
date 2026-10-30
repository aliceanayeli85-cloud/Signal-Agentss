import { randomUUID } from 'node:crypto';
import { applyCorporateActions } from '../../agent/corporate-actions.js';
import { marketContext } from '../../agent/features.js';
import { HORIZONS } from '../../agent/model.js';
import { isCandleComplete, normalizeCandles, nyParts } from '../../engine/time.js';
import { getKillSwitch, getSettings, type Db } from '../db.js';
import type { Deps } from './analysis.js';
import { evaluateSymbol, holdings, latestRun, loadModel, nyTime, robinhoodCash, type Opportunity } from './agent.js';
import { describeError } from './market.js';
import { TradingError } from './trading.js';

// ---------------------------------------------------------------------------
// On-demand analysis for any ticker
// ---------------------------------------------------------------------------

export async function stockOpportunity(deps: Deps, symbol: string): Promise<{ opportunity: Opportunity; fromRun: number | null }> {
  const latest = latestRun(deps.db);
  const hit = latest?.opportunities.find((o) => o.symbol === symbol);
  if (hit) return { opportunity: hit, fromRun: Number(latest!.run.id) };
  const p = deps.market.provider;
  const now = deps.now();
  const raw = await p.dailyBarsMulti([symbol, 'SPY'], new Date(now - 500 * 86_400_000).toISOString());
  const clean = (s: string) => normalizeCandles(applyCorporateActions(s, raw[s] ?? [])).filter((c) => isCandleComplete(c, '1Day', now));
  const cs = clean(symbol);
  const spy = clean('SPY');
  if (cs.length < 30) throw new TradingError(404, 'NO_DATA', `Not enough daily history for ${symbol} (found ${cs.length} candles).`);
  const quote = await deps.market.quote(symbol).catch(() => null);
  const hold = holdings(deps.db).find((h) => h.symbol === symbol) ?? null;
  const cash = robinhoodCash(deps.db) ?? 0;
  const clock = await deps.market.clock();
  const o = evaluateSymbol(symbol, cs, quote, hold, { settings: getSettings(deps.db), capital: { cash, equity: cash + (hold && quote ? hold.shares * quote.price : 0) }, model: loadModel(), market: marketContext(spy), spy, now, marketOpen: clock ? clock.isOpen : null, killSwitch: getKillSwitch(deps.db).on }, hold ? 'holding' : 'lookup', await p.assetName(symbol));
  try {
    o.news = (await p.news({ symbols: [symbol], startIso: new Date(now - 7 * 86_400_000).toISOString(), limit: 10 })).slice(0, 8);
  } catch {
    o.news = [];
  }
  return { opportunity: o, fromRun: null };
}

// ---------------------------------------------------------------------------
// Real-money trade tickets: prepared by the agent, approved by the user,
// placed by the user in Robinhood. Nothing here sends an order anywhere.
// ---------------------------------------------------------------------------

export interface TicketRow {
  id: string;
  run_id: number | null;
  symbol: string;
  side: 'buy' | 'sell';
  status: 'proposed' | 'approved' | 'rejected' | 'expired';
  json: string;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
}

function sessionEnd(now: number): number {
  const p = nyParts(now);
  const close = nyTime(p.dateKey, '16:00');
  return close > now ? close : now + 24 * 3_600_000;
}

export function expireTickets(db: Db, now: number) {
  db.prepare("UPDATE agent_tickets SET status = 'expired', decided_at = ? WHERE status = 'proposed' AND expires_at < ?").run(now, now);
}

export function listTickets(db: Db, now: number) {
  expireTickets(db, now);
  return (db.prepare('SELECT * FROM agent_tickets ORDER BY created_at DESC LIMIT 50').all() as TicketRow[]).map((t) => ({ ...t, ticket: JSON.parse(t.json) }));
}

export async function createTicket(deps: Deps, symbol: string, side: 'buy' | 'sell') {
  const { db } = deps;
  const now = deps.now();
  const latest = latestRun(db);
  const o = latest?.opportunities.find((x) => x.symbol === symbol);
  if (!o) throw new TradingError(404, 'NOT_SCANNED', `${symbol} is not in the latest scan. Run a scan first.`);
  const warnings = [
    'Nothing has been sent to Robinhood. You place this order yourself, and only after approving it here.',
    'A stop is not a guarantee: a gap can fill below it and lose more than planned.',
    'Prices move. Re-check the live price in Robinhood before submitting; do not chase above the limit.',
    'Robinhood fractional orders may only be available as dollar-based market orders, and stop orders may not be available for fractional quantities. Check in the app.',
  ];
  let ticket: Record<string, unknown>;
  if (side === 'buy') {
    if (getKillSwitch(db).on) throw new TradingError(423, 'KILL_SWITCH', 'The kill switch is ON. No buy tickets can be created.');
    if (o.classification !== 'BUY WATCHLIST' && o.classification !== 'STRONG BUY SETUP') throw new TradingError(409, 'NOT_A_BUY', `${symbol} is ${o.classification}: ${o.classReasons.join(' ')}`);
    if (!o.plan || !o.sizing || o.sizing.fit !== 'FITS') throw new TradingError(409, 'DOES_NOT_FIT', o.sizing?.message ?? 'No plan fits your capital. Keep your money rather than force a trade.');
    ticket = {
      symbol, name: o.name, side: 'BUY', classification: o.classification, reasons: o.classReasons,
      shares: o.sizing.shares, dollarAmount: Math.round(o.sizing.notional * 100) / 100,
      orderType: 'Limit (or a dollar-based market order if Robinhood requires it for fractional shares)', limitPrice: Math.round(o.plan.entryHigh * 100) / 100,
      entryRange: [o.plan.entryLow, o.plan.entryHigh], stop: o.plan.stop, tp1: o.plan.tp1, tp2: o.plan.tp2, rewardRisk: o.plan.rewardRisk,
      maxLoss: o.sizing.maxLoss, costs: o.sizing.costs, invalidation: o.plan.invalidation, evidence: o.evidence,
      forecast: o.forecasts[20]!.status === 'OK' ? o.forecasts[20] : { status: o.forecasts[20]!.status, reason: o.forecasts[20]!.reason },
      warnings,
    };
  } else {
    const h = holdings(db).find((x) => x.symbol === symbol);
    if (!h) throw new TradingError(404, 'NOT_HELD', `You have no recorded ${symbol} holding.`);
    const px = o.price ?? o.technicals.close;
    ticket = {
      symbol, name: o.name, side: 'SELL', classification: o.classification, reasons: o.classReasons,
      shares: h.shares, dollarAmount: Math.round(h.shares * px * 100) / 100, orderType: 'Market (fractional shares) or limit', limitPrice: Math.round(px * 100) / 100,
      costBasis: h.cost_basis, estimatedPnl: h.shares * px - h.cost_basis, warnings: warnings.filter((w) => !w.includes('stop')),
    };
  }
  const agentPrompt = [
    `Using my Robinhood account, PREVIEW (do not place) this order: ${ticket.side} ${ticket.shares} share(s) of ${symbol} (about $${ticket.dollarAmount}).`,
    side === 'buy' ? `Use a limit of $${ticket.limitPrice} if available for this quantity; otherwise tell me what order types you can use.` : 'Tell me the order types available for this fractional quantity.',
    'Show the full preview, then WAIT. Do not place anything until I reply with the single word CONFIRM. Do not place any other order.',
  ].join('\n');
  const id = randomUUID();
  db.prepare("INSERT INTO agent_tickets (id, run_id, symbol, side, status, json, created_at, expires_at) VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)").run(id, Number(latest!.run.id), symbol, side, JSON.stringify({ ...ticket, agentPrompt }), now, sessionEnd(now));
  return listTickets(db, now).find((t) => t.id === id)!;
}

export function decideTicket(db: Db, id: string, decision: 'approve' | 'reject', confirm: unknown, now: number) {
  expireTickets(db, now);
  const t = db.prepare('SELECT * FROM agent_tickets WHERE id = ?').get(id) as TicketRow | undefined;
  if (!t) throw new TradingError(404, 'NOT_FOUND', 'Ticket not found.');
  if (t.status !== 'proposed') return { ...t, ticket: JSON.parse(t.json), message: `This ticket is already ${t.status}.` };
  if (decision === 'approve' && confirm !== 'APPROVE') throw new TradingError(400, 'CONFIRM_REQUIRED', 'Type APPROVE to approve this real-money plan.');
  if (decision === 'approve' && t.side === 'buy' && getKillSwitch(db).on) throw new TradingError(423, 'KILL_SWITCH', 'The kill switch is ON.');
  db.prepare('UPDATE agent_tickets SET status = ?, decided_at = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'rejected', now, id);
  return {
    ...(db.prepare('SELECT * FROM agent_tickets WHERE id = ?').get(id) as TicketRow),
    ticket: JSON.parse(t.json),
    message: decision === 'approve' ? 'Approved by you. Now place it yourself in Robinhood (or paste the prompt into an AI app connected to Robinhood and reply CONFIRM only if the preview matches). Then update My Robinhood with the actual fill.' : 'Rejected. Nothing was done.',
  };
}

// ---------------------------------------------------------------------------
// AI History: model validation record + live (forward) prediction scoring
// ---------------------------------------------------------------------------

export function aiHistory(db: Db) {
  const model = loadModel();
  const rows = db.prepare('SELECT * FROM agent_predictions ORDER BY asof_date DESC, symbol').all() as {
    symbol: string; asof_date: string; horizon: number; status: string; p_up: number | null; base_rate: number; shadow_p: number | null; shadow_bucket: number | null; classification: string; price: number; resolved: number; outcome_date: string | null; actual_return: number | null;
  }[];
  const live = HORIZONS.map((h) => {
    const r = rows.filter((x) => x.horizon === h && x.resolved);
    const m = model?.models[h];
    const shadowP = (b: number | null) => (m && b ? m.buckets[b - 1]!.pUp : null);
    const scored = r.filter((x) => shadowP(x.shadow_bucket) !== null);
    const brierOf = (ps: number[], ys: number[]) => (ps.length ? ps.reduce((a, p, i) => a + (p - ys[i]!) ** 2, 0) / ps.length : null);
    const ys = scored.map((x) => (x.actual_return! > 0 ? 1 : 0));
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const byClass = ['STRONG BUY SETUP', 'BUY WATCHLIST', 'HOLD', 'SELL WATCH', 'AVOID', 'NO TRADE'].map((c) => {
      const xs = r.filter((x) => x.classification === c);
      return { classification: c, n: xs.length, avgReturn: mean(xs.map((x) => x.actual_return!)), upRate: xs.length ? xs.filter((x) => x.actual_return! > 0).length / xs.length : null };
    });
    return {
      horizon: h,
      predictions: rows.filter((x) => x.horizon === h).length,
      resolved: r.length,
      upRate: r.length ? r.filter((x) => x.actual_return! > 0).length / r.length : null,
      shadowBrier: brierOf(scored.map((x) => shadowP(x.shadow_bucket)!), ys),
      baseBrier: brierOf(scored.map((x) => x.base_rate), ys),
      topBucketsAvgReturn: mean(r.filter((x) => (x.shadow_bucket ?? 0) >= 8).map((x) => x.actual_return!)),
      bottomBucketsAvgReturn: mean(r.filter((x) => (x.shadow_bucket ?? 99) <= 3).map((x) => x.actual_return!)),
      byClass,
    };
  });
  const buyish = rows.filter((x) => x.resolved && (x.classification === 'BUY WATCHLIST' || x.classification === 'STRONG BUY SETUP') && x.horizon === 5);
  return {
    model: model
      ? {
          version: model.version,
          trainedAt: model.trainedAt,
          splits: model.splits,
          horizons: HORIZONS.map((h) => ({ horizon: h, baseRate: model.models[h]!.baseRate, report: model.models[h]!.report, buckets: model.models[h]!.buckets.map((b) => ({ pUp: b.pUp, n: b.n, testPUp: b.test.pUp, testN: b.test.n, meanRet: b.meanRet, testMeanRet: b.test.meanRet })) })),
        }
      : null,
    live,
    firstPrediction: rows.at(-1)?.asof_date ?? null,
    unresolved: rows.filter((x) => !x.resolved).length,
    recentResolved: rows.filter((x) => x.resolved).slice(0, 40),
    winners: buyish.filter((x) => x.actual_return! > 0).slice(0, 10),
    losers: buyish.filter((x) => x.actual_return! <= 0).slice(0, 10),
    note: 'Live predictions are a true forward test: each is recorded before its outcome exists and scored only after the horizon has passed. Few resolved predictions means these numbers are not yet meaningful.',
  };
}

export function portfolio(db: Db, latestOpps: Opportunity[] | null, quotes: Map<string, { price: number; time: number }>) {
  const cash = robinhoodCash(db);
  const list = holdings(db).map((h) => {
    const q = quotes.get(h.symbol);
    const o = latestOpps?.find((x) => x.symbol === h.symbol) ?? null;
    const value = q ? h.shares * q.price : null;
    return { ...h, price: q?.price ?? null, priceTime: q?.time ?? null, value, pnl: value !== null ? value - h.cost_basis : null, pnlPct: value !== null && h.cost_basis > 0 ? value / h.cost_basis - 1 : null, classification: o?.classification ?? null, reasons: o?.classReasons ?? [], exitLevel: o?.technicals.low20 ?? null };
  });
  const invested = list.reduce((a, h) => a + (h.value ?? 0), 0);
  const cost = list.reduce((a, h) => a + h.cost_basis, 0);
  return { holdings: list, cash, totalValue: invested + (cash ?? 0), invested, costBasis: cost, pnl: invested - cost, pnlPct: cost > 0 ? invested / cost - 1 : null, note: 'Entered by you. The app cannot read your Robinhood account; update these after each trade.' };
}

export { describeError };
