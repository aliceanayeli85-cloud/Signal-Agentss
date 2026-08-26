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
| [GeckoTerminal](https://www.geckoterminal.com/dex-api) | On-chain **OHLCV** (1m–1d), trending pools, and token holder/contract data (holder count, top-10 concentration, creator holding, mint and freeze authority) | No | Rate limited hard. Charts are collected by a background refresher into a local store rather than fetched per page load — see [Rate limits](#rate-limits-and-the-candle-store). |
| [Coinbase Exchange](https://docs.cdp.coinbase.com/exchange/reference) | Centralised crypto quotes and candles | No | 4h bars are aggregated locally from 1h, because Coinbase offers no 4h granularity. Reports no liquidity or transaction counts, so the risk engine excludes those factors rather than guessing them. |
| [Alpha Vantage](https://www.alphavantage.co/documentation/) | Stocks / ETFs | **Yes** — `ALPHA_VANTAGE_API_KEY` | Free tier is ~25 requests/day. |
| [Polygon.io](https://polygon.io/docs/stocks) | Stocks / ETFs | **Yes** — `POLYGON_API_KEY` | Free tier is delayed and rate limited. |
| [Anthropic API](https://docs.claude.com/) | AI analysis panel | **Yes** — `ANTHROPIC_API_KEY` | Entirely optional. Every other feature works without it. |

Binance is deliberately **not** used: it returns HTTP 451 from many regions, and an adapter that
silently fails for half its users is worse than not having one.

---

## MY MEME COINS — the token watchlist

The **My Coins** tab holds a permanent watchlist identified by **token contract
address**, not by trading pair. Four Solana addresses are seeded on first boot; more
can be added by pasting a mint address.

Nothing about a token is assumed. Each address is resolved through the providers on
every load — to the pair with the deepest liquidity, since that is the only one where
the quoted price, the levels and a stop mean anything. An address that resolves to no
pool where it is the **base** token is rejected as `DATA UNAVAILABLE`; a fuzzy name
match on a different token is never accepted.

Each card shows name, symbol, contract address, price, market cap, FDV, liquidity, 5m /
1h / 24h volume, 5m / 1h / 6h / 24h price change, buys, sells, buy/sell ratio, pair age,
holder count, top-10 concentration, creator holding, mint and freeze authority, liquidity
status, volume verdict, structure, the momentum ladder, and how old the data is. Every
one of those renders a dash or `Unavailable` when the provider did not return it.

Clicking a card opens a detail page with the price chart, volume chart, liquidity trend,
market structure, technical indicators, setup analysis, risk analysis, entry plan, a paper
trade ticket, that token's own trade history, a backtest over its stored bars, and the AI
explanation.

### Trade status

Every token carries exactly one status: `WATCH`, `SETUP FORMING`, `ENTRY CONDITIONS MET`,
`WAIT FOR RETEST`, `HIGH RISK`, `INVALIDATED`, `NO TRADE`, or `DATA UNAVAILABLE`.

There is no `BUY`. Hazard is evaluated before opportunity, so a technically perfect setup
on a pool that is draining returns `HIGH RISK`, not an entry.

### Liquidity tracked over time

No provider publishes a liquidity time series, so the app builds one: the background
refresher records a snapshot of each watchlist token continuously, and the trend is
computed from what it observed. A market the app has seen fewer than three times reports
`insufficient-history` — not `stable`. When liquidity falls fast enough the token is
flagged `HIGH RISK — LIQUIDITY DETERIORATION` and entry is not recommended.

### Volume verdicts

Relative volume, acceleration, trend and price/volume divergence produce one of two
flags: **BULLISH CONFIRMATION** when a price advance is backed by real participation, or
**WARNING** when price rises while volume deteriorates. A warning never hides behind a
valid setup — it is added to the status reasons alongside it.

### Chasing warning

When a token has already run hard (20% in 5m, 35% in 1h, 80% in 6h, 150% in 24h) the
ticket shows `CHASING WARNING`. It does **not** block the paper trade; it requires an
acknowledgement, and the trade is recorded as flagged.

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

| Category | Weight |
| --- | --- |
| Market structure | 20 |
| Volume | 20 |
| Momentum | 15 |
| Liquidity | 15 |
| Support / resistance | 10 |
| Risk / reward | 10 |
| Multi-timeframe alignment | 10 |

A sub-check whose data is missing reduces that category's scorable maximum rather than scoring
zero, and the published score is earned ÷ scorable, scaled to 100. The panel lists every category,
the points it earned, the scorable maximum, and the individual reason behind each point — including
the checks that could not be run.

### Risk engine (0–100, higher is worse)
Liquidity depth, pair age, volatility, volume trend and collapse, buy/sell imbalance (only when the
transaction count is large enough for the ratio to mean anything), price extension, price movement
relative to liquidity, and FDV overhang.

It also scores liquidity trend, holder concentration, creator holding and contract authorities.
Those come from GeckoTerminal's token endpoint; an `unknown` mint or freeze authority scores as
*unknown*, never as revoked — absence of evidence is not evidence. When only a small fraction of the
checklist could be evaluated the panel says a low score means *"few measured hazards"*, not
*"safe"*. There is no LP-lock check and no audit; nothing here means a token is safe.

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
holder and contract data, volume and liquidity verdicts, warnings and data gaps — is sent to Claude
with a required output structure: **what is happening**, **why it matters**, bull case with what
would need to happen, bear case with what would invalidate it, neutral case, **no-trade
conditions**, setup quality 0–100, and an evidence-completeness confidence that rates the **data**,
not the odds.

**Historical evidence** is computed by the app from its own closed paper trades and handed to the
model as fact — the model is never asked to produce a win rate, and none is published below 30
matching observations. The model is instructed never to state a probability and never to recommend
an action.

### Education mode
Every technical term in the UI carries an inline explainer, and Settings holds the full glossary:
what a liquidity sweep is, what a retest is, what 2R means, what expectancy is, what volume
confirmation means, what look-ahead bias is, and why a historical frequency is not a probability.

---

## Rate limits and the candle store

The on-chain OHLCV provider rate-limits aggressively — in practice a handful of requests in a few
seconds is enough to be throttled. A watchlist of four tokens across a timeframe ladder needs far
more than that, so fetching charts during a page load meant the last tokens in the list always
showed `DATA UNAVAILABLE`. Accurate, but useless.

So charts are not fetched during page loads. A **background refresher** requests one series at a
time, roughly every nine seconds, and writes the bars into a local SQLite store. Pages read from
that store and display the true age of the newest bar. The consequences are worth stating plainly:

- **Market data is always live.** Price, liquidity, market cap, volume, price changes and
  transaction counts come from DexScreener on every request; that provider is far more permissive.
- **Charts warm up.** On a fresh database the first load shows market data with no chart; the store
  fills within a couple of minutes and stays current after that.
- **Stored bars are real provider data.** Nothing is derived or interpolated. The newest bar is
  still forming, so re-fetching overwrites it in place rather than duplicating it.
- **Higher timeframes are aggregated, never invented.** 1h and 4h are folded up from stored 15m
  bars; 5m from 1m. Aggregation only ever combines whole bars upward — a finer timeframe is never
  synthesised from a coarser one.
- **A rate limit is never silently absorbed.** The provider layer backs off, serves the last good
  response labelled `stale: true` with its original fetch time, and the UI shows the real age.

`GET /api/health` reports the refresher's state — requests made, bars stored, last error.

## Project structure

```
src/
  shared/          Types, education glossary and journal questions used by both sides
  engine/          Pure, testable analysis — no I/O, no network, no database
    indicators.ts        ATR, RSI, VWAP, EMA, relative volume, safe division
    candles.ts           Bar aggregation and upward timeframe derivation
    structure.ts         Swings, levels, supply/demand zones, liquidity sweeps
    volume.ts            Acceleration, trend, divergence, confirmation/warning flags
    liquidity.ts         Liquidity trend from recorded observations
    momentum.ts          The 1m-1D momentum ladder
    trade-status.ts      The eight-state status machine and chasing warning
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
    services/      Analysis orchestration, token reports, candle store,
                   background refresher, AI layer, recording
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
Tables: `settings`, `assets`, `market_data`, `candles`, `strategies`, `setups`, `paper_trades`,
`trade_journal`, `backtests`, `performance`, `alerts`, `watchlists`, `schema_migrations`.

`market_data` accumulates the liquidity observations the trend is computed from, and `candles`
holds the local OHLCV store. Both grow as you use the app — that is the point.

All timestamps are Unix milliseconds in UTC. Records are preserved — closing a trade updates it in
place. Only structural rows are seeded (the settings record and the strategy catalogue); no market
data, trades or results are ever seeded.

---

## Testing

```bash
npm test
```

207 tests covering position sizing, R multiple and P&L, indicators, candle aggregation, setup
scoring, the risk engine, trade plans, the backtest engine, performance and statistics, the FOMO
detector, the chasing warning, daily limits, volume analysis, the liquidity trend, the momentum
ladder, the trade-status machine, token-address resolution safety, the candle store, provider
parsers, HTTP failure handling, the cache, the database layer and the REST API.

Edge cases under test include: API failure, rate limiting, malformed and non-JSON responses,
missing market data, zero liquidity, zero volume, invalid stops, invalid position sizes, division by
zero, empty watchlists, unwritable databases, duplicate trades, out-of-order timestamps, duplicate
bar timestamps, extreme price values, backtest look-ahead, the intrabar stop/target ambiguity, a
token address that resolves to no pool, and a fuzzy search match on the wrong token.

---

## Known limitations

- **Rate limits shape the experience.** See [Rate limits](#rate-limits-and-the-candle-store). Price,
  liquidity, volume and transaction figures are live on every load; charts fill in over a couple of
  minutes on first run and stay current after that.
- **The 1-minute and 5-minute momentum readings are detail-page only.** A 1m series cannot be
  aggregated from coarser bars, so fetching it for every card on every refresh would blow the rate
  limit. Cards show `n/a` for those two with the reason on hover; the detail page fetches them.
- **Premarket levels are unavailable.** No connected provider separates extended-hours bars, so
  Day Trade mode reports premarket high/low as unavailable instead of reusing the session open.
- **Holder figures are not live.** They carry the provider's own `last_updated` timestamp, which the
  UI displays. They are recomputed on the order of minutes, not per block.
- **There is no honeypot or LP-lock check.** The provider's honeypot field is usually `unknown`, and
  the app reports it as unavailable rather than as "not a honeypot".
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

This is now more tractable than it was: the background refresher already visits every watchlist
token on a loop, and the candle store already holds the bars a resolution would read.


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
