# MemeTrader OS

A local trading **research, analysis, paper-trading and education** platform for meme coins,
crypto and (with an API key) stocks.

It finds candidate setups, measures market structure, scores risk, builds trade plans, sizes
positions, paper trades, journals, backtests and reports what your own recorded results actually
say.

**It does not predict the market, and it is not profitable software.** It is a measurement and
discipline tool. Read [What this app refuses to do](#what-this-app-refuses-to-do) before anything
else.

---

## Quick start

One command, from this directory:

```bash
npm install && npm run dev
```

Then open **http://127.0.0.1:5173**.

That is all. No `.env` file is required, no database setup is required, and no API key is required
for the meme-coin and crypto features. The SQLite database is created and migrated on first boot.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the API (port 5199) and the UI (port 5173) together. |
| `npm run build` | Typechecks everything and builds the production client bundle. |
| `npm start` | Builds, then serves the API **and** the built UI from one process on port 5199. |
| `npm test` | Runs the full unit and integration test suite. |
| `npm run typecheck` | Typechecks the client, server, engine and tests. |
| `npm run db:init` | Creates and migrates the database without starting the server. |

Requires **Node.js 20.11+** (developed and verified on Node 22).

To customise anything — ports, database path, cache TTLs, optional API keys — copy `.env.example`
to `.env` and edit it. Every value in it is optional.

---

## What this app refuses to do

These are structural properties of the code, not policy statements:

- **It never fabricates data.** If a provider does not return a field, that field is `null` and the
  UI shows `DATA UNAVAILABLE` with the reason. No price, volume, liquidity, market cap, win rate,
  backtest result or confidence value in this app is ever synthesised, defaulted or estimated.
- **It never invents an API.** Every data source is a public, documented endpoint, linked from the
  Settings page. There is no Fomo integration, because no legitimate public Fomo API was available
  to build against.
- **It never touches real money.** There is no wallet connection, no transaction signing, no key
  handling and no exchange execution code anywhere in this repository. `ENABLE_LIVE_TRADING` exists
  only so that any future integration must be enabled deliberately — and because there is nothing
  to enable today, **the server refuses to start if you set it to `true`**.
- **It never calls a score a probability.** The setup score counts satisfied conditions. The risk
  score aggregates measurable hazards. AI confidence rates how complete the evidence was. None of
  them is a probability of profit, and the UI says so next to each one.
- **It never converts history into a forecast.** Historical statistics are phrased as *"this rule
  set produced a 63% win rate across 243 matching observations"* — never *"you have a 63% chance of
  winning."* That distinction is enforced in `src/engine/stats.ts` and covered by tests.
- **It never claims a token is safe.** There is no honeypot, mint-authority or LP-lock data source
  connected, and the risk panel says so explicitly on every meme coin.

---

## Data sources actually connected

| Source | Serves | Key required | Notes |
| --- | --- | --- | --- |
| [DexScreener](https://docs.dexscreener.com/api/reference) | On-chain pair metadata: price, liquidity, FDV, market cap, windowed volume, buy/sell counts, pair age | No | Publishes **no OHLCV**, so charts for on-chain pairs come from GeckoTerminal. |
| [GeckoTerminal](https://www.geckoterminal.com/dex-api) | On-chain **OHLCV** (1m–1d) and trending pools | No | Rate limited to roughly 30 requests/minute. The app caches aggressively because of this. |
| [Coinbase Exchange](https://docs.cdp.coinbase.com/exchange/reference) | Centralised crypto quotes and candles | No | 4h bars are aggregated locally from 1h, because Coinbase offers no 4h granularity. Reports no liquidity or transaction counts, so the risk engine excludes those factors rather than guessing them. |
| [Alpha Vantage](https://www.alphavantage.co/documentation/) | Stocks / ETFs | **Yes** — `ALPHA_VANTAGE_API_KEY` | Free tier is ~25 requests/day. |
| [Polygon.io](https://polygon.io/docs/stocks) | Stocks / ETFs | **Yes** — `POLYGON_API_KEY` | Free tier is delayed and rate limited. |
| [Anthropic API](https://docs.claude.com/) | AI analysis panel | **Yes** — `ANTHROPIC_API_KEY` | Entirely optional. Every other feature works without it. |

Binance is deliberately **not** used: it returns HTTP 451 from many regions, and an adapter that
silently fails for half its users is worse than not having one.

---

## What the app does

### Market scanner
Tabs for Meme Coins, Crypto, Stocks, Watchlist, New Pairs, Top Momentum, Unusual Volume and
Potential Breakouts. Every tab merges results across the providers that serve that asset class, and
reports each provider's status separately — so a tab where one source failed shows partial results
plus an explicit note, never a silently shortened list.

"Unusual Volume" compares the last hour against the 24-hour average hour using only figures the
provider actually returned. "Potential Breakouts" is a shortlist, not a claim: it filters on real
1h/24h change and liquidity, and the chart decides whether a break is real.

### Analysis engine
For a selected market and timeframe:

- **Market structure** — higher highs/lows, lower highs/lows, consolidation, breakout, breakdown,
  reclaim, failed breakout, with the swing points that produced the classification.
- **Levels** — support, resistance, supply and demand zones, clustered from swing points and
  ranked by how many times price actually touched them.
- **Liquidity sweeps** — identified only after the reversal candle closes, because before that a
  sweep is indistinguishable from a genuine breakout.
- **Indicators** — ATR, RSI, session VWAP, relative volume, EMA 20/50/200. Each returns `null`
  rather than a fallback when there is not enough data.
- **Multi-timeframe alignment** — 1D / 4H / 1H / 15M evaluated independently, reported as HIGH,
  MODERATE, MIXED or UNKNOWN. A timeframe that could not be loaded is shown as unavailable, never
  assumed neutral.

### Setup detection — five modular strategies
`Breakout + Retest`, `Support Bounce`, `Trend Continuation`, `Range Breakout`, `Failed Breakout`.

Each is a self-contained module in `src/engine/setups/` implementing one interface, and each is
handed only the bars up to and including the decision bar — the same code path the backtester uses,
which is what makes the two consistent.

### Setup score (0–100)
A checklist total across trend structure, timeframe alignment, volume confirmation, level quality,
momentum, breakout quality, retest quality, liquidity quality, risk/reward and volatility.

A factor whose input data is missing is excluded from **both** the earned points and the
denominator, and the UI reports how much of the checklist could be evaluated. The panel shows every
factor, its points and why — including the ones that could not be scored.

### Risk engine (0–100, higher is worse)
Liquidity depth, pair age, volatility, volume trend and collapse, buy/sell imbalance (only when the
transaction count is large enough for the ratio to mean anything), price extension, price movement
relative to liquidity, and FDV overhang.

Holder concentration and liquidity-over-time are always reported as **unavailable**, because no
connected source provides them. When only a small fraction of the checklist could be evaluated the
panel says a low score means *"few measured hazards"*, not *"safe"*.

### Trade plan and position sizing
Entry, stop, invalidation level with the reason it invalidates, TP1/TP2/TP3 preferring real
structure over arbitrary multiples, and reward-to-risk at each target. When a valid stop cannot be
established the app returns **"No valid trade plan available"** with the reason.

The position sizer takes account size, risk %, entry and stop, and returns max dollar risk, size,
potential loss, potential profit and R:R. Presets are 0.25% / 0.5% / 1% / 1.5% / 2%, defaulting to
1%, with an explicit warning above 2% and a stronger one for high-volatility markets recommending
*smaller* size.

### Paper trading, FOMO detection and daily limits
Every paper trade records timestamp, asset, timeframe, setup, entry, stop, targets, size, risk,
outcome, P&L, R multiple, setup score, risk score and the market conditions at entry.

Before an entry is accepted, a **discipline check** runs: entering after a vertical move,
re-entering something you exited within two hours, trading through a losing streak, increasing risk
above your baseline, or entering with no defined setup. Any flag must be acknowledged, and the
trade is recorded as flagged.

Configurable limits (max trades/day, daily loss %, max consecutive losses, max risk/trade) lock new
entries when breached — `TRADING LOCKED — Your predefined risk limit has been reached.` The lock
can only be lifted by the explicit simulation override in Settings, and trades taken while it is on
are recorded as such.

### Journal
Six pre-trade questions asked before the position exists, seven post-trade questions that separate
*"the plan was wrong"* from *"I did not follow the plan"*, and an A–F execution grade that grades
the process, not the outcome.

### Backtesting
A real bar-by-bar backtester with configurable timeframe, strategies, stop rule (structure or ATR
multiple), target R, risk %, fees and slippage.

Look-ahead prevention is the point of the design:

- Strategies only ever receive `candles.slice(start, i + 1)` — future bars are not in the array.
- A signal on bar `i` fills at the **open of bar `i + 1`**, moved against you by the slippage
  assumption.
- When one bar's range contains both the stop and the target, the **stop** is recorded, because
  intrabar sequence is unknowable from OHLC data.
- The series is split into in-sample and out-of-sample by bar index, and results are reported
  separately for each.

Reports trades, win rate, average return, average R, expectancy, profit factor, max drawdown,
largest win/loss and longest losing streak. Sharpe is **withheld below 30 trades** and labelled
"per-trade, not annualised" when shown. Every result carries: *Past performance does not establish
future profitability.*

### Performance and statistics
Total trades, wins, losses, win rate, average winner and loser, expectancy, profit factor, average
and median R, max drawdown, consecutive wins and losses, average holding time, and breakdowns by
strategy and timeframe — with the **sample size and a confidence band** displayed next to every
figure. A best/worst strategy is not named until at least two groups have 10+ trades each.

The statistics engine publishes no win rate at all below 30 matching observations, and phrases what
it does publish as an observed historical frequency.

### AI analysis (optional)
When `ANTHROPIC_API_KEY` is set, the computed report — structure, levels, indicators, scores,
warnings and data gaps — is sent to Claude with a required output structure: bull case with what
would need to happen, bear case with what would invalidate it, neutral case, setup quality 0–100,
and an evidence-completeness confidence that rates the **data**, not the odds. The model is
instructed never to state a probability and never to recommend an action.

### Education mode
Every technical term in the UI carries an inline explainer, and Settings holds the full glossary:
what a liquidity sweep is, what a retest is, what 2R means, what expectancy is, what volume
confirmation means, what look-ahead bias is, and why a historical frequency is not a probability.

---

## Project structure

```
src/
  shared/          Types, education glossary and journal questions used by both sides
  engine/          Pure, testable analysis — no I/O, no network, no database
    indicators.ts        ATR, RSI, VWAP, EMA, relative volume, safe division
    structure.ts         Swings, levels, supply/demand zones, liquidity sweeps
    setups/              The five strategies, behind one interface
    setup-score.ts       Checklist scoring with evaluated/unevaluated factors
    risk-engine.ts       Meme-coin hazard scoring
    trade-plan.ts        Entry, stop, invalidation, targets, R:R
    position-size.ts     Sizing, R multiple, P&L
    mtf.ts               Timeframe alignment
    discipline.ts        FOMO detection and daily limits
    backtest/            Bar-by-bar engine and metrics
    performance.ts       Trader performance
    stats.ts             Historical frequency (never a forecast)
  server/
    providers/     One adapter per data source behind a shared interface
    services/      Analysis orchestration, AI layer, recording
    routes/        REST API
    db/            Drizzle schema and versioned SQL migrations
    lib/           env, logger, errors, HTTP with retries, TTL cache, validation
  client/
    pages/         Meme, Day Trade, Swing, Backtest, Paper Trade, Journal, Performance, Settings
    components/    Chart, scanner, analysis panels, trade ticket, primitives
tests/             165 unit and integration tests
```

The analysis engine has no dependency on the server, the database or the network, which is what
makes it directly testable and what lets the live desk and the backtester share the same code.

---

## Database

SQLite via Drizzle ORM, created at `./data/memetrader.db` and migrated automatically on boot.
Tables: `settings`, `assets`, `market_data`, `strategies`, `setups`, `paper_trades`,
`trade_journal`, `backtests`, `performance`, `alerts`, `watchlists`, `schema_migrations`.

All timestamps are Unix milliseconds in UTC. Records are preserved — closing a trade updates it in
place. Only structural rows are seeded (the settings record and the strategy catalogue); no market
data, trades or results are ever seeded.

---

## Testing

```bash
npm test
```

165 tests covering position sizing, R multiple and P&L, indicators, setup scoring, the risk engine,
trade plans, the backtest engine, performance and statistics, the FOMO detector and daily limits,
provider parsers, HTTP failure handling, the cache, the database layer and the REST API.

Edge cases under test include: API failure, rate limiting, malformed and non-JSON responses,
missing market data, zero liquidity, zero volume, invalid stops, invalid position sizes, division by
zero, empty watchlists, unwritable databases, duplicate trades, out-of-order timestamps, duplicate
bar timestamps, extreme price values, backtest look-ahead, and the intrabar stop/target ambiguity.

---

## Known limitations

- **Rate limits shape the experience.** GeckoTerminal allows ~30 requests/minute and a full
  analysis costs up to five (one per timeframe in the ladder). Responses are cached for 20 seconds
  by default; rapid switching between markets can still hit the limit, which surfaces as an
  explicit rate-limit message rather than stale data.
- **Premarket levels are unavailable.** No connected provider separates extended-hours bars, so
  Day Trade mode reports premarket high/low as unavailable instead of reusing the session open.
- **Holder concentration and liquidity history are unavailable.** Both would need an on-chain data
  source this app is not connected to.
- **Stock coverage is key-gated and thin.** Neither stock adapter implements a market-wide screener,
  so the Stocks tab works by symbol lookup rather than a live scan.
- **The scanner pool is not the whole market.** DexScreener has no public "top gainers" endpoint, so
  the meme tabs are built from its documented boosted/profile token feeds plus GeckoTerminal's
  trending pools, then filtered locally. That is a sample of the market, not a survey of it.
- **Backtests inherit the provider's history.** Coinbase caps a candle request at 300 bars, so a
  1000-bar request returns 300 and the result reports the true bar count. Small samples produce
  loud warnings for good reason.
- **The five strategies are a starting point, not an edge.** They are conventional patterns
  implemented honestly. Nothing here has been shown to be profitable, and the backtester exists
  specifically so you can find out for yourself whether they are not.
- **Alerts only fire while the app is open.** There is no background scheduler; the client polls.

---

## Recommended next development step

**Record every detected setup's forward outcome automatically, so the statistics engine has a real
sample.**

The app currently persists setups as they are detected (`setups` table) and computes historical
frequencies from *closed paper trades* — which means the sample only grows as fast as you manually
trade. A background job that revisits each recorded setup after N bars, resolves it against
subsequent candles using the same `resolveExit` rule the backtester uses, and writes the outcome,
would let the statistics engine reach its 30-observation threshold from observation rather than
participation. That turns "historical frequency" from a feature that mostly says *insufficient
observations* into the app's most useful screen.

The pieces already exist: `resolveExit` is exported and tested, the `setups` table stores entry,
stop and targets at detection time, and `computeHistoricalStats` takes a plain array of R multiples.

---

## Disclaimer

This software is for research and education. It is not financial advice, it does not predict
markets, and nothing in it establishes that any strategy is or will be profitable. Trading meme
coins carries a high risk of total loss. The final decision is always yours.
