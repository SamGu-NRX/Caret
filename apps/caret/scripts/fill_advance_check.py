#!/usr/bin/env python3
"""Checks that a verified fill moves focus to the next field (SURFACES.md section 5) and that the
next field's offer follows, on caret-fixture's Claim form.

  fill_advance_check.py <evidence_dir>

Same rig as fill_acceptance.py with CARET_FILL_ADVANCE on. The only key the host sends is the Tab
it posts to the fixture's pid after each verified fill; this script posts nothing.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fill_acceptance as fa  # noqa: E402


def main(out_dir):
    os.environ["CARET_FILL_ADVANCE"] = "on"
    fx, _, gold = fa.rig(out_dir)
    pids = [fx.pid]
    fa.visit(pids, fx.pid, fa.CLAIM)
    fields = gold[fa.CLAIM]
    steps = []
    last = 0
    for index in range(4):
        offer = fa.wait_for(lambda: fa.fill_offer(fx.pid, last), 10)
        focused = fa.ax(pids, "focused", fx.pid)["frame"]
        step = {"index": index, "label": fields[index]["label"], "offer": offer and offer["text"],
                "focusedIsThisField": focused == fields[index]["frame"]}
        if not offer:
            steps.append(step)
            break
        last = offer["id"]
        step["consumed"] = fa.host(f"key tab {fx.pid}")["consumed"]
        claim_id = fa.host()["lastClaim"]["claimID"]
        ins = fa.wait_for(lambda: (lambda st: st["lastInsertion"] if (st.get("lastInsertion") or {}).get("claimID") == claim_id else None)(fa.host()), 5)
        step["insertMs"] = ins and round(ins["durationMs"], 1)
        step["method"] = ins and ins.get("method")
        step["fellBack"] = ins and ins.get("fellBack")
        time.sleep(0.1)
        step["value"] = fa.ax(pids, "value", fx.pid, fa.frame_arg(fields[index]["frame"]))["value"]
        step["exact"] = step["value"] == fields[index]["gold"]
        moved = fa.ax(pids, "focused", fx.pid)["frame"]
        step["focusMovedToNext"] = moved == fields[index + 1]["frame"]
        steps.append(step)
        fa.log(json.dumps(step))
    with open(os.path.join(out_dir, "advance.json"), "w") as f:
        json.dump({"steps": steps, "host": fa.host().get("counters")}, f, indent=2)


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    finally:
        fa.stop_all()
