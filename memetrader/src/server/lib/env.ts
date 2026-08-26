import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader. Node's own --env-file is not available in every runner we
 * support, and a dotenv dependency for twelve lines of parsing is not worth it.
 * Real process env always wins over the file.
 */
function loadDotEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, 'utf8');
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? null : raw.trim();
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 5199),
  host: process.env.HOST ?? '127.0.0.1',
  databasePath: process.env.DATABASE_PATH ?? './data/memetrader.db',
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',

  /** How long a provider response is served from cache before being refetched. */
  cacheTtlMs: num('DATA_CACHE_TTL_MS', 20_000),
  /** Age at which cached data is labelled stale in the UI. */
  staleAfterMs: num('DATA_STALE_AFTER_MS', 60_000),
  httpTimeoutMs: num('HTTP_TIMEOUT_MS', 12_000),

  /** Optional. Without it the AI analysis panel reports itself unavailable. */
  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5',

  /** Optional stock-data providers. Without a key the stock adapter is unavailable. */
  alphaVantageApiKey: str('ALPHA_VANTAGE_API_KEY'),
  polygonApiKey: str('POLYGON_API_KEY'),

  /**
   * Hard safety switch. Real-money execution is not implemented anywhere in this
   * codebase; this flag exists so that any future integration has to be turned on
   * deliberately, and so the UI can prove it is off.
   */
  liveTradingEnabled: (process.env.ENABLE_LIVE_TRADING ?? 'false').toLowerCase() === 'true',
} as const;

export type Env = typeof env;
