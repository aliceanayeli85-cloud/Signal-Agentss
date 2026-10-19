"""Dashboard numbers, daily plan and the weekly report. Real recorded data only."""

from datetime import date, timedelta

from . import config
from .content import load_json, todays_posts
from .crm import get_settings, open_slots, plus_days, today

LOST_OR_DONE = ("Lost", "Completed")


def plan_day_number(settings, on=None):
    on = date.fromisoformat(on) if on else date.today()
    launch = settings.get("launch_date")
    if launch:
        start = date.fromisoformat(launch)
        if on < start:
            return None
        return (on - start).days % 7 + 1
    return on.isoweekday()  # Monday = Day 1 until a launch date is set


def todays_plan(conn):
    settings = get_settings(conn)
    plan = load_json("weekly_plan.json")
    n = plan_day_number(settings)
    return {
        "cash_mode": settings.get("cash_mode") == "yes",
        "day_number": n,
        "day": plan["normal"][n - 1] if n else None,
        "cash_steps": plan["cash_mode"],
        "launch_date": settings.get("launch_date"),
    }


def revenue(conn, start=None, end=None):
    """Money actually collected (payments recorded), not quotes or bookings."""
    sql = "SELECT COALESCE(SUM(amount), 0) FROM payments"
    args = []
    if start:
        sql += " WHERE paid_date BETWEEN ? AND ?"
        args = [start, end]
    return round(conn.execute(sql, args).fetchone()[0], 2)


def outstanding(conn):
    return round(conn.execute(
        "SELECT COALESCE(SUM(price_charged - amount_paid), 0) FROM jobs WHERE payment_status IN ('unpaid','partial')"
    ).fetchone()[0], 2)


def funnel(conn, start=None, end=None):
    """Counts of leads and what happened to them. With a date range, it's leads whose
    inquiry date falls inside the range."""
    where, args = "", []
    if start:
        where, args = " WHERE inquiry_date BETWEEN ? AND ?", [start, end]
    leads = conn.execute(f"SELECT id FROM leads{where}", args).fetchall()
    ids = [r["id"] for r in leads]
    if not ids:
        return {"leads": 0, "quoted": 0, "booked": 0, "completed": 0, "lost": 0,
                "lead_to_booking": None, "quote_to_booking": None}
    marks = ",".join("?" * len(ids))

    def has(event):
        return conn.execute(
            f"SELECT count(DISTINCT lead_id) FROM lead_events WHERE event_type=? AND lead_id IN ({marks})",
            [event] + ids,
        ).fetchone()[0]

    quoted, booked, completed, lost = has("quote_sent"), has("booked"), has("completed"), has("lost")
    return {
        "leads": len(ids),
        "quoted": quoted,
        "booked": booked,
        "completed": completed,
        "lost": lost,
        "lead_to_booking": round(100 * booked / len(ids)) if ids else None,
        "quote_to_booking": round(100 * booked / quoted) if quoted else None,
    }


def channel_stats(conn, start=None, end=None):
    where, args = "", []
    if start:
        where, args = " WHERE l.inquiry_date BETWEEN ? AND ?", [start, end]
    rows = conn.execute(
        f"""SELECT l.source,
                   count(*) AS inquiries,
                   sum(EXISTS(SELECT 1 FROM lead_events e WHERE e.lead_id=l.id AND e.event_type='booked')) AS booked,
                   COALESCE((SELECT sum(p.amount) FROM payments p JOIN jobs j ON j.id=p.job_id
                             WHERE j.lead_id IN (SELECT id FROM leads x WHERE x.source=l.source)), 0) AS revenue_all_time
            FROM leads l{where} GROUP BY l.source ORDER BY inquiries DESC""",
        args,
    ).fetchall()
    return [dict(r) for r in rows]


def effort_by_channel(conn, start, end):
    rows = conn.execute(
        """SELECT channel, count(*) AS actions, COALESCE(sum(minutes), 0) AS minutes
           FROM effort_log WHERE log_date BETWEEN ? AND ? GROUP BY channel""",
        (start, end),
    ).fetchall()
    return {r["channel"]: dict(r) for r in rows}


def dashboard(conn):
    t = today()
    week_start = (date.today() - timedelta(days=date.today().weekday())).isoformat()
    unanswered = conn.execute("SELECT * FROM leads WHERE status='New Lead' ORDER BY inquiry_date, id").fetchall()
    followups = conn.execute(
        f"""SELECT * FROM leads WHERE status NOT IN ('New Lead', 'Lost', 'Completed', 'Booked')
              AND next_followup_date IS NOT NULL AND next_followup_date <= ? ORDER BY next_followup_date""",
        (t,),
    ).fetchall()
    review_due = conn.execute(
        """SELECT l.*, j.completed_date FROM leads l JOIN jobs j ON j.lead_id=l.id
           WHERE l.review_requested_date IS NULL AND j.payment_status='paid' AND j.completed_date < ?
           GROUP BY l.id ORDER BY j.completed_date""",
        (t,),
    ).fetchall()
    repeat_due = conn.execute(
        "SELECT * FROM leads WHERE status='Completed' AND repeat_followup_date IS NOT NULL AND repeat_followup_date <= ?",
        (t,),
    ).fetchall()
    appts = conn.execute(
        """SELECT a.*, s.slot_date, s.dropoff_time, l.name AS lead_name FROM appointments a
           JOIN slots s ON s.id=a.slot_id JOIN leads l ON l.id=a.lead_id
           WHERE a.status IN ('proposed','confirmed') AND s.slot_date >= ? ORDER BY s.slot_date, s.dropoff_time""",
        (plus_days(-1),),
    ).fetchall()
    reminders_due = [a for a in appts if a["status"] == "confirmed" and a["slot_date"] == plus_days(1) and not a["reminder_sent_date"]]
    unpaid = conn.execute(
        """SELECT j.*, l.name AS lead_name FROM jobs j JOIN leads l ON l.id=j.lead_id
           WHERE j.payment_status IN ('unpaid','partial') ORDER BY j.completed_date""").fetchall()
    jobs_week = conn.execute("SELECT count(*) FROM jobs WHERE completed_date BETWEEN ? AND ?", (week_start, t)).fetchone()[0]
    jobs_all = conn.execute("SELECT count(*) FROM jobs").fetchone()[0]
    return {
        "today": t,
        "plan": todays_plan(conn),
        "posts": todays_posts(conn),
        "unanswered": unanswered,
        "followups": followups,
        "review_due": review_due,
        "repeat_due": repeat_due,
        "appointments": appts,
        "reminders_due": reminders_due,
        "open_slots": open_slots(conn, days_ahead=7),
        "unpaid": unpaid,
        "jobs_week": jobs_week,
        "jobs_all": jobs_all,
        "revenue_week": revenue(conn, week_start, t),
        "revenue_all": revenue(conn),
        "outstanding": outstanding(conn),
        "funnel_all": funnel(conn),
        "channels": channel_stats(conn),
    }


def week_bounds(any_day=None):
    d = date.fromisoformat(any_day) if any_day else date.today()
    start = d - timedelta(days=d.weekday())
    return start.isoformat(), (start + timedelta(days=6)).isoformat()


def _events(conn, kind, start, end):
    return conn.execute(
        "SELECT count(*) FROM lead_events WHERE event_type=? AND event_date BETWEEN ? AND ?", (kind, start, end)
    ).fetchone()[0]


def weekly_report(conn, any_day=None):
    start, end = week_bounds(any_day)
    posts = conn.execute(
        "SELECT id, title, published_date, published_where FROM posts WHERE status='published' AND published_date BETWEEN ? AND ? ORDER BY published_date",
        (start, end),
    ).fetchall()
    channels = channel_stats(conn, start, end)
    effort = effort_by_channel(conn, start, end)
    inquiries = sum(c["inquiries"] for c in channels)

    # Median-ish speed: average days from inquiry to first reply for this week's leads.
    speed = conn.execute(
        """SELECT avg(julianday(r.first_reply) - julianday(l.inquiry_date)) FROM leads l
           JOIN (SELECT lead_id, min(event_date) AS first_reply FROM lead_events
                 WHERE event_type IN ('reply_sent','quote_sent') GROUP BY lead_id) r ON r.lead_id=l.id
           WHERE l.inquiry_date BETWEEN ? AND ?""",
        (start, end),
    ).fetchone()[0]

    effort_rows = []
    for ch in sorted(set(effort) | {c["source"] for c in channels}):
        e = effort.get(ch, {"actions": 0, "minutes": 0})
        inq = next((c["inquiries"] for c in channels if c["source"] == ch), 0)
        published_here = sum(1 for p in posts if ch.split("_")[0] in (p["published_where"] or "").lower())
        effort_rows.append({
            "channel": ch, "actions": e["actions"], "minutes": e["minutes"], "posts": published_here,
            "inquiries": inq,
            "inquiries_per_hour": round(inq / (e["minutes"] / 60), 1) if e["minutes"] else None,
        })

    report = {
        "start": start,
        "end": end,
        "posts_published": [dict(p) for p in posts],
        "inquiries": inquiries,
        "channels": channels,
        "replies_sent": _events(conn, "reply_sent", start, end),
        "quotes_sent": _events(conn, "quote_sent", start, end),
        "followups_sent": _events(conn, "followup_sent", start, end),
        "booked": _events(conn, "booked", start, end),
        "cancelled": _events(conn, "cancelled", start, end),
        "no_shows": _events(conn, "no_show", start, end),
        "jobs_completed": conn.execute("SELECT count(*) FROM jobs WHERE completed_date BETWEEN ? AND ?", (start, end)).fetchone()[0],
        "revenue": revenue(conn, start, end),
        "outstanding_now": outstanding(conn),
        "avg_days_to_reply": round(speed, 1) if speed is not None else None,
        "effort": effort_rows,
        "funnel": funnel(conn, start, end),
    }
    report["next_week"] = recommendations(conn, report)
    return report


def recommendations(conn, r):
    """Plain rules on top of the recorded numbers. No data -> says so."""
    tips = []
    total_activity = r["inquiries"] + len(r["posts_published"]) + sum(e["actions"] for e in r["effort"])
    if total_activity == 0:
        return ["Nothing was recorded this week, so there's nothing to judge yet. Log posts, leads and effort as they happen - "
                "next week's report will be useful."]
    if not r["posts_published"]:
        tips.append("No posts were marked published. Approve 2-3 posts on Sunday and publish one every other day.")
    if r["avg_days_to_reply"] is not None and r["avg_days_to_reply"] >= 1:
        tips.append(f"Average reply took {r['avg_days_to_reply']} day(s). Same-day replies win more jobs - check messages twice a day.")
    still_new = conn.execute("SELECT count(*) FROM leads WHERE status='New Lead'").fetchone()[0]
    if still_new:
        tips.append(f"{still_new} lead(s) still have no reply. Answer them first thing tomorrow.")
    if r["quotes_sent"] and not r["booked"]:
        tips.append("Quotes went out but nobody booked. Send the quote follow-up and include real open times.")
    for e in r["effort"]:
        if e["minutes"] >= 60 and e["inquiries"] == 0:
            tips.append(f"{e['channel']}: {e['minutes']} min this week, 0 inquiries. Cut that time in half next week unless it's a long-term thing (like Google).")
    best = [e for e in r["effort"] if e["inquiries_per_hour"]]
    if best:
        top = max(best, key=lambda e: e["inquiries_per_hour"])
        tips.append(f"Best return on time: {top['channel']} ({top['inquiries_per_hour']} inquiries/hour). Do a bit more of that.")
    sources = {c["source"] for c in r["channels"]}
    if r["jobs_completed"] and "referral" not in sources:
        tips.append("You finished jobs this week - send the referral ask to happy customers.")
    if r["inquiries"] and not any(e["minutes"] for e in r["effort"]):
        tips.append("Leads came in but no effort was logged, so the report can't tell which work paid off. Log minutes per channel.")
    if r["cancelled"] + r["no_shows"] >= 2:
        tips.append("2+ cancellations/no-shows. Send the reminder template the day before every appointment.")
    if not tips:
        tips.append("Nothing jumps out. Keep the same routine another week so there's enough data to compare.")
    return tips


def weekly_report_text(r):
    lines = [f"CARBON FORCE DETAILING - WEEKLY REPORT {r['start']} to {r['end']}", ""]
    lines.append(f"Posts published: {len(r['posts_published'])}")
    for p in r["posts_published"]:
        lines.append(f"  - {p['published_date']}  {p['title']}  ({p['published_where']})")
    lines.append(f"Inquiries: {r['inquiries']}")
    for c in r["channels"]:
        lines.append(f"  - {c['source']}: {c['inquiries']} (booked so far: {c['booked']})")
    lines += [
        f"Replies sent: {r['replies_sent']}   Quotes sent: {r['quotes_sent']}   Follow-ups sent: {r['followups_sent']}",
        f"Appointments booked: {r['booked']}   Cancelled: {r['cancelled']}   No-shows: {r['no_shows']}",
        f"Jobs completed: {r['jobs_completed']}",
        f"Revenue collected: ${r['revenue']:.2f}   (still owed to you: ${r['outstanding_now']:.2f})",
        f"Average days to first reply: {r['avg_days_to_reply'] if r['avg_days_to_reply'] is not None else 'n/a'}",
        "",
        "Effort by channel:",
    ]
    for e in r["effort"]:
        rate = e["inquiries_per_hour"] if e["inquiries_per_hour"] is not None else "n/a"
        lines.append(f"  - {e['channel']}: {e['actions']} actions, {e['minutes']} min, {e['inquiries']} inquiries, {rate}/hour")
    lines += ["", "What to change next week:"] + [f"  - {t}" for t in r["next_week"]]
    lines += ["", "Only recorded data is counted. Likes and views are not revenue."]
    return "\n".join(lines)


def service_label(key):
    return config.SERVICES.get(key, {}).get("label", key)
