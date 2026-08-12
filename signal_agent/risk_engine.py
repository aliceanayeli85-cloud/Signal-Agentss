def calc_levels(price, support, resistance, max_stop_pct=0.15, min_stop_pct=0.05):
    """
    Builds entry/stop/TP1/TP2 off support/resistance structure, clamped to a
    sane distance from price so a stale/distant support doesn't produce a
    nonsense stop-loss. Falls back to simple % bands when structure isn't useful.
    """
    # ---- Stop ----
    stop_distance_pct = (price - support) / price if (price and support < price) else 0
    if min_stop_pct <= stop_distance_pct <= max_stop_pct:
        stop = support * 0.99
    elif stop_distance_pct > max_stop_pct:
        stop = price * (1 - max_stop_pct)   # support too far below — clamp
    else:
        stop = price * (1 - min_stop_pct)   # support too close / above price — floor it

    # ---- Targets ----
    if resistance > price * 1.02:
        tp1 = price + (resistance - price) * 0.6
        tp2 = resistance * 1.05
    else:
        # already through resistance or no real room left — project off the stop distance instead
        risk_amount = price - stop
        tp1 = price + risk_amount * 2.0
        tp2 = price + risk_amount * 3.5

    entry_low = price * 0.998
    entry_high = price * 1.005

    risk = price - stop
    reward = tp1 - price
    rr = round(reward / risk, 2) if risk > 0 else None

    return {
        "entry_low": round(entry_low, 6),
        "entry_high": round(entry_high, 6),
        "stop": round(stop, 6),
        "tp1": round(tp1, 6),
        "tp2": round(tp2, 6),
        "risk_reward": rr,
    }
