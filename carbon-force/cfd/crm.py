"""Leads, follow-ups, availability, appointments, jobs and payments."""

from datetime import date, timedelta

from . import config
from . import validate as v
from .db import now_iso


def today():
    return date.today().isoformat()


def plus_days(n, start=None):
    base = date.fromisoformat(start) if start else date.today()
    return (base + timedelta(days=n)).isoformat()


# ---------------------------------------------------------------- settings

def get_settings(conn):
    stored = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    return {key: stored.get(key, "") for key in config.SETTINGS_FIELDS}


def save_settings(conn, form):
    for key, (label, _hint, _required) in config.SETTINGS_FIELDS.items():
        if key not in form:
            continue
        value = v.text(form.get(key), label, max_len=200)
        if key == "max_jobs_per_day" and value:
            value = str(v.integer(value, label, lo=1, hi=10))
        if key == "launch_date" and value:
            value = v.iso_date(value, label)
        if key == "cash_mode" and value:
            value = "yes" if value.lower() in ("yes", "y", "on", "1", "true") else "no"
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
    conn.commit()


def missing_required_settings(conn):
    s = get_settings(conn)
    return [
        config.SETTINGS_FIELDS[k][0]
        for k, (_l, _h, required) in config.SETTINGS_FIELDS.items()
        if required and not s.get(k)
    ]


def max_jobs_per_day(conn):
    try:
        return max(1, int(get_settings(conn)["max_jobs_per_day"] or 2))
    except ValueError:
        return 2


# ---------------------------------------------------------------- leads

def log_event(conn, lead_id, event_type, note="", event_date=None):
    conn.execute(
        "INSERT INTO lead_events(lead_id, event_date, event_type, note) VALUES(?, ?, ?, ?)",
        (lead_id, event_date or today(), event_type, v.text(note, "Note", 1000)),
    )


def create_lead(conn, form):
    name = v.text(form.get("name"), "Name or nickname", 120, required=True)
    method = v.choice(form.get("contact_method"), "Contact method", config.CONTACT_METHODS)
    contact = v.text(form.get("contact_value"), "Contact detail", 200)
    source = v.choice(form.get("source"), "Source", config.LEAD_SOURCES)
    service = v.choice(form.get("requested_service"), "Requested service", config.SERVICE_CHOICES, "unsure")
    inquiry = v.iso_date(form.get("inquiry_date"), "Inquiry date") or today()
    if inquiry > today():
        raise v.ValidationError("Inquiry date can't be in the future.")
    consent = v.flag(form.get("consent_to_text"))
    stamp = now_iso()
    cur = conn.execute(
        """INSERT INTO leads(name, contact_method, contact_value, consent_to_text, consent_note,
               inquiry_date, source, source_detail, vehicle, requested_service, quoted_price,
               status, next_followup_date, notes, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'New Lead', ?, ?, ?, ?)""",
        (
            name, method, contact, consent,
            v.text(form.get("consent_note"), "Consent note", 200),
            inquiry, source,
            v.text(form.get("source_detail"), "Source detail", 200),
            v.text(form.get("vehicle"), "Vehicle", 120),
            service,
            v.money(form.get("quoted_price"), "Quoted price"),
            inquiry,  # a new inquiry is due for a reply the day it arrives
            v.text(form.get("notes"), "Notes", 2000),
            stamp, stamp,
        ),
    )
    lead_id = cur.lastrowid
    log_event(conn, lead_id, "inquiry", f"via {source}", inquiry)
    conn.commit()
    return lead_id


def get_lead(conn, lead_id):
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
    if not row:
        raise v.ValidationError("That lead doesn't exist.")
    return row


def update_lead(conn, lead_id, form):
    lead = get_lead(conn, lead_id)
    status = v.choice(form.get("status"), "Status", config.LEAD_STATUSES, lead["status"])
    if status == "Lost" and lead["status"] != "Lost":
        log_event(conn, lead_id, "lost", form.get("lost_reason", ""))
    conn.execute(
        """UPDATE leads SET name=?, contact_method=?, contact_value=?, consent_to_text=?,
               consent_note=?, source=?, source_detail=?, vehicle=?, requested_service=?,
               quoted_price=?, status=?, next_followup_date=?, lost_reason=?, notes=?,
               repeat_followup_date=?, updated_at=? WHERE id=?""",
        (
            v.text(form.get("name"), "Name or nickname", 120, required=True),
            v.choice(form.get("contact_method"), "Contact method", config.CONTACT_METHODS),
            v.text(form.get("contact_value"), "Contact detail", 200),
            v.flag(form.get("consent_to_text")),
            v.text(form.get("consent_note"), "Consent note", 200),
            v.choice(form.get("source"), "Source", config.LEAD_SOURCES),
            v.text(form.get("source_detail"), "Source detail", 200),
            v.text(form.get("vehicle"), "Vehicle", 120),
            v.choice(form.get("requested_service"), "Requested service", config.SERVICE_CHOICES, "unsure"),
            v.money(form.get("quoted_price"), "Quoted price"),
            status,
            None if status in ("Lost", "Completed") and not form.get("next_followup_date")
            else v.iso_date(form.get("next_followup_date"), "Next follow-up"),
            v.text(form.get("lost_reason"), "Lost reason", 200),
            v.text(form.get("notes"), "Notes", 2000),
            v.iso_date(form.get("repeat_followup_date"), "Repeat follow-up date"),
            now_iso(), lead_id,
        ),
    )
    conn.commit()


def mark_replied(conn, lead_id, followup_days=2, note=""):
    lead = get_lead(conn, lead_id)
    new_status = "Replied" if lead["status"] in ("New Lead", "Follow-Up Due") else lead["status"]
    conn.execute(
        "UPDATE leads SET status=?, last_contact_date=?, next_followup_date=?, updated_at=? WHERE id=?",
        (new_status, today(), plus_days(followup_days), now_iso(), lead_id),
    )
    log_event(conn, lead_id, "reply_sent", note)
    conn.commit()


def send_quote(conn, lead_id, service, price=None, followup_days=2):
    service = v.choice(service, "Service", list(config.SERVICES))
    amount = v.money(price, "Quoted price")
    if amount is None:
        amount = config.SERVICES[service]["price"]
    get_lead(conn, lead_id)
    conn.execute(
        """UPDATE leads SET status='Quote Sent', requested_service=?, quoted_price=?,
               last_contact_date=?, next_followup_date=?, updated_at=? WHERE id=?""",
        (service, amount, today(), plus_days(followup_days), now_iso(), lead_id),
    )
    log_event(conn, lead_id, "quote_sent", f"{config.SERVICES[service]['label']} ${amount:g}")
    conn.commit()


def log_followup(conn, lead_id, next_days=3, note=""):
    get_lead(conn, lead_id)
    conn.execute(
        "UPDATE leads SET last_contact_date=?, next_followup_date=?, updated_at=? WHERE id=?",
        (today(), plus_days(next_days) if next_days else None, now_iso(), lead_id),
    )
    log_event(conn, lead_id, "followup_sent", note)
    conn.commit()


def refresh_followup_statuses(conn):
    """Flip open leads whose follow-up date has arrived to 'Follow-Up Due'.

    'New Lead' stays as is: it means nobody has replied yet, which is a separate,
    more urgent list on the dashboard.
    """
    conn.execute(
        """UPDATE leads SET status='Follow-Up Due', updated_at=?
           WHERE status IN ('Replied', 'Quote Sent') AND next_followup_date IS NOT NULL
             AND next_followup_date <= ?""",
        (now_iso(), today()),
    )
    conn.commit()


def list_leads(conn, status=None):
    if status:
        return conn.execute("SELECT * FROM leads WHERE status=? ORDER BY inquiry_date DESC, id DESC", (status,)).fetchall()
    return conn.execute(
        """SELECT * FROM leads ORDER BY
             CASE status WHEN 'New Lead' THEN 0 WHEN 'Follow-Up Due' THEN 1 WHEN 'Quote Sent' THEN 2
                         WHEN 'Replied' THEN 3 WHEN 'Booked' THEN 4 WHEN 'Completed' THEN 5 ELSE 6 END,
             inquiry_date DESC, id DESC"""
    ).fetchall()


def lead_events(conn, lead_id):
    return conn.execute("SELECT * FROM lead_events WHERE lead_id=? ORDER BY id DESC", (lead_id,)).fetchall()


# ---------------------------------------------------------------- availability

def add_slot(conn, form):
    slot_date = v.iso_date(form.get("slot_date"), "Date", required=True)
    if slot_date < today():
        raise v.ValidationError("You can't open a slot in the past.")
    dropoff = v.time_hhmm(form.get("dropoff_time"), "Drop-off time", required=True)
    pickup = v.time_hhmm(form.get("pickup_time"), "Pick-up time")
    if pickup and pickup <= dropoff:
        raise v.ValidationError("Pick-up time has to be after drop-off time.")
    clash = conn.execute(
        "SELECT 1 FROM slots WHERE slot_date=? AND dropoff_time=? AND status!='closed'", (slot_date, dropoff)
    ).fetchone()
    if clash:
        raise v.ValidationError("You already have a slot at that date and time.")
    cur = conn.execute(
        "INSERT INTO slots(slot_date, dropoff_time, pickup_time, status, note, created_at) VALUES(?, ?, ?, 'open', ?, ?)",
        (slot_date, dropoff, pickup, v.text(form.get("note"), "Note", 200), now_iso()),
    )
    conn.commit()
    return cur.lastrowid


def close_slot(conn, slot_id):
    slot = conn.execute("SELECT * FROM slots WHERE id=?", (slot_id,)).fetchone()
    if not slot:
        raise v.ValidationError("That slot doesn't exist.")
    if slot["status"] in ("held", "booked"):
        raise v.ValidationError("Cancel the appointment in this slot first.")
    conn.execute("UPDATE slots SET status='closed' WHERE id=?", (slot_id,))
    conn.commit()


def open_slots(conn, days_ahead=14):
    return conn.execute(
        "SELECT * FROM slots WHERE status='open' AND slot_date BETWEEN ? AND ? ORDER BY slot_date, dropoff_time",
        (today(), plus_days(days_ahead)),
    ).fetchall()


def all_slots(conn):
    return conn.execute(
        """SELECT s.*, a.id AS appt_id, a.status AS appt_status, a.lead_id AS lead_id, l.name AS lead_name
           FROM slots s
           LEFT JOIN appointments a ON a.slot_id = s.id AND a.status IN ('proposed','confirmed','completed')
           LEFT JOIN leads l ON l.id = a.lead_id
           WHERE s.slot_date >= ? ORDER BY s.slot_date, s.dropoff_time""",
        (plus_days(-7),),
    ).fetchall()


# ---------------------------------------------------------------- appointments

def propose_appointment(conn, lead_id, slot_id, service, price=None, notes=""):
    """Put a lead into one of YOUR open slots. Only slots you created can be used,
    so the system never offers a time you didn't approve."""
    lead = get_lead(conn, lead_id)
    slot = conn.execute("SELECT * FROM slots WHERE id=?", (slot_id,)).fetchone()
    if not slot:
        raise v.ValidationError("Pick one of your open slots.")
    if slot["status"] != "open":
        raise v.ValidationError("That slot is no longer open.")
    if slot["slot_date"] < today():
        raise v.ValidationError("That slot is in the past.")
    service = v.choice(service, "Service", list(config.SERVICES))
    amount = v.money(price, "Price")
    if amount is None:
        amount = lead["quoted_price"] or config.SERVICES[service]["price"]
    same_day = conn.execute(
        """SELECT count(*) FROM appointments a JOIN slots s ON s.id=a.slot_id
           WHERE s.slot_date=? AND a.status IN ('proposed','confirmed')""",
        (slot["slot_date"],),
    ).fetchone()[0]
    if same_day >= max_jobs_per_day(conn):
        raise v.ValidationError(
            f"You already have {same_day} car(s) that day, which is your daily max. "
            "Raise the max in Settings if you really can take another."
        )
    stamp = now_iso()
    cur = conn.execute(
        """INSERT INTO appointments(lead_id, slot_id, service, quoted_price, status, notes, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'proposed', ?, ?, ?)""",
        (lead_id, slot_id, service, amount, v.text(notes, "Notes", 500), stamp, stamp),
    )
    conn.execute("UPDATE slots SET status='held' WHERE id=?", (slot_id,))
    conn.execute(
        "UPDATE leads SET quoted_price=?, requested_service=?, next_followup_date=?, updated_at=? WHERE id=?",
        (amount, service, plus_days(1), stamp, lead_id),
    )
    log_event(conn, lead_id, "time_offered", f"{slot['slot_date']} {slot['dropoff_time']}")
    conn.commit()
    return cur.lastrowid


def _appointment(conn, appt_id):
    row = conn.execute(
        "SELECT a.*, s.slot_date, s.dropoff_time, s.pickup_time FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE a.id=?",
        (appt_id,),
    ).fetchone()
    if not row:
        raise v.ValidationError("That appointment doesn't exist.")
    return row


def confirm_appointment(conn, appt_id):
    """Call only after the customer has said yes to the time."""
    appt = _appointment(conn, appt_id)
    if appt["status"] != "proposed":
        raise v.ValidationError(f"Only a proposed appointment can be confirmed (this one is {appt['status']}).")
    stamp = now_iso()
    conn.execute("UPDATE appointments SET status='confirmed', confirmed_date=?, updated_at=? WHERE id=?", (today(), stamp, appt_id))
    conn.execute("UPDATE slots SET status='booked' WHERE id=?", (appt["slot_id"],))
    conn.execute(
        "UPDATE leads SET status='Booked', next_followup_date=?, last_contact_date=?, updated_at=? WHERE id=?",
        (plus_days(-1, appt["slot_date"]) if appt["slot_date"] > today() else appt["slot_date"], today(), stamp, appt["lead_id"]),
    )
    log_event(conn, appt["lead_id"], "booked", f"{appt['slot_date']} {appt['dropoff_time']} {appt['service']}")
    conn.commit()


def mark_reminder_sent(conn, appt_id):
    appt = _appointment(conn, appt_id)
    conn.execute("UPDATE appointments SET reminder_sent_date=?, updated_at=? WHERE id=?", (today(), now_iso(), appt_id))
    log_event(conn, appt["lead_id"], "reminder_sent")
    conn.commit()


def cancel_appointment(conn, appt_id, no_show=False, reason=""):
    appt = _appointment(conn, appt_id)
    if appt["status"] not in ("proposed", "confirmed"):
        raise v.ValidationError("Only proposed or confirmed appointments can be cancelled.")
    new_status = "no_show" if no_show else "cancelled"
    stamp = now_iso()
    conn.execute("UPDATE appointments SET status=?, notes=trim(notes || ' ' || ?), updated_at=? WHERE id=?",
                 (new_status, v.text(reason, "Reason", 200), stamp, appt_id))
    # Re-open a future slot so it can be offered again; past slots just close.
    slot_status = "open" if appt["slot_date"] >= today() else "closed"
    conn.execute("UPDATE slots SET status=? WHERE id=?", (slot_status, appt["slot_id"]))
    conn.execute(
        "UPDATE leads SET status='Follow-Up Due', next_followup_date=?, updated_at=? WHERE id=?",
        (plus_days(2), stamp, appt["lead_id"]),
    )
    log_event(conn, appt["lead_id"], new_status, reason)
    conn.commit()


def complete_job(conn, appt_id, form):
    appt = _appointment(conn, appt_id)
    if appt["status"] != "confirmed":
        raise v.ValidationError("Only a confirmed appointment can be marked completed.")
    price = v.money(form.get("price_charged"), "Price charged")
    if price is None:
        price = appt["quoted_price"]
    paid = v.money(form.get("amount_paid"), "Amount paid") or 0.0
    if price <= 0:
        raise v.ValidationError("Price charged must be more than $0.")
    if paid > price:
        raise v.ValidationError("Amount paid is more than the price charged. Record tips in notes.")
    payment_status = "paid" if paid >= price and price > 0 else ("partial" if paid > 0 else "unpaid")
    method = v.choice(form.get("payment_method"), "Payment method", config.PAYMENT_METHODS, "") if paid else ""
    completed = v.iso_date(form.get("completed_date"), "Completed date") or today()
    if completed > today():
        raise v.ValidationError("Completed date can't be in the future.")
    service = v.choice(form.get("service"), "Service", list(config.SERVICES), appt["service"])
    if paid and not method:
        raise v.ValidationError("Pick how they paid.")
    cur = conn.execute(
        """INSERT INTO jobs(appointment_id, lead_id, completed_date, service, price_charged, amount_paid,
               payment_status, payment_method, paid_date, notes) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (appt_id, appt["lead_id"], completed, service, price, paid, payment_status, method,
         completed if paid else None, v.text(form.get("notes"), "Notes", 500)),
    )
    if paid:
        conn.execute("INSERT INTO payments(job_id, paid_date, amount, method) VALUES(?, ?, ?, ?)",
                     (cur.lastrowid, completed, paid, method))
    stamp = now_iso()
    conn.execute("UPDATE appointments SET status='completed', updated_at=? WHERE id=?", (stamp, appt_id))
    conn.execute(
        """UPDATE leads SET status='Completed', next_followup_date=?, repeat_followup_date=?, updated_at=? WHERE id=?""",
        (plus_days(1, completed), plus_days(35, completed), stamp, appt["lead_id"]),
    )
    log_event(conn, appt["lead_id"], "completed", f"{service} ${price:g}", completed)
    if paid:
        log_event(conn, appt["lead_id"], "payment", f"${paid:g} {method}", completed)
    conn.commit()


def record_payment(conn, job_id, amount, method):
    job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not job:
        raise v.ValidationError("That job doesn't exist.")
    amount = v.money(amount, "Amount", required=True)
    if amount <= 0:
        raise v.ValidationError("Amount must be more than $0.")
    method = v.choice(method, "Payment method", config.PAYMENT_METHODS)
    total = round(job["amount_paid"] + amount, 2)
    if total > job["price_charged"]:
        raise v.ValidationError("That would be more than the price charged.")
    status = "paid" if total >= job["price_charged"] else "partial"
    conn.execute("UPDATE jobs SET amount_paid=?, payment_status=?, payment_method=?, paid_date=? WHERE id=?",
                 (total, status, method, today(), job_id))
    conn.execute("INSERT INTO payments(job_id, paid_date, amount, method) VALUES(?, ?, ?, ?)",
                 (job_id, today(), amount, method))
    log_event(conn, job["lead_id"], "payment", f"${amount:g} {method}")
    conn.commit()


def mark_review_requested(conn, lead_id):
    get_lead(conn, lead_id)
    conn.execute("UPDATE leads SET review_requested_date=?, next_followup_date=NULL, updated_at=? WHERE id=?",
                 (today(), now_iso(), lead_id))
    log_event(conn, lead_id, "review_requested")
    conn.commit()


def mark_review_received(conn, lead_id):
    get_lead(conn, lead_id)
    conn.execute("UPDATE leads SET review_received=1, updated_at=? WHERE id=?", (now_iso(), lead_id))
    log_event(conn, lead_id, "review_received")
    conn.commit()


def mark_repeat_offer_sent(conn, lead_id):
    get_lead(conn, lead_id)
    conn.execute("UPDATE leads SET repeat_followup_date=?, updated_at=? WHERE id=?", (plus_days(60), now_iso(), lead_id))
    log_event(conn, lead_id, "repeat_offer_sent")
    conn.commit()


def appointments(conn, statuses=("proposed", "confirmed")):
    marks = ",".join("?" * len(statuses))
    return conn.execute(
        f"""SELECT a.*, s.slot_date, s.dropoff_time, s.pickup_time, l.name AS lead_name,
                   l.contact_method, l.contact_value
            FROM appointments a JOIN slots s ON s.id=a.slot_id JOIN leads l ON l.id=a.lead_id
            WHERE a.status IN ({marks}) ORDER BY s.slot_date, s.dropoff_time""",
        statuses,
    ).fetchall()


def jobs(conn, limit=200):
    return conn.execute(
        """SELECT j.*, l.name AS lead_name FROM jobs j JOIN leads l ON l.id=j.lead_id
           ORDER BY j.completed_date DESC, j.id DESC LIMIT ?""",
        (limit,),
    ).fetchall()


# ---------------------------------------------------------------- effort log

def log_effort(conn, form):
    conn.execute(
        "INSERT INTO effort_log(log_date, channel, activity, minutes) VALUES(?, ?, ?, ?)",
        (
            v.iso_date(form.get("log_date"), "Date") or today(),
            v.choice(form.get("channel"), "Channel", config.EFFORT_CHANNELS),
            v.text(form.get("activity"), "What you did", 200, required=True),
            v.integer(form.get("minutes"), "Minutes", lo=0, hi=600, default=0),
        ),
    )
    conn.commit()
