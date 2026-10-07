"""Score Laya's recorded logits on every field decision, zero-shot and calibrated, beside Jev and the canned key.

A field's outcome: right (filled with the key's value), wrong (filled with anything else, including any fill of a
field whose key wants it empty), abstained (left empty though the key has a value). A field whose key wants it empty
and stays empty counts in "empty kept" and in no other column. Fields the key does not score are skipped.

Laya decides a field as Caret's fill does with Jev: two wordings (A, and B with the options reversed) must name the
same value, and the lower of the two confidences must reach the cutoff. Confidence is the top option's probability
(laya_mlx answer_confidence) after temperature scaling. Zero-shot uses the checkpoint's shipped temperatures (clamped
to [0.5, 5] as upstream laya does since v0.3.5) and Caret's FILL_CUTOFF 0.75. Calibrated fits one temperature per
control type (text, menu, radio, checkbox, dropdown) on corpus-dev by log loss, then takes the lowest cutoff with 0
wrong on corpus-dev, and applies both unchanged to W4 and the two task sets.

Jev: its live answers to Caret's own two value questions (jev_fields.py), the same dual-ask gate at 0.75, then the
same code kind checks narrow.ts gave Laya (check.ts), so neither engine is credited with a check the other lacks.
Whose/owner gates and verifyWrites are left out for both.

  python3 score.py [ckpt ...]   -> score-<ckpt>.json and a table on stdout

Ported to ops/heavy from ~/.caret-run/evidence/screen/ly1 (recipes/laya.sh runs it): its data come from the job's
sealed inputs ($CARET_HEAVY_INPUTS/laya-data), the runs and the scores live under $CARET_HEAVY_OUT, and check.ts runs
from beside this file. Nothing else changed.
"""
import json
import math
import os
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).parent  # check.ts
DATA = Path(os.environ["CARET_HEAVY_INPUTS"]) / "laya-data"
OUT = Path(os.environ["CARET_HEAVY_OUT"])
FILL_CUTOFF = 0.75
DEV, HELD = "corpus-dev", ["w4", "tasks-blind", "tasks-labelled"]
SETS = [DEV] + HELD


def load(name):
    return [json.loads(l) for l in open(DATA / name)]


Q = {(q["set"], q["page"], q["descriptor"]): q for q in load("questions.jsonl")}
N = {(r["set"], r["page"], r["descriptor"]): r for r in load("narrowed.jsonl")}


def softmax(z, T):
    m = max(x / T for x in z)
    e = [math.exp(x / T - m) for x in z]
    s = sum(e)
    return [x / s for x in e]


def outcome(key, pick, right):
    if key == "value":
        return "abstained" if pick is None else ("right" if pick == right else "wrong")
    return "emptyKept" if pick is None else "wrong"


def table(rows):
    c = Counter(rows)
    return {k: c.get(k, 0) for k in ("right", "wrong", "abstained", "emptyKept")}


def laya_pick(f, run, T, cut, dual=True):
    """The value Laya fills, or None. T: temperature for this field."""
    texts = Q[f]["texts"]
    got = []
    for w in ("A", "B") if dual else ("A",):
        keys, z = run[w]["keys"], run[w]["logits"]
        p = softmax(z, T if T is not None else run[w]["shippedT"])
        i = max(range(len(p)), key=p.__getitem__)
        got.append((None if keys[i] == "none" else texts[keys[i]], p[i]))
    text = got[0][0]
    if text is None or any(t != text for t, _ in got):
        return None, min(c for _, c in got)
    return (text if min(c for _, c in got) >= cut else None), min(c for _, c in got)


def correct_index(f, keys):
    q = Q[f]
    if q["key"] == "value":
        hits = [i for i, k in enumerate(keys) if k != "none" and q["texts"][k] == q["rightText"]]
        if hits:
            return hits
    return [keys.index("none")]


def fit_temperatures(runs, fields):
    """One temperature per control type, by log loss over both wordings on the given fields."""
    by = defaultdict(list)
    for f in fields:
        if f in runs:
            for w in ("A", "B"):
                by[Q[f]["control"]].append((runs[f][w]["logits"], correct_index(f, runs[f][w]["keys"])))
    grid = [math.exp(x / 40) for x in range(-160, 121)]  # 0.018 .. 20
    out = {}
    for ctl, items in by.items():
        def nll(T):
            return -sum(math.log(max(1e-12, sum(softmax(z, T)[i] for i in idx))) for z, idx in items) / len(items)
        out[ctl] = min(grid, key=nll)
    return out


def score_engine(fields, pick_of):
    per = defaultdict(list)
    for f in fields:
        q = Q[f]
        if q["key"] == "unscored":
            continue
        per[q["set"]].append(outcome(q["key"], pick_of(f), q["rightText"]))
    return {s: table(per[s]) for s in SETS}


def jev_picks():
    J = {(r["page"], r["descriptor"]): r for r in load("jev-fields.jsonl")}
    reqs, keys = [], {}
    for f, q in Q.items():
        j = J.get((q["page"], q["descriptor"])) if q["set"] in ("corpus-dev", "w4") else None
        if j is None or j["pick"] is None:
            continue
        n = N[f]
        i = str(len(reqs))
        keys[i] = f
        reqs.append(json.dumps({"id": i, "control": q["control"], "descriptor": q["descriptor"], "label": n["label"], "nearest": n["nearest"], "placeholder": n["placeholder"], "text": j["pick"]}))
    out = subprocess.run(["node", str(HERE / "check.ts")], input="\n".join(reqs) + "\n", capture_output=True, text=True, check=True).stdout
    ok = {keys[r["id"]]: r["ok"] for r in map(json.loads, out.strip().splitlines())}
    picks = {}
    for f, q in Q.items():
        j = J.get((q["page"], q["descriptor"])) if q["set"] in ("corpus-dev", "w4") else None
        if j is not None:
            picks[f] = j["pick"] if j["pick"] is not None and ok.get(f, False) else None
    return picks


def auroc(scores, labels):
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 3)


def main(ckpts):
    jp = jev_picks()
    jev_fields = [f for f in Q if f in jp]
    report = {"jev": score_engine(jev_fields, lambda f: jp[f]), "jevFields": Counter(Q[f]["set"] for f in jev_fields if Q[f]["key"] != "unscored")}
    report["keyCeilingNarrowed"] = score_engine(list(Q), lambda f: Q[f]["rightText"] if Q[f]["key"] == "value" and Q[f]["rightText"] in Q[f]["texts"].values() else None)
    report["keyCeilingCaretOptions"] = score_engine(list(Q), lambda f: Q[f]["rightText"] if Q[f]["key"] == "value" else None)
    for ck in ckpts:
        path = OUT / "runs" / ("%s.jsonl" % ck)
        if not path.exists():
            print("no run for", ck)
            continue
        runs = {(r["set"], r["page"], r["descriptor"]): r for r in map(json.loads, open(path))}
        fields = list(Q)
        res = {}
        # Raw ability: how often the top option of wording A is the right one, on fields whose right value was offered.
        top = Counter()
        conf_right = ([], [])
        for f in fields:
            if f not in runs or Q[f]["key"] == "unscored":
                continue
            r = runs[f]["A"]
            idx = correct_index(f, r["keys"])
            p = softmax(r["logits"], r["shippedT"])
            i = max(range(len(p)), key=p.__getitem__)
            ok = i in idx
            top[(Q[f]["set"], Q[f]["key"], "offered" if Q[f]["key"] == "none" or r["keys"][idx[0]] != "none" else "notOffered", ok)] += 1
            conf_right[0].append(p[i])
            conf_right[1].append(ok)
        res["top1"] = {"%s|%s|%s|%s" % k: v for k, v in sorted(top.items())}
        res["auroc_top_prob"] = auroc(*conf_right)
        res["zeroShot"] = {
            "dual@0.75": score_engine(fields, lambda f: laya_pick(f, runs[f], None, FILL_CUTOFF)[0] if f in runs else None),
            "single@0.75": score_engine(fields, lambda f: laya_pick(f, runs[f], None, FILL_CUTOFF, dual=False)[0] if f in runs else None),
            "dual@argmax": score_engine(fields, lambda f: laya_pick(f, runs[f], None, 0.0)[0] if f in runs else None),
        }
        temps = fit_temperatures(runs, [f for f in fields if f[0] == DEV and Q[f]["key"] != "unscored"])
        res["temperatures"] = temps
        for dual in (True, False):
            # Lowest cutoff with 0 wrong on corpus-dev.
            worst = 0.0
            for f in fields:
                if f[0] != DEV or f not in runs or Q[f]["key"] == "unscored":
                    continue
                T = temps.get(Q[f]["control"], 1.0)
                pick, conf = laya_pick(f, runs[f], T, 0.0, dual)
                if pick is not None and outcome(Q[f]["key"], pick, Q[f]["rightText"]) == "wrong":
                    worst = max(worst, conf)
            cut = min(1.0, worst + 1e-6)
            name = "dual" if dual else "single"
            res["calibrated_" + name] = {
                "cutoff": round(cut, 6),
                "score": score_engine(fields, lambda f: laya_pick(f, runs[f], temps.get(Q[f]["control"], 1.0), cut, dual)[0] if f in runs else None),
            }
        report[ck] = res
        (OUT / ("score-%s.json" % ck)).write_text(json.dumps(res, indent=1))
    (OUT / "score.json").write_text(json.dumps(report, indent=1, default=dict))
    fmt = lambda t: "%d / %d / %d (+%d empty kept)" % (t["right"], t["wrong"], t["abstained"], t["emptyKept"])
    print("set:", " | ".join(SETS))
    print("canned key over Caret's options:", " | ".join(fmt(report["keyCeilingCaretOptions"][s]) for s in SETS))
    print("canned key over the <=8 narrowed options (Laya's ceiling):", " | ".join(fmt(report["keyCeilingNarrowed"][s]) for s in SETS))
    print("Jev live, value question + code checks:", " | ".join(fmt(report["jev"][s]) for s in SETS), dict(report["jevFields"]))
    for ck in ckpts:
        if ck not in report:
            continue
        r = report[ck]
        for k, v in r["zeroShot"].items():
            print("%s zero-shot %s:" % (ck, k), " | ".join(fmt(v[s]) for s in SETS))
        for k in ("calibrated_dual", "calibrated_single"):
            print("%s %s cut %.4f:" % (ck, k, r[k]["cutoff"]), " | ".join(fmt(r[k]["score"][s]) for s in SETS))
        print("%s temperatures %s auroc %s" % (ck, {k: round(v, 3) for k, v in r["temperatures"].items()}, r["auroc_top_prob"]))


if __name__ == "__main__":
    main(sys.argv[1:] or ["laya", "typed-decisions", "multilingual"])
