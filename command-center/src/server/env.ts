import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader so the app needs no extra dependency. Real env vars win. */
function loadDotEnv(path = resolve(process.cwd(), '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key!] === undefined) process.env[key!] = raw!.replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const str = (k: string, d: string | null = null) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d;
};
const bool = (k: string, d: boolean) => {
  const v = process.env[k]?.toLowerCase();
  return v === undefined || v === '' ? d : v === 'true' || v === '1';
};

export const env = {
  port: num('PORT', 5299),
  host: str('HOST', '127.0.0.1')!,
  databasePath: str('DATABASE_PATH', './data/command-center.db')!,
  /** Required whenever the server listens beyond this machine. */
  accessToken: str('ACCESS_TOKEN'),
  alpacaKeyId: str('ALPACA_API_KEY_ID'),
  alpacaSecret: str('ALPACA_API_SECRET_KEY'),
  alpacaDataUrl: str('ALPACA_DATA_URL', 'https://data.alpaca.markets')!,
  /** Only the market clock is read from here. No order endpoint is ever called. */
  alpacaClockUrl: str('ALPACA_CLOCK_URL', 'https://paper-api.alpaca.markets')!,
  alpacaFeed: str('ALPACA_FEED', 'iex')!,
  httpTimeoutMs: num('HTTP_TIMEOUT_MS', 10_000),
  monitorInProcess: bool('MONITOR_IN_PROCESS', true),
  monitorIntervalSec: num('MONITOR_INTERVAL_SECONDS', 60),
  monitorOffHoursIntervalSec: num('MONITOR_OFF_HOURS_INTERVAL_SECONDS', 900),
  ntfyUrl: str('NTFY_URL'),
  enableLiveTrading: bool('ENABLE_LIVE_TRADING', false),
  logLevel: str('LOG_LEVEL', 'info')!,
};

export const isLocalHost = (h: string) => ['127.0.0.1', 'localhost', '::1'].includes(h);

/**
 * Refuses unsafe configurations at startup instead of running in a state the
 * user did not intend. There is no live order code to enable.
 */
export function assertSafeConfig(e = env): void {
  if (e.enableLiveTrading) {
    throw new Error('ENABLE_LIVE_TRADING=true was set, but this app contains no live order code. Real orders are placed by you in Robinhood (see docs/ROBINHOOD.md). Remove the setting to start.');
  }
  if (!isLocalHost(e.host) && !e.accessToken) {
    throw new Error(`HOST=${e.host} exposes the app beyond this computer. Set ACCESS_TOKEN to a long random string first so strangers cannot use your dashboard.`);
  }
}
