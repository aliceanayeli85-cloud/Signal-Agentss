import type { Candle, MarketSnapshot } from '../src/shared/types.js';

/** Deterministic candle builder so tests never depend on live data or randomness. */
export function candle(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number | null = 1000,
): Candle {
  return { time, open, high, low, close, volume };
}

/** A series that walks from `start` by `step` per bar with a fixed intrabar range. */
export function ramp(
  count: number,
  start: number,
  step: number,
  options: { volume?: number | null; range?: number; startTime?: number; interval?: number } = {},
): Candle[] {
  const { volume = 1000, range = 0.5, startTime = 1_700_000_000, interval = 3600 } = options;
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = price + step;
    out.push(
      candle(
        startTime + i * interval,
        open,
        Math.max(open, close) + range,
        Math.min(open, close) - range,
        close,
        volume,
      ),
    );
    price = close;
  }
  return out;
}

/** Flat, noisy range between `low` and `high` - the base for range/breakout tests. */
export function rangeBars(
  count: number,
  low: number,
  high: number,
  options: { volume?: number | null; startTime?: number; interval?: number } = {},
): Candle[] {
  const { volume = 1000, startTime = 1_700_000_000, interval = 3600 } = options;
  const mid = (low + high) / 2;
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    // Deterministic zig-zag that touches both edges repeatedly.
    const phase = i % 4;
    const open = phase === 0 ? mid : phase === 1 ? high - 0.1 : phase === 2 ? mid : low + 0.1;
    const close = phase === 0 ? high - 0.1 : phase === 1 ? mid : phase === 2 ? low + 0.1 : mid;
    out.push(
      candle(
        startTime + i * interval,
        open,
        Math.max(open, close) + 0.05,
        Math.min(open, close) - 0.05,
        close,
        volume,
      ),
    );
  }
  return out;
}

export function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: 'test:chain:pair',
    provider: 'test',
    assetClass: 'meme',
    symbol: 'TEST',
    name: 'Test Token',
    chain: 'solana',
    pairAddress: 'pair',
    baseTokenAddress: 'base',
    quoteSymbol: 'SOL',
    dex: 'testdex',
    url: null,
    priceUsd: 1,
    liquidityUsd: 250_000,
    marketCapUsd: 1_000_000,
    fdvUsd: 1_000_000,
    volume: { h24: 500_000, h6: 120_000, h1: 20_000, m5: 2_000 },
    priceChangePct: { h24: 5, h6: 2, h1: 1, m5: 0.2 },
    txns: { h1: { buys: 60, sells: 40 }, h24: { buys: 900, sells: 800 } },
    pairCreatedAt: Date.now() - 30 * 24 * 3_600_000,
    fetchedAt: Date.now(),
    ...overrides,
  };
}
