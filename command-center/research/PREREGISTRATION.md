# Pre-registration — strategy research v1

Written and committed **before any candidate strategy was run on market data**. Git history
records the order. Code: `src/research/strategies.ts` (rules), `src/research/decision.ts`
(decision rule), `src/research/config.ts` (data and periods).

## Question
Does any simple, explainable long-only rule set show a repeatable edge after costs, across
independent periods, at a $1 risk per trade? An edge here means positive average R per trade.

## Data
- Alpaca consolidated (SIP) daily candles, split-adjusted, 2016-01-04 → 2026-10-27.
- Total-return (dividend-adjusted) candles are used **only** for buy-and-hold benchmarks.
- Tickers, fixed in advance: SPY, QQQ, IWM, DIA, XLF, XLE, AAPL, MSFT, JPM, KO. These cover the
  broad market, small caps, financials, energy, mega-cap tech and a defensive stock.

## Chronological periods
| Period | Dates | Purpose | Regimes |
| --- | --- | --- | --- |
| Training | 2016–2019 | Rules are fixed in advance, so nothing is fitted here. Used for defect checks and as one independent period. | low-vol bull, 2018 sell-offs |
| Validation | 2020–2022 | Compare candidates and decide which advance. | COVID crash, 2021 bull, 2022 bear |
| Final test | 2023-01-01 → 2026-10-27 | **Untouched.** Evaluated once, after the validation decisions are committed. | 2023–24 bull, 2025 sell-off |

- **Validation step:** data is cut off at 2022-12-31, so final-test candles cannot influence it.
- **Final test:** each strategy runs over the full series, and trades are attributed to the period
  in which they were entered.
- **Walk-forward:** with fixed rules there is nothing to re-fit, so walk-forward reduces to
  evaluating each later window out-of-sample. Results are also reported calendar year by calendar
  year, to show consistency across regimes.

## Candidates (all long only, daily candles)
- **C0 Baseline (audited):** the live engine's rules, unchanged apart from the audit fixes. See
  [BASELINE.md](BASELINE.md).
- **C1 Trend following**
  - Entry: close > 100-day SMA, and close > the prior 20-day high → buy at the next open.
  - Stop: signal close − 2 × ATR(14).
  - Exit: a close below the prior 10-day low → sell at the next open. Maximum hold 120 days. No
    profit target.
- **C2 Breakout, confirmed**
  - Signal: close > the prior 20-day high, on volume ≥ 1.5 × the 20-day average, closing in the
    top 25% of the day's range.
  - Trend filter: close > 50-day SMA, and the 50-day SMA rising over 10 days.
  - Entry: the next day must trade above the signal high (fill no more than 0.25 ATR above it).
  - Stop: signal low − 0.1 ATR.
  - Exits: half at +1.5R, then a breakeven stop; the rest at +3R; maximum hold 20 days.
- **C3 Pullback in a long-term uptrend**
  - Trend filter: close > 200-day SMA, and 50-day SMA > 200-day SMA.
  - Signal: the day's low reaches the 20 EMA, and the day closes green above the 20 EMA.
  - Entry: the next day must trade above the signal high (fill no more than 0.25 ATR above it).
  - Stop: lowest low of the last 5 days − 0.1 ATR.
  - Exits: same as C2.

Parameters are textbook defaults. **No parameter search will be run.** If a variation is wanted
later, it becomes v2, with a new untouched period (future paper trading).

## Execution and risk (identical for every candidate)
- $1 risk per trade, capped at 2% of equity. Size is recalculated at the actual fill price.
- $50 position cap, including slippage. Fractional shares.
- Live risk guard applied: $3 daily loss limit, 2 losses in a row, 3 trades per day, 60-minute
  cooldown.
- Slippage 5 bps per market fill. **Stress test:** 15 bps.
- SEC and FINRA sell fees; $0 commission.
- Stops: a gap exits at the open. If a candle spans both stop and target, the stop counts first.
- Targets fill only when price trades at least 1¢ through them.
- Each ticker is simulated as a separate $100 account. Edge is measured on pooled trades.

## Reported for every strategy × ticker × period
- Trades and net return after costs.
- Expectancy, in $ and in R, with a 90% bootstrap interval.
- Profit factor and win rate.
- Average win and average loss.
- Maximum drawdown.
- Exposure: % of days in a position.
- Benchmarks: buy-and-hold total return, and doing nothing ($0).

## Decision rule (applied mechanically to pooled trades; `decision.ts`)
**After validation (stage 1):**
- **REJECTED** if:
  - any unresolved defect, or
  - validation has ≥ 30 trades and its average R ≤ 0, or
  - validation has ≥ 30 trades and its profit factor < 1.
- **Advances** to the final test only if **all** of these hold:
  - ≥ 30 validation trades;
  - average R > 0 in **both** training and validation;
  - validation profit factor ≥ 1.15;
  - validation average R still > 0 at 15 bps slippage.

**After the final test (stage 2):**
- **REJECTED** if the final test has ≥ 30 trades and average R ≤ 0.
- **CANDIDATE FOR EXTENDED PAPER TESTING** only if it advanced **and** all of these hold:
  - ≥ 30 final-test trades;
  - average R > 0;
  - profit factor ≥ 1.1;
  - still > 0 at 15 bps;
  - positive average R on ≥ 50% of tickers with ≥ 3 trades over validation + test.
- **INSUFFICIENT EVIDENCE:** everything else, including any strategy that did not advance.
  A good final test cannot promote it.

Even a candidate is **not** called profitable. It only earns more paper trading. The bootstrap
interval is reported: if it includes zero, the edge is not statistically distinguishable from
none.
