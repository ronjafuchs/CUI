#!/usr/bin/env python3
"""Start the CSV Labeler locally.

Usage:  python run.py [--port 8765]

The server binds to 127.0.0.1 only. No data leaves your machine.
"""
import argparse
import webbrowser
import threading

from labelapp import create_app

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=8765)
parser.add_argument("--no-browser", action="store_true")
args = parser.parse_args()

app = create_app()

if not args.no_browser:
    threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")).start()

print(f"\n  CSV Labeler running at  http://127.0.0.1:{args.port}\n  Press Ctrl+C to stop.\n")
app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True)
