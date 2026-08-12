import argparse
import time
import traceback

import config
from data_engine import fetch_ohlcv, fetch_snapshot, DataEngineError
from signal_engine import score_signal
from risk_engine import calc_levels
from alerts import build_message, send_console, send_telegram
from storage import init_db, log_signal


def run_once(token_cfg):
    candles = fetch_ohlcv(token_cfg["network"], token_cfg["pool_address"], timeframe="hour", limit=100)
    snapshot = fetch_snapshot(token_cfg["token_address"])

    result = score_signal(
        candles, snapshot,
        min_liquidity_usd=config.MIN_LIQUIDITY_USD,
        max_1h_volatility_pct=config.MAX_1H_VOLATILITY_PCT,
    )
    levels = {} if result["no_trade"] else calc_levels(result["price"], result["support"], result["resistance"])

    message = build_message(token_cfg["name"], result, levels)
    send_console(message)
    send_telegram(message, config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID)
    log_signal(config.DB_PATH, token_cfg["name"], result, levels)


def run_cycle():
    failures = 0
    for token_cfg in config.TOKENS:
        try:
            run_once(token_cfg)
        except DataEngineError as e:
            failures += 1
            print(f"[{token_cfg['name']}] data error: {e}")
        except Exception:
            failures += 1
            print(f"[{token_cfg['name']}] unexpected error:")
            traceback.print_exc()
    return failures


def main(once=False):
    init_db(config.DB_PATH)
    print(f"Signal agent started. Watching {len(config.TOKENS)} token(s).")
    if once:
        return run_cycle()

    print("Polling continuously. Ctrl+C to stop.")
    while True:
        run_cycle()
        time.sleep(config.POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CATE signal agent")
    parser.add_argument(
        "--once",
        action="store_true",
        help="fetch, score, log one signal per token, then exit",
    )
    args = parser.parse_args()
    raise SystemExit(main(once=args.once))
