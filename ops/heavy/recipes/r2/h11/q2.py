#!/usr/bin/env python3
"""Q2 driver, rig VM only: Caret in real apps with live models, scored from read-backs Caret doesn't own.

H11: the run's scenario is page_task (the desk's Ask on one of the repo's task pages, the page task panel at the form,
Tab, the reveal's continuation, ⌘Z), read back through the fixture's own oracle (fixture/h11_site.ts over a Unix
socket). H10's browser fills and Asks stay in this file and run only when payload/h11-options.json lists "h10".

Three Caret configurations, one after another:
  P  product: the acceptance Caret.app as a launchd agent (the role that vends the page bridge), its own helper and
     reader, live Jev and Groq through CARET_ENV_FILE (a file on a RAM disk; this process never sees a key). Fill, Ask,
     the event card as shipped, writing help, surfaces and stopping.
  C  calendar: the shipped reader can't write Calendar (no --calendar-test), so this harness starts the bundle's own
     helper and reader with --calendar-test and attaches a full-UI Caret (--helper-socket): event card added, undone.
  G  ghost: the Gemma model is not in the guest (3.5 GB), so ghost text comes from A18's recorded model run
     (--test-hooks --ghost-replay). Mid-sentence fit or silence, Tab takes the phrase, ⌘Z.

Every key and click is real HID input (q2-key), allowed only in the rig VM. Read-backs: the page's own posted state
(q2_site.py), Accessibility (q2-ax), the native fixture's `form dump`, EventKit, and Caret's read-only debug socket.
Usage: q2.py <out-dir>      env: RIG_JOB, RIG_PAYLOAD, Q2_ENV_FILE (the RAM-disk env file's path)
"""
import html
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request

P = os.environ["RIG_PAYLOAD"]
O = sys.argv[1]
T = f"{P}/tools"
ENV_FILE = os.environ.get("Q2_ENV_FILE", "")
ACC = f"{P}/acc/Caret.app"
CARET = f"{ACC}/Contents/MacOS/Caret"
NODE = f"{ACC}/Contents/Helpers/node"
HELPER = f"{ACC}/Contents/Resources/helper/main.mjs"
READER = f"{ACC}/Contents/Helpers/caret-screen"
CFT_APP = f"{P}/apps/Google Chrome for Testing.app"
CFT = f"{CFT_APP}/Contents/MacOS/Google Chrome for Testing"
FIXTURE = f"{P}/apps/CaretFixture.app/Contents/MacOS/caret-fixture"
EXT = f"{ACC}/Contents/Resources/Caret for Chrome"
EXT_ID = "idbkbnaepbamcdecogahbinlcodkbmmj"
SITE = "http://127.0.0.1:8765"
DOCS = "/tmp/q2docs"
UID = os.getuid()
T0 = time.time()
BUDGET_S = int(os.environ.get("Q2_BUDGET", "3150"))  # set by job.sh from its one deadline
SPEND_STOP = 0.20         # H10: Sam's cap is $0.30 of live Jev; stop live scenarios well before it
# H10: only the browser scenarios, in the real app: four Tab fills (TextEdit note, Mail message), one Fill all with a
# select, radio, checkbox and date and one Cmd-Z, and three Asks on the page.
H10_ASKS = ("q1-01", "q1-02", "q1-10")
# H11: the run's options, written by stage.sh (the guest can't see the host's environment). Defaults: page_task on
# wizard-1, the note as the only source, no Next press.
OPTIONS = {"pages": ["wizard-1"], "sources": "note", "nextPage": False, "scenarios": ["page_task"]}
if os.path.exists(f"{P}/h11-options.json"):
    OPTIONS.update(json.load(open(f"{P}/h11-options.json")))
for d in ("shots", "scen"):
    os.makedirs(f"{O}/{d}", exist_ok=True)

ROWS = []                 # the scoreboard
ESC = {}                  # ask id -> {"afterOne": ask reply after one Esc, "escs": Escs to close the desk}
NOTES = []
LOG = open(f"{O}/q2.log", "a", buffering=1)


def say(*a):
    line = f"{time.strftime('%H:%M:%S')} +{int(time.time() - T0)}s " + " ".join(str(x) for x in a)
    print(line, flush=True)
    LOG.write(line + "\n")


def run(cmd, timeout=30, inp=None):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=inp)
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


def key(name, mods=""):
    run([f"{T}/q2-key", "key", name] + ([mods] if mods else []))


def typ(text):
    run([f"{T}/q2-key", "type", text], timeout=120)


def pgrep(name):
    rc, out, _ = run(["pgrep", "-x", name])
    return [int(x) for x in out.split()] if rc == 0 else []


def wait(fn, timeout, every=0.2):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() >= end:
            return v
        time.sleep(every)


def left():
    return BUDGET_S - (time.time() - T0)


# ------------------------------------------------------------------------------------------------- Caret's sockets
class Caret:
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

    def perch(self):
        return self.q("perch")

    def ask(self):
        return self.q("ask")


def dig(d, path, default=None):
    for k in path.split("."):
        if not isinstance(d, dict):
            return default
        d = d.get(k)
    return default if d is None else d


class Consumer:
    """A consumer on the helper's socket: every published message (synthetic content only) to helper-messages.ndjson,
    every costUsd summed (a lower bound: event-card, planner and Groq costs are not on the wire at ae3dd8b)."""

    def __init__(self, path, tag):
        self.msgs = []
        self.spend = 0.0
        self.lock = threading.Lock()
        self.out = open(f"{O}/helper-messages-{tag}.ndjson", "a", buffering=1)
        threading.Thread(target=self._run, args=(path,), daemon=True).start()

    def _costs(self, o):
        if isinstance(o, dict):
            return sum(v for k, v in o.items() if k == "costUsd" and isinstance(v, (int, float))) + sum(self._costs(v) for v in o.values() if isinstance(v, (dict, list)))
        if isinstance(o, list):
            return sum(self._costs(v) for v in o)
        return 0.0

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
        s.sendall(json.dumps({"type": "hello", "v": 1, "role": "consumer", "mode": "live", "pid": os.getpid(), "version": "q2"}).encode() + b"\n")
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
                    self.spend += self._costs(m)
                self.out.write(json.dumps({"t": time.time(), "message": m}) + "\n")

    def since(self, t, mtype=None):
        with self.lock:
            return [m for (ts, m) in self.msgs if ts >= t and (mtype is None or m.get("type") == mtype)]


CONSUMERS = []
CONFIG = (open(f"{P}/CONFIG").read().strip() if os.path.exists(f"{P}/CONFIG") else "off")


CURRENT = {"caret": None}
SPEND = {"last": None}


def spend():
    """Real spend from the helper's ledger on the debug socket (state.spend, H8): Jev plus the Groq writer since the
    helper started. The consumer-side sum of costUsd fields is only the fallback, and a lower bound."""
    c = CURRENT["caret"]
    if c is not None:
        s = c.state().get("spend")
        if isinstance(s, dict):
            SPEND["last"] = s
    s = SPEND["last"]
    if s:
        return float(dig(s, "jev.costUsd", 0) or 0) + float(dig(s, "writer.costUsd", 0) or 0)
    return sum(c.spend for c in CONSUMERS)


# ------------------------------------------------------------------------------------------------- the page's own state
def site(path, body=None):
    try:
        req = urllib.request.Request(SITE + path, data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST")
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read() or b"{}")
    except Exception as e:  # noqa: BLE001 - a dead page is a result, not a crash
        return {"error": str(e)}


class Page:
    current = "apply"

    @classmethod
    def go(cls, name):
        if cls.current != name:
            site(f"/cmd?page={cls.current}", {"go": f"{name}.html"})
            cls.current = name
        else:
            site(f"/cmd?page={name}", {"reload": True})
        site(f"/clear?page={name}", {})
        return wait(lambda: site(f"/state?page={name}").get("fields") is not None, 15, 0.3)

    @classmethod
    def focus(cls, field):
        site(f"/cmd?page={cls.current}", {"focus": field})
        return wait(lambda: site(f"/state?page={cls.current}").get("focused") == field, 5, 0.2)

    @classmethod
    def fields(cls):
        return site(f"/state?page={cls.current}").get("fields") or {}

    @classmethod
    def pressed(cls):
        return site(f"/state?page={cls.current}").get("pressed") or []


def norm(field, v):
    if v is True or v is False:
        return v
    v = (v or "").strip()
    if re.search(r"phone|callback|mobile", field):
        return re.sub(r"\D", "", v)[-10:]
    return v.lower()


def same(field, got, want):
    if callable(want):
        return bool(want(got))
    return norm(field, got) == norm(field, want)


# ------------------------------------------------------------------------------------------------- evidence
def shot(name, pids):
    for pid in pids:
        for w in ax("windows", pid).get("windows", []):
            if w.get("layer", 0) >= 0 and w["frame"][2] > 20 and w["frame"][3] > 10:
                run(["screencapture", "-x", "-o", "-l", str(w["number"]), f"{O}/shots/{name}-{pid}-{w['number']}.png"])


def dump(name, obj):
    with open(f"{O}/scen/{name}.json", "w") as f:
        json.dump(obj, f, indent=1, default=str)
    return f"scen/{name}.json"


def row(sid, group, **k):
    r = {"id": sid, "group": group}
    for c in ("offered", "right", "acted", "verified", "undone", "stopped", "wrong"):
        r[c] = k.get(c, "n/a")
    r["evidence"] = k.get("evidence", "")
    r["note"] = k.get("note", "")
    ROWS.append(r)
    say("ROW", json.dumps(r))
    with open(f"{O}/rows.json", "w") as f:
        json.dump(ROWS, f, indent=1)


def yn(b):
    return "yes" if b else "no"


# ------------------------------------------------------------------------------------------------- the apps
class Apps:
    textedit = None
    cft = None
    mail = None
    site = None
    fixture = None
    tasks = None
    bridged = False

    @classmethod
    def start_site(cls):
        cls.site = subprocess.Popen([sys.executable, f"{T}/q2_site.py", f"{P}/site", "8765"], stdout=open(f"{O}/site.log", "a"), stderr=subprocess.STDOUT)
        wait(lambda: "error" not in site("/state?page=x"), 10, 0.3)

    @classmethod
    def textedit_docs(cls, *names):
        run(["open", "-a", "TextEdit", *[f"{DOCS}/{n}" for n in names]])
        cls.textedit = wait(lambda: (pgrep("TextEdit") or [None])[0], 15)
        time.sleep(1.5)
        return cls.textedit

    @classmethod
    def start_cft(cls, page):
        pid = cls.start_cft_url(f"{SITE}/{page}.html")
        Page.current = page
        wait(lambda: site(f"/state?page={page}").get("fields") is not None, 30, 0.5)
        return pid

    @classmethod
    def start_cft_url(cls, url):
        prof = "/tmp/q2-cft"
        os.makedirs(f"{prof}/NativeMessagingHosts", exist_ok=True)
        # Chrome for Testing with --user-data-dir reads only this folder (W1's --nm-probe).
        with open(f"{prof}/NativeMessagingHosts/ai.caret.bridge.json", "w") as f:
            json.dump({"name": "ai.caret.bridge", "description": "Caret", "path": f"{ACC}/Contents/Helpers/caret-bridge", "type": "stdio",
                       "allowed_origins": [f"chrome-extension://{EXT_ID}/"]}, f)
        p = subprocess.Popen([CFT, f"--user-data-dir={prof}", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
                              "--disable-sync", "--disable-features=DisableLoadExtensionCommandLineSwitch,Translate", f"--load-extension={EXT}",
                              f"--disable-extensions-except={EXT}", "--window-position=480,30", "--window-size=480,565", url],
                             stdout=open(f"{O}/cft.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
        cls.cft = p.pid
        return p.pid

    @classmethod
    def mail_open(cls, eml, subject):
        run(["open", "-a", "Mail", f"{DOCS}/{eml}"])
        cls.mail = wait(lambda: (pgrep("Mail") or [None])[0], 20)
        shown = lambda: any(subject in w.get("title", "") for w in ax("windows", cls.mail).get("windows", []))  # noqa: E731
        win = wait(shown, 20, 1) if cls.mail else False
        if cls.mail and not win:
            # H10: a fresh guest's Mail has no account and may put its first-run sheet up instead of the message. Record
            # it, dismiss it once through Accessibility (VM only), and open the message again.
            seen = {"windows": ax("windows", cls.mail), "tree": jrun([f"{T}/h10-ax", "tree", str(cls.mail), "8"], 30)}
            shot(f"mail-{eml}-first", [cls.mail])
            for title in ("Cancel", "Not Now", "Close"):
                r = jrun([f"{T}/h10-ax", "press", str(cls.mail), title], 15)
                seen.setdefault("presses", []).append(r)
                if r.get("pressed"):
                    break
            time.sleep(2)
            cls.mail = (pgrep("Mail") or [None])[0]
            if cls.mail is None:
                run(["open", "-a", "Mail", f"{DOCS}/{eml}"])
                cls.mail = wait(lambda: (pgrep("Mail") or [None])[0], 20)
            else:
                run(["open", "-a", "Mail", f"{DOCS}/{eml}"])
            win = wait(shown, 20, 1) if cls.mail else False
            seen["after"] = ax("windows", cls.mail) if cls.mail else None
            if not win and cls.mail:
                # Mail could not show the message: quit it, so its account sheet cannot take the front (and focus a text
                # field) while the page scenarios run.
                run(["osascript", "-e", 'tell application "Mail" to quit'], 15)
                seen["quit"] = wait(lambda: not pgrep("Mail"), 10, 0.5) is not None
            shot(f"mail-{eml}-after", [cls.mail] if cls.mail else [])
            dump(f"mail-{eml}", seen)
            NOTES.append(f"Mail {eml}: first-run windows {[w.get('title') for w in seen['windows'].get('windows', [])]}; presses {[p.get('pressed') or p.get('error') for p in seen.get('presses', [])]}; message shown after: {bool(win)}")
        return bool(win)

    @classmethod
    def front(cls, pid):
        r = ax("activate", pid)
        time.sleep(0.4)
        return r.get("front", False)


# ------------------------------------------------------------------------------------------------- one field fill
def fill_field(c, sid, field, want, app_pid, note=""):
    t = time.time()
    if same(field, Page.fields().get(field), want):
        row(sid, "fill", offered="n/a", verified="yes", note=f"{note}: {field} already held {want!r} (a pop-up's Fill all on this page wrote it)")
        return True, True
    Page.focus(field)
    # H10: the helper offers a form either field by field (a ghost value, Tab writes that field) or, when it has a value
    # for every text field, as a Fill all pop-up at the field (Tab writes the form). Either is an offer here.
    st = wait(lambda: (lambda s: s if (dig(s, "offer.kind") == "fill" and dig(s, "offer.pid") == app_pid) or dig(s, "surface.kind") == "popup" else None)(c.state()), 15)
    offered = bool(st)
    popup = bool(st) and dig(st, "surface.kind") == "popup"
    text = dig(st or {}, "offer.text", "") if not popup else (dig(st, "surface.popupSpoken") or dig(st, "surface.lineText") or "")
    placed = (popup_placement(c, field) if popup else placement(c, field)) if offered else None
    shot(f"{sid}-offer", [app_pid, c.pid])
    acted = verified = wrong = False
    got = None
    if offered:
        before = dig(c.state(), "lastClaim.claimID")
        key("tab")
        # H10: a page field is written by the helper's page engine (the claim is "accepted", nothing is inserted by the
        # host), so the read-back waits for the page itself, up to 8 s.
        acted = bool(wait(lambda: (lambda s: dig(s, "lastClaim.claimID") != before and outcome(dig(s, "lastClaim.outcome")) in ("inserted", "accepted", "insertFailed", "pending"))(c.state()), 6))
        wait(lambda: Page.fields().get(field), 10, 0.3)
        time.sleep(0.5)
        got = Page.fields().get(field)
        shot(f"{sid}-after", [app_pid, c.pid])
        verified = same(field, got, want)
        wrong = bool(got) and not verified
    proposals = c.consumers.since(t, "fillProposal") if hasattr(c, "consumers") else []
    withheld = sorted({str(f.get("withheld")) for p in proposals for f in (p.get("fields") or []) if f.get("withheld")})
    ev = dump(sid, {"state": c.state(), "page": Page.fields(), "proposals": proposals[-2:]})
    page_now = Page.fields()
    known = KNOWN.get(Page.current, {})
    wrong = wrong or any(v not in ("", False, None) and k in known and not same(k, v, known[k]) for k, v in page_now.items())
    row(sid, "fill", offered=yn(offered), right=yn(offered and (popup or same(field, text, want))), acted=yn(acted), verified=yn(verified), wrong=yn(wrong),
        evidence=f"{ev}; shots/{sid}-offer-*", note=f"{note} {'pop-up' if popup else 'ghost'} offer={text[:120]!r} got={got!r} page={page_now} withheld={withheld} lastSkip={dig(c.state(), 'fill.lastSkip')} held={dig(c.state(), 'surface.held')}")
    if placed is not None:
        row(f"{sid}-at-field", "placement", offered="yes", verified=yn(placed["atField"]), evidence=dump(f"{sid}-placement", placed),
            note=f"ghost {placed['ghost']} vs the page's field {placed['field']} (page metrics); line {placed['line']}")
    return offered, verified


# ------------------------------------------------------------------------------------------------- H10 placement
def page_rect(field):
    """The field in screen points by the page's own measure (guard.js): its rect and the window's metrics, with the
    viewport at the bottom of the window and the guest's 2x display (devicePixelRatio / 2 is the zoom)."""
    s = site(f"/state?page={Page.current}")
    m, r = s.get("metrics") or {}, (s.get("rects") or {}).get(field)
    if not m or not r:
        return None
    z = (m.get("dpr") or 2) / 2.0
    top = m["screenY"] + m["outerHeight"] - m["innerHeight"] * z
    return [m["screenX"] + r[0] * z, top + r[1] * z, r[2] * z, r[3] * z]


def placement(c, field):
    """Whether Caret drew the offer at the field: its ghost panel (the field's frame, inset by the text's inset) spans the
    field's height and lies inside its width, by the page's own measure, within 2 points."""
    time.sleep(0.3)
    st = c.state()
    g = dig(st, "fill.overlay.ghost.frame")
    f = page_rect(field)
    line = dig(st, "fill.overlay.line.frame")
    ok = bool(g and f) and abs(g[1] - f[1]) <= 2 and abs(g[3] - f[3]) <= 2 and g[0] >= f[0] - 2 and g[0] + g[2] <= f[0] + f[2] + 2
    return {"atField": ok, "ghost": g, "field": f, "line": line, "placement": dig(st, "fill.overlay.placement")}


def outcome(o):
    """A claim record's outcome: a string, or the one key of an object ({"accepted": {}}, {"rejected": "..."})."""
    return o if isinstance(o, str) else next(iter(o), None) if isinstance(o, dict) else None


def popup_placement(c, field):
    """Whether the pop-up was placed at the field: the field it placed against is the page's field (within 2 points), and
    its panel overlaps the field's columns and sits right above or below it (within 60 points), covering none of it."""
    time.sleep(0.3)
    st = c.state()
    p = dig(st, "surface.panel.frame")
    pf = dig(st, "surface.panelPlacement.field")
    f = page_rect(field)
    # Above or below the field, sharing its columns, or beside it (FieldPanelPlacement puts it where it covers none of the
    # app's own elements), sharing its rows; within 60 points either way, and covering none of the field.
    ok = bool(p and pf and f) and all(abs(pf[i] - f[i]) <= 2 for i in range(4)) and (
        (p[0] < f[0] + f[2] and p[0] + p[2] > f[0] and ((p[1] + p[3] <= f[1] + 2 and f[1] - (p[1] + p[3]) <= 60) or (p[1] >= f[1] + f[3] - 2 and p[1] - (f[1] + f[3]) <= 60)))
        or (p[1] < f[1] + f[3] and p[1] + p[3] > f[1] and ((p[0] + p[2] <= f[0] + 2 and f[0] - (p[0] + p[2]) <= 60) or (p[0] >= f[0] + f[2] - 2 and p[0] - (f[0] + f[2]) <= 60))))
    return {"atField": ok, "ghost": p, "field": f, "line": pf, "placement": dig(st, "surface.panelPlacement")}


def aim(field):
    """A real click where the page's own measure puts the field; the page must say that field took focus. Checks the
    viewport-at-the-bottom rule the helper uses (page-link screenRect) in this guest, independently of Caret."""
    t0 = time.time()
    site(f"/cmd?page={Page.current}", {"blur": True})
    # Metrics posted after the blur, so the window's place is the one the click goes to (the first run's first check read
    # metrics from before the window settled and clicked off screen).
    wait(lambda: (lambda s: s.get("focused") is None and (s.get("receivedAt") or 0) > t0 + 0.5)(site(f"/state?page={Page.current}")), 4, 0.2)
    f = page_rect(field)
    if f is None:
        return {"field": field, "hit": False, "why": "no page metrics"}
    run([f"{T}/q2-key", "click", f"{f[0] + f[2] / 2:.1f}", f"{f[1] + f[3] / 2:.1f}"])
    time.sleep(0.6)
    got = site(f"/state?page={Page.current}").get("focused")
    return {"field": field, "point": [f[0] + f[2] / 2, f[1] + f[3] / 2], "focused": got, "hit": got == field}


# ------------------------------------------------------------------------------------------------- phase P
def launch_agent(home, extra_args, req):
    """The acceptance bundle as the launchd agent the shipped login item is: CARET_LAUNCHD_AGENT=1 under launchd
    (ppid 1), team-signed, with the page bridge's Mach service. The plist holds no key: only the env file's path."""
    plist = "/tmp/q2-agent.plist"
    progargs = "".join(f"<string>{html.escape(a)}</string>" for a in [CARET, "--home", home, *extra_args] + (["--acceptance-browser-requirement", req] if req else []))
    with open(plist, "w") as f:
        f.write(f"""<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>dev.caret.host</string><key>ProgramArguments</key><array>{progargs}</array>
<key>EnvironmentVariables</key><dict><key>CARET_LAUNCHD_AGENT</key><string>1</string><key>CARET_JEV_DAILY_CAP</key><string>{html.escape(os.environ["CARET_JEV_DAILY_CAP"])}</string><key>CARET_ENV_FILE</key><string>{html.escape(ENV_FILE)}</string></dict>
<key>MachServices</key><dict><key>dev.caret.host.page-bridge</key><true/></dict><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>{O}/p-caret.out</string><key>StandardErrorPath</key><string>{O}/p-caret.err</string>
<key>LimitLoadToSessionType</key><string>Aqua</string><key>ProcessType</key><string>Interactive</string></dict></plist>""")
    run(["launchctl", "bootout", f"gui/{UID}/dev.caret.host"])
    rc, out, err = run(["launchctl", "bootstrap", f"gui/{UID}", plist])
    say("bootstrap", rc, out.strip(), err.strip())


def phase_p():
    say("== phase P: product")
    rc, req, err = run(["codesign", "-d", "-r-", CFT_APP])
    req = (req + err).split("designated => ", 1)[-1].strip().splitlines()[0] if "designated" in req + err else ""
    c = Caret("/tmp/q2p")
    # The configuration under test (payload/CONFIG, written by run.sh): "off" is the default "Always suggest as I type",
    # "on" is "Caret decides when to help" (H6), set the way the menu sets it: in the settings file. Version 1 of the
    # file is read by this host; the rest are the defaults a new user has.
    os.makedirs(c.home, exist_ok=True)
    with open(f"{c.home}/host-settings.json", "w") as f:
        json.dump({"version": 2, "roles": ["fill", "repeat", "watch", "calendar", "words"], "level": "balanced", "character": "pebble",
                   "paused": False, "onboarded": True, "memory": [], "routing": CONFIG == "on"}, f)
    launch_agent(c.home, ["--status-item", "on", "--onboarding", "off", "--test-hooks", "--ghost-replay", f"{P}/ghost/replay.json"], req)
    CURRENT["caret"] = c
    if not wait(lambda: os.path.exists(c.sock), 40, 0.5):
        say("phase P: no host socket")
        NOTES.append("phase P: Caret's debug socket never appeared; see p-caret.err")
        return
    c.pid = wait(lambda: next(iter(int(x) for x in run(["pgrep", "-f", "acc/Caret.app/Contents/MacOS/Caret"])[1].split()), None), 10)
    say("caret pid", c.pid)
    svc = wait(lambda: (lambda s: s if dig(s, "helper.state") == "running" and dig(s, "reader.state") == "running" else None)(c.q("services")), 60, 1)
    dump("p-services", c.q("services"))
    nojev = "runs without Jev" in open(f"{O}/p-caret.err", errors="replace").read() if os.path.exists(f"{O}/p-caret.err") else None
    say("services", bool(svc), "no-jev" if nojev else "jev on")
    if not svc:
        NOTES.append("phase P: helper or reader never reached running; scenarios skipped")
        return
    if nojev:
        NOTES.append("phase P: the helper ran without Jev (no key reached it); results are not live")
    settings = c.q("settings")
    dump("p-settings", settings)
    routing_seen = dig(c.state(), "settings.routing", None)
    NOTES.append(f"configuration {CONFIG}: settings reply routing={settings.get('routing', dig(settings, 'settings.routing'))}; state routing={routing_seen}")
    c.consumers = Consumer(c.screen, "p")
    CONSUMERS.append(c.consumers)
    threading.Thread(target=rim_sampler, args=(c,), daemon=True).start()

    scen = OPTIONS["scenarios"]
    if "h10" in scen:
        Apps.textedit_docs("Application details.txt", "Registration note.txt", "Support notes.txt")
        ax("setframe", Apps.textedit, 0, 30, 470, 330)
        Apps.start_cft("apply")
        time.sleep(3)
        bridge_row(c)

    steps = []
    if "page_task" in scen:
        steps += [(f"page_task {pg}", (lambda pg: lambda c: page_task(c, pg))(pg)) for pg in OPTIONS["pages"]]
    if "h10" in scen:
        steps += [("fill", fills), ("ask", asks)]
    for name, fn in steps:
        if left() < 600:
            NOTES.append(f"phase P: {name} not run (time budget)")
            continue
        if spend() > SPEND_STOP:
            NOTES.append(f"phase P: {name} not run (visible spend ${spend():.3f})")
            continue
        try:
            fn(c)
        except Exception as e:  # noqa: BLE001 - one scenario's crash must not end the run
            say(f"{name} crashed: {e!r}")
            NOTES.append(f"harness: {name} crashed: {e!r}")
    st = c.state()
    dump("p-final-state", st)
    dump("p-final-perch", c.perch())
    # H11: offers.claimed is a key of state.counters (HostRuntime.swift), not a nested object; H10 read it with dig().
    claimed = (st.get("counters") or {}).get("offers.claimed", 0) or 0
    row("bug18-counters", "debug", offered="n/a", verified=yn((dig(st, "tap.consumed", 0) or 0) > 0 and claimed > 0),
        evidence="scen/p-final-state.json", note=f"tap.consumed={dig(st, 'tap.consumed')} offers.claimed={claimed}")
    err = open(f"{O}/p-caret.err", errors="replace").read() if os.path.exists(f"{O}/p-caret.err") else ""
    row("bug19-chrome-ax", "reader", verified=yn("-25205" not in err), evidence="p-caret.err", note=f"AXManualAccessibility -25205 lines: {err.count('-25205')}")
    run(["launchctl", "bootout", f"gui/{UID}/dev.caret.host"])
    wait(lambda: not os.path.exists(c.sock) or "error" in c.q("ping"), 15)


RIM = []


def rim_sampler(c):
    while True:
        p = c.perch()
        if p.get("rimShown"):
            RIM.append({"t": time.time(), "rim": p.get("rim"), "targetWindow": p.get("targetWindow"), "seen": p.get("seen"), "number": p.get("rimWindowNumber")})
        time.sleep(0.15)


def fills(c):
    Apps.front(Apps.textedit)
    run(["open", "-a", "TextEdit", f"{DOCS}/Application details.txt"])
    time.sleep(1)
    # The click check runs on the contact page, which no fill here uses: a click focuses a field, which starts the form's
    # proposal there, and a pop-up belongs to the field it was offered at.
    Page.go("contact")
    Apps.front(Apps.cft)
    aims = [aim(f) for f in ("lastname", "email")]
    site(f"/cmd?page={Page.current}", {"blur": True})
    Page.go("apply")
    Apps.front(Apps.cft)
    row("placement-formula", "placement", offered="n/a", verified=yn(all(a["hit"] for a in aims)), evidence=dump("placement-formula", aims),
        note="real clicks at the page-measured field centres (viewport at the window's bottom): " + "; ".join(f"{a['field']}->{a.get('focused')}" for a in aims))
    t9 = time.time()
    fill_field(c, "fill-1a-web-note-first", "first_name", "Jordan", Apps.cft, "apply.html + TextEdit note")
    whole_form(c, "fill-1a-fill9", "apply", t9)
    fill_field(c, "fill-1b-web-note-email", "email", "jordan.reyes@example.org", Apps.cft, "focus moved after a proposal (Q1 bug 12)")

    webmail_tab(c)
    fill_all(c)


def whole_form(c, sid, page, t):
    """H10 round 2: after Tab on a Fill all pop-up, every value the page knows is right, nothing is wrong, and the pop-up
    was not withdrawn as expired (fix 8)."""
    got = Page.fields()
    known = KNOWN.get(page, {})
    right = sorted(k for k, v in known.items() if same(k, got.get(k), v))
    wrong = sorted(k for k, v in got.items() if v not in ("", False, None) and k in known and not same(k, v, known[k]))
    expired = [m.get("id") for m in c.consumers.since(t, "offerWithdrawn") if m.get("reason") == "expired"]
    popups = [m.get("spec", {}).get("blocks", [{}])[0].get("title", {}).get("text") for m in c.consumers.since(t, "popup")]
    row(sid, "fill", offered=yn(bool(popups)), verified=yn(len(right) >= 3 and not wrong and not expired), wrong=yn(bool(wrong)),
        evidence=dump(sid, {"page": got, "right": right, "wrong": wrong, "expired": expired, "popups": popups}),
        note=f"pop-ups {popups}; expired {expired}; right {len(right)}/{len(known)} {right}; wrong {wrong}")


def webmail_tab(c):
    """H10 round 2, in place of Mail (no account in the guest): the source is a webmail-like page in another tab of the
    same browser, and the form is in the first tab. TextEdit is quit first, so the webmail tab is the only window that
    holds the traveler's details. Records whether fill offers anything, and from which window."""
    # Exact-pid TERM, not AppleScript: an Apple Event to another app can raise an Automation prompt in the guest. The notes are
    # unedited files the harness opened.
    [run(["kill", "-TERM", str(pid)], 15) for pid in pgrep("TextEdit")]
    wait(lambda: not pgrep("TextEdit"), 10, 0.5)
    Page.go("traveler")
    # A second tab: the running browser opens a URL given again on its own command line in a new tab, and selects it.
    subprocess.Popen([CFT, "--user-data-dir=/tmp/q2-cft", f"{SITE}/webmail.html"], stdout=open(f"{O}/cft.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
    opened = wait(lambda: site("/state?page=webmail").get("fields") is not None, 20, 0.5) is not None
    Apps.front(Apps.cft)
    time.sleep(3)
    shot("webmail-tab", [Apps.cft])
    # Back to the form's tab with Chrome's own ⌘1 (the first tab): no Caret offer is up on the webmail page to take it.
    key("1", "cmd")
    sel = (0, "", "")
    time.sleep(2)
    t = time.time()
    Page.current = "traveler"
    offered, verified = fill_field(c, "fill-2a-webmail-tab-first", "first", "Jordan", Apps.cft, f"traveler.html, source a webmail tab (opened {opened}, tab switch rc {sel[0]})")
    props = c.consumers.since(t - 30, "fillProposal") + [p for p in c.consumers.since(t - 30, "popup")]
    srcs = sorted({(f.get("source") or {}).get("windowTitle", "") for p in props for f in (p.get("fields") or []) if f.get("source")})
    NOTES.append(f"webmail tab: proposals {len(props)}; source windows {srcs}; offered {offered}; verified {verified}")
    run(["open", "-a", "TextEdit", f"{DOCS}/Application details.txt"])


def native_fill(c):
    fx = subprocess.Popen([FIXTURE, "--foreground", "--windows", "forms"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f"{O}/fixture.err", "a"), text=True, bufsize=1)
    Apps.fixture = fx

    def cmd(line):
        fx.stdin.write(line + "\n")
        fx.stdin.flush()
        return fx.stdout.readline().strip()

    # Its first stdout line is a startup banner ("caret-fixture pid N windows ..."), not a reply.
    banner = fx.stdout.readline().strip()
    time.sleep(1.5)
    queue = ax("texts", fx.pid, "Caret Fixture — Order queue").get("texts", [])
    opened = cmd("form open intake")
    Apps.front(fx.pid)
    # `responder` knows only the fixture's named windows; a new form window puts focus in its first field itself.
    foc = ax("focused", fx.pid)
    if foc.get("role") != "AXTextField":
        key("tab")
        foc = ax("focused", fx.pid)
    NOTES.append(f"native fixture: focus after open {foc.get('role')} value={foc.get('value')!r}")
    t = time.time()
    st = wait(lambda: (lambda s: s if dig(s, "offer.kind") == "fill" and dig(s, "offer.pid") == fx.pid else None)(c.state()), 15)
    shot("fill-3-native-offer", [fx.pid, c.pid])
    text = dig(st or {}, "offer.text", "")
    acted = verified = wrong = False
    form = {}
    if st:
        key("tab")
        acted = bool(wait(lambda: dig(c.state(), "lastClaim.outcome") in ("inserted", "accepted", "insertFailed"), 6))
        time.sleep(1)
    try:
        form = json.loads(cmd("form dump intake") or "{}")
    except ValueError:
        form = {}
    vals = [v for v in json.dumps(form).split('"') if v and v not in ("ok", "fields", "intake") and len(v) > 2]
    written = [v for v in (form.get("fields") or {}).values()] if isinstance(form.get("fields"), dict) else vals
    written = [w for w in written if isinstance(w, str) and w]
    verified = bool(written) and all(any(w in q for q in queue) for w in written)
    wrong = bool(written) and not verified
    ev = dump("fill-3-native", {"banner": banner, "queue": queue, "opened": opened, "dump": form, "state": c.state(), "proposals": c.consumers.since(t, "fillProposal")[-2:]})
    row("fill-3-native", "fill", offered=yn(bool(st)), right=yn(bool(st) and any(text.strip() in q for q in queue if text.strip())), acted=yn(acted), verified=yn(verified),
        wrong=yn(wrong), evidence=ev, note=f"caret-fixture intake; offer={text!r}; written={written}")
    cmd("form close intake")


def fill_all(c):
    """One-action Fill all (H6): with a fill offer showing, ⌘1 fills every field the helper can write. Select, radio,
    checkbox and date are scored separately: the helper may write them or leave them as hand-off rows."""
    run(["open", "-a", "TextEdit", f"{DOCS}/Registration note.txt"])
    time.sleep(1)
    Page.go("register")
    Apps.front(Apps.cft)
    t = time.time()
    Page.focus("full_name")
    offer_up = lambda: (lambda s: s if dig(s, "surface.kind") == "popup" or (dig(s, "offer.kind") == "fill" and dig(s, "offer.pid") == Apps.cft) else None)(c.state())  # noqa: E731
    st = wait(offer_up, 12)
    if not st:
        # H10: a field the helper withheld shows nothing; the form's next field with a value carries its ⌘1.
        Page.focus("email")
        st = wait(offer_up, 10)
    shot("fill-4-fillall-offer", [Apps.cft, c.pid])
    kind = "popup" if dig(st or {}, "surface.kind") == "popup" else dig(st or {}, "offer.kind")
    want = {"full_name": "Jordan Reyes", "email": "jordan.reyes@example.org", "shirt": "L", "attend": "in-person", "veg": True, "arrival": "2026-11-12"}
    acted = False
    how = None
    if st:
        if kind == "popup":
            key("tab")
            how = "popup Tab"
        else:
            key("1", "cmd")
            how = "⌘1"
        acted = bool(wait(lambda: any(m.get("phase") in ("started", "acting", "verified", "done") for m in c.consumers.since(t, "taskProgress")), 8))
        if not acted and how == "⌘1":
            how = "⌘1 did nothing"
        wait(lambda: any(m.get("phase") in ("done", "stopped", "handoff") for m in c.consumers.since(t, "taskProgress")), 15)
        time.sleep(1)
    got = Page.fields()
    text_ok = all(same(k, got.get(k), want[k]) for k in ("full_name", "email"))
    controls = {k: same(k, got.get(k), want[k]) for k in ("shirt", "attend", "veg", "arrival")}
    wrong = any(got.get(k) not in ("", False, None) and not same(k, got.get(k), v) for k, v in want.items())
    prop = c.consumers.since(t, "fillProposal")
    ev = dump("fill-4-fillall", {"state": c.state(), "page": got, "proposals": prop[-2:], "progress": c.consumers.since(t, "taskProgress")})
    row("fill-4-fill-all", "fill", offered=yn(bool(st)), right=yn(how in ("⌘1", "popup Tab") and acted), acted=yn(acted), verified=yn(text_ok and all(controls.values())), wrong=yn(wrong), evidence=ev,
        note=f"offer {kind}, accepted by {how}; text fields right={text_ok}; select/radio/checkbox/date right={controls}; page={got}")
    undone = False
    if acted:
        before_undo = Page.fields()
        key("z", "cmd")
        # The one ⌘Z restores every field the run wrote: text empty, select back to its prompt, no radio, box unticked.
        undone = bool(wait(lambda: all(v in ("", False, None) for v in Page.fields().values()), 8, 0.4))
        NOTES.append(f"Fill all: page before ⌘Z {before_undo}; after {Page.fields()}")
    st2 = c.state()
    row("fill-5-undo", "fill", acted=yn(acted), undone=yn(undone), evidence=dump("fill-5-undo", {"lastUndo": st2.get("lastUndo"), "toast": dig(st2, "surface.toast"), "page": Page.fields()}),
        note=f"⌘Z after Fill all; page after={Page.fields()}; lastUndo={st2.get('lastUndo')}")


# ------------------------------------------------------------------------------------------------- Ask
PERSON = {"first": "Jordan", "last": "Reyes", "email": "jordan.reyes@example.org", "phone": "(512) 555-0147"}
ASKS = [
    # id, page, sources (TextEdit docs / Mail .eml), instruction, expected fields, kind
    ("q1-01", "apply", ["Application details.txt"], "put my first name, last name and email from my application notes into this form",
     {"first_name": "Jordan", "last_name": "Reyes", "email": PERSON["email"]}, "fill"),
    ("q1-02", "apply", ["Application details.txt"], "In Chrome, put the email from Application details.txt into the Email field", {"email": PERSON["email"]}, "fill"),
    ("q1-03", "apply", ["Application details.txt"], "Fill the rest of this application form in Chrome from my Application details note",
     {"first_name": "Jordan", "last_name": "Reyes", "email": PERSON["email"], "phone": PERSON["phone"], "grad": "05/2027", "linkedin": "https://www.linkedin.com/in/jordan-reyes-example"}, "fill"),
    ("q1-04", "apply", ["Application details.txt"], "Put the first name, last name, phone and school from Application details.txt into First Name, Last Name, Phone and School in Chrome",
     {"first_name": "Jordan", "last_name": "Reyes", "phone": PERSON["phone"], "school-input": "The University of Texas at Austin"}, "fill"),
    ("q1-05", "apply", ["Application details.txt"], "Put the phone number from Application details.txt into Phone in Chrome", {"phone": PERSON["phone"]}, "fill"),
    ("q1-06", "apply", ["Application details.txt"], "Put Jordan into First Name in Chrome", {"first_name": "Jordan"}, "fill+undo"),
    ("q1-07", "contact", ["Registration note.txt"], "Fill my name and email into this contact form in Chrome", {"firstname": "Jordan", "lastname": "Reyes", "email": PERSON["email"]}, "fill"),
    ("q1-08", "contact", ["Registration note.txt"], "Put my email into the Email field in Chrome", {"email": PERSON["email"]}, "fill"),
    ("q1-09", "flights", [], "Search one-way flights from Austin to Seattle on 11/12/2026 on this flight booking page in Chrome",
     {"trip": "oneway", "from-input": lambda v: "austin" in (v or "").lower(), "to-input": lambda v: "seattle" in (v or "").lower(), "depart": "2026-11-12"}, "fill"),
    ("q1-10", "traveler", ["Application details.txt"], "Fill in my name and email on this traveler information form in Chrome", {"first": "Jordan", "last": "Reyes", "email": PERSON["email"]}, "fill"),
    ("b29-04", "apply", ["Application details.txt"], "just do my contact info up top",
     {"first_name": "Jordan", "last_name": "Reyes", "email": PERSON["email"], "phone": PERSON["phone"]}, "fillOrAsk"),
    ("b29-07", "contact", ["Registration note.txt"], "name + email only pls", {"firstname": "Jordan", "lastname": "Reyes", "email": PERSON["email"]}, "fillOrAsk"),
    ("b30-02", "support", ["Support notes.txt"], "Copy the callback phone from the note into the support form and draft a short description of the sign-in problem. Leave Account email empty and do not submit.",
     {"callback": "555-0114", "acct": "", "desc": lambda v: all(w in (v or "").lower() for w in ("welcome screen", "sign")) and "555-0199" not in (v or "")}, "goal"),
    ("b30-03", "reply-oren", ["oren.eml"], "Copy Oren's email into the reply To field and draft an RSVP saying I'm in for the workshop. Do not add an event or send the reply.",
     {"to": "oren.moss@example.com", "body": lambda v: any(w in (v or "").lower().replace("’", "'") for w in ("i'm in", "count me in", "i'll be there")) and not any(w in (v or "").lower() for w in ("bringing a guest", "plus one"))}, "goal"),
    ("b30-11", "reply-maren", ["maren.eml"], "copy Maren's address into the reply and tell her I'll be there at 4", {}, "refuseOrAsk"),
]
# Every value that is right on each page; a written value that contradicts one is wrong, and a right value in a field
# the instruction didn't name is reported as out of scope.
KNOWN = {
    "apply": {"first_name": "Jordan", "last_name": "Reyes", "email": PERSON["email"], "phone": PERSON["phone"], "school-input": "The University of Texas at Austin",
              "degree": "Bachelor's Degree", "grad": "05/2027", "auth": "yes", "linkedin": "https://www.linkedin.com/in/jordan-reyes-example"},
    "contact": {"firstname": "Jordan", "lastname": "Reyes", "email": PERSON["email"]},
    "flights": {"trip": "oneway", "from-input": lambda v: "austin" in (v or "").lower(), "to-input": lambda v: "seattle" in (v or "").lower(), "depart": "2026-11-12"},
    "traveler": {"first": "Jordan", "last": "Reyes", "email": PERSON["email"], "phone": PERSON["phone"], "dob": "2004-03-04"},
    "support": {"callback": "555-0114"},
    "reply-oren": {"to": "oren.moss@example.com"},
    "reply-maren": {"to": "maren.holt@example.com"},
}
FORBID = {"b30-11": ["4", "four", "3:00", "3 pm", "at 3"]}
EML_SUBJECT = {"trip.eml": "Your trip details", "oren.eml": "Paper workshop", "maren.eml": "Kiln open house"}


# The labels a user reads on each page, to pick the right rows of a "which fields?" question.
LABELS = {
    "apply": {"first_name": "first name", "last_name": "last name", "email": "email", "phone": "phone", "grad": "graduation", "linkedin": "linkedin", "school-input": "school"},
    "contact": {"firstname": "first name", "lastname": "last name", "email": "email"},
    "flights": {"from-input": "from", "to-input": "to", "depart": "depart", "trip": "trip"},
    "traveler": {"first": "first name", "last": "last name", "email": "email"},
    "support": {"callback": "callback", "desc": "description"},
    "reply-oren": {"to": "to", "body": "message"},
    "reply-maren": {"to": "to", "body": "message"},
}
SOURCE_WORDS = {"Application details.txt": "application details", "Registration note.txt": "registration note", "Support notes.txt": "support notes",
                "trip.eml": "trip details", "oren.eml": "paper workshop", "maren.eml": "kiln open house"}


def answer_question(a, want, page, sources):
    """Answers an Ask question (B29) as the user who gave the instruction would: the wanted fields (Space on each, then
    Tab), the window the instruction names, or "you". Returns what was picked."""
    q = a.get("question") or {}
    opts = q.get("options") or []
    part = q.get("part")
    text = lambda o: " ".join(str(o.get(k) or "") for k in ("label", "title", "app", "name", "kind")).lower()  # noqa: E731
    cur = int(a.get("highlight") or 0)

    def move(i):
        nonlocal cur
        while opts and cur != i:
            key("down")
            cur = (cur + 1) % len(opts)
            time.sleep(0.15)

    picked = []
    if part == "fields":
        labels = [LABELS.get(page, {}).get(k) for k in want if LABELS.get(page, {}).get(k)]
        for i, o in enumerate(opts):
            if o.get("kind") == "field" and any((o.get("label") or "").lower().startswith(l) for l in labels):
                move(i)
                key("space")
                picked.append(o.get("label"))
                time.sleep(0.15)
    else:
        words = [SOURCE_WORDS[s] for s in sources if s in SOURCE_WORDS]
        for i, o in enumerate(opts):
            t = text(o)
            if (part == "source" and (any(w in t for w in words) or (not words and o.get("kind") == "memory"))) or (part == "person" and o.get("kind") == "you"):
                move(i)
                picked.append(t.strip())
                break
    key("tab")
    return {"part": part, "question": q.get("text") or q.get("question"), "options": [text(o).strip() for o in opts], "picked": picked}


def open_desk(c):
    for title in ("Ask Caret…", "Ask Caret..."):
        r = ax("menu", c.pid, title)
        if r.get("pressed"):
            break
    ok = wait(lambda: c.perch().get("listOpen") and c.perch().get("askEditing"), 4, 0.2)
    return r, bool(ok)


def asks(c):
    first = True
    for sid, page, sources, instruction, want, kind in [a for a in ASKS if a[0] in H10_ASKS]:
        if left() < 700 or spend() > SPEND_STOP:
            NOTES.append(f"ask {sid} not run (time {int(left())} s left, visible spend ${spend():.3f})")
            continue
        for s in sources:
            if s.endswith(".eml"):
                Apps.mail_open(s, EML_SUBJECT[s])
            else:
                run(["open", "-a", "TextEdit", f"{DOCS}/{s}"])
        time.sleep(1)
        Page.go(page)
        Apps.front(Apps.cft)
        t = time.time()
        menu, opened = open_desk(c)
        if first:
            # Q1 bugs 13 and 15: the first press opens the desk, near the window being worked in.
            p, win = c.perch(), next((w for w in ax("windows", Apps.cft).get("windows", []) if w["frame"][2] > 300), None)
            lf = p.get("listFrame")
            near = bool(lf and win and lf[0] < win["frame"][0] + win["frame"][2] and lf[0] + lf[2] > win["frame"][0] and lf[1] < 200)
            shot("ask-desk", [Apps.cft, c.pid])
            row("surface-desk-near-window", "surfaces", offered=yn(opened), verified=yn(near), evidence=dump("ask-desk", {"perch": p, "cftWindow": win, "menu": menu}) + "; shots/ask-desk-*",
                note=f"listFrame={lf} window={win and win['frame']} (Q1 bugs 13, 15: first press opened={opened})")
            first = False
        if not opened:
            row(f"ask-{sid}", "ask", offered="no", note=f"desk did not open: {menu}")
            continue
        typ(instruction)
        key("return")
        a = wait(lambda: (lambda r: r if r.get("phase") in ("proposed", "failed", "ended", "asked", "question") or dig(r, "card.question") else None)(c.ask()), 30, 0.3) or c.ask()
        shot(f"ask-{sid}-card", [Apps.cft, c.pid])
        questions = []
        while a.get("phase") == "question" and kind != "refuseOrAsk" and len(questions) < 2:
            qid = dig(a, "question.questionId") or json.dumps(a.get("question"), sort_keys=True)
            questions.append(answer_question(a, want, page, sources))
            a = wait(lambda: (lambda r: r if r.get("phase") in ("proposed", "failed", "ended") or (r.get("phase") == "question" and (dig(r, "question.questionId") or json.dumps(r.get("question"), sort_keys=True)) != qid) else None)(c.ask()), 30, 0.3) or c.ask()
            shot(f"ask-{sid}-after-pick-{len(questions)}", [Apps.cft, c.pid])
        phase = a.get("phase")
        card = a.get("card") or {}
        asked = bool(questions) or phase == "question"
        acted = verified = wrong = undone = False
        got = {}
        # H10: a proposal is run whether or not a question came first (Q2 ran only unasked ones, so q1-02's plan, made
        # after "Whose details go in?", was never accepted).
        if phase == "proposed":
            key("tab")
            wait(lambda: c.ask().get("phase") in ("ended", "failed", "idle") or any(m.get("phase") in ("done", "stopped", "handoff") for m in c.consumers.since(t, "taskProgress")), 20, 0.3)
            acted = bool(c.consumers.since(t, "taskProgress")) or c.ask().get("phase") in ("running", "ended")
            time.sleep(1)
        got = Page.fields()
        hits = {k: same(k, got.get(k), v) for k, v in want.items()}
        verified = bool(want) and all(hits.values())
        written = {k: v for k, v in got.items() if v not in ("", False, None) and not (k == "trip" and v == "round")}
        known = {**KNOWN.get(page, {}), **want}
        contradicts = [k for k in written if k in known and not same(k, got.get(k), known[k])]
        unknown = [k for k in written if k not in known and not (sid in FORBID and k == "body")]
        out_of_scope = [k for k in written if k not in want and k in known]
        wrong = bool(contradicts or unknown or Page.pressed())
        if sid in FORBID:
            wrong = wrong or any(f in json.dumps(got).lower() for f in FORBID[sid])
        if kind == "fill+undo" and acted:
            key("z", "cmd")
            undone = bool(wait(lambda: not Page.fields().get("first_name"), 8, 0.4))
        right = verified if kind in ("fill", "fill+undo", "goal", "fillOrAsk") else (not wrong and not written and phase in ("failed", "question"))
        title = card.get("title", "")
        ev = dump(f"ask-{sid}", {"instruction": instruction, "questions": questions, "ask": a, "afterRun": c.ask(), "page": got, "hits": hits, "progress": c.consumers.since(t, "taskProgress"), "pressed": Page.pressed()})
        row(f"ask-{sid}", "ask", offered=yn(phase == "proposed" or asked), right=yn(right), acted=yn(acted), verified=yn(verified) if want else "n/a",
            undone=yn(undone) if kind == "fill+undo" else "n/a", wrong=yn(wrong), evidence=f"{ev}; shots/ask-{sid}-card-*",
            note=f"phase={phase} asked={asked} picks={[q['picked'] for q in questions]} title={title!r} line={a.get('line')!r} hits={hits} contradicts={contradicts} unknownWrites={unknown} outOfScope={out_of_scope} pressed={Page.pressed()}")
        # Q1 bug 14: one Esc clears a finished or failed ask (line and text); count the Escs to close.
        escs = 0
        after1 = {}
        for _ in range(4):
            if not c.perch().get("listOpen"):
                break
            key("escape")
            escs += 1
            time.sleep(0.5)
            if escs == 1:
                after1 = c.ask()
        ESC[sid] = {"afterOne": {k: after1.get(k) for k in ("text", "phase", "line")}, "escs": escs, "phase": phase, "title": title}
        if phase == "failed":
            NOTES.append(f"ask {sid}: after one Esc text={after1.get('text')!r} phase={after1.get('phase')}; Escs to close {escs}")


# ------------------------------------------------------------------------------------------------- TextEdit: event card, writing
def new_doc(full=False):
    Apps.front(Apps.textedit)
    key("n", "cmd")
    time.sleep(1.2)
    if full:
        ax("setframe", Apps.textedit, 0, 25, 960, 575)
    else:
        ax("setframe", Apps.textedit, 10, 40, 600, 420)
    time.sleep(0.5)


EVENT_SENTENCE = "Call with Priya on Thursday at 3pm about the venue deposit."


def event_offer(c, t, timeout=25):
    return wait(lambda: (lambda s: s if dig(s, "surface.kind") in ("action", "popup") and (dig(s, "surface.panel.frame") or dig(s, "surface.held")) else None)(c.state()), timeout)


def calendar_tool(*a):
    return jrun([f"{T}/calendar-tool", *a], 30)


def event_product(c):
    """The shipped path (H8): the event line, ↓ for the card (it asks how long; Tab takes the highlighted 30 minutes),
    Tab, macOS's Calendar prompt naming Caret, Allow, the event in the default calendar, ⌘Z while the toast holds it.
    Read back through EventKit (q2-ax events), never from Caret."""
    new_doc(full=True)
    t = time.time()
    typ(EVENT_SENTENCE + " ")
    st = event_offer(c, t)
    shot("event-p-offer", [Apps.textedit, c.pid])
    held = dig(st or {}, "surface.held") or dig(c.state(), "surface.lastUnshown.reason")
    drawn = bool(st and dig(st, "surface.panel.frame") and not dig(st, "surface.held"))
    row("surface-full-window-doc", "surfaces", offered=yn(bool(st)), verified=yn(drawn), evidence=dump("event-p-offer", {"state": st or c.state()}) + "; shots/event-p-offer-*",
        note=f"event action line in a full-window TextEdit document (Q1 bug 2); held={held}")
    acted = verified = undone = wrong = False
    info = {"calendarBefore": c.state().get("calendar"), "default": calendar_tool("default")}
    cal_title = (info["default"] or {}).get("title") if isinstance(info["default"], dict) else None
    if drawn:
        key("down")
        time.sleep(0.5)
        info["card"] = dig(c.state(), "surface")
        shot("event-p-card", [Apps.textedit, c.pid])
        key("tab")
        info["prompt"] = wait(lambda: (lambda r: r if isinstance(r, dict) and r.get("buttons") else None)(calendar_tool("prompt", "Caret")), 15, 0.3)
        if info["prompt"]:
            for n in info["prompt"].get("windows", []):
                run(["screencapture", "-x", "-o", "-l", str(n), f"{O}/shots/event-p-prompt-{n}.png"])
            info["allow"] = calendar_tool("allow", "Caret")
        done = wait(lambda: [m for m in c.consumers.since(t, "taskProgress") if m.get("phase") in ("done", "handoff", "stopped")], 30, 0.2)
        acted = bool(c.consumers.since(t, "taskProgress"))
        info["end"] = done
        evs = ax("events", cal_title or "Calendar", 14).get("events", [])
        mine = [e for e in evs if "priya" in e.get("title", "").lower()]
        info["events"] = evs
        verified = len(mine) == 1 and "T15:00" in mine[0]["start"] and "T15:30" in mine[0]["end"]
        wrong = bool(mine) and not verified
        shot("event-p-added", [Apps.textedit, c.pid])
        key("z", "cmd")
        undone = bool(wait(lambda: not [e for e in ax("events", cal_title or "Calendar", 14).get("events", []) if "priya" in e.get("title", "").lower()], 15, 0.5))
        info["toast"] = dig(c.state(), "surface.toast")
        info["calendarAfter"] = c.state().get("calendar")
    row("event-calendar", "event", offered=yn(bool(st)), right=yn(drawn), acted=yn(acted), verified=yn(verified), undone=yn(undone), wrong=yn(wrong),
        evidence=dump("event-p", {**info, "progress": c.consumers.since(t, "taskProgress")}) + "; shots/event-p-*",
        note=f"shipped path; prompt={'yes' if info.get('prompt') else 'no'} allow={info.get('allow')}; default calendar={cal_title}; expects Thursday 15:00-15:30 local")
    # Q1 bug 9: a sentence with a zone gets an event or a line saying why.
    key("escape")
    t = time.time()
    typ("\nKiln open house on Saturday at 3pm PT. ")
    st = event_offer(c, t, 15)
    msgs = [m.get("type") for m in c.consumers.since(t)]
    row("event-zone", "event", offered=yn(bool(st)), evidence=dump("event-zone", {"state": c.state(), "types": msgs}),
        note=f"surface={dig(st or {}, 'surface.kind')} line={dig(c.state(), 'surface.lineText')!r} (Q1 bug 9: offered, or a line saying why)")
    key("escape")


def writing(c):
    new_doc()
    typ("I recieve the package tomorow. ")
    st = wait(lambda: (lambda s: s if dig(s, "writing.underlines") or dig(s, "offer.kind") == "writing" else None)(c.state()), 12)
    shot("writing-underline", [Apps.textedit, c.pid])
    before = ax("doc", Apps.textedit).get("value", "")
    fixed = native = own = False
    if st:
        if not dig(c.state(), "offer.writing.ownsTab"):
            key("down")
            time.sleep(0.5)
        key("tab")
        fixed = bool(wait(lambda: "receive " in ax("doc", Apps.textedit).get("value", ""), 5, 0.4))
        if fixed:
            key("z", "cmd")
            native = bool(wait(lambda: "recieve" in ax("doc", Apps.textedit).get("value", ""), 5, 0.4))
            time.sleep(5)  # the toast goes; the next ⌘Z is TextEdit's own
            v1 = ax("doc", Apps.textedit).get("value", "")
            key("z", "cmd")
            own = bool(wait(lambda: ax("doc", Apps.textedit).get("value", "") != v1, 4, 0.4))
    st2 = c.state()
    row("writing", "writing", offered=yn(bool(st)), right=yn(fixed), acted=yn(fixed), verified=yn(fixed), undone=yn(native and own),
        evidence=dump("writing", {"before": before, "after": ax("doc", Apps.textedit), "writing": st2.get("writing"), "lastUndo": st2.get("lastUndo")}) + "; shots/writing-*",
        note=f"Tab fixed={fixed}; ⌘Z native={native} (strategy {dig(st2, 'lastUndo.strategy')}); TextEdit's own undo after={own}")


# ------------------------------------------------------------------------------------------------- stopping
def stop_run(c):
    """A real key in the running task's app pauses it; Esc (owned after 3 s of work) stops it with the step named."""
    run(["open", "-a", "TextEdit", f"{DOCS}/Application details.txt"])
    Page.go("apply")
    Apps.front(Apps.cft)
    menu, opened = open_desk(c)
    if not opened:
        row("stop", "stop", note="desk did not open")
        return
    t = time.time()
    typ(ASKS[2][3])
    key("return")
    a = wait(lambda: (lambda r: r if r.get("phase") in ("proposed", "failed") else None)(c.ask()), 30, 0.3) or {}
    if a.get("phase") != "proposed":
        row("stop", "stop", offered="no", evidence=dump("stop", {"ask": a}), note="no multi-step plan to interrupt (Ask did not propose)")
        key("escape")
        return
    key("tab")
    started = wait(lambda: [m for m in c.consumers.since(t, "taskProgress") if m.get("phase") in ("started", "acting")], 8, 0.05)
    finished_first = any(m.get("phase") in ("done", "stopped") for m in c.consumers.since(t, "taskProgress"))
    t_key = time.time()
    key("right")  # a real key in the task's app
    paused = wait(lambda: [m for m in c.consumers.since(t_key, "taskProgress") if m.get("phase") == "paused"] or c.state().get("authorityLastRevoke"), 3, 0.1)
    time.sleep(3.3)
    key("escape")
    line = wait(lambda: (lambda s: s if re.search(r"stopped", s or "", re.I) else None)(dig(c.state(), "surface.lineText")), 10, 0.2)
    prog = c.consumers.since(t, "taskProgress")
    row("stop", "stop", offered="yes", acted=yn(bool(started)), stopped=yn(bool(paused) and bool(line)), evidence=dump("stop", {"progress": prog, "state": c.state(), "perch": c.perch()}),
        note=f"paused by a real key={bool(paused)}; Esc line={line!r}; task phases={[m.get('phase') for m in prog]}" + ("; the task finished before the key" if finished_first and not paused else ""))
    key("escape")


def surfaces(c):
    hit = next((r for r in RIM if r.get("rim") and r.get("targetWindow") and r["rim"][0] <= r["targetWindow"][0] and r["rim"][1] <= r["targetWindow"][1]
                and r["rim"][0] + r["rim"][2] >= r["targetWindow"][0] + r["targetWindow"][2]), None)
    row("surface-rim", "surfaces", offered=yn(bool(RIM)), verified=yn(bool(hit)), evidence=dump("rim", RIM[-20:]),
        note=f"{len(RIM)} perch samples with rimShown; first around its target: {hit}")


# ------------------------------------------------------------------------------------------------- phase G
def direct_caret(home, extra, tag):
    out = open(f"{O}/{tag}-caret.err", "a")
    p = subprocess.Popen([CARET, "--home", home, "--status-item", "off", "--onboarding", "off", *extra], stdout=out, stderr=subprocess.STDOUT)
    c = Caret(home)
    c.pid = p.pid
    c.proc = p
    wait(lambda: os.path.exists(c.sock), 30, 0.3)
    return c


def phase_g():
    """Ghost text from A18's recorded model run (--test-hooks --ghost-replay): the Gemma model is 3.5 GB and is not in
    the guest. Caret started here with no model key in its environment, so its helper runs without Jev and spends nothing."""
    say("== phase G: ghost text (recorded model run)")
    if not Apps.textedit:
        Apps.textedit_docs("Support notes.txt")
    c = direct_caret("/tmp/q2g", ["--test-hooks", "--ghost-replay", f"{P}/ghost/replay.json"], "g")
    time.sleep(3)
    replay = {(e.get("before"), e.get("after", "")): e for e in json.load(open(f"{P}/ghost/replay.json")).get("entries", [])}
    ok = n = 0
    details = []
    for case in json.load(open(f"{P}/ghost/mid-cases.json")):
        if left() < 120:
            break
        new_doc()
        typ(case["before"] + case["after"])
        for _ in range(len(case["after"])):
            key("left")
        time.sleep(3)
        s = c.state()
        got = dig(s, "offer.text") if dig(s, "offer.kind") == "ghost" else None
        rec = replay.get((case["before"], case["after"]), {})
        good = (got is None) if rec.get("reason") else (got == rec.get("text"))
        n += 1
        ok += good
        details.append({"before": case["before"], "got": got, "recorded": rec.get("text"), "reason": rec.get("reason"), "ok": good})
        key("w", "cmd")
        time.sleep(0.6)
        key("d", "cmd")  # Don't Save
        time.sleep(0.6)
    row("ghost-mid-sentence", "ghost", offered=f"{sum(1 for d in details if d['got'])}/{n}", right=f"{ok}/{n}", wrong=yn(ok < n), evidence=dump("ghost-mid", details),
        note="recorded model run (--ghost-replay), not live: fits the recorded text or stays silent (Q1 bugs 6, 7)")
    tabs = []
    for case in json.load(open(f"{P}/ghost/tab-cases.json"))[:3]:
        if left() < 90:
            break
        new_doc()
        typ(case["before"])
        s = wait(lambda: (lambda s: s if dig(s, "offer.kind") == "ghost" else None)(c.state()), 6)
        phrase = dig(s or {}, "offer.text")
        r = {"before": case["before"], "phrase": phrase}
        if phrase:
            key("tab")
            time.sleep(0.8)
            r["afterTab"] = ax("doc", Apps.textedit).get("value", "")
            r["wholePhrase"] = r["afterTab"] == case["before"] + phrase
            key("z", "cmd")
            time.sleep(0.8)
            r["afterUndo"] = ax("doc", Apps.textedit).get("value", "")
            r["undone"] = r["afterUndo"] == case["before"]
            time.sleep(4)
            key("z", "cmd")
            time.sleep(0.8)
            r["ownUndo"] = len(ax("doc", Apps.textedit).get("value", "")) < len(case["before"])
        tabs.append(r)
        key("w", "cmd")
        time.sleep(0.6)
        key("d", "cmd")
        time.sleep(0.6)
    st = c.state()
    row("ghost-tab", "ghost", offered=f"{sum(1 for r in tabs if r.get('phrase'))}/{len(tabs)}", right=f"{sum(1 for r in tabs if r.get('wholePhrase'))}/{len(tabs)}",
        acted=f"{sum(1 for r in tabs if 'afterTab' in r)}/{len(tabs)}", undone=f"{sum(1 for r in tabs if r.get('undone') and r.get('ownUndo'))}/{len(tabs)}",
        evidence=dump("ghost-tab", {"cases": tabs, "tap": st.get("tap"), "offers": st.get("offers")}),
        note="Tab takes the whole phrase (Q1 bug 17); one ⌘Z removes it and TextEdit's own undo still works (Q1 bug 5)")
    c.proc.terminate()
    c.proc.wait(10)


# ------------------------------------------------------------------------------------------------- H11 page tasks
# The repo's task pages (fixtures/web-form, F1) and their oracle, run by fixture/h11_site.ts with the bundle's Node. The
# pages are on 127.0.0.1 for the browser; the oracle answers only on a Unix socket (no page or extension can reach it).
FIX = f"{P}/fixture"
TASKS_PORT = 8770
TASKS = f"http://127.0.0.1:{TASKS_PORT}"
ORACLE_SOCK = "/tmp/h11-oracle.sock"
PAGE_PATH = {"wizard-1": "/tasks/wizard/1", "wizard-2": "/tasks/wizard/2", "reveal": "/tasks/reveal"}
ASK_PAGE = "fill out this form"
AT_FORM_LINE = "Preview at the form"  # AskCopy.atForm (AskCaret.swift)
PAGE_TASK_COUNTERS = ("started", "accepted", "continued", "nextPage", "putAway", "undo", "expired", "acceptRefused", "tabHeld",
                      "stopped", "publishRefused", "acceptUnsent", "controlUnsent")
# PageTaskMachine.undoLifetime: the ending's ⌘Z toast, and the panel, last 8 s after the goal ends; after that the task is
# cleared and neither ⌘Z nor a continuation reaches it. The harness presses ⌘Z by 6.5 s after the end it saw.
UNDO_BY_S = 6.5


class _UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("oracle.local", timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def ora(path, method="GET", timeout=12):
    """One oracle request: (value, None), or (None, why) when the route said no or the socket failed."""
    try:
        conn = _UnixHTTP(ORACLE_SOCK, timeout)
        conn.request(method, path)
        r = conn.getresponse()
        body = r.read()
        conn.close()
        v = json.loads(body or b"null")
    except (OSError, ValueError, http.client.HTTPException) as e:
        return None, f"oracle socket: {e}"
    if r.status != 200:
        return None, (v.get("error") if isinstance(v, dict) else str(v)) or f"status {r.status}"
    return v, None


def ctr(st, name):
    return int((st.get("counters") or {}).get(f"pageTask.{name}", 0) or 0)


def page_counters(c):
    st = c.state()
    return {n: ctr(st, n) for n in PAGE_TASK_COUNTERS}


def frontmost():
    return jrun([f"{T}/h10-ax", "front"], 10)


def browser_front():
    """The browser in front, so a real key reaches the page task's offer (PageTaskMachine.appActivated hides the panel and
    gives up its keys while another app is in front)."""
    if frontmost().get("pid") != Apps.cft:
        Apps.front(Apps.cft)
    return frontmost().get("pid") == Apps.cft


def oracle_summary(tag, page):
    s, err = ora("/summary")
    s = s or {"error": err}
    return {"tag": tag, "page": page, "submits": s.get("submits"), "strayPresses": s.get("strayPresses"), "harnessPresses": s.get("harnessPresses"),
            "probeErrors": s.get("probeErrors"), "error": s.get("error")}


def settled_values(page, quiet=1.2, most=6.0):
    """The page's values once they have not changed for `quiet` seconds (at most `most`). probe.js posts with fetch
    keepalive and a dropped post is not resent (F1 note), so a read can lag the DOM: the page shots are the check."""
    end = time.time() + most
    last, since = None, time.time()
    while time.time() < end:
        v, err = ora(f"/values?page={page}")
        if v != last:
            last, since = v, time.time()
        elif time.time() - since >= quiet:
            break
        time.sleep(0.25)
    return last


def goal_messages(c, t, gid=None):
    return [m for m in c.consumers.since(t, "goalProgress") if gid is None or m.get("goalId") == gid]


def goal_end(c, t, gid):
    return next((m for m in goal_messages(c, t, gid) if m.get("event") in ("finished", "stopped")), None)


def write_sources(exp, page):
    """The person's sources from tasks/expect/<page>.json as TextEdit documents: the note always; with sources "all", the
    email and the memory entries too (the guest's Caret has no memory store to hold them). Returns the file names."""
    src = exp["sources"]
    title = re.sub(r"[/:]", "-", src["note"].splitlines()[0]).strip()[:60] or f"{page} note"
    docs = [(f"{title}.txt", src["note"] + "\n")]
    if OPTIONS["sources"] == "all":
        e = src["email"]
        docs.append((f"Email from {e['from'].split('<')[0].strip()}.txt", f"From: {e['from']}\nTo: {e['to']}\nSubject: {e['subject']}\n\n{e['body']}\n"))
        docs.append(("Saved details.txt", "".join(f"{m['key']}: {m['value']}\n" for m in src["memory"])))
    for name, text in docs:
        with open(f"{DOCS}/{name}", "w") as f:
            f.write(text)
        SOURCE_WORDS[name] = name[:-4].lower()[:24]
    return [n for n, _ in docs], title


def open_task_page(page):
    """Opens the page (the first time by starting the browser, then in a new tab, as webmail_tab does) and waits until the
    oracle reads a load of it that is new (README, "Driving a journey")."""
    before = set(((ora(f"/loads?page={page}")[0]) or {}).get("loads", []))
    url = TASKS + PAGE_PATH[page]
    if Apps.cft is None:
        Apps.start_cft_url(url)
    else:
        subprocess.Popen([CFT, "--user-data-dir=/tmp/q2-cft", url], stdout=open(f"{O}/cft.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
    return bool(wait(lambda: any(x not in before for x in ((ora(f"/loads?page={page}")[0]) or {}).get("current", [])), 30, 0.5))


def bridge_row(c):
    if Apps.bridged:
        return
    Apps.bridged = True
    errtext = open(f"{O}/p-caret.err", errors="replace").read() if os.path.exists(f"{O}/p-caret.err") else ""
    bridge = re.findall(r".*(?:engine|bridge|browser requirement|not trusted|refus).*", errtext)[-8:]
    NOTES.append("page bridge lines in p-caret.err: " + " | ".join(x.strip()[:160] for x in bridge))
    ps = c.q("pagesight")
    dump("p-pagesight", ps)
    row("chrome-extension-bridge", "fill", offered="n/a", verified=yn(bool(re.search(r"open for bridge|engine .*open", errtext)) or bool(ps.get("engines") or ps.get("connected"))),
        evidence="scen/p-pagesight.json; p-caret.err", note=f"Caret for Chrome connected to the full-UI acceptance Caret through caret-bridge (9560c8a); pagesight keys={sorted(ps)[:8]}")


def caret_texts(c):
    """Best effort: the static texts of Caret's first Accessibility window (the panel is a non-activating panel, which
    may not be listed). Evidence for the hand-off row only; the helper's messages decide it."""
    return jrun([f"{T}/h10-ax", "texts", str(c.pid), ""], 15)


def run_page(c, page, sid, gid, t_ask, log):
    """Tab on the preview showing, then each continuation's Tab, until the goal and every continuation end. Returns the
    time the last end was seen (None if none) and the goal ids it ran. Every read and shot lands in `log`."""
    gids = [gid]
    end_at = None
    hidden = [k for k, r in (log["readingsAtLoad"] or {}).items() if not r.get("visible") and log["expected"].get(k, "none") != "none"]
    while True:
        k = len(gids)
        front = browser_front()
        before = page_counters(c)
        t_tab = time.time()
        if not front or not dig(c.q("pagetask"), "status.ownsTab"):
            log["tabs"].append({"why": "preview did not own Tab in the front browser; no key posted"})
            return end_at, gids
        key("tab")
        took = wait(lambda: (lambda n: n if n["accepted"] > before["accepted"] or n["tabHeld"] > before["tabHeld"] or n["acceptRefused"] > before["acceptRefused"] else None)(page_counters(c)), 6, 0.1)
        step = {"tab": k, "browserFront": front, "countersBefore": before, "countersAfterTab": took or page_counters(c), "lastClaim": dig(c.state(), "lastClaim")}
        log["tabs"].append(step)
        if not took or took["accepted"] <= before["accepted"]:
            step["why"] = "Tab was not taken as an acceptance"
            shot(f"{sid}-tab{k}-not-taken", [c.pid, Apps.cft])
            return end_at, gids
        shot(f"{sid}-tab{k}-running", [c.pid])
        end = wait(lambda: goal_end(c, t_ask, gids[-1]), 120, 0.3)
        end_at = time.time()
        step["end"] = end
        step["secondsToEnd"] = round(end_at - t_tab, 1)
        if not end:
            step["why"] = "no finished or stopped message for the goal within 120 s"
            return None, gids
        vals = settled_values(page, quiet=1.0, most=3.0)
        step["values"] = vals
        step["score"] = ora(f"/score?page={page}")[0]
        step["oracle"] = oracle_summary(f"tab{k}", page)
        shot(f"{sid}-tab{k}-ended", [c.pid, Apps.cft])
        readings = ora(f"/readings?page={page}")[0] or {}
        revealed_empty = [f for f in hidden if (readings.get(f) or {}).get("visible") and not (readings.get(f) or {}).get("value")]
        step["revealedEmpty"] = revealed_empty
        if not revealed_empty:
            return end_at, gids
        # A field this run revealed is still empty: its own preview may come (pageTask.continued), and must come before
        # the panel leaves (8 s after the end).
        cont = wait(lambda: page_counters(c)["continued"] > before["continued"], max(0.5, UNDO_BY_S - (time.time() - end_at)), 0.2)
        if not cont:
            step["continuation"] = f"none within {UNDO_BY_S} s of the end"
            return end_at, gids
        seg = next((m for m in reversed(goal_messages(c, t_ask)) if m.get("event") == "segment" and m.get("goalId") not in gids), None)
        step["continuation"] = seg
        shot(f"{sid}-tab{k}-continued-preview", [c.pid])
        if seg is None:
            step["why"] = "pageTask.continued went up but no new segment message was seen"
            return end_at, gids
        gids.append(seg["goalId"])


def undo_page(c, page, sid, base, end_at, log):
    """⌘Z while the ending's toast holds it; then every field the run wrote must be back to what the page started with."""
    after = settled_values(page, quiet=0.8, most=2.0) or {}
    written = sorted(k for k in after if after.get(k) != (base or {}).get(k))
    since_end = time.time() - end_at
    res = {"written": written, "secondsAfterEnd": round(since_end, 1)}
    if since_end > UNDO_BY_S:
        res["why"] = f"⌘Z not pressed: {since_end:.1f} s after the end, past {UNDO_BY_S} s (the toast lasts 8 s)"
        log["undo"] = res
        return None, res
    before = page_counters(c)
    res["browserFront"] = browser_front()
    key("z", "cmd")
    res["undoCounted"] = bool(wait(lambda: page_counters(c)["undo"] > before["undo"], 3, 0.1))
    restored = wait(lambda: (lambda v: v if v is not None and all(v.get(k) == (base or {}).get(k) for k in written) else None)(ora(f"/values?page={page}")[0]), 8, 0.4)
    res["valuesAfter"] = restored or ora(f"/values?page={page}")[0]
    res["notRestored"] = sorted(k for k in written if (res["valuesAfter"] or {}).get(k) != (base or {}).get(k))
    res["progress"] = [m for m in c.consumers.since(end_at - 1, "taskProgress") if m.get("phase") == "undone"]
    time.sleep(0.6)
    shot(f"{sid}-undone", [c.pid, Apps.cft])
    log["undo"] = res
    return bool(written) and bool(restored), res


def shots_taken(prefix):
    return sorted(e.name for e in os.scandir(f"{O}/shots") if e.name.startswith(prefix))


def segments(c, t):
    return [m for m in goal_messages(c, t) if m.get("event") == "segment"]


def score_cols(sc):
    sc = sc or {}
    return {k: len(sc.get(k) or []) for k in ("right", "wrong", "missed", "leftAlone", "absent")}


def page_task(c, page):
    """H11 acceptance 3 on one task page: the desk's Ask "fill out this form from my note" comes back as a preview at the
    form (desk: "Preview at the form"), real Tab fills, a revealed field's own preview takes a second Tab, read back by
    the oracle against tasks/expect/<page>.json (wrong = 0), ⌘Z empties what the run wrote, and nothing is submitted.
    The browser task panel's next page waits for P3 (H11_NEXT_PAGE)."""
    sid = f"h11-{page}"
    say(f"== page_task {page}")
    exp, err = ora(f"/expect?page={page}")
    if exp is None:
        row(f"{sid}-ask-at-form", "pagetask", offered="no", note=f"no expectation from the oracle: {err}")
        return
    names, title = write_sources(exp, page)
    [run(["kill", "-TERM", str(pid)], 15) for pid in pgrep("TextEdit")]
    wait(lambda: not pgrep("TextEdit"), 10, 0.5)
    run(["open", "-a", "TextEdit", *[f"{DOCS}/{n}" for n in names]])
    Apps.textedit = wait(lambda: (pgrep("TextEdit") or [None])[0], 15)
    time.sleep(1.5)
    if Apps.textedit:
        ax("setframe", Apps.textedit, 0, 30, 470, 330)
    loaded = open_task_page(page)
    bridge_row(c)
    log = {"page": page, "sources": names, "options": OPTIONS, "expected": exp["expected"], "loaded": loaded, "tabs": [],
           "readingsAtLoad": ora(f"/readings?page={page}")[0], "baseline": ora(f"/baseline?page={page}")[0]}
    ev = lambda: dump(sid, log)  # noqa: E731 - the one evidence file per page, rewritten as the run goes
    if not loaded:
        row(f"{sid}-ask-at-form", "pagetask", offered="no", evidence=ev(), note=f"{TASKS}{PAGE_PATH[page]} never reported a new load to the oracle")
        return
    log["oracle"] = [oracle_summary("load", page)]
    # Into the first field: the page's first focusable element is its first field, and no offer owns Tab yet.
    browser_front()
    key("tab")
    time.sleep(1.5)
    log["focusAfterTab"] = dig(c.state(), "focus")
    shot(f"{sid}-page-loaded", [Apps.cft])

    c0 = page_counters(c)
    t = time.time()
    menu, opened = open_desk(c)
    if not opened:
        row(f"{sid}-ask-at-form", "pagetask", offered="no", evidence=ev(), note=f"desk did not open: {menu}")
        return
    typ(ASK_PAGE)
    key("return")
    a = wait(lambda: (lambda r: r if r.get("phase") in ("atForm", "proposed", "failed", "ended", "question") else None)(c.ask()), 90, 0.3) or c.ask()
    questions = []
    while a.get("phase") == "question" and len(questions) < 2:
        qid = dig(a, "question.questionId") or json.dumps(a.get("question"), sort_keys=True)
        questions.append(answer_question(a, {}, page, names))
        a = wait(lambda: (lambda r: r if r.get("phase") in ("atForm", "proposed", "failed", "ended") or (r.get("phase") == "question" and (dig(r, "question.questionId") or json.dumps(r.get("question"), sort_keys=True)) != qid) else None)(c.ask()), 60, 0.3) or c.ask()
    started = wait(lambda: page_counters(c)["started"] > c0["started"], 10, 0.2)
    shot(f"{sid}-panel-preview", [c.pid])
    shot(f"{sid}-page-preview", [Apps.cft])
    segs = segments(c, t)
    first = segs[0] if segs else None
    log.update({"instruction": ASK_PAGE, "ask": a, "questions": questions, "countersBefore": c0, "segments": segs, "spendAtPreview": spend()})
    at_form = a.get("phase") == "atForm"
    row(f"{sid}-ask-at-form", "pagetask", offered=yn(opened), right=yn(at_form and a.get("line") == AT_FORM_LINE), acted=yn(bool(started)),
        evidence=f"{ev()}; shots/{sid}-panel-preview-*",
        note=f"desk phase={a.get('phase')} line={a.get('line')!r} (want atForm, {AT_FORM_LINE!r}); pageTask.started +{page_counters(c)['started'] - c0['started']}; questions={[q['part'] for q in questions]}; segments={len(segs)}")
    if not started or first is None:
        for rid in ("tab", "reveal", "undo") + (("next-page",) if page == "wizard-1" else ()):
            row(f"{sid}-{rid}", "pagetask", note=f"not run: no page task started (desk phase {a.get('phase')}, segments {len(segs)})")
        handoff_row(c, page, sid, segs, ev)
        row(f"{sid}-counters", "debug", evidence=ev(), note="pageTask counters this page: " + ", ".join(f"{k} +{v - c0[k]}" for k, v in page_counters(c).items()))
        key("escape")
        return

    view = first.get("page") or {}
    rows_seen = [(r.get("label"), r.get("value"), r.get("picked")) for r in view.get("rows") or []]
    row(f"{sid}-panel-preview", "pagetask", offered="yes", verified=yn(bool(shots_taken(f"{sid}-panel-preview-"))),
        evidence=f"shots/{sid}-panel-preview-*; {ev()}",
        note=f"Caret's windows captured by number (light, as the guest has it); from={view.get('from')!r}; rows={rows_seen}; warnings={first.get('warnings')}; attach={view.get('attach')}")

    base = log["baseline"] or settled_values(page)
    end_at, gids = run_page(c, page, sid, first["goalId"], t, log)
    tabs = log["tabs"]
    t1 = tabs[0] if tabs else {}
    sc1 = score_cols(t1.get("score"))
    row(f"{sid}-tab", "pagetask", offered="yes", right=yn(sc1["wrong"] == 0 and sc1["right"] > 0), acted=yn("end" in t1),
        verified=yn(bool(t1.get("end")) and sc1["wrong"] == 0 and sc1["missed"] == 0), wrong=yn(sc1["wrong"] > 0), evidence=f"{ev()}; shots/{sid}-tab1-*",
        note=f"Tab 1: {t1.get('why') or ''} end={(t1.get('end') or {}).get('event')}/{(t1.get('end') or {}).get('outcome')} in {t1.get('secondsToEnd')} s; score {sc1}; "
             f"wrong={(t1.get('score') or {}).get('wrong')} missed={(t1.get('score') or {}).get('missed')} absent={(t1.get('score') or {}).get('absent')}")
    if len(tabs) > 1:
        last = tabs[-1]
        scn = score_cols(last.get("score"))
        revealed = tabs[0].get("revealedEmpty") or []
        right_now = (last.get("score") or {}).get("right") or []
        row(f"{sid}-reveal", "pagetask", offered="yes", right=yn(scn["wrong"] == 0), acted=yn("end" in last),
            verified=yn(bool(last.get("end")) and scn["wrong"] == 0 and all(f in right_now for f in revealed)),
            wrong=yn(scn["wrong"] > 0), evidence=f"{ev()}; shots/{sid}-tab1-continued-preview-*, shots/{sid}-tab2-*",
            note=f"pageTask.continued went up; revealed and empty after Tab 1: {tabs[0].get('revealedEmpty')}; after Tab {len(tabs)}: score {scn}, wrong={(last.get('score') or {}).get('wrong')}")
    else:
        why = t1.get("continuation") or ("no field this run revealed was left empty" if not t1.get("revealedEmpty") else "")
        late = [m.get("goalId") for m in goal_messages(c, t) if m.get("event") == "segment" and m.get("reason") == "afterReveal"]
        row(f"{sid}-reveal", "pagetask", offered=yn(bool(late)), acted="no", verified="n/a" if not t1.get("revealedEmpty") else "no", evidence=ev(),
            note=f"no continuation taken: {why}; revealed and empty after Tab 1: {t1.get('revealedEmpty')}; afterReveal segments seen at any time: {late}")

    wizard_next = OPTIONS["nextPage"] and page == "wizard-1"
    if not end_at:
        row(f"{sid}-undo", "pagetask", note="not run: the goal never ended")
    elif wizard_next:
        row(f"{sid}-undo", "pagetask", note="not run: H11_NEXT_PAGE=1 pressed Next first (the undo is checked on wizard-2)")
    else:
        ok, res = undo_page(c, page, sid, base, end_at, log)
        row(f"{sid}-undo", "pagetask", acted=yn(res.get("undoCounted")), undone=yn(ok) if ok is not None else "n/a", evidence=f"{ev()}; shots/{sid}-undone-*",
            note=res.get("why") or f"⌘Z {res['secondsAfterEnd']} s after the end; pageTask.undo counted={res.get('undoCounted')}; written={res['written']}; not restored={res.get('notRestored')} "
                                    f"(the oracle can lag the DOM: check shots/{sid}-undone-*)")
    # Before the Next press, so the hand-off row reads page 1's panel.
    handoff_row(c, page, sid, segments(c, t), ev)
    if page == "wizard-1":
        if not OPTIONS["nextPage"]:
            row(f"{sid}-next-page", "pagetask", note="not run: waits for P3 (set H11_NEXT_PAGE=1 when P3 lands)")
        elif not end_at:
            row(f"{sid}-next-page", "pagetask", note="not run: page 1's goal never ended")
        else:
            next_page(c, sid, end_at, t, log)
    summ = oracle_summary("final", page)
    log["oracle"].append(summ)
    every = log["oracle"] + [tb.get("oracle") for tb in tabs if tb.get("oracle")]
    row(f"{sid}-no-submit", "pagetask", verified=yn(all(o.get("submits") == 0 and not o.get("strayPresses") for o in every if not o.get("error"))),
        wrong=yn(any((o.get("submits") or 0) > 0 or o.get("strayPresses") for o in every)), evidence=ev(),
        note=f"submits and stray presses at each read: {[(o['tag'], o.get('submits'), len(o.get('strayPresses') or []), o.get('error')) for o in every]}; probe errors {summ.get('probeErrors')}")
    final = page_counters(c)
    log["countersAfter"] = final
    row(f"{sid}-counters", "debug", verified=yn(final["expired"] == c0["expired"] and final["acceptRefused"] == c0["acceptRefused"] and final["tabHeld"] == c0["tabHeld"]),
        evidence=ev(), note="pageTask counters this page: " + ", ".join(f"{k} +{final[k] - c0[k]}" for k in PAGE_TASK_COUNTERS) + f"; spend ${spend():.4f}")
    ev()
    # Leave the page task to time out, and the desk closed, before the next page.
    for _ in range(3):
        if not c.perch().get("listOpen"):
            break
        key("escape")
        time.sleep(0.4)
    time.sleep(8.5)


def handoff_row(c, page, sid, segs, ev):
    """"You press Next": the panel shows the user's own step only when the helper sends one (a handoff or press step,
    GoalWire Step.Kind); expected absent until P3. The harness never presses anything for Caret here."""
    steps = [st for m in segs for st in (m.get("steps") or []) if st.get("kind") in ("handoff", "press")]
    texts = caret_texts(c)
    said = [x for x in texts.get("texts", []) if re.search(r"\bpress\b|\bNext\b", x)]
    row(f"{sid}-you-press-next", "pagetask", offered=yn(bool(steps)), verified="n/a", evidence=dump(f"{sid}-handoff", {"steps": steps, "caretTexts": texts}),
        note=f"hand-off steps from the helper: {[s.get('says') for s in steps]}; Caret's Accessibility texts naming a press: {said} (expected absent until P3)")


def next_page(c, sid, end_at, t, log):
    """P3 only (H11_NEXT_PAGE=1): the harness's own Next press (the oracle's harnessPress, the only sanctioned press),
    then the goal's preview on wizard-2 (pageTask.nextPage), Tab, read back against wizard-2.json, ⌘Z."""
    page = "wizard-2"
    nid = f"h11-{page}"
    before = page_counters(c)
    loads_before = set(((ora(f"/loads?page={page}")[0]) or {}).get("loads", []))
    t_press = time.time()
    press, err = ora("/press?page=wizard-1&target=next", method="POST")
    log["nextPress"] = {"press": press, "error": err, "secondsAfterEnd": round(time.time() - end_at, 1)}
    loaded = bool(wait(lambda: any(x not in loads_before for x in ((ora(f"/loads?page={page}")[0]) or {}).get("current", [])), 15, 0.4))
    came = wait(lambda: page_counters(c)["nextPage"] > before["nextPage"], 60, 0.3)
    shot(f"{nid}-panel-next", [c.pid, Apps.cft])
    if not came:
        row(f"{sid}-next-page", "pagetask", offered="no", evidence=dump(nid, log),
            note=f"harness pressed Next ({err or 'pressed'}); wizard-2 loaded={loaded}; pageTask.nextPage never went up within 60 s")
        return
    exp, _ = ora(f"/expect?page={page}")
    sub = {"page": page, "expected": (exp or {}).get("expected", {}), "tabs": [], "readingsAtLoad": ora(f"/readings?page={page}")[0],
           "baseline": ora(f"/baseline?page={page}")[0], "oracle": []}
    log["wizard2"] = sub
    # The newest segment since the press: P3 may name it nextPage, or send it as the goal's next segment.
    seg = next((m for m in reversed(segments(c, t_press))), None)
    if seg is None:
        row(f"{sid}-next-page", "pagetask", offered="yes", evidence=dump(nid, log), note="pageTask.nextPage went up but no segment message came after the press")
        return
    end2, _ = run_page(c, page, nid, seg["goalId"], t, sub)
    tb = sub["tabs"][-1] if sub["tabs"] else {}
    scn = score_cols(tb.get("score"))
    row(f"{sid}-next-page", "pagetask", offered="yes", right=yn(scn["wrong"] == 0), acted=yn("end" in tb), verified=yn(bool(tb.get("end")) and scn["wrong"] == 0 and scn["missed"] == 0),
        wrong=yn(scn["wrong"] > 0), evidence=f"{dump(nid, log)}; shots/{nid}-*", note=f"wizard-2 after Tab: score {scn}; wrong={(tb.get('score') or {}).get('wrong')}")
    if end2:
        ok, res = undo_page(c, page, nid, sub["baseline"], end2, sub)
        row(f"{nid}-undo", "pagetask", acted=yn(res.get("undoCounted")), undone=yn(ok) if ok is not None else "n/a", evidence=f"{dump(nid, log)}; shots/{nid}-undone-*",
            note=res.get("why") or f"written={res['written']}; not restored={res.get('notRestored')}")
    sub["oracle"].append(oracle_summary("final", page))
    dump(nid, log)


# ------------------------------------------------------------------------------------------------- main
def main():
    os.makedirs(DOCS, exist_ok=True)
    run(["cp", *[f"{P}/docs/{f}" for f in os.listdir(f"{P}/docs")], DOCS])
    say("rev", open(f"{P}/REV").read().strip(), "config", CONFIG, "env file", "set" if ENV_FILE and os.path.exists(ENV_FILE) else "MISSING")
    if not (ENV_FILE and os.path.exists(ENV_FILE)):
        NOTES.append("no env file: the helper runs without Jev; this run is not live")
    if "h10" in OPTIONS["scenarios"]:
        Apps.start_site()
    if "page_task" in OPTIONS["scenarios"]:
        NOTES.append(f"task pages and oracle (fixture/h11_site.ts): {'up' if Apps.start_task_site() else 'NEVER ANSWERED; see tasks-site.log'}")
    try:
        phase_p()
    except Exception as e:  # noqa: BLE001
        say(f"phase P crashed: {e!r}")
        NOTES.append(f"harness: phase P crashed: {e!r}")
    final_spend = spend()
    CURRENT["caret"] = None
    run(["launchctl", "bootout", f"gui/{UID}/dev.caret.host"])
    if Apps.cft:
        try:
            os.kill(Apps.cft, signal.SIGTERM)
        except OSError:
            pass
    if Apps.tasks is not None:
        Apps.tasks.terminate()
    NOTES.append(f"H11 options {json.dumps(OPTIONS)} (phases C and G, native fill, event, writing, stop and surfaces not run)")
    err = open(f"{O}/p-caret.err", errors="replace").read() if os.path.exists(f"{O}/p-caret.err") else ""
    for l in [x for x in err.splitlines() if "fill recheck" in x]:
        NOTES.append("helper: " + l.strip()[:600])
    with open(f"{O}/results.json", "w") as f:
        json.dump({"rev": open(f"{P}/REV").read().strip(), "config": CONFIG, "options": OPTIONS, "rows": ROWS,
                   "q1Bugs": bug_status() if "h10" in OPTIONS["scenarios"] else None, "esc": ESC, "notes": NOTES,
                   "spendUsd": round(final_spend, 5), "spendLedger": SPEND["last"], "spendSource": "state.spend" if SPEND["last"] else "costUsd on the helper socket (lower bound)",
                   "seconds": int(time.time() - T0)}, f, indent=1)
    scoreboard(os.environ.get("Q2_PREVIEW") == "1")
    say("done", len(ROWS), "rows; spend", f"${final_spend:.4f}")


def get(rid):
    return next((r for r in ROWS if r["id"] == rid), None)


def bug_status():
    """Q1's 19 bugs against this run's rows: fixed, still broken, or not covered (with the row that decides)."""
    def yes(rid, col):
        r = get(rid)
        return None if r is None or r[col] in ("n/a", "?") else r[col] == "yes"

    def frac(rid, col):
        r = get(rid)
        if not r or "/" not in str(r[col]):
            return None
        a, b = str(r[col]).split("/")
        return int(a), int(b)

    def st(v):
        return "not covered" if v is None else ("fixed" if v else "still broken")

    q1 = [get(f"ask-q1-{i:02d}") for i in range(1, 11)]
    q1r = [r for r in q1 if r]
    right = sum(r["right"] == "yes" for r in q1r)
    fills = [yes(x, "verified") for x in ("fill-1a-web-note-first", "fill-1b-web-note-email", "fill-2a-web-mail-first", "fill-2b-web-mail-email")]
    mid, tab = frac("ghost-mid-sentence", "right"), frac("ghost-tab", "right")
    und = frac("ghost-tab", "undone")
    failed = [e for e in ESC.values() if e["phase"] == "failed"]
    titles = [e["title"] for e in ESC.values() if e.get("title")]
    out = [
        (1, "fill from another window never fired", st(None if all(f is None for f in fills) else any(fills)), "fill-1*, fill-2*"),
        (2, "action line held (noClearSpot) in a text editor", st(yes("surface-full-window-doc", "verified")), "surface-full-window-doc"),
        (3, "Ask fails natural instructions", "not covered" if not q1r else f"{'fixed' if right >= 8 else 'still broken' if right <= 3 else 'partly'} ({right}/{len(q1r)} right)", "ask-q1-*"),
        (4, "Ask writes a sentence fragment into date fields", st(None if not get("ask-q1-09") else get("ask-q1-09")["wrong"] == "no"), "ask-q1-09"),
        (5, "⌘Z after a ghost Tab does nothing and kills TextEdit's undo", st(None if not und or not und[1] else und[0] == und[1]), "ghost-tab (recorded model)"),
        (6, "mid-sentence ghost text ignores the text after the caret", st(None if not mid or not mid[1] else mid[0] == mid[1]), "ghost-mid-sentence (recorded model)"),
        (7, "ghost copies the line above", st(None if not mid or not mid[1] else mid[0] == mid[1]), "ghost-mid-sentence case 9 (recorded model)"),
        (8, "⌘Z after an Ask run does nothing", st(yes("ask-q1-06", "undone")), "ask-q1-06"),
        (9, "a time zone silently drops the event", st(yes("event-zone", "offered")), "event-zone (offered, or a line saying why: read its note)"),
        (10, "selects, radios, checkboxes, files never in a proposal", "see note" if get("fill-4-fill-all") else "not covered", "fill-4-fill-all note (hand-off rows by design)"),
        (11, "a full name is never split into First and Last", st(None if not get("ask-q1-07") else "'lastname': True" in get("ask-q1-07")["note"]), "ask-q1-07"),
        (12, "noFieldAtFocus after focus moves", st(yes("fill-1b-web-note-email", "offered")), "fill-1b-web-note-email"),
        (13, "Ask panel opens in a far corner", st(yes("surface-desk-near-window", "verified")), "surface-desk-near-window"),
        (14, "two Escs to clear a failed ask", st(None if not failed else all(not e["afterOne"].get("text") for e in failed)), "ESC in results.json"),
        (15, "first Ask Caret… press does nothing", st(yes("surface-desk-near-window", "offered")), "surface-desk-near-window"),
        (16, "plan card titles carry the asterisk", st(None if not titles else not any("*" in t for t in titles)), "ask-* titles"),
        (17, "Tab takes one word", st(None if not tab or not tab[1] else tab[0] == tab[1]), "ghost-tab (recorded model)"),
        (18, "debug counters stay 0", st(yes("bug18-counters", "verified")), "bug18-counters"),
        (19, "AXManualAccessibility -25205 on Chrome", st(yes("bug19-chrome-ax", "verified")), "bug19-chrome-ax"),
    ]
    return [{"bug": n, "what": w, "status": s_, "decided by": d} for n, w, s_, d in out]


def scoreboard(preview):
    cols = ["id", "offered", "right", "acted", "verified", "undone", "stopped", "wrong", "evidence"]
    lines = [f"# H11 page task scoreboard (Q2 harness){' (PREVIEW: harness dry run, not the verdict)' if preview else ''}", "",
             f"Build {open(f'{P}/REV').read().strip()}, configuration {CONFIG} (routing {'on' if CONFIG == 'on' else 'off'}). Model spend ${(SPEND['last'] and spend()) or 0:.4f} ({'state.spend' if SPEND['last'] else 'no ledger read'}). "
             f"{int(time.time() - T0)} s.", "", "| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in ROWS:
        lines.append("| " + " | ".join(str(r[c]).replace("|", "/") for c in cols) + " |")
    if "h10" in OPTIONS["scenarios"]:
        lines += ["", "## Q1 bugs", "", "| # | bug | status | decided by |", "|---|---|---|---|"]
        lines += [f"| {b['bug']} | {b['what']} | {b['status']} | {b['decided by']} |" for b in bug_status()]
    lines += ["", "## Notes per row", ""] + [f"- {r['id']}: {r['note']}" for r in ROWS] + ["", "## Run notes", ""] + [f"- {n}" for n in NOTES]
    with open(f"{O}/scoreboard.md", "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
