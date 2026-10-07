#!/usr/bin/env python3
"""H14 driver, rig VM only: the page task panel's attach rows on F1's wizard page 3 (brief H14, acceptance 3).

One configuration, as H13's: the acceptance Caret.app as the launchd agent (the role that vends the page bridge to Caret
for Chrome), started with --test-hooks and an empty --ghost-replay file so the ghost model never loads in the guest's
4 GB. Live Jev uses only the verified RAM-disk env file; no Groq key is sent. Chrome for Testing shows
/tasks/wizard-3.html from the commit's fixtures/web-form/public, served read-only by http.server on 127.0.0.1:8790 with
its request log in site.log.

How the page goal is started. (A), tried first, is the real path: a real click on the page's heading, then the desk's
Ask over the debug socket (`ask type fill out this form`, `ask submit`), waiting up to 25 s for pageTask.status.stage
"preview". (B), when A gives no preview with an attach row, is the canned path: `pagetask start <goalProgress>` with a
segment built from the live page (window id from the helper's consumer stream, Chrome for Testing's pid). Every row
records which path it took. Rows 3 to 5 are canned only: each needs a preview whose steps the driver chose.

Rows (each with screenshots by window number of Chrome for Testing and of Caret's windows: the page task panel, the open
panel, the save line, the memory window):
  1. attach-input: the preview's attach rows show; real ⌘2 opens the open panel (pageTask.choosing set); the fixture
     résumé is picked by keys only (⌘⇧G, the path, Return, Return); the browser is front again and the row reads
     "<name>, edited today"; real Tab. Real path: #resume.files[0].name over CDP. Canned path: the helper refuses the
     unknown goal; the host's debug state keeps the acceptance Tab sent (pageTask.lastAccept*), so confirmedFile's step
     and file name are read from it.
  2. attach-dropzone: the page reloaded, a fresh preview, real ⌘3, the same pick, Tab. Real: #resume_drop.files[0].name.
  3. tab-never-confirms: a canned preview whose first row offers a saved file; a real Tab without ⌘2 must confirm no
     file. PageTask.tab (CaretHostCore/PageTask.swift) holds Tab on a preview that only attaches and has no file, so
     the expected outcome is "held, nothing sent".
  4. click-opens: a real click on the first attach row opens the open panel; Esc closes it, nothing is sent, the
     browser is front again.
  5. save-line: a fileSaveOffer helperLine injected for a goal the panel just ended; fileSave.phase "offered" with its
     panel; real Esc; phase "none".
  6. switches: the memory window's Sites tab; `memory switch web off` and `rich on` show in `settings`; both put back.
  7. zero-submits: no POST to /tasks/submit in site.log for the whole run.

Safety: every key and click is real HID input (h14-key), which BUILD-ORDER allows only in the rig VM. Tab, ⌘2 and ⌘3
are pressed only while the preview owns Tab in the browser (pageTask.status.ownsTab) and the browser is in front, so a
key the panel does not take never moves the page's focus toward its Submit button. Return and the path are typed only
while an open panel is up and Caret owns the front. A click on the panel is refused unless the point is inside the
panel's frame and the page under it holds no control. Results: out/result.json and out/scoreboard.md.

usage: h14.py <out-dir>        env: RIG_JOB, RIG_PAYLOAD, H14_BUDGET (seconds this script may use)
"""
import hashlib
import html
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdp as cdplib  # noqa: E402

P = os.environ["RIG_PAYLOAD"]
O = sys.argv[1]
T = f"{P}/tools"
ACC = f"{P}/acc/Caret.app"
CARET = f"{ACC}/Contents/MacOS/Caret"
CFT_APP = f"{P}/apps/Google Chrome for Testing.app"
CFT = f"{CFT_APP}/Contents/MacOS/Google Chrome for Testing"
CFT_BUNDLE = "com.google.chrome.for.testing"
CFT_NAME = "Google Chrome for Testing"
EXT = f"{ACC}/Contents/Resources/Caret for Chrome"
EXT_ID = "idbkbnaepbamcdecogahbinlcodkbmmj"
SITE_PORT = 8790
SITE = f"http://127.0.0.1:{SITE_PORT}"
PAGE_URL = f"{SITE}/tasks/wizard-3.html"
PAGE_TITLE = "Apply: Field Robotics Technician (step 3 of 3)"
CDP_PORT = 9333
HOME = "/tmp/h14home"
PROFILE = "/tmp/h14-cft"
REPLAY = f"{P}/ghost/replay.json"
UID = os.getuid()
T0 = time.time()
BUDGET_S = int(os.environ.get("H14_BUDGET", "1400"))
ENV_FILE = os.environ.get("H14_ENV_FILE", "")  # LV1: the RAM-disk env file job.sh wrote; empty runs without Jev

# The fixture files, made in the guest. Synthetic: Ines Vandermeer is F1's invented applicant (tasks/expect/wizard-3.json).
FIX = "/tmp/caret-fixture"
RESUME_NAME = "ines-vandermeer-resume-2026.pdf"
RESUME = f"{FIX}/{RESUME_NAME}"
NOTES_TXT = f"{FIX}/notes.txt"
PDF_BYTES = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
             b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n")
SAVED_ID = "file-1a2b3c4d"
EDITED_TODAY = f"{RESUME_NAME}, edited today"

ASK_TEXT = "fill out this form"
REAL_WAIT_S = 25          # brief: up to 25 s for the real path's preview
PANEL_WAIT_S = 6          # an open panel or a redraw after a key; not measured, generous for a 4 GB guest
# The attach row's centre below the panel's top, in points, when Accessibility gives no frame for its button: the
# first attach row is the third text line (title, "from …", row), 63 pt down in the reference render
# apps/caret/Tests/CaretHostTests/References/page-task-attach-only-light.png (2x: row centre at 176 px, panel top at
# 50 px). x is on the row's file text, 58% across.
ROW1_DY = 63.0
ROW_X_FRAC = 0.58

ROWS = []
UNDO_ROWS = []  # LV1: (id, observed, files cleared) per real-path attach
CHECKS = []
NOTES = []
SHOTS = []
os.makedirs(f"{O}/shots", exist_ok=True)
LOG = open(f"{O}/h14.log", "a", buffering=1)


def say(*a):
    line = f"{time.strftime('%H:%M:%S')} +{int(time.time() - T0)}s " + " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


def run(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"


def jrun(cmd, timeout=30):
    rc, out, err = run(cmd, timeout)
    try:
        return json.loads(out.strip().splitlines()[-1]) if out.strip() else {"error": err.strip() or f"rc {rc}"}
    except (ValueError, IndexError):
        return {"error": (out + err).strip()[:300]}


def ax(*a, timeout=20):
    return jrun([f"{T}/q2-ax", *[str(x) for x in a]], timeout)


def wait(fn, timeout, every=0.2):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() >= end:
            return v
        time.sleep(every)


def left():
    return BUDGET_S - (time.time() - T0)


def dig(d, path, default=None):
    for k in path.split("."):
        if not isinstance(d, dict):
            return default
        d = d.get(k)
    return default if d is None else d


def now_ms():
    return int(time.time() * 1000)


def sub(d, *keys):
    """Some keys of one reply (each socket command is sent once, then picked from)."""
    return {k: d.get(k) for k in keys} if isinstance(d, dict) else {"error": repr(d)}


def check(cid, ok, observed):
    """A setup check: not a row, but the run passes only when these pass too."""
    CHECKS.append({"id": cid, "pass": bool(ok), "observed": observed})
    say("CHECK", "PASS" if ok else "FAIL", cid, json.dumps(observed, default=str)[:400])


def row(rid, path, ok, observed):
    """One of the brief's rows. `path`: "real" or "canned" for a row on a page goal, "n/a" for rows 6 and 7."""
    ROWS.append({"id": rid, "path": path, "pass": bool(ok), "observed": observed})
    say("ROW", "PASS" if ok else "FAIL", rid, path, json.dumps(observed, default=str)[:600])


# ------------------------------------------------------------------------------------------------- Caret's sockets
class Caret:
    """The host's debug socket: one command per connection, JSON back."""

    def __init__(self, home):
        self.home = home
        self.sock = f"{home}/sockets/host.sock"
        self.screen = f"{home}/sockets/screen.sock"
        self.pid = None

    def q(self, command):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(5)
                s.connect(self.sock)
                s.sendall((command + "\n").encode())
                s.shutdown(socket.SHUT_WR)
                data = b""
                while chunk := s.recv(65536):
                    data += chunk
            return json.loads(data or b"{}")
        except (OSError, ValueError) as e:
            return {"error": str(e)}

    def state(self):
        return self.q("state")

    def pt(self):
        """The page task panel as `pagetask` reads it (it publishes first, so the panel's frame and text are fresh)."""
        return self.q("pagetask")

    def start(self, goal):
        return self.q("pagetask start " + json.dumps(goal, separators=(",", ":")))


class Consumer:
    """A plain consumer on the helper's socket (H13's). Without the pageText capability it is sent each pageField
    without its text: the field's key, window, title and app, which the canned goal copies. It is not a goal host, so
    it never sees goalProgress, and the helper echoes no host's goalAccept to anyone (server.ts answers a refusal on the
    sending connection only). Every message goes to helper-messages.ndjson."""

    def __init__(self, path):
        self.msgs = []
        self.lock = threading.Lock()
        self.out = open(f"{O}/helper-messages.ndjson", "a", buffering=1)
        threading.Thread(target=self._run, args=(path,), daemon=True).start()

    def _run(self, path):
        for _ in range(100):
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(path)
                break
            except OSError:
                time.sleep(0.5)
        else:
            say(f"consumer: could not connect to {path}")
            return
        s.sendall(json.dumps({"type": "hello", "v": 1, "role": "consumer", "mode": "live", "pid": os.getpid(), "version": "h14"}).encode() + b"\n")
        buf = b""
        while True:
            try:
                chunk = s.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    m = json.loads(line)
                except ValueError:
                    continue
                with self.lock:
                    self.msgs.append((time.time(), m))
                self.out.write(json.dumps({"t": time.time(), "message": m}) + "\n")

    def since(self, t, mtype=None):
        with self.lock:
            return [m for (ts, m) in self.msgs if ts >= t and (mtype is None or m.get("type") == mtype)]

    def field(self, t, title):
        xs = [m for m in self.since(t, "pageField") if m.get("title") == title and m.get("windowId")]
        return xs[-1] if xs else None


# ------------------------------------------------------------------------------------------------- real input
class Keys:
    """h14-key serve: one HID key, move or click per line, acknowledged once posted."""

    def __init__(self):
        self.p = subprocess.Popen([f"{T}/h14-key", "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=open(f"{O}/h14-key.err", "a"), text=True, bufsize=1)

    def _cmd(self, line):
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()
        r = self.p.stdout.readline().strip()
        if r != "ok":
            raise RuntimeError(f"h14-key {line!r}: {r or 'no reply'}")

    def char(self, c):
        self._cmd(f"c {ord(c)}")

    def key(self, name, mods=""):
        self._cmd(f"k {name} {mods}".strip())

    def move(self, x, y):
        self._cmd(f"v {x:.1f} {y:.1f}")

    def click(self, x, y):
        self._cmd(f"m {x:.1f} {y:.1f}")

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            self.p.kill()


# ------------------------------------------------------------------------------------------------- the page
READ_JS = r"""(() => {
  const q = (s) => document.querySelector(s);
  const r = q("#resume"), d = q("#resume_drop"), a = document.activeElement;
  return { title: document.title, url: location.href,
           resume: r && r.files.length ? r.files[0].name : null, resumeCount: r ? r.files.length : null,
           resumeShown: (q("#resume-name") || {}).textContent || "",
           drop: d && d.files.length ? d.files[0].name : null, dropCount: d ? d.files.length : null,
           dropShown: (q(".dropzone .filename") || {}).textContent || "",
           coverLength: ((q("#cover_letter") || {}).value || "").length, consent: !!(q("#consent") || {}).checked,
           active: a ? (a.id || a.tagName) : null, hasFocus: document.hasFocus(), visibility: document.visibilityState };
})()"""

RECT_JS = r"""((sel) => {
  const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
  return { rect: [r.left, r.top, r.width, r.height], screenX: window.screenX, screenY: window.screenY,
           outerWidth: window.outerWidth, outerHeight: window.outerHeight, innerWidth: window.innerWidth,
           innerHeight: window.innerHeight, dpr: window.devicePixelRatio };
})(%s)"""

METRICS_JS = r"""({ screenX: window.screenX, screenY: window.screenY, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
   innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio })"""

# What a click at page point (x, y) would land on, were it to reach the page: refused when it is a control.
AT_JS = r"""((x, y) => {
  const e = document.elementFromPoint(x, y); if (!e) return { tag: null, control: false };
  const c = e.closest("button, input, select, textarea, label, a[href], [role=button], .dropzone, form .actions");
  return { tag: e.tagName, id: e.id || null, control: c !== null, controlTag: c ? c.tagName : null };
})(%s, %s)"""


class Page:
    def __init__(self, url_part):
        t = wait(lambda: self._target(url_part), 30, 0.5)
        if not t:
            raise RuntimeError(f"no Chrome for Testing page target with {url_part}")
        self.c = cdplib.CDP(t["webSocketDebuggerUrl"])

    @staticmethod
    def _target(url_part):
        try:
            return cdplib.page_target(CDP_PORT, url_part)
        except OSError:
            return None

    def read(self):
        try:
            return self.c.eval(READ_JS) or {}
        except (cdplib.CDPError, OSError, ValueError) as e:
            return {"error": str(e)}

    @staticmethod
    def _top(m):
        """The viewport's top in screen points (H13's measure: the viewport at the bottom of the window, the guest's 2x
        display, devicePixelRatio / 2 the zoom)."""
        z = (m.get("dpr") or 2) / 2.0
        return z, m["screenY"] + m["outerHeight"] - m["innerHeight"] * z

    def screen_rect(self, sel):
        m = self.c.eval(RECT_JS % json.dumps(sel))
        if not m:
            return None, m
        z, top = self._top(m)
        r = m["rect"]
        return [m["screenX"] + r[0] * z, top + r[1] * z, r[2] * z, r[3] * z], m

    def at_screen(self, sx, sy):
        """What lies under screen point (sx, sy) in the page, or {"outside": True} when it is not over the viewport."""
        m = self.c.eval(METRICS_JS)
        z, top = self._top(m)
        x, y = (sx - m["screenX"]) / z, (sy - top) / z
        if x < 0 or y < 0 or x > m["innerWidth"] or y > m["innerHeight"]:
            return {"outside": True, "pagePoint": [x, y]}
        hit = self.c.eval(AT_JS % (json.dumps(x), json.dumps(y))) or {}
        hit["pagePoint"] = [x, y]
        return hit

    def reload(self):
        self.c.call("Page.reload", {"ignoreCache": True})
        time.sleep(0.5)
        return wait(lambda: self.read().get("title") == PAGE_TITLE, 15, 0.3)


# ------------------------------------------------------------------------------------------------- apps and windows
class Apps:
    cft = None
    site = None


def front_pid():
    return ax("front").get("pid")


def browser_front():
    if front_pid() != Apps.cft:
        ax("activate", Apps.cft)
        time.sleep(0.4)
    return front_pid() == Apps.cft


def caret_pid():
    rc, out, _ = run(["pgrep", "-f", "acc/Caret.app/Contents/MacOS/Caret"])
    pids = [int(x) for x in out.split()] if rc == 0 else []
    return pids[0] if pids else None


def winlist():
    _, out, _ = run([f"{T}/winlist"])
    rows = []
    for ln in out.splitlines():
        p = ln.split("\t")
        if p[0] != "WIN" or len(p) < 6:
            continue
        try:
            w, h = (float(x) for x in p[5].split("x"))
            rows.append({"number": int(p[1]), "pid": int(p[2]), "owner": p[3], "layer": int(p[4]), "w": w, "h": h})
        except ValueError:
            continue
    return rows


def panel_service(w):
    """An open panel drawn by AppKit's out-of-process service rather than in Caret. Caret is not sandboxed
    (Bundle/caret.entitlements), so its NSOpenPanel is expected in-process; this covers the other case."""
    return "Open and Save" in w["owner"]


def roles(c):
    """Window number to role, for the windows the host names in its debug state."""
    st = c.state()
    out = {}
    for path, name in (("pageTask.panel.windowNumber", "pagetask"), ("fileSave.panel.windowNumber", "saveline")):
        n = dig(st, path)
        if n:
            out[int(n)] = name
    return out


def shot(tag, c, extra=None):
    """Each on-screen window of Chrome for Testing, of Caret and of an open-panel service, captured by window number
    (screencapture -l). Caret's are named by role where the debug state or the caller says which window it is."""
    names = roles(c) if c.pid else {}
    names.update(extra or {})
    got = []
    for w in winlist():
        if w["w"] < 4 or w["h"] < 4:
            continue
        if w["pid"] == Apps.cft:
            who = "cft"
        elif w["pid"] == c.pid or panel_service(w):
            who = "caret-" + names.get(w["number"], "window")
        else:
            continue
        rel = f"shots/{tag}-{who}-{w['number']}.png"
        run(["screencapture", "-x", "-o", "-l", str(w["number"]), f"{O}/{rel}"])
        if os.path.exists(f"{O}/{rel}"):
            got.append({"path": rel, "window": w["number"], "pid": w["pid"], "owner": w["owner"], "layer": w["layer"], "size": [w["w"], w["h"]]})
    SHOTS.extend(got)
    return [g["path"] for g in got]


def start_site():
    Apps.site = subprocess.Popen([sys.executable, "-m", "http.server", str(SITE_PORT), "--bind", "127.0.0.1", "--directory", f"{P}/site"],
                                 stdout=open(f"{O}/site.log", "a"), stderr=subprocess.STDOUT)

    def up():
        try:
            with urllib.request.urlopen(PAGE_URL, timeout=3) as r:
                return r.status == 200
        except OSError:
            return False
    return wait(up, 15, 0.3)


def launch_caret(req):
    """The acceptance bundle as the launchd agent the shipped login item is (H13's launch_caret): CARET_LAUNCHD_AGENT=1,
    the page bridge's Mach service, Chrome for Testing's requirement accepted. No env file and no key."""
    os.makedirs(HOME, exist_ok=True)
    with open(f"{HOME}/host-settings.json", "w") as f:
        json.dump({"version": 2, "roles": ["fill", "repeat", "watch", "calendar", "words"], "level": "balanced", "character": "pebble",
                   "paused": False, "onboarded": True, "memory": [], "routing": False}, f)
    args = [CARET, "--home", HOME, "--status-item", "on", "--onboarding", "off", "--test-hooks", "--ghost-replay", REPLAY]
    if req:
        args += ["--acceptance-browser-requirement", req]
    plist = "/tmp/h14-agent.plist"
    # LV1: live Jev. The env file is on the RAM disk job.sh made; only its path is written here, never a key.
    envf = f"<key>CARET_ENV_FILE</key><string>{html.escape(ENV_FILE)}</string>" if ENV_FILE else ""
    progargs = "".join(f"<string>{html.escape(a)}</string>" for a in args)
    with open(plist, "w") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>dev.caret.host</string><key>ProgramArguments</key><array>{progargs}</array>
<key>EnvironmentVariables</key><dict><key>CARET_LAUNCHD_AGENT</key><string>1</string><key>CARET_JEV_DAILY_CAP</key><string>{html.escape(os.environ["CARET_JEV_DAILY_CAP"])}</string>{envf}</dict>
<key>MachServices</key><dict><key>dev.caret.host.page-bridge</key><true/></dict><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>{O}/caret.out</string><key>StandardErrorPath</key><string>{O}/caret.err</string>
<key>LimitLoadToSessionType</key><string>Aqua</string><key>ProcessType</key><string>Interactive</string></dict></plist>""")
    run(["launchctl", "bootout", f"gui/{UID}/dev.caret.host"])
    rc, out, err = run(["launchctl", "bootstrap", f"gui/{UID}", plist])
    say("bootstrap", rc, out.strip(), err.strip())


def start_cft(url):
    os.makedirs(f"{PROFILE}/NativeMessagingHosts", exist_ok=True)
    with open(f"{PROFILE}/NativeMessagingHosts/ai.caret.bridge.json", "w") as f:
        json.dump({"name": "ai.caret.bridge", "description": "Caret", "path": f"{ACC}/Contents/Helpers/caret-bridge", "type": "stdio",
                   "allowed_origins": [f"chrome-extension://{EXT_ID}/"]}, f)
    # Narrower than H13's window: the page task panel with no anchor stands at the screen's top right
    # (PageTaskPlacement.place), and a click meant for it must not have a page control under it if it falls through.
    p = subprocess.Popen([CFT, f"--user-data-dir={PROFILE}", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
                          "--disable-sync", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate", f"--load-extension={EXT}",
                          f"--disable-extensions-except={EXT}", f"--remote-debugging-port={CDP_PORT}",
                          "--window-position=20,30", "--window-size=560,560", url],
                         stdout=open(f"{O}/cft.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
    Apps.cft = p.pid
    return p.pid


def make_fixture():
    os.makedirs(FIX, exist_ok=True)
    with open(RESUME, "wb") as f:
        f.write(PDF_BYTES)
    with open(NOTES_TXT, "w") as f:
        f.write("Synthetic notes for H14. Nothing here is real.\n")
    return {"resume": RESUME, "resumeBytes": os.path.getsize(RESUME), "notes": NOTES_TXT, "editedMs": int(os.path.getmtime(RESUME) * 1000)}


# ------------------------------------------------------------------------------------------------- read-backs
COUNTERS = {"accepted": "pageTask.accepted", "picked": "pageTask.filePicked", "chooseFile": "pageTask.chooseFile",
            "savedConfirmed": "pageTask.savedConfirmed", "tabHeld": "pageTask.tabHeld", "acceptRefused": "pageTask.acceptRefused",
            "acceptUnsent": "pageTask.acceptUnsent", "noChooser": "pageTask.noChooser", "putAway": "pageTask.putAway",
            "saveShown": "fileSave.shown", "saveYielded": "fileSave.yielded", "saveNoPage": "fileSave.noPage"}


def counts(c):
    st = c.state()
    cs = st.get("counters") or {}
    out = {k: int(cs.get(v, 0) or 0) for k, v in COUNTERS.items()}
    # Lines the host wrote as goalAccept (HelperClient.send(GoalAccept)); the helper's last error text, which names the
    # goal a refusal is about.
    out["helperAccepts"] = int(dig(st, "helper.accepts", 0) or 0)
    out["helperLastError"] = dig(st, "helper.lastError")
    return out


def delta(a, b):
    return {k: b[k] - a[k] for k in a if isinstance(a[k], int)}


def panel_text(p):
    return dig(p, "panel.text") or ""


def open_panel_windows(c, base):
    return [w for w in winlist() if (w["pid"] == c.pid or panel_service(w)) and w["number"] not in base and w["w"] >= 300 and w["h"] >= 200]


def open_panel_ax(c, label=None):
    """The open panel by Accessibility: a window of Caret's with a "Choose" button, and its message."""
    r = ax("axwin", c.pid)
    for w in r.get("windows", []):
        titles = [b.get("title") for b in w.get("buttons", [])]
        texts = w.get("texts", [])
        if "Choose" in titles:
            msg = next((t for t in texts + [w.get("title", "")] if t.startswith("Choose a file for")), None)
            return {"found": True, "title": w.get("title"), "subrole": w.get("subrole"), "frame": w.get("frame"), "message": msg,
                    "messageNamesRow": (label is None or msg == f"Choose a file for '{label}'")}
    return {"found": False, "error": r.get("error"), "windows": [w.get("title") for w in r.get("windows", [])]}


def wait_preview(c, timeout):
    """A preview that is drawn and owns the browser's Tab."""
    return wait(lambda: (lambda p: p if dig(p, "status.stage") == "preview" and p.get("panel") and dig(p, "status.ownsTab") else None)(c.pt()), timeout, 0.25)


def keys_ok(c):
    """Whether a real Tab, ⌘2 or ⌘3 now reaches the preview: the browser in front and the preview owning its keys."""
    front = browser_front()
    p = c.pt()
    return front and bool(dig(p, "status.ownsTab")), {"browserFront": front, "ownsTab": dig(p, "status.ownsTab"), "stage": dig(p, "status.stage")}


# ------------------------------------------------------------------------------------------------- the page goal
class Ctx:
    """The live page as the canned goal names it."""
    windowId = None
    app = None
    title = PAGE_TITLE


GOALS = [0]


def canned_goal(saved_edited=None):
    """A goalProgress segment for wizard page 3 (GoalWire.swift GoalProgress): two attach rows and the user's Submit.
    With `saved_edited`, the first row offers the fixture résumé as a saved file instead of a chooser."""
    GOALS[0] += 1
    gid = f"goal-h14-{GOALS[0]}-{secrets.token_hex(3)}"
    first = {"index": 0, "kind": "attach", "says": "Resume: a file you choose", "file": {"source": "choose"}}
    if saved_edited is not None:
        first = {"index": 0, "kind": "attach", "says": f"Resume: {RESUME_NAME}",
                 "file": {"source": "saved", "savedId": SAVED_ID, "path": RESUME, "name": RESUME_NAME, "edited": saved_edited}}
    at = now_ms()
    return {
        "type": "goalProgress", "v": 1, "at": at, "goalId": gid, "requestId": None, "event": "segment",
        "segment": 0, "segments": 1, "reason": "start", "replaces": None,
        "digest": hashlib.sha256(gid.encode()).hexdigest(), "expires": at + 120000,
        "where": {"kind": "window", "app": Ctx.app["name"], "title": Ctx.title},
        "steps": [first,
                  {"index": 1, "kind": "attach", "says": "Or drop your resume here: a file you choose", "file": {"source": "choose"}},
                  {"index": 2, "kind": "handoff", "says": "You press Submit application"}],
        "warnings": [],
        "page": {"windowId": Ctx.windowId, "app": Ctx.app, "anchor": None,
                 # Where the panel stands: the lower right of the 960x600 screen, clear of Chrome's window (20,30 560x560)
                 # and of the top right, where macOS draws notification banners over everything (run 5: a click on the
                 # panel there hit a banner, which opened System Settings). Presentation only; nothing acts on it.
                 "viewport": [600, 330, 350, 262], "from": "your request", "rows": [], "attach": [],
                 "files": [{"step": 0, "label": "Resume", "accept": [".pdf", ".doc", ".docx"]},
                           {"step": 1, "label": "Or drop your resume here", "accept": []}]},
    }


def start_canned(c, saved_edited=None):
    """Starts a canned preview once no page task runs. Returns (goal, observed)."""
    busy = wait(lambda: dig(c.pt(), "status.stage") not in ("running", "stopping"), 30, 0.5)
    browser_front()
    goal = canned_goal(saved_edited)
    r = c.start(goal)
    p = wait_preview(c, PANEL_WAIT_S)
    obs = {"goalId": goal["goalId"], "reply": sub(r, "error", "status"), "idleBeforeStart": bool(busy),
           "preview": bool(p), "panelText": panel_text(p or c.pt())}
    return goal, obs


def click_body(page):
    """A real click on the page's heading: focus in the page, on no field."""
    r, _ = page.screen_rect("h1")
    if not r:
        return {"clicked": False, "why": "no h1"}
    x, y = r[0] + min(r[2] / 2, 60), r[1] + r[3] / 2
    browser_front()
    KEYS.click(x, y)
    time.sleep(0.4)
    st = page.read()
    return {"clicked": True, "at": [x, y], "active": st.get("active"), "hasFocus": st.get("hasFocus")}


def page_context(page, consumer):
    """The page's window id and app from the helper's consumer stream: a real click on the cover letter (nothing is
    typed there) makes the helper report that field, then a click on the heading takes focus off it again."""
    t = time.time()
    r, metrics = page.screen_rect("#cover_letter")
    if not r:
        return None, {"why": "no #cover_letter", "metrics": metrics}
    browser_front()
    KEYS.click(r[0] + r[2] / 2, r[1] + r[3] / 2)
    real = wait(lambda: consumer.field(t, PAGE_TITLE), 30, 0.3)
    body = click_body(page)
    if not real:
        return None, {"why": "no pageField from wizard-3 reached the consumer", "body": body}
    app = real.get("app") if isinstance(real.get("app"), dict) else {}
    Ctx.windowId = real["windowId"]
    Ctx.app = {"pid": int(app.get("pid") or Apps.cft), "bundleId": app.get("bundleId") or CFT_BUNDLE, "name": app.get("name") or CFT_NAME}
    Ctx.title = real.get("title") or PAGE_TITLE
    obs = {"windowId": Ctx.windowId, "app": Ctx.app, "title": Ctx.title, "cftPid": Apps.cft, "appPidIsCft": Ctx.app["pid"] == Apps.cft, "body": body}
    return Ctx.windowId, obs


def try_real(c, page, tag):
    """Path A: the desk's Ask about the page in front. True when it brings a preview with an attach row."""
    obs = {"body": click_body(page)}
    # A preview already up (a row that stopped before its Tab) must not pass for the Ask's answer.
    before = dig(c.pt(), "status.goalId")
    t = time.time()
    obs["type"] = sub(c.q("ask type " + ASK_TEXT), "phase", "text", "error")
    obs["submit"] = sub(c.q("ask submit"), "sent", "phase", "error")
    got = wait(lambda: (lambda p: p if dig(p, "status.stage") == "preview" and dig(p, "status.goalId") != before else None)(c.pt()), REAL_WAIT_S, 0.5)
    obs["waitedS"] = round(time.time() - t, 1)
    obs["askFinal"] = sub(c.q("ask"), "phase", "line", "requestId", "linked", "error")
    browser_front()
    p = wait_preview(c, PANEL_WAIT_S) if got else c.pt()
    obs["pageTask"] = p
    obs["hasAttachRow"] = "Choose a file…" in panel_text(p)
    obs["shots"] = shot(tag, c)
    return bool(got) and obs["hasAttachRow"], obs


# ------------------------------------------------------------------------------------------------- the open panel
def ask_for_panel(c, trigger, tag, label):
    """`trigger()` is the real key or click that asks for the open panel. Waits for it; returns (opened, observed)."""
    base = {w["number"] for w in winlist() if w["pid"] == c.pid}
    trigger()
    got = wait(lambda: (lambda p, ws: (p, ws) if p.get("choosing") is not None and ws else None)(c.pt(), open_panel_windows(c, base)), PANEL_WAIT_S, 0.25)
    p = c.pt()
    wins = got[1] if got else open_panel_windows(c, base)
    obs = {"choosing": p.get("choosing"), "openPanelWindows": wins, "frontPid": front_pid(), "caretPid": c.pid,
           "ax": open_panel_ax(c, label)}
    owners = {c.pid} | {w["pid"] for w in wins}
    obs["panelFront"] = obs["frontPid"] in owners
    obs["shots"] = shot(f"{tag}-open-panel", c, {w["number"]: "openpanel" for w in wins})
    return bool(got) and obs["panelFront"], obs, base


def pick(c, base, path):
    """Picks `path` in the open panel by keys only: ⌘⇧G, the path, Return (Go to), Return (Choose). The second Return
    is pressed only while the panel is still up and in front, so it can never reach the page."""
    obs = {}
    KEYS.key("g", "cmd,shift")
    time.sleep(1.0)
    for ch in path:
        KEYS.char(ch)
    time.sleep(0.6)
    KEYS.key("return")
    time.sleep(1.2)
    still = open_panel_windows(c, base)
    owners = {c.pid} | {w["pid"] for w in still}
    obs["afterGoTo"] = {"panelUp": bool(still), "frontPid": front_pid()}
    if still and obs["afterGoTo"]["frontPid"] in owners:
        KEYS.key("return")
    else:
        NOTES.append("the open panel was gone or behind after the Go-to Return; the Choose Return was not pressed")
    closed = wait(lambda: not open_panel_windows(c, base) and c.pt().get("choosing") is None, PANEL_WAIT_S, 0.25)
    time.sleep(0.6)  # the host gives the foreground back to the browser after the panel's completion handler
    p = c.pt()
    obs.update(closed=bool(closed), browserFront=front_pid() == Apps.cft, choosingAfter=p.get("choosing"), panelText=panel_text(p),
               ownsTab=dig(p, "status.ownsTab"), stage=dig(p, "status.stage"))
    return obs


def dismiss_panel(c, base):
    """Esc in the open panel, only while Caret (or the panel's service) is in front."""
    wins = open_panel_windows(c, base)
    owners = {c.pid} | {w["pid"] for w in wins}
    if front_pid() not in owners:
        return {"escPressed": False, "why": "the open panel was not in front"}
    KEYS.key("escape")
    closed = wait(lambda: not open_panel_windows(c, base) and c.pt().get("choosing") is None, PANEL_WAIT_S, 0.25)
    time.sleep(0.6)
    return {"escPressed": True, "closed": bool(closed), "browserFront": front_pid() == Apps.cft, "choosingAfter": c.pt().get("choosing")}


def tab(c):
    ok, why = keys_ok(c)
    if ok:
        KEYS.key("tab")
    why["tabPressed"] = ok
    return ok, why


# ------------------------------------------------------------------------------------------------- rows 1 and 2
LABELS = {0: "Resume", 1: "Or drop your resume here"}


def attach_row(c, page, rid, real_preview, step, key):
    """Rows 1 and 2: the attach row `step` (⌘2 for the first, ⌘3 for the second), the fixture résumé picked by keys,
    then Tab. `real_preview`: the real path's preview is up; otherwise a canned one is started."""
    label = LABELS[step]
    obs = {}
    if real_preview:
        path = "real"
        p = wait_preview(c, PANEL_WAIT_S) or c.pt()
        obs["start"] = {"preview": dig(p, "status.stage") == "preview", "panelText": panel_text(p)}
    else:
        path = "canned"
        goal, obs["start"] = start_canned(c)
        obs["goalId"] = goal["goalId"]
    obs["shotsPreview"] = shot(f"{rid}-preview", c)
    obs["chooseShown"] = "Choose a file…" in obs["start"]["panelText"]
    ok, why = keys_ok(c)
    obs["beforeKey"] = why
    if not ok:
        return row(rid, path, False, dict(obs, why="the preview did not own the browser's keys; no key pressed"))
    c0 = counts(c)
    opened, obs["open"], base = ask_for_panel(c, lambda: KEYS.key(key, "cmd"), rid, label if path == "canned" else None)
    if not opened:
        obs["dismiss"] = dismiss_panel(c, base)
        return row(rid, path, False, dict(obs, why="no open panel in front after the key"))
    obs["pick"] = pick(c, base, RESUME)
    text = obs["pick"]["panelText"]
    # The panel's spoken text joins a row's label and file with ", " (PageTaskPanel.spoken).
    obs["textHasFile"] = (f"{label}, {EDITED_TODAY}" in text) if path == "canned" else (EDITED_TODAY in text)
    obs["shotsPicked"] = shot(f"{rid}-picked", c)
    pressed, obs["tab"] = tab(c)
    if not pressed:
        return row(rid, path, False, dict(obs, why="the preview did not own Tab after the pick; Tab not pressed"))
    time.sleep(1.0)
    if path == "real":
        want_key = "resume" if step == 0 else "drop"
        got = wait(lambda: (lambda d: d if d.get(want_key) == RESUME_NAME else None)(page.read()), 20, 0.5) or page.read()
        obs["page"] = got
        obs["oracle"] = {"field": "#resume" if step == 0 else "#resume_drop", "want": RESUME_NAME, "got": got.get(want_key),
                         "shown": got.get("resumeShown" if step == 0 else "dropShown")}
        # The brief asks #resume-name to show the file too; the dropzone's own name line is recorded, not required.
        shown = RESUME_NAME in (got.get("resumeShown") or "") if step == 0 else True
        ok = (obs["chooseShown"] and obs["open"]["choosing"] is not None and obs["pick"]["browserFront"] and obs["textHasFile"]
              and got.get(want_key) == RESUME_NAME and shown)
        # LV1: one real Cmd-Z after the attach, read back over CDP. Recorded as its own row; it does not change this one.
        time.sleep(1.0)
        front, why = keys_ok(c)
        undo = {"beforeKey": why, "browserFront": browser_front()}
        if undo["browserFront"]:
            KEYS.key("z", "cmd")
            time.sleep(2.0)
            after = page.read()
            undo.update({"after": after.get(want_key), "afterCount": after.get("resumeCount" if step == 0 else "dropCount"), "pageTask": dig(c.pt(), "status.stage")})
            undo["shot"] = shot(f"{rid}-undo", c)
        UNDO_ROWS.append((f"{rid}-undo", undo, undo.get("afterCount") == 0))
    else:
        wait(lambda: str(dig(c.pt(), "status.stage", "")).startswith("ended") or (counts(c)["helperLastError"] or "").find(obs["goalId"]) >= 0, 4, 0.25)
        c1 = counts(c)
        d = delta(c0, c1)
        p = c.pt()
        obs["after"] = {"delta": d, "helperLastError": c1["helperLastError"], "stage": dig(p, "status.stage"), "lastHeld": dig(p, "status.lastHeld"),
                        "panelText": panel_text(p)}
        # The helper echoes no goalAccept; the host's debug state keeps the last acceptance Tab sent (pageTask.lastAccept,
        # lastAcceptFileStep, lastAcceptFileName: the confirmed file's step and name, never its folder).
        named = obs["goalId"] in (c1["helperLastError"] or "")
        sent = {"accept": dig(p, "lastAccept"), "step": dig(p, "lastAcceptFileStep"), "name": dig(p, "lastAcceptFileName")}
        obs["confirmedFile"] = {"observed": True, "sent": sent, "want": {"step": step, "name": RESUME_NAME},
                                "basis": {"rowText": obs["textHasFile"], "choosing": obs["open"]["choosing"], "filePickedDelta": d["picked"],
                                          "acceptedDelta": d["accepted"], "helperAcceptsDelta": d["helperAccepts"], "refusalNamesGoal": named}}
        obs["oracle"] = "not run: the canned goal is unknown to the helper, so nothing reaches the page"
        obs["page"] = page.read()
        ok = (obs["chooseShown"] and obs["open"]["choosing"] == step and obs["pick"]["browserFront"] and obs["textHasFile"]
              and d["picked"] == 1 and d["accepted"] == 1 and d["helperAccepts"] == 1 and named
              and sent["step"] == step and sent["name"] == RESUME_NAME and str(sent["accept"] or "").startswith(obs["goalId"]))
    obs["shotsAfter"] = shot(f"{rid}-after", c)
    row(rid, path, ok, obs)


# ------------------------------------------------------------------------------------------------- rows 3 to 5
def tab_never_confirms(c, page, edited):
    rid = "tab-never-confirms"
    goal, obs = start_canned(c, saved_edited=edited)
    obs["shotsPreview"] = shot(f"{rid}-preview", c)
    obs["offersSaved"] = f"Resume, {EDITED_TODAY}" in obs["panelText"] and "Attach" in obs["panelText"]
    c0 = counts(c)
    pressed, obs["tab"] = tab(c)
    if not pressed:
        return row(rid, "canned", False, dict(obs, why="the preview did not own Tab; Tab not pressed"))
    time.sleep(1.0)
    c1 = counts(c)
    d = delta(c0, c1)
    p = c.pt()
    obs["after"] = {"delta": d, "stage": dig(p, "status.stage"), "lastHeld": dig(p, "status.lastHeld"), "panelText": panel_text(p),
                    "helperLastError": c1["helperLastError"]}
    obs["page"] = page.read()
    obs["shotsAfter"] = shot(f"{rid}-after", c)
    # Expected from PageTask.tab: held ("no file was chosen"), nothing written. A written goalAccept with neither a pick
    # nor a saved file confirmed would carry no confirmedFile, so it would pass too, but is recorded as such.
    held = d["helperAccepts"] == 0 and d["accepted"] == 0 and dig(p, "status.lastHeld") == "no file was chosen"
    sent_bare = d["helperAccepts"] == 1 and d["accepted"] == 1 and dig(p, "lastAcceptFileStep") is None
    obs["outcome"] = "held, nothing sent" if held else ("goalAccept sent with no file confirmed" if sent_bare else "other")
    # #resume left empty is recorded only: an earlier real row may have filled it before row 2's reload.
    ok = obs["offersSaved"] and d["savedConfirmed"] == 0 and d["picked"] == 0 and (held or sent_bare)
    row(rid, "canned", ok, obs)


def row_point(c, page, label):
    """Where to click attach row `label`: its button's frame by Accessibility, else the reference layout. Returns
    (point or None, observed). The point must be inside the panel's frame, and the page under it must hold no control."""
    p = c.pt()
    fr = dig(p, "panel.frame")
    obs = {"panelFrame": fr}
    if not fr:
        return None, dict(obs, why="no panel frame")
    pt = None
    for w in ax("axwin", c.pid).get("windows", []):
        for b in w.get("buttons", []):
            name = b.get("description") or b.get("title") or ""
            if name.startswith(f"{label},") and b.get("frame"):
                x, y, wd, h = b["frame"]
                pt, obs["method"], obs["button"] = (x + wd * 0.5, y + h / 2), "ax", {"name": name, "frame": b["frame"]}
                break
        if pt:
            break
    if not pt:
        pt, obs["method"] = (fr[0] + fr[2] * ROW_X_FRAC, fr[1] + ROW1_DY), "layout"
    obs["point"] = list(pt)
    inside = fr[0] + 4 <= pt[0] <= fr[0] + fr[2] - 4 and fr[1] + 4 <= pt[1] <= fr[1] + fr[3] - 4
    under = page.at_screen(*pt)
    obs["insidePanel"], obs["pageUnder"] = inside, under
    if not inside or under.get("control"):
        return None, dict(obs, why="the point is outside the panel, or a page control lies under it")
    return pt, obs


def click_opens(c, page, gated=True):
    """gated (the product): the panel takes the click only once a mouse move puts the pointer over its content.
    gated=False (diagnostic, `pagetask clicks always`): the whole panel window takes clicks while it has attach rows."""
    rid = "click-opens" if gated else "click-opens-ungated"
    c.q("pagetask clicks " + ("gated" if gated else "always"))
    goal, obs = start_canned(c)
    obs["shotsPreview"] = shot(f"{rid}-preview", c)
    if not obs["preview"]:
        return row(rid, "canned", False, dict(obs, why="no preview"))
    pt, obs["target"] = row_point(c, page, "Resume")
    if not pt:
        return row(rid, "canned", False, dict(obs, why="no safe point on the first attach row; no click"))
    c0 = counts(c)

    diag = {"beforeMove": dig(c.pt(), "panel")}

    def trigger():
        KEYS.move(*pt)
        time.sleep(0.3)  # HostedPanel takes the pointer once a mouse-moved event reaches its monitor
        diag["afterMove"] = dig(c.pt(), "panel")
        # Every on-screen window, front to back, as the window server lists them (owner, layer, size, origin, alpha).
        diag["windowsBeforeClick"] = [l for l in run([f"{T}/winlist"])[1].splitlines()][:40]
        KEYS.click(*pt)
        # What happens right after the click: the front app, the task panel's state and its window, every 50 ms for 1 s.
        seq = []
        t0 = time.time()
        while time.time() - t0 < 1.0:
            p = c.pt()
            cnt = dig(c.state(), "counters", {}) or {}
            seq.append({"t": round(time.time() - t0, 3), "front": front_pid(), "hidden": dig(p, "status.hidden"), "stage": dig(p, "status.stage"),
                        "panel": dig(p, "panel.takesClicks"), "visible": dig(p, "panel") is not None,
                        "caretActivated": cnt.get("pageTask.caretActivated"), "click": cnt.get("pageTask.click")})
            time.sleep(0.05)
        diag["afterClickSequence"] = seq
        diag["frontAfterClick"] = [l for l in run([f"{T}/winlist"])[1].splitlines() if l.startswith("FRONT")]

    opened, obs["open"], base = ask_for_panel(c, trigger, rid, "Resume")
    diag["afterClick"] = dig(c.pt(), "panel")
    counters = dig(c.state(), "counters", {}) or {}
    diag["clickCounter"] = counters.get("pageTask.click")
    diag["chooseCounter"] = counters.get("pageTask.chooseFile")
    obs["pointer"] = diag
    if not opened:
        obs["dismiss"] = dismiss_panel(c, base)
        return row(rid, "canned", False, dict(obs, why="no open panel in front after the click"))
    obs["esc"] = dismiss_panel(c, base)
    c1 = counts(c)
    d = delta(c0, c1)
    p = c.pt()
    obs["after"] = {"delta": d, "choosing": p.get("choosing"), "stage": dig(p, "status.stage"), "panelText": panel_text(p)}
    obs["shotsAfter"] = shot(f"{rid}-after", c)
    ok = (obs["open"]["choosing"] == 0 and obs["esc"].get("closed") and obs["esc"].get("browserFront") and p.get("choosing") is None
          and d["accepted"] == 0 and d["helperAccepts"] == 0 and d["picked"] == 0)
    row(rid, "canned", ok, obs)


def save_line(c, page):
    """The save line needs the goal's page task to still hold its place and no offer of the browser's to be current
    (FileSaveMachine.receive): a canned goal picked and accepted, whose refusal ends the task, gives that for the 6 s
    the ending stays (PageTaskMachine.endLifetime)."""
    rid = "save-line"
    goal, obs = start_canned(c)
    if not obs["preview"] or not keys_ok(c)[0]:
        return row(rid, "canned", False, dict(obs, why="no preview owning the browser's keys"))
    opened, obs["open"], base = ask_for_panel(c, lambda: KEYS.key("2", "cmd"), rid, "Resume")
    if not opened:
        obs["dismiss"] = dismiss_panel(c, base)
        return row(rid, "canned", False, dict(obs, why="no open panel"))
    obs["pick"] = pick(c, base, RESUME)
    pressed, obs["tab"] = tab(c)
    if not pressed:
        return row(rid, "canned", False, dict(obs, why="Tab not pressed"))
    ended = wait(lambda: str(dig(c.pt(), "status.stage", "")).startswith("ended"), 4, 0.2)
    obs["ended"] = dig(c.pt(), "status.stage")
    if not ended:
        return row(rid, "canned", False, dict(obs, why="the task did not end, so the line would yield to the preview"))
    at = now_ms()
    line = {"type": "fileSaveOffer", "v": 1, "id": "file-offer-h14-1", "at": at, "expires": at + 60000, "goalId": goal["goalId"],
            "question": "Resume", "site": PAGE_URL, "file": {"name": RESUME_NAME}, "replaces": None,
            "says": f"Use {RESUME_NAME} for 'Resume' next time?"}
    c0 = counts(c)
    obs["inject"] = c.q("inject " + json.dumps({"kind": "helperLine", "line": line}, separators=(",", ":")))
    st = wait(lambda: (lambda s: s if dig(s, "fileSave.phase") == "offered" else None)(c.state()), 3, 0.15) or c.state()
    obs["offered"] = {"phase": dig(st, "fileSave.phase"), "panel": dig(st, "fileSave.panel"), "delta": delta(c0, counts(c))}
    obs["shotsOffered"] = shot(f"{rid}-offered", c)
    front = front_pid() == Apps.cft
    obs["escFront"] = front
    if front and dig(st, "fileSave.phase") == "offered":
        KEYS.key("escape")
    st2 = wait(lambda: (lambda s: s if dig(s, "fileSave.phase") == "none" else None)(c.state()), 3, 0.15) or c.state()
    obs["afterEsc"] = {"phase": dig(st2, "fileSave.phase"), "panel": dig(st2, "fileSave.panel")}
    obs["shotsAfter"] = shot(f"{rid}-after", c)
    ok = (obs["inject"].get("ok") is True and dig(st, "fileSave.phase") == "offered" and bool(dig(st, "fileSave.panel")) and front
          and dig(st2, "fileSave.phase") == "none")
    row(rid, "canned", ok, obs)


# ------------------------------------------------------------------------------------------------- rows 6 and 7
def settings_flags(c):
    s = c.q("settings").get("settings") or {}
    # CaretSettings encodes these only when they differ from their defaults (web on, contenteditables off).
    return {"pageInlineText": s.get("pageInlineText", True), "pageInlineContentEditable": s.get("pageInlineContentEditable", False)}


def switches(c):
    rid = "switches"
    obs = {"before": settings_flags(c)}
    base = {w["number"] for w in winlist() if w["pid"] == c.pid}
    obs["show"] = sub(c.q("memory show"), "windowShown", "tab", "error")
    win = wait(lambda: [w for w in winlist() if w["pid"] == c.pid and w["number"] not in base and w["w"] >= 300 and w["h"] >= 200], 5, 0.3) or []
    names = {w["number"]: "memory" for w in win}
    obs["memoryWindows"] = win
    obs["shotsShow"] = shot(f"{rid}-memory", c, names)
    obs["tab"] = sub(c.q("memory tab sites"), "tab", "windowShown", "error")
    time.sleep(0.6)
    obs["shotsSites"] = shot(f"{rid}-sites", c, names)
    obs["webOff"] = sub(c.q("memory switch web off"), "tab", "error")
    obs["afterWebOff"] = settings_flags(c)
    obs["richOn"] = sub(c.q("memory switch rich on"), "tab", "error")
    obs["afterRichOn"] = settings_flags(c)
    obs["shotsSwitched"] = shot(f"{rid}-switched", c, names)
    c.q("memory switch web on")
    c.q("memory switch rich off")
    obs["restored"] = settings_flags(c)
    obs["close"] = sub(c.q("memory close"), "windowShown", "error")
    browser_front()
    ok = (obs["tab"].get("tab") == "sites" and bool(win) and obs["afterWebOff"]["pageInlineText"] is False
          and obs["afterRichOn"]["pageInlineContentEditable"] is True
          and obs["restored"] == {"pageInlineText": True, "pageInlineContentEditable": False})
    row(rid, "n/a", ok, obs)


def zero_submits():
    try:
        log = open(f"{O}/site.log", errors="replace").read()
    except OSError as e:
        return row("zero-submits", "n/a", False, {"why": f"no site.log: {e}"})
    submits = [ln for ln in log.splitlines() if re.search(r'"POST /tasks/submit', ln)]
    obs = {"submits": submits, "pageLoads": len(re.findall(r'"GET /tasks/wizard-3\.html', log)),
           "oraclePosts": len(re.findall(r'"POST /tasks/oracle/', log)), "logLines": len(log.splitlines())}
    row("zero-submits", "n/a", obs["pageLoads"] >= 1 and not submits, obs)


# ------------------------------------------------------------------------------------------------- results
def write_results(final_state, rev, real):
    for rid, obs, ok in UNDO_ROWS:
        if not any(x["id"] == rid for x in ROWS):
            row(rid, "real", ok, obs)
    every = ROWS + CHECKS
    res = {"spend": final_state.get("spend"), "rev": rev, "pass": bool(ROWS) and all(x["pass"] for x in every), "rows": ROWS, "checks": CHECKS, "realPath": real,
           "screenshots": SHOTS, "finalState": "final-state.json", "log": "job.log", "driverLog": "h14.log", "caretLog": "caret.err",
           "siteLog": "site.log", "helperMessages": "helper-messages.ndjson", "notes": NOTES, "elapsedS": round(time.time() - T0, 1)}
    with open(f"{O}/result.json", "w") as f:
        json.dump(res, f, indent=1, default=str)
    lines = [f"# H14 test Mac, {rev}", "",
             f"page goal: real path {'gave a preview' if real.get('ok') else 'gave no preview'} "
             f"(ask {dig(real, 'first.askFinal.phase')!s}, waited {dig(real, 'first.waitedS')!s} s); canned rows say so", ""]
    for x in CHECKS:
        lines.append(f"- {'PASS' if x['pass'] else 'FAIL'} setup `{x['id']}`")
    for x in ROWS:
        o = x["observed"] if isinstance(x["observed"], dict) else {}
        brief = {k: o[k] for k in ("why", "outcome", "textHasFile", "oracle", "ended", "submits") if k in o}
        if "confirmedFile" in o:
            brief["confirmedFile"] = o["confirmedFile"]["sent"]
        lines.append(f"- {'PASS' if x['pass'] else 'FAIL'} `{x['id']}` ({x['path']}) {json.dumps(brief, default=str)[:300]}")
    lines += [""] + [f"- note: {n}" for n in NOTES]
    with open(f"{O}/scoreboard.md", "w") as f:
        f.write("\n".join(lines) + "\n")


KEYS = None


def main():
    global KEYS
    rev = open(f"{P}/REV").read().strip()
    say("== H14", rev)
    c = Caret(HOME)
    final = {}
    real = {"tried": False, "ok": False}
    try:
        fx = make_fixture()
        check("fixture", os.path.getsize(RESUME) > 0 and os.path.exists(NOTES_TXT), fx)
        if not start_site():
            NOTES.append("the fixture site on 127.0.0.1 never answered")
        rc, req, err = run(["codesign", "-d", "-r-", CFT_APP])
        req = (req + err).split("designated => ", 1)[-1].strip().splitlines()[0] if "designated" in req + err else ""
        launch_caret(req)
        if not wait(lambda: os.path.exists(c.sock), 40, 0.5):
            check("caret-up", False, {"why": "no debug socket; see caret.err"})
            return
        c.pid = wait(caret_pid, 10)
        svc = wait(lambda: (lambda s: s if dig(s, "helper.state") == "running" and dig(s, "reader.state") == "running" else None)(c.q("services")), 60, 1)
        st = c.state()
        p0 = c.pt()
        check("caret-up", bool(svc) and dig(st, "engine.state") == "replay" and p0.get("filesWired") is True,
              {"pid": c.pid, "services": c.q("services"), "engine": st.get("engine"), "filesWired": p0.get("filesWired"), "trust": st.get("trust")})
        consumer = Consumer(c.screen)
        KEYS = Keys()
        start_cft(PAGE_URL)
        page = Page("/tasks/wizard-3.html")
        loaded = wait(lambda: page.read().get("title") == PAGE_TITLE, 20, 0.3)
        time.sleep(2)
        check("page", bool(loaded), page.read())
        wid, ctx = page_context(page, consumer)
        check("window-id", bool(wid), ctx)
        if not wid:
            NOTES.append("no window id from the helper: the canned path cannot run, and every row needs it or the real path")

        # (A) the real path, once; (B) canned for whatever A does not give.
        real["tried"] = True
        real["ok"], real["first"] = try_real(c, page, "real-ask")
        say("real path", "preview" if real["ok"] else "no preview", json.dumps(real["first"].get("askFinal")))
        if not real["ok"] and dig(real, "first.pageTask.status.stage") == "preview":
            NOTES.append("the real path's preview had no attach row; canned rows replace it")

        if left() > 120 and (real["ok"] or wid):
            attach_row(c, page, "attach-input", real["ok"], 0, "2")
        if left() > 120 and (real["ok"] or wid):
            page.reload()
            again = False
            if real["ok"]:
                again, real["second"] = try_real(c, page, "real-ask-2")
                if not again:
                    NOTES.append("attach-dropzone: the real path gave no preview on the reloaded page; canned instead")
            if again or wid:
                attach_row(c, page, "attach-dropzone", again, 1, "3")
        if wid:
            if left() > 90:
                tab_never_confirms(c, page, fx["editedMs"])
            if left() > 90:
                click_opens(c, page)
            if left() > 90:
                # Diagnostic: the same click with the whole panel taking clicks (no pointer gating).
                click_opens(c, page, gated=False)
                c.q("pagetask clicks gated")
            if left() > 90:
                save_line(c, page)
        if left() > 60:
            switches(c)
        zero_submits()
        final = c.state()
    except Exception as e:  # noqa: BLE001 - the results are written whatever happened
        say(f"crashed: {e!r}")
        NOTES.append(f"harness crashed: {e!r}")
    finally:
        if not final:
            final = c.state()
        if not any(x["id"] == "zero-submits" for x in ROWS):
            zero_submits()
        with open(f"{O}/final-state.json", "w") as f:
            json.dump(final, f, indent=1)
        write_results(final, rev, real)
        if KEYS:
            KEYS.close()
        run(["launchctl", "bootout", f"gui/{UID}/dev.caret.host"])
        if Apps.site:
            Apps.site.terminate()
    say("done", sum(1 for x in ROWS if x["pass"]), "of", len(ROWS), "rows pass")


if __name__ == "__main__":
    main()
