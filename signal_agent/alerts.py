import requests

ICONS = {
    "STRONG BUY": "🟢🟢",
    "BUY": "🟢",
    "HOLD / WATCH": "🟡",
    "WEAK": "🟠",
    "SELL / AVOID": "🔴",
    "NO TRADE": "🚫",
}


def build_message(token_name, result, levels):
    verdict = result["verdict"]
    icon = ICONS.get(verdict, "")

    reasons = []
    if result["breakdown"]["trend"] >= 15:
        reasons.append("price above key EMAs")
    if result["higher_low"]:
        reasons.append("higher low formed")
    if result["macd_bullish"]:
        reasons.append("MACD turning bullish")
    if result["vol_increase_pct"] > 20:
        reasons.append(f"volume up {result['vol_increase_pct']}%")

    if result["no_trade"]:
        if result["liquidity_usd"] < 15000:
            reasons = ["liquidity too thin to trust"]
        else:
            reasons = ["volatility too extreme right now"]

    reason_text = ", ".join(reasons) if reasons else "no strong confluence yet"

    lines = [
        f"{icon} {token_name} — {verdict}",
        "",
        f"Confidence: {result['score']}/100",
    ]

    if verdict != "NO TRADE":
        rr = f"1:{levels['risk_reward']}" if levels.get("risk_reward") else "n/a"
        lines += [
            f"Entry: ${levels['entry_low']}–${levels['entry_high']}",
            f"Stop: ${levels['stop']}",
            f"TP1: ${levels['tp1']}",
            f"TP2: ${levels['tp2']}",
            f"Risk/Reward: {rr}",
            "",
        ]

    lines += [
        f"Why: {reason_text}.",
        f"RSI: {result['rsi']} | Liquidity: ${result['liquidity_usd']:,.0f} | 1h move: {result['volatility_1h_pct']:.1f}%",
    ]

    if verdict != "NO TRADE":
        lines.append(f"Invalidation: close below ${levels['stop']} cancels this thesis.")

    return "\n".join(lines)


def send_console(message):
    print("\n" + message + "\n" + "-" * 40)


def send_telegram(message, bot_token, chat_id):
    if not bot_token or not chat_id:
        return
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    try:
        requests.post(url, data={"chat_id": chat_id, "text": message}, timeout=10)
    except requests.RequestException as e:
        print(f"Telegram send failed: {e}")
