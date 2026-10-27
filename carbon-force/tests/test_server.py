import http.client
import re
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.parse import urlencode

from helpers import GOOD_SETTINGS, DBTest

from cfd import server


class ServerTests(DBTest):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.app = server.App()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.csrf = self.httpd.app.csrf

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def req(self, method, path, form=None, host="127.0.0.1"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        body = urlencode(form) if form is not None else None
        headers = {"Host": host}
        if body is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        data = r.read().decode()
        c.close()
        return r.status, r.getheader("Location") or "", data

    def post(self, path, form):
        return self.req("POST", path, dict(form, csrf=self.csrf))

    def test_pages_load(self):
        for path in ["/", "/leads", "/leads/new", "/booking", "/content", "/content/d01-open-for-business",
                     "/replies", "/prospecting", "/plan", "/report", "/report.txt", "/settings", "/static/style.css"]:
            status, _, _ = self.req("GET", path)
            self.assertEqual(status, 200, path)
        self.assertEqual(self.req("GET", "/nope")[0], 404)
        self.assertEqual(self.req("GET", "/leads/999")[0], 404)

    def test_bad_host_rejected(self):
        self.assertEqual(self.req("GET", "/", host="evil.example")[0], 400)

    def test_post_without_csrf_rejected(self):
        status, loc, _ = self.req("POST", "/leads", {"name": "X", "contact_method": "text", "source": "flyer"})
        self.assertEqual(status, 303)
        self.assertIn("err=", loc)
        self.assertNotIn("X", self.req("GET", "/leads")[2].split("<table>")[1].split("</table>")[0].replace("<th>", ""))

    def test_end_to_end_booking_and_escaping(self):
        self.post("/settings", GOOD_SETTINGS)
        status, loc, _ = self.post("/leads", {"name": "<script>alert(1)</script>", "contact_method": "text",
                                              "source": "facebook_group", "requested_service": "full"})
        self.assertEqual(status, 303)
        lead_path = loc.split("?")[0]
        page = self.req("GET", lead_path)[2]
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;", page)
        lid = lead_path.rsplit("/", 1)[1]

        self.post(f"/leads/{lid}/quote", {"service": "full"})
        from cfd import crm
        self.post("/slots", {"slot_date": crm.plus_days(1), "dropoff_time": "08:30"})
        slot_id = re.search(r'<option value="(\d+)">', self.req("GET", lead_path)[2]).group(1)
        self.post(f"/leads/{lid}/offer", {"slot_id": slot_id, "service": "full"})
        appt = re.search(r"/appointments/(\d+)/confirm", self.req("GET", lead_path)[2]).group(1)
        self.post(f"/appointments/{appt}/confirm", {})
        status, loc, _ = self.post(f"/appointments/{appt}/complete",
                                   {"service": "full", "price_charged": "140", "amount_paid": "140", "payment_method": "cash"})
        self.assertIn("msg=", loc)
        self.assertIn("$140.00", self.req("GET", "/")[2])
        self.assertIn("Revenue collected: $140.00", self.req("GET", "/report.txt")[2])

    def test_validation_error_is_shown_not_crash(self):
        status, loc, _ = self.post("/slots", {"slot_date": "2000-01-01", "dropoff_time": "08:30"})
        self.assertEqual(status, 303)
        self.assertIn("err=", loc)

    def test_csv_neutralises_formulas(self):
        self.post("/leads", {"name": "=HYPERLINK(\"x\")", "contact_method": "text", "source": "flyer"})
        csv_text = self.req("GET", "/export/leads.csv")[2]
        self.assertIn("'=HYPERLINK", csv_text)


class LanModeTests(DBTest):
    def test_lan_requires_pin(self):
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.app = server.App(lan=True, pin="123456")
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/")
            r = c.getresponse()
            r.read()
            self.assertEqual((r.status, r.getheader("Location")), (303, "/login"))
            c.request("POST", "/login", body="pin=wrong", headers={"Content-Type": "application/x-www-form-urlencoded"})
            r = c.getresponse()
            r.read()
            self.assertIsNone(r.getheader("Set-Cookie"))
            c.request("POST", "/login", body="pin=123456", headers={"Content-Type": "application/x-www-form-urlencoded"})
            r = c.getresponse()
            r.read()
            cookie = r.getheader("Set-Cookie").split(";")[0]
            c.request("GET", "/", headers={"Cookie": cookie})
            r = c.getresponse()
            r.read()
            self.assertEqual(r.status, 200)
            c.close()
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
