"""SQLite storage, schema and backups. Standard library only."""

import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = ROOT / "data"

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_method TEXT NOT NULL,
    contact_value TEXT NOT NULL DEFAULT '',
    consent_to_text INTEGER NOT NULL DEFAULT 0,
    consent_note TEXT NOT NULL DEFAULT '',
    inquiry_date TEXT NOT NULL,
    source TEXT NOT NULL,
    source_detail TEXT NOT NULL DEFAULT '',
    vehicle TEXT NOT NULL DEFAULT '',
    requested_service TEXT NOT NULL DEFAULT 'unsure',
    quoted_price REAL,
    status TEXT NOT NULL DEFAULT 'New Lead',
    next_followup_date TEXT,
    last_contact_date TEXT,
    lost_reason TEXT NOT NULL DEFAULT '',
    review_requested_date TEXT,
    review_received INTEGER NOT NULL DEFAULT 0,
    repeat_followup_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lead_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    event_date TEXT NOT NULL,
    event_type TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_date TEXT NOT NULL,
    dropoff_time TEXT NOT NULL,
    pickup_time TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    slot_id INTEGER NOT NULL REFERENCES slots(id),
    service TEXT NOT NULL,
    quoted_price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    confirmed_date TEXT,
    reminder_sent_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    completed_date TEXT NOT NULL,
    service TEXT NOT NULL,
    price_charged REAL NOT NULL,
    amount_paid REAL NOT NULL DEFAULT 0,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    payment_method TEXT NOT NULL DEFAULT '',
    paid_date TEXT,
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    paid_date TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    day INTEGER NOT NULL,
    title TEXT NOT NULL,
    pillar TEXT NOT NULL,
    purpose TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT NOT NULL,
    season TEXT NOT NULL DEFAULT 'any',
    needs_real_photos INTEGER NOT NULL DEFAULT 0,
    facebook TEXT NOT NULL DEFAULT '',
    instagram TEXT NOT NULL DEFAULT '',
    story TEXT NOT NULL DEFAULT '',
    reel_script TEXT NOT NULL DEFAULT '',
    group_version TEXT NOT NULL DEFAULT '',
    visual TEXT NOT NULL DEFAULT '',
    shots TEXT NOT NULL DEFAULT '',
    cta TEXT NOT NULL DEFAULT '',
    allow_terms TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    approved_date TEXT,
    scheduled_date TEXT,
    published_date TEXT,
    published_where TEXT NOT NULL DEFAULT '',
    owner_notes TEXT NOT NULL DEFAULT '',
    edited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opp_type TEXT NOT NULL,
    name TEXT NOT NULL,
    url_or_contact TEXT NOT NULL DEFAULT '',
    distance_note TEXT NOT NULL DEFAULT '',
    rule_type TEXT NOT NULL DEFAULT 'unknown',
    rules_notes TEXT NOT NULL DEFAULT '',
    date_found TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'to_research',
    next_action TEXT NOT NULL DEFAULT '',
    next_action_date TEXT,
    outcome TEXT NOT NULL DEFAULT '',
    source_of_info TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effort_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_date TEXT NOT NULL,
    channel TEXT NOT NULL,
    activity TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_slots_date ON slots(slot_date);
"""


def data_dir():
    return Path(os.environ.get("CFD_DATA_DIR", DEFAULT_DATA_DIR))


def db_path():
    return data_dir() / "carbon_force.db"


def _restrict(path):
    # Customer data: owner-only on macOS/Linux. Windows ignores chmod bits; the
    # folder sits inside the user's own profile there.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def connect(path=None):
    path = Path(path) if path else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    if new:
        _restrict(path)
    return conn


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def backup(conn, keep=30, label="auto"):
    """Copy the live database to data/backups/ using SQLite's online backup API.

    Keeps the newest `keep` files; older auto backups are pruned, manual ones never are.
    """
    backups = data_dir() / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = backups / f"carbon_force-{label}-{stamp}.db"
    dest = sqlite3.connect(str(target))
    with dest:
        conn.backup(dest)
    dest.close()
    _restrict(target)
    if label == "auto":
        autos = sorted(backups.glob("carbon_force-auto-*.db"))
        for old in autos[:-keep]:
            old.unlink()
    return target


def daily_backup_if_needed(conn):
    backups = data_dir() / "backups"
    today = datetime.now().strftime("%Y%m%d")
    if backups.exists() and any(backups.glob(f"carbon_force-auto-{today}-*.db")):
        return None
    return backup(conn)


def restore(backup_file, target=None):
    target = Path(target) if target else db_path()
    src = Path(backup_file)
    if not src.exists():
        raise FileNotFoundError(src)
    check = sqlite3.connect(str(src))
    try:
        check.execute("SELECT count(*) FROM leads").fetchone()
    finally:
        check.close()
    if target.exists():
        safety = target.with_name(f"carbon_force-before-restore-{datetime.now():%Y%m%d-%H%M%S}.db")
        shutil.copy2(target, safety)
    shutil.copy2(src, target)
    _restrict(target)
    return target
