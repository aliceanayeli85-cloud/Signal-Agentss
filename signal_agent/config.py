"""
Configuration for the Signal Agent.
Fill in your tokens, chain info, and (optional) Telegram credentials.
"""

# ---- Tokens to watch ----
# network: GeckoTerminal network slug (e.g. "solana", "eth", "bsc", "base")
# pool_address: the specific liquidity pool address (grab it from the
#     dexscreener.com or geckoterminal.com URL for that pair)
# token_address: the token's contract/mint address
TOKENS = [
    {
        "name": "CATE",
        "network": "solana",
        "pool_address": "HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3",
        "token_address": "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump",
    },
]

# ---- Polling ----
POLL_INTERVAL_SECONDS = 300  # 5 min. GeckoTerminal's free tier is rate-limited — don't go below ~60s.

# ---- Risk filters (these trigger a NO TRADE override regardless of score) ----
MIN_LIQUIDITY_USD = 15000       # below this, liquidity is too thin to trust the signal
MAX_1H_VOLATILITY_PCT = 25.0    # abs(1h price change %) above this = "extreme"

# ---- Telegram (optional) ----
# Leave both blank to just print alerts to the console instead.
# To set up: message @BotFather on Telegram to create a bot and get a token,
# then message your bot once and hit https://api.telegram.org/bot<TOKEN>/getUpdates
# to find your chat_id.
TELEGRAM_BOT_TOKEN = ""
TELEGRAM_CHAT_ID = ""

# ---- Storage ----
DB_PATH = "signals.db"
