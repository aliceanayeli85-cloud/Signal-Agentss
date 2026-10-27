"""Fake TEST data for trying the app. Only ever loaded into data/demo/, never your real database."""

from . import content, crm, prospecting
from .db import now_iso


def _past_slot(conn, days_ago, time="09:00"):
    cur = conn.execute(
        "INSERT INTO slots(slot_date, dropoff_time, status, created_at) VALUES(?, ?, 'open', ?)",
        (crm.plus_days(-days_ago), time, now_iso()),
    )
    return cur.lastrowid


def load(conn):
    content.sync_library(conn)
    prospecting.seed(conn)
    if conn.execute("SELECT count(*) FROM leads").fetchone()[0]:
        return False
    crm.save_settings(conn, {
        "booking_line": "TEST: text 000-000-0000 to book",
        "phone": "000-000-0000",
        "area_line": "TEST AREA, Melrose Park",
        "hours_line": "TEST drop-off hours",
        "payment_methods": "cash, Zelle",
        "interior_includes": "TEST interior list",
        "exterior_includes": "TEST exterior list",
        "turnaround_line": "TEST turnaround wording",
        "max_jobs_per_day": "2",
    })

    def lead(name, source, service, days_ago):
        return crm.create_lead(conn, {"name": f"TEST {name}", "contact_method": "text", "contact_value": "000-000-0000",
                                      "source": source, "requested_service": service,
                                      "inquiry_date": crm.plus_days(-days_ago)})

    lead("Unanswered Ana", "facebook_group", "interior", 0)
    b = lead("Quoted Ben", "facebook_page", "full", 3)
    crm.send_quote(conn, b, "full")
    conn.execute("UPDATE leads SET next_followup_date=? WHERE id=?", (crm.today(), b))

    c = lead("Done Carla", "referral", "full", 6)
    crm.send_quote(conn, c, "full")
    slot = _past_slot(conn, 2)
    appt = conn.execute(
        "INSERT INTO appointments(lead_id, slot_id, service, quoted_price, status, created_at, updated_at) "
        "VALUES(?, ?, 'full', 140, 'proposed', ?, ?)", (c, slot, now_iso(), now_iso())).lastrowid
    conn.execute("UPDATE slots SET status='held' WHERE id=?", (slot,))
    crm.confirm_appointment(conn, appt)
    crm.complete_job(conn, appt, {"price_charged": "140", "amount_paid": "140", "payment_method": "cash",
                                  "completed_date": crm.plus_days(-2)})

    d = lead("Upcoming Dev", "instagram", "interior", 1)
    s1 = crm.add_slot(conn, {"slot_date": crm.plus_days(1), "dropoff_time": "08:30"})
    a2 = crm.propose_appointment(conn, d, s1, "interior")
    crm.confirm_appointment(conn, a2)
    crm.add_slot(conn, {"slot_date": crm.plus_days(2), "dropoff_time": "09:00"})
    crm.add_slot(conn, {"slot_date": crm.plus_days(4), "dropoff_time": "08:30"})

    crm.log_effort(conn, {"channel": "facebook_group", "activity": "TEST answered 2 recommendation posts", "minutes": "20"})
    crm.log_effort(conn, {"channel": "instagram", "activity": "TEST posted a reel", "minutes": "45"})
    conn.commit()
    return True
