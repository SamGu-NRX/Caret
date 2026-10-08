"""Turns each recipe step's evidence into an exit code, and writes the recipe's result.json.

A recipe runs a step, then calls one subcommand here with the step's exit status. The subcommand
reads the step's own report, appends a record to $CARET_HEAVY_OUT/steps.ndjson, prints one line
and exits with the step's code, so the recipe can stop early (canned sets stop at the first wrong
value). The recipe ends with `check.py finish`, which writes result.json and exits with the
recipe's code. The codes and their precedence are in ops/heavy/README.md.

  check.py page-loop NAME --exit N [--wrong-seen] [--expect-ids FILE] [--goal]
                                       NAME's page-loop.json and NAME.log under OUT
  check.py suite NAME --log FILE --exit N --kind vitest|node-test|tsc
  check.py prepare NAME --log FILE --exit N [--fail-code 12|14]
  check.py spend --day YYYY-MM-DD --from-line N --limit USD [--ledger-dir DIR]
  check.py r2 --harness h11|h14 --run DIR --rev SHA --exit N --spend-limit USD [--options JSON]
  check.py laya CKPT --exit N --expected K   OUT/runs/CKPT.jsonl (K records), -sanity.json, -latency.json
  check.py laya-score NAME --exit N --ckpts CKPT...   OUT/score.json with a result for every checkpoint
  check.py finish [--require STEP...]

Evidence that is present but malformed is 12 whatever the step exited. A step named in --require
that never recorded, or a checker failure the recipe logged in OUT/checker-errors.txt (recipes/lib.sh),
also makes finish 12.
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


class Malformed(Exception):
    pass


def _rows(data):
    """The report's rows, checked for the fields acceptance reads. Malformed on any other shape."""
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        raise Malformed("page-loop.json has no rows list")
    for r in data["rows"]:
        if not (isinstance(r, dict) and isinstance(r.get("id"), str) and isinstance(r.get("wrong"), list)
                and (r.get("walk") is None or isinstance(r.get("walk"), dict))
                and (r.get("error") is None or isinstance(r.get("error"), str))):
            raise Malformed("a row lacks id, wrong, walk or error of the right type: {!r}".format(r)[:300])
    for key in ("presses", "posts"):
        if data.get(key) is not None and not isinstance(data.get(key), int):
            raise Malformed("{} is not a count".format(key))
    return data["rows"]


# What page-loop-eval reports for a scored task with nothing eligible to fill, which Caret stopped empty: the eval
# passes it (page-loop-eval.ts, "scored zero-eligible task with no preview"), so it is no page error (B1 report,
# 2026-10-07: wizard-3 in caret-hb-1eac305-canned-n1). Any other error, on any row, still fails the set.
STOPPED_EMPTY = "no preview: stopped Caret found nothing to put in "


def expected_empty_task(row):
    task = row.get("task")
    return (row.get("goal") is None and isinstance(task, dict) and task.get("scored") is True
            and task.get("eligible") == 0 and isinstance(row.get("error"), str)
            and row["error"].startswith(STOPPED_EMPTY))


def page_loop(name, exit_code, wrong_seen, expect_ids=None, goal=False):
    """One eval set. Acceptance: no wrong value, every expected page present and walked, no page error, no press or
    POST, and on the goal path a goal result for every page that had something to fill."""
    base = os.path.join(out_dir(), name)
    report, log = os.path.join(base, "page-loop.json"), base + ".log"
    step = {"kind": "page-loop", "name": name, "exit": exit_code, "evidence": existing(report, log)}
    data = rows = None
    try:
        with open(report, encoding="utf-8") as fh:
            data = json.load(fh)
        rows = _rows(data)
    except FileNotFoundError:
        step["why"] = "no page-loop.json"
    except (OSError, ValueError, Malformed) as ex:
        step["malformed"] = True
        step["why"] = "malformed page-loop.json: {}".format(ex)
    if rows is not None:
        ids = [r["id"] for r in rows]
        step.update(pages=len(rows), walked=sum(1 for r in rows if r["walk"] is not None),
                    wrong=sum(len(r["wrong"]) for r in rows),
                    errors=[r["id"] for r in rows if r["error"] and not expected_empty_task(r)],
                    stopped_empty=[r["id"] for r in rows if expected_empty_task(r)],
                    presses=data.get("presses") or 0, posts=data.get("posts") or 0, spent=data.get("spent"))
    problems, failures = [], []
    if rows is not None:
        if expect_ids is not None:
            with open(expect_ids, encoding="utf-8") as fh:
                want = {line.strip() for line in fh if line.strip()}
            missing, extra = sorted(want - set(ids)), sorted(set(ids) - want)
            if missing or extra or len(ids) != len(set(ids)):
                problems.append("pages differ from the expected list (missing {}, unexpected {}, {} rows)".format(
                    missing, extra, len(ids)))
        if not rows or step["walked"] < len(rows):
            problems.append("{} of {} pages walked".format(step["walked"], len(rows)))
        if goal:
            for r in rows:
                task = r.get("task")
                if task is not None and (not isinstance(task, dict) or task.get("scored") is not True):
                    problems.append("{}: the task page was not scored".format(r["id"]))
                elif r.get("goal") is None and not (isinstance(task, dict) and task.get("eligible") == 0):
                    problems.append("{}: no goal result".format(r["id"]))
        if step["errors"]:
            failures.append("page errors on {}".format(step["errors"]))
        if step["presses"] or step["posts"]:
            failures.append("{} presses, {} POSTs".format(step["presses"], step["posts"]))
    if rows is not None and step["wrong"] > 0:
        step.update(code=WRONG, why="{} wrong value(s) in page-loop.json".format(step["wrong"]))
    elif wrong_seen:
        step.update(code=WRONG, why="a wrong value was seen in the log, and the eval was stopped")
    elif step.get("malformed") or problems:
        step.update(code=EVIDENCE, why=step.get("why") or "; ".join(problems))
    elif exit_code != 0 or failures:
        step.update(code=FAILED, why=step.get("why") or "; ".join(failures) or "the eval exited {}".format(exit_code))
    elif rows is None:
        step["code"] = EVIDENCE
    else:
        step["code"] = OK
    return record(step)


_VITEST = re.compile(r"^\s*Tests\s+(?:(\d+) failed)?(?:\s*\|\s*)?(?:(\d+) passed)?", re.M)
_NODE = re.compile(r"^\S*\s*(pass|fail) (\d+)\s*$", re.M)
_TSC = re.compile(r"error TS\d+", re.M)
# swift test's two frameworks: XCTest's last "Executed" line is the whole run's; Swift Testing's run line follows it.
_XCTEST = re.compile(r"Executed (\d+) tests?, with (\d+) failures?")
_SWIFT_TESTING = re.compile(r"Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed) after [\d.]+ seconds?"
                            r"(?: with (\d+) issues?)?")


def _swift_summary(name, text, exit_code):
    """Counts from swift test's output, written to OUT/<name>.summary.json. A nonzero exit with no test summary at all
    is a build error: nothing ran."""
    xc, st = _XCTEST.findall(text), _SWIFT_TESTING.findall(text)
    summary = {"name": name, "exit": exit_code, "xctest": None, "swift_testing": None, "build_failed": False,
               "failed": None, "passed": None}
    if xc:
        executed, failures = (int(x) for x in xc[-1])
        summary["xctest"] = {"executed": executed, "failures": failures}
    if st:
        tests, verdict, issues = st[-1]
        summary["swift_testing"] = {"tests": int(tests), "verdict": verdict, "issues": int(issues or 0)}
    if xc or st:
        x, s = summary["xctest"], summary["swift_testing"]
        summary["failed"] = (x["failures"] if x else 0) + ((s["issues"] or 1) if s and s["verdict"] == "failed" else 0)
        summary["passed"] = ((x["executed"] - x["failures"]) if x else 0) + (s["tests"] if s and s["verdict"] == "passed" else 0)
    else:
        summary["build_failed"] = exit_code != 0
    path = os.path.join(out_dir(), name + ".summary.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=1)
    return summary, path


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
    elif kind == "swift":
        summary, path = _swift_summary(name, text, exit_code)
        step["evidence"] = step["evidence"] + existing(path)
        if summary["build_failed"]:
            step.update(failed=None, passed=None, code=PREPARE,
                        why="swift test exited {} before any test ran (a build error)".format(exit_code))
            return record(step)
        failed, passed = summary["failed"], summary["passed"]
    step.update(failed=failed, passed=passed)
    if exit_code != 0 or (failed or 0) > 0:
        step.update(code=FAILED, why="exit {}, {} failed".format(exit_code, failed))
    elif kind != "tsc" and not passed:
        step.update(code=EVIDENCE, why="the log reports no passing tests")
    else:
        step["code"] = OK
    return record(step)


def vm_proof(exit_code):
    """vm-cancel-proof.sh's OUT/proof.json: every named check must be true. 11 when one is not (or the proof script
    failed), 12 when there is no readable proof."""
    path = os.path.join(out_dir(), "proof.json")
    step = {"kind": "vm-proof", "name": "proof", "exit": exit_code, "evidence": existing(path)}
    try:
        with open(path, encoding="utf-8") as fh:
            checks = json.load(fh)["checks"]
        if not isinstance(checks, dict) or not checks:
            raise ValueError("no checks")
    except (OSError, ValueError, KeyError, TypeError) as ex:
        step.update(code=EVIDENCE, why="no readable proof.json: {}".format(ex))
        return record(step)
    failed = sorted(k for k, v in checks.items() if v is not True)
    step["checks"] = checks
    if failed or exit_code != 0:
        step.update(code=FAILED, why="failed: {}".format(failed) if failed else "the proof exited {}".format(exit_code))
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
    step = {"kind": "spend", "name": "spend", "day": day, "limit": limit, "from_line": from_line, "evidence": []}
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


H14_ROWS = ("attach-input", "attach-dropzone", "tab-never-confirms", "save-line", "switches", "zero-submits",
            "attach-input-undo", "attach-dropzone-undo")
H14_CHECKS = ("fixture", "caret-up", "page", "window-id")


def h11_acceptance(data, options):
    """(problems, failures) for H11: every page's own rows present and completed. From q2.py's page_task rows."""
    problems, failures = [], []
    rows = {r.get("id"): r for r in data["rows"]}
    for note in data.get("notes") or []:
        if isinstance(note, str) and ((note.startswith("harness: ") and " crashed" in note)
                                      or (note.startswith("phase P: ") and " not run" in note)):
            failures.append(note[:200])
    needs = []  # (row id, column, value)
    if "page_task" in options.get("scenarios", []):
        for page in options.get("pages", []):
            sid = "h11-" + page
            needs += [(sid + "-ask-at-form", "offered", "yes"), (sid + "-ask-at-form", "right", "yes"),
                      (sid + "-tab", "right", "yes"), (sid + "-tab", "verified", "yes"),
                      (sid + "-no-submit", "verified", "yes")]
            # With the next page on, page 1's undo is checked on wizard-2 (q2.py page_task, H11_NEXT_PAGE).
            undo = "h11-wizard-2-undo" if page == "wizard-1" and options.get("nextPage") else sid + "-undo"
            needs.append((undo, "undone", "yes"))
    if "h10" in options.get("scenarios", []):
        for prefix in ("fill-", "ask-"):
            if not any(str(i).startswith(prefix) for i in rows):
                problems.append("no {}* row for the h10 scenario".format(prefix))
    for rid, column, value in needs:
        if rid not in rows:
            problems.append("row {} is missing".format(rid))
        elif rows[rid].get(column) != value:
            failures.append("{} {}={} ({})".format(rid, column, rows[rid].get(column), str(rows[rid].get("note"))[:120]))
    return sorted(set(problems)), failures


def h14_acceptance(data):
    problems, failures = [], []
    rows = {r.get("id"): r for r in data["rows"]}
    checks = {c.get("id"): c for c in data.get("checks") or [] if isinstance(c, dict)}
    for rid in H14_ROWS + (("click-opens",) if "click-opens-ungated" not in rows else ("click-opens-ungated",)):
        if rid not in rows:
            problems.append("row {} is missing".format(rid))
        elif rows[rid].get("pass") is not True:
            failures.append("row {} failed".format(rid))
    for cid in H14_CHECKS:
        if cid not in checks:
            problems.append("check {} is missing".format(cid))
        elif checks[cid].get("pass") is not True:
            failures.append("check {} failed".format(cid))
    if data.get("pass") is not True and not failures:
        failures.append("H14 result says pass={}".format(data.get("pass")))
    return problems, failures


# RAE, the real-app eval (~/.caret-run/evidence/host/rae): acceptance is defined here, and the harness's own tests import
# it. Row columns are those rae.py's row() writes.
RAE_MODES = ("probe", "run")
RAE_STATUSES = {"ran", "probed", "absent", "blocked", "unreachable", "setup-failed", "budget", "not-run", "crashed"}
# The guest app or site was not there to test: recorded, not a failure of the run.
RAE_ENVIRONMENT = {"absent", "blocked", "unreachable", "setup-failed"}
RAE_VERDICTS = ("complete", "partial", "none", "wrong", "evidence-incomplete")
# A ran row's scoring evidence: per-field outcome counts from score.py, and Caret's takes.
RAE_COUNTS = ("taken", "right", "partial", "kept", "missed", "abstained", "extra")
RAE_COLUMNS = {"verdict": RAE_VERDICTS, "clipboard": ("restored", "changed"), "wrong": ("yes", "no"),
               "undone": ("yes", "no", "n/a"), "stopped": ("yes", "no", "finished-first", "n/a")}


def rae_options_problem(options, known_targets):
    """Why the plan's rae-options.json cannot be run, or None: a mode of RAE_MODES, and a non-empty list of distinct
    targets the staged payload has."""
    targets = options.get("targets") if isinstance(options, dict) else None
    if not isinstance(options, dict) or options.get("mode") not in RAE_MODES:
        return "rae-options.json mode must be one of {}".format(RAE_MODES)
    if not isinstance(targets, list) or not targets or len(set(map(str, targets))) != len(targets):
        return "rae-options.json targets must be a non-empty list of distinct target ids"
    unknown = [t for t in targets if t not in known_targets]
    if unknown:
        return "rae-options.json names targets the payload does not have: {}".format(unknown)
    return None


def rae_row_problems(r):
    """What a ran row lacks of its scoring evidence."""
    tid, problems = r.get("id"), []
    for column in RAE_COUNTS:
        value = r.get(column)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            problems.append("ran row {} has no count {} ({!r})".format(tid, column, value))
    for column, allowed in RAE_COLUMNS.items():
        if r.get(column) not in allowed:
            problems.append("ran row {} has no valid {} ({!r})".format(tid, column, r.get(column)))
    return problems


def rae_acceptance(data, options, known_targets):
    """(problems, failures) for one RAE results.json against the plan's rae-options.json and the targets the payload
    has. Problems are untrustworthy evidence (12), failures a run that did not do its job (11); a wrong row is r2()'s."""
    problems, failures = [], []
    bad_options = rae_options_problem(options, known_targets)
    if bad_options:
        return [bad_options], failures
    if data.get("harness") != "rae":
        problems.append("results are not RAE's (harness={!r})".format(data.get("harness")))
        return problems, failures
    if data.get("options") != options:
        problems.append("results ran with options {}, not the plan's {}".format(data.get("options"), options))
        return problems, failures
    mode = options["mode"]
    rows = {r.get("id"): r for r in data["rows"]}
    for tid in options["targets"]:
        r = rows.get(tid)
        if r is None:
            problems.append("row {} is missing".format(tid))
            continue
        status = r.get("status")
        if status not in RAE_STATUSES:
            problems.append("row {} has unknown status {!r}".format(tid, status))
        elif mode == "probe" and status not in {"probed"} | RAE_ENVIRONMENT:
            problems.append("probe row {} says {}".format(tid, status))
        elif mode == "run" and status == "probed":
            problems.append("run row {} says probed".format(tid))
        elif status in ("crashed", "not-run", "budget"):
            failures.append("{} {}: {}".format(tid, status, str(r.get("note"))[:160]))
        if status != "ran":
            continue
        row_problems = rae_row_problems(r)
        problems += row_problems
        if row_problems:
            continue
        if r["verdict"] == "evidence-incomplete":
            problems.append("{}: read-back could not score every field ({})".format(tid, str(r.get("note"))[:160]))
        if r["clipboard"] == "changed":
            failures.append("{}: the clipboard was not put back".format(tid))
        # As H11's undo gate: a check that ran and failed fails the run.
        if r["undone"] == "no":
            failures.append("{}: the undo did not restore the fields ({})".format(tid, str(r.get("note"))[:160]))
        if r["stopped"] == "no":
            failures.append("{}: the stop did not stop the run ({})".format(tid, str(r.get("note"))[:160]))
    for note in data.get("notes") or []:
        if isinstance(note, str) and note.startswith("harness: ") and " crashed" in note:
            failures.append(note[:200])
    # A row with no take: Caret never acted on the target, so it does not count as having run.
    if mode == "run" and not any(r.get("status") == "ran" and isinstance(r.get("taken"), int) and r["taken"] > 0
                                 for r in data["rows"]):
        failures.append("no target ran")
    return sorted(set(problems)), failures


def leak_ok(leak_text, harness, mode):
    """The guest's leak-check.txt: CLEAN after a scan. A RAE probe guest never has a key, so NO KEYS is right there
    (the host feeder's scan of the copied-back run still covers it); every other guest holds one."""
    text = (leak_text or "").strip()
    return text.startswith("CLEAN") or (harness == "rae" and mode == "probe" and text.startswith("NO KEYS"))


def rae_known_targets(targets_dir):
    """The target ids the staged payload has: payload/tools/targets/<id>.json (RAE's stage.sh)."""
    try:
        return {name[:-len(".json")] for name in os.listdir(targets_dir or "") if name.endswith(".json")}
    except OSError:
        return set()


def r2(harness, run, rev, exit_code, options, spend_limit, rae_targets=None):
    """A rig run's copied-back evidence: rig.json, the guest's results, its leak check and its spend, then the
    harness's acceptance rows."""
    step = {"kind": "r2", "name": harness, "exit": exit_code, "evidence": []}
    if exit_code in (LEAK_FOUND, LEAK_UNSCANNED):
        step.update(code=exit_code, why="host leak check {}".format("found a key" if exit_code == LEAK_FOUND
                                                                     else "could not finish"))
        return record(step)
    results = os.path.join(run, "out", "result.json" if harness == "h14" else "results.json")
    leak = os.path.join(run, "out", "leak-check.txt")
    step["evidence"] = existing(os.path.join(run, "rig.json"), os.path.join(run, "rig.log"), results, leak)
    problems, failures = [], []
    try:
        with open(results, encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or not isinstance(data.get("rows"), list) or \
                not all(isinstance(r, dict) for r in data["rows"]):
            raise ValueError("results have no list of row objects")
    except (OSError, ValueError) as ex:
        data = None
        problems.append("no readable guest results: {}".format(ex))
    want_options = json.loads(options) if options else None
    try:
        with open(leak, encoding="utf-8") as fh:
            clean = leak_ok(fh.read(), harness, (want_options or {}).get("mode"))
    except OSError:
        clean = False
    if not clean:
        problems.append("the guest's leak check did not say CLEAN (or NO KEYS in a RAE probe)")
    if data is not None:
        if data.get("rev") != rev:
            problems.append("results are for {}, not the pinned {}".format(data.get("rev"), rev))
        if harness in ("h11", "rae"):
            if want_options is None or data.get("options") != want_options:
                problems.append("results ran with options {}, not the plan's {}".format(data.get("options"), options))
            else:
                p, f = h11_acceptance(data, want_options) if harness == "h11" else \
                    rae_acceptance(data, want_options, rae_known_targets(rae_targets))
                problems += p
                failures += f
        else:
            p, f = h14_acceptance(data)
            problems += p
            failures += f
    try:
        step["usd"] = round(guest_spend(run), 6)
    except (OSError, ValueError, KeyError, TypeError) as ex:
        step["usd"] = None
        problems.append("guest spend ledger unreadable: {!r}".format(ex))
    wrong_rows = [r.get("id") for r in (data or {}).get("rows", []) if r.get("wrong") == "yes"]
    step.update(wrong_rows=wrong_rows, problems=problems, failures=failures)
    if wrong_rows:
        step.update(code=WRONG, why="wrong value in rows {}".format(wrong_rows))
    elif step["usd"] is not None and step["usd"] > spend_limit + 1e-9:
        step.update(code=SPEND, why="guest spent ${:.4f}, limit ${:.4f}".format(step["usd"], spend_limit))
    elif problems:
        step.update(code=EVIDENCE, why="; ".join(problems)[:1500])
    elif exit_code != 0 or failures:
        step.update(code=FAILED, why="; ".join(["rig run exited {}".format(exit_code)] * (exit_code != 0) + failures)[:1500])
    else:
        step["code"] = OK
    return record(step)


def laya(ckpt, exit_code, expected):
    """One checkpoint's run: exactly the expected field records, each with both wordings, and its two reports."""
    runs = os.path.join(out_dir(), "runs")
    records, sanity, latency = (os.path.join(runs, ckpt + suffix) for suffix in (".jsonl", "-sanity.json", "-latency.json"))
    step = {"kind": "laya", "name": ckpt, "exit": exit_code, "expected": expected,
            "evidence": existing(records, sanity, latency, os.path.join(out_dir(), ckpt + ".log"))}
    try:
        with open(records, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        if not all(isinstance(r, dict) and isinstance(r.get("A"), dict) and isinstance(r.get("B"), dict) for r in rows):
            raise ValueError("a record lacks both wordings")
        for path in (sanity, latency):
            with open(path, encoding="utf-8") as fh:
                json.load(fh)
        step["records"] = len(rows)
        malformed = None
    except FileNotFoundError as ex:
        rows, malformed = None, None
        step["why"] = "missing {}".format(os.path.basename(ex.filename))
    except (OSError, ValueError) as ex:
        rows, malformed = None, "malformed checkpoint output: {}".format(ex)
    if malformed:
        step.update(code=EVIDENCE, why=malformed)
    elif exit_code != 0:
        step.update(code=FAILED, why=step.get("why") or "laya_run.py exited {}".format(exit_code))
    elif rows is None:
        step["code"] = EVIDENCE
    elif expected <= 0 or len(rows) != expected:
        step.update(code=EVIDENCE, why="{} records, expected {}".format(len(rows), expected))
    else:
        step["code"] = OK
    return record(step)


def laya_score(name, exit_code, ckpts):
    path = os.path.join(out_dir(), "score.json")
    step = {"kind": "laya-score", "name": name, "exit": exit_code,
            "evidence": existing(path, os.path.join(out_dir(), "score.log"))}
    try:
        with open(path, encoding="utf-8") as fh:
            report = json.load(fh)
        missing = [c for c in ckpts if not isinstance(report.get(c), dict) or "zeroShot" not in report[c]]
        problem = "no score for {}".format(missing) if missing or "jev" not in report else None
    except FileNotFoundError:
        report, problem = None, None
    except (OSError, ValueError) as ex:
        report, problem = None, "malformed score.json: {}".format(ex)
    if problem:
        step.update(code=EVIDENCE, why=problem)
    elif exit_code != 0:
        step.update(code=FAILED, why="score.py exited {}".format(exit_code))
    elif report is None:
        step.update(code=EVIDENCE, why="no score.json")
    else:
        step["code"] = OK
    return record(step)


def finish(required=()):
    steps = []
    try:
        with open(os.path.join(out_dir(), "steps.ndjson"), encoding="utf-8") as fh:
            steps = [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as ex:
        steps = [{"kind": "finish", "name": "steps.ndjson", "code": EVIDENCE, "why": "unreadable: {!r}".format(ex)}]
    seen = {s.get("name") for s in steps}
    # A required step that never recorded is missing evidence (12), unless an earlier step already failed and the
    # recipe stopped there: then it is a consequence, listed but not allowed to hide the real cause.
    failed_first = any(s.get("code") for s in steps)
    for name in required:
        if name not in seen:
            steps.append({"kind": "required", "name": name, "code": 0 if failed_first else EVIDENCE,
                          "skipped": failed_first,
                          "why": "not run after an earlier failure" if failed_first else "required step never recorded"})
    try:
        with open(os.path.join(out_dir(), "checker-errors.txt"), encoding="utf-8") as fh:
            errors = [line.strip() for line in fh if line.strip()]
    except FileNotFoundError:
        errors = []
    if errors:
        steps.append({"kind": "checker", "name": "checker-errors.txt", "code": EVIDENCE,
                      "why": "the checker failed: {}".format("; ".join(errors))[:1500], "evidence": ["checker-errors.txt"]})
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
    p.add_argument("--expect-ids", help="file listing every page id the set must report, one per line")
    p.add_argument("--goal", action="store_true", help="goal path: every page needs a goal result")
    s = sub.add_parser("suite")
    s.add_argument("name")
    s.add_argument("--log", required=True)
    s.add_argument("--exit", type=int, required=True)
    s.add_argument("--kind", choices=("vitest", "node-test", "tsc", "swift"), required=True)
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
    r.add_argument("--harness", choices=("h11", "h14", "rae"), required=True)
    r.add_argument("--run", required=True)
    r.add_argument("--rev", required=True)
    r.add_argument("--exit", type=int, required=True)
    r.add_argument("--options")
    r.add_argument("--rae-targets", metavar="DIR", help="RAE: the staged payload's tools/targets, the known target ids")
    r.add_argument("--spend-limit", type=float, required=True)
    la = sub.add_parser("laya")
    la.add_argument("name")
    la.add_argument("--exit", type=int, required=True)
    la.add_argument("--expected", type=int, required=True)
    ls = sub.add_parser("laya-score")
    ls.add_argument("name")
    ls.add_argument("--exit", type=int, required=True)
    ls.add_argument("--ckpts", nargs="+", required=True)
    vp = sub.add_parser("vm-proof")
    vp.add_argument("--exit", type=int, required=True)
    f = sub.add_parser("finish")
    f.add_argument("--require", nargs="*", default=[], help="step names that must have been recorded")
    args = parser.parse_args(argv)
    if args.cmd == "page-loop":
        return page_loop(args.name, args.exit, args.wrong_seen, args.expect_ids, args.goal)
    if args.cmd == "suite":
        return suite(args.name, args.log, args.exit, args.kind)
    if args.cmd == "prepare":
        return prepare(args.name, args.log, args.exit, args.fail_code)
    if args.cmd == "spend":
        return spend(args.day, args.from_line, args.limit, args.ledger_dir)
    if args.cmd == "r2":
        return r2(args.harness, args.run, args.rev, args.exit, args.options, args.spend_limit, args.rae_targets)
    if args.cmd == "vm-proof":
        return vm_proof(args.exit)
    if args.cmd == "laya":
        return laya(args.name, args.exit, args.expected)
    if args.cmd == "laya-score":
        return laya_score(args.name, args.exit, args.ckpts)
    return finish(args.require)


if __name__ == "__main__":
    sys.exit(main())
