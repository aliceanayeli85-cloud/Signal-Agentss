# Carbon Force Command Center (phone app): architecture, audit, upgrade log

## What it is
A single HTML page published as a private claude.ai Artifact. It runs in the browser.

- Source: `phone/template.html`. `phone/build.py` embeds `content/posts.json`, `replies.json` and `weekly_plan.json`, then writes `phone/command-center.html`, which is the file that gets published.
- No server and no build tools beyond Python. No external services except Google Fonts.

## Storage (actual behavior)
- Data lives in the Artifact's `db` capability (Claude-hosted document store), not on the phone.
- Access rule: `{ path: "", read: "owner", write: "owner" }`. Only the artifact owner can read or write, including Claude acting in the owner's account. Checked with a lower access level: an editor-level read returns nothing.
- Collections: `leads, slots, appts, jobs, posts, opps, effort, timings, briefs, expenses, experiments, daily, backups`.
- Config docs: `config/settings` (Setup), `config/business` (services, add-ons, costs, capacity, targets, policies, script edits, readiness), `config/meta` (last backup date), `config/activejob` (running Work timer).
- Writes happen only after a user action, never on load. `config/business` falls back to built-in defaults plus the old Setup text until the owner saves something.
- Limits: if the artifact is deleted, its data is deleted with it. There's no automatic off-site backup, so the app reminds the owner weekly to save a backup file.

## Pre-upgrade audit (v6, Oct 21 2026)
| # | Problem | Fix |
|---|---|---|
| 1 | Apple Cash missing from payment methods (owner accepts it) | Added; method labels everywhere |
| 2 | Day-plan math used ms/86,400,000, so it broke across daylight saving (wrong day, or "launch starts") | `dayDiff()` rounds whole days; used everywhere dates are compared |
| 3 | Spray wax treated as included in the exterior (Setup text, Work checklist, website) | Wax is an add-on: filtered out of included lists, separate Work step only when booked, removed from the website's exterior list |
| 4 | Channel "collected" ignored the selected period (all-time money in a weekly table) | Payments and refunds are filtered by date |
| 5 | Double taps could save a record twice | Global busy guard on every save |
| 6 | Backup could be saved but never restored; no last-backup date | Validated restore (merge by ID, never deletes, safety snapshot first), last-backup date, weekly reminder |
| 7 | Prices hardcoded in code | Editable in Services & prices; scripts, quotes and reports read them |
| 8 | No costs, discounts, refunds, fees or profit | Full job costing (see below) |
| 9 | Leads lacked outreach stages, follow-up count, next action, lost reason | Added; Lost requires a reason |
| 10 | No duplicate detection | Same phone (7+ digits) or same name and number gets a warning; owner must confirm it's a different person; never auto-merged |
| 11 | No capacity by hours; double-confirm of a slot possible in theory | Hours-per-day check plus a check that no second confirmed booking shares a slot |
| 12 | Templates weren't editable; review script didn't stress honest reviews | Every script is editable, with a claim check; review request asks for an honest review |

Duplicate functionality left as-is on purpose: the desktop Python app (`cfd/`) is an older, separate version. The phone app is the one in use. The desktop app doesn't have the new features.

## Money definitions (as implemented in `jobEcon`)
- **Revenue (earned)** = price − discount − refunds
- **Net paid** = payments (including deposit) − refunds. **Balance** = revenue − net paid (never below 0)
- **After job costs** (contribution) = revenue − supplies − other direct costs − payment fees
- **Estimated operating profit** = after job costs − (labor hours × owner hourly value) − overhead share (monthly overhead ÷ jobs that month)
- The app never shows a number as **actual profit** unless supplies are marked actual, labor hours are actual, every payment method's fee is known, owner hourly value is set, and monthly overhead is set (0 allowed). Otherwise it's labeled estimate or incomplete, and the missing inputs are listed.
- A deposit kept on a cancellation is recorded as its own small "kept deposit" job, so it counts as money earned.

## Tests (run Oct 21 2026)
`node` + Playwright against `command-center.html` with an in-memory copy of storage, seeded with a copy of the live data (Setup, 16 prospecting items, 1 brief). 70/70 checks passed, covering:
- the full lead → quote → booking → job → partial and final payment → refund journey
- the profit math, the weekly report and channel attribution
- marketing cost per customer
- duplicate and double-tap guards, and capacity limits
- conditional add-on steps in the Work checklist
- backup → restore into an empty store, with invalid, wrong-format and tampered files rejected
- reopen persistence, every screen at 390px with no sideways scroll, and no console errors

Desktop Python tests: 40/40.

## Restore points
- Git tag `pre-upgrade-2026-10-21` and copies in `phone/backups-pre-upgrade/`
- In-app snapshot `backups/pre-upgrade-2026-10-21` (Setup, prospecting items, brief), restorable from Setup → Saved snapshots
