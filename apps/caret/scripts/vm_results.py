#!/usr/bin/env python3
"""One line saying whether a VM walk passed, from its results.json, for a rig job's summary.

  vm_results.py <results.json> [--transcript FILE] [--expect CASE ...]

Pass needs all of: the file exists; the walk reached its end (`complete`) with no exception; every
planned case finished (`done`), and so did every `--expect` case; every check passed. Otherwise
the line says what is missing, first the reason the walk stopped. Interrupted attempts that a retry
recovered are named either way. With no results.json the line says the walk aborted and quotes
the transcript's last error line. Exit 0 on pass, 1 otherwise.

V1a's job printed the transcript's last line for check 7, which was blank after a traceback, and
treated the walk's exit status as the whole story.
"""
import argparse
import json
import os
import sys


def interruptions_text(items):
    return "; ".join(f"{i['case']} ({i['command']}: sent {i['sent']} of {i['of']}, focus {i['focus']})" for i in items)


def verdict(results, expect=()):
    """(passed, line) for a parsed results.json, or for None when it is missing."""
    if results is None:
        return False, "fail: walk aborted; results missing"
    problems = []
    exception = results.get("exception")
    if exception:
        problems.append(f"exception in {exception.get('case')}: {exception.get('error')}")
    if not results.get("complete"):
        problems.append("walk did not reach its end")
    done = set(results.get("done") or [])
    planned = list(results.get("planned") or [])
    missing = [c for c in planned + [e for e in expect if e not in planned] if c not in done]
    if missing:
        problems.append("cases not finished: " + ", ".join(missing))
    checks = results.get("checks") or []
    failed = [c["check"] for c in checks if not c.get("ok")]
    if failed:
        problems.append(f"{len(failed)} failed: " + "; ".join(failed[:4]) + ("; ..." if len(failed) > 4 else ""))
    if not checks:
        problems.append("no checks recorded")
    interrupted = results.get("interruptions") or []
    tail = f"; interrupted attempts: {interruptions_text(interrupted)}" if interrupted else ""
    if problems:
        return False, "fail: " + "; ".join(problems) + tail
    return True, f"pass: {len(checks)}/{len(checks)} checks, {len(done)} cases" + tail


def last_error(transcript):
    try:
        lines = [l.strip() for l in open(transcript, errors="replace") if l.strip()]
    except OSError:
        return None
    for line in reversed(lines):
        if "Error" in line or "error" in line or "Traceback" in line:
            return line
    return lines[-1] if lines else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("results")
    p.add_argument("--transcript")
    p.add_argument("--expect", nargs="*", default=[])
    a = p.parse_args()
    results = None
    if os.path.exists(a.results):
        try:
            results = json.load(open(a.results))
        except json.JSONDecodeError as e:
            print(f"fail: results.json unreadable: {e}")
            sys.exit(1)
    ok, line = verdict(results, a.expect)
    if results is None and a.transcript:
        error = last_error(a.transcript)
        if error:
            line += f"; last error: {error[:300]}"
    print(line)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
