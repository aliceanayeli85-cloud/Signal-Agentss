# Strategy research report — v1 / v1.1

**Date:** 2026-10-29.
**Data:** Alpaca consolidated (SIP) daily candles, 2016-01-04 → 2026-10-27, for SPY, QQQ, IWM,
DIA, XLF, XLE, AAPL, MSFT, JPM and KO.
**Risk:** $1 per trade (2% equity cap), $50 position cap, all daily limits on.
**Costs:** 5 bps slippage per fill (15 bps stress test) plus regulatory fees.

Full tables: [`results/tables-v1.1.md`](results/tables-v1.1.md).
Process documents: [BASELINE.md](BASELINE.md), [AUDIT.md](AUDIT.md),
[PREREGISTRATION.md](PREREGISTRATION.md).

## Bottom line

| Strategy | Verdict |
| --- | --- |
| Baseline (current dashboard rules) | **REJECTED** |
| C1 Trend following (20-day breakout, 10-day exit) | **CANDIDATE FOR EXTENDED PAPER TESTING**, with a major caveat |
| C2 Confirmed breakout | **INSUFFICIENT EVIDENCE** |
| C3 Pullback in a long-term uptrend | **INSUFFICIENT EVIDENCE** |

**No strategy here is shown to be profitable.**

The one candidate made money in every period, but it did **not** pick better days than the market
itself. Its profit comes from being invested while prices rose, at a small and controlled size, and
it earned **less** than simply holding the same money on the same days. That is risk control, not a
proven trading edge.

---

## 1. What was wrong with the baseline

**Defects fixed in the engine** (details in [AUDIT.md](AUDIT.md)):
1. **Size was not recalculated at the fill price.** 10 of 76 normal stop-outs lost more than the
   $1 budget. The same flaw was in live paper trading. Fixed in both.
2. **Take-profits counted as filled on a mere touch.** Now price must trade 1¢ through the target.
3. **The $50 cap and cash check ignored slippage.** A few cents of borrowing. Fixed.
4. **Live daily signals used IEX volume** (under 2% of the market), while research used
   consolidated volume. Live daily candles now use the consolidated feed.
5. **A spin-off showed up as a fake crash.** XLF's 2016 real-estate spin-off appeared as an −18%
   overnight drop, because Alpaca adjusts for neither. It cost one trend trade −7.5R. Now
   corrected. **v1.1** re-runs the identical rules on the corrected data. It was run after v1's
   final test had been seen, so it is a data-correction check, not a fresh test. Verdicts were
   unchanged. v1 stays recorded as the clean, pre-registered run.

After the fixes, all 178 baseline trades pass every audit check:
- no look-ahead (truncation tests at three dates);
- entries only after the conditions were met;
- nothing over the budget or the position cap;
- no overlaps or double counting.

**The strategy itself:** before the fixes, and with the identical rules, the baseline lost money
in validation (2020–2022). It lost 0.19R per trade over 43 trades (PF 0.74), and still lost at
15 bps slippage. The pre-registered rule therefore rejects it.

Two more problems:
- It trades rarely: 178 trades in 10 years across 10 tickers. Small samples swing a lot. Switching
  data feeds alone moved QQQ from −$0.95 to +$3.93.
- It earned less than holding the same money on the same days in every period (it was invested
  9% of the time).

The dashboard now shows this status on every plan.

## 2. Alternatives tested

All three rules and the decision rule were committed before any of them was run (commit
`26db71b`). Every parameter is a textbook default; no parameter search was done.

- **C1 Trend following**
  - Entry: price above its 100-day average closes at a new 20-day high → buy at the next open.
  - Stop: 2 ATR below the signal close.
  - Exit: at the next open after a close below the 10-day low.
- **C2 Confirmed breakout:** a 20-day high on ≥ 1.5× average volume, a strong close and a rising
  50-day average. The next day must trade above the breakout high. Exits: half at +1.5R, the rest
  at +3R.
- **C3 Pullback in an uptrend:** above the 200-day average, with the 50-day above the 200-day.
  A dip to the 20-day EMA that closes green. The next day must trade above its high. Same exits
  as C2.

## 3. Results and verdicts

Pooled across 10 tickers. Avg R ≈ average dollars per trade at $1 risk. CI = 90% bootstrap
interval for Avg R.

| Strategy | Training 2016–19 | Validation 2020–22 | **Final test 2023–26 (untouched)** | Verdict |
| --- | --- | --- | --- | --- |
| Baseline | 70 trades, +0.32R | 43 trades, **−0.19R**, PF 0.74 | 65 trades, +0.11R, CI [−0.16, +0.38] | **REJECTED** |
| C1 Trend | 165, +0.51R | 121, +0.14R, PF 1.32, CI [−0.06, +0.36] | 179, **+0.29R**, PF 1.72, CI [+0.09, +0.49] | **CANDIDATE** |
| C2 Breakout | 34, −0.01R | **16 trades**, −0.19R | 24, +0.21R, CI [−0.19, +0.62] | **INSUFFICIENT EVIDENCE** |
| C3 Pullback | 170, +0.22R | 133, +0.04R, PF 1.12; **−0.01R at 15 bps** | 215, +0.03R, CI [−0.09, +0.16] | **INSUFFICIENT EVIDENCE** |

Why each verdict:

- **Baseline:** lost money in validation with ≥ 30 trades. Its positive final test cannot rescue
  it, because a strategy must pass validation first.
- **C2:** far too few trades: 74 in 10 years over 10 tickers, only 16 in validation. It was
  negative in both training and validation. The positive final test (24 trades) is
  indistinguishable from luck.
- **C3:** a hair above zero in validation, and **negative once slippage is 15 bps**. The final test
  confirms an edge of about zero (+0.03R, CI −0.09 to +0.16). With costs, it is roughly a coin flip.
- **C1:** met every pre-registered condition:
  - positive in all three periods;
  - final test 179 trades, PF 1.72, CI above zero;
  - still positive at 15 bps (+0.22R);
  - positive on 8 of 10 tickers;
  - it lost only in down years (2018, 2022, 2025), as long-only trend following should.

## 4. Does anything merit further paper trading?

**C1 — yes, as an experiment. Not as a money-maker.** Read these before deciding:

- **No evidence of timing skill (post-hoc check, not used for the verdict).**
  - On the days C1 was invested, the stocks rose 5.3 / 6.0 / 5.8 basis points per day, versus
    7.1 / 5.8 / 8.4 on all days (training / validation / test).
  - Holding the same money on the same days would have earned more in every period. In the final
    test that was $63.70, versus C1's $53.74.
  - C1 captures market drift while limiting exposure (in the market about 45% of days). It does
    not find better moments.
- **Far behind plain buy-and-hold.** Over the final test, C1 made about $5.37 per $100 account,
  while buy-and-hold made +60% to +174%. Mostly that's because $1 risk means positions of about
  $31 on average. But it means this strategy alone will not grow $100 meaningfully.
- **It depends on a few big winners.** The top 10 of 465 trades produced about half of all profit.
  Missing a few of them, through hesitation or a skipped day, changes the result a lot.
- **It needs a falling-market test.** It lost in 2018, 2022 and 2025. A long bear market has not
  been tested in its most recent form.

**Suggested paper-trading plan, if you want it:**
- Run C1 unchanged, in paper only, for at least 30 more trades (roughly 6–12 months across these
  10 tickers).
- Track it against buy-and-hold of the same tickers.
- Judge it on average R and drawdown, not on any single win.

I can add C1 to the dashboard as a paper-only strategy, but have **not** done so without your
go-ahead.

> **Update 2026-10-29:** with your go-ahead, C1 was added as a separate paper-only portfolio,
> labelled EXPERIMENTAL — NOT PROVEN PROFITABLE. Protocol:
> [C1_PAPER_PROTOCOL.md](C1_PAPER_PROTOCOL.md). The benchmark was set to SPY (a predefined ETF),
> plus an SPY same-exposure comparison. This report's findings are unchanged.

**For a v2 (future work, to be pre-registered first):** add a timing-skill criterion (a strategy
must beat same-capital holding) and a random-entry benchmark.

## 5. Remaining limitations

- **Data**
  - Ten survivors chosen today (survivorship bias).
  - Daily candles only.
  - Corporate actions corrected only where found (one spin-off).
  - Dividends are not credited on open trades (conservative).
  - No earnings or news data.
- **Execution**
  - Fills are modelled from daily OHLC. Intraday order sequence is unknown, so the stop is assumed
    first.
  - Partial fills are not modelled.
  - Gap losses are real: up to −2.8R, beyond the $1 plan.
  - Robinhood stop orders may not be available for fractional shares.
  - Paper trading cannot reproduce real fills or emotions.
- **Statistics**
  - About 120–215 trades per period are still modest. Most confidence intervals are wide, and
    several include zero.
  - Each ticker is a separate $100 account: the pooled numbers measure edge per trade, not one
    real $100 account trading all ten.
  - Four strategies were compared, so the best of four looks better than it is (a small
    multiple-comparison effect).
  - The final test has now been used. Any change to C1 must be judged on **new** data, such as
    future paper trades — never by re-running 2023–2026.
- **Not done (by design):** parameter optimisation, live execution, any increase in risk.

## Reproduce
```bash
cd command-center
npm run research -- fetch          # download data (needs Alpaca keys)
npm run research -- audit          # backtester invariants on real trades
npm run research -- validate v1.1  # validate/final refuse to overwrite recorded results; delete them first to re-run
npm run research -- final v1.1
npm run research -- diagnose v1.1
npm run research -- tables v1.1
```
