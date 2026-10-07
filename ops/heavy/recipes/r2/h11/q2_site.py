#!/usr/bin/env python3
"""Q2's guest-local site on 127.0.0.1:8765: serves site/, and gives the harness its own read-back of every form,
independent of Caret's readers. Each page (site/guard.js) posts its fields' values to /state on every change and
long-polls /next for a command: focus a field, reload, or go to another page. The harness reads /state and queues
commands with /cmd. Pressing a submit button is recorded in the state as `pressed`; nothing leaves the guest.

  q2_site.py <site-dir> [port]
"""
import json
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
lock = threading.Condition()
states = {}      # page -> last posted state
commands = {}    # page -> [command]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _page(self):
        return parse_qs(urlparse(self.path).query).get("page", [""])[0]

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/state":
            with lock:
                return self._json(states.get(self._page()) or {})
        if path == "/next":
            page, end = self._page(), time.time() + 8
            with lock:
                while not commands.get(page) and time.time() < end:
                    lock.wait(end - time.time())
                cmd = commands[page].pop(0) if commands.get(page) else None
            return self._json(cmd or {})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        page = self._page()
        with lock:
            if path == "/state":
                data["receivedAt"] = time.time()
                states[page] = data
            elif path == "/cmd":
                commands.setdefault(page, []).append(data)
            elif path == "/clear":
                states.pop(page, None)
            lock.notify_all()
        return self._json({"ok": True})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
