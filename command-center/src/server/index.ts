import { createApp } from './app.js';
import { openDb } from './db.js';
import { assertSafeConfig, env } from './env.js';
import { logger } from './logger.js';
import { AlpacaProvider } from './providers/alpaca.js';
import { MarketService } from './services/market.js';
import { ntfyNotifier, startScheduler } from './services/monitor.js';

assertSafeConfig();

const db = openDb(env.databasePath);
const provider = new AlpacaProvider({ keyId: env.alpacaKeyId, secret: env.alpacaSecret, dataUrl: env.alpacaDataUrl, clockUrl: env.alpacaClockUrl, feed: env.alpacaFeed, dailyFeed: env.alpacaDailyFeed, timeoutMs: env.httpTimeoutMs });
const deps = { db, market: new MarketService(provider, db), now: Date.now };
const notify = env.ntfyUrl ? ntfyNotifier(env.ntfyUrl) : null;
const owner = `server-${process.pid}`;

const app = createApp(deps, { accessToken: env.accessToken, notify, monitorOwner: owner });
const server = app.listen(env.port, env.host, () => {
  logger.info('command center listening', { url: `http://${env.host}:${env.port}`, dataConfigured: provider.isConfigured(), monitorInProcess: env.monitorInProcess });
  if (!provider.isConfigured()) logger.warn('market data not configured: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY');
});

const scheduler = env.monitorInProcess ? startScheduler(deps, { intervalSec: env.monitorIntervalSec, offHoursSec: env.monitorOffHoursIntervalSec, notify, owner }) : null;

function shutdown() {
  scheduler?.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
