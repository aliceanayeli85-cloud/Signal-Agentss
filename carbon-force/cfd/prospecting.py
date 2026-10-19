"""Local opportunities: groups, listings, partners. Records what happened - never
contacts anyone by itself."""

from . import config
from . import validate as v
from .content import load_json
from .crm import today
from .db import now_iso


def seed(conn):
    done = conn.execute("SELECT value FROM settings WHERE key='_prospects_seeded'").fetchone()
    if done:
        return 0
    rows = load_json("prospects_seed.json")
    for r in rows:
        conn.execute(
            """INSERT INTO opportunities(opp_type, name, url_or_contact, rule_type, rules_notes, date_found,
                   status, next_action, source_of_info, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'to_research', ?, ?, ?)""",
            (r["opp_type"], r["name"], r["url_or_contact"], r["rule_type"], r["rules_notes"], today(),
             r["next_action"], r["source_of_info"], now_iso()),
        )
    conn.execute("INSERT INTO settings(key, value) VALUES('_prospects_seeded', ?)", (today(),))
    conn.commit()
    return len(rows)


def _fields(form):
    return {
        "opp_type": v.choice(form.get("opp_type"), "Type", config.OPPORTUNITY_TYPES),
        "name": v.text(form.get("name"), "Name", 200, required=True),
        "url_or_contact": v.text(form.get("url_or_contact"), "Link or public contact", 300),
        "distance_note": v.text(form.get("distance_note"), "Distance", 100),
        "rule_type": v.choice(form.get("rule_type"), "Group rules", list(config.GROUP_RULE_TYPES), "unknown"),
        "rules_notes": v.text(form.get("rules_notes"), "Rules notes", 1000),
        "status": v.choice(form.get("status"), "Status", config.OPPORTUNITY_STATUSES, "to_research"),
        "next_action": v.text(form.get("next_action"), "Next action", 300),
        "next_action_date": v.iso_date(form.get("next_action_date"), "Next action date"),
        "outcome": v.text(form.get("outcome"), "Outcome", 500),
        "source_of_info": v.text(form.get("source_of_info"), "Where you found it", 300),
    }


def add(conn, form):
    f = _fields(form)
    cur = conn.execute(
        f"""INSERT INTO opportunities({', '.join(f)}, date_found, updated_at)
            VALUES({', '.join('?' * len(f))}, ?, ?)""",
        list(f.values()) + [v.iso_date(form.get("date_found"), "Date found") or today(), now_iso()],
    )
    conn.commit()
    return cur.lastrowid


def update(conn, opp_id, form):
    if not conn.execute("SELECT 1 FROM opportunities WHERE id=?", (opp_id,)).fetchone():
        raise v.ValidationError("That opportunity doesn't exist.")
    f = _fields(form)
    conn.execute(
        f"UPDATE opportunities SET {', '.join(k + '=?' for k in f)}, updated_at=? WHERE id=?",
        list(f.values()) + [now_iso(), opp_id],
    )
    conn.commit()


def list_all(conn):
    return conn.execute(
        """SELECT * FROM opportunities ORDER BY
             CASE WHEN next_action_date IS NOT NULL AND next_action_date <= ? THEN 0 ELSE 1 END,
             CASE status WHEN 'to_research' THEN 1 WHEN 'researched' THEN 2 WHEN 'join_requested' THEN 3
                         WHEN 'joined' THEN 4 WHEN 'contacted' THEN 5 ELSE 9 END, id""",
        (today(),),
    ).fetchall()


def due(conn):
    return conn.execute(
        "SELECT * FROM opportunities WHERE next_action_date IS NOT NULL AND next_action_date <= ? "
        "AND status NOT IN ('declined','not_a_fit') ORDER BY next_action_date",
        (today(),),
    ).fetchall()
