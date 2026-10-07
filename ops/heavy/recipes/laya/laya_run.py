"""Run Laya checkpoints on the reshaped field questions and time single requests, without putting weights on disk.

Disk was under the brief's 12 GiB floor (11.1 GiB free at 19:30 CDT), so each checkpoint's model.safetensors is
streamed from Hugging Face into memory, checked against the repository's SHA-256, and handed to laya-mlx (an MLX port
of upstream laya, which matched upstream's answers on 63/63 validation questions in FP32 and FP16) through mx.load on
a BytesIO. Only the small config and tokenizer files live on disk, in ~/.caret-run/models/laya/src.

For every shaped field it records the raw option logits of both wordings (A and B), so scoring can apply any
temperature afterwards (score.py). It also times one request = one field's wording-A question through the same path
laya's system_one takes (tokenize, build the sequence, one forward pass, softmax), on the GPU in float16 and on the
CPU in float32.

  ./run-env.sh laya_run.py --ckpt laya|multilingual|typed-decisions [--latency N]
Writes runs/<ckpt>.jsonl (one line per field), runs/<ckpt>-latency.json and runs/<ckpt>-sanity.json.

Ported to ops/heavy from ~/.caret-run/evidence/screen/ly1 (recipes/laya.sh runs it): its data, model config and
weight digests come from the job's sealed inputs ($CARET_HEAVY_INPUTS/laya-data, laya-src), and runs/ goes under
$CARET_HEAVY_OUT. Nothing else changed.
"""
import argparse
import hashlib
import io
import json
import os
import time
import urllib.request
from pathlib import Path

import mlx.core as mx
import numpy as np

import laya_mlx.agent as la
from laya_mlx.common import answer_confidence, clamp_temperature, confidence_from_probs, temp_bucket

DATA = Path(os.environ["CARET_HEAVY_INPUTS"]) / "laya-data"
SRC = Path(os.environ["CARET_HEAVY_INPUTS"]) / "laya-src"
REV = "7b928d828b7b0e022f929d9bd2e44165aa270148"
SUB = {"laya": "", "multilingual": "multilingual/", "typed-decisions": "typed-decisions/"}
SHA = {line.split()[0]: line.split()[1] for line in (DATA / "weights-sha256.txt").read_text().splitlines()}

ap = argparse.ArgumentParser()
ap.add_argument("--ckpt", required=True, choices=list(SUB))
ap.add_argument("--latency", type=int, default=100, help="requests timed per device (after 10 warm-up requests)")
args = ap.parse_args()
OUT = Path(os.environ["CARET_HEAVY_OUT"]) / "runs"
OUT.mkdir(exist_ok=True)


def log(msg):
    print("%s %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


# ---- weights into memory ----
name = SUB[args.ckpt] + "model.safetensors"
url = "https://huggingface.co/convaiinnovations/laya/resolve/%s/%s" % (REV, name)
t0 = time.time()
with urllib.request.urlopen(url) as resp:
    blob = resp.read()
digest = hashlib.sha256(blob).hexdigest()
if digest != SHA[name]:
    raise SystemExit("sha256 mismatch for %s: got %s, want %s" % (name, digest, SHA[name]))
log("fetched %s into memory: %.0f MB in %.0f s, sha256 ok" % (name, len(blob) / 1e6, time.time() - t0))

model_dir = SRC / SUB[args.ckpt].rstrip("/") if SUB[args.ckpt] else SRC
_orig_load = mx.load


def _load(f, *a, **k):
    if str(f).endswith("model.safetensors"):
        return _orig_load(io.BytesIO(blob), format="safetensors")
    return _orig_load(f, *a, **k)


mx.load = _load
la.resolve_model = lambda *a, **k: model_dir


def agent(device, dtype):
    return la.Agent(str(model_dir), device=device, dtype=dtype, batch_size=8)


def probs(logits, k, T):
    z = np.asarray(logits[:k], dtype=np.float64) / T
    p = np.exp(z - z.max())
    return p / p.sum()


def run_fields(ag, limit=None):
    """Raw logits for both wordings of every field this checkpoint's budget fits."""
    rows = []
    for line in open(DATA / "questions.jsonl"):
        if limit is not None and len(rows) >= limit:
            break
        r = json.loads(line)
        sh = r["shaped"].get(args.ckpt)
        if sh is None or "misfit" in sh:
            continue
        items, internal = ag.prepare(sh["state"], {"A": sh["qA"], "B": sh["qB"]})
        if any(it["state_stats"]["truncated"] for it in items):
            raise SystemExit("build.py said this fits but laya-mlx truncated it: %s %s" % (r["page"], r["descriptor"]))
        batch = la.collate_items(items, ag.tok.pad_token_id)
        logits, act = ag.forward(batch)
        logits, act = np.asarray(logits.astype(mx.float32)), np.asarray(act.astype(mx.float32))
        out = {"set": r["set"], "page": r["page"], "descriptor": r["descriptor"], "tokens": [len(it["ids"]) for it in items]}
        for row, (qid, q) in enumerate(zip(("A", "B"), internal)):
            keys = list(q["crit"])
            k = len(keys)
            T = clamp_temperature(ag.temperature_by_options_raw.get(temp_bucket(0, k), ag.temperature_raw[0]))
            p = probs(logits[row], k, T)
            out[qid] = {
                "keys": keys,
                "logits": [round(float(x), 5) for x in logits[row, :k]],
                "shippedT": T,
                "choice": keys[int(p.argmax())],
                "answerConfidence": round(answer_confidence(p, k), 4),
                "entropyConfidence": round(confidence_from_probs(p, k), 4),
                "actProbability": round(float(np.exp(act[row, 0]) / np.exp(act[row]).sum()), 4),
            }
        rows.append(out)
    return rows


def sanity(ag):
    """laya's own README example: billing at about 0.94 on the English checkpoint."""
    return ag.system_one(
        "I was billed twice. Please refund the duplicate today.",
        {"department": {"type": "choice", "instructions": "Which team should handle this request?", "criteria": {"billing": "invoices, payments, refunds", "technical": "bugs and outages", "sales": "new purchases"}}},
    )["answers"]


def latency(ag, n):
    qs = []
    for line in open(DATA / "questions.jsonl"):
        r = json.loads(line)
        sh = r["shaped"].get(args.ckpt)
        if sh is not None and "misfit" not in sh:
            qs.append((sh["state"], sh["qA"], sh["tokens"]))
    times = []
    for i in range(n + 10):
        state, q, _ = qs[i % len(qs)]
        t = time.perf_counter()
        ag.system_one(state, {"q": q})
        if i >= 10:
            times.append((time.perf_counter() - t) * 1000)
    times.sort()
    pick = lambda f: times[min(len(times) - 1, int(f * len(times)))]
    return {"n": n, "p50": round(pick(0.5), 1), "p95": round(pick(0.95), 1), "max": round(times[-1], 1), "meanTokens": round(sum(x[2] for x in qs[:n]) / min(n, len(qs)), 1)}


res = {"ckpt": args.ckpt, "rev": REV, "mlx": mx.__version__ if hasattr(mx, "__version__") else None}
t0 = time.time()
gpu = agent("gpu", "float16")
res["loadGpuS"] = round(time.time() - t0, 1)
res["cfg"] = {k: gpu.cfg.get(k) for k in ("max_len", "head_max_len", "encoder")}
(OUT / ("%s-sanity.json" % args.ckpt)).write_text(json.dumps(sanity(gpu), indent=1))
t0 = time.time()
rows = run_fields(gpu)
log("eval: %d fields x 2 wordings on GPU fp16 in %.1f s" % (len(rows), time.time() - t0))
with open(OUT / ("%s.jsonl" % args.ckpt), "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
res["gpu_fp16"] = latency(gpu, args.latency)
log("GPU fp16 latency %s" % res["gpu_fp16"])
del gpu
mx.clear_cache()
cpu = agent("cpu", "float32")
res["cpu_fp32"] = latency(cpu, max(20, args.latency // 4))
log("CPU fp32 latency %s" % res["cpu_fp32"])
# fp16 and fp32 should pick the same option; check a sample on the CPU model.
sample = run_fields(cpu, limit=60)
agree = sum(a["A"]["choice"] == b["A"]["choice"] for a, b in zip(sample, rows[:60]))
res["fp32VsFp16ChoiceAgreement"] = "%d/%d" % (agree, len(sample))
del cpu
blob = None
(OUT / ("%s-latency.json" % args.ckpt)).write_text(json.dumps(res, indent=1))
log("done %s" % json.dumps(res))
