"""Register a launchd job with the job's recovery owner before starting it.

  $CARET_HEAVY_REGISTER launchd LABEL

LABEL must start with $CARET_HEAVY_LAUNCHD_PREFIX. The recovery owner accepts the request only from a
process it already tracks as part of the job, and answers only after the registration is in its
journal; exit 0 then. Any other answer exits 1, and the caller must not start the job.
"""

import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I: the script's directory is not on sys.path
import recovery  # noqa: E402


def main(argv):
    if len(argv) != 2 or argv[0] != "launchd":
        print("usage: register.py launchd LABEL", file=sys.stderr)
        return 2
    label = argv[1]
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(os.environ["CARET_HEAVY_RECOVERY_SOCKET"])
        recovery.send(sock, {"op": "register", "resource": {"id": "launchd:" + label, "type": "launchd", "label": label}})
        got = recovery.Reader(sock).read()
    except (OSError, KeyError, ValueError) as ex:
        print("register.py: {!r}".format(ex), file=sys.stderr)
        return 1
    if got is None or not got[0].get("ok"):
        print("register.py: refused: {}".format(got and got[0].get("error")), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
