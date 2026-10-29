import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/engine/settings.js';
import { runStrategy } from '../src/research/harness.js';
import { TREND_FOLLOW } from '../src/research/strategies.js';
import { openDb } from '../src/server/db.js';
import { summarize } from '../src/server/services/account.js';
import { processC1, seriesStats, type C1TradeRow } from '../src/server/services/c1.js';
import { seriesFromCloses } from './helpers.js';

const S = { ...DEFAULT_SETTINGS };

/** Test-only random walk with drift; daily candles stamped at New York midnight. */
function walk(n: number, seed: number, drift = 0.47) {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const closes: number[] = [];
  let p = 50;
  for (let i = 0; i < n; i++) closes.push((p *= 1 + (rnd() - drift) * 0.04));
  return seriesFromCloses(closes, Date.UTC(2020, 0, 1, 5)).map((c) => ({ ...c, h: Math.max(c.o, c.c) * (1 + rnd() * 0.012), l: Math.min(c.o, c.c) * (1 - rnd() * 0.012), v: 1000 }));
}

const dateOf = (t: number) => new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);

describe('C1 paper processor = pre-registered research rules', () => {
  for (const seed of [7, 11, 23, 99]) {
    it(`single ticker (seed ${seed}): identical trades to the audited research backtest`, () => {
      const cs = walk(800, seed);
      const research = runStrategy('X', cs, TREND_FOLLOW, S).filter((t) => !t.exitReason.startsWith('open at end'));
      const db = openDb(':memory:');
      processC1(db, { X: cs }, S, { universe: ['X'], benchmark: 'X', startDate: dateOf(cs[0]!.t), killSwitchOn: false, now: 0, requireWarmup: false });
      const paper = db.prepare("SELECT * FROM c1_trades WHERE status = 'closed' ORDER BY entry_time").all() as C1TradeRow[];
      expect(research.length).toBeGreaterThan(3); // otherwise the comparison proves nothing
      expect(paper.map((t) => [dateOf(t.entry_time), t.shares, +t.entry_fill.toFixed(6), t.exit_date, +t.pnl!.toFixed(6)])).toEqual(
        research.map((t) => [dateOf(t.entryTime), t.shares, +t.entryPrice.toFixed(6), dateOf(t.exitTime), +t.pnl.toFixed(6)]),
      );
    });
  }
});




const opts = (cs: { t: number }[], universe = ['X'], extra: Partial<Parameters<typeof processC1>[3]> = {}) => ({ universe, benchmark: universe[0]!, startDate: dateOf(cs[0]!.t), killSwitchOn: false, now: 0, requireWarmup: false, ...extra });
const trades = (db: ReturnType<typeof openDb>) => db.prepare('SELECT * FROM c1_trades ORDER BY entry_time').all() as C1TradeRow[];

describe('C1 paper portfolio', () => {
  const cs = walk(800, 7);

  it('is isolated: C1 activity never touches the baseline paper account or real-money records', () => {
    const db = openDb(':memory:');
    processC1(db, { X: cs }, S, opts(cs));
    expect(trades(db).length).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM positions').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number }).n).toBe(0);
    expect(summarize(db, 'paper', S, Date.now()).realizedPnl).toBe(0);
    expect(summarize(db, 'live', S, Date.now()).realizedPnl).toBe(0);
  });

  it('records a signal first and a simulated trade only on the next session', () => {
    const db = openDb(':memory:');
    const firstSignal = (() => {
      const probe = openDb(':memory:');
      processC1(probe, { X: cs }, S, opts(cs));
      return (probe.prepare("SELECT signal_date FROM c1_signals WHERE kind = 'entry' ORDER BY signal_date LIMIT 1").get() as { signal_date: string }).signal_date;
    })();
    const k = cs.findIndex((c) => dateOf(c.t) === firstSignal);
    processC1(db, { X: cs.slice(0, k + 1) }, S, opts(cs));
    expect((db.prepare("SELECT status FROM c1_signals WHERE signal_date = ?").get(firstSignal) as { status: string }).status).toBe('pending');
    expect(trades(db)).toHaveLength(0);
    processC1(db, { X: cs.slice(0, k + 2) }, S, opts(cs));
    expect((db.prepare("SELECT status FROM c1_signals WHERE signal_date = ?").get(firstSignal) as { status: string }).status).toBe('executed');
    expect(trades(db)[0]!.entry_date).toBe(dateOf(cs[k + 1]!.t));
  });

  it('processes each day once: catching up in chunks equals one pass, and re-running adds nothing', () => {
    const one = openDb(':memory:');
    processC1(one, { X: cs }, S, opts(cs));
    const chunked = openDb(':memory:');
    for (const k of [300, 450, 451, 700, 800]) processC1(chunked, { X: cs.slice(0, k) }, S, opts(cs));
    processC1(chunked, { X: cs }, S, opts(cs)); // nothing new
    const strip = (rows: C1TradeRow[]) => rows.map(({ id: _id, ...r }) => r);
    expect(strip(trades(chunked))).toEqual(strip(trades(one)));
    expect((chunked.prepare('SELECT COUNT(*) AS n FROM c1_daily').get() as { n: number }).n).toBe(cs.length);
  });

  it('records costs, slippage, planned risk and excursions for every trade', () => {
    const db = openDb(':memory:');
    processC1(db, { X: cs }, S, opts(cs));
    for (const t of trades(db).filter((x) => x.status === 'closed')) {
      expect(t.entry_slippage).toBeGreaterThan(0);
      expect(t.exit_slippage!).toBeGreaterThanOrEqual(0);
      expect(t.planned_risk).toBeLessThanOrEqual(1.0000001);
      expect(t.shares * t.entry_fill).toBeLessThanOrEqual(50.0000001);
      expect(t.mae).toBeLessThanOrEqual(0);
      expect(t.mfe).toBeGreaterThanOrEqual(0);
      expect(t.exit_reason).toBeTruthy();
      expect(t.pnl).toBeCloseTo(t.shares * (t.exit_fill! - t.entry_fill) - t.fees, 9);
    }
  });

  it('a gap through the stop exits at the open and can lose MORE than the planned risk', () => {
    const probe = openDb(':memory:');
    processC1(probe, { X: cs }, S, opts(cs));
    const first = trades(probe)[0]!;
    const k = cs.findIndex((c) => dateOf(c.t) === first.entry_date);
    const g = first.stop * 0.85;
    const gapped = cs.map((c, i) => (i <= k ? c : { ...c, o: c.o * (g / cs[k]!.c), h: c.h * (g / cs[k]!.c), l: c.l * (g / cs[k]!.c), c: c.c * (g / cs[k]!.c) }));
    const db = openDb(':memory:');
    processC1(db, { X: gapped }, S, opts(gapped));
    const t = trades(db)[0]!;
    expect(t.exit_date).not.toBe(first.entry_date); // the gap happens the day after entry
    expect(t.exit_reason).toMatch(/gap below stop/);
    expect(t.pnl!).toBeLessThan(-t.planned_risk);
    expect(t.r_multiple!).toBeLessThan(-1);
  });

  it('the $2 max open risk allows at most two positions at once (signals beyond that are skipped, not forced)', () => {
    const db = openDb(':memory:');
    processC1(db, { A: cs, B: cs, C: cs }, S, opts(cs, ['A', 'B', 'C']));
    const skipped = db.prepare("SELECT status_reason FROM c1_signals WHERE status = 'skipped'").all() as { status_reason: string }[];
    expect(skipped.some((s) => /open risk|cash|minimum order|exceed the limits/i.test(s.status_reason))).toBe(true);
    for (const row of db.prepare('SELECT date, open_positions FROM c1_daily').all() as { open_positions: number }[]) expect(row.open_positions).toBeLessThanOrEqual(2);
  });

  it('the kill switch blocks new entries but positions are still managed', () => {
    const db = openDb(':memory:');
    processC1(db, { X: cs }, S, opts(cs, ['X'], { killSwitchOn: true }));
    expect(trades(db)).toHaveLength(0);
    const reasons = db.prepare("SELECT status_reason FROM c1_signals WHERE status = 'skipped'").all() as { status_reason: string }[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => /kill switch/i.test(r.status_reason))).toBe(true);
  });

  it('the daily loss limit blocks C1 entries that day', () => {
    const probe = openDb(':memory:');
    processC1(probe, { X: cs }, S, opts(cs));
    const first = trades(probe)[0]!;
    const k = cs.findIndex((c) => dateOf(c.t) === first.entry_date);
    const db = openDb(':memory:');
    processC1(db, { X: cs.slice(0, k) }, S, opts(cs));
    // A $3 realized loss recorded for the entry day.
    db.prepare("INSERT INTO c1_trades (id, symbol, signal_date, entry_date, entry_time, entry_raw, entry_fill, shares, stop, planned_risk, entry_slippage, status, exit_date, exit_time, fees, pnl, r_multiple, regime) VALUES ('L', 'Y', ?, ?, 0, 1, 1, 1, 0.5, 1, 0, 'closed', ?, 0, 0, -3, -3, 'test')").run(first.entry_date, first.entry_date, first.entry_date);
    processC1(db, { X: cs.slice(0, k + 1) }, S, opts(cs));
    const sig = db.prepare("SELECT status, status_reason FROM c1_signals WHERE signal_date = ?").get(first.signal_date) as { status: string; status_reason: string };
    expect(sig.status).toBe('skipped');
    expect(sig.status_reason).toMatch(/daily limit|shut down/i);
  });

  it('pauses (does not skip ahead) when a ticker is missing a day, and warns', () => {
    const db = openDb(':memory:');
    const holey = cs.filter((_, i) => i !== 500);
    const r = processC1(db, { X: cs, Y: holey }, S, opts(cs, ['X', 'Y']));
    expect(r.warnings.join(' ')).toMatch(/Missing .* candle for Y/);
    expect(r.processed.at(-1)).toBe(dateOf(cs[499]!.t));
  });

  it('live mode pauses instead of silently skipping days that lack enough history', () => {
    const db = openDb(':memory:');
    const r = processC1(db, { X: cs }, S, { ...opts(cs), requireWarmup: true });
    expect(r.processed).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/Not enough history/);
  });
  it('flags large gaps as possible corporate actions', () => {
    const odd = cs.map((c, i) => (i >= 600 ? { ...c, o: c.o * 0.8, h: c.h * 0.8, l: c.l * 0.8, c: c.c * 0.8 } : c));
    const r = processC1(openDb(':memory:'), { X: odd }, S, opts(odd));
    expect(r.warnings.join(' ')).toMatch(/gapped -20\.0%/);
  });

  it('benchmarks: buy-and-hold tracks the ETF; same-exposure moves only with C1\'s invested dollars', () => {
    const db = openDb(':memory:');
    processC1(db, { X: cs }, S, opts(cs));
    const rows = db.prepare('SELECT * FROM c1_daily ORDER BY date').all() as { bench_full_equity: number; bench_matched_equity: number; bench_close: number; invested: number }[];
    const last = rows.at(-1)!;
    expect(last.bench_full_equity).toBeCloseTo((100 / (1 + 5 / 10_000)) * (last.bench_close / rows[0]!.bench_close), 6);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1]!.invested === 0) expect(rows[i]!.bench_matched_equity).toBeCloseTo(rows[i - 1]!.bench_matched_equity, 9);
    }
  });
});

describe('series statistics', () => {
  it('drawdown, return, and no risk-adjusted figure before 60 days', () => {
    const s = seriesStats([110, 99, 121], 100);
    expect(s.netReturnPct).toBeCloseTo(21, 9);
    expect(s.maxDrawdownUsd).toBeCloseTo(11, 9);
    expect(s.maxDrawdownPct).toBeCloseTo(10, 9);
    expect(s.volatilityPct).toBeNull();
    expect(s.sharpeLike).toBeNull();
    expect(seriesStats(Array.from({ length: 80 }, (_, i) => 100 + i + (i % 3)), 100).sharpeLike).not.toBeNull();
  });
});
