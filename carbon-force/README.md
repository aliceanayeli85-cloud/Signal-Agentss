# Carbon Force Detailing: Command Center

A free, private app on your own computer that runs the customer side of the business:
leads, replies, follow-ups, booking, completed jobs, real revenue, a 30-day post library,
local prospecting and a weekly report.

**What it never does on its own:** post anything, message anyone, spend money, or touch your
branding files. You copy and paste every post and message yourself, then tap a button to record it.

---

## Phone only? Use the phone version

**https://claude.ai/artifact/TSCEG1rUG1QeUScfPZaLNQ**: open it on your phone while signed in to Claude.
Add it to your home screen (Share → Add to Home Screen) so it works like an app.

- Same features: leads, reply templates, drop-off booking, jobs and payments, 30-day posts, prospecting,
  7-day plan and cash mode, weekly report.
- Data is saved in your private Claude storage. Only you, the owner, can read or change it, even if the link is shared.
- Backup: More → Setup → Save backup file.
- Source: `phone/template.html`. Rebuild with `python phone/build.py` after editing `content/*.json`.

The computer version below is optional.

---

## 1. Setup (one time, about 10 minutes)

You need **Python 3.9 or newer**. Nothing else gets installed. No accounts and no API keys.

| Computer | How to get Python |
| --- | --- |
| Windows | Install from python.org/downloads and **tick "Add Python to PATH"** on the first screen. |
| Mac | Open Terminal and type `python3 --version`. If it asks to install developer tools, say yes. Or install from python.org. |
| Chromebook / Linux | Usually already installed (`python3 --version`). |

Then:

1. Download this project folder (on GitHub: green **Code** button → **Download ZIP**, then unzip it).
2. Open a terminal **in the `carbon-force` folder**:
   - Windows: open the folder in File Explorer, click the address bar, type `cmd`, press Enter.
   - Mac: right-click the folder → **New Terminal at Folder**.
3. Start it:
   ```
   python run.py
   ```
   (On a Mac, use `python3 run.py`.)
4. Open **http://localhost:8765** in your browser and bookmark it.
5. Go to **Settings** and fill in your real details: booking line, phone, general area,
   drop-off hours, what each service includes, payment methods and turnaround.
   No post can be approved until these are filled in, so placeholder text never gets posted.
6. Optional: put your existing logo at `brand/logo.png` (see `brand/README.md`).

Keep the terminal window open while you use the app. Press **Ctrl+C** in it to stop.

### Try it with fake data first (recommended)
```
python run.py demo
```
Opens a **separate** demo copy at http://localhost:8766 with fake "TEST" customers. Your real data
isn't touched. Delete `data/demo/` whenever you like.

### Use it from your phone (same Wi-Fi)
```
set CFD_PIN=pick-a-6+-character-pin          (Windows)
export CFD_PIN=pick-a-6+-character-pin       (Mac/Linux)
python run.py --lan
```
On your phone, go to `http://<your computer's local IP>:8765` and enter the PIN.
Only do this on your home Wi-Fi, never on public Wi-Fi.

**Don't run this on Replit or any public host.** It holds customer phone numbers and is built
to run on your own computer.

---

## 2. Your daily loop (10-20 minutes)

1. Open **Today**. Do what it lists, top to bottom:
   - **New leads - no reply yet** → open each one, copy a reply, send it from your phone, then tap **I replied**.
   - **Follow-ups due** → copy the follow-up template, send it, tap **I sent a follow-up**.
   - **Reminders / review requests / repeat reminders** → same idea.
   - **Today's plan** → one content action, one customer action, one follow-up action, plus an optional extra.
2. When anyone messages you, **add them as a lead first** (Leads → Add). Pick the right "Where did they find you?".
   That one field is how you learn which marketing works.
3. Log marketing time on the **Plan** page (rough minutes are fine).

**Cash mode** (Plan page or Settings) swaps the daily plan for a list focused on getting paying
customers this week: reply fast, chase quotes, fill real open slots, ask past customers.

---

## 3. Booking: drop-off only, and only at times you've approved

1. **Booking → Add open slot** for each drop-off time you can **really** take a car.
2. On a lead, **Hold this slot for them**, then send them the time.
   (The "availability" reply template lists only your real open slots. If you have none, it says so.)
3. When they say yes → **Customer said yes - confirm**. Send the booking confirmation template.
4. The day before → send the reminder and tap **Reminder sent**.
5. After the job → **Job done - record it** (price charged, amount paid, payment method).
   Unpaid or partly paid jobs show as "still owed" until you record the payment.

The app blocks: times you didn't add, double-booking a slot, and more cars per day than your max (Settings).

**Revenue = money you've recorded as paid. Nothing else.** Quotes, bookings, likes and views are
counted separately and never added to revenue.

---

## 4. Reviewing and approving posts

Posts page → open a post. You'll see:
- purpose, call to action, suggested visual, shot list, platform
- ready-to-paste text with your Settings filled in (Facebook, Instagram, Story, Reel script, group version)
- step-by-step instructions for posting it

Status flow: **draft → approved → scheduled (optional planning date) → published**.
- **Approve** is blocked if: Settings are missing, the text has `[TYPE ...]` parts you haven't filled in
  with real details, or it contains a claim you haven't confirmed (mobile, ceramic, polishing, paint
  correction, extraction, "fully booked", "limited spots", "insured", "certified", "best in...").
- Posts marked **needs your real photos/video** need you to tick a box saying you have genuine footage.
- If you edit an approved post, it goes back to draft so you approve the new wording.
- **Mark published** only after you posted it yourself. Write where (e.g. "facebook page").

Skip seasonal posts that don't fit the week. Fall posts are good now (October-November), and the salt and
December posts are for winter.

---

## 5. Is it working? (weekly, 10 minutes)

**Weekly** page, every Sunday (or Day 7):
- posts published, inquiries by channel, replies, quotes, bookings, cancellations and no-shows
- jobs completed, revenue collected, money still owed
- average days to first reply
- effort per channel (minutes vs. inquiries, so you can see inquiries per hour)
- "What to change next week": simple rules applied to *your* recorded numbers

The question to ask every week: **which channel brought inquiries that turned into paid jobs, and how much
time did it take?** Do more of that and less of whatever took time and brought nothing.

Terminal version: `python run.py report` (add `--week 2026-10-19` for a past week).

---

## 6. Backups and privacy

- One automatic backup per day when the app starts → `data/backups/` (the last 30 are kept).
- **Settings → Back up now**, or `python run.py backup`.
- **Once a week, copy `data/backups/` to a USB stick or private cloud folder.**
- Restore: stop the app, then `python run.py restore data/backups/<file>.db` (your current data is saved first).
- Customer data lives only in `data/carbon_force.db` on your computer. It's excluded from git, so it
  never gets uploaded to GitHub. On Mac/Linux, the file is readable only by your user account.
- The CSV export contains customer info. Don't email it around.
- Never put passwords or account logins into the app.

---

## 7. Troubleshooting

| Problem | Fix |
| --- | --- |
| `python` is not recognized (Windows) | Reinstall Python and tick **Add Python to PATH**, or try `py run.py`. |
| `command not found: python` (Mac) | Use `python3 run.py`. |
| "Address already in use" | It's already running in another window, or use `python run.py --port 8790`. |
| Page says "That form expired" | The app was restarted. Reload the page and do it again. |
| Browser can't connect | The terminal window was closed. Run `python run.py` again. |
| "Can't approve yet: fill in Settings" | Fill the listed Settings fields. |
| "Can't approve yet: replace the [TYPE ...] parts" | Edit the wording and put in the real detail (e.g. what the car actually looked like). |
| "Contains a claim you haven't confirmed" | Remove the word. If you've *really* started offering it, update `cfd/config.py` (SERVICES / BANNED_CLAIMS) first. |
| Availability template says NO OPEN SLOTS | Add your real open times on the Booking page. |
| Phone can't open it in `--lan` mode | Same Wi-Fi? Firewall allowing Python? Use the computer's local IP, not `localhost`. |
| Something broke / red error | Your data is safe. Copy the error from the terminal window. Restore yesterday's backup if needed. |

Run the self-tests (they use throwaway test data, not yours): `python -m unittest discover -s tests`

---

## 8. Maintenance and changing things

| Change | Where |
| --- | --- |
| Prices or services | `cfd/config.py` → `SERVICES` (posts and templates pick it up automatically) |
| Claims to block | `cfd/config.py` → `BANNED_CLAIMS` |
| Post wording | In the app (Posts → Edit), or `content/posts.json` for unedited drafts |
| Reply templates | `content/replies.json` |
| 7-day plan / cash mode steps | `content/weekly_plan.json` |
| Starter prospecting list | `content/prospects_seed.json` (only loaded once, on first run) |

After editing a `.json` file, restart the app. If it won't start, the JSON probably has a missing
comma or quote. Undo your last edit.

---

## 9. Free vs. costs money

| Thing | Cost |
| --- | --- |
| This app, Python, backups | Free |
| Facebook Page, Instagram account, Nextdoor business page, Google Business Profile, Bing Places, Apple Business Connect, Yelp page | Free to create |
| Boosted posts / ads on any platform | **Costs money. Not used. The app never does this.** |
| Melrose Park Chamber membership | Has dues. Decide before joining. |
| A permanent sign (if you go for a Google profile that shows your address) | Costs money. Check Village rules first. |
| Village business license (if required) | Unknown. Call Village Hall: 708-343-4000. |
| Printing more flyers | Small cost, optional. |

---

## 10. Files

```
carbon-force/
  run.py                    start here
  cfd/                      the app (Python standard library only)
    config.py               prices, services, blocked claims, settings fields
    db.py                   database + backups
    crm.py                  leads, follow-ups, slots, appointments, jobs, payments
    content.py              post library, approval rules, claim checks
    templates.py            reply templates filled with real data
    prospecting.py          local opportunities
    reports.py              dashboard numbers + weekly report
    server.py / pages.py / web.py   the browser interface
    demo.py                 fake TEST data (demo mode only)
  content/
    posts.json              30-day post library
    replies.json            reply / follow-up message library
    weekly_plan.json        7-day routine + cash mode
    prospects_seed.json     starter prospecting list
    shot-list.md            what to film and photograph (no face)
  playbooks/
    first-week-launch.md    START HERE after setup
    brand-voice.md          how Carbon Force sounds
    daily-weekly-workflow.md
    local-prospecting.md    groups, Google, partners, referrals - with rules
    instagram-setup.md
  brand/                    your existing logo and flyers (never modified)
  data/                     YOUR DATA (private, not in git)
  tests/                    automated tests
```
