import sqlite3
import time


def init_db(path):
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT,
            timestamp INTEGER,
            verdict TEXT,
            score INTEGER,
            price REAL,
            entry_low REAL,
            entry_high REAL,
            stop REAL,
            tp1 REAL,
            tp2 REAL,
            risk_reward REAL,
            rsi REAL,
            liquidity_usd REAL,
            volatility_1h_pct REAL
        )
    """)
    conn.commit()
    conn.close()


def log_signal(path, token_name, result, levels):
    conn = sqlite3.connect(path)
    conn.execute(
        """INSERT INTO signals
        (token, timestamp, verdict, score, price, entry_low, entry_high, stop, tp1, tp2,
         risk_reward, rsi, liquidity_usd, volatility_1h_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            token_name, int(time.time()), result["verdict"], result["score"], result["price"],
            levels.get("entry_low"), levels.get("entry_high"), levels.get("stop"),
            levels.get("tp1"), levels.get("tp2"), levels.get("risk_reward"),
            result["rsi"], result["liquidity_usd"], result["volatility_1h_pct"],
        ),
    )
    conn.commit()
    conn.close()
