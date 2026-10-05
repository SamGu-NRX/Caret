#!/usr/bin/env python3
"""T2's writing acceptance in a TextEdit this script starts, in the rig VM only: it types and
presses keys at the HID level (a17-tool type, key, cmdz) and changes the guest's text settings.

  writing_vm_acceptance.py <out_dir>

  native  The capability the toast's ⌘Z relies on (V1a check 6, option A): Tab fixes a misspelling,
          the toast is left to go, and then one TextEdit ⌘Z puts back exactly the sentence as typed
          and the next undoes the typing. NativeUndoApps lists TextEdit on this proof.
  fix     A typed misspelling at a sentence's end is underlined and its line shows. Tab fixes exactly
          that range and nothing else, with the caret back where it was. ⌘Z while the toast is up
          puts it back by TextEdit's own Undo (the host reports `nativeUndo`), and the next ⌘Z is
          TextEdit's: it undoes typing, not the fix.
  fixall  Two errors in one sentence. ↓ opens the list, ↓ to "Fix all in this paragraph" shows its
          diff, Tab applies both as one write, and one ⌘Z puts both back.
  choice  "adress", whose checker answers disagree: the line shows both and does not own Tab.

Every picture is joined from `screencapture -l` captures of TextEdit's window and Caret's panels
(compose-shot), never a screen region. Environment: CARET_BIN, A17_TOOL, COMPOSE_SHOT.
"""
import json
import os
import socket
import subprocess
import sys
import time

CARET = os.environ["CARET_BIN"]
TOOL = os.environ["A17_TOOL"]
COMPOSE = os.environ["COMPOSE_SHOT"]
TEXTEDIT = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit"
SOCK = "/tmp/t2-host.sock"
STARTED = []
CHECKS = []


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def check(name, ok, **detail):
    CHECKS.append({"check": name, "ok": bool(ok), **detail})
    log("PASS" if ok else "FAIL", name, json.dumps(detail)[:500] if detail else "")
    return ok


def tool(*args):
    out = subprocess.run([TOOL, *map(str, args)], capture_output=True, text=True)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"error": f"a17-tool {args[0]}: {out.stdout} {out.stderr}"}


def host(command):
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
    # The guest's own text help would fix the misspellings before Caret sees them.
    for domain, key in [("-g", "NSAutomaticSpellingCorrectionEnabled"), ("-g", "NSAutomaticCapitalizationEnabled"),
                        ("-g", "NSAutomaticPeriodSubstitutionEnabled"), ("-g", "NSAutomaticTextCompletionEnabled"),
                        ("com.apple.TextEdit", "CorrectSpellingAutomatically"), ("com.apple.TextEdit", "CheckSpellingWhileTyping"),
                        ("com.apple.TextEdit", "CheckGrammarWithSpelling")]:
        subprocess.run(["defaults", "write", domain, key, "-bool", "false"])
    subprocess.run(["defaults", "write", "com.apple.TextEdit", "NSShowAppCentricOpenPanelInsteadOfUntitledFile", "-bool", "false"])
    subprocess.run(["defaults", "write", "com.apple.TextEdit", "RichText", "-int", "0"])
    te = start("textedit", [TEXTEDIT, "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO", "-ApplePersistenceIgnoreState", "YES",
                             "-NSQuitAlwaysKeepsWindows", "NO"], out_dir)
    time.sleep(3)
    if os.path.exists(SOCK):
        os.remove(SOCK)
    settings = os.path.join(out_dir, "settings.json")
    start("host", [CARET, "--socket", SOCK, "--helper-socket", "/tmp/t2-no-helper.sock", "--allow-pids", str(te.pid),
                   "--no-ghost", "--test-hooks", "--settings", settings, "--status-item", "off"], out_dir)
    if not wait_for(lambda: os.path.exists(SOCK), 20, 0.1):
        raise SystemExit("host did not open its socket")
    time.sleep(1.5)
    check("TextEdit is frontmost", tool("activate", te.pid).get("front"))
    check("TextEdit's document is readable", wait_for(lambda: tool("value", te.pid).get("value") is not None, 10, 0.2))
    return te.pid


def state():
    return host("state")


def writing_offer():
    offer = state().get("offer") or {}
    return offer if offer.get("kind") == "writing" else None


def shot(pid, out_dir, name):
    """TextEdit's window and every Caret panel on screen, each captured by its window number."""
    layers = []
    for w in tool("windows", pid).get("windows", []):
        if w.get("layer") == 0 and w["frame"][2] > 100:
            path = os.path.join(out_dir, f"{name}-textedit-{w['number']}.png")
            subprocess.run(["screencapture", "-x", "-o", "-l", str(w["number"]), path])
            layers.append((path, w["frame"]))
            break
    writing = state().get("writing") or {}
    panels = list(writing.get("underlines") or []) + ([writing["panel"]] if writing.get("panel") else [])
    for p in panels:
        path = os.path.join(out_dir, f"{name}-panel-{p['windowNumber']}.png")
        subprocess.run(["screencapture", "-x", "-o", "-l", str(p["windowNumber"]), path])
        layers.append((path, p["frame"]))
    if not layers:
        return None
    out = os.path.join(out_dir, f"{name}.png")
    args = [COMPOSE, out] + [f"{path}:{','.join(str(round(v, 1)) for v in frame)}" for path, frame in layers]
    subprocess.run(args, capture_output=True)
    log("shot", out, len(layers), "layers")
    return out


def type_sentence(pid, text):
    typed = tool("type", pid, text).get("value")
    offer = wait_for(writing_offer, 4)
    return typed, offer


def last_insertion():
    return state().get("lastInsertion") or {}


def press(pid, name):
    return tool("key", pid, name)


def undo_group(pid, out_dir, name, typed, fixed):
    """⌘Z while the toast is up, then TextEdit's own ⌘Z."""
    earlier = state().get("lastUndo")
    tool("cmdz", pid)
    wait_for(lambda: state().get("lastUndo") not in (None, earlier), 3)
    u1 = tool("value", pid).get("value")
    shot(pid, out_dir, f"{name}-after-cmdz")
    undo = state().get("lastUndo") or {}
    check(f"{name}: ⌘Z on the toast puts the original back", u1 == typed and undo.get("ok") is True and undo.get("strategy") == "nativeUndo",
          value=u1, typed=typed, undo=undo)
    u2 = tool("cmdz", pid).get("value")
    check(f"{name}: the next ⌘Z is TextEdit's and undoes typing, not the fix back in",
          u2 is not None and u2 != u1 and u2 != fixed and typed.startswith(u2), value=u2)
    return u1, u2


def fix(pid, out_dir):
    tool("newdoc", pid)
    sentence = "We will recieve the parcel tomorrow. "
    typed, offer = type_sentence(pid, sentence)
    check("fix: the sentence typed", typed == sentence, value=typed)
    check("fix: a writing offer for the misspelling", offer is not None and offer["writing"]["presentation"] == "line"
          and offer["writing"]["ownsTab"] is True, offer=offer)
    start_at = sentence.index("recieve")
    if offer:
        check("fix: the active mark is “recieve”", (offer["writing"]["activeStart"], offer["writing"]["activeEnd"]) == (start_at, start_at + 7),
              writing=offer["writing"])
    w = state().get("writing") or {}
    check("fix: it is underlined from its text bounds", len(w.get("underlines") or []) >= 1 and w.get("anchoredBy") == "bounds"
          and any(m.get("hasBounds") for m in w.get("marks", [])), writing=w)
    shot(pid, out_dir, "fix-line")
    before = last_insertion().get("claimID", 0)
    press(pid, "tab")
    ins = wait_for(lambda: (lambda i: i if i.get("claimID", 0) > before else None)(last_insertion()), 5) or {}
    after = tool("value", pid)
    fixed = sentence.replace("recieve", "receive")
    check("fix: Tab fixed exactly that range", ins.get("ok") is True and after.get("value") == fixed, insertion=ins, value=after.get("value"))
    check("fix: the caret is back at the end", after.get("selection") == [len(fixed), 0], selection=after.get("selection"))
    check("fix: the toast holds ⌘Z", (state().get("writing") or {}).get("panelRole") == "toast", writing=state().get("writing"))
    shot(pid, out_dir, "fix-toast")
    undo_group(pid, out_dir, "fix", sentence, fixed)


def native(pid, out_dir):
    """TextEdit's own Undo after Caret's AX fix, with Caret's toast gone, so ⌘Z is TextEdit's."""
    tool("newdoc", pid)
    sentence = "They will recieve it soon. "
    typed, offer = type_sentence(pid, sentence)
    check("native: the sentence typed", typed == sentence and offer is not None, value=typed)
    before = last_insertion().get("claimID", 0)
    press(pid, "tab")
    ins = wait_for(lambda: (lambda i: i if i.get("claimID", 0) > before else None)(last_insertion()), 5) or {}
    fixed = sentence.replace("recieve", "receive")
    check("native: Tab fixed it", ins.get("ok") is True and tool("value", pid).get("value") == fixed, insertion=ins)
    # The toast holds ⌘Z for its lifetime (UndoGrant.defaultLifetime, 5 s); after it, ⌘Z is TextEdit's.
    gone = wait_for(lambda: (state().get("writing") or {}).get("panelRole") != "toast", 8, 0.2)
    time.sleep(0.5)
    earlier = state().get("lastUndo")
    u1 = tool("cmdz", pid).get("value")
    check("native: with the toast gone, one TextEdit ⌘Z puts back exactly the sentence as typed",
          gone is not None and u1 == sentence and state().get("lastUndo") == earlier, value=u1, typed=sentence)
    u2 = tool("cmdz", pid).get("value")
    check("native: the next TextEdit ⌘Z undoes the typing", u2 is not None and u2 != u1 and sentence.startswith(u2), value=u2)


def fixall(pid, out_dir):
    tool("newdoc", pid)
    sentence = "I recieve teh letters every week. "
    typed, offer = type_sentence(pid, sentence)
    check("fixall: an offer with two marks", offer is not None and offer["writing"]["marks"] >= 2, offer=offer)
    if not offer:
        return
    press(pid, "down")
    opened = wait_for(lambda: (lambda o: o if o and o["writing"]["presentation"] == "expanded" else None)(writing_offer()), 2)
    check("fixall: ↓ opens the list", opened is not None, offer=opened)
    rows = (opened or offer)["writing"]["rows"]
    check("fixall: the list ends in Fix all", rows[-1:] == ["fixAll"], rows=rows)
    for _ in range(len(rows) - 1):
        press(pid, "down")
    current = writing_offer()
    check("fixall: Fix all is highlighted", current is not None and current["writing"]["current"] == len(rows) - 1, offer=current)
    shot(pid, out_dir, "fixall-diff")
    before = last_insertion().get("claimID", 0)
    title_before = tool("undo-title", pid)
    press(pid, "tab")
    ins = wait_for(lambda: (lambda i: i if i.get("claimID", 0) > before else None)(last_insertion()), 5) or {}
    fixed = "I receive the letters every week. "
    value = tool("value", pid).get("value")
    check("fixall: both fixed in one write", ins.get("ok") is True and value == fixed, insertion=ins, value=value)
    check("fixall: TextEdit records an edit", tool("undo-title", pid).get("enabled") is True, before=title_before)
    shot(pid, out_dir, "fixall-toast")
    undo_group(pid, out_dir, "fixall", sentence, fixed)


def choice(pid, out_dir):
    tool("newdoc", pid)
    typed, offer = type_sentence(pid, "Can you adress the feedback? ")
    ok = offer is not None and offer["writing"]["needsChoice"] is True and offer["writing"]["ownsTab"] is False
    check("choice: “adress” shows both answers and owns no Tab", ok, offer=offer, note="macOS may agree with itself; then this records it")
    shot(pid, out_dir, "choice-line")
    press(pid, "esc")


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    try:
        pid = setup(out_dir)
        for case in (native, fix, fixall, choice):
            if tool("activate", pid).get("front"):
                case(pid, out_dir)
            else:
                check(f"{case.__name__}: TextEdit is frontmost", False)
        json.dump(state(), open(os.path.join(out_dir, "host-state.json"), "w"), indent=2)
    finally:
        for p in STARTED:
            p.terminate()
        passed = sum(c["ok"] for c in CHECKS)
        json.dump(CHECKS, open(os.path.join(out_dir, "checks.json"), "w"), indent=2)
        log(f"{passed}/{len(CHECKS)} checks passed")
        sys.exit(0 if passed == len(CHECKS) else 1)


if __name__ == "__main__":
    main()
