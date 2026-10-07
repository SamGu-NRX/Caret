"""Register a resource with the job's recovery owner before starting it.

  $CARET_HEAVY_REGISTER launchd LABEL     a launchd job, before `launchctl bootstrap`
  $CARET_HEAVY_REGISTER group PGID        a process group the caller made and is holding (rig.ts holds Chrome)

LABEL must start with $CARET_HEAVY_LAUNCHD_PREFIX. PGID's leader must be the caller's own child. The
recovery owner accepts the request only from a process it already tracks as part of the job, and
answers only after the registration is in its journal; exit 0 then. Any other answer exits 1, and the
caller must not start the resource.
"""

import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # run with -I: the script's directory is not on sys.path
import procs  # noqa: E402
import recovery  # noqa: E402


def main(argv):
    if len(argv) != 2 or argv[0] not in ("launchd", "group"):
        print("usage: register.py launchd LABEL | group PGID", file=sys.stderr)
        return 2
    if argv[0] == "launchd":
        resource = {"id": "launchd:" + argv[1], "type": "launchd", "label": argv[1]}
    else:
        pgid = int(argv[1])
        leader = recovery.identity(procs.DarwinProbes(), pgid)
        if leader is None or os.getpgid(pgid) != pgid:
            print("register.py: {} is not a live process group leader".format(pgid), file=sys.stderr)
            return 1
        resource = {"id": "group:{}:{}".format(*leader), "type": "group", "pgid": pgid, "leader": leader}
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(os.environ["CARET_HEAVY_RECOVERY_SOCKET"])
        recovery.send(sock, {"op": "register", "resource": resource})
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
