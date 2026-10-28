import type { Quote } from '../src/engine/plan.js';
import type { Candle, Timeframe } from '../src/engine/types.js';
import { DataError, type MarketClock, type MarketDataProvider } from '../src/server/providers/alpaca.js';

/** TEST-ONLY provider. Serves whatever the test puts in it. */
export class FakeProvider implements MarketDataProvider {
  readonly name = 'Fake (tests only)';
  readonly docsUrl = 'about:blank';
  bars_: Partial<Record<Timeframe, Candle[]>> = {};
  quotes_ = new Map<string, Quote>();
  clock_: MarketClock = { isOpen: true, timestamp: 0, nextOpen: null, nextClose: null };
  failWith: DataError | null = null;
  calls = 0;

  isConfigured() {
    return true;
  }
  notes() {
    return ['Test data.'];
  }
  async quotes(symbols: string[]) {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return new Map(symbols.filter((s) => this.quotes_.has(s)).map((s) => [s, this.quotes_.get(s)!]));
  }
  async bars(_symbol: string, tf: Timeframe) {
    if (this.failWith) throw this.failWith;
    const b = this.bars_[tf];
    if (!b) throw new DataError('NOT_FOUND', `no ${tf} bars in fake`);
    return b;
  }
  async clock() {
    if (this.failWith) throw this.failWith;
    return this.clock_;
  }
}

export const NOW = Date.UTC(2026, 2, 10, 15, 0); // Tue 10:00 New York
const DAY = 86_400_000;

/**
 * 230 daily candles in an uptrend with waves (so RSI is not pinned at 100),
 * ending on a green candle that dips into the 9 EMA: a textbook pullback.
 * The last candle is dated the day before NOW, so it is complete.
 */
export function pullbackSeries(): Candle[] {
  const n = 230;
  const lastT = Date.UTC(2026, 2, 9, 4); // Mon midnight New York (EDT)
  const out: Candle[] = [];
  let prev = 40;
  for (let i = 0; i < n - 1; i++) {
    const c = 40 + i * 0.12 + Math.sin(i / 2.2) * 1.2;
    out.push({ t: lastT - (n - 1 - i) * DAY, o: prev, h: Math.max(prev, c) + 0.15, l: Math.min(prev, c) - 0.15, c, v: 1_000_000 });
    prev = c;
  }
  const closes = out.map((c) => c.c);
  const k = 2 / 10;
  let e9 = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
  for (let i = 9; i < closes.length; i++) e9 = closes[i]! * k + e9 * (1 - k);
  const last = out[out.length - 1]!;
  const o = Math.max(last.c, e9 + 0.05);
  out.push({ t: lastT, o, h: o + 0.35, l: e9 - 0.1, c: o + 0.3, v: 1_100_000 });
  return out;
}
