import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseUnavailableError } from './db/index.js';
import { env } from './lib/env.js';
import { RiskLimitError, statusOf, UpstreamError, ValidationError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { EXECUTION_STATUS, providerStatuses } from './providers/registry.js';
import { alertsRouter } from './routes/alerts.js';
import { backtestRouter } from './routes/backtest.js';
import { deskRouter } from './routes/desk.js';
import { journalRouter } from './routes/journal.js';
import { marketRouter } from './routes/market.js';
import { performanceRouter } from './routes/performance.js';
import { tradingRouter } from './routes/trading.js';
import { watchlistRouter } from './routes/watchlist.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    logger.debug('request', { method: req.method, path: req.path });
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      time: Date.now(),
      providers: providerStatuses(),
      execution: EXECUTION_STATUS,
      ai: { configured: env.anthropicApiKey !== null, model: env.anthropicModel },
      dataFreshness: { cacheTtlMs: env.cacheTtlMs, staleAfterMs: env.staleAfterMs },
    });
  });

  app.use('/api/market', marketRouter);
  app.use('/api/trading', tradingRouter);
  app.use('/api/journal', journalRouter);
  app.use('/api/performance', performanceRouter);
  app.use('/api/backtest', backtestRouter);
  app.use('/api/watchlist', watchlistRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/desk', deskRouter);

  // In production the built client is served by the same process, so `npm start`
  // is genuinely one command.
  const clientDist = resolve(process.cwd(), 'dist/client');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}.` });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof DatabaseUnavailableError ? 503 : statusOf(error);
    const message = error instanceof Error ? error.message : 'Unexpected server error.';

    if (status >= 500) logger.error('request failed', { error, status });
    else logger.warn('request rejected', { message, status });

    const body: Record<string, unknown> = { error: errorCode(error), message };
    if (error instanceof RiskLimitError) body.reasons = error.reasons;
    if (error instanceof UpstreamError) body.source = error.source;
    res.status(status).json(body);
  });

  return app;
}

function errorCode(error: unknown): string {
  if (error instanceof ValidationError) return 'validation_error';
  if (error instanceof UpstreamError) return 'upstream_unavailable';
  if (error instanceof RiskLimitError) return 'risk_limit_reached';
  if (error instanceof DatabaseUnavailableError) return 'database_unavailable';
  if (error instanceof Error && error.name === 'NotFoundError') return 'not_found';
  return 'internal_error';
}
