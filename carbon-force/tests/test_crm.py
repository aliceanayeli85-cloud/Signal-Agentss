import unittest

from helpers import DBTest

from cfd import crm, db, reports
from cfd.validate import ValidationError


class LeadTests(DBTest):
    def test_new_lead_is_unanswered_and_due_today(self):
        lid = self.lead()
        lead = crm.get_lead(self.conn, lid)
        self.assertEqual(lead["status"], "New Lead")
        self.assertEqual(lead["next_followup_date"], crm.today())
        self.assertEqual(len(reports.dashboard(self.conn)["unanswered"]), 1)

    def test_validation(self):
        with self.assertRaises(ValidationError):
            self.lead(name="")
        with self.assertRaises(ValidationError):
            self.lead(source="bought_list")
        with self.assertRaises(ValidationError):
            self.lead(inquiry_date=crm.plus_days(3))
        with self.assertRaises(ValidationError):
            self.lead(quoted_price="abc")

    def test_quote_sets_price_and_followup(self):
        lid = self.lead()
        crm.send_quote(self.conn, lid, "full")
        lead = crm.get_lead(self.conn, lid)
        self.assertEqual((lead["status"], lead["quoted_price"]), ("Quote Sent", 140))
        self.assertEqual(lead["next_followup_date"], crm.plus_days(2))

    def test_followup_due_flip(self):
        lid = self.lead()
        crm.mark_replied(self.conn, lid)
        self.conn.execute("UPDATE leads SET next_followup_date=? WHERE id=?", (crm.plus_days(-1), lid))
        crm.refresh_followup_statuses(self.conn)
        self.assertEqual(crm.get_lead(self.conn, lid)["status"], "Follow-Up Due")
        self.assertEqual(len(reports.dashboard(self.conn)["followups"]), 1)


class BookingTests(DBTest):
    def setUp(self):
        super().setUp()
        self.settings()

    def test_cannot_open_slot_in_past(self):
        with self.assertRaises(ValidationError):
            crm.add_slot(self.conn, {"slot_date": crm.plus_days(-1), "dropoff_time": "09:00"})

    def test_duplicate_slot_rejected(self):
        self.slot()
        with self.assertRaises(ValidationError):
            self.slot()

    def test_only_open_slots_can_be_offered(self):
        lid = self.lead()
        s = self.slot()
        crm.propose_appointment(self.conn, lid, s, "interior")
        with self.assertRaises(ValidationError):
            crm.propose_appointment(self.conn, self.lead(name="Other"), s, "interior")
        with self.assertRaises(ValidationError):
            crm.propose_appointment(self.conn, lid, 9999, "interior")

    def test_daily_max_enforced(self):
        crm.save_settings(self.conn, {"max_jobs_per_day": "1"})
        crm.propose_appointment(self.conn, self.lead(), self.slot(time="08:00"), "interior")
        with self.assertRaises(ValidationError):
            crm.propose_appointment(self.conn, self.lead(name="B"), self.slot(time="13:00"), "interior")

    def test_confirm_then_cancel_reopens_slot(self):
        lid = self.lead()
        s = self.slot()
        a = crm.propose_appointment(self.conn, lid, s, "full")
        self.assertEqual(crm.get_lead(self.conn, lid)["status"], "New Lead")  # holding is not booking
        crm.confirm_appointment(self.conn, a)
        self.assertEqual(crm.get_lead(self.conn, lid)["status"], "Booked")
        crm.cancel_appointment(self.conn, a, reason="sick")
        slot = self.conn.execute("SELECT status FROM slots WHERE id=?", (s,)).fetchone()
        self.assertEqual(slot["status"], "open")
        self.assertEqual(crm.get_lead(self.conn, lid)["status"], "Follow-Up Due")

    def test_complete_requires_confirmed(self):
        a = crm.propose_appointment(self.conn, self.lead(), self.slot(), "interior")
        with self.assertRaises(ValidationError):
            crm.complete_job(self.conn, a, {"amount_paid": "80", "payment_method": "cash"})


class RevenueTests(DBTest):
    def setUp(self):
        super().setUp()
        self.settings()

    def booked(self, service="interior"):
        lid = self.lead()
        a = crm.propose_appointment(self.conn, lid, self.slot(days=len(self.conn.execute("SELECT id FROM slots").fetchall()) + 1), service)
        crm.confirm_appointment(self.conn, a)
        return lid, a

    def test_revenue_counts_only_payments(self):
        self.booked()  # booked but not done: $0
        self.assertEqual(reports.revenue(self.conn), 0)
        _, a = self.booked("full")
        crm.complete_job(self.conn, a, {"amount_paid": "0"})
        self.assertEqual(reports.revenue(self.conn), 0)
        self.assertEqual(reports.outstanding(self.conn), 140)
        job = self.conn.execute("SELECT id FROM jobs").fetchone()["id"]
        crm.record_payment(self.conn, job, "100", "cash")
        self.assertEqual(reports.revenue(self.conn), 100)
        crm.record_payment(self.conn, job, "40", "zelle")
        self.assertEqual(reports.revenue(self.conn), 140)
        self.assertEqual(reports.outstanding(self.conn), 0)
        with self.assertRaises(ValidationError):
            crm.record_payment(self.conn, job, "1", "cash")

    def test_paid_needs_method_and_no_overpay(self):
        _, a = self.booked()
        with self.assertRaises(ValidationError):
            crm.complete_job(self.conn, a, {"amount_paid": "80"})
        with self.assertRaises(ValidationError):
            crm.complete_job(self.conn, a, {"amount_paid": "90", "payment_method": "cash"})

    def test_completed_paid_job_triggers_review_and_repeat(self):
        lid, a = self.booked()
        crm.complete_job(self.conn, a, {"amount_paid": "80", "payment_method": "cash", "completed_date": crm.plus_days(-1)})
        d = reports.dashboard(self.conn)
        self.assertEqual([r["id"] for r in d["review_due"]], [lid])
        lead = crm.get_lead(self.conn, lid)
        self.assertEqual(lead["status"], "Completed")
        self.assertEqual(lead["repeat_followup_date"], crm.plus_days(34))
        crm.mark_review_requested(self.conn, lid)
        self.assertEqual(reports.dashboard(self.conn)["review_due"], [])

    def test_weekly_report(self):
        r = reports.weekly_report(self.conn)
        self.assertIn("Nothing was recorded", r["next_week"][0])
        lid, a = self.booked()
        crm.send_quote(self.conn, lid, "interior")
        crm.complete_job(self.conn, a, {"amount_paid": "80", "payment_method": "cash"})
        crm.log_effort(self.conn, {"channel": "facebook_page", "activity": "posted", "minutes": "30"})
        r = reports.weekly_report(self.conn)
        self.assertEqual((r["inquiries"], r["quotes_sent"], r["booked"], r["jobs_completed"], r["revenue"]), (1, 1, 1, 1, 80))
        self.assertIn("Revenue collected: $80.00", reports.weekly_report_text(r))
        fb = [e for e in r["effort"] if e["channel"] == "facebook_page"][0]
        self.assertEqual(fb["inquiries_per_hour"], 2.0)


class BackupTests(DBTest):
    def test_backup_and_restore(self):
        self.lead(name="Keep Me")
        path = db.backup(self.conn, label="manual")
        self.conn.execute("DELETE FROM lead_events")
        self.conn.execute("DELETE FROM leads")
        self.conn.commit()
        self.conn.close()
        db.restore(path)
        self.conn = db.connect()
        self.assertEqual(self.conn.execute("SELECT name FROM leads").fetchone()["name"], "Keep Me")

    def test_auto_backup_once_per_day(self):
        self.assertIsNotNone(db.daily_backup_if_needed(self.conn))
        self.assertIsNone(db.daily_backup_if_needed(self.conn))


if __name__ == "__main__":
    unittest.main()
