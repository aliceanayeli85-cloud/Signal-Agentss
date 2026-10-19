"""Build the phone version (command-center.html) from template.html + the shared content files.

    python phone/build.py

The post library, reply templates and 7-day plan live in content/*.json, so the
desktop app and the phone page always use the same wording.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONTENT = HERE.parent / "content"


def embed(name):
    data = json.loads((CONTENT / name).read_text(encoding="utf-8"))
    # "</" inside a <script> block would end it early.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


html = (HERE / "template.html").read_text(encoding="utf-8")
for marker, name in [("__POSTS__", "posts.json"), ("__REPLIES__", "replies.json"), ("__PLAN__", "weekly_plan.json")]:
    assert marker in html, marker
    html = html.replace(marker, embed(name))
(HERE / "command-center.html").write_text(html, encoding="utf-8")
print("wrote", HERE / "command-center.html", len(html), "bytes")
