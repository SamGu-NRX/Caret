#!/usr/bin/env python3
"""Onboarding's know step to a filled form, with a real helper and a real Tab (brief A14, part 2).

  /usr/bin/lockf -k ~/.long-run/locks/gui.lock memory_fill_walk.py <out_dir>

What it proves: a name and an email typed on onboarding's know step are kept by the helper (memory
`add`); on a fresh form the helper proposes them per field, the host offers each with the line "from
what you told Caret", and a real Tab writes it with no source window to recheck. Forget in the memory
book removes both, and another fresh form gets no offer.

Starts, and stops on exit, only what it records: the helper (live Jev, its own socket and data dir),
two CaretFixture.app processes with one Claim form each (A is filled, B is the form after Forget), the
reader limited to those pids, and the host on its own settings file with test hooks, onboarding
hidden, no perch, no status item and no ghost text. Onboarding and the memory book are driven through
the host's debug socket; focus moves by AXFocused writes (fixture-ax). Each Tab is a real key through
the host's event tap (fixture-ax key-if-front), sent only while the fixture is frontmost by both
NSWorkspace and LaunchServices.

Gates: the gui lease, gui.lock held by the caller, no quiet window, and 300 s without input before the
first key. A watchdog stops the run on any input that is not the run's own key; later keys need no
input since the run's last one. The foreground goes back to the app that had it.

The typed values are invented ("Sam Rivera"); nothing here reads or writes the user's memory.
"""
import json
import os
import subprocess
import sys
import time

import fill_acceptance as fa
import fixture_app

SOCKETS = os.path.expanduser("~/.caret-run/sockets")
fa.HELPER_SOCK = os.path.join(SOCKETS, "a14-memory-helper.sock")
fa.HOST_SOCK = os.path.join(SOCKETS, "a14-memory-host.sock")
CLAIM = fa.CLAIM
NAME, EMAIL = "Sam Rivera", "sam.rivera@example.com"
CAPTION = "from what you told Caret"
IDLE_MIN = float(os.environ.get("CARET_REALTAB_IDLE_MIN", "300"))

checks = []
result = {"checks": checks}


def check(name, ok, **detail):
    checks.append({"check": name, "ok": bool(ok), **detail})
    fa.log("PASS" if ok else "FAIL", name, json.dumps(detail, default=str)[:400])
    return ok


def may_press():
    """None when a real key may go now: the gates hold, and the last input is old enough or was this
    run's own key."""
    if not fixture_app.gui_lock_held():
        return "refused: run under lockf -k ~/.long-run/locks/gui.lock"
    if fixture_app.quiet_now():
        return "deferred: quiet window"
    idle = fixture_app.hid_idle_seconds()
    last = time.time() - idle
    if idle < IDLE_MIN and not any(a - 0.2 <= last <= b for a, b in fa.SYNTHETIC):
        return f"deferred: user active (idle {idle:.0f} s)"
    return None


def fixture(out_dir, name):
    gold = os.path.join(out_dir, f"gold-{name}.json")
    proc = fa.start(f"fixture-{name}", fixture_app.args("--windows", "claim", "--gold", gold, "--duration", "900"),
                    out_dir, stdin=subprocess.PIPE)
    fa.wait_for(lambda: os.path.exists(gold), 10, 0.1)
    return proc, gold


def ax_frames(pids, pid, gold_path):
    """Full name and Email, by their Accessibility frames (1 pt larger than the view frames)."""
    time.sleep(0.5)
    with open(gold_path) as f:
        fields = json.load(f)["forms"][0]["fields"]
    live = fa.ax(pids, "fields", pid)
    out = {}
    for field in fields[:2]:
        match = [f["frame"] for f in live if f["window"] == CLAIM and all(abs(a - b) <= 2 for a, b in zip(f["frame"], field["frame"]))]
        out[field["label"]] = match[0] if match else field["frame"]
    return out


def phone_frame(pids, pid, gold_path):
    """Phone, a field neither value fits, by its Accessibility frame."""
    with open(gold_path) as f:
        field = json.load(f)["forms"][0]["fields"][2]
    live = [f["frame"] for f in fa.ax(pids, "fields", pid)
            if f["window"] == CLAIM and all(abs(a - b) <= 2 for a, b in zip(f["frame"], field["frame"]))]
    return live[0] if live else field["frame"]


# CARET_A14_TAB=hook (A17): each Tab goes through the host's debug socket (`key tab <pid>`, the tap's
# own routing, no event posted anywhere) instead of a HID key. Since 2026-10-04 HID input may be
# posted only in the rig VM, which cannot hold the Jev key this walk needs, so on Sam's desktop the
# walk runs this way; the event tap's own delivery is checked by the VM runs.
TAB_HOOK = os.environ.get("CARET_A14_TAB") == "hook"
# Whether the hook's last Tab was taken by the host. A hook Tab is not an event, so the event tap's
# own consumed counter does not move for it.
HOOK_TAKEN = {"last": None}


def tab(pids, pid):
    """One Tab into the frontmost fixture: a real key, or the host's hook (TAB_HOOK). Returns the
    claim's insertion, or None."""
    why = may_press()
    if why:
        raise SystemExit(why)
    before = fa.host().get("lastClaim") or {}
    if TAB_HOOK:
        HOOK_TAKEN["last"] = fa.host(f"key tab {pid}").get("consumed")
    else:
        env = dict(os.environ, CARET_TEST_PIDS=",".join(map(str, pids)))
        # The run's own key resets HID idle; only the second the send takes is excused, not more.
        fa.expect_synthetic(1)
        sent = subprocess.run([fa.AX, "key-if-front", str(pid), "tab"], capture_output=True, text=True, env=env)
        if sent.returncode != 0:
            raise SystemExit("deferred: foreground (" + (sent.stdout + sent.stderr).strip()[:200] + ")")
    claim = fa.wait_for(lambda: (lambda c: c if c and c.get("claimID") != before.get("claimID") else None)(fa.host().get("lastClaim")), 2)
    if not claim:
        return None
    return fa.wait_for(lambda: (lambda s: s["lastInsertion"] if (s.get("lastInsertion") or {}).get("claimID") == claim["claimID"] else None)(fa.host()), 5)


def walk(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    why = fixture_app.why_not_foreground(IDLE_MIN)
    if why:
        result["status"] = why
        return
    for path in (fa.HELPER_SOCK, fa.HOST_SOCK):
        if os.path.exists(path):
            raise SystemExit(f"{path} exists; another run may be live")

    fa.start_with_secret("helper", ["node", "src/main.ts", "--auth-fd", "0", "--socket", fa.HELPER_SOCK, "--data-dir", os.path.join(out_dir, "helper-data"),
                                    "--allow-background-focus"], out_dir, env=dict(os.environ, CARET_ENV_FILE=fa.ENV_FILE), cwd=fa.HELPER_DIR)
    if not fa.wait_for(lambda: os.path.exists(fa.HELPER_SOCK), 10, 0.1):
        raise SystemExit("helper did not open its socket")
    fa.record_proposals(os.path.join(out_dir, "proposals.ndjson"))
    fx_a, gold_a = fixture(out_dir, "a")
    fx_b, gold_b = fixture(out_dir, "b")
    pids = [fx_a.pid, fx_b.pid]
    frames = {fx_a.pid: ax_frames(pids, fx_a.pid, gold_a), fx_b.pid: ax_frames(pids, fx_b.pid, gold_b)}
    pid_list = ",".join(map(str, pids))
    reader_at = time.time()
    fa.start_with_secret("reader", [os.path.join(fa.SCREEN_BIN, "caret-screen"), "--auth-fd", "0", "--socket", fa.HELPER_SOCK, "--only-pids", pid_list,
                                    "--event-pids", pid_list], out_dir)
    fa.start_caret("host", [fa.CARET, "--socket", fa.HOST_SOCK, "--helper-socket", fa.HELPER_SOCK, "--allow-pids", pid_list,
                            "--settings", os.path.join(out_dir, "settings.json"), "--onboarding", "hidden", "--test-hooks",
                            "--status-item", "off", "--perch", "hidden", "--no-ghost"], out_dir,
                   env=dict(os.environ, CARET_FILL_ADVANCE="off"))
    if not fa.wait_for(lambda: os.path.exists(fa.HOST_SOCK), 15, 0.1):
        raise SystemExit("host did not open its socket")
    if not fa.wait_for(lambda: fa.host().get("helper", {}).get("connected"), 15, 0.2):
        raise SystemExit("host never connected to the helper")
    time.sleep(4)  # the reader's first walk of every window

    # 1. Onboarding's know step, typed and kept.
    ob = lambda c: fa.host("onboarding " + c)
    ob("next")
    know = fa.wait_for(lambda: (lambda r: r if r.get("showsKnow") else None)(fa.host("onboarding")), 5, 0.1)
    check("the helper's memory list names add, so the know step is in the flow", know is not None, onboarding=fa.host("onboarding"))
    r = ob("next")
    if not check("Continue from the work screen reaches the know step", r.get("step") == "know", step=r.get("step")):
        return
    ob(f"about name {NAME}")
    ob(f"about email {EMAIL}")
    r = ob("next")
    check("Continue from the know step moves on", r.get("step") == "permissions", step=r.get("step"))

    def about():
        fa.host("memory list")
        time.sleep(0.2)
        return [e for e in fa.host("memory")["book"]["entries"] if e["kind"] == "about"]
    kept = fa.wait_for(lambda: (lambda a: a if len(a) >= 2 else None)(about()), 8, 0.3) or about()
    typed = fa.host("memory")["book"]["typed"]
    check("the typed name and email are kept by the helper as About entries, and nothing waits on the host",
          len(kept) == 2 and any(NAME in e["says"] for e in kept) and any(EMAIL in e["says"] for e in kept) and typed == [],
          entries=[{"id": e["id"], "says": e["says"]} for e in kept], typed=typed)

    # 2. A fresh form fills from them with a real Tab. The helper asks about a form at most once per
    # 30 s (helper.ts FILL_REPEAT_MS), and the reader's first walk may already have asked about A's
    # focused Full name, before anything was typed (walk-4: no proposal for 20 s). So A is focused
    # only once that has passed.
    time.sleep(max(0.0, reader_at + 40 - time.time()))
    previous = fa.ax(pids, "frontmost").get("pid")
    fa.BEFORE_STOP.append(lambda: fixture_app.hand_back(fx_b, previous))
    fa.BEFORE_STOP.append(lambda: fixture_app.hand_back(fx_a, previous))
    result["previousFront"] = previous
    ok, front = fixture_app.activate(fx_a, lambda: fa.ax(pids, "frontmost"))
    if not check("form A takes the foreground", ok, frontmost=front):
        result["status"] = "deferred: foreground"
        return
    fa.ax(pids, "key-window", fx_a.pid, CLAIM)
    # Full name may already hold focus from launch, and focusing it again posts no focus change, so
    # nothing would ask the helper (walk-6). Phone first makes the move to Full name a real one.
    fa.ax(pids, "focus", fx_a.pid, fa.frame_arg(phone_frame(pids, fx_a.pid, gold_a)))
    time.sleep(0.5)
    last_offer = 0
    for label, want in (("Full name", NAME), ("Email", EMAIL)):
        frame = frames[fx_a.pid][label]
        before = fa.host()["helper"]["proposals"]
        focus_at = fa.ax(pids, "focus", fx_a.pid, fa.frame_arg(frame))["atMs"] / 1000
        offer = fa.wait_for(lambda: fa.fill_offer(fx_a.pid, last_offer), 20, 0.05)
        shown_at = time.time()
        if not check(f"A {label}: offered from what you told Caret",
                     offer is not None and offer["text"] == want and offer["fill"]["source"] == CAPTION,
                     offer=offer, lastSkip=fa.host()["fill"].get("lastSkip"), newProposals=fa.host()["helper"]["proposals"] - before):
            continue
        last_offer = offer["id"]
        result.setdefault("focusToOfferMs", []).append(round((shown_at - focus_at) * 1000, 1))
        time.sleep(0.25)  # the line's entrance
        result.setdefault("shots", []).append(fa.shot(out_dir, fx_a.pid, CLAIM, f"a-{label.split()[0].lower()}-offer"))
        tap_before = fa.host()["tap"]["consumed"]
        ins = tab(pids, fx_a.pid)
        value = fa.ax(pids, "value", fx_a.pid, fa.frame_arg(frame))["value"]
        check(f"A {label}: a real Tab writes it, with no source window to recheck",
              ins is not None and ins.get("ok") and value == want
              and (HOOK_TAKEN["last"] is True if TAB_HOOK else fa.host()["tap"]["consumed"] == tap_before + 1),
              insertion=ins, value=value)
        time.sleep(0.3)
        toast = fa.host()["fill"].get("toast") or {}
        check(f"A {label}: the toast names what you told Caret", toast.get("caption") == f"Filled 1 field {CAPTION}", toast=toast)

    # The filled form shows both values, and a window that shows them is a fair source for the next
    # form (walk-3 offered A's Full name to B "from Caret Fixture, Claim form"). So A's two fields
    # are emptied first, and only memory could offer them.
    for label in ("Full name", "Email"):
        fa.ax(pids, "set-field", fx_a.pid, fa.frame_arg(frames[fx_a.pid][label]), "")
    check("A's fields are emptied, so no window shows the values",
          all(fa.ax(pids, "value", fx_a.pid, fa.frame_arg(f))["value"] == "" for f in frames[fx_a.pid].values()))
    time.sleep(2)

    # 3. Forget both in the memory book; the helper no longer holds them.
    forgot_at_ms = time.time() * 1000
    for e in kept:
        fa.host(f"memory forget {e['id']}")
        sent = fa.host("memory confirm").get("sent")
        gone = fa.wait_for(lambda: all(x["id"] != e["id"] for x in fa.host("memory")["book"]["entries"]), 5, 0.2)
        check(f"Forget {e['id']}: sent and gone from the book", sent is True and gone, entry=e["id"])
    check("the helper lists no About entry after Forget", about() == [], entries=about())

    # 4. Another fresh form gets no offer, and Tab is the form's own.
    ok, front = fixture_app.activate(fx_b, lambda: fa.ax(pids, "frontmost"))
    if not check("form B takes the foreground", ok, frontmost=front):
        result["status"] = "deferred: foreground"
        return
    fa.ax(pids, "key-window", fx_b.pid, CLAIM)
    for label in ("Full name", "Email"):
        frame = frames[fx_b.pid][label]
        before = fa.host()["helper"]["proposals"]
        fa.ax(pids, "focus", fx_b.pid, fa.frame_arg(frame))
        proposed = fa.wait_for(lambda: fa.host()["helper"]["proposals"] > before, 3, 0.1)
        time.sleep(1.5)
        state = fa.host()
        offer = fa.fill_offer(fx_b.pid, 0)
        # The helper may send no proposal at all when nothing fits; either way nothing is offered.
        check(f"B {label}: nothing is offered", offer is None,
              offer=offer, newProposal=bool(proposed), lastSkip=state["fill"].get("lastSkip"))
    frame = frames[fx_b.pid]["Email"]
    tap_before = fa.host()["tap"]["consumed"]
    fa.ax(pids, "focus", fx_b.pid, fa.frame_arg(frame))
    time.sleep(0.5)
    # Other apps can take the foreground on their own (walk-2: Chrome, 22 s in); take it back once.
    if fa.ax(pids, "frontmost").get("pid") != fx_b.pid:
        ok, front = fixture_app.activate(fx_b, lambda: fa.ax(pids, "frontmost"))
        result["reactivatedB"] = {"ok": ok, "frontmost": front}
    why = may_press()
    if why:
        raise SystemExit(why)
    if TAB_HOOK:
        key_ok = fa.host(f"key tab {fx_b.pid}").get("consumed") is False
    else:
        env = dict(os.environ, CARET_TEST_PIDS=pid_list)
        # The run's own key resets HID idle; only the second the send takes is excused, not more.
        fa.expect_synthetic(1)
        key_ok = subprocess.run([fa.AX, "key-if-front", str(fx_b.pid), "tab"], capture_output=True, text=True, env=env).returncode == 0
    time.sleep(0.5)
    check("B: a Tab passes to the form and writes nothing",
          key_ok and fa.host()["tap"]["consumed"] == tap_before
          and all(fa.ax(pids, "value", fx_b.pid, fa.frame_arg(f))["value"] == "" for f in frames[fx_b.pid].values()),
          keySent=key_ok, tabHook=TAB_HOOK)
    # What the helper proposed for B: no value from anywhere, so nothing withheld could have shown either.
    b_fields = []
    with open(os.path.join(out_dir, "proposals.ndjson")) as f:
        for line in f:
            d = json.loads(line)
            m = d["message"]
            if m.get("type") == "fillProposal" and m.get("windowId", "").startswith(f"{fx_b.pid}-") and d["receivedAtMs"] > forgot_at_ms:
                b_fields += [{"descriptor": x["descriptor"][:40], "value": x["value"], "memory": x.get("memory"), "withheld": x["withheld"],
                              "asks": [a["choice"] for a in x["asks"]]} for x in m["fields"]]
    check("B: after Forget the helper proposed for B, with no value and no candidate", len(b_fields) > 0 and all(x["value"] is None and x["memory"] is None
          and all(c == "none" for c in x["asks"]) for x in b_fields), fields=b_fields)
    result["status"] = "done"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    front = lambda: (lambda o: json.loads(o.stdout) if o.returncode == 0 else {})(
        subprocess.run([fa.AX, "frontmost"], capture_output=True, text=True, env=dict(os.environ, CARET_TEST_PIDS="1")))
    dog = fixture_app.Watchdog(lambda t: any(a - 0.2 <= t <= b for a, b in fa.SYNTHETIC), front, fa.NAMES)
    lease = fixture_app.GuiLease()
    try:
        lease.__enter__()
        dog.__enter__()
        walk(out)
    except KeyboardInterrupt:
        result["status"] = f"deferred: user active (input at {dog.tripped})" if dog.tripped else "interrupted"
    except SystemExit as e:
        result["status"] = str(e)
    finally:
        dog.__exit__()
        for hand_back in fa.BEFORE_STOP:
            hand_back()
        fa.stop_all()
        lease.__exit__()
        dog.timeline.append((round(time.time() - dog.start, 2), front().get("pid"), "after hand-back"))
        result["frontTimeline"] = dog.timeline
        result["passed"] = sum(1 for c in checks if c["ok"])
        result["total"] = len(checks)
        with open(os.path.join(out, "walk.json"), "w") as f:
            json.dump(result, f, indent=2, sort_keys=True, default=str)
        fa.log("status", result.get("status"), f"{result['passed']}/{result['total']} passed")
    sys.exit(0 if result.get("status") == "done" and result["passed"] == result["total"] else 1)
