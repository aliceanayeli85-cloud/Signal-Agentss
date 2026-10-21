"""Page bodies. Each function returns (title, body_html)."""

from . import config, content, crm, prospecting, reports, templates
from .web import (SERVICE_LABELS, badge, copy_block, esc, field, form, money, options, pct, select)

PUBLISH_STEPS = {
    "facebook": [
        "Open your Facebook Page (not your personal profile).",
        "Create post -> paste the Facebook text -> add your real photo(s)/video.",
        "Read it once out loud. Fix anything that doesn't sound like you.",
        "Post (or use Facebook's own Schedule option).",
        "Come back here and press 'Mark published'.",
    ],
    "instagram": [
        "Open Instagram -> + -> Post / Reel / Story.",
        "Pick your real photo(s)/clip. For Reels, add on-screen text from the script.",
        "Paste the Instagram caption. Keep hashtags to 3-5.",
        "Share, then press 'Mark published' here.",
    ],
    "group": [
        "Open the group -> read the rules again (they change).",
        "Only post if the rule type allows it today (see Prospecting).",
        "Paste the group version. Add one real photo.",
        "Don't post the same thing in lots of groups on the same day.",
        "Log it in the effort log as facebook_group.",
    ],
}


def _setup_warning(conn):
    missing = crm.missing_required_settings(conn)
    if not missing:
        return ""
    return (f'<div class="card warn"><b>Finish Settings before you post or reply.</b> Missing: '
            f'{esc(", ".join(missing))}. <a href="/settings">Open Settings</a></div>')


def lead_link(row, label=None):
    return f'<a href="/leads/{row["id"]}">{esc(label or row["name"])}</a>'


# ------------------------------------------------------------------ dashboard

def dashboard(conn, csrf):
    d = reports.dashboard(conn)
    plan = d["plan"]
    parts = [_setup_warning(conn)]

    if plan["cash_mode"]:
        steps = "".join(f"<li>{esc(s)}</li>" for s in plan["cash_steps"])
        todo = f'<div class="card danger"><h2>CASH MODE is on</h2><ol class="todo">{steps}</ol>' \
               f'<small>Turn it off in Settings when bookings are steady.</small></div>'
    elif plan["day"]:
        day = plan["day"]
        todo = f"""<div class="card good"><h2>Today: Day {plan['day_number']} - {esc(day['theme'])}</h2>
<ol class="todo"><li><b>Content:</b> {esc(day['content'])}</li>
<li><b>Get customers:</b> {esc(day['acquisition'])}</li>
<li><b>Follow up:</b> {esc(day['followup'])}</li>
<li class="muted"><b>If you have energy:</b> {esc(day['optional'])}</li></ol>
<small>{'Day 1 = ' + esc(plan['launch_date']) if plan['launch_date'] else 'Set a launch date in Settings to start Day 1 when you want. Until then Monday = Day 1.'}</small></div>"""
    else:
        todo = f'<div class="card"><h2>Launch hasn\'t started</h2>Your Day 1 is {esc(plan["launch_date"])}. Use the time to finish Settings and approve your first posts.</div>'
    parts.append(todo)

    def lead_list(rows, empty, extra=None):
        if not rows:
            return f'<p class="muted">{esc(empty)}</p>'
        items = []
        for r in rows:
            note = extra(r) if extra else ""
            items.append(f'<li>{lead_link(r)} {badge(r["status"])} <small>{esc(r["source"].replace("_", " "))} - '
                         f'{esc(SERVICE_LABELS.get(r["requested_service"], r["requested_service"]))}{note}</small></li>')
        return f'<ul class="tight">{"".join(items)}</ul>'

    action_cards = f"""<div class="grid">
<div class="card {'danger' if d['unanswered'] else ''}"><h2>New leads - no reply yet ({len(d['unanswered'])})</h2>
{lead_list(d['unanswered'], 'None. Nice.', lambda r: ' - asked ' + esc(r['inquiry_date']))}
<a href="/leads/new">+ Add a new inquiry</a></div>
<div class="card {'warn' if d['followups'] else ''}"><h2>Follow-ups due ({len(d['followups'])})</h2>
{lead_list(d['followups'], 'Nothing due today.', lambda r: ' - due ' + esc(r['next_followup_date']))}</div>
<div class="card"><h2>After-the-job</h2>
<h3>Reminders to send (appointments tomorrow)</h3>{_appt_list(d['reminders_due'], 'None.')}
<h3>Review requests due</h3>{lead_list(d['review_due'], 'None.')}
<h3>Repeat-booking reminders due</h3>{lead_list(d['repeat_due'], 'None.')}</div>
</div>"""
    parts.append(action_cards)

    opp_due = prospecting.due(conn)
    if opp_due:
        items = "".join(f'<li><a href="/prospecting#o{o["id"]}">{esc(o["name"])}</a> - {esc(o["next_action"])}</li>' for o in opp_due)
        parts.append(f'<div class="card warn"><h2>Prospecting actions due</h2><ul class="tight">{items}</ul></div>')

    post_items = []
    for p in d["posts"]:
        when = f" - scheduled {esc(p['scheduled_date'])}" if p["scheduled_date"] else ""
        post_items.append(f'<li><a href="/content/{esc(p["id"])}">Day {p["day"]}: {esc(p["title"])}</a> {badge(p["status"])}'
                          f'<small>{esc(p["platform"])}{when}</small></li>')
    parts.append(f"""<div class="grid"><div class="card"><h2>Today's posts</h2>
<ul class="tight">{''.join(post_items) or '<li class="muted">Library is empty.</li>'}</ul>
<small>Open a post to see the filled-in text, the visual to use and step-by-step publishing instructions.
Drafts must be approved by you first.</small></div>
<div class="card"><h2>Appointments</h2>{_appt_list(d['appointments'], 'No upcoming appointments.')}
<h3>Open drop-off slots (next 7 days)</h3>{_slot_list(d['open_slots'])}
<a href="/booking">Manage booking</a></div></div>""")

    f = d["funnel_all"]
    chan_rows = "".join(
        f"<tr><td>{esc(c['source'].replace('_', ' '))}</td><td>{c['inquiries']}</td><td>{c['booked']}</td>"
        f"<td>{money(c['revenue_all_time'])}</td></tr>" for c in d["channels"]
    ) or '<tr><td colspan="4" class="muted">No leads recorded yet.</td></tr>'
    unpaid = "".join(f'<li>{esc(j["lead_name"])}: {money(j["price_charged"] - j["amount_paid"])} owed '
                     f'<a href="/booking#j{j["id"]}">record payment</a></li>' for j in d["unpaid"])
    parts.append(f"""<div class="grid">
<div class="card"><h2>Money (collected only)</h2>
<div class="big">{money(d['revenue_week'])}</div><small>collected this week (Mon-today)</small>
<p>All time: <b>{money(d['revenue_all'])}</b><br>Still owed to you: <b>{money(d['outstanding'])}</b></p>
<p>Jobs completed: <b>{d['jobs_week']}</b> this week, <b>{d['jobs_all']}</b> all time</p>
{'<h3>Unpaid</h3><ul class="tight">' + unpaid + '</ul>' if unpaid else ''}
<small>Quotes, bookings, likes and views are never counted as revenue.</small></div>
<div class="card"><h2>Leads to bookings (all time)</h2>
<p>Leads: <b>{f['leads']}</b> - quoted: <b>{f['quoted']}</b> - booked: <b>{f['booked']}</b> - completed: <b>{f['completed']}</b> - lost: <b>{f['lost']}</b></p>
<p>Lead to booking: <b>{pct(f['lead_to_booking'])}</b> - Quote to booking: <b>{pct(f['quote_to_booking'])}</b></p></div>
<div class="card"><h2>Where inquiries come from</h2><div class="tablewrap"><table>
<tr><th>Channel</th><th>Inquiries</th><th>Booked</th><th>Collected</th></tr>{chan_rows}</table></div></div>
</div>""")
    return "Today", "".join(parts)


def _appt_list(rows, empty):
    if not rows:
        return f'<p class="muted">{esc(empty)}</p>'
    items = "".join(
        f'<li>{esc(templates.friendly_date(a["slot_date"]))} {esc(templates.friendly_time(a["dropoff_time"]))} - '
        f'<a href="/leads/{a["lead_id"]}">{esc(a["lead_name"])}</a> - {esc(config.SERVICES[a["service"]]["label"])} '
        f'{money(a["quoted_price"])} {badge(a["status"])}</li>'
        for a in rows
    )
    return f'<ul class="tight">{items}</ul>'


def _slot_list(rows):
    if not rows:
        return '<p class="muted">No open slots entered. Add the times you can actually take a car on the Booking page.</p>'
    return '<ul class="tight">' + "".join(
        f'<li>{esc(templates.friendly_date(s["slot_date"]))}, drop-off {esc(templates.friendly_time(s["dropoff_time"]))}</li>'
        for s in rows) + "</ul>"


# ------------------------------------------------------------------ leads

def lead_form_fields(lead=None):
    g = (lambda k, default="": (lead[k] if lead is not None and lead[k] is not None else default))
    return f"""<div class="row">
{field('Name or nickname', 'name', g('name'), required=True, hint='Whatever helps you remember them. First name is fine.')}
{select('Contact method', 'contact_method', config.CONTACT_METHODS, g('contact_method', 'text'))}
{field('Phone / handle / email', 'contact_value', g('contact_value'))}
</div><div class="row">
{select('Where did they find you?', 'source', config.LEAD_SOURCES, g('source', 'facebook_page'))}
{field('Source detail', 'source_detail', g('source_detail'), hint='e.g. which group or post')}
{field('Vehicle', 'vehicle', g('vehicle'), hint='e.g. 2017 Honda CR-V')}
</div><div class="row">
{select('Service they want', 'requested_service', config.SERVICE_CHOICES, g('requested_service', 'unsure'), SERVICE_LABELS)}
{field('Quoted price', 'quoted_price', f"{g('quoted_price'):g}" if g('quoted_price') != '' else '', hint='Leave blank until you quote')}
</div>
<label><input type="checkbox" name="consent_to_text" value="1" {'checked' if g('consent_to_text', 0) else ''}>
They contacted me first / said it's OK to text them about this job</label>
{field('Consent note', 'consent_note', g('consent_note'), hint='e.g. "texted me first 10/19"')}
{field('Notes', 'notes', g('notes'), kind='textarea')}"""


def leads_list(conn, status=None):
    rows = crm.list_leads(conn, status)
    filt = " ".join(f'<a href="/leads?status={esc(s)}">{esc(s)}</a> |' for s in config.LEAD_STATUSES)
    body = f'<p><a href="/leads/new"><b>+ Add a new inquiry</b></a></p><p class="muted">Filter: <a href="/leads">All</a> | {filt} <a href="/export/leads.csv">Export CSV</a></p>'
    trs = "".join(
        f"<tr><td>{lead_link(r)}</td><td>{badge(r['status'])}</td><td>{esc(r['inquiry_date'])}</td>"
        f"<td>{esc(r['source'].replace('_', ' '))}</td><td>{esc(SERVICE_LABELS.get(r['requested_service'], ''))}</td>"
        f"<td>{money(r['quoted_price']) if r['quoted_price'] is not None else '-'}</td><td>{esc(r['next_followup_date'] or '-')}</td></tr>"
        for r in rows
    ) or '<tr><td colspan="7" class="muted">No leads yet. When someone messages you, add them here first.</td></tr>'
    body += f'<div class="card tablewrap"><table><tr><th>Name</th><th>Status</th><th>Asked</th><th>Source</th><th>Service</th><th>Quote</th><th>Next follow-up</th></tr>{trs}</table></div>'
    return "Leads", body


def new_lead(conn, csrf):
    body = form("/leads", f"""{field('Date they asked', 'inquiry_date', crm.today(), kind='date')}{lead_form_fields()}""",
                csrf, "Add lead")
    return "New inquiry", f'<div class="card">{body}</div>'


def lead_detail(conn, csrf, lead_id):
    lead = crm.get_lead(conn, lead_id)
    events = crm.lead_events(conn, lead_id)
    appts = conn.execute(
        """SELECT a.*, s.slot_date, s.dropoff_time, s.pickup_time FROM appointments a JOIN slots s ON s.id=a.slot_id
           WHERE a.lead_id=? ORDER BY a.id DESC""", (lead_id,)).fetchall()
    jobs = conn.execute("SELECT * FROM jobs WHERE lead_id=? ORDER BY id DESC", (lead_id,)).fetchall()
    slots = crm.open_slots(conn, days_ahead=21)

    quick = "".join([
        form(f"/leads/{lead_id}/reply", '<input type="hidden" name="days" value="2">', csrf, "I replied", "inline"),
        form(f"/leads/{lead_id}/followup", '<input type="hidden" name="days" value="4">', csrf, "I sent a follow-up", "inline"),
        form(f"/leads/{lead_id}/followup", '<input type="hidden" name="days" value="0">', csrf, "Final follow-up sent", "inline"),
    ])
    quote = form(f"/leads/{lead_id}/quote",
                 '<div class="row">' + select("Service", "service", list(config.SERVICES),
                                              lead["requested_service"] if lead["requested_service"] in config.SERVICES else "full", SERVICE_LABELS)
                 + field("Price (blank = standard price)", "price", "") + "</div>", csrf, "I sent this quote")
    if slots:
        offer = form(f"/leads/{lead_id}/offer",
                     '<div class="row">' + f'<label>Your open slot<select name="slot_id">'
                     + "".join(f'<option value="{s["id"]}">{esc(templates.friendly_date(s["slot_date"]))} - {esc(templates.friendly_time(s["dropoff_time"]))}</option>' for s in slots)
                     + "</select></label>"
                     + select("Service", "service", list(config.SERVICES),
                              lead["requested_service"] if lead["requested_service"] in config.SERVICES else "full", SERVICE_LABELS)
                     + field("Price (blank = quote or standard)", "price", "") + "</div>",
                     csrf, "Hold this slot for them")
        offer += '<small>Holding a slot doesn\'t book it. Press Confirm only after they say yes.</small>'
    else:
        offer = '<p class="muted">No open slots. <a href="/booking">Add your real available times</a> first.</p>'

    appt_html = ""
    for a in appts:
        actions = ""
        if a["status"] == "proposed":
            actions += form(f"/appointments/{a['id']}/confirm", "", csrf, "Customer said yes - confirm", "inline")
            actions += form(f"/appointments/{a['id']}/cancel", "", csrf, "Release slot", "inline")
        if a["status"] == "confirmed":
            actions += form(f"/appointments/{a['id']}/reminder", "", csrf, "Reminder sent", "inline")
            actions += form(f"/appointments/{a['id']}/cancel", field("Reason", "reason", ""), csrf, "Cancelled", "inline", confirm="Cancel this appointment?")
            actions += form(f"/appointments/{a['id']}/noshow", "", csrf, "No-show", "inline", confirm="Mark as no-show?")
            actions += "<details><summary>Job done - record it</summary>" + form(
                f"/appointments/{a['id']}/complete",
                '<div class="row">' + select("Service done", "service", list(config.SERVICES), a["service"], SERVICE_LABELS)
                + field("Price charged", "price_charged", f"{a['quoted_price']:g}")
                + field("Amount paid now", "amount_paid", f"{a['quoted_price']:g}", hint="0 if they haven't paid yet")
                + select("Paid with", "payment_method", [""] + config.PAYMENT_METHODS, "") + "</div>"
                + field("Completed date", "completed_date", crm.today(), kind="date") + field("Notes", "notes", ""),
                csrf, "Mark completed") + "</details>"
        tmpl = ""
        if a["status"] in ("proposed", "confirmed"):
            tmpl = "<details><summary>Messages for this appointment</summary>" + "".join(
                f"<h3>{esc(t['title'])}</h3>" + copy_block(templates.render(conn, t["id"], lead, a))
                for t in templates.all_templates() if t["id"] in ("booking_confirmation", "reminder", "ready_pickup", "reschedule")
            ) + "</details>"
        appt_html += (f'<div class="card"><b>{esc(templates.friendly_date(a["slot_date"]))} {esc(templates.friendly_time(a["dropoff_time"]))}</b> '
                      f'- {esc(config.SERVICES[a["service"]]["label"])} {money(a["quoted_price"])} {badge(a["status"])}'
                      f'<div>{actions}</div>{tmpl}</div>')

    after = ""
    if jobs:
        after = '<div class="card"><h2>After the job</h2>'
        for j in jobs:
            after += f'<p>{esc(j["completed_date"])}: {esc(config.SERVICES[j["service"]]["label"])} - charged {money(j["price_charged"])}, paid {money(j["amount_paid"])} {badge(j["payment_status"])}</p>'
        after += form(f"/leads/{lead_id}/review_requested", "", csrf, "Review request sent", "inline") if not lead["review_requested_date"] else f'<p class="muted">Review requested {esc(lead["review_requested_date"])}.</p>'
        after += form(f"/leads/{lead_id}/review_received", "", csrf, "They left a review", "inline") if not lead["review_received"] else '<p>Review received.</p>'
        after += form(f"/leads/{lead_id}/repeat_sent", "", csrf, "Repeat offer sent", "inline")
        after += f'<small>Repeat reminder date: {esc(lead["repeat_followup_date"] or "-")}</small></div>'

    reply_ids = ["price", "location", "come_to_me", "full_package", "availability", "pet_or_stain",
                 "quote_followup", "no_reply_1", "no_reply_2", "review_request", "referral_ask", "repeat_offer"]
    by_id = {t["id"]: t for t in templates.all_templates()}
    replies = "".join(
        f'<details><summary>{esc(by_id[i]["title"])}</summary><small>{esc(by_id[i]["when"])}</small>'
        f'{copy_block(templates.render(conn, i, lead))}<small>Then: {esc(by_id[i]["next_step"])}</small></details>'
        for i in reply_ids
    )
    timeline = "".join(f"<li>{esc(e['event_date'])} - {esc(e['event_type'].replace('_', ' '))} {esc(e['note'])}</li>" for e in events)
    consent = "yes" if lead["consent_to_text"] else "not recorded"

    body = f"""<p>{badge(lead['status'])} asked {esc(lead['inquiry_date'])} via <b>{esc(lead['source'].replace('_', ' '))}</b>
{esc(lead['source_detail'])} - {esc(lead['contact_method'].replace('_', ' '))}: {esc(lead['contact_value'])} -
consent to text: {consent} - next follow-up: <b>{esc(lead['next_followup_date'] or '-')}</b></p>
<div class="grid">
<div class="card"><h2>1. Reply (copy, paste, send yourself)</h2>{replies}</div>
<div class="card"><h2>2. Record what you did</h2>{quick}<h3>Quote</h3>{quote}<h3>Offer a drop-off time</h3>{offer}</div>
</div>
{appt_html}{after}
<div class="card"><h2>Edit lead</h2>{form(f'/leads/{lead_id}/update', lead_form_fields(lead) + '<div class="row">'
    + select('Status', 'status', config.LEAD_STATUSES, lead['status'])
    + field('Next follow-up', 'next_followup_date', lead['next_followup_date'] or '', kind='date')
    + field('Repeat reminder date', 'repeat_followup_date', lead['repeat_followup_date'] or '', kind='date')
    + field('Lost reason', 'lost_reason', lead['lost_reason']) + '</div>', csrf, 'Save changes')}</div>
<div class="card"><h2>History</h2><ul class="tight">{timeline}</ul></div>"""
    return lead["name"], body


# ------------------------------------------------------------------ booking

def booking(conn, csrf):
    slots = crm.all_slots(conn)
    rows = ""
    for s in slots:
        who = f'<a href="/leads/{s["lead_id"]}">{esc(s["lead_name"])}</a>' if s["lead_name"] else ""
        close = form(f"/slots/{s['id']}/close", "", csrf, "Close", "inline") if s["status"] == "open" else ""
        rows += (f"<tr><td>{esc(templates.friendly_date(s['slot_date']))}</td><td>{esc(templates.friendly_time(s['dropoff_time']))}"
                 f"{(' - pick-up ' + esc(templates.friendly_time(s['pickup_time']))) if s['pickup_time'] else ''}</td>"
                 f"<td>{badge(s['status'])}</td><td>{who} {badge(s['appt_status']) if s['appt_status'] else ''}</td><td>{esc(s['note'])} {close}</td></tr>")
    rows = rows or '<tr><td colspan="5" class="muted">No slots yet.</td></tr>'
    add = form("/slots", '<div class="row">' + field("Date", "slot_date", crm.plus_days(1), kind="date", required=True)
               + field("Drop-off time", "dropoff_time", "08:30", kind="time", required=True)
               + field("Expected pick-up (optional)", "pickup_time", "", kind="time")
               + field("Note", "note", "") + "</div>", csrf, "Add open slot")
    jobs = crm.jobs(conn)
    jrows = ""
    for j in jobs:
        pay = ""
        if j["payment_status"] in ("unpaid", "partial"):
            pay = form(f"/jobs/{j['id']}/payment", '<div class="row">' + field("Amount", "amount", f"{j['price_charged'] - j['amount_paid']:g}")
                       + select("Method", "method", config.PAYMENT_METHODS, "cash") + "</div>", csrf, "Record payment")
        jrows += (f'<tr id="j{j["id"]}"><td>{esc(j["completed_date"])}</td><td><a href="/leads/{j["lead_id"]}">{esc(j["lead_name"])}</a></td>'
                  f'<td>{esc(config.SERVICES[j["service"]]["label"])}</td><td>{money(j["price_charged"])}</td><td>{money(j["amount_paid"])}</td>'
                  f'<td>{badge(j["payment_status"])} {esc(j["payment_method"])}{pay}</td></tr>')
    jrows = jrows or '<tr><td colspan="6" class="muted">No completed jobs yet.</td></tr>'
    body = f"""<div class="card warn"><b>How booking works:</b> 1) Add the drop-off times you can REALLY take a car.
2) On a lead, hold one of those slots and send them the time. 3) When they say yes, press Confirm.
The app won't let you book a time you didn't add, or more cars per day than your max ({crm.max_jobs_per_day(conn)}).</div>
<div class="card"><h2>Add an open drop-off slot</h2>{add}</div>
<div class="card"><h2>Upcoming appointments</h2>{_appt_list(crm.appointments(conn), 'None yet.')}</div>
<div class="card tablewrap"><h2>Your slots</h2><table><tr><th>Date</th><th>Time</th><th>Slot</th><th>Customer</th><th></th></tr>{rows}</table></div>
<div class="card tablewrap"><h2>Completed jobs and payments</h2><table><tr><th>Done</th><th>Customer</th><th>Service</th><th>Charged</th><th>Paid</th><th>Payment</th></tr>{jrows}</table></div>"""
    return "Booking", body


# ------------------------------------------------------------------ content

def content_list(conn, status=None):
    rows = content.list_posts(conn, status)
    counts = {s: conn.execute("SELECT count(*) FROM posts WHERE status=?", (s,)).fetchone()[0] for s in config.POST_STATUSES}
    filt = " | ".join(f'<a href="/content?status={s}">{s} ({counts[s]})</a>' for s in config.POST_STATUSES)
    trs = "".join(
        f'<tr><td>{p["day"]}</td><td><a href="/content/{esc(p["id"])}">{esc(p["title"])}</a>'
        f'{" <small>needs your real photos/video</small>" if p["needs_real_photos"] else ""}</td>'
        f'<td>{esc(p["pillar"])}</td><td>{esc(p["platform"])}</td><td>{esc(p["season"])}</td><td>{badge(p["status"])}</td></tr>'
        for p in rows
    )
    body = f"""<p class="muted">Filter: <a href="/content">all</a> | {filt}</p>
<div class="card warn">Nothing here is posted for you. Workflow: <b>draft -> you approve -> you post it yourself -> mark published</b>.
Seasonal posts (fall/winter) are marked; skip ones that don't fit the week. See <code>content/shot-list.md</code> for what to film.</div>
<div class="card tablewrap"><table><tr><th>Day</th><th>Post</th><th>Type</th><th>Platform</th><th>Season</th><th>Status</th></tr>{trs}</table></div>"""
    return "Posts (30-day library)", body


def content_detail(conn, csrf, post_id):
    p = content.get_post(conn, post_id)
    settings = crm.get_settings(conn)
    problems = content.post_problems(p, settings)
    sections = ""
    labels = {"facebook": "Facebook Page", "instagram": "Instagram caption", "story": "Story frames",
              "reel_script": "Reel script (no voice, text on screen)", "group_version": "Community-group version"}
    for f, label in labels.items():
        if p[f]:
            sections += f"<h3>{esc(label)}</h3>" + copy_block(content.fill(p[f], settings))
    steps = []
    if p["facebook"]:
        steps.append(("Facebook Page", PUBLISH_STEPS["facebook"]))
    if p["instagram"] or p["story"] or p["reel_script"]:
        steps.append(("Instagram", PUBLISH_STEPS["instagram"]))
    if p["group_version"]:
        steps.append(("Community groups", PUBLISH_STEPS["group"]))
    steps_html = "".join(f"<h3>{esc(t)}</h3><ol>{''.join(f'<li>{esc(s)}</li>' for s in ss)}</ol>" for t, ss in steps)

    actions = ""
    if p["status"] == "draft":
        tick = ('<label><input type="checkbox" name="photos_confirmed" value="1"> I have my own real photos/video for this</label>'
                if p["needs_real_photos"] else "")
        actions += form(f"/content/{esc(post_id)}/status", tick + '<input type="hidden" name="status" value="approved">', csrf, "Approve")
    if p["status"] in ("approved", "scheduled"):
        actions += form(f"/content/{esc(post_id)}/status", '<input type="hidden" name="status" value="scheduled">'
                        + field("Planned date", "scheduled_date", p["scheduled_date"] or crm.today(), kind="date"), csrf, "Schedule (planning only)")
        actions += form(f"/content/{esc(post_id)}/status", '<input type="hidden" name="status" value="published">'
                        + field("Where you posted it", "published_where", "", required=True, hint="e.g. facebook page, instagram, Melrose Park Neighbors group")
                        + field("Date posted", "published_date", crm.today(), kind="date"), csrf, "Mark published (I posted it)")
        actions += form(f"/content/{esc(post_id)}/status", '<input type="hidden" name="status" value="draft">', csrf, "Back to draft", "inline")
    if p["status"] == "published":
        actions = f'<p>Published {esc(p["published_date"])} - {esc(p["published_where"])}</p>'

    prob_html = ""
    if problems and p["status"] == "draft":
        prob_html = '<div class="card warn"><b>Before you can approve:</b><ul class="tight">' + "".join(f"<li>{esc(x)}</li>" for x in problems) + "</ul></div>"

    real_note = ("<br><b>Needs your genuine photos/video.</b> Never use stock photos or someone else's work."
                 if p["needs_real_photos"] else "")
    edit_form = form(f"/content/{esc(post_id)}/edit", "".join(field(labels[f], f, p[f], kind="textarea") for f in labels)
                     + field("Your notes", "owner_notes", p["owner_notes"], kind="textarea"), csrf, "Save wording")
    body = f"""<p>{badge(p['status'])} Day {p['day']} - {esc(p['pillar'])} - {esc(p['platform'])} - {esc(p['format'])} - season: {esc(p['season'])}</p>
<div class="card"><b>Purpose:</b> {esc(p['purpose'])}<br><b>Call to action:</b> {esc(p['cta'])}<br>
<b>Visual:</b> {esc(p['visual'])}{real_note}
<h3>Shot list</h3><pre>{esc(p['shots'])}</pre></div>
{prob_html}
<div class="grid"><div class="card"><h2>Ready-to-paste text</h2>{sections}</div>
<div class="card"><h2>Approve / publish</h2>{actions}<h2>How to post it</h2>{steps_html}</div></div>
<div class="card"><details><summary>Edit the wording</summary>
<small>Placeholders like {{price_full}} and {{booking_line}} fill in from Settings. Editing an approved post sends it back to draft.</small>
{edit_form}</details></div>"""
    return p["title"], body


# ------------------------------------------------------------------ replies

def replies_page(conn):
    groups = {}
    for t in templates.all_templates():
        groups.setdefault(t["group"], []).append(t)
    body = ('<div class="card warn">These are filled in with your Settings and your REAL open slots. '
            'To fill in a customer\'s name, open the template from their lead page. You send every message yourself.</div>')
    for g, ts in groups.items():
        body += f'<div class="card"><h2>{esc(g)}</h2>'
        for t in ts:
            body += (f'<h3>{esc(t["title"])}</h3><small>{esc(t["when"])}</small>{copy_block(templates.render(conn, t["id"]))}'
                     f'<small>Then: {esc(t["next_step"])}</small>')
        body += "</div>"
    return "Reply templates", body


# ------------------------------------------------------------------ prospecting

def opp_fields(o=None):
    g = (lambda k, default="": (o[k] if o is not None and o[k] is not None else default))
    rule_labels = dict(config.GROUP_RULE_TYPES)
    return ('<div class="row">' + select("Type", "opp_type", config.OPPORTUNITY_TYPES, g("opp_type", "facebook_group"))
            + field("Name", "name", g("name"), required=True)
            + field("Link or PUBLIC contact", "url_or_contact", g("url_or_contact")) + "</div>"
            + '<div class="row">' + field("Distance from you", "distance_note", g("distance_note"))
            + select("Group rules", "rule_type", list(config.GROUP_RULE_TYPES), g("rule_type", "unknown"), rule_labels)
            + select("Status", "status", config.OPPORTUNITY_STATUSES, g("status", "to_research")) + "</div>"
            + field("Rules notes", "rules_notes", g("rules_notes"), kind="textarea")
            + '<div class="row">' + field("Next action", "next_action", g("next_action"))
            + field("Next action date", "next_action_date", g("next_action_date"), kind="date") + "</div>"
            + field("Outcome so far", "outcome", g("outcome"))
            + field("Where this info came from", "source_of_info", g("source_of_info")))


def prospecting_page(conn, csrf):
    rows = prospecting.list_all(conn)
    cards = ""
    for o in rows:
        rule_help = config.GROUP_RULE_TYPES.get(o["rule_type"], "")
        update_form = form(f"/prospecting/{o['id']}", opp_fields(o), csrf, "Save")
        cards += (f'<div class="card" id="o{o["id"]}"><b>{esc(o["name"])}</b> {badge(o["status"])} <small>{esc(o["opp_type"].replace("_", " "))} - '
                  f'found {esc(o["date_found"])} - {esc(o["url_or_contact"])}</small>'
                  f'<p><b>Next:</b> {esc(o["next_action"] or "-")} {("(" + esc(o["next_action_date"]) + ")") if o["next_action_date"] else ""}<br>'
                  f'<b>Rules:</b> {esc(rule_help)}<br><small>{esc(o["rules_notes"])}</small>'
                  f'{"<br><b>Outcome:</b> " + esc(o["outcome"]) if o["outcome"] else ""}</p>'
                  f'<details><summary>Update</summary>{update_form}</details></div>')
    body = f"""<div class="card warn"><b>Rules:</b> follow each platform's and group's rules. Public business contacts only.
No scraping, no buying leads, no mass messages. Statuses only change when YOU did the thing - nothing here has been contacted or created yet unless you marked it.
Group rule types decide which draft to use: <i>promo allowed</i> or <i>promo day only</i> -> the post's group version; <i>recommendations only</i> -> the
'Answering a recommendation post' reply; <i>no business</i> -> don't post. Full guide: <code>playbooks/local-prospecting.md</code>.</div>
<div class="card"><details><summary><b>+ Add an opportunity</b></summary>{form('/prospecting', opp_fields(), csrf, 'Add')}</details></div>
{cards}"""
    return "Local prospecting", body


# ------------------------------------------------------------------ plan + effort

def plan_page(conn, csrf):
    plan = content.load_json("weekly_plan.json")
    p = reports.todays_plan(conn)
    days = "".join(
        f"""<div class="card {'good' if p['day_number'] == d['day'] else ''}"><h2>Day {d['day']} - {esc(d['theme'])}</h2><ol class="todo">
<li><b>Content:</b> {esc(d['content'])}</li><li><b>Get customers:</b> {esc(d['acquisition'])}</li>
<li><b>Follow up:</b> {esc(d['followup'])}</li><li class="muted"><b>Optional:</b> {esc(d['optional'])}</li></ol></div>"""
        for d in plan["normal"])
    cash = "".join(f"<li>{esc(s)}</li>" for s in plan["cash_mode"])
    toggle = "no" if p["cash_mode"] else "yes"
    effort = form("/effort", '<div class="row">' + field("Date", "log_date", crm.today(), kind="date")
                  + select("Channel", "channel", config.EFFORT_CHANNELS, "facebook_page")
                  + field("What you did", "activity", "", required=True) + field("Minutes", "minutes", "15") + "</div>", csrf, "Log it")
    recent = conn.execute("SELECT * FROM effort_log ORDER BY log_date DESC, id DESC LIMIT 15").fetchall()
    rec = "".join(f"<li>{esc(r['log_date'])} - {esc(r['channel'])} - {esc(r['activity'])} ({r['minutes']} min)</li>" for r in recent)
    body = f"""<div class="card"><h2>Log marketing time</h2><small>Log every posting/outreach session (rough minutes is fine). The weekly report compares time spent to inquiries per channel.</small>{effort}
<ul class="tight">{rec}</ul></div>
<div class="card danger"><h2>CASH MODE {'(ON)' if p['cash_mode'] else '(off)'}</h2><small>Use when you need paying jobs this week. It replaces the normal day plan on the Today page.</small>
<ol class="todo">{cash}</ol>{form('/settings/cash_mode', f'<input type="hidden" name="cash_mode" value="{toggle}">', csrf, 'Turn cash mode ' + ('off' if p['cash_mode'] else 'on'))}</div>
<h2>7-day routine (about 30-45 min a day)</h2>{days}"""
    return "Daily plan", body


# ------------------------------------------------------------------ weekly

def report_page(conn, week=None):
    r = reports.weekly_report(conn, week)
    prev = crm.plus_days(-7, r["start"])
    nxt = crm.plus_days(7, r["start"])
    body = f"""<p><a href="/report?week={prev}">&larr; previous week</a> | <a href="/report?week={nxt}">next week &rarr;</a> |
<a href="/report.txt?week={esc(r['start'])}">plain-text version</a></p>
<div class="card"><h2>What to change next week</h2><ul class="tight">{''.join(f'<li>{esc(t)}</li>' for t in r['next_week'])}</ul></div>
{copy_block(reports.weekly_report_text(r))}"""
    return f"Week of {r['start']}", body


# ------------------------------------------------------------------ settings

def settings_page(conn, csrf):
    s = crm.get_settings(conn)
    fields = ""
    for key, (label, hint, required) in config.SETTINGS_FIELDS.items():
        kind = "date" if key == "launch_date" else "text"
        if key == "cash_mode":
            fields += select(label, key, ["no", "yes"], s[key] or "no")
            continue
        h = (f"Example: {hint}" if hint else "") + (" (required before approving posts)" if required else "")
        fields += field(label, key, s[key], kind=kind, hint=h)
    backups = form("/backup", "", csrf, "Back up now")
    body = f"""<div class="card warn">Examples are only hints - nothing is saved until you type your own real details.
Never put passwords or account logins here.</div>
<div class="card">{form('/settings', fields, csrf, 'Save settings')}</div>
<div class="card"><h2>Backups</h2><p>The app makes one automatic backup per day when it starts (kept: 30).
Files are in <code>data/backups/</code>. Copy that folder to a USB drive or private cloud folder once a week.</p>{backups}
<p><a href="/export/leads.csv">Download leads as CSV</a> (contains customer info - keep it private).</p></div>"""
    return "Settings", body
