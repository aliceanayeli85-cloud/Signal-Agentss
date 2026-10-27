"""Carbon Force Detailing command center.

    python run.py                 start the app at http://localhost:8765
    python run.py --lan           also allow your phone on the same Wi-Fi (needs CFD_PIN)
    python run.py backup          make a backup now
    python run.py restore FILE    restore a backup (the current data is saved first)
    python run.py report          print this week's report
    python run.py demo            start a separate DEMO copy filled with fake test data
"""

import argparse
import os
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    sys.exit("Python 3.9 or newer is needed. See README.md -> Setup.")

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main():
    parser = argparse.ArgumentParser(description="Carbon Force Detailing command center")
    parser.add_argument("command", nargs="?", default="serve", choices=["serve", "backup", "restore", "report", "demo"])
    parser.add_argument("file", nargs="?", help="backup file for 'restore'")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true", help="allow devices on your Wi-Fi (requires CFD_PIN)")
    parser.add_argument("--week", help="any date in the week for 'report' (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.command == "demo":
        os.environ["CFD_DATA_DIR"] = str(Path(__file__).resolve().parent / "data" / "demo")
    from cfd import db, demo, reports, server

    if args.command == "serve":
        server.serve(port=args.port, lan=args.lan)
    elif args.command == "demo":
        conn = db.connect()
        demo.load(conn)
        conn.close()
        print("DEMO MODE - fake test data only, stored separately in data/demo/. Your real data is untouched.")
        server.serve(port=args.port + 1, lan=False)
    elif args.command == "backup":
        conn = db.connect()
        print("Saved", db.backup(conn, label="manual"))
        conn.close()
    elif args.command == "restore":
        if not args.file:
            sys.exit("Usage: python run.py restore data/backups/<file>.db")
        print("Restored to", db.restore(args.file))
    elif args.command == "report":
        conn = db.connect()
        print(reports.weekly_report_text(reports.weekly_report(conn, args.week)))
        conn.close()


if __name__ == "__main__":
    main()
