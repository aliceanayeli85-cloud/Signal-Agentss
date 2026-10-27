"""Local web server (standard library only).

Security model:
- Binds to 127.0.0.1 by default, so only this computer can open it.
- --lan mode (phone on the same Wi-Fi) requires a PIN from the CFD_PIN environment variable.
- Every form has a CSRF token; Host header is checked; responses are no-store and
  carry a strict Content-Security-Policy.
- Logs never include form contents or query strings.
"""

import csv
import hashlib
import hmac
import io
import os
import re
import secrets
import sys
import time
import traceback
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from . import content, crm, db, pages, prospecting, reports
from .validate import ValidationError
from .web import CSS, JS, LOGO_TYPES, esc, find_logo, page

MAX_BODY = 64 * 1024


class App:
    def __init__(self, lan=False, pin=None, db_file=None):
        self.lan = lan
        self.pin = pin
        self.db_file = db_file
        self.csrf = secrets.token_urlsafe(32)
        self.session_key = secrets.token_bytes(32)
        self.failed_logins = []
        conn = self.conn()
        try:
            content.sync_library(conn)
            prospecting.seed(conn)
            db.daily_backup_if_needed(conn)
        finally:
            conn.close()

    def conn(self):
        return db.connect(self.db_file)

    def session_token(self):
        return hmac.new(self.session_key, b"ok", hashlib.sha256).hexdigest()


def _route(path):
    parts = [p for p in path.split("/") if p]
    return parts


class Handler(BaseHTTPRequestHandler):
    server_version = "CarbonForce/1.0"
    sys_version = ""

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        # Path only, no query string, no bodies: keeps customer details out of logs.
        if os.environ.get("CFD_QUIET"):
            return
        sys.stderr.write(f"{self.log_date_time_string()} {self.command} {urlparse(self.path).path}\n")

    # ------------------------------------------------------------ plumbing

    def _headers(self, status, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                         "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def send(self, body, status=200, ctype="text/html; charset=utf-8", extra=None):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self._headers(status, ctype, dict(extra or {}, **{"Content-Length": str(len(data))}))
        self.wfile.write(data)

    def redirect(self, location, msg="", err=""):
        if msg or err:
            sep = "&" if "?" in location else "?"
            location += sep + ("msg=" + quote(msg) if msg else "err=" + quote(err))
        self._headers(303, "text/plain", {"Location": location, "Content-Length": "0"})

    def host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]")
        if self.app.lan:
            return True  # PIN protects LAN mode
        return host in ("127.0.0.1", "localhost", "::1")

    def logged_in(self):
        if not self.app.lan:
            return True
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        token = jar.get("cfd_session")
        return bool(token) and hmac.compare_digest(token.value, self.app.session_token())

    def read_form(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValidationError("That form was too big.")
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        parsed = parse_qs(raw, keep_blank_values=True)
        return {k: v[-1] for k, v in parsed.items()}

    def render(self, title_body, active, query):
        title, body = title_body
        self.send(page(title, body, active, query.get("msg", [""])[0], query.get("err", [""])[0]))

    # ------------------------------------------------------------ GET

    def do_GET(self):
        if not self.host_ok():
            return self.send("Bad host", 400, "text/plain")
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = _route(url.path)

        if parts[:1] == ["static"]:
            if parts == ["static", "style.css"]:
                return self.send(CSS, ctype="text/css; charset=utf-8")
            if parts == ["static", "app.js"]:
                return self.send(JS, ctype="application/javascript; charset=utf-8")
            return self.send("Not found", 404, "text/plain")
        if parts == ["login"]:
            return self.send(self.login_page(query.get("err", [""])[0]))
        if not self.logged_in():
            return self.redirect("/login")
        if parts == ["brand", "logo"]:
            logo = find_logo()
            if not logo:
                return self.send("No logo", 404, "text/plain")
            return self.send(logo.read_bytes(), ctype=LOGO_TYPES[logo.suffix.lower()])

        conn = self.app.conn()
        try:
            crm.refresh_followup_statuses(conn)
            csrf = self.app.csrf
            if not parts:
                return self.render(pages.dashboard(conn, csrf), "/", query)
            if parts == ["leads"]:
                return self.render(pages.leads_list(conn, query.get("status", [None])[0]), "/leads", query)
            if parts == ["leads", "new"]:
                return self.render(pages.new_lead(conn, csrf), "/leads", query)
            if len(parts) == 2 and parts[0] == "leads" and parts[1].isdigit():
                return self.render(pages.lead_detail(conn, csrf, int(parts[1])), "/leads", query)
            if parts == ["booking"]:
                return self.render(pages.booking(conn, csrf), "/booking", query)
            if parts == ["content"]:
                return self.render(pages.content_list(conn, query.get("status", [None])[0]), "/content", query)
            if len(parts) == 2 and parts[0] == "content":
                return self.render(pages.content_detail(conn, csrf, parts[1]), "/content", query)
            if parts == ["replies"]:
                return self.render(pages.replies_page(conn), "/replies", query)
            if parts == ["prospecting"]:
                return self.render(pages.prospecting_page(conn, csrf), "/prospecting", query)
            if parts == ["plan"]:
                return self.render(pages.plan_page(conn, csrf), "/plan", query)
            if parts == ["report"]:
                return self.render(pages.report_page(conn, query.get("week", [None])[0]), "/report", query)
            if parts == ["report.txt"]:
                r = reports.weekly_report(conn, query.get("week", [None])[0])
                return self.send(reports.weekly_report_text(r), ctype="text/plain; charset=utf-8")
            if parts == ["settings"]:
                return self.render(pages.settings_page(conn, csrf), "/settings", query)
            if parts == ["export", "leads.csv"]:
                return self.send(export_leads_csv(conn), ctype="text/csv; charset=utf-8",
                                 extra={"Content-Disposition": "attachment; filename=carbon-force-leads.csv"})
            return self.send(page("Not found", "<p>That page doesn't exist. <a href='/'>Go to Today</a></p>"), 404)
        except ValidationError as e:
            return self.send(page("Hmm", f"<p>{esc(e)}</p><p><a href='/'>Back to Today</a></p>"), 404)
        except ValueError:
            return self.send(page("Hmm", "<p>That date or link looks wrong.</p><p><a href='/'>Back to Today</a></p>"), 400)
        except Exception:
            traceback.print_exc()
            return self.send(page("Something broke", "<p>Something went wrong. Your data is safe; see the terminal "
                                  "window for details, and the Troubleshooting section of README.md.</p>"), 500)
        finally:
            conn.close()

    # ------------------------------------------------------------ POST

    def do_POST(self):
        if not self.host_ok():
            return self.send("Bad host", 400, "text/plain")
        url = urlparse(self.path)
        parts = _route(url.path)
        try:
            form = self.read_form()
        except ValidationError as e:
            return self.send(str(e), 413, "text/plain")

        if parts == ["login"]:
            return self.handle_login(form)
        if not self.logged_in():
            return self.redirect("/login")
        if not hmac.compare_digest(form.get("csrf", ""), self.app.csrf):
            return self.redirect("/", err="That form expired (the app was restarted). Please try again.")

        conn = self.app.conn()
        back = "/"
        try:
            back, msg = self.dispatch(conn, parts, form)
            return self.redirect(back, msg=msg)
        except ValidationError as e:
            conn.rollback()
            return self.redirect(self.back_for(parts), err=str(e))
        except Exception:
            conn.rollback()
            traceback.print_exc()
            return self.redirect(self.back_for(parts), err="Something went wrong saving that. Nothing was changed.")
        finally:
            conn.close()

    @staticmethod
    def back_for(parts):
        if parts[:1] == ["leads"] and len(parts) >= 2 and parts[1].isdigit():
            return f"/leads/{parts[1]}"
        if parts[:1] == ["leads"]:
            return "/leads/new"
        if parts[:1] == ["content"] and len(parts) >= 2 and re.fullmatch(r"[\w-]+", parts[1]):
            return f"/content/{parts[1]}"
        if parts[:1] in (["slots"], ["jobs"], ["appointments"]):
            return "/booking"
        if parts[:1] == ["prospecting"]:
            return "/prospecting"
        if parts[:1] == ["effort"]:
            return "/plan"
        if parts[:1] == ["settings"] or parts == ["backup"]:
            return "/settings"
        return "/"

    def dispatch(self, conn, parts, form):
        if parts == ["leads"]:
            lead_id = crm.create_lead(conn, form)
            return f"/leads/{lead_id}", "Lead added. Reply to them now - fast replies win jobs."
        if len(parts) == 3 and parts[0] == "leads" and parts[1].isdigit():
            lid, action = int(parts[1]), parts[2]
            target = f"/leads/{lid}"
            if action == "update":
                crm.update_lead(conn, lid, form)
                return target, "Saved."
            if action == "reply":
                crm.mark_replied(conn, lid, int(form.get("days") or 2))
                return target, "Logged your reply. Follow-up set for 2 days from now."
            if action == "quote":
                crm.send_quote(conn, lid, form.get("service"), form.get("price"))
                return target, "Quote logged. Follow-up set for 2 days from now."
            if action == "followup":
                days = int(form.get("days") or 0)
                crm.log_followup(conn, lid, days)
                return target, ("Follow-up logged." if days else "Final follow-up logged. If they don't answer, mark them Lost.")
            if action == "offer":
                crm.propose_appointment(conn, lid, int(form.get("slot_id") or 0), form.get("service"), form.get("price"))
                return target, "Slot held. Send them the time; confirm when they say yes."
            if action == "review_requested":
                crm.mark_review_requested(conn, lid)
                return target, "Review request logged."
            if action == "review_received":
                crm.mark_review_received(conn, lid)
                return target, "Nice. Review logged."
            if action == "repeat_sent":
                crm.mark_repeat_offer_sent(conn, lid)
                return target, "Repeat offer logged. Next reminder in 60 days."
        if parts == ["slots"]:
            crm.add_slot(conn, form)
            return "/booking", "Slot added."
        if len(parts) == 3 and parts[0] == "slots" and parts[2] == "close" and parts[1].isdigit():
            crm.close_slot(conn, int(parts[1]))
            return "/booking", "Slot closed."
        if len(parts) == 3 and parts[0] == "appointments" and parts[1].isdigit():
            aid, action = int(parts[1]), parts[2]
            lead_id = conn.execute("SELECT lead_id FROM appointments WHERE id=?", (aid,)).fetchone()
            target = f"/leads/{lead_id[0]}" if lead_id else "/booking"
            if action == "confirm":
                crm.confirm_appointment(conn, aid)
                return target, "Confirmed. Send the booking confirmation message."
            if action == "reminder":
                crm.mark_reminder_sent(conn, aid)
                return target, "Reminder logged."
            if action == "cancel":
                crm.cancel_appointment(conn, aid, reason=form.get("reason", ""))
                return target, "Cancelled. The slot is open again if it's in the future."
            if action == "noshow":
                crm.cancel_appointment(conn, aid, no_show=True)
                return target, "No-show logged."
            if action == "complete":
                crm.complete_job(conn, aid, form)
                return target, "Job recorded. Send the review request tomorrow."
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "payment" and parts[1].isdigit():
            crm.record_payment(conn, int(parts[1]), form.get("amount"), form.get("method"))
            return "/booking", "Payment recorded."
        if len(parts) == 3 and parts[0] == "content":
            pid, action = parts[1], parts[2]
            if action == "status":
                content.set_status(conn, pid, form.get("status"), form)
                return f"/content/{quote(pid)}", f"Post is now {form.get('status')}."
            if action == "edit":
                status = content.edit_post(conn, pid, form)
                return f"/content/{quote(pid)}", f"Wording saved (status: {status})."
        if parts == ["prospecting"]:
            prospecting.add(conn, form)
            return "/prospecting", "Opportunity added."
        if len(parts) == 2 and parts[0] == "prospecting" and parts[1].isdigit():
            prospecting.update(conn, int(parts[1]), form)
            return f"/prospecting#o{parts[1]}", "Updated."
        if parts == ["effort"]:
            crm.log_effort(conn, form)
            return "/plan", "Logged."
        if parts == ["settings"]:
            crm.save_settings(conn, form)
            return "/settings", "Settings saved."
        if parts == ["settings", "cash_mode"]:
            crm.save_settings(conn, {"cash_mode": form.get("cash_mode", "no")})
            return "/", "Cash mode " + ("on." if form.get("cash_mode") == "yes" else "off.")
        if parts == ["backup"]:
            path = db.backup(conn, label="manual")
            return "/settings", f"Backup saved: {path.name}"
        raise ValidationError("Unknown action.")

    # ------------------------------------------------------------ login (LAN mode)

    def login_page(self, err=""):
        body = (f'<div class="card"><form method="post" action="/login">'
                f'<label>PIN<input type="password" name="pin" autocomplete="current-password" required></label>'
                f'<button type="submit">Open</button></form></div>')
        return page("Enter PIN", body, err=err, logged_in=False)

    def handle_login(self, form):
        now = time.time()
        self.app.failed_logins = [t for t in self.app.failed_logins if now - t < 300]
        if len(self.app.failed_logins) >= 5:
            return self.redirect("/login", err="Too many tries. Wait 5 minutes.")
        if self.app.pin and hmac.compare_digest(form.get("pin", ""), self.app.pin):
            jar = f"cfd_session={self.app.session_token()}; HttpOnly; SameSite=Strict; Path=/"
            self._headers(303, "text/plain", {"Location": "/", "Set-Cookie": jar, "Content-Length": "0"})
            return None
        self.app.failed_logins.append(now)
        return self.redirect("/login", err="Wrong PIN.")


def export_leads_csv(conn):
    out = io.StringIO()
    rows = conn.execute("SELECT * FROM leads ORDER BY id").fetchall()
    writer = csv.writer(out)
    if rows:
        writer.writerow(rows[0].keys())
        for r in rows:
            # Neutralise spreadsheet formulas in user-entered text.
            writer.writerow([("'" + str(x)) if isinstance(x, str) and x[:1] in "=+-@" else x for x in r])
    return out.getvalue()


def serve(host="127.0.0.1", port=8765, lan=False, db_file=None):
    pin = os.environ.get("CFD_PIN", "")
    if lan:
        if len(pin) < 6:
            raise SystemExit("LAN mode needs a PIN of at least 6 characters in the CFD_PIN environment variable. See README.")
        host = "0.0.0.0"
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.app = App(lan=lan, pin=pin, db_file=db_file)
    shown = "localhost" if host == "127.0.0.1" else host
    print(f"Carbon Force command center running: http://{shown}:{port}")
    print("Leave this window open while you use it. Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
