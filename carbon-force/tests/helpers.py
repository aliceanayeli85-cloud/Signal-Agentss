import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["CFD_QUIET"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cfd import content, crm, db  # noqa: E402

GOOD_SETTINGS = {
    "booking_line": "Text 000-000-0000 to book",
    "phone": "000-000-0000",
    "area_line": "Melrose Park",
    "hours_line": "Drop-off 8-10am",
    "payment_methods": "cash",
    "interior_includes": "vacuum and wipe-down",
    "exterior_includes": "hand wash",
    "turnaround_line": "Ready same day",
    "max_jobs_per_day": "2",
}


class DBTest(unittest.TestCase):
    """Each test gets its own throwaway database in a temp folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["CFD_DATA_DIR"] = self.tmp.name
        self.conn = db.connect()

    def tearDown(self):
        self.conn.close()
        os.environ.pop("CFD_DATA_DIR", None)
        self.tmp.cleanup()

    def settings(self, **over):
        crm.save_settings(self.conn, dict(GOOD_SETTINGS, **over))

    def lead(self, **over):
        form = {"name": "Test Person", "contact_method": "text", "contact_value": "000", "source": "facebook_page",
                "requested_service": "interior"}
        form.update(over)
        return crm.create_lead(self.conn, form)

    def slot(self, days=1, time="08:30"):
        return crm.add_slot(self.conn, {"slot_date": crm.plus_days(days), "dropoff_time": time})

    def library(self):
        content.sync_library(self.conn)
