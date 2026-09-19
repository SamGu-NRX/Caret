#!/usr/bin/env python3
"""Drive the real bridge process end to end with synthetic input.

This is the runnable proof that the pieces connect: a context frame goes in
over a pipe, a judge selects a route, a writer or a workflow produces a
proposal, an acceptance comes back with a structured result, and a second
acceptance of the same proposal is refused.

Everything it types is invented here in this file. It does not read the
clipboard, the screen, mail or any real field.

    python3 scripts/caret_bridge_example.py                            # no keys, no network
    python3 scripts/caret_bridge_example.py --providers live-jev-groq  # both product keys
    python3 scripts/caret_bridge_example.py --providers live-gateway   # one Gateway key

Only a live run proves anything about the providers. The default run proves the
transport, the scheduling rules and the workflow seam.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from queue import Empty, Queue

ROOT = Path(__file__).resolve().parent.parent

SCRIPTS = {
    "inline": {"route": ["INLINE"], "inline": ["everyone on the thread by Friday."]},
    "action": {"route": ["ACTION"], "workflow": ["book-calendar-link"]},
}

# Each live mode names the providers it selects and the variables they need. The
# gateway mode exists so the whole loop can run on one key: Jev stays the product
# judge, and the Gateway judge is an LLM classifier standing in for it.
PROVIDERS = {
    "scripted": {"judge": None, "writer": None, "env": ()},
    "live-jev-groq": {"judge": "jev", "writer": "groq", "env": ("TYPESAFE_API_KEY", "GROQ_API_KEY")},
    "live-gateway": {"judge": "gateway", "writer": "gateway", "env": ("AI_GATEWAY_API_KEY",)},
}


def synthetic_frame(revision: int, *, text: str, element: str = "compose-1", captured_at=None) -> dict:
    """A made-up editor window. No real application is observed."""
    now = captured_at or datetime.now(timezone.utc)
    return {
        "snapshot": {
            "revision": revision,
            "captured_at": now.isoformat(),
            "target": {
                "pid": 4242,
                "bundle_id": "com.example.SyntheticEditor",
                "window_id": "window-1",
                "element_id": element,
                "element_revision": f"v{revision}",
            },
            "role": "AXTextArea",
            "nearby_text": text,
            "text_offset": 0,
            "caret": len(text.encode("utf-16-le")) // 2,
            "selection": {},
            "secure": False,
            "ime_composing": False,
            "app_excluded": False,
        },
        "permissions": {"accessibility": True},
        "clipboard": {
            "available": True,
            "text": "Austin to Dallas, Tuesday",
            "captured_at": now.isoformat(),
        },
        "history": [
            {
                "source_id": "synthetic-history-1",
                "captured_at": (now - timedelta(seconds=45)).isoformat(),
                "text": "Viewed a synthetic scheduling thread about a Dallas meeting.",
                "app": "com.example.SyntheticMail",
            }
        ],
        "observations": [],
        "sources": [
            {"name": "screenpipe", "available": True, "captured_at": (now - timedelta(seconds=45)).isoformat()},
            {"name": "computer-use", "available": False, "detail": "No executor connected in this slice"},
        ],
        "workflow_active": False,
    }


class BridgeClient:
    """Minimal client: correlated replies on one queue, events on another."""

    def __init__(self, process: subprocess.Popen) -> None:
        self.process = process
        self.replies: Queue = Queue()
        self.events: Queue = Queue()
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            message = json.loads(line)
            (self.replies if "id" in message else self.events).put(message)

    def call(self, method: str, params: dict | None = None, timeout: float = 20.0) -> dict:
        request = {"id": int(time.time() * 1000) % 100000, "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(request) + "\n")
        self.process.stdin.flush()
        return self.replies.get(timeout=timeout)

    def next_event(self, timeout: float = 20.0) -> dict | None:
        try:
            return self.events.get(timeout=timeout)
        except Empty:
            return None

    def drain_events(self, timeout: float = 0.3) -> list[dict]:
        seen = []
        while True:
            try:
                seen.append(self.events.get(timeout=timeout))
            except Empty:
                return seen


def show(label: str, payload) -> None:
    print(f"\n--- {label} ---")
    print(json.dumps(payload, indent=2)[:1400])


def run_scenario(name: str, providers: str, workdir: Path) -> bool:
    print(f"\n{'=' * 70}\nSCENARIO: {name} ({providers})\n{'=' * 70}")
    command = [
        sys.executable,
        "-m",
        "caret.bridge",
        "--fixture",
        str(ROOT / "fixtures" / "meeting.json"),
        "--db",
        str(workdir / f"{name}.sqlite"),
        "--interval",
        "0.2",
    ]
    selected = PROVIDERS[providers]
    if selected["judge"]:
        command += ["--judge", selected["judge"], "--writer", selected["writer"]]
    else:
        script = workdir / f"{name}.json"
        script.write_text(json.dumps(SCRIPTS[name]))
        command += ["--judge", f"scripted:{script}", "--writer", f"scripted:{script}"]

    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        bufsize=1,
    )
    client = BridgeClient(process)
    try:
        hello = client.call("hello")
        show("hello: registered workflows and their availability", hello["result"])

        # Phase 1. Three updates inside one interval. Only the newest is asked
        # about; the earlier two are coalesced rather than queued, and any offer
        # built from an older one is invalidated as soon as the text moves on.
        admissions = []
        for revision, text in enumerate(
            ["I will send ", "I will send the ", "I will send the summary to "], start=1
        ):
            admissions.append(client.call("context.update", {"frame": synthetic_frame(revision, text=text)}))
            time.sleep(0.02)
        show("context.update x3 inside one interval", [reply["result"] for reply in admissions])
        show(
            "events while the text kept moving",
            [{key: event.get(key) for key in ("event", "revision", "reason")} for event in client.drain_events(0.8)],
        )

        # Phase 2. The user stops typing. This frame stays current, so its offer
        # survives long enough to be accepted.
        settled = 10
        client.call(
            "context.update",
            {"frame": synthetic_frame(settled, text="I will send the summary to the team and cc ")},
        )
        event = None
        deadline = time.time() + 20
        while time.time() < deadline:
            event = client.next_event(timeout=5.0)
            if event is None:
                break
            if event.get("event") in ("offer", "abstain", "failed") and event.get(
                "offer", {"revision": event.get("revision")}
            ).get("revision", event.get("revision")) == settled:
                break
        if not event:
            print("\nNo evaluation event arrived for the settled frame.")
            return False
        show("evaluation event for the settled frame", event)

        if event["event"] != "offer":
            print(f"\nNo offer to accept ({event['event']}: {event.get('reason')}).")
            return event["event"] == "abstain"

        offer = event["offer"]
        accepted = client.call(
            "offer.accept",
            {"proposal_id": offer["proposal_id"], "revision": offer["revision"], "target": offer["target"]},
        )
        show("offer.accept -> structured result", accepted)

        repeat = client.call(
            "offer.accept",
            {"proposal_id": offer["proposal_id"], "revision": offer["revision"], "target": offer["target"]},
        )
        show("the same acceptance a second time", repeat)
        if repeat.get("ok"):
            print("\nFAIL: a repeated acceptance was allowed to execute again.")
            return False

        client.drain_events()
        return bool(accepted.get("ok"))
    finally:
        try:
            client.call("shutdown", timeout=5.0)
        except Exception:
            pass
        try:
            process.stdin.close()
        except Exception:
            pass
        process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--providers",
        choices=sorted(PROVIDERS),
        default="scripted",
        help="'scripted' needs no keys and makes no network call. 'live-jev-groq' calls the "
        "product providers and needs TYPESAFE_API_KEY and GROQ_API_KEY. 'live-gateway' runs both "
        "the judge and the writer through Vercel AI Gateway and needs only AI_GATEWAY_API_KEY.",
    )
    args = parser.parse_args()

    required = PROVIDERS[args.providers]["env"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        print(
            f"--providers {args.providers} needs {', '.join(missing)}. "
            "Refusing to substitute a scripted provider."
        )
        return 2
    if required:
        print(f"Running against live providers ({args.providers}) with synthetic input.")
    else:
        print("Running with scripted providers. This proves the transport, not the providers.")

    with tempfile.TemporaryDirectory() as directory:
        workdir = Path(directory)
        results = {name: run_scenario(name, args.providers, workdir) for name in SCRIPTS}

    print(f"\n{'=' * 70}")
    for name, ok in results.items():
        print(f"{name:10s} {'ok' if ok else 'FAILED'}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
