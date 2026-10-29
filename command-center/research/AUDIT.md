# Backtester audit — 2026-10-29

Scope: `src/engine/backtest.ts` (`runBacktest`, `simulateExit`), the plan and sizing code it calls,
and the live paper-trading paths that share them.

Each check below was examined in the code, covered by an automated test where possible, and run
against **all 178 baseline trades** on the real SIP data (`npm run research -- audit` writes
[`results/audit.json`](results/audit.json)).

## Material defects found and fixed

| # | Defect | Effect | Fix |
| --- | --- | --- | --- |
| 1 | **Size was not recalculated at the actual fill price.** The position was sized at the top of the entry zone, but fills up to 0.25 ATR higher were accepted. | 10 of 76 normal (non-gap) stop-outs lost more than the $1 budget, up to −1.15R. **The same flaw was in live paper approval.** | Backtest and paper fills now re-size at the fill price. Tests in `server.test.ts` and `plan-orders-backtest.test.ts`. |
| 2 | **Take-profit limit orders counted as filled when price merely touched the target.** | Optimistic: a touch does not guarantee a limit fill. | Targets fill only if price trades **at least 1¢ through** the target, in both the backtest and the paper monitor. |
| 3 | **The position cap and cash check ignored entry slippage.** | Cash spent could exceed the $50 cap or available cash by a few cents (21 trades) — technically borrowing. | Caps now apply to price including slippage. |
| 4 | **Live daily signals used IEX volume while research used consolidated volume.** IEX is only 1.3–1.8% of total volume. | Live signals would not match the tested rules. | Daily candles now come from the consolidated (SIP) feed, ≥16 minutes old (free plan), falling back to IEX if refused. Intraday stays on real-time IEX. |
| 5 | **Stray isolated bar.** IEX history contains a single 2018 SPY print, followed by a 20-month gap. | Would corrupt indicators if included (it was not, in the reported runs). | Research data cleaning cuts any series at its last gap longer than 5 days, and reports it. The SIP data had no gaps. |

## Checks that passed (0 violations on 178 real trades)

- **No look-ahead.** Cutting the data at 2018-06-29, 2021-06-30 and 2024-06-28 leaves every trade
  that closed before the cut unchanged, for all 10 tickers. Strategies only receive candles up to
  the decision bar.
- **Entries happen only after conditions are met.** Every entry is on a later candle than its
  signal. Every entry price lies within that candle's range. Trigger entries happen only when the
  candle actually trades through the trigger (or gaps above it: fill at the open).
- **Conservative stops.** If one candle spans both the stop and a target, the stop is assumed
  first. A gap below the stop exits at the (worse) open. After take-profit 1, the breakeven stop
  only applies from the next candle.
- **Costs.** Slippage on every market-type fill. SEC + FINRA sell fees rounded up. Commission as
  configured.
- **Capital.** No position over $50 or over equity, including slippage. No non-gap stop loses more
  than the budget.
- **No double counting.**
  - At most one open trade per ticker, and trades never overlap.
  - Each trade belongs to exactly one period (by entry date).
  - Duplicate timestamps are removed before analysis.
  - Exposure counts each day at most once.

## Known modelling limits (not defects, but they affect results)

- **Gap risk is real.** 13 of 178 stops were gaps below the stop. The worst cost **−2.79R**
  (−$2.79 on a $1 plan). The $1 budget is a plan, not a guarantee.
- **Partial fills are not modelled.** Orders are tiny ($50 or less in very liquid names), so full
  fills are realistic for market-type orders. A limit order may still not fill — the 1¢
  trade-through rule is the mitigation.
- **Dividends.** Strategy trades use split-adjusted (not dividend-adjusted) prices. Ex-dividend drops
  count against open trades (conservative). Buy-and-hold benchmarks use total-return
  (dividend-adjusted) prices.
- **Each ticker is simulated as its own $100 account.** Pooled results measure the per-trade edge.
  They are not the P&L of one $100 account trading all ten tickers.
- **Ticker list survivorship.** All ten names exist and are large today. Stocks that were delisted
  or shrank are not represented.
- **Hourly candles** include the 9:00–9:30 pre-market inside the first bar. Research here uses daily
  candles only.
- **Time exit.** "20 bars" means 20 candles after the entry candle, so 21 candles including the
  entry day.

## Sensitivity observed

For the same ticker and dates, switching between IEX and SIP data changes results materially.
QQQ goes from −$0.95 to +$3.93, and SPY from −$5.57 to −$3.13. Daily highs differ by a median of
under 0.01%. When a fraction of a cent decides whether a trade triggers, a sample of 6–20 trades is
dominated by noise. Results need many trades, across several independent periods, before they mean
anything.
