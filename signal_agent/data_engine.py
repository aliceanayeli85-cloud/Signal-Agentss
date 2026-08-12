import time
import requests

GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2"
DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex"


class DataEngineError(Exception):
    pass


def fetch_ohlcv(network: str, pool_address: str, timeframe: str = "hour", aggregate: int = 1, limit: int = 100):
    """
    Pulls OHLCV candles from GeckoTerminal (free, no API key needed).
    timeframe: 'day' | 'hour' | 'minute'
    Returns a list of dicts, OLDEST first:
        {"timestamp": int, "open": float, "high": float, "low": float, "close": float, "volume": float}
    """
    url = f"{GECKOTERMINAL_BASE}/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}"
    params = {"aggregate": aggregate, "limit": limit, "currency": "usd"}
    resp = requests.get(url, params=params, timeout=15)
    if resp.status_code != 200:
        raise DataEngineError(f"GeckoTerminal OHLCV failed ({resp.status_code}): {resp.text[:200]}")

    raw = resp.json()["data"]["attributes"]["ohlcv_list"]
    # GeckoTerminal returns newest-first: [timestamp, open, high, low, close, volume]
    candles = [
        {"timestamp": row[0], "open": row[1], "high": row[2], "low": row[3], "close": row[4], "volume": row[5]}
        for row in reversed(raw)
    ]
    return candles


def fetch_snapshot(token_address: str):
    """
    Pulls a live snapshot from DexScreener (free, no API key needed).
    Picks the highest-liquidity pair for the token.
    """
    url = f"{DEXSCREENER_BASE}/tokens/{token_address}"
    resp = requests.get(url, timeout=15)
    if resp.status_code != 200:
        raise DataEngineError(f"DexScreener snapshot failed ({resp.status_code}): {resp.text[:200]}")

    pairs = resp.json().get("pairs") or []
    if not pairs:
        raise DataEngineError("No pairs found for this token on DexScreener.")

    best = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0))
    txns_h1 = (best.get("txns") or {}).get("h1", {}) or {}

    return {
        "price_usd": float(best.get("priceUsd", 0) or 0),
        "liquidity_usd": float((best.get("liquidity") or {}).get("usd", 0) or 0),
        "volume_h1": float((best.get("volume") or {}).get("h1", 0) or 0),
        "volume_h24": float((best.get("volume") or {}).get("h24", 0) or 0),
        "price_change_h1": float((best.get("priceChange") or {}).get("h1", 0) or 0),
        "price_change_h24": float((best.get("priceChange") or {}).get("h24", 0) or 0),
        "buys_h1": int(txns_h1.get("buys", 0) or 0),
        "sells_h1": int(txns_h1.get("sells", 0) or 0),
        "market_cap": float(best.get("marketCap", 0) or 0),
        "fdv": float(best.get("fdv", 0) or 0),
        "pair_url": best.get("url", ""),
        "fetched_at": int(time.time()),
    }
