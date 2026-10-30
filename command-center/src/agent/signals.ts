import { analyze, type Analysis } from '../engine/analysis.js';
import { atr, ema, rsi, sma } from '../engine/indicators.js';
import type { Candle } from '../engine/types.js';

/**
 * Measurable scanner signals. Each is a yes/no condition on COMPLETED daily
 * candles with its numbers attached, so the user can check it on a chart.
 * None of them is a prediction.
 */
export interface Signal {
  id: string;
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  detail: string;
}

export interface Technicals {
  close: number;
  date: number;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema20: number | null;
  rsi14: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbPctB: number | null;
  bbWidthPercentile: number | null;
  atr14: number | null;
  atrPct: number | null;
  relVolume: number | null;
  avgDollarVolume: number | null;
  ret20: number | null;
  relStrength20: number | null;
  high20: number | null;
  low20: number | null;
  low10: number | null;
  dailyVwap: number | null;
}

export function technicals(cs: Candle[], spy: Candle[] | null): Technicals {
  const n = cs.length;
  const closes = cs.map((c) => c.c);
  const last = cs[n - 1]!;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const e20 = ema(closes, 20);
  const r = rsi(closes, 14);
  const a = atr(cs, 14);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null));
  const f = macd.findIndex((v) => v !== null);
  const sig = f >= 0 ? ema(macd.slice(f) as number[], 9) : [];
  const hist = (i: number) => (macd[i] != null && sig[i - f] != null ? macd[i]! - sig[i - f]! : null);
  const sd = (i: number) => {
    if (i < 19 || s20[i] == null) return null;
    let v = 0;
    for (let k = i - 19; k <= i; k++) v += (closes[k]! - s20[i]!) ** 2;
    return Math.sqrt(v / 20);
  };
  const widths: number[] = [];
  for (let i = Math.max(19, n - 126); i < n; i++) {
    const d = sd(i);
    if (d !== null && s20[i]) widths.push((4 * d) / s20[i]!);
  }
  const w = widths.at(-1);
  const d = sd(n - 1);
  const window = (len: number, end = n - 1) => cs.slice(Math.max(0, end - len + 1), end + 1);
  let vol = 0;
  for (let k = Math.max(0, n - 21); k < n - 1; k++) vol += cs[k]!.v;
  vol /= Math.min(20, n - 1);
  let dollar = 0;
  for (let k = Math.max(0, n - 20); k < n; k++) dollar += cs[k]!.v * cs[k]!.c;
  dollar /= Math.min(20, n);
  const ret20 = n > 20 ? last.c / closes[n - 21]! - 1 : null;
  const spyRet = spy && spy.length > 20 ? spy.at(-1)!.c / spy.at(-21)!.c - 1 : null;
  const bbU = s20[n - 1] != null && d !== null ? s20[n - 1]! + 2 * d : null;
  const bbL = s20[n - 1] != null && d !== null ? s20[n - 1]! - 2 * d : null;
  return {
    close: last.c,
    date: last.t,
    sma20: s20[n - 1] ?? null,
    sma50: s50[n - 1] ?? null,
    sma200: s200[n - 1] ?? null,
    ema20: e20[n - 1] ?? null,
    rsi14: r[n - 1] ?? null,
    macdHist: hist(n - 1),
    bbUpper: bbU,
    bbLower: bbL,
    bbPctB: bbU !== null && bbL !== null && bbU > bbL ? (last.c - bbL) / (bbU - bbL) : null,
    bbWidthPercentile: w !== undefined && widths.length > 20 ? widths.filter((x) => x <= w).length / widths.length : null,
    atr14: a[n - 1] ?? null,
    atrPct: a[n - 1] != null ? a[n - 1]! / last.c : null,
    relVolume: vol > 0 ? last.v / vol : null,
    avgDollarVolume: dollar,
    ret20,
    relStrength20: ret20 !== null && spyRet !== null ? ret20 - spyRet : null,
    high20: n > 20 ? Math.max(...window(20, n - 2).map((c) => c.h)) : null,
    low20: n > 20 ? Math.min(...window(20, n - 2).map((c) => c.l)) : null,
    low10: n > 10 ? Math.min(...window(10, n - 2).map((c) => c.l)) : null,
    dailyVwap: last.vw ?? null,
  };
}

/** Returns every signal that is TRUE on the latest completed candle. */
export function detectSignals(cs: Candle[], t: Technicals, an: Analysis): Signal[] {
  const out: Signal[] = [];
  const n = cs.length;
  const c = cs[n - 1]!;
  const prev = cs[n - 2]!;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (t.relVolume !== null && t.relVolume >= 2) out.push({ id: 'unusual_volume', label: 'Unusual volume', direction: c.c >= prev.c ? 'bullish' : 'bearish', detail: `Volume was ${t.relVolume.toFixed(1)}× its 20-day average on a ${c.c >= prev.c ? 'up' : 'down'} day.` });
  if (t.relStrength20 !== null && t.relStrength20 >= 0.05) out.push({ id: 'relative_strength', label: 'Relative strength', direction: 'bullish', detail: `Up ${pct(t.ret20!)} over 20 days, ${pct(t.relStrength20)} better than SPY.` });
  if (t.relStrength20 !== null && t.relStrength20 <= -0.05) out.push({ id: 'relative_weakness', label: 'Relative weakness', direction: 'bearish', detail: `${pct(t.ret20!)} over 20 days, ${pct(-t.relStrength20)} worse than SPY.` });
  if (t.high20 !== null && c.c > t.high20) out.push({ id: 'breakout_20d', label: '20-day breakout', direction: 'bullish', detail: `Closed $${c.c.toFixed(2)} above the prior 20-day high $${t.high20.toFixed(2)}.` });
  if (t.low20 !== null && c.c < t.low20) out.push({ id: 'breakdown_20d', label: '20-day breakdown', direction: 'bearish', detail: `Closed $${c.c.toFixed(2)} below the prior 20-day low $${t.low20.toFixed(2)}.` });
  for (const s of an.setups) out.push({ id: `setup_${s.type.toLowerCase()}`, label: s.label, direction: 'bullish', detail: s.reasonsFor.join(' ') });
  for (const e of an.events) if (e.kind === 'failed_breakout') out.push({ id: 'failed_breakout', label: 'Failed breakout', direction: 'bearish', detail: e.explanation });
  const closes = cs.map((x) => x.c);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const e20 = ema(closes, 20);
  const crossed = (a: (number | null)[], b: (number | null)[], lookback: number, up: boolean) => {
    for (let k = n - lookback; k < n; k++) {
      if (k < 1 || a[k] == null || b[k] == null || a[k - 1] == null || b[k - 1] == null) continue;
      if (up ? a[k - 1]! <= b[k - 1]! && a[k]! > b[k]! : a[k - 1]! >= b[k - 1]! && a[k]! < b[k]!) return true;
    }
    return false;
  };
  if (crossed(s50, s200, 5, true)) out.push({ id: 'golden_cross', label: 'Golden cross', direction: 'bullish', detail: '50-day average crossed above the 200-day average in the last 5 days.' });
  if (crossed(s50, s200, 5, false)) out.push({ id: 'death_cross', label: 'Death cross', direction: 'bearish', detail: '50-day average crossed below the 200-day average in the last 5 days.' });
  if (crossed(e20, s50, 3, true)) out.push({ id: 'ema20_cross_up', label: '20 EMA crossed above 50-day', direction: 'bullish', detail: 'Short-term average crossed above the medium-term average in the last 3 days.' });
  if (t.rsi14 !== null && t.rsi14 < 30) out.push({ id: 'rsi_oversold', label: 'RSI oversold', direction: 'neutral', detail: `RSI ${t.rsi14.toFixed(0)} (below 30). Stretched down; can stay that way.` });
  if (t.rsi14 !== null && t.rsi14 > 70) out.push({ id: 'rsi_overbought', label: 'RSI overbought', direction: 'neutral', detail: `RSI ${t.rsi14.toFixed(0)} (above 70). Stretched up; buying here means chasing.` });
  const r = rsi(closes, 14);
  if (r[n - 1] != null && r[n - 2] != null && r[n - 2]! < 30 && r[n - 1]! >= 30) out.push({ id: 'rsi_reversal', label: 'Possible reversal (RSI back above 30)', direction: 'bullish', detail: 'RSI climbed back above 30 after being oversold. Reversals in downtrends often fail.' });
  if (t.macdHist !== null) {
    const ti = technicals(cs.slice(0, -1), null).macdHist;
    if (ti !== null && ti <= 0 && t.macdHist > 0) out.push({ id: 'macd_cross_up', label: 'MACD turned positive', direction: 'bullish', detail: 'MACD histogram crossed above zero on the last candle.' });
    if (ti !== null && ti >= 0 && t.macdHist < 0) out.push({ id: 'macd_cross_down', label: 'MACD turned negative', direction: 'bearish', detail: 'MACD histogram crossed below zero on the last candle.' });
  }
  if (t.bbUpper !== null && c.c > t.bbUpper) out.push({ id: 'bollinger_upper', label: 'Above upper Bollinger Band', direction: 'neutral', detail: 'Closed above the upper band: strong, but statistically stretched.' });
  if (t.bbLower !== null && c.c < t.bbLower) out.push({ id: 'bollinger_lower', label: 'Below lower Bollinger Band', direction: 'neutral', detail: 'Closed below the lower band: weak, but statistically stretched.' });
  if (t.bbWidthPercentile !== null && t.bbWidthPercentile <= 0.1) out.push({ id: 'bollinger_squeeze', label: 'Volatility squeeze', direction: 'neutral', detail: 'Bollinger Bands are the narrowest in 6 months. A large move often follows — direction unknown.' });
  if (t.dailyVwap !== null && t.relVolume !== null && t.relVolume >= 1.5) {
    out.push({ id: c.c >= t.dailyVwap ? 'above_vwap' : 'below_vwap', label: c.c >= t.dailyVwap ? 'Closed above session VWAP' : 'Closed below session VWAP', direction: c.c >= t.dailyVwap ? 'bullish' : 'bearish', detail: `On heavy volume, closed ${c.c >= t.dailyVwap ? 'above' : 'below'} the day's volume-weighted average price $${t.dailyVwap.toFixed(2)}.` });
  }
  if (an.support && t.atr14 !== null && Math.abs(c.c - an.support.price) <= t.atr14 * 0.5) out.push({ id: 'at_support', label: 'At support', direction: 'neutral', detail: `Within half a day's range of support $${an.support.price.toFixed(2)} (${an.support.touches} touches).` });
  if (an.resistance && t.atr14 !== null && Math.abs(an.resistance.price - c.c) <= t.atr14 * 0.5) out.push({ id: 'at_resistance', label: 'At resistance', direction: 'neutral', detail: `Within half a day's range of resistance $${an.resistance.price.toFixed(2)} (${an.resistance.touches} touches).` });
  if (t.atrPct !== null && t.atrPct >= 0.05) out.push({ id: 'high_volatility', label: 'High volatility', direction: 'neutral', detail: `Typical daily range ${pct(t.atrPct)} of the price.` });
  return out;
}

export function runAnalysis(cs: Candle[]): Analysis {
  return analyze(cs.slice(-300), '1Day');
}
