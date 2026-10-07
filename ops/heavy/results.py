"""The evidence adapter: does a recipe's result.json belong to this job, and is it fresh?

Pass or fail is the recipe's own exit code (ops/heavy/README.md); recipes/check.py computes it and
writes result.json. This adapter only checks that the evidence can be trusted as this run's:
result.json exists and parses, names this job ID, this plan's SHA-256 and this recipe, reports
the exit code the recipe actually returned, and lists evidence files that are regular files
inside the run's fresh output directory, written after the recipe started.
"""

import json
import os
import stat

SCHEMA = 1
# File times have whole-second resolution on some paths; allow that much before the recipe's start.
CLOCK_SLACK_S = 1.0


def validate(plan, plan_digest, out_dir, started_wall, recipe_exit):
    """Problems with the recipe's evidence, as sentences; empty when it can be trusted."""
    path = os.path.join(out_dir, "result.json")
    try:
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode):
            return ["result.json is not a regular file"]
        with open(path, encoding="utf-8") as fh:
            result = json.load(fh)
    except FileNotFoundError:
        return ["result.json is missing"]
    except (OSError, ValueError) as ex:
        return ["result.json is unreadable: {}".format(ex)]
    if not isinstance(result, dict):
        return ["result.json is not an object"]
    problems = []
    if st.st_mtime < started_wall - CLOCK_SLACK_S:
        problems.append("result.json predates this run")
    expected = {"schema": SCHEMA, "job_id": plan["job_id"], "plan_sha256": plan_digest,
                "recipe": plan["recipe"]["name"], "exit": recipe_exit}
    for key, want in expected.items():
        if result.get(key) != want:
            problems.append("result.json {} is {!r}, expected {!r}".format(key, result.get(key), want))
    evidence = result.get("evidence")
    if not isinstance(evidence, list) or (recipe_exit == 0 and not evidence):
        problems.append("result.json lists no evidence files")
        evidence = []
    root = os.path.realpath(out_dir)
    for rel in evidence:
        if not isinstance(rel, str) or os.path.isabs(rel):
            problems.append("evidence entry {!r} is not a relative path".format(rel))
            continue
        full = os.path.join(out_dir, rel)
        if not os.path.realpath(full).startswith(root + os.sep):
            problems.append("evidence {} is outside the run's output directory".format(rel))
            continue
        try:
            est = os.lstat(full)
        except FileNotFoundError:
            problems.append("evidence {} is missing".format(rel))
            continue
        if not stat.S_ISREG(est.st_mode):
            problems.append("evidence {} is not a regular file".format(rel))
        elif est.st_mtime < started_wall - CLOCK_SLACK_S:
            problems.append("evidence {} predates this run".format(rel))
    return problems
