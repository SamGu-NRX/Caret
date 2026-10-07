"""Turns each recipe step's evidence into an exit code, and writes the recipe's result.json.

A recipe runs a step, then calls one subcommand here with the step's exit status. The subcommand
reads the step's own report, appends a record to $CARET_HEAVY_OUT/steps.ndjson, prints one line
and exits with the step's code, so the recipe can stop early (canned sets stop at the first wrong
value). The recipe ends with `check.py finish`, which writes result.json and exits with the
recipe's code. The codes and their precedence are in ops/heavy/README.md.

  check.py page-loop NAME --exit N [--wrong-seen]   NAME's page-loop.json and NAME.log under OUT
  check.py suite NAME --log FILE --exit N --kind vitest|node-test|tsc
  check.py prepare NAME --log FILE --exit N [--fail-code 12|14]
  check.py spend --day YYYY-MM-DD --from-line N --limit USD [--ledger-dir DIR]
  check.py r2 --harness h11|h14 --run DIR --rev SHA --exit N --spend-limit USD [--options JSON]
  check.py finish
"""

import argparse
import json
import os
import re
import sys

OK, WRONG, FAILED, EVIDENCE, SPEND, PREPARE = 0, 10, 11, 12, 13, 14
LEAK_UNSCANNED, LEAK_FOUND = 98, 99
# finish reports the most serious step: a found key, an unfinished leak scan, a wrong value, spend,
# untrustworthy evidence, a failed suite, then a failed preparation.
PRECEDENCE = (LEAK_FOUND, LEAK_UNSCANNED, WRONG, SPEND, EVIDENCE, FAILED, PREPARE)
LEDGER_DIR = os.path.expanduser("~/Library/Application Support/CaretV2/jev-spend")


def out_dir():
    return os.environ["CARET_HEAVY_OUT"]


def rel(path):
    return os.path.relpath(path, out_dir())


def record(step):
    with open(os.path.join(out_dir(), "steps.ndjson"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(step, sort_keys=True) + "\n")
    print("check: {} {} -> {}{}".format(step["kind"], step["name"], step["code"],
                                         ": " + step["why"] if step.get("why") else ""), flush=True)
    return step["code"]


def existing(*paths):
    return [rel(p) for p in paths if os.path.isfile(p)]


def page_loop(name, exit_code, wrong_seen):
    base = os.path.join(out_dir(), name)
    report, log = os.path.join(base, "page-loop.json"), base + ".log"
    step = {"kind": "page-loop", "name": name, "exit": exit_code, "evidence": existing(report, log)}
    try:
        with open(report, encoding="utf-8") as fh:
            data = json.load(fh)
        rows = data["rows"]
        wrong = sum(len(r["wrong"]) for r in rows)
        step.update(pages=len(rows), walked=sum(1 for r in rows if r.get("walk") is not None), wrong=wrong,
                    errors=sum(1 for r in rows if r.get("error")), presses=data.get("presses"),
                    posts=data.get("posts"), spent=data.get("spent"))
    except FileNotFoundError:
        data = None
        step["why"] = "no page-loop.json"
    except (OSError, ValueError, KeyError, TypeError) as ex:
        data = None
        step["why"] = "malformed page-loop.json: {!r}".format(ex)
    if data is not None and step["wrong"] > 0:
        step.update(code=WRONG, why="{} wrong value(s) in page-loop.json".format(step["wrong"]))
    elif wrong_seen:
        step.update(code=WRONG, why="a wrong value was seen in the log, and the eval was stopped")
    elif exit_code != 0:
        step["code"] = FAILED
        step["why"] = step.get("why") or "the eval exited {}".format(exit_code)
    elif data is None:
        step["code"] = EVIDENCE
    elif step["pages"] == 0 or step["walked"] < step["pages"]:
        step["code"], step["why"] = EVIDENCE, "{} of {} pages walked".format(step["walked"], step["pages"])
    else:
        step["code"] = OK
    return record(step)


_VITEST = re.compile(r"^\s*Tests\s+(?:(\d+) failed)?(?:\s*\|\s*)?(?:(\d+) passed)?", re.M)
_NODE = re.compile(r"^\S*\s*(pass|fail) (\d+)\s*$", re.M)
_TSC = re.compile(r"error TS\d+", re.M)


def suite(name, log, exit_code, kind):
    step = {"kind": "suite", "name": name, "exit": exit_code, "suite": kind, "evidence": existing(log)}
    try:
        with open(log, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        step.update(code=EVIDENCE if exit_code == 0 else FAILED, why="no log {}".format(log))
        return record(step)
    failed = passed = None
    if kind == "vitest":
        found = _VITEST.findall(text)
        if found:
            failed, passed = (int(found[-1][0] or 0), int(found[-1][1] or 0))
    elif kind == "node-test":
        counts = dict((k, int(v)) for k, v in _NODE.findall(text))
        if counts:
            failed, passed = counts.get("fail", 0), counts.get("pass", 0)
    elif kind == "tsc":
        failed, passed = len(_TSC.findall(text)), None
    step.update(failed=failed, passed=passed)
    if exit_code != 0 or (failed or 0) > 0:
        step.update(code=FAILED, why="exit {}, {} failed".format(exit_code, failed))
    elif kind != "tsc" and not passed:
        step.update(code=EVIDENCE, why="the log reports no passing tests")
    else:
        step["code"] = OK
    return record(step)


def prepare(name, log, exit_code, fail_code=PREPARE):
    step = {"kind": "prepare", "name": name, "exit": exit_code, "evidence": existing(log)}
    step["code"] = OK if exit_code == 0 else fail_code
    if exit_code:
        step["why"] = "exited {}".format(exit_code)
    return record(step)


def spend(day, from_line, limit, ledger_dir):
    ledger = os.path.join(ledger_dir, day + ".ndjson")
    step = {"kind": "spend", "name": day, "limit": limit, "from_line": from_line, "evidence": []}
    try:
        with open(ledger, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        usd = sum(float(r["usd"]) for r in rows[from_line - 1:])
    except FileNotFoundError:
        usd = 0.0
    except (OSError, ValueError, KeyError, TypeError) as ex:
        step.update(code=EVIDENCE, why="ledger unreadable: {!r}".format(ex))
        return record(step)
    step["usd"] = round(usd, 6)
    step["code"] = SPEND if usd > limit + 1e-9 else OK
    if step["code"]:
        step["why"] = "spent ${:.4f}, limit ${:.4f}".format(usd, limit)
    return record(step)


def guest_spend(run):
    """USD the guest's Jev ledger recorded in this run, leaving out R2's seed rows."""
    total = 0.0
    folder = os.path.join(run, "out", "jev-spend")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        with open(os.path.join(folder, name), encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    row = json.loads(line)
                    if not row.get("r2Seed"):
                        total += float(row["usd"])
    return total


def r2(harness, run, rev, exit_code, options, spend_limit):
    """A rig run's copied-back evidence: rig.json, the guest's results, its leak check and its spend."""
    step = {"kind": "r2", "name": harness, "exit": exit_code, "evidence": []}
    if exit_code in (LEAK_FOUND, LEAK_UNSCANNED):
        step.update(code=exit_code, why="host leak check {}".format("found a key" if exit_code == LEAK_FOUND
                                                                     else "could not finish"))
        return record(step)
    results = os.path.join(run, "out", "results.json" if harness == "h11" else "result.json")
    leak = os.path.join(run, "out", "leak-check.txt")
    step["evidence"] = existing(os.path.join(run, "rig.json"), os.path.join(run, "rig.log"), results, leak)
    problems = []
    try:
        with open(results, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as ex:
        data = None
        problems.append("no readable guest results: {!r}".format(ex))
    try:
        with open(leak, encoding="utf-8") as fh:
            clean = fh.read().strip().startswith("CLEAN")
    except OSError:
        clean = False
    if not clean:
        problems.append("the guest's leak check did not say CLEAN")
    if data is not None:
        if data.get("rev") != rev:
            problems.append("results are for {}, not the pinned {}".format(data.get("rev"), rev))
        if harness == "h11" and options is not None and data.get("options") != json.loads(options):
            problems.append("results ran with options {}, not the plan's {}".format(data.get("options"), options))
    try:
        step["usd"] = round(guest_spend(run), 6)
    except (OSError, ValueError, KeyError, TypeError) as ex:
        step["usd"] = None
        problems.append("guest spend ledger unreadable: {!r}".format(ex))
    wrong_rows = [r.get("id") for r in (data or {}).get("rows", []) if r.get("wrong") == "yes"]
    step["wrong_rows"] = wrong_rows
    if wrong_rows:
        step.update(code=WRONG, why="wrong value in rows {}".format(wrong_rows))
    elif step["usd"] is not None and step["usd"] > spend_limit + 1e-9:
        step.update(code=SPEND, why="guest spent ${:.4f}, limit ${:.4f}".format(step["usd"], spend_limit))
    elif exit_code != 0:
        step.update(code=FAILED, why="rig run exited {}".format(exit_code) + ("; " + "; ".join(problems) if problems else ""))
    elif problems:
        step.update(code=EVIDENCE, why="; ".join(problems))
    elif harness == "h14" and data.get("pass") is not True:
        step.update(code=FAILED, why="H14 result says pass={}".format(data.get("pass")))
    else:
        step["code"] = OK
    return record(step)


def finish():
    steps = []
    try:
        with open(os.path.join(out_dir(), "steps.ndjson"), encoding="utf-8") as fh:
            steps = [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        pass
    codes = {s["code"] for s in steps}
    code = next((c for c in PRECEDENCE if c in codes), OK) if steps else EVIDENCE
    evidence = sorted({e for s in steps for e in s.get("evidence", [])} | ({"steps.ndjson"} if steps else set()))
    result = {"schema": 1, "job_id": os.environ["CARET_HEAVY_JOB_ID"],
              "plan_sha256": os.environ["CARET_HEAVY_PLAN_SHA256"], "recipe": os.environ["CARET_HEAVY_RECIPE"],
              "exit": code, "steps": steps, "evidence": evidence}
    if not steps:
        result["why"] = "the recipe recorded no steps"
    with open(os.path.join(out_dir(), "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1)
    print("check: finish -> {} ({} steps)".format(code, len(steps)), flush=True)
    return code


def main(argv=None):
    parser = argparse.ArgumentParser(prog="check.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("page-loop")
    p.add_argument("name")
    p.add_argument("--exit", type=int, required=True)
    p.add_argument("--wrong-seen", action="store_true")
    s = sub.add_parser("suite")
    s.add_argument("name")
    s.add_argument("--log", required=True)
    s.add_argument("--exit", type=int, required=True)
    s.add_argument("--kind", choices=("vitest", "node-test", "tsc"), required=True)
    pr = sub.add_parser("prepare")
    pr.add_argument("name")
    pr.add_argument("--log", required=True)
    pr.add_argument("--exit", type=int, required=True)
    pr.add_argument("--fail-code", type=int, choices=(EVIDENCE, PREPARE), default=PREPARE)
    sp = sub.add_parser("spend")
    sp.add_argument("--day", required=True)
    sp.add_argument("--from-line", type=int, required=True)
    sp.add_argument("--limit", type=float, required=True)
    sp.add_argument("--ledger-dir", default=LEDGER_DIR)
    r = sub.add_parser("r2")
    r.add_argument("--harness", choices=("h11", "h14"), required=True)
    r.add_argument("--run", required=True)
    r.add_argument("--rev", required=True)
    r.add_argument("--exit", type=int, required=True)
    r.add_argument("--options")
    r.add_argument("--spend-limit", type=float, required=True)
    sub.add_parser("finish")
    args = parser.parse_args(argv)
    if args.cmd == "page-loop":
        return page_loop(args.name, args.exit, args.wrong_seen)
    if args.cmd == "suite":
        return suite(args.name, args.log, args.exit, args.kind)
    if args.cmd == "prepare":
        return prepare(args.name, args.log, args.exit, args.fail_code)
    if args.cmd == "spend":
        return spend(args.day, args.from_line, args.limit, args.ledger_dir)
    if args.cmd == "r2":
        return r2(args.harness, args.run, args.rev, args.exit, args.options, args.spend_limit)
    return finish()


if __name__ == "__main__":
    sys.exit(main())
