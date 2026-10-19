"""Post library: loading, placeholder filling, claim checks and status workflow.

The system never publishes anything. 'published' only records that YOU posted it.
"""

import json
import re
from pathlib import Path

from . import config
from . import validate as v
from .crm import get_settings, today

CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"
POST_FIELDS = ["facebook", "instagram", "story", "reel_script", "group_version"]
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def load_library(path=None):
    path = Path(path) if path else CONTENT_DIR / "posts.json"
    with open(path, encoding="utf-8") as fh:
        posts = json.load(fh)
    ids = set()
    for p in posts:
        if p["id"] in ids:
            raise ValueError(f"Duplicate post id {p['id']}")
        ids.add(p["id"])
    return posts


def sync_library(conn, path=None):
    """Insert library posts that aren't in the database yet.

    Posts you've edited or moved past 'draft' are never overwritten. Unedited drafts
    pick up wording fixes from posts.json.
    """
    added = updated = 0
    for p in load_library(path):
        row = conn.execute("SELECT status, edited FROM posts WHERE id=?", (p["id"],)).fetchone()
        values = (
            p["day"], p["title"], p["pillar"], p["purpose"], p["platform"], p["format"],
            p.get("season", "any"), 1 if p.get("needs_real_photos") else 0,
            p.get("facebook", ""), p.get("instagram", ""), p.get("story", ""),
            p.get("reel_script", ""), p.get("group_version", ""), p.get("visual", ""),
            p.get("shots", ""), p.get("cta", ""), p.get("allow_terms", ""),
        )
        if row is None:
            conn.execute(
                """INSERT INTO posts(day, title, pillar, purpose, platform, format, season, needs_real_photos,
                       facebook, instagram, story, reel_script, group_version, visual, shots, cta, allow_terms, id)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                values + (p["id"],),
            )
            added += 1
        elif row["status"] == "draft" and not row["edited"]:
            conn.execute(
                """UPDATE posts SET day=?, title=?, pillar=?, purpose=?, platform=?, format=?, season=?,
                       needs_real_photos=?, facebook=?, instagram=?, story=?, reel_script=?, group_version=?,
                       visual=?, shots=?, cta=?, allow_terms=? WHERE id=?""",
                values + (p["id"],),
            )
            updated += 1
    conn.commit()
    return added, updated


def placeholder_values(settings):
    values = dict(settings)
    values.update({
        "business": config.BUSINESS_NAME,
        "price_interior": f"${config.SERVICES['interior']['price']}",
        "price_exterior": f"${config.SERVICES['exterior']['price']}",
        "price_full": f"${config.SERVICES['full']['price']}",
    })
    return values


def fill(text, settings):
    """Swap {placeholders} for your settings. Unset ones become a loud marker."""
    values = placeholder_values(settings)

    def swap(m):
        value = values.get(m.group(1))
        return value if value else f"[SET {m.group(1).upper()} IN SETTINGS]"

    return PLACEHOLDER.sub(swap, text or "")


def banned_claims(text):
    found = []
    lowered = (text or "").lower()
    for phrase in config.BANNED_CLAIMS:
        pattern = r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])"
        if re.search(pattern, lowered):
            found.append(phrase)
    return found


def _negated_mobile_ok(text):
    # "We're not mobile" / "no mobile service" is honest and allowed.
    cleaned = re.sub(r"(not|no|isn't|aren't|don't do|can't do)\s+(a\s+)?mobile", "", (text or "").lower())
    return cleaned


def _allowed(post):
    raw = post["allow_terms"] if "allow_terms" in post.keys() else ""
    return {t.strip().lower() for t in (raw or "").split(",") if t.strip()}


def post_problems(post, settings):
    """Everything that blocks approval. Empty list = OK to approve."""
    problems = []
    for field in POST_FIELDS:
        raw = post[field] if field in post.keys() else ""
        if not raw:
            continue
        filled = fill(raw, settings)
        if "[SET " in filled:
            missing = sorted(set(re.findall(r"\[SET (\w+) IN SETTINGS\]", filled)))
            problems.append(f"{field}: fill in Settings first ({', '.join(m.lower() for m in missing)})")
        if "[TYPE" in filled:
            problems.append(f"{field}: replace the [TYPE ...] parts with real details")
        claims = [c for c in banned_claims(_negated_mobile_ok(filled)) if c not in _allowed(post)]
        if claims:
            problems.append(f"{field}: contains a claim you haven't confirmed ({', '.join(claims)})")
    return problems


def get_post(conn, post_id):
    row = conn.execute("SELECT * FROM posts WHERE id=?", (post_id,)).fetchone()
    if not row:
        raise v.ValidationError("That post doesn't exist.")
    return row


def edit_post(conn, post_id, form):
    post = get_post(conn, post_id)
    if post["status"] == "published":
        raise v.ValidationError("This post is already published. Edit it on the platform instead.")
    updates = {f: v.text(form.get(f, post[f]), f, 4000) for f in POST_FIELDS}
    updates["owner_notes"] = v.text(form.get("owner_notes", post["owner_notes"]), "Notes", 1000)
    # Editing an approved post sends it back to draft so the new wording gets approved.
    changed = any(updates[f] != post[f] for f in POST_FIELDS)
    status = "draft" if changed and post["status"] != "draft" else post["status"]
    conn.execute(
        f"""UPDATE posts SET {', '.join(f'{f}=?' for f in updates)}, edited=?, status=?,
               approved_date=CASE WHEN ?='draft' THEN NULL ELSE approved_date END WHERE id=?""",
        list(updates.values()) + [1 if changed else post["edited"], status, status, post_id],
    )
    conn.commit()
    return status


def set_status(conn, post_id, new_status, form=None):
    form = form or {}
    post = get_post(conn, post_id)
    new_status = v.choice(new_status, "Status", config.POST_STATUSES)
    current = post["status"]
    if new_status == current:
        return
    if new_status == "approved":
        if post["needs_real_photos"] and not v.flag(form.get("photos_confirmed")):
            raise v.ValidationError("This post needs your real photos/video. Tick the box confirming you have them.")
        problems = post_problems(post, get_settings(conn))
        if problems:
            raise v.ValidationError("Can't approve yet: " + "; ".join(problems))
        conn.execute("UPDATE posts SET status='approved', approved_date=? WHERE id=?", (today(), post_id))
    elif new_status == "scheduled":
        if current not in ("approved", "scheduled"):
            raise v.ValidationError("Approve the post before scheduling it.")
        when = v.iso_date(form.get("scheduled_date"), "Scheduled date", required=True)
        conn.execute("UPDATE posts SET status='scheduled', scheduled_date=? WHERE id=?", (when, post_id))
    elif new_status == "published":
        if current not in ("approved", "scheduled"):
            raise v.ValidationError("Only approved or scheduled posts can be marked published.")
        where = v.text(form.get("published_where"), "Where you posted it", 200, required=True)
        when = v.iso_date(form.get("published_date"), "Date posted") or today()
        if when > today():
            raise v.ValidationError("Published date can't be in the future - use Scheduled for that.")
        conn.execute("UPDATE posts SET status='published', published_date=?, published_where=? WHERE id=?",
                     (when, where, post_id))
    elif new_status == "draft":
        if current == "published":
            raise v.ValidationError("A published post can't go back to draft.")
        conn.execute("UPDATE posts SET status='draft', approved_date=NULL, scheduled_date=NULL WHERE id=?", (post_id,))
    conn.commit()


def list_posts(conn, status=None):
    if status:
        return conn.execute("SELECT * FROM posts WHERE status=? ORDER BY day, id", (status,)).fetchall()
    return conn.execute("SELECT * FROM posts ORDER BY day, id").fetchall()


def todays_posts(conn, limit=2):
    """Scheduled-for-today first, then approved posts waiting, then the next drafts."""
    t = today()
    due = conn.execute("SELECT * FROM posts WHERE status='scheduled' AND scheduled_date<=? ORDER BY scheduled_date", (t,)).fetchall()
    if len(due) >= limit:
        return due
    approved = conn.execute("SELECT * FROM posts WHERE status='approved' ORDER BY day LIMIT ?", (limit - len(due),)).fetchall()
    picked = list(due) + list(approved)
    if len(picked) < limit:
        picked += conn.execute("SELECT * FROM posts WHERE status='draft' ORDER BY day LIMIT ?", (limit - len(picked),)).fetchall()
    return picked


def load_json(name):
    with open(CONTENT_DIR / name, encoding="utf-8") as fh:
        return json.load(fh)
