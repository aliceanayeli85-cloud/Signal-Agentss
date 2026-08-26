import { describe, expect, it } from 'vitest';
import type { Candle, LiquidityTrend, SetupDetection, StructureAnalysis, VolumeAnalysis } from '../src/shared/types.js';
import { aggregateCandles, aggregationFactor, deriveTimeframe } from '../src/engine/candles.js';
import { analyseLiquidity, MIN_LIQUIDITY_OBSERVATIONS } from '../src/engine/liquidity.js';
import { analyseMomentum, MOMENTUM_TIMEFRAMES } from '../src/engine/momentum.js';
import { assessChasing, resolveTradeStatus } from '../src/engine/trade-status.js';
import { analyseVolume } from '../src/engine/volume.js';
import { candle, ramp, snapshot } from './helpers.js';

function neutralVolume(): VolumeAnalysis {
  return {
    relativeVolume: 1,
    acceleration: 1,
    trend: 'steady',
    priceVolumeDivergence: 0,
    flag: 'neutral',
    headline: 'neutral',
    reasons: [],
  };
}

function trend(overrides: Partial<LiquidityTrend> = {}): LiquidityTrend {
  return {
    label: 'stable',
    changePct: 0,
    observations: 5,
    firstObservedAt: 1,
    lastObservedAt: 2,
    currentUsd: 100_000,
    detail: 'stable',
    highRisk: false,
    ...overrides,
  };
}

function structure(label: StructureAnalysis['label']): StructureAnalysis {
  return { label, bias: 'neutral', swings: [], levels: [], sweeps: [], notes: [] };
}

function detection(): SetupDetection {
  return {
    strategy: 'breakout-retest',
    strategyName: 'Breakout + Retest',
    direction: 'long',
    triggerIndex: 1,
    triggerTime: 1,
    entry: 100,
    stop: 95,
    invalidation: 96,
    invalidationReason: 'close below 96',
    keyLevel: 96,
    annotations: [],
    notes: [],
  };
}

describe('candle aggregation', () => {
  it('folds bars and drops a partial trailing group', () => {
    const bars: Candle[] = [
      candle(0, 10, 12, 9, 11, 1),
      candle(60, 11, 15, 10, 14, 2),
      candle(120, 14, 16, 13, 13, 3),
      candle(180, 13, 14, 8, 9, 4),
      candle(240, 9, 10, 8, 9, 5),
    ];
    const folded = aggregateCandles(bars, 4);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toEqual({ time: 0, open: 10, high: 16, low: 8, close: 9, volume: 10 });
  });

  it('reports null volume when any constituent bar lacked it', () => {
    const bars = [candle(0, 1, 2, 1, 2, 1), candle(60, 2, 3, 2, 3, null)];
    expect(aggregateCandles(bars, 2)[0]?.volume).toBeNull();
  });

  it('knows which timeframes divide into which', () => {
    expect(aggregationFactor('15m', '1h')).toBe(4);
    expect(aggregationFactor('15m', '4h')).toBe(16);
    expect(aggregationFactor('1m', '5m')).toBe(5);
    // Never downward: a finer series cannot be invented from a coarser one.
    expect(aggregationFactor('1h', '15m')).toBeNull();
  });

  it('refuses to derive a finer timeframe from a coarser one', () => {
    const hourly = ramp(50, 100, 1, { interval: 3600 });
    expect(deriveTimeframe({ timeframe: '1h', candles: hourly }, '15m')).toBeNull();
    expect(deriveTimeframe({ timeframe: '1h', candles: hourly }, '4h')).not.toBeNull();
  });

  it('returns the source untouched when the timeframes match', () => {
    const bars = ramp(10, 100, 1);
    expect(deriveTimeframe({ timeframe: '1h', candles: bars }, '1h')).toBe(bars);
  });
});

describe('liquidity trend', () => {
  it('reports insufficient history rather than "stable" for a new market', () => {
    const result = analyseLiquidity([{ capturedAt: 1, liquidityUsd: 50_000 }], 50_000);
    expect(result.label).toBe('insufficient-history');
    expect(result.highRisk).toBe(false);
    expect(result.detail).toMatch(new RegExp(`${MIN_LIQUIDITY_OBSERVATIONS} recorded observations`));
  });

  it('flags a fast, large drop as rapid loss and high risk', () => {
    const base = Date.now() - 30 * 60_000;
    const result = analyseLiquidity(
      [
        { capturedAt: base, liquidityUsd: 100_000 },
        { capturedAt: base + 10 * 60_000, liquidityUsd: 80_000 },
        { capturedAt: base + 20 * 60_000, liquidityUsd: 50_000 },
      ],
      40_000,
    );
    expect(result.label).toBe('rapid-loss');
    expect(result.highRisk).toBe(true);
    expect(result.detail).toMatch(/HIGH RISK — LIQUIDITY DETERIORATION/);
  });

  it('calls a slow decline falling, not rapid loss', () => {
    const base = Date.now() - 6 * 3_600_000;
    const result = analyseLiquidity(
      [
        { capturedAt: base, liquidityUsd: 100_000 },
        { capturedAt: base + 2 * 3_600_000, liquidityUsd: 95_000 },
        { capturedAt: base + 4 * 3_600_000, liquidityUsd: 88_000 },
      ],
      85_000,
    );
    expect(result.label).toBe('falling');
    expect(result.highRisk).toBe(false);
  });

  it('recognises growth and stability', () => {
    const base = Date.now() - 3_600_000;
    const observations = [
      { capturedAt: base, liquidityUsd: 100_000 },
      { capturedAt: base + 600_000, liquidityUsd: 105_000 },
      { capturedAt: base + 1_200_000, liquidityUsd: 110_000 },
    ];
    expect(analyseLiquidity(observations, 130_000).label).toBe('increasing');
    expect(analyseLiquidity(observations, 101_000).label).toBe('stable');
  });

  it('ignores null and zero readings instead of treating them as data', () => {
    const result = analyseLiquidity(
      [
        { capturedAt: 1, liquidityUsd: null },
        { capturedAt: 2, liquidityUsd: 0 },
        { capturedAt: 3, liquidityUsd: 10_000 },
      ],
      10_000,
    );
    expect(result.observations).toBe(1);
    expect(result.label).toBe('insufficient-history');
  });
});

describe('volume analysis', () => {
  it('reports unavailable when the series carries no volume', () => {
    const result = analyseVolume(ramp(60, 100, 1, { volume: null }), null);
    expect(result.flag).toBe('unavailable');
    expect(result.headline).toBe('VOLUME DATA UNAVAILABLE');
    expect(result.relativeVolume).toBeNull();
  });

  it('reports unavailable when there are too few bars', () => {
    expect(analyseVolume(ramp(10, 100, 1), null).flag).toBe('unavailable');
  });

  it('flags bullish confirmation when a rise is backed by expanding volume', () => {
    const bars = ramp(60, 100, 1, { volume: 1000 });
    for (let i = bars.length - 3; i < bars.length; i += 1) {
      const bar = bars[i];
      if (bar) bar.volume = 4000;
    }
    const result = analyseVolume(bars, null);
    expect(result.trend).toBe('expanding');
    expect(result.flag).toBe('bullish-confirmation');
    expect(result.headline).toMatch(/BULLISH CONFIRMATION/);
  });

  it('warns when price rises while volume deteriorates', () => {
    const bars = ramp(60, 100, 1, { volume: 5000 });
    for (let i = bars.length - 3; i < bars.length; i += 1) {
      const bar = bars[i];
      if (bar) bar.volume = 400;
    }
    const result = analyseVolume(bars, null);
    expect(result.trend).toBe('contracting');
    expect(result.flag).toBe('warning');
    expect(result.headline).toMatch(/price is rising while volume deteriorates/i);
    expect(result.priceVolumeDivergence).toBeLessThan(0);
  });

  it('adds the windowed snapshot figures when they are present', () => {
    const result = analyseVolume(ramp(60, 100, 1, { volume: 1000 }), snapshot());
    expect(result.reasons.some((r) => /24h average hourly volume/i.test(r))).toBe(true);
  });
});

describe('momentum ladder', () => {
  it('separates a failed fetch from genuinely short history', () => {
    const result = analyseMomentum([
      { timeframe: '1m', candles: null, unavailableReason: 'rate limited' },
      { timeframe: '5m', candles: ramp(2, 100, 1) },
      { timeframe: '15m', candles: ramp(40, 100, 1) },
    ]);
    const byTf = Object.fromEntries(result.readings.map((r) => [r.timeframe, r]));
    expect(byTf['1m']?.status).toBe('unavailable');
    expect(byTf['1m']?.reason).toBe('rate limited');
    expect(byTf['5m']?.status).toBe('insufficient-data');
    expect(byTf['15m']?.status).toBe('ok');
  });

  it('produces no bias at all when nothing could be measured', () => {
    const result = analyseMomentum(
      MOMENTUM_TIMEFRAMES.map((tf) => ({ timeframe: tf, candles: null, unavailableReason: 'no data' })),
    );
    expect(result.bias).toBe('unknown');
    expect(result.evaluated).toBe(0);
  });

  it('reads direction from the timeframes that did have data', () => {
    const up = analyseMomentum(
      MOMENTUM_TIMEFRAMES.map((tf) => ({ timeframe: tf, candles: ramp(40, 100, 1) })),
    );
    expect(up.bias).toBe('bullish');
    expect(up.evaluated).toBe(MOMENTUM_TIMEFRAMES.length);

    const down = analyseMomentum(
      MOMENTUM_TIMEFRAMES.map((tf) => ({ timeframe: tf, candles: ramp(40, 200, -1) })),
    );
    expect(down.bias).toBe('bearish');
  });

  it('calls a flat market neutral rather than picking a side', () => {
    const flat = analyseMomentum(
      MOMENTUM_TIMEFRAMES.map((tf) => ({ timeframe: tf, candles: ramp(40, 100, 0) })),
    );
    expect(flat.bias).toBe('neutral');
  });
});

describe('trade status', () => {
  const base = {
    hasMarketData: true,
    hasCandles: true,
    detections: [] as SetupDetection[],
    plan: { available: false as const, reason: 'no plan' },
    risk: null,
    liquidity: trend(),
    volume: neutralVolume(),
    setupScore: null,
  };

  it('reports DATA UNAVAILABLE when there is no market or chart data', () => {
    expect(resolveTradeStatus({ ...base, hasMarketData: false, structure: null }).status).toBe('DATA UNAVAILABLE');
    expect(resolveTradeStatus({ ...base, hasCandles: false, structure: null }).status).toBe('DATA UNAVAILABLE');
  });

  it('puts hazard ahead of any technical picture', () => {
    const result = resolveTradeStatus({
      ...base,
      structure: structure('higher-highs-higher-lows'),
      detections: [detection()],
      plan: {
        available: true,
        direction: 'long',
        entry: 100,
        stop: 95,
        invalidation: 96,
        invalidationReason: '',
        targets: { tp1: 105, tp2: 110, tp3: 115 },
        rr: { tp1: 1, tp2: 2, tp3: 3 },
        riskPerUnit: 5,
        notes: [],
      },
      liquidity: trend({ label: 'rapid-loss', highRisk: true, detail: 'pool draining' }),
    });
    // A perfect setup on a draining pool is not an opportunity.
    expect(result.status).toBe('HIGH RISK');
  });

  it('marks a failed breakout and a breakdown as invalidated', () => {
    expect(resolveTradeStatus({ ...base, structure: structure('failed-breakout') }).status).toBe('INVALIDATED');
    expect(resolveTradeStatus({ ...base, structure: structure('breakdown') }).status).toBe('INVALIDATED');
  });

  it('asks for a retest after an unretested breakout', () => {
    const result = resolveTradeStatus({ ...base, structure: structure('breakout') });
    expect(result.status).toBe('WAIT FOR RETEST');
    expect(result.reasons.join(' ')).toMatch(/has not yet come back to test/i);
  });

  it('surfaces a volume warning alongside a valid setup instead of hiding it', () => {
    const result = resolveTradeStatus({
      ...base,
      structure: structure('higher-highs-higher-lows'),
      detections: [detection()],
      plan: {
        available: true,
        direction: 'long',
        entry: 100,
        stop: 95,
        invalidation: 96,
        invalidationReason: '',
        targets: { tp1: 105, tp2: 110, tp3: 115 },
        rr: { tp1: 1, tp2: 2, tp3: 3 },
        riskPerUnit: 5,
        notes: [],
      },
      volume: { ...neutralVolume(), flag: 'warning', headline: 'WARNING — volume deteriorating.' },
    });
    expect(result.status).toBe('ENTRY CONDITIONS MET');
    expect(result.reasons.join(' ')).toMatch(/WARNING — volume deteriorating/);
  });

  it('never returns BUY', () => {
    const statuses = [
      structure('consolidation'),
      structure('higher-highs-higher-lows'),
      structure('breakout'),
      structure('reclaim'),
      structure('lower-highs-lower-lows'),
      structure('insufficient-data'),
    ].map((s) => resolveTradeStatus({ ...base, structure: s }).status);
    for (const status of statuses) {
      expect(status).not.toMatch(/buy/i);
    }
  });
});

describe('chasing warning', () => {
  it('triggers on an extreme recent move and uses the mandated wording', () => {
    const result = assessChasing({ h1: 60 });
    expect(result.triggered).toBe(true);
    expect(result.headline).toBe('CHASING WARNING');
    expect(result.message).toMatch(/already moved substantially/i);
    expect(result.message).toMatch(/Wait for a defined setup instead of entering because of momentum/);
  });

  it('uses the tightest window that qualifies', () => {
    expect(assessChasing({ m5: 25, h24: 500 }).window).toBe('5 minutes');
  });

  it('does not trigger on ordinary movement or on a decline', () => {
    expect(assessChasing({ m5: 2, h1: 5, h24: 20 }).triggered).toBe(false);
    expect(assessChasing({ h1: -80 }).triggered).toBe(false);
  });

  it('does not trigger when no price-change window was reported', () => {
    expect(assessChasing({}).triggered).toBe(false);
  });
});

describe('token address resolution safety', () => {
  it('only accepts a pool whose BASE token is the requested mint', async () => {
    const originalFetch = globalThis.fetch;
    const wanted = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';

    // DexScreener returns a pool where the requested address is the QUOTE side,
    // plus one where it is the base. Only the latter describes the right asset.
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('token-pairs')) {
        return new Response(
          JSON.stringify([
            {
              chainId: 'solana',
              pairAddress: 'WrongPair',
              baseToken: { address: 'SomeOtherMint', symbol: 'OTHER', name: 'Other' },
              quoteToken: { symbol: 'WANTED' },
              priceUsd: '1',
              liquidity: { usd: 9_000_000 },
            },
            {
              chainId: 'solana',
              pairAddress: 'RightPair',
              baseToken: { address: wanted, symbol: 'CATE', name: 'Catecoin' },
              quoteToken: { symbol: 'SOL' },
              priceUsd: '0.06',
              liquidity: { usd: 100_000 },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const { DexScreenerProvider } = await import('../src/server/providers/dexscreener.js');
      const result = await new DexScreenerProvider().resolveToken('solana', wanted);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      // The deeper pool is the wrong one; base-token identity wins over liquidity.
      expect(result.data.pairAddress).toBe('RightPair');
      expect(result.data.symbol).toBe('CATE');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports unavailable when no pool has the requested mint as its base', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            chainId: 'solana',
            pairAddress: 'Unrelated',
            baseToken: { address: 'DifferentMint', symbol: 'NOPE', name: 'Nope' },
            priceUsd: '1',
            liquidity: { usd: 50_000 },
          },
        ]),
        { status: 200 },
      )) as typeof fetch;

    try {
      const { DexScreenerProvider } = await import('../src/server/providers/dexscreener.js');
      const result = await new DexScreenerProvider().resolveToken('solana', 'RequestedMintThatIsNotThere');
      expect(result.status).toBe('unavailable');
      if (result.status === 'unavailable') {
        expect(result.reason).toMatch(/no tradable pair/i);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
