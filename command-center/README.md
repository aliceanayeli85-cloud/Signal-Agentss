# Trading Command Center

A phone-friendly dashboard for **analysing US stocks and ETFs, planning trades, paper trading and
monitoring**, built for a $100 account with a $1 risk per trade.

**It cannot place real orders.** Real trades are placed by you, in Robinhood
([docs/ROBINHOOD.md](docs/ROBINHOOD.md)). Nothing here predicts the market or shows that any
strategy is profitable.

---

## Quick start

```bash
cd command-center
npm install
cp .env.example .env      # then add your free Alpaca keys
npm run dev               # open http://127.0.0.1:5273
```

| Command | What it does |
| --- | --- |
| `npm run dev` | API (port 5299) + UI (port 5273) with live reload. |
| `npm start` | Builds the UI and serves everything from one process on port 5299. The monitor runs inside it. |
| `npm run monitor` | Runs the monitor alone (for when the web server is not always on). |
| `npm test` | 106 tests: calculations, risk rules, order handling, data failures, API. |
| `npm run typecheck` | TypeScript check. |

### Without keys
The app starts, and every price shows as unavailable with the reason. No price, plan or order is
ever made up.

### Market data: Alpaca (free)
1. Sign up at <https://alpaca.markets>. Market data needs no deposit.
2. Generate API keys in the dashboard.
3. Set `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`.

The free **IEX feed** is real-time but only covers trades on one exchange, so volume and VWAP are
approximations. The app says so next to the data.

---

## Using it from your phone (and keeping the monitor running)

The monitor only works while the server process runs. A chat session or a closed laptop does not
keep it alive. Options:

- **Replit** (this repo is a Replit project): put the keys plus `HOST=0.0.0.0` and a long
  `ACCESS_TOKEN` in *Secrets*, then run `cd command-center && npm install && npm start`. For
  monitoring that survives closing the tab, deploy as a **Reserved VM**. An *Autoscale* deployment
  sleeps when idle, and the monitor sleeps with it.
- **Any always-on machine / VPS**: run `npm start` under a process manager (systemd, pm2).
- **Split setup**: `MONITOR_IN_PROCESS=false` on the web server, and `npm run monitor` on an
  always-on machine with the same database file.

If the monitor stops, the dashboard shows **"Monitoring warning"** together with the time of the
last successful check.

Optional push notifications: set `NTFY_URL` to a secret topic and install the free
[ntfy](https://ntfy.sh) app.

---

## Architecture

```
src/engine/   Pure calculations — no network, no database. Fully unit-tested.
  indicators   EMA 9/20, RSI 14, ATR 14, session VWAP, relative volume
  time         New York sessions, completed vs forming candles, higher-timeframe building
  levels       Swing points → support / resistance with touch counts
  patterns     Engulfing, hammer, shooting star, doji, inside bar (with plain-English meaning)
  trend        Uptrend / downtrend / sideways from EMAs + swing structure
  analysis     Full report, breakouts & failed breakouts, three long-only setups
  plan         Trade plan or "NO TRADE — CONDITIONS NOT MET", with every rule check listed
  costs        Slippage, SEC/FINRA sell fees, position sizing against the $ risk budget
  settings     Risk rules, hard caps, "no raising risk after a loss"
  risk         Kill switch, daily shutdown, cooldown, revenge & duplicate protection
  orders       Order state machine, simulated stops/targets, price alerts
  backtest     Bar-by-bar simulation using the same analysis + plan code
src/server/   Express API + SQLite
  providers/alpaca   Read-only market data and market clock
  services/          market cache, account state, analysis, trading, monitor, robinhood
src/monitor/  Standalone monitor worker
src/client/   React dashboard (mobile-first, dark)
```

Key design decisions:

- **Only completed candles drive decisions.** The forming candle is drawn grey and ignored by the
  analysis. A daily candle counts as complete 15 minutes after the 4 pm close.
- **One code path.** Live plans and backtests call the same `analyze()` and `buildTradePlan()`, so
  a backtest tests the rules you actually trade.
- **Paper and real are separate.** Every record has a `mode`. Real trades are entered by you and
  are never auto-sold. They only get alerts.
- **Orders need approval.** Preview (expires in 5 minutes), then explicit approval, which
  re-checks every rule on a fresh price. Idempotency keys stop double orders. If the trigger has
  not traded yet, no order can be created at all: you get a price alert instead.
- **The monitor is periodic and honest about it.** It checks every 60s while the market is open,
  every 15 min when it is closed. It never simulates a fill on a stale price or outside regular
  hours. A database lease prevents two monitors running at once, and alerts are de-duplicated.

## The trade plan

For each ticker: price + timestamp + source, trend (and bigger-picture trend), setup, entry zone,
confirmation, stop, TP1, TP2, risk per share, reward-to-risk, position size, max planned loss,
estimated costs and slippage, reasons to enter, reasons to avoid, and a checklist.

If **any** check fails, the headline is `NO TRADE — CONDITIONS NOT MET`. The checks:

- data fresh
- enough history
- a setup exists
- stop below entry
- not chasing
- reward-to-risk ≥ 1.5
- size possible within limits
- trend not against the trade
- higher timeframe not down
- RSI ≤ 75
- not over-extended from the 20 EMA
- no recent failed breakout
- within the risk budget
- account rules OK

Setups (long only — no shorting, margin or options):

- **Pullback to the 9/20 EMA in an uptrend.** Enter above the signal candle's high.
- **Breakout above resistance on ≥ 1.5× volume.** The level must have been touched at least
  twice.
- **Reversal candle at support.** Counter-trend trades are flagged as such.

Targets: TP1 = nearest resistance if within 3R, otherwise 2R. TP2 = next resistance, otherwise the
same distance again. At TP1, half is sold and the stop moves to breakeven.

## Default risk rules ($100 account)

| Rule | Default | Hard cap |
| --- | --- | --- |
| Risk per trade | $1 | 2% of equity (shrinks as equity falls) |
| Max daily loss | $3 → shut down for the day | 5% of equity |
| Max open risk | $2 | — |
| Max position | $50 | equity (no borrowing) |
| Trades per day | 3 | — |
| Losses in a row | 2 → shut down for the day | — |
| Cooldown after a loss | 60 min | — |
| Same ticker after a loss | blocked until tomorrow | — |

Risk can always be lowered. **Raising** it is refused after a losing trade.

## Backtesting

Bar-by-bar on Alpaca history, with slippage and fees. Look-ahead protections:

- history is sliced at the decision candle
- fills only happen on a later candle
- when a candle touches both stop and target, the stop counts first
- gaps exit at the open

Results are split into the first 70% (in-sample) and last 30% (out-of-sample). Under 30 trades, a
warning says the sample is too small. Metrics: win rate, average gain/loss, profit factor,
expectancy, average R, max drawdown.

## Strategy research

Read [research/REPORT.md](research/REPORT.md) before trusting any plan.

- **Current dashboard rules:** REJECTED. They lost money out-of-sample in 2020–2022.
- **Simple trend-following rule:** a candidate for more paper testing only. It showed no evidence
  of timing skill.

The research has its own audit trail (immutable baseline, backtester audit, pre-registration,
chronological validation) under `research/`. It is reproducible with `npm run research -- …`.

## C1 trend following — EXPERIMENTAL, paper only

Open it from **More → C1 trend following**. The full protocol is in
[research/C1_PAPER_PROTOCOL.md](research/C1_PAPER_PROTOCOL.md).

- **Separate.** It runs as a separate $100 paper portfolio in its own `c1_*` tables. It never
  touches the baseline paper account or real-money records. The rejected baseline still runs
  unchanged.
- **Same rules as the research.** It uses the exact pre-registered research code. Tests prove the
  paper processor makes the same trades as the research backtest.
- **Completed candles only.** Daily candles are processed once each, after the close. Simulated
  fills use the next official open plus slippage, or the stop price. Gaps through a stop fill at
  the worse open.
- **Same risk controls.** $1 per trade, the 2% cap, the $50 cap, $2 maximum open risk, the daily
  limits and the kill switch. Signals that don't fit are skipped, with the reason — never forced.
- **Benchmarks.** SPY buy-and-hold, and SPY held with the same dollars C1 had invested, compared on
  return, drawdown, volatility and exposure.
- **The page shows:**
  - signals, labelled "not trades";
  - simulated positions and trades, with MAE/MFE, slippage and fees;
  - upcoming entry and exit levels;
  - the latest data update;
  - data-quality warnings.
- **Expect about two years to reach 30 trades.** With two positions allowed at once, a historical
  replay gives about 14 trades a year.

## Known limitations

- **No earnings or news data.** The app tells you to check earnings dates yourself before every
  trade.
- **IEX volume is partial.** Relative volume compares IEX to IEX, which is consistent but not
  the whole market.
- **No trading-calendar data.** Higher-timeframe candles drop the most recent (possibly
  unfinished) week, day or hour, so that filter lags slightly.
- **Periodic, not continuous.** Price can pass a stop and come back between checks. Paper exits
  only happen when a check sees the price.
- **SEC fee rate** defaults to $27.80/million (conservative). It changes; verify it.
- **The strategies are a starting point, not a proven edge.** Use the backtester and at least 30
  paper trades to find out.
