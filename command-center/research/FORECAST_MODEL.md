# Forecast model v1 — Trading Intelligence agent

**Result: NOT VALIDATED at any horizon.** The app therefore shows **INSUFFICIENT EVIDENCE**
instead of probabilities. The model runs in **shadow mode**: its predictions are logged and
scored forward in AI History.

Code: `src/agent/features.ts`, `src/agent/model.ts`. Gate committed before training (commit
`176f784`). Model: `results/forecast-model-v1.json`. Data fingerprints:
`results/forecast-data-manifest.json`.

## Question
For a liquid US stock or ETF, is the close **1, 5 or 20 trading days** from now higher than
today's close? Probability of **direction** is different from probability of reaching a **profit
target**. The latter is estimated separately: the chance of +2 ATR before −1 ATR, assuming the
stop comes first when both happen in one candle.

## Data
- 109 symbols across 13 sector groups (`src/agent/universe.ts`).
- Alpaca consolidated (SIP) daily candles, split-adjusted, 2015–2026-10-28.
- Corporate actions corrected where verified (`src/agent/corporate-actions.ts`): XLF, RTX, T, GE
  ×2, HON spin-offs; DOW history start.

## Features (all use only data up to the decision day's close)
- returns over 1, 5, 20 and 60 days;
- distance from the 50- and 200-day averages;
- RSI(14);
- MACD histogram ÷ price;
- Bollinger %B;
- ATR ÷ price;
- log relative volume;
- 20-day relative strength vs SPY;
- position in the 20-day range;
- SPY 20-day return;
- SPY above or below its 200-day average.

## Method
1. L2 logistic regression, fitted on **training** data (2016–2021). Regularisation is chosen by
   validation log-loss.
2. Histogram calibration: ten buckets of the raw score, fitted on **validation** data (2022–2023).
   Each bucket's probability is the share that actually went up. Expected return, 10th/90th
   percentiles and the target probability come from the same buckets.
3. **Test** (2024-01 → 2026-10) is used only to measure.
4. **Embargo:** a sample belongs to a period only if its whole forward window lies inside that
   period.
5. Uncertainty: a 90% interval for Brier skill, from resampling whole calendar months.

## Gate (fixed before training)
A horizon is VALIDATED only if, on **test** data, all four hold:
- Brier skill vs the constant base rate > 0;
- it beats a simple momentum rule;
- mean calibration error ≤ 3 percentage points;
- the top bucket out-earns the bottom bucket.

## Results
| Horizon | Train / val / test samples | Validation skill | **Test skill** [90% CI] | vs momentum | Calibration error | Test accuracy | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 day | 136,059 / 54,409 / 77,172 | +0.33% | **−0.09%** [−0.30, +0.13] | −0.10% | 1.7 pts | 51.2% | INSUFFICIENT EVIDENCE |
| 5 days | 135,627 / 53,973 / 76,736 | +1.34% | **−0.12%** [−1.10, +0.88] | −0.12% | 2.8 pts | 51.8% | INSUFFICIENT EVIDENCE |
| 20 days | 134,007 / 52,338 / 75,101 | +5.49% | **−2.65%** [−6.80, +1.11] | −2.61% | 9.5 pts | 46.5% | INSUFFICIENT EVIDENCE |

Base rates (share of periods that ended higher, training): 53% / 56% / 61%.

## How to read this
- **The skill seen on validation disappeared on unseen test years.** This is the classic
  in-sample/out-of-sample decay that the three-way split exists to catch. Had the probabilities
  been shown after validation alone, they would have been misleading.
- **The 20-day model was badly miscalibrated on test (9.5 points off).** Validation was the 2022
  bear market and test was the 2024–26 bull market. Market regime shifts break probabilities fitted
  on one regime.
- **Post-hoc observation, not used:** the top bucket out-earned the bottom bucket on test by 0.3% /
  0.8% / 4.9%. Ranking may carry a little information even though the probabilities fail, but this
  was not a pre-registered test. It is being measured forward, in shadow mode.

## Limitations
- Technical and market features only: no fundamentals, earnings, news or options data.
- Samples on the same day are correlated, so effective sample size is much smaller than the row
  count. The month-block intervals account for this.
- Ten survivors-biased large names dominate the universe. Small caps are not modelled.
- Costs are not part of direction scoring. The recommendation layer adds them separately.
- **Any v2** must be specified before training, and judged on data after 2026-10-28 (the live
  forward test), not on the already-used test years.
