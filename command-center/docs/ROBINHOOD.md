# Robinhood: what is verified, and how to connect safely

Checked on **2026-10-28** against Robinhood's own pages:

- <https://robinhood.com/us/en/support/articles/agentic-trading-overview/>
- <https://robinhood.com/newsroom/robinhood-is-now-open-to-agents/>

Re-check these before relying on anything below. The product is in beta and changes.

## Verified

- Robinhood runs an **official Trading MCP server** for AI agents at
  `https://agent.robinhood.com/mcp/trading`. It launched in beta on May 27, 2026.
- A connected agent can **read all** your Robinhood accounts (balances, positions, order history).
- It can only **place trades in a separate "Robinhood Agentic" (MCP) account**. Robinhood prompts
  you to open that account during the agent sign-in. You need a primary individual account in good
  standing first.
- Robinhood lists these tool groups: account/portfolio, watchlist, market data, equities,
  options, crypto. The launch announcement says trading is **equities only** during the beta.
- You can review what the agent is about to do. **But if you tell it to act without approval, it
  can place trades without your confirmation.**
- You can disconnect the agent at any time, and Robinhood sends a push notification for each trade.
- Robinhood says you are responsible for, and assume the risk of, every trade an agent places.
- Claude Code setup command, as published by Robinhood:
  `claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading`

## Not verified — do not assume

- The exact tool names and the **order types** available (market, limit, stop, stop-limit,
  trailing stop). Ask the connected agent to list them, then check against Robinhood's order-types
  article.
- Whether **stop orders work on fractional quantities**. If they don't, a fractional position has
  no automatic stop: you must watch it and sell manually.
- Rate limits and size limits for agent orders.

## Why this app is not connected to Robinhood

- This app is a normal web server. It is not an MCP client and holds no Robinhood login.
- Connecting needs **your** sign-in through Robinhood's own screen, inside an AI app. Nobody can do
  that for you, and you should never give anyone your password.
- Live execution is deliberately not built. The plan is paper trading first.
  `ENABLE_LIVE_TRADING=true` makes the server refuse to start.

## The safe workflow (when you are ready for real money)

1. Paper trade until you have **at least 30 closed trades** and you follow the rules consistently.
   Check Journal → P&L.
2. Under Risk, enter the real cash you set aside. Use at most $100, and only money you can afford
   to lose.
3. Connect an AI app to Robinhood using the steps above. Fund only the agentic account.
4. First ask it **read-only** questions: "list my positions", "which order types can you place?"
5. In the app, go to More → Robinhood → **Build ticket**. It uses the real-money risk rules and
   refuses with **NO TRADE — CONDITIONS NOT MET** when the rules say no.
6. Either:
   - type the ticket into the Robinhood app yourself, or
   - paste the generated prompt into the connected AI app. It asks for a **preview only** and
     tells the agent not to place anything until you reply `CONFIRM`.
7. Check the preview against the ticket: ticker, BUY, quantity, order type, price, estimated cost.
   Only then reply `CONFIRM`.
8. Place the protective stop if Robinhood allows it for your quantity, and confirm it shows as
   queued.
9. Record the actual fill under Trades → Real. The monitor will then alert you at the stop,
   targets and thesis invalidation. These are **alerts, not orders**.

## Doing this from a phone

The Robinhood sign-in runs inside whichever AI app you connect. If it won't finish on your phone,
do it once from a computer browser. The app's ticket and prompt work fine from a phone.
