import pandas as pd


def _to_series(candles):
    closes = pd.Series([c["close"] for c in candles], dtype="float64")
    highs = pd.Series([c["high"] for c in candles], dtype="float64")
    lows = pd.Series([c["low"] for c in candles], dtype="float64")
    vols = pd.Series([c["volume"] for c in candles], dtype="float64")
    return closes, highs, lows, vols


def ema(series, period):
    return series.ewm(span=period, adjust=False).mean()


def rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, 1e-12)
    return 100 - (100 / (1 + rs))


def macd(series, fast=12, slow=26, signal=9):
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def detect_higher_low(lows, lookback=10):
    """Simple structure check: is the most recent swing low higher than the prior one?"""
    if len(lows) < lookback + 2:
        return False
    recent = lows.tail(lookback)
    midpoint = len(recent) // 2
    first_half_min = recent.iloc[:midpoint].min()
    second_half_min = recent.iloc[midpoint:].min()
    return second_half_min > first_half_min


def support_resistance(highs, lows, lookback=30):
    window_high = highs.tail(lookback)
    window_low = lows.tail(lookback)
    return {"support": float(window_low.min()), "resistance": float(window_high.max())}


def score_signal(candles, snapshot, min_liquidity_usd, max_1h_volatility_pct):
    """
    Trend(25) + Momentum(20) + Volume(20) + Structure(20) + Token risk(15) = 100
    Token risk starts at 15 and gets deducted (full 15 = low risk).
    Returns score, verdict, and everything the risk engine / alert formatter need.
    """
    if len(candles) < 30:
        raise ValueError("Need at least 30 candles to score reliably.")

    closes, highs, lows, vols = _to_series(candles)
    price = snapshot["price_usd"] or float(closes.iloc[-1])

    ema20 = ema(closes, 20)
    ema50 = ema(closes, min(50, len(closes) - 1))
    rsi14 = rsi(closes, 14)
    macd_line, signal_line, hist = macd(closes)
    sr = support_resistance(highs, lows)
    higher_low = detect_higher_low(lows)

    breakdown = {}

    # ---- Trend (25) ----
    trend_pts = 0
    price_above_emas = price > ema20.iloc[-1] and price > ema50.iloc[-1]
    if price_above_emas:
        trend_pts += 15
    if higher_low:
        trend_pts += 10
    breakdown["trend"] = trend_pts

    # ---- Momentum (20) ----
    momentum_pts = 0
    last_rsi = float(rsi14.iloc[-1])
    if 45 <= last_rsi <= 70:
        momentum_pts += 10
    elif last_rsi > 70:
        momentum_pts += 4
    elif last_rsi < 30:
        momentum_pts += 2
    macd_bullish = bool(hist.iloc[-1] > 0 and hist.iloc[-1] > hist.iloc[-2])
    if macd_bullish:
        momentum_pts += 10
    breakdown["momentum"] = momentum_pts

    # ---- Volume (20) ----
    volume_pts = 0
    avg_vol = vols.tail(20).mean()
    last_vol = vols.iloc[-1]
    vol_increase_pct = ((last_vol - avg_vol) / avg_vol * 100) if avg_vol > 0 else 0
    if vol_increase_pct > 20:
        volume_pts += 12
    elif vol_increase_pct > 0:
        volume_pts += 6
    buys, sells = snapshot["buys_h1"], snapshot["sells_h1"]
    if buys + sells > 0:
        buy_ratio = buys / (buys + sells)
        if buy_ratio > 0.55:
            volume_pts += 8
        elif buy_ratio > 0.45:
            volume_pts += 4
    breakdown["volume"] = volume_pts

    # ---- Structure (20) ----
    structure_pts = 0
    near_resistance_breakout = price >= sr["resistance"] * 0.98
    near_support_bounce = sr["support"] < price <= sr["support"] * 1.05
    if near_resistance_breakout:
        structure_pts += 12
    if higher_low:
        structure_pts += 8
    elif near_support_bounce:
        structure_pts += 5
    breakdown["structure"] = structure_pts

    # ---- Token risk (15) : full points = LOW risk ----
    risk_pts = 15
    liquidity = snapshot["liquidity_usd"]
    volatility_1h = abs(snapshot["price_change_h1"])
    if liquidity < min_liquidity_usd:
        risk_pts -= 10
    elif liquidity < min_liquidity_usd * 2:
        risk_pts -= 4
    if volatility_1h > max_1h_volatility_pct:
        risk_pts -= 8
    elif volatility_1h > max_1h_volatility_pct * 0.6:
        risk_pts -= 3
    risk_pts = max(0, risk_pts)
    breakdown["token_risk"] = risk_pts

    total = trend_pts + momentum_pts + volume_pts + structure_pts + risk_pts
    no_trade = liquidity < min_liquidity_usd or volatility_1h > max_1h_volatility_pct

    if no_trade:
        verdict = "NO TRADE"
    elif total >= 85:
        verdict = "STRONG BUY"
    elif total >= 70:
        verdict = "BUY"
    elif total >= 55:
        verdict = "HOLD / WATCH"
    elif total >= 40:
        verdict = "WEAK"
    else:
        verdict = "SELL / AVOID"

    return {
        "verdict": verdict,
        "score": total,
        "breakdown": breakdown,
        "price": price,
        "rsi": round(last_rsi, 1),
        "macd_bullish": macd_bullish,
        "vol_increase_pct": round(vol_increase_pct, 1),
        "support": sr["support"],
        "resistance": sr["resistance"],
        "higher_low": higher_low,
        "liquidity_usd": liquidity,
        "volatility_1h_pct": volatility_1h,
        "no_trade": no_trade,
    }
