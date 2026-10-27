"""Reply templates filled in with a lead's details and your REAL open slots."""

from datetime import date

from . import config
from .content import fill, load_json
from .crm import get_settings, open_slots


def friendly_date(iso):
    d = date.fromisoformat(iso)
    return f"{d:%a} {d:%b} {d.day}"


def friendly_time(hhmm):
    if not hhmm:
        return ""
    h, m = (int(x) for x in hhmm.split(":"))
    suffix = "am" if h < 12 else "pm"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d}{suffix}" if m else f"{h12}{suffix}"


def open_times_text(conn, limit=5):
    slots = open_slots(conn, days_ahead=14)[:limit]
    if not slots:
        return "[NO OPEN SLOTS ENTERED - ADD REAL SLOTS ON THE BOOKING PAGE FIRST]"
    return "\n".join(f"- {friendly_date(s['slot_date'])}, drop-off {friendly_time(s['dropoff_time'])}" for s in slots)


def render(conn, template_id, lead=None, appointment=None):
    templates = {t["id"]: t for t in load_json("replies.json")}
    if template_id not in templates:
        raise KeyError(template_id)
    settings = get_settings(conn)
    values = dict(settings)
    values["open_times"] = open_times_text(conn)
    values["name"] = (lead["name"].split()[0] if lead and lead["name"] else "there")
    service = (appointment["service"] if appointment else None) or (lead["requested_service"] if lead else None)
    if service in config.SERVICES:
        values["service_label"] = config.SERVICES[service]["label"].lower()
    else:
        values["service_label"] = "cleaning"
    if appointment:
        values["appt_date"] = friendly_date(appointment["slot_date"])
        values["appt_time"] = friendly_time(appointment["dropoff_time"])
        values["appt_service"] = config.SERVICES[appointment["service"]]["label"]
        values["appt_price"] = f"${appointment['quoted_price']:g}"
    # Literal braces in values must not be re-expanded; fill() does a single pass.
    text = templates[template_id]["text"]
    return fill(_presub(text, values), settings)


def _presub(text, values):
    for key, value in values.items():
        if value and key not in config.SETTINGS_FIELDS:
            safe = str(value).replace("{", "(").replace("}", ")")
            text = text.replace("{" + key + "}", safe)
    return text


def all_templates():
    return load_json("replies.json")
