import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { computeMetrics, runBacktest } from '../engine/backtest.js';
import { InvalidTransitionError } from '../engine/orders.js';
import { checkEntry } from '../engine/risk.js';
import { DEFAULT_SETTINGS, HARD_CAPS, RiskSettingsSchema, validateSettingsChange } from '../engine/settings.js';
import { readTrend } from '../engine/trend.js';
import { TIMEFRAMES, type Timeframe } from '../engine/types.js';
import { getKillSwitch, getSettings, logRiskEvent, setKv, type Db, type Mode } from './db.js';
import { logger } from './logger.js';
import { accountState, lastClosedWasLoss, summarize, type PositionRow } from './services/account.js';
import { analyzeSymbol, normalizeSymbol, type Deps } from './services/analysis.js';
import { describeError } from './services/market.js';
import { monitorStatus, runMonitorCycle, type Notifier } from './services/monitor.js';
import { ROBINHOOD_FACTS, buildRobinhoodTicket } from './services/robinhood.js';
import { c1Overview, runC1 } from './services/c1.js';
import { agentConfig, agentStatus, holdings as listHoldings, latestRun, RANKING_RULE, runAgentScan } from './services/agent.js';
import { CLASS_RULES, THRESHOLDS } from '../agent/classify.js';
import { aiHistory, createTicket, decideTicket, listTickets, portfolio, stockOpportunity } from './services/agent-actions.js';
import { approveOrder, cancelOrder, closePaperPosition, previewOrder, recordLiveEntry, recordLiveExit, setLiveCapital, TradingError, toPreview, type OrderRow } from './services/trading.js';

export interface AppOptions {
  accessToken: string | null;
  notify: Notifier | null;
  monitorOwner: string;
}

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];
const tfSchema = z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]);
const modeOf = (v: unknown): Mode => (v === 'live' ? 'live' : 'paper');

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function symbolParam(raw: unknown): string {
  const s = normalizeSymbol(raw);
  if (!s) throw new HttpError(400, 'Enter a valid US stock or ETF ticker (letters, up to 10 characters).');
  return s;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res))
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch(next);
};

export function createApp(deps: Deps, opts: AppOptions): express.Express {
  const { db } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));

  app.use('/api', (req, res, next) => {
    if (!opts.accessToken) return next();
    const given = Buffer.from(String(req.header('x-access-token') ?? ''));
    const want = Buffer.from(opts.accessToken);
    if (given.length === want.length && timingSafeEqual(given, want)) return next();
    res.status(401).json({ error: 'unauthorized', message: 'Access token required.' });
  });

  app.get('/api/health', wrap(() => ({
    status: 'ok',
    time: deps.now(),
    dataSource: { name: deps.market.provider.name, configured: deps.market.provider.isConfigured(), docsUrl: deps.market.provider.docsUrl, notes: deps.market.provider.notes() },
    execution: 'PAPER ONLY. This app cannot place real orders.',
    monitor: monitorStatus(db, deps.now()),
  })));

  app.get('/api/dashboard', wrap(() => {
    const now = deps.now();
    const s = getSettings(db);
    const quotes = db.prepare('SELECT * FROM quotes ORDER BY fetched_at DESC LIMIT 1').get() as { fetched_at: number } | undefined;
    return {
      now,
      paper: summarize(db, 'paper', s, now),
      live: summarize(db, 'live', s, now),
      guard: checkEntry(s, accountState(db, 'paper', s, now), null, now),
      liveGuard: checkEntry(s, accountState(db, 'live', s, now), null, now),
      killSwitch: getKillSwitch(db),
      monitor: monitorStatus(db, now),
      lastPriceUpdateAt: quotes?.fetched_at ?? null,
      alerts: db.prepare('SELECT * FROM alert_events ORDER BY created_at DESC, id DESC LIMIT 8').all(),
      unreadAlerts: (db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE read_at IS NULL').get() as { n: number }).n,
      dataConfigured: deps.market.provider.isConfigured(),
    };
  }));

  app.get('/api/market/overview', wrap(async () => {
    const clock = await deps.market.clock();
    let quotes = new Map();
    let quoteError: string | null = null;
    try {
      quotes = await deps.market.quotes(INDEX_SYMBOLS);
    } catch (e) {
      quoteError = describeError(e).message;
    }
    const items = await Promise.all(
      INDEX_SYMBOLS.map(async (symbol) => {
        try {
          const set = await deps.market.candles(symbol, '1Day', 120);
          const prev = set.completed.at(-1);
          const q = quotes.get(symbol) ?? null;
          return { symbol, quote: q, prevClose: prev?.c ?? null, changePct: q && prev ? ((q.price - prev.c) / prev.c) * 100 : null, trend: readTrend(set.completed).trend, error: null };
        } catch (e) {
          return { symbol, quote: quotes.get(symbol) ?? null, prevClose: null, changePct: null, trend: null, error: describeError(e).message };
        }
      }),
    );
    return { clock, items, quoteError, generatedAt: deps.now() };
  }));

  // --- Watchlist ---
  app.get('/api/watchlist', wrap(async () => {
    const symbols = (db.prepare('SELECT symbol FROM watchlist ORDER BY added_at, symbol').all() as { symbol: string }[]).map((r) => r.symbol);
    let error: string | null = null;
    let quotes = new Map();
    try {
      if (symbols.length) quotes = await deps.market.quotes(symbols);
    } catch (e) {
      error = describeError(e).message;
    }
    return { symbols: symbols.map((s) => ({ symbol: s, quote: quotes.get(s) ?? null })), error, now: deps.now() };
  }));
  app.post('/api/watchlist', wrap((req) => {
    const symbol = symbolParam(req.body?.symbol);
    db.prepare('INSERT OR IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)').run(symbol, deps.now());
    return { ok: true, symbol };
  }));
  app.delete('/api/watchlist/:symbol', wrap((req) => {
    db.prepare('DELETE FROM watchlist WHERE symbol = ?').run(symbolParam(req.params.symbol));
    return { ok: true };
  }));

  // --- Analysis & plans ---
  app.get('/api/analysis/:symbol', wrap((req) => analyzeSymbol(deps, symbolParam(req.params.symbol), parse(tfSchema, req.query.tf ?? '1Day'), modeOf(req.query.mode))));

  // --- Paper orders ---
  const previewSchema = z.object({ symbol: z.string(), timeframe: tfSchema, orderType: z.enum(['market', 'limit']), idempotencyKey: z.string().min(8).max(100) });
  app.post('/api/orders/preview', wrap((req) => {
    const b = parse(previewSchema, req.body);
    return previewOrder(deps, { ...b, symbol: symbolParam(b.symbol) });
  }));
  app.post('/api/orders/:id/approve', wrap((req) => approveOrder(deps, String(req.params.id), req.body?.confirm)));
  app.post('/api/orders/:id/cancel', wrap((req) => cancelOrder(db, String(req.params.id), deps.now())));
  app.get('/api/orders', wrap(() => ({ orders: (db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50').all() as OrderRow[]).map(toPreview) })));

  // --- Positions ---
  app.get('/api/positions', wrap((req) => {
    const mode = modeOf(req.query.mode);
    const rows = db.prepare('SELECT * FROM positions WHERE mode = ? ORDER BY status = \'open\' DESC, opened_at DESC LIMIT 100').all(mode) as PositionRow[];
    return {
      mode,
      positions: rows.map((p) => ({ ...p, unrealizedPnl: p.status === 'open' && p.last_price !== null ? p.qty_open * (p.last_price - p.entry_price) : 0, fills: db.prepare('SELECT * FROM fills WHERE position_id = ? ORDER BY at').all(p.id) })),
      monitor: monitorStatus(db, deps.now()),
    };
  }));
  app.post('/api/positions/:id/close', wrap((req) => closePaperPosition(deps, String(req.params.id))));

  // --- Real-money records (entered by the user) ---
  app.post('/api/live/capital', wrap((req) => {
    setLiveCapital(db, Number(req.body?.amount), deps.now());
    return { ok: true };
  }));
  const liveEntrySchema = z.object({ symbol: z.string(), qty: z.number(), price: z.number(), stop: z.number(), tp1: z.number(), tp2: z.number(), timeframe: tfSchema, filledAt: z.number().optional(), invalidationPrice: z.number().nullable().optional() });
  app.post('/api/live/positions', wrap((req) => {
    const b = parse(liveEntrySchema, req.body);
    return recordLiveEntry(db, { ...b, symbol: symbolParam(b.symbol), filledAt: b.filledAt ?? deps.now(), invalidationPrice: b.invalidationPrice ?? null }, deps.now());
  }));
  app.post('/api/live/positions/:id/exit', wrap((req) => {
    const b = parse(z.object({ qty: z.number(), price: z.number(), fees: z.number().default(0), at: z.number().optional() }), req.body);
    return recordLiveExit(db, String(req.params.id), { ...b, at: b.at ?? deps.now() });
  }));

  // --- Alerts ---
  app.get('/api/alerts/rules', wrap(() => ({ rules: db.prepare('SELECT * FROM alert_rules ORDER BY status = \'armed\' DESC, created_at DESC LIMIT 100').all() })));
  app.post('/api/alerts/rules', wrap((req) => {
    const b = parse(z.object({ symbol: z.string(), kind: z.enum(['price_above', 'price_below']), price: z.number().positive(), note: z.string().max(200).optional() }), req.body);
    const symbol = symbolParam(b.symbol);
    const dup = db.prepare("SELECT id FROM alert_rules WHERE symbol = ? AND kind = ? AND ABS(price - ?) < 0.005 AND status = 'armed'").get(symbol, b.kind, b.price);
    if (dup) return { ok: true, duplicate: true };
    db.prepare("INSERT INTO alert_rules (symbol, kind, price, note, status, created_at) VALUES (?, ?, ?, ?, 'armed', ?)").run(symbol, b.kind, b.price, b.note ?? null, deps.now());
    return { ok: true, duplicate: false };
  }));
  app.delete('/api/alerts/rules/:id', wrap((req) => {
    db.prepare("UPDATE alert_rules SET status = 'disabled' WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  }));
  app.get('/api/alerts/events', wrap(() => ({ events: db.prepare('SELECT * FROM alert_events ORDER BY created_at DESC, id DESC LIMIT 100').all() })));
  app.post('/api/alerts/events/read', wrap(() => {
    db.prepare('UPDATE alert_events SET read_at = ? WHERE read_at IS NULL').run(deps.now());
    return { ok: true };
  }));

  // --- Journal ---
  app.get('/api/journal', wrap((req) => ({ entries: db.prepare('SELECT j.*, p.realized_pnl, p.status AS position_status, p.exit_reason FROM journal j LEFT JOIN positions p ON p.id = j.position_id WHERE j.mode = ? ORDER BY j.created_at DESC LIMIT 100').all(modeOf(req.query.mode)) })));
  const journalSchema = z.object({
    why_entered: z.string().max(2000).optional(),
    followed_plan: z.enum(['yes', 'partly', 'no']).optional(),
    what_happened: z.string().max(2000).optional(),
    lesson: z.string().max(2000).optional(),
    emotion: z.string().max(200).optional(),
    grade: z.enum(['A', 'B', 'C', 'D', 'F']).optional(),
  });
  app.put('/api/journal/:id', wrap((req) => {
    const b = parse(journalSchema, req.body);
    const fields = Object.entries(b).filter(([, v]) => v !== undefined);
    if (fields.length) db.prepare(`UPDATE journal SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...fields.map(([, v]) => v), deps.now(), Number(req.params.id));
    return { ok: true };
  }));

  // --- P&L ---
  app.get('/api/pnl', wrap((req) => {
    const mode = modeOf(req.query.mode);
    const s = getSettings(db);
    const closed = db.prepare("SELECT * FROM positions WHERE mode = ? AND status = 'closed' ORDER BY closed_at").all(mode) as PositionRow[];
    const summary = summarize(db, mode, s, deps.now());
    let eq = summary.startingCapital;
    return {
      mode,
      summary,
      metrics: computeMetrics(closed.map((p) => ({ pnl: p.realized_pnl, rMultiple: p.planned_loss > 0 ? p.realized_pnl / p.planned_loss : 0 })), summary.startingCapital),
      equityCurve: closed.map((p) => ({ t: p.closed_at!, equity: (eq += p.realized_pnl), symbol: p.symbol, pnl: p.realized_pnl })),
      sampleWarning: closed.length < 30 ? `Only ${closed.length} closed trade(s). That is far too few to judge whether this works — keep paper trading.` : null,
    };
  }));

  // --- Risk, settings, kill switch ---
  app.get('/api/risk', wrap(() => {
    const now = deps.now();
    const s = getSettings(db);
    return {
      settings: s,
      defaults: DEFAULT_SETTINGS,
      hardCaps: HARD_CAPS,
      paper: { summary: summarize(db, 'paper', s, now), state: accountState(db, 'paper', s, now), guard: checkEntry(s, accountState(db, 'paper', s, now), null, now) },
      live: { summary: summarize(db, 'live', s, now), state: accountState(db, 'live', s, now), guard: checkEntry(s, accountState(db, 'live', s, now), null, now) },
      killSwitch: getKillSwitch(db),
      events: db.prepare('SELECT * FROM risk_events ORDER BY at DESC LIMIT 30').all(),
    };
  }));
  app.put('/api/settings', wrap((req) => {
    const now = deps.now();
    const current = getSettings(db);
    const next = parse(RiskSettingsSchema, { ...current, ...req.body });
    const paper = summarize(db, 'paper', current, now);
    const live = summarize(db, 'live', current, now);
    const errors = validateSettingsChange(current, next, {
      equity: Math.min(paper.equity, next.startingCapitalUsd),
      todayRealizedPnl: Math.min(paper.todayRealizedPnl, live.todayRealizedPnl),
      lastClosedTradeWasLoss: lastClosedWasLoss(db),
    });
    if (errors.length) throw new HttpError(409, errors.join(' '));
    setKv(db, 'risk_settings', next, now);
    logRiskEvent(db, 'SETTINGS', 'Risk settings changed.', now);
    return { ok: true, settings: next };
  }));
  app.post('/api/kill-switch', wrap((req) => {
    const now = deps.now();
    const on = req.body?.on === true;
    if (!on && req.body?.confirm !== 'RESUME') throw new HttpError(400, 'To turn the kill switch off, type RESUME to confirm.');
    const reason = String(req.body?.reason ?? (on ? 'Turned on by user.' : 'Turned off by user.')).slice(0, 200);
    db.transaction(() => {
      setKv(db, 'kill_switch', { on, at: now, reason }, now);
      if (on) db.prepare("UPDATE orders SET status = 'cancelled', status_reason = 'Kill switch turned on.', updated_at = ? WHERE status IN ('preview','working')").run(now);
      logRiskEvent(db, on ? 'KILL_SWITCH_ON' : 'KILL_SWITCH_OFF', reason, now);
    })();
    return { killSwitch: getKillSwitch(db) };
  }));

  // --- Backtest ---
  app.post('/api/backtest', wrap(async (req) => {
    const b = parse(z.object({ symbol: z.string(), timeframe: z.enum(['1Day', '1Hour']), maxHoldBars: z.number().int().min(1).max(100).default(20) }), req.body);
    const symbol = symbolParam(b.symbol);
    const set = await deps.market.candles(symbol, b.timeframe, b.timeframe === '1Day' ? 1500 : 2000).catch((e) => {
      throw new HttpError(503, describeError(e).message);
    });
    const result = runBacktest(set.completed, { timeframe: b.timeframe, settings: getSettings(db), maxHoldBars: b.maxHoldBars, warmupBars: 60, outOfSampleFraction: 0.3 });
    const row = { symbol, timeframe: b.timeframe, source: deps.market.provider.name, ...result };
    db.prepare('INSERT INTO backtests (symbol, timeframe, created_at, result_json) VALUES (?, ?, ?, ?)').run(symbol, b.timeframe, deps.now(), JSON.stringify(row));
    return row;
  }));
  app.get('/api/backtest', wrap(() => ({
    runs: (db.prepare('SELECT id, symbol, timeframe, created_at, result_json FROM backtests ORDER BY created_at DESC LIMIT 20').all() as { id: number; symbol: string; timeframe: string; created_at: number; result_json: string }[]).map((r) => {
      const res = JSON.parse(r.result_json);
      return { id: r.id, symbol: r.symbol, timeframe: r.timeframe, createdAt: r.created_at, trades: res.all.trades, winRate: res.all.winRate, profitFactor: res.all.profitFactor, totalPnl: res.all.totalPnl };
    }),
  })));

  // --- Monitor ---
  app.get('/api/monitor', wrap(() => monitorStatus(db, deps.now())));
  app.post('/api/monitor/run', wrap(async () => {
    const r = await runMonitorCycle(deps, opts.monitorOwner, opts.notify);
    return { ...r, status: monitorStatus(db, deps.now()) };
  }));

  // --- C1 experimental paper strategy (separate ledger; no real orders) ---
  app.get('/api/c1', wrap(() => c1Overview(deps, getSettings(db))));
  app.post('/api/c1/run', wrap(async () => {
    const r = await runC1(deps, getSettings(db), getKillSwitch(db).on);
    return { run: r, overview: await c1Overview(deps, getSettings(db)) };
  }));

  // --- Trading Intelligence agent (research and recommendations; never places orders) ---
  app.get('/api/agent', wrap(async () => {
    const now = deps.now();
    const latest = latestRun(db);
    const hold = listHoldings(db);
    let quotes = new Map();
    try {
      if (hold.length) quotes = await deps.market.quotes(hold.map((h) => h.symbol));
    } catch {
      /* portfolio shows missing prices */
    }
    return {
      status: agentStatus(db, now),
      monitor: monitorStatus(db, now),
      latest: latest ? { run: latest.run, market: latest.market, briefing: latest.briefing, meta: latest.meta, top: latest.opportunities.slice(0, 8), counts: latest.opportunities.reduce<Record<string, number>>((m, o) => ((m[o.classification] = (m[o.classification] ?? 0) + 1), m), {}) } : null,
      alerts: db.prepare("SELECT * FROM alert_events WHERE category IN ('AGENT','PRICE_ALERT','SYSTEM') ORDER BY created_at DESC, id DESC LIMIT 8").all(),
      portfolio: portfolio(db, latest?.opportunities ?? null, quotes),
      killSwitch: getKillSwitch(db),
      dataConfigured: deps.market.provider.isConfigured(),
    };
  }));
  app.get('/api/agent/opportunities', wrap(() => {
    const latest = latestRun(db);
    return { run: latest?.run ?? null, opportunities: latest?.opportunities ?? [], market: latest?.market ?? null, rankingRule: RANKING_RULE, classRules: CLASS_RULES, thresholds: THRESHOLDS };
  }));
  app.post('/api/agent/run', wrap(() => runAgentScan(deps, 'manual')));
  app.get('/api/agent/config', wrap(() => agentConfig(db)));
  app.put('/api/agent/config', wrap((req) => {
    const b = parse(z.object({ enabled: z.boolean().optional(), scheduleET: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(6).optional(), extraSymbols: z.array(z.string()).max(50).optional(), removedSymbols: z.array(z.string()).max(200).optional(), useScreener: z.boolean().optional() }), req.body);
    const clean = (xs?: string[]) => xs?.map((x) => symbolParam(x));
    const next = { ...agentConfig(db), ...b, ...(b.extraSymbols ? { extraSymbols: clean(b.extraSymbols) } : {}), ...(b.removedSymbols ? { removedSymbols: clean(b.removedSymbols) } : {}) };
    setKv(db, 'agent_config', next, deps.now());
    return next;
  }));
  app.get('/api/agent/stock/:symbol', wrap((req) => stockOpportunity(deps, symbolParam(req.params.symbol))));
  app.get('/api/agent/history', wrap(() => aiHistory(db)));
  app.get('/api/agent/tickets', wrap(() => ({ tickets: listTickets(db, deps.now()) })));
  app.post('/api/agent/tickets', wrap((req) => {
    const b = parse(z.object({ symbol: z.string(), side: z.enum(['buy', 'sell']) }), req.body);
    return createTicket(deps, symbolParam(b.symbol), b.side);
  }));
  app.post('/api/agent/tickets/:id/approve', wrap((req) => decideTicket(db, String(req.params.id), 'approve', req.body?.confirm, deps.now())));
  app.post('/api/agent/tickets/:id/reject', wrap((req) => decideTicket(db, String(req.params.id), 'reject', null, deps.now())));

  // --- My Robinhood: holdings entered by the user (the app cannot read the account) ---
  app.get('/api/robinhood/portfolio', wrap(async () => {
    const hold = listHoldings(db);
    let quotes = new Map();
    let quoteError: string | null = null;
    try {
      if (hold.length) quotes = await deps.market.quotes(hold.map((h) => h.symbol));
    } catch (e) {
      quoteError = describeError(e).message;
    }
    return { ...portfolio(db, latestRun(db)?.opportunities ?? null, quotes), quoteError };
  }));
  app.put('/api/robinhood/holdings', wrap((req) => {
    const b = parse(z.object({ symbol: z.string(), shares: z.number().positive().max(1e7), costBasis: z.number().min(0).max(1e9), note: z.string().max(200).optional() }), req.body);
    db.prepare("INSERT INTO holdings (symbol, shares, cost_basis, source, note, updated_at) VALUES (?, ?, ?, 'manual', ?, ?) ON CONFLICT(symbol) DO UPDATE SET shares = excluded.shares, cost_basis = excluded.cost_basis, note = excluded.note, updated_at = excluded.updated_at").run(symbolParam(b.symbol), b.shares, b.costBasis, b.note ?? null, deps.now());
    return { ok: true };
  }));
  app.delete('/api/robinhood/holdings/:symbol', wrap((req) => {
    db.prepare('DELETE FROM holdings WHERE symbol = ?').run(symbolParam(req.params.symbol));
    return { ok: true };
  }));
  app.put('/api/robinhood/cash', wrap((req) => {
    const b = parse(z.object({ amount: z.number().min(0).max(1e9).nullable() }), req.body);
    setKv(db, 'robinhood_cash', b.amount, deps.now());
    return { ok: true, cash: b.amount };
  }));

  // --- Robinhood ---
  app.get('/api/robinhood', wrap(() => ROBINHOOD_FACTS));
  app.post('/api/robinhood/ticket', wrap((req) => {
    const b = parse(z.object({ symbol: z.string(), timeframe: tfSchema }), req.body);
    return buildRobinhoodTicket(deps, symbolParam(b.symbol), b.timeframe);
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}.` });
  });

  const clientDist = resolve(process.cwd(), 'dist/client');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof TradingError) return res.status(err.status).json({ error: err.code, message: err.message, details: err.details ?? null });
    if (err instanceof HttpError) return res.status(err.status).json({ error: 'request_failed', message: err.message });
    if (err instanceof InvalidTransitionError) return res.status(409).json({ error: 'invalid_state', message: err.message });
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.' });
    const d = describeError(err);
    if (d.code !== 'INTERNAL') return res.status(503).json({ error: d.code, message: d.message });
    logger.error('unhandled error', { error: d.message });
    res.status(500).json({ error: 'internal', message: 'Something went wrong on the server.' });
  });

  return app;
}

export type { Db };
