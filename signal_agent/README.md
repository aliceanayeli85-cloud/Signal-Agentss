# CATE Signal Agent — Phase 1 (Signal-Only)

Watches your tokens, scores them with a rules-based model (not AI guessing),
and sends a BUY / HOLD / SELL / **NO TRADE** alert. It does not place trades.

## What it does

1. **Data Engine** — pulls live price/liquidity/volume from DexScreener, and
   hourly candles from GeckoTerminal (both free, no API key).
2. **Signal Engine** — scores Trend (25) + Momentum (20) + Volume (20) +
   Structure (20) + Token Risk (15) = 100. Maps to a verdict:
   - 85–100 STRONG BUY · 70–84 BUY · 55–69 HOLD/WATCH · 40–54 WEAK · 0–39 SELL/AVOID
   - Overridden to **NO TRADE** if liquidity or volatility fails your risk filters —
     that's a real signal, not a bug.
3. **Risk Engine** — entry range, stop, TP1, TP2, risk/reward.
4. **Alerts** — printed to console, and optionally sent to Telegram.
5. **Storage** — every signal is logged to `signals.db` (SQLite) so you can
   later check, after 100+ signals, whether this actually has an edge
   (that's Phase 2 — paper trading).

## Setup

```bash
pip install -r requirements.txt
```

### 1. Find your token's addresses

- Go to your token's page on dexscreener.com.
- The **pair/pool address** is in the URL, e.g.
  `dexscreener.com/solana/<POOL_ADDRESS>`
- The **token address** (mint/contract) is usually shown on the page itself,
  or via `dexscreener.com/latest/dex/search?q=CATE` in a browser.

### 2. Edit `config.py`

Paste in the pool address and token address for each token you want watched.

### 3. (Optional) Set up Telegram alerts

- Message **@BotFather** on Telegram → `/newbot` → copy the token.
- Message your new bot once (anything).
- Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser to find
  your `chat_id`.
- Put both in `config.py`. Leave blank to just use console output.

### 4. Run it

```bash
python main.py
```

It polls every 5 minutes by default (`POLL_INTERVAL_SECONDS` in config.py).
Leave it running in a terminal, tmux session, or as a background service.

## Important notes

- **This does not place trades.** Fomo doesn't expose a public trading API,
  so Phase 4 (auto-execution) from the original plan isn't realistic unless
  that changes — treat this as an alert system, and place trades yourself.
- **GeckoTerminal's free tier is rate-limited.** Don't drop the poll interval
  below ~60 seconds, especially with multiple tokens.
- The scoring thresholds (liquidity minimum, volatility ceiling, RSI zones,
  stop distance) are starting points, not gospel — once you've got signals
  logging in `signals.db`, look at what's actually working and tune
  `config.py` accordingly.

## Next: Phase 2 (Paper Trading)

Once you've got a few days of signals in `signals.db`, the next step is a
small script that checks each logged BUY/SELL against what price actually
did afterward, so you can see a real win rate instead of "it worked three
times." Say the word when you're ready for that piece.
