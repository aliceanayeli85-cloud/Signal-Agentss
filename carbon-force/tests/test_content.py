import re
import unittest

from helpers import DBTest

from cfd import config, content, crm, templates
from cfd.validate import ValidationError


class LibraryQualityTests(unittest.TestCase):
    """The library itself: 30 distinct, complete, honest posts."""

    @classmethod
    def setUpClass(cls):
        cls.posts = content.load_library()

    def test_thirty_distinct_posts(self):
        self.assertEqual(len(self.posts), 30)
        self.assertEqual(len({p["title"] for p in self.posts}), 30)
        self.assertEqual(sorted(p["day"] for p in self.posts), list(range(1, 31)))

    def test_required_fields(self):
        for p in self.posts:
            for f in ("purpose", "cta", "platform", "visual", "shots", "format", "pillar"):
                self.assertTrue(p.get(f), f"{p['id']} is missing {f}")
            self.assertTrue(p.get("facebook") or p.get("instagram") or p.get("story"), p["id"])

    def test_variety(self):
        pillars = {p["pillar"] for p in self.posts}
        self.assertGreaterEqual(len(pillars), 8)
        first_lines = [(p.get("facebook") or p.get("instagram") or p.get("story")).splitlines()[0].lower()[:30] for p in self.posts]
        self.assertEqual(len(first_lines), len(set(first_lines)), "repeated hooks")
        self.assertTrue(any(p.get("reel_script") for p in self.posts))
        self.assertTrue(any(p.get("group_version") for p in self.posts))
        self.assertTrue(any(p.get("story") for p in self.posts))
        self.assertTrue(any(p["season"] != "any" for p in self.posts))

    def test_no_unconfirmed_claims_or_hardcoded_prices(self):
        for p in self.posts:
            allowed = {t.strip() for t in p.get("allow_terms", "").split(",") if t.strip()}
            for f in content.POST_FIELDS:
                text = p.get(f, "")
                found = [c for c in content.banned_claims(content._negated_mobile_ok(text)) if c not in allowed]
                self.assertEqual(found, [], f"{p['id']}.{f}")
                self.assertIsNone(re.search(r"\$\d", text), f"{p['id']}.{f} hardcodes a price; use a placeholder")

    def test_light_on_hashtags_and_emoji(self):
        for p in self.posts:
            self.assertLessEqual(p.get("instagram", "").count("#"), 5, p["id"])
            self.assertIsNone(re.search("[\U0001F300-\U0001FAFF]", " ".join(p.get(f, "") for f in content.POST_FIELDS)), p["id"])

    def test_no_gendered_owner_words(self):
        for p in self.posts:
            text = " ".join(p.get(f, "") for f in content.POST_FIELDS).lower()
            self.assertIsNone(re.search(r"\b(guy|man|woman|gal|girl|dude)\b", text), p["id"])

    def test_templates_are_honest(self):
        for t in templates.all_templates():
            self.assertEqual(content.banned_claims(t["text"]), [], t["id"])
            self.assertIsNone(re.search(r"\$\d", t["text"]), t["id"])


class WorkflowTests(DBTest):
    def setUp(self):
        super().setUp()
        self.library()

    def test_cannot_approve_without_settings(self):
        with self.assertRaises(ValidationError) as cm:
            content.set_status(self.conn, "d02-price-menu", "approved")
        self.assertIn("Settings", str(cm.exception))

    def test_full_lifecycle(self):
        self.settings()
        pid = "d02-price-menu"
        with self.assertRaises(ValidationError):
            content.set_status(self.conn, pid, "published", {"published_where": "fb"})
        content.set_status(self.conn, pid, "approved")
        content.set_status(self.conn, pid, "scheduled", {"scheduled_date": crm.plus_days(1)})
        with self.assertRaises(ValidationError):
            content.set_status(self.conn, pid, "published", {"published_where": "fb", "published_date": crm.plus_days(1)})
        content.set_status(self.conn, pid, "published", {"published_where": "facebook page"})
        post = content.get_post(self.conn, pid)
        self.assertEqual((post["status"], post["published_date"]), ("published", crm.today()))
        with self.assertRaises(ValidationError):
            content.edit_post(self.conn, pid, {"facebook": "new"})

    def test_real_photo_posts_need_confirmation(self):
        self.settings()
        pid = "d04-under-the-seats"
        with self.assertRaises(ValidationError):
            content.set_status(self.conn, pid, "approved")
        content.set_status(self.conn, pid, "approved", {"photos_confirmed": "1"})

    def test_type_markers_block_approval(self):
        self.settings()
        with self.assertRaises(ValidationError) as cm:
            content.set_status(self.conn, "d06-before-after-1", "approved", {"photos_confirmed": "1"})
        self.assertIn("[TYPE", str(cm.exception))

    def test_banned_claim_blocks_and_negation_allowed(self):
        self.settings()
        pid = "d02-price-menu"
        content.edit_post(self.conn, pid, {"facebook": "Mobile detailing, we come to you!"})
        with self.assertRaises(ValidationError):
            content.set_status(self.conn, pid, "approved")
        content.edit_post(self.conn, pid, {"facebook": "I'm not mobile. Drop-off only. {booking_line}"})
        content.set_status(self.conn, pid, "approved")
        # "automobile" must not trip the mobile check
        self.assertEqual(content.banned_claims("great for any automobile"), [])

    def test_edit_after_approval_returns_to_draft_and_sync_keeps_edits(self):
        self.settings()
        pid = "d02-price-menu"
        content.set_status(self.conn, pid, "approved")
        self.assertEqual(content.edit_post(self.conn, pid, {"facebook": "My own words {booking_line}"}), "draft")
        content.sync_library(self.conn)
        self.assertEqual(content.get_post(self.conn, pid)["facebook"], "My own words {booking_line}")

    def test_fill_marks_missing_settings(self):
        self.assertIn("[SET BOOKING_LINE IN SETTINGS]", content.fill("{booking_line}", crm.get_settings(self.conn)))
        self.settings()
        self.assertEqual(content.fill("{price_full} {booking_line}", crm.get_settings(self.conn)), "$140 Text 000-000-0000 to book")


class TemplateTests(DBTest):
    def test_availability_never_invents_times(self):
        self.settings()
        self.assertIn("NO OPEN SLOTS", templates.render(self.conn, "availability"))
        crm.add_slot(self.conn, {"slot_date": crm.plus_days(2), "dropoff_time": "08:30"})
        text = templates.render(self.conn, "availability")
        self.assertIn("8:30am", text)
        self.assertNotIn("NO OPEN SLOTS", text)

    def test_lead_name_and_braces_are_safe(self):
        self.settings()
        lid = crm.create_lead(self.conn, {"name": "{private_address} Bob", "contact_method": "text", "source": "flyer"})
        text = templates.render(self.conn, "no_reply_1", crm.get_lead(self.conn, lid))
        self.assertIn("(private_address)", text)

    def test_prices_come_from_config(self):
        self.settings()
        text = templates.render(self.conn, "price")
        for s in config.SERVICES.values():
            self.assertIn(f"${s['price']}", text)


if __name__ == "__main__":
    unittest.main()
