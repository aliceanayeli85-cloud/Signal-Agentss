"""Input validation. Every write to the database passes through these."""

import re
from datetime import date, datetime


class ValidationError(ValueError):
    pass


def text(value, field, max_len=500, required=False):
    value = (value or "").strip()
    if required and not value:
        raise ValidationError(f"{field} is required.")
    if len(value) > max_len:
        raise ValidationError(f"{field} is too long (max {max_len} characters).")
    # Strip control characters other than newline/tab.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)


def choice(value, field, options, default=None):
    value = (value or "").strip()
    if not value and default is not None:
        return default
    if value not in options:
        raise ValidationError(f"{field} must be one of: {', '.join(options)}.")
    return value


def iso_date(value, field, required=False):
    value = (value or "").strip()
    if not value:
        if required:
            raise ValidationError(f"{field} is required.")
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise ValidationError(f"{field} must be a date like 2026-10-21.") from None


def time_hhmm(value, field, required=False):
    value = (value or "").strip()
    if not value:
        if required:
            raise ValidationError(f"{field} is required.")
        return ""
    for fmt in ("%H:%M", "%I:%M%p", "%I:%M %p", "%I%p", "%I %p"):
        try:
            return datetime.strptime(value.upper(), fmt).strftime("%H:%M")
        except ValueError:
            continue
    raise ValidationError(f"{field} must be a time like 08:30 or 8:30 AM.")


def money(value, field, required=False):
    value = (str(value) if value is not None else "").strip().replace("$", "").replace(",", "")
    if not value:
        if required:
            raise ValidationError(f"{field} is required.")
        return None
    try:
        amount = round(float(value), 2)
    except ValueError:
        raise ValidationError(f"{field} must be a number like 80 or 80.00.") from None
    if amount < 0 or amount > 10000:
        raise ValidationError(f"{field} must be between 0 and 10,000.")
    return amount


def integer(value, field, lo=0, hi=100000, default=None):
    value = (str(value) if value is not None else "").strip()
    if not value:
        if default is not None:
            return default
        raise ValidationError(f"{field} is required.")
    try:
        number = int(value)
    except ValueError:
        raise ValidationError(f"{field} must be a whole number.") from None
    if not lo <= number <= hi:
        raise ValidationError(f"{field} must be between {lo} and {hi}.")
    return number


def flag(value):
    return 1 if str(value or "").lower() in ("1", "on", "yes", "true") else 0
