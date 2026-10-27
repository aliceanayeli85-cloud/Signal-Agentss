"""HTML helpers, page layout, CSS and JS. Every dynamic value goes through esc()."""

import html
from pathlib import Path

from . import config

BRAND_DIR = Path(__file__).resolve().parent.parent / "brand"
LOGO_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp"}


def esc(value):
    return html.escape("" if value is None else str(value), quote=True)


def find_logo():
    for ext in LOGO_TYPES:
        p = BRAND_DIR / f"logo{ext}"
        if p.exists():
            return p
    return None


def money(x):
    return f"${x:,.2f}" if x is not None else "-"


def pct(x):
    return f"{x}%" if x is not None else "-"


def options(values, selected=None, labels=None):
    out = []
    for val in values:
        label = (labels or {}).get(val, val.replace("_", " ") if val else "-")
        sel = " selected" if str(val) == str(selected or "") else ""
        out.append(f'<option value="{esc(val)}"{sel}>{esc(label)}</option>')
    return "".join(out)


SERVICE_LABELS = {k: f"{s['label']} (${s['price']})" for k, s in config.SERVICES.items()}
SERVICE_LABELS["unsure"] = "Not sure yet"


def form(action, body, csrf, button="Save", cls="", confirm=None):
    extra = f' data-confirm="{esc(confirm)}"' if confirm else ""
    return (f'<form method="post" action="{esc(action)}" class="{esc(cls)}"{extra}>'
            f'<input type="hidden" name="csrf" value="{esc(csrf)}">{body}'
            f'<button type="submit">{esc(button)}</button></form>')


def field(label, name, value="", kind="text", required=False, hint="", attrs=""):
    req = " required" if required else ""
    hint_html = f'<small>{esc(hint)}</small>' if hint else ""
    if kind == "textarea":
        control = f'<textarea name="{esc(name)}" rows="6"{req} {attrs}>{esc(value)}</textarea>'
    else:
        control = f'<input type="{esc(kind)}" name="{esc(name)}" value="{esc(value)}"{req} {attrs}>'
    return f'<label>{esc(label)}{control}{hint_html}</label>'


def select(label, name, values, selected=None, labels=None, hint=""):
    hint_html = f'<small>{esc(hint)}</small>' if hint else ""
    return f'<label>{esc(label)}<select name="{esc(name)}">{options(values, selected, labels)}</select>{hint_html}</label>'


def copy_block(text, label="Copy"):
    return (f'<div class="copy"><pre>{esc(text)}</pre>'
            f'<button type="button" class="copybtn">{esc(label)}</button></div>')


def badge(text, kind=""):
    cls = str(text).lower().replace(" ", "-").replace("_", "-")
    return f'<span class="badge {esc(cls)} {esc(kind)}">{esc(text)}</span>'


NAV = [
    ("/", "Today"),
    ("/leads", "Leads"),
    ("/booking", "Booking"),
    ("/content", "Posts"),
    ("/replies", "Replies"),
    ("/prospecting", "Prospecting"),
    ("/plan", "Plan"),
    ("/report", "Weekly"),
    ("/settings", "Settings"),
]


def page(title, body, active="/", msg="", err="", logged_in=True):
    logo = find_logo()
    brand = (f'<img src="/brand/logo" alt="{esc(config.BUSINESS_NAME)}" class="logo">' if logo
             else f'<span class="brandname">{esc(config.BUSINESS_NAME)}</span>')
    nav = "".join(
        f'<a href="{href}" class="{"on" if href == active else ""}">{esc(label)}</a>' for href, label in NAV
    ) if logged_in else ""
    flash = ""
    if msg:
        flash += f'<div class="flash ok">{esc(msg)}</div>'
    if err:
        flash += f'<div class="flash err">{esc(err)}</div>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)} - {esc(config.BUSINESS_NAME)}</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<header><a href="/" class="home">{brand}</a><nav>{nav}</nav></header>
<main>{flash}<h1>{esc(title)}</h1>{body}</main>
<footer>Local only. Nothing here posts or sends messages for you. Back up from Settings.</footer>
<script src="/static/app.js"></script>
</body></html>"""


CSS = """
:root{--bg:#f6f6f4;--card:#fff;--ink:#1d1d1f;--muted:#666;--line:#ddd;--accent:#1f2a37;--ok:#1e7d3a;--warn:#a15c00;--bad:#b42318;}
@media (prefers-color-scheme: dark){:root{--bg:#121417;--card:#1c1f24;--ink:#ececec;--muted:#a0a0a0;--line:#333;--accent:#d7dde4;--ok:#5cc27a;--warn:#f0a43a;--bad:#ff7b72;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;position:sticky;top:0;z-index:2}
.home{text-decoration:none;color:var(--ink);font-weight:700}.logo{height:36px}
nav{display:flex;flex-wrap:wrap;gap:4px}
nav a{padding:6px 10px;border-radius:6px;text-decoration:none;color:var(--ink);font-size:15px}
nav a.on{background:var(--accent);color:var(--bg)}
main{max-width:1050px;margin:0 auto;padding:16px}
h1{font-size:24px;margin:8px 0 16px}h2{font-size:19px;margin:0 0 10px}h3{font-size:16px;margin:12px 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px;min-width:0}
.big{font-size:28px;font-weight:700}.muted,small{color:var(--muted)}
small{display:block;font-size:13px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.tablewrap{overflow-x:auto}
label{display:block;margin:8px 0;font-weight:600;font-size:14px}
input,select,textarea{display:block;width:100%;margin-top:3px;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;font-weight:400}
input[type=checkbox]{display:inline;width:auto;margin-right:6px}
button{background:var(--accent);color:var(--bg);border:0;border-radius:6px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
form.inline{display:inline-block;margin:0 6px 6px 0}form.inline button{margin-top:0;padding:6px 10px;font-size:14px}
.row{display:flex;flex-wrap:wrap;gap:0 12px}.row>label{flex:1 1 200px}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:12px}
.flash.ok{background:color-mix(in srgb,var(--ok) 18%,transparent)}.flash.err{background:color-mix(in srgb,var(--bad) 20%,transparent)}
.warn{border-left:4px solid var(--warn)}.danger{border-left:4px solid var(--bad)}.good{border-left:4px solid var(--ok)}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line);white-space:nowrap}
.badge.new-lead,.badge.follow-up-due,.badge.draft{border-color:var(--warn);color:var(--warn)}
.badge.booked,.badge.approved,.badge.confirmed{border-color:var(--ok);color:var(--ok)}
.badge.lost,.badge.cancelled,.badge.no-show{color:var(--muted)}
.badge.published,.badge.completed,.badge.paid{background:var(--ok);color:var(--bg);border-color:var(--ok)}
.copy{position:relative;margin:6px 0 12px}
pre{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:15px;margin:0}
.copy pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:38px 10px 10px}
.copybtn{position:absolute;top:6px;right:6px;margin:0;padding:4px 10px;font-size:13px}
ul.tight{margin:4px 0;padding-left:20px}ul.tight li{margin:3px 0}
.todo li{margin:6px 0}
footer{text-align:center;color:var(--muted);font-size:13px;padding:24px 16px}
a{color:inherit}
details summary{cursor:pointer;font-weight:600;margin:6px 0}
"""

JS = """
document.addEventListener('click', function (e) {
  if (!e.target.classList.contains('copybtn')) return;
  var text = e.target.parentNode.querySelector('pre').innerText;
  var done = function () { e.target.textContent = 'Copied'; setTimeout(function () { e.target.textContent = 'Copy'; }, 1500); };
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done); return; }
  var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
  try { document.execCommand('copy'); done(); } catch (err) {} document.body.removeChild(t);
});
document.addEventListener('submit', function (e) {
  var msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});
"""
