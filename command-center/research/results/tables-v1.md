# Full results (v1)

Generated from `results/final-v1.json`. Each ticker is a separate $100 account; pooled return is on the combined $1000. R = profit ÷ planned risk (≈ $1).

## Buy-and-hold benchmarks (total return, 100% invested)

| Ticker | Training 2016–2019 | Validation 2020–2022 | Final test 2023–2026 |
| --- | --- | --- | --- |
| SPY | 71.9% | 24.0% | 109.9% |
| QQQ | 101.6% | 26.8% | 174.2% |
| IWM | 58.1% | 8.6% | 66.5% |
| DIA | 82.1% | 22.6% | 67.7% |
| XLF | 46.1% | 18.0% | 72.3% |
| XLE | 15.5% | 68.4% | 77.2% |
| AAPL | 206.3% | 79.1% | 171.2% |
| MSFT | 214.8% | 55.4% | 125.2% |
| JPM | 140.5% | 5.1% | 172.5% |
| KO | 48.9% | 26.3% | 60.0% |

No-trade baseline: $0.00 and 0% in every period.

## C0_BASELINE_AUDITED — Baseline (audited engine)

**Verdict: REJECTED.** Validation lost money over 43 trades (avg -0.191R).

| Period | Trades | Net | Return | Exp. $ | Avg R | 90% CI (R) | PF | Win % | Avg win | Avg loss | Max DD | Exposure | Avg R @15 bps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| train | 70 | $18.82 | 1.88% | 0.27 | 0.32 | [0.05, 0.60] | 1.73 | 56 | 1.14 | -0.83 | $6.26 | 9% | 0.20 |
| validation | 43 | −$6.58 | -0.66% | -0.15 | -0.19 | [-0.48, 0.11] | 0.74 | 37 | 1.15 | -0.93 | $10.04 | 6% | -0.24 |
| test | 65 | $9.17 | 0.92% | 0.14 | 0.11 | [-0.16, 0.38] | 1.29 | 46 | 1.35 | -0.89 | $13.28 | 9% | 0.03 |
| all | 178 | $21.41 | 2.14% | 0.12 | 0.12 | [-0.05, 0.28] | 1.26 | 48 | 1.22 | -0.88 | $13.28 | 9% | — |

**By calendar year (pooled):** 2016: 18t -0.35R · 2017: 26t 0.56R · 2018: 11t 0.20R · 2019: 15t 0.79R · 2020: 9t 0.27R · 2021: 27t -0.32R · 2022: 7t -0.29R · 2023: 13t 0.86R · 2024: 22t 0.39R · 2025: 18t -0.18R · 2026: 12t -0.78R

**Timing diagnostic (post-hoc):** train: in-market 7.9 bp/day vs all days 7.0; strategy $18.82 vs same-capital hold $26.87 · validation: in-market -1.1 bp/day vs all days 5.8; strategy −$6.58 vs same-capital hold −$5.34 · test: in-market 3.7 bp/day vs all days 8.4; strategy $9.17 vs same-capital hold $12.70

| Ticker | train trades / net / avg R / PF / DD / exposure | validation trades / net / avg R / PF / DD / exposure | test trades / net / avg R / PF / DD / exposure |
| --- | --- | --- | --- |
| SPY | 12 / $2.16 / 0.28 / 1.63 / $1.47 / 16% | 9 / −$7.47 / -0.92 / 0.09 / $8.24 / 10% | 15 / $1.91 / -0.04 / 1.29 / $4.95 / 17% |
| QQQ | 11 / $1.77 / 0.05 / 1.40 / $2.06 / 13% | 6 / $2.03 / 0.31 / 1.75 / $1.75 / 12% | 3 / $3.72 / 1.24 / 5.30 / $0.86 / 5% |
| IWM | 7 / $1.01 / 0.13 / 1.36 / $2.76 / 11% | 1 / $1.99 / 2.02 / — / $0.00 / 3% | 6 / −$1.81 / -0.30 / 0.51 / $2.76 / 10% |
| DIA | 10 / $6.79 / 1.12 / 6.53 / $0.85 / 15% | 6 / −$3.80 / -0.76 / 0.20 / $4.72 / 9% | 8 / $1.25 / 0.09 / 1.65 / $1.00 / 12% |
| XLF | 4 / −$3.38 / -1.00 / 0.00 / $3.38 / 3% | 5 / −$1.13 / -0.23 / 0.62 / $1.98 / 6% | 7 / $4.23 / 0.70 / 2.96 / $1.20 / 13% |
| XLE | 2 / $3.22 / 1.68 / — / $0.00 / 3% | 4 / $0.95 / 0.25 / 1.97 / $0.98 / 7% | 2 / −$3.68 / -1.90 / 0.00 / $3.68 / 0% |
| AAPL | 5 / $2.71 / 0.59 / 1.92 / $2.94 / 5% | 2 / $0.01 / -0.02 / 1.01 / $0.95 / 2% | 6 / $0.76 / 0.14 / 1.22 / $2.54 / 10% |
| MSFT | 11 / $1.40 / 0.09 / 1.27 / $3.33 / 15% | 5 / $1.67 / 0.26 / 2.09 / $1.53 / 9% | 7 / $6.04 / 0.96 / 5.99 / $0.96 / 13% |
| JPM | 3 / $1.98 / 0.65 / 3.10 / $0.95 / 6% | 1 / −$0.95 / -1.00 / 0.00 / $0.95 / 1% | 7 / −$3.88 / -0.59 / 0.32 / $4.75 / 8% |
| KO | 5 / $1.17 / 0.20 / 1.89 / $0.96 / 7% | 4 / $0.13 / 0.15 / 1.07 / $1.00 / 6% | 4 / $0.64 / 0.15 / 1.33 / $1.93 / 6% |

## C1_TREND_FOLLOW — Trend following: 20-day breakout, 10-day exit

**Verdict: CANDIDATE FOR EXTENDED PAPER TESTING.** Positive in training, validation and the untouched final test; survives tripled slippage; broad across tickers. This is NOT proof of future profitability.

| Period | Trades | Net | Return | Exp. $ | Avg R | 90% CI (R) | PF | Win % | Avg win | Avg loss | Max DD | Exposure | Avg R @15 bps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| train | 164 | $65.06 | 6.51% | 0.40 | 0.45 | [0.16, 0.74] | 1.90 | 48 | 1.77 | -0.84 | $18.24 | 43% | 0.34 |
| validation | 121 | $17.77 | 1.78% | 0.15 | 0.14 | [-0.06, 0.36] | 1.32 | 41 | 1.47 | -0.79 | $12.05 | 40% | 0.09 |
| test | 179 | $53.74 | 5.37% | 0.30 | 0.29 | [0.09, 0.49] | 1.72 | 44 | 1.63 | -0.75 | $15.61 | 47% | 0.22 |
| all | 464 | $136.58 | 13.66% | 0.29 | 0.31 | [0.17, 0.45] | 1.67 | 45 | 1.64 | -0.79 | $18.24 | 45% | — |

**By calendar year (pooled):** 2016: 27t 1.02R · 2017: 49t 0.72R · 2018: 38t -0.29R · 2019: 50t 0.42R · 2020: 37t 0.26R · 2021: 50t 0.36R · 2022: 34t -0.30R · 2023: 43t 0.66R · 2024: 50t 0.15R · 2025: 47t -0.11R · 2026: 39t 0.54R

**Timing diagnostic (post-hoc):** train: in-market 4.7 bp/day vs all days 7.0; strategy $65.06 vs same-capital hold $72.45 · validation: in-market 6.0 bp/day vs all days 5.8; strategy $17.77 vs same-capital hold $34.32 · test: in-market 5.8 bp/day vs all days 8.4; strategy $53.74 vs same-capital hold $63.70

| Ticker | train trades / net / avg R / PF / DD / exposure | validation trades / net / avg R / PF / DD / exposure | test trades / net / avg R / PF / DD / exposure |
| --- | --- | --- | --- |
| SPY | 17 / $5.72 / 0.34 / 2.21 / $1.80 / 51% | 15 / −$0.39 / -0.03 / 0.95 / $3.24 / 48% | 22 / $5.98 / 0.26 / 1.74 / $2.49 / 56% |
| QQQ | 18 / $7.53 / 0.49 / 1.86 / $2.53 / 50% | 11 / $4.42 / 0.40 / 1.97 / $3.18 / 44% | 19 / $11.28 / 0.59 / 2.32 / $3.36 / 51% |
| IWM | 15 / $3.87 / 0.26 / 1.67 / $2.82 / 45% | 12 / $0.55 / 0.05 / 1.10 / $4.41 / 34% | 21 / −$5.14 / -0.28 / 0.47 / $6.23 / 39% |
| DIA | 19 / $9.57 / 0.88 / 2.71 / $2.12 / 47% | 14 / −$2.08 / -0.16 / 0.70 / $3.20 / 46% | 18 / $4.72 / 0.26 / 1.72 / $2.73 / 54% |
| XLF | 14 / −$1.73 / -0.12 / 0.84 / $7.52 / 42% | 12 / $1.80 / 0.15 / 1.35 / $2.61 / 35% | 19 / $2.88 / 0.13 / 1.36 / $3.00 / 46% |
| XLE | 15 / −$6.11 / -0.41 / 0.41 / $6.11 / 22% | 12 / $2.89 / 0.24 / 1.53 / $3.19 / 40% | 15 / $4.98 / 0.33 / 1.59 / $6.09 / 37% |
| AAPL | 14 / $24.39 / 1.74 / 7.83 / $1.76 / 53% | 10 / $10.98 / 1.10 / 4.92 / $1.48 / 46% | 14 / $12.72 / 0.91 / 4.11 / $1.54 / 49% |
| MSFT | 21 / $7.56 / 0.36 / 1.86 / $4.48 / 50% | 12 / $2.72 / 0.23 / 1.46 / $3.72 / 38% | 16 / $10.71 / 0.66 / 2.68 / $2.85 / 50% |
| JPM | 14 / $11.85 / 0.85 / 3.34 / $4.36 / 42% | 12 / −$2.60 / -0.22 / 0.67 / $4.66 / 28% | 18 / $5.93 / 0.33 / 1.96 / $2.11 / 51% |
| KO | 17 / $2.41 / 0.11 / 1.27 / $3.65 / 32% | 11 / −$0.52 / -0.05 / 0.88 / $2.19 / 43% | 17 / −$0.32 / -0.02 / 0.96 / $4.31 / 34% |

## C2_BREAKOUT_CONFIRMED — Breakout with volume and next-day confirmation

**Verdict: INSUFFICIENT EVIDENCE.** Only 16 validation trades (< 30). Training period not positive (avg -0.074R). Validation not positive. Validation profit factor 0.73 < 1.15. Validation not positive with slippage tripled to 15 bps. Did not advance from validation, so the final test cannot promote it.

| Period | Trades | Net | Return | Exp. $ | Avg R | 90% CI (R) | PF | Win % | Avg win | Avg loss | Max DD | Exposure | Avg R @15 bps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| train | 33 | −$4.37 | -0.44% | -0.13 | -0.07 | [-0.37, 0.24] | 0.72 | 42 | 0.81 | -0.83 | $7.37 | 3% | -0.16 |
| validation | 16 | −$2.21 | -0.22% | -0.14 | -0.19 | [-0.59, 0.23] | 0.73 | 38 | 0.99 | -0.82 | $6.07 | 2% | -0.23 |
| test | 24 | $4.99 | 0.50% | 0.21 | 0.21 | [-0.19, 0.62] | 1.50 | 50 | 1.25 | -0.83 | $3.55 | 3% | 0.14 |
| all | 73 | −$1.60 | -0.16% | -0.02 | -0.00 | [-0.22, 0.21] | 0.95 | 44 | 1.01 | -0.83 | $10.44 | 3% | — |

**By calendar year (pooled):** 2016: 6t -0.59R · 2017: 11t -0.40R · 2018: 8t 0.95R · 2019: 8t -0.26R · 2020: 7t -1.00R · 2021: 6t 1.02R · 2022: 3t -0.69R · 2023: 6t 0.25R · 2024: 9t -0.05R · 2025: 6t 0.67R · 2026: 3t 0.01R

**Timing diagnostic (post-hoc):** train: in-market 1.9 bp/day vs all days 7.0; strategy −$4.37 vs same-capital hold $2.35 · validation: in-market -3.1 bp/day vs all days 5.8; strategy −$2.21 vs same-capital hold −$0.27 · test: in-market 10.1 bp/day vs all days 8.4; strategy $4.99 vs same-capital hold $6.99

| Ticker | train trades / net / avg R / PF / DD / exposure | validation trades / net / avg R / PF / DD / exposure | test trades / net / avg R / PF / DD / exposure |
| --- | --- | --- | --- |
| SPY | 3 / $1.95 / 1.24 / — / $0.00 / 2% | 2 / −$1.31 / -1.00 / 0.00 / $1.31 / 1% | 1 / −$0.77 / -1.00 / 0.00 / $0.77 / 1% |
| QQQ | 2 / $0.78 / 0.28 / 2.33 / $0.59 / 3% | 0 / $0.00 / — / — / $0.00 / 0% | 0 / $0.00 / — / — / $0.00 / 0% |
| IWM | 3 / −$1.76 / -0.59 / 0.11 / $1.99 / 3% | 1 / $0.65 / 0.65 / — / $0.00 / 2% | 3 / −$2.08 / -0.69 / 0.00 / $2.08 / 3% |
| DIA | 4 / $1.61 / 0.44 / 5.05 / $0.40 / 5% | 1 / −$1.00 / -1.00 / 0.00 / $1.00 / 1% | 4 / $0.29 / 0.24 / 1.20 / $1.00 / 4% |
| XLF | 3 / −$1.50 / -0.72 / 0.00 / $1.50 / 1% | 2 / $1.08 / 0.62 / — / $0.00 / 1% | 4 / −$2.10 / -0.60 / 0.21 / $2.10 / 2% |
| XLE | 3 / −$1.41 / -0.46 / 0.29 / $1.41 / 3% | 2 / $2.20 / 1.10 / — / $0.00 / 5% | 1 / −$1.02 / -1.02 / 0.00 / $1.02 / 0% |
| AAPL | 7 / −$0.72 / -0.10 / 0.82 / $2.00 / 6% | 2 / −$2.02 / -1.01 / 0.00 / $2.02 / 1% | 5 / $1.78 / 0.36 / 1.89 / $1.00 / 8% |
| MSFT | 3 / −$3.00 / -1.00 / 0.00 / $3.00 / 1% | 1 / −$0.74 / -1.00 / 0.00 / $0.74 / 1% | 2 / $2.50 / 1.25 / — / $0.00 / 4% |
| JPM | 2 / −$1.25 / -0.62 / 0.00 / $1.25 / 3% | 0 / $0.00 / — / — / $0.00 / 0% | 2 / $2.31 / 1.15 / — / $0.00 / 4% |
| KO | 3 / $0.93 / 0.60 / 1.93 / $1.00 / 3% | 5 / −$1.07 / -0.21 / 0.65 / $3.00 / 8% | 2 / $4.08 / 2.04 / — / $0.00 / 2% |

## C3_PULLBACK_IN_TREND — Pullback to the 20 EMA in a long-term uptrend

**Verdict: INSUFFICIENT EVIDENCE.** Validation profit factor 1.10 < 1.15. Validation not positive with slippage tripled to 15 bps. Did not advance from validation, so the final test cannot promote it.

| Period | Trades | Net | Return | Exp. $ | Avg R | 90% CI (R) | PF | Win % | Avg win | Avg loss | Max DD | Exposure | Avg R @15 bps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| train | 170 | $38.03 | 3.80% | 0.22 | 0.22 | [0.08, 0.35] | 1.67 | 59 | 0.95 | -0.82 | $9.52 | 23% | 0.13 |
| validation | 133 | $7.24 | 0.72% | 0.05 | 0.04 | [-0.11, 0.20] | 1.12 | 49 | 1.06 | -0.90 | $16.53 | 24% | -0.01 |
| test | 215 | $6.60 | 0.66% | 0.03 | 0.03 | [-0.09, 0.16] | 1.07 | 48 | 1.02 | -0.89 | $15.64 | 30% | -0.03 |
| all | 518 | $51.87 | 5.19% | 0.10 | 0.10 | [0.02, 0.18] | 1.24 | 52 | 1.00 | -0.87 | $31.11 | 25% | — |

**By calendar year (pooled):** 2016: 7t 0.43R · 2017: 63t 0.35R · 2018: 61t -0.07R · 2019: 39t 0.42R · 2020: 29t 0.24R · 2021: 84t 0.07R · 2022: 20t -0.34R · 2023: 44t -0.24R · 2024: 64t 0.32R · 2025: 54t -0.02R · 2026: 53t -0.04R

**Timing diagnostic (post-hoc):** train: in-market 7.7 bp/day vs all days 7.0; strategy $38.03 vs same-capital hold $55.89 · validation: in-market 6.9 bp/day vs all days 5.8; strategy $7.24 vs same-capital hold $19.89 · test: in-market 3.9 bp/day vs all days 8.4; strategy $6.60 vs same-capital hold $16.70

| Ticker | train trades / net / avg R / PF / DD / exposure | validation trades / net / avg R / PF / DD / exposure | test trades / net / avg R / PF / DD / exposure |
| --- | --- | --- | --- |
| SPY | 15 / $4.18 / 0.25 / 2.17 / $1.68 / 22% | 10 / −$1.10 / -0.11 / 0.72 / $1.43 / 21% | 23 / −$0.03 / 0.01 / 1.00 / $3.12 / 35% |
| QQQ | 18 / $9.79 / 0.57 / 3.31 / $1.12 / 26% | 12 / $4.34 / 0.36 / 2.02 / $2.17 / 23% | 20 / $3.02 / 0.17 / 1.40 / $3.02 / 31% |
| IWM | 17 / −$0.28 / -0.11 / 0.96 / $3.52 / 21% | 13 / −$0.38 / -0.03 / 0.93 / $4.13 / 19% | 20 / $4.70 / 0.25 / 1.57 / $1.80 / 31% |
| DIA | 14 / $1.13 / 0.05 / 1.22 / $3.24 / 18% | 13 / −$3.82 / -0.32 / 0.52 / $4.03 / 23% | 26 / $1.53 / 0.11 / 1.15 / $5.19 / 33% |
| XLF | 13 / $5.61 / 0.47 / 2.82 / $2.00 / 19% | 15 / −$2.50 / -0.20 / 0.73 / $6.53 / 26% | 22 / −$1.87 / -0.11 / 0.84 / $4.57 / 28% |
| XLE | 10 / −$0.59 / -0.08 / 0.89 / $3.22 / 10% | 15 / $2.52 / 0.15 / 1.37 / $3.00 / 23% | 15 / −$4.94 / -0.34 / 0.55 / $7.83 / 17% |
| AAPL | 17 / $8.16 / 0.50 / 2.34 / $3.42 / 22% | 13 / $4.96 / 0.38 / 2.15 / $2.10 / 25% | 20 / $3.73 / 0.22 / 1.44 / $4.79 / 28% |
| MSFT | 28 / $6.03 / 0.22 / 1.69 / $3.68 / 38% | 17 / $2.01 / 0.10 / 1.24 / $4.69 / 27% | 19 / −$0.33 / -0.02 / 0.97 / $4.59 / 24% |
| JPM | 15 / $3.58 / 0.24 / 1.62 / $4.13 / 21% | 9 / $0.22 / 0.02 / 1.05 / $2.12 / 16% | 27 / $7.27 / 0.26 / 1.74 / $2.96 / 40% |
| KO | 23 / $0.42 / 0.04 / 1.05 / $3.41 / 28% | 16 / $0.99 / 0.06 / 1.15 / $2.02 / 33% | 23 / −$6.50 / -0.34 / 0.49 / $10.23 / 28% |
