# C1 paper evaluation protocol

**Status: EXPERIMENTAL — NOT PROVEN PROFITABLE.** This is paper only. C1 has no live
execution, and none will be added during this evaluation.

Fixed on 2026-10-29, before any C1 paper trade existed. Background:
[REPORT.md](REPORT.md). In research, C1 was the only candidate, and it showed **no evidence of
timing skill**.

## What is being tested
Does C1 keep a positive average R after costs **on new data, in the real account
constraints**, and does it do better than simply holding SPY with the same money?

## Frozen rules
- Code: `TREND_FOLLOW.signal` in `src/research/strategies.ts` — the exact pre-registered
  function.
- Exit order: as in the audited `simulateChannelExit` (open: channel exit, then gap stop; during
  the day: stop; at the close: 120-day time exit, then the channel-exit signal).
- Tests prove the paper processor produces the same trades as the research backtest: on synthetic
  data, and on all 10 real tickers for 2016–2026.

| Item | Value |
| --- | --- |
| Filter | close > 100-day SMA |
| Entry signal | a **completed** daily close above the highest high of the previous 20 days |
| Entry | next session's official open (simulated market-on-open) + 5 bps slippage |
| Stop | signal close − 2 × ATR(14). A gap below the stop exits at the open, **below the stop**. |
| Exit | a completed close below the lowest low of the previous 10 days → sell at the next open; or the stop; or 120 days |
| Universe | SPY, QQQ, IWM, DIA, XLF, XLE, AAPL, MSFT, JPM, KO |
| Data | Alpaca consolidated (SIP) daily candles, split-adjusted (the research data) |
| Start | trading day **2026-10-28**, the first day after the research data ended |

**Confirmation** means the signal candle has closed (it is complete). No extra confirmation
rule was added, because that would change the pre-registered strategy.

## Risk (the app's existing controls, unchanged)
- **Account:** one separate $100 paper account (the `c1_*` tables). It is isolated from the
  baseline paper account and from real-money records.
- **Per trade:** $1 risk, capped at 2% of equity. Position size is calculated at the actual fill
  price. Maximum $50 per position, including slippage. No borrowing.
- **Account-wide limits:**
  - $2 maximum open risk;
  - $3 daily loss limit;
  - 2 losses in a row stops trading for the day;
  - 3 trades per day;
  - 60-minute cooldown after a loss;
  - no re-entry into a ticker that lost today;
  - the global kill switch blocks new C1 entries, but open positions are still managed.
- **Too many signals:** when more signals arrive than fit, they are taken in the fixed ticker
  order above. The others are recorded as **skipped, with the reason**. No entry is forced.
- **Open risk:** it is counted as (entry − stop) × shares for as long as the position is open.
  C1 never raises its stop, so a long-held winner keeps using $1 of the $2 limit. That is
  conservative, and it is the app's existing rule.

## A stop is not a guaranteed loss limit
A gap through the stop is filled at the (worse) open. Losses beyond the planned risk are recorded
as they happen and shown as "gap stops" with the worst R. In the research period, the worst gap
cost −2.8R.

## Benchmark (fixed now; never changed after results are seen)
1. **SPY buy-and-hold:** the full starting capital is put into SPY at the close of the start date
   (5 bps slippage) and held. Cash earns 0%.
2. **SPY same exposure:** each day, hold SPY equal to C1's invested dollars at the previous close.
   This asks whether C1's picks beat simply being in SPY with the same money. Rebalancing costs are
   ignored, which slightly flatters the benchmark.

Both use split-adjusted closes without dividends, the same basis as C1.

**Reported for C1 and both benchmarks:**
- net return;
- maximum drawdown ($ and %);
- annualised volatility (from 20 days of data);
- return ÷ volatility (only from 60 trading days);
- market exposure (% of days, and average % invested).

## Recorded for every simulated trade
- signal date;
- entry and exit dates and timestamps;
- raw prices and fill prices;
- shares;
- planned risk;
- entry and exit slippage;
- fees;
- net P&L and R;
- exit reason;
- maximum adverse and favourable excursion (approximate, from daily highs and lows);
- days held;
- market condition at entry (SPY above or below its 200-day average).

## How long, and when to look
- **Minimum: 30 closed C1 trades.**
- **Feasibility, stated up front.** Replaying 2016–2026 through this exact processor, as one
  $100 account, gave a **median of 14 trades a year**. 88% of signals were skipped because the
  $2 open-risk limit allows only two positions. **30 trades will likely take about two years.**
  (`research/results/c1-portfolio-feasibility.json`. Those years were already used in research,
  so the estimate is for planning only.)
- If fewer than 30 trades exist after **12 months**, that is reported as it stands. Rules are
  **not** loosened and risk is **not** raised to speed things up.
- **Check-ins** at 10, 20 and 30 closed trades, and at 6 and 12 months. These are for data
  problems and process errors, not for changing the rules.

## How results will be judged (at 30 trades, or 12 months — whichever is later)
- Average R after costs, with a bootstrap interval; profit factor; drawdown; worst gap loss.
- C1 against **SPY same exposure**: did the selection add anything beyond being invested?
- Results split by market condition (SPY above or below its 200-day average).
- **30 trades is still a small sample.** A positive result at 30 trades means "keep paper testing",
  not "profitable". A negative result is a reason to stop.

## Things that would invalidate the evaluation
Any change to the rules, the universe, the benchmark, the start date or the risk settings
**during** the evaluation. Such a change ends this evaluation; a new version must start from
zero with its own protocol.

## Operational notes and limits
- **Where it runs.** C1 is updated by the monitor (each cycle; cheap when there is no new day),
  or with "Process now". Days are processed once, in order, after the session completes.
- **Catching up after downtime.** If the server is off, C1 catches up from history when it
  restarts. It loads about 520 daily candles, enough for an outage of over a year. If a day ever
  lacks the 120 earlier candles the rules need, processing **pauses with a warning** instead of
  silently skipping signals.
- **Kill switch during catch-up.** It applies as it is **at processing time**. If it is on, any
  entries due in the catch-up window are skipped.
- **Missing data.** If any ticker is missing a day, processing **pauses** at that day and shows a
  warning; it never skips ahead.
- **Large gaps.** Overnight gaps over 8% are flagged for a manual check (real news versus an
  unadjusted corporate action such as a spin-off).
- **Data feed.** If Alpaca refuses the consolidated feed, daily candles fall back to IEX and a
  warning is shown.
- **When fills appear.** Fills appear after the session they belong to (end-of-day processing).
  A daily-candle model cannot know the exact intraday time of a stop.
