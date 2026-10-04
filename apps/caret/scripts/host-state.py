#!/usr/bin/env python3
"""Query the Caret host's debug socket.

Usage:
  host-state.py [command]                 print the reply (default command: state)
  host-state.py wait-offer [timeout_s]    poll until an offer exists; print it; exit 1 on timeout
  host-state.py wait-insertion ID [timeout_s]
                                          poll until lastInsertion.claimID > ID; print it

The socket path is $CARET_HOST_SOCKET or ~/.caret-run/sockets/host.sock.
"""
import json
import os
import socket
import sys
import time

PATH = os.environ.get("CARET_HOST_SOCKET") or os.path.expanduser("~/.caret-run/sockets/host.sock")


def ask(command: str = "state") -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5.0)
        s.connect(PATH)
        s.sendall((command + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        chunks = []
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return json.loads(b"".join(chunks))


def poll(predicate, timeout: float) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = ask()
        found = predicate(state)
        if found is not None:
            return found
        time.sleep(0.05)
    return None


def main() -> int:
    args = sys.argv[1:]
    command = args[0] if args else "state"
    if command == "wait-offer":
        timeout = float(args[1]) if len(args) > 1 else 10.0
        offer = poll(lambda s: s.get("offer"), timeout)
        print(json.dumps(offer, indent=2, sort_keys=True))
        return 0 if offer else 1
    if command == "wait-insertion":
        after = int(args[1])
        timeout = float(args[2]) if len(args) > 2 else 5.0
        insertion = poll(
            lambda s: s["lastInsertion"] if s.get("lastInsertion") and s["lastInsertion"]["claimID"] > after else None,
            timeout,
        )
        print(json.dumps(insertion, indent=2, sort_keys=True))
        return 0 if insertion else 1
    print(json.dumps(ask(command), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
