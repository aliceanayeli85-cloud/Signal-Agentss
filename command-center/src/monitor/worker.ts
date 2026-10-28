/**
 * Standalone monitor: `npm run monitor`. Use this when the dashboard server
 * is not always running (e.g. run the worker on an always-on machine and set
 * MONITOR_IN_PROCESS=false on the web server). A database lease guarantees
 * only one monitor processes orders at a time.
 */
import { openDb } from '../server/db.js';
import { assertSafeConfig, env } from '../server/env.js';
import { logger } from '../server/logger.js';
import { AlpacaProvider } from '../server/providers/alpaca.js';
import { MarketService } from '../server/services/market.js';
import { ntfyNotifier, startScheduler } from '../server/services/monitor.js';

assertSafeConfig({ ...env, host: '127.0.0.1' });
const db = openDb(env.databasePath);
const provider = new AlpacaProvider({ keyId: env.alpacaKeyId, secret: env.alpacaSecret, dataUrl: env.alpacaDataUrl, clockUrl: env.alpacaClockUrl, feed: env.alpacaFeed, timeoutMs: env.httpTimeoutMs });
const deps = { db, market: new MarketService(provider, db), now: Date.now };
const scheduler = startScheduler(deps, { intervalSec: env.monitorIntervalSec, offHoursSec: env.monitorOffHoursIntervalSec, notify: env.ntfyUrl ? ntfyNotifier(env.ntfyUrl) : null, owner: `worker-${process.pid}` });
logger.info('monitor worker started', { intervalSec: env.monitorIntervalSec, offHoursSec: env.monitorOffHoursIntervalSec, db: env.databasePath });

const stop = () => {
  scheduler.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
