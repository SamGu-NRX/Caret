#!/usr/bin/env python3
"""A17's on-screen insertion checks, in the rig VM only (they post HID keys and write the guest's
general pasteboard; see a17-tool.swift). TextEdit and Caret are started here, by exec.

  insertion_vm_acceptance.py clipboard <out_dir> [runs]
      Paste, then reconcile (Sam's decision of 2026-10-04), through Caret's real paste route
      (`writemethod <pid> pastePid`). Each run starts from rich, multi-item prior contents and
      Tabs an offer into TextEdit:
        race   a copy made after Caret's item is on the pasteboard and the paste has landed, but
               before the restore, survives; the host reports skippedUserCopied;
        plain  the prior contents come back, every item and type with the same bytes, restored;
        empty  an empty pasteboard is empty again;
        refused  prior contents with a file URL (of a file that exists, written as Finder writes
               one) and a private type: Caret does not paste (I3's refusal rule) but writes by AX
               instead, says why (clipboardRefused), and the pasteboard is untouched: its change
               count does not move, and a fresh read by another process after the seed (`fresh`)
               matches one after the run. The fresh read must list the file URL item, or the run
               fails at stage "seed": in A17's and V1b's runs, a file URL naming a missing file was
               seen by its writer only, so Caret had nothing to refuse.
      race and plain start from restorable contents (`seed text`), refused from `seed rich`.
      changeCount and contents (types and SHA-256 per type) are logged before and after every run.
      Every run starts in a new document (⌘N), so one run's text never decides where the next
      one's offer goes (V1a appended every run to one document; once its line was full, each offer
      was withdrawn before Tab and the rest of the runs inserted nothing). Odd runs put text after
      the caret first (typed, then ↑ to the start), so the offer is drawn in a capsule; even runs
      start empty, so it is inline. Each row records the injection's reply, the presentation the
      host drew, the claim id and the stage that failed (setup, shown, claim, insert, clipboard),
      so a placement failure cannot pass for a clipboard failure.

  insertion_vm_acceptance.py undo <out_dir>
      q1 bug 5: type with real keys, Tab an offer into TextEdit, then press ⌘Z twice with real keys.
      The first removes exactly Caret's text, the second still undoes the typing. Once by the AX
      route (the default) and once by the paste route, each in a fresh document.

Environment: CARET_BIN (Caret's executable), A17_TOOL (a17-tool), CARET_TEST_RESTORE_DELAY_MS is set
here for the host (400 ms, test hooks only) so the race's copy lands while Caret's item is up.
"""
import json
import os
import subprocess
import sys
import time

CARET = os.environ["CARET_BIN"]
TOOL = os.environ["A17_TOOL"]
TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"
SOCK = "/tmp/a17-host.sock"
STARTED = []
CHECKS = []


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def check(name, ok, **detail):
    CHECKS.append({"check": name, "ok": bool(ok), **detail})
    log("PASS" if ok else "FAIL", name, json.dumps(detail)[:400] if detail else "")
    return ok


def tool(*args):
    out = subprocess.run([TOOL, *map(str, args)], capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"error": f"a17-tool {args[0]}: {out.stdout} {out.stderr}"}


def host(command):
    import socket
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(10)
        s.connect(SOCK)
        s.sendall((command + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    return json.loads(data)


def wait_for(predicate, timeout, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    return None


def start(name, args, out_dir, env=None):
    out = open(os.path.join(out_dir, f"{name}.log"), "w")
    proc = subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT, env=env)
    STARTED.append(proc)
    log("started", name, proc.pid)
    return proc


def setup(out_dir):
    subprocess.run(["defaults", "write", "com.apple.TextEdit", "NSShowAppCentricOpenPanelInsteadOfUntitledFile", "-bool", "false"])
    subprocess.run(["defaults", "write", "com.apple.TextEdit", "RichText", "-int", "0"])
    te = start("textedit", [TEXTEDIT, "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO", "-ApplePersistenceIgnoreState", "YES",
                             "-NSQuitAlwaysKeepsWindows", "NO"], out_dir)
    time.sleep(3)
    if os.path.exists(SOCK):
        os.remove(SOCK)
    env = dict(os.environ, CARET_TEST_RESTORE_DELAY_MS="400")
    settings = os.path.join(out_dir, "settings.json")
    h = start("host", [CARET, "--socket", SOCK, "--helper-socket", "/tmp/a17-no-helper.sock", "--allow-pids", str(te.pid),
                       "--no-ghost", "--test-hooks", "--settings", settings, "--status-item", "off"], out_dir, env)
    if not wait_for(lambda: os.path.exists(SOCK), 20, 0.1):
        raise SystemExit("host did not open its socket")
    time.sleep(1.5)
    check("TextEdit is frontmost", tool("activate", te.pid).get("front"))
    # The document's text view takes a moment to be readable after launch (run 1 of the first VM
    # run read nothing).
    check("TextEdit's document is readable", wait_for(lambda: tool("value", te.pid).get("value") is not None, 10, 0.2))
    return te.pid


def last_insertion():
    return host("state").get("lastInsertion") or {}


def tab_in(pid, text):
    """An offer of `text` at TextEdit's caret, taken with Tab through the tap's own decision. Also
    returns what the host drew: its surface state right after the injection."""
    before = last_insertion().get("claimID", 0)
    tool("activate", pid)
    reply = host("inject " + json.dumps({"kind": "alternatives", "pid": pid, "candidates": [text]}, separators=(",", ":")))
    surface = host("state").get("surface") or {}
    time.sleep(0.4)
    k = host(f"key tab {pid}")
    ins = wait_for(lambda: (lambda i: i if i.get("claimID", 0) > before else None)(last_insertion()), 6)
    return reply, surface, k, ins or {}


def fresh_document(pid, after):
    """A new document; with `after`, that text typed and the caret moved back to its start, so the
    offer has text after the caret. Returns the value and selection it starts from."""
    tool("activate", pid)
    tool("newdoc", pid)
    if after:
        tool("type", pid, after)
        tool("key", pid, "up")
    return tool("value", pid)


def items(dump):
    return [[(t["type"], t["sha"]) for t in item] for item in dump.get("items", [])]


def clipboard(out_dir, runs):
    pid = setup(out_dir)
    check("the paste route is set for TextEdit", host(f"writemethod {pid} pastePid").get("ok"))
    ledger = open(os.path.join(out_dir, "pasteboard.ndjson"), "w")
    results = {"race": 0, "plain": 0, "empty": 0, "refused": 0}
    plan = [("race", i) for i in range(runs)] + [("plain", i) for i in range(runs)] + [("empty", i) for i in range(2)] \
        + [("refused", i) for i in range(2)]
    presentations = {"inline": 0, "capsule": 0}
    for n, (kind, i) in enumerate(plan):
        text = f" {kind}{i:02d}"
        tail = " after" if n % 2 else ""
        start = fresh_document(pid, tail)
        want_capsule = bool(tail)
        # TextEdit may correct what was typed, so the run expects the text the document holds.
        held = start.get("value") or ""
        set_up = start.get("selection") == [0, 0] and (bool(held.strip()) if tail else held == "")
        before = tool("seed", {"empty": "empty", "refused": "rich"}.get(kind, "text"))
        # The seed's own read is its writer's view; this one is another process's (H7b: in V1b, Caret's
        # read of the seeded general pasteboard listed one item where the seed listed two).
        fresh = tool("dump")
        watcher = None
        if kind == "race":
            watcher = subprocess.Popen([TOOL, "copy-when", str(pid), f"user copy {i:02d}", "6"], stdout=subprocess.PIPE, text=True)
        reply, surface, k, ins = tab_in(pid, text)
        copied = json.loads(watcher.communicate(timeout=10)[0]) if watcher else None
        time.sleep(0.8)
        after = tool("dump")
        field = tool("value", pid).get("value") or ""
        presentation = reply.get("presentation")
        if presentation in presentations:
            presentations[presentation] += 1
        row = {"run": f"{kind}{i:02d}", "start": start, "reply": reply, "presentation": presentation, "capsule": surface.get("capsule"),
               "capsuleSide": surface.get("capsuleSide"), "tab": k, "claimID": ins.get("claimID"), "before": before, "fresh": fresh, "after": after,
               "insertion": ins, "copy": copied, "field": field == text + held}
        ledger.write(json.dumps(row) + "\n")
        ledger.flush()
        shown = reply.get("ok") is True and presentation == ("capsule" if want_capsule else "inline")
        inserted = ins.get("ok") is True and ins.get("method") == "pastePid" and field == text + held
        if kind == "race":
            ok = inserted and copied and copied.get("copied") and ins.get("clipboard") == "skippedUserCopied" \
                and after.get("plain") == f"user copy {i:02d}" and after.get("changeCount") == copied["after"]["changeCount"]
        elif kind == "plain":
            ok = inserted and ins.get("clipboard") == "restored" and items(after) == items(before) \
                and after.get("changeCount") == before.get("changeCount") + 2
        elif kind == "empty":
            ok = inserted and ins.get("clipboard") == "restored" and after.get("items") == [] \
                and after.get("changeCount") == before.get("changeCount") + 2
        else:
            ok = ins.get("ok") is True and ins.get("method") == "axSelectedText" and field == text + held \
                and ins.get("clipboard") is None and bool(ins.get("clipboardRefused")) and items(after) == items(fresh) \
                and after.get("changeCount") == before.get("changeCount") == fresh.get("changeCount")
        ok = ok and set_up and shown
        # The first stage that went wrong, so a run that never showed its offer is not read as a
        # clipboard failure.
        seeded = kind != "refused" or any(t["type"] == "public.file-url" for item in fresh.get("items", []) for t in item)
        ok = ok and seeded
        stage = ("setup" if not set_up else "seed" if not seeded else "shown" if not shown else "claim" if not ins
                 else "insert" if ins.get("ok") is not True or field != text + held else "clipboard" if not ok else None)
        results[kind] += 1 if ok else 0
        check(f"{kind} {i:02d}", ok, stage=stage, presentation=presentation, reply=reply, claimID=ins.get("claimID"),
              clipboard=ins.get("clipboard"), lost=ins.get("clipboardLost"), refused=ins.get("clipboardRefused"),
              method=ins.get("method"), error=ins.get("error"),
              before=before.get("changeCount"), after=after.get("changeCount"), copied=(copied or {}).get("afterMarkerMs"))
    log("summary", json.dumps(results))
    log("presentations", json.dumps(presentations))
    return results


def undo(out_dir):
    pid = setup(out_dir)
    outcome = {}
    for route in ("axSelectedText", "pastePid"):
        check(f"{route}: a fresh document", "error" not in tool("newdoc", pid))
        set_route = host(f"writemethod {pid} {route}")
        check(f"{route}: the route is set", set_route.get("ok") is True, reply=set_route, table=host("state").get("writeMethods"))
        typed = tool("type", pid, "alpha beta ").get("value")
        title_typed = tool("undo-title", pid)
        reply, _, k, ins = tab_in(pid, "GAMMA")
        v1 = tool("value", pid).get("value")
        title_after = tool("undo-title", pid)
        u1 = tool("cmdz", pid).get("value")
        u2 = tool("cmdz", pid).get("value")
        row = {"typed": typed, "undoAfterTyping": title_typed, "insertion": ins, "afterTab": v1, "undoAfterTab": title_after,
               "afterCmdZ1": u1, "afterCmdZ2": u2}
        outcome[route] = row
        # TextEdit corrects as it is typed ("Alpha beta "), so the document is compared with what it
        # read back after typing, not with the keys.
        check(f"{route}: Tab wrote by its route", ins.get("ok") is True and ins.get("method") == route and v1 == f"{typed}GAMMA", insertion=ins, value=v1, typed=typed)
        check(f"{route}: TextEdit's Undo is enabled after the insert", title_after.get("enabled") is True, undo=title_after)
        check(f"{route}: the first ⌘Z removes exactly Caret's text", u1 == typed, value=u1, typed=typed)
        check(f"{route}: the second ⌘Z still undoes the typing (the app's history survived)", u2 is not None and u2 != u1 and len(u2) < len(u1), value=u2)
    json.dump(outcome, open(os.path.join(out_dir, "undo.json"), "w"), indent=2)
    return outcome


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("clipboard", "undo"):
        raise SystemExit(__doc__)
    mode, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    try:
        if mode == "clipboard":
            clipboard(out_dir, int(sys.argv[3]) if len(sys.argv) > 3 else 10)
        else:
            undo(out_dir)
    finally:
        for p in STARTED:
            p.terminate()
        passed = sum(c["ok"] for c in CHECKS)
        failed = len(CHECKS) - passed
        json.dump({"passed": passed, "failed": failed, "checks": CHECKS}, open(os.path.join(out_dir, "results.json"), "w"), indent=2)
        log("summary", passed, "passed,", failed, "failed")
    sys.exit(0 if CHECKS and all(c["ok"] for c in CHECKS) else 1)


if __name__ == "__main__":
    main()
