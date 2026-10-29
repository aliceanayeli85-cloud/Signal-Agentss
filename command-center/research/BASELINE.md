# Baseline v1 — immutable record

Recorded 2026-10-29, **before** any audit fix. Raw results: [`results/baseline-v1.json`](results/baseline-v1.json)
(write-once; the research CLI refuses to overwrite it). Data fingerprints:
[`results/data-manifest.json`](results/data-manifest.json).

## Code
Engine at commit `5bbefc1`: `src/engine/analysis.ts`, `plan.ts`, `backtest.ts` (`runBacktest`).

## Strategy rules (long only, daily or hourly candles, completed candles only)
Signals are evaluated on the last completed candle. If more than one setup appears, the order of preference is pullback, then breakout, then reversal.

1. **PULLBACK_EMA**
   - Trend must be up: close > EMA20, EMA9 > EMA20, and EMA20 rising versus 5 candles earlier.
   - The signal candle's low reaches the 9 EMA (low ≤ EMA9 × 1.002) and it closes ≥ EMA20.
   - The candle closes green or shows a bullish pattern.
   - Entry: trigger = signal high; entry zone up to high + 0.1 ATR.
   - Stop: min(signal low, EMA20) − 0.1 ATR.
2. **BREAKOUT**
   - Closes above a level touched ≥ 2 times, after the previous close was at or below it.
   - Relative volume ≥ 1.5, RSI ≤ 75, trend not down.
   - Entry: next open.
   - Stop: level − 0.5 ATR.
3. **SUPPORT_REVERSAL**
   - Low within 0.5 ATR of a support level touched ≥ 2 times.
   - Bullish pattern on the candle; RSI between 25 and 50 and rising.
   - Entry: trigger = signal high.
   - Stop: min(low, support) − 0.1 ATR.

**Targets**
- TP1 = nearest resistance if it is within 3R, otherwise 2R.
- TP2 = next resistance, otherwise TP1 plus the same distance again.
- Half the position is sold at TP1, and the stop moves to breakeven on the next candle.
- Time exit after 20 candles.

**Plan filters (all must pass)**
- reward-to-risk at TP1 ≥ 1.5
- RSI ≤ 75
- entry ≤ 2.5 ATR above EMA20
- trend not down (except reversals)
- higher-timeframe trend not down (weekly built from daily; daily built from hourly)
- no failed breakout in the last 3 candles
- position size possible within limits
- not chasing (fill ≤ entry-zone top + 0.25 ATR)

## Risk and cost parameters (`DEFAULT_SETTINGS`)
| Parameter | Value |
| --- | --- |
| Starting capital | $100 |
| Risk per trade | $1, capped at 2% of equity |
| Max position | $50 |
| Daily loss limit | $3 |
| Trades per day | 3 |
| Losses in a row | 2 |
| Cooldown after a loss | 60 min |
| Fractional shares | allowed |
| Slippage | 5 bps per fill |
| Commission | $0 |
| SEC fee | $27.80 per $1M sold |
| FINRA TAF | $0.000166/share, max $8.30 |
| Analysis window | 300 bars |
| Warm-up | 60 bars |
| Max hold | 20 bars |

## Execution assumptions (as coded)
- Signals fill on the next candle: breakouts at the open; trigger setups only if that candle trades through the trigger.
- When one candle touches both the stop and a target, the stop is assumed first. A gap below the stop exits at the open.
- Targets fill as limit orders at the target price. Stops and time exits get slippage.
- One position at a time per ticker. Each ticker is simulated independently with its own $100.

## A) Replication of the results reported on 2026-10-29 (IEX feed)
All six reproduce exactly:

| Run | Bars | Trades | Win % | PF | P&L |
| --- | --- | --- | --- | --- | --- |
| SPY 1Day | 1500 | 16 | 19 | 0.44 | −$5.66 |
| SPY 1Hour | 1740 | 17 | 24 | 0.49 | −$2.16 |
| QQQ 1Day | 1500 | 7 | 29 | 0.78 | −$0.95 |
| QQQ 1Hour | 1704 | 11 | 27 | 0.72 | −$0.99 |
| AAPL 1Day | 1500 | 9 | 44 | 1.07 | +$0.36 |
| AAPL 1Hour | 1775 | 14 | 29 | 0.48 | −$3.32 |

## B) Same baseline, research dataset (SIP daily, 2016-01-04 → 2026-10-27, 10 tickers)
| Period | Trades | Net P&L | PF | Avg R | Win % |
| --- | --- | --- | --- | --- | --- |
| All | 178 | +$21.95 | 1.27 | +0.12 | 48 |
| Training 2016–19 | 70 | +$19.03 | 1.74 | +0.32 | 56 |
| Validation 2020–22 | 43 | −$6.71 | 0.74 | −0.20 | 37 |
| Final test 2023–26 | 65 | +$9.63 | 1.31 | +0.12 | 46 |

Per ticker over the full period: SPY −$3.23, QQQ +$7.70, IWM +$1.18, DIA +$4.15, XLF −$0.26,
XLE +$0.51, AAPL +$3.53, MSFT +$9.23, JPM −$2.84, KO +$1.97.

The IEX runs (A) and the SIP runs (B) disagree for the same ticker and dates. IEX volume is a
small and variable slice of total volume, which changes the breakout volume filter. That is the
first audit item.
