# Q2's key leak scan, used in the guest (job.sh) and on the host (run.sh).
#   printf '%s\n' "$KEY"... | python3 leakscan.py DIR
# Keys come on stdin, never argv. Looks for each key, and its first and last 16 characters, as UTF-8 and UTF-16 in
# every file's bytes and in every file and directory name. Prints "SCANNED N", then one hit path per line. Exits
# non-zero when it could not finish (no keys, a directory it can't walk, a file it can't read), so a failure never
# reads as clean. It can't see a key drawn into a screenshot's pixels.
import os
import sys

keys = [k for k in sys.stdin.read().split("\n") if k]
if not keys:
    sys.exit("leak check: no keys given")
needles = set()
for k in keys:
    for part in {k, k[:16], k[-16:]}:
        needles.update({part.encode(), part.encode("utf-16-le"), part.encode("utf-16-be")})


def walk_error(e):
    sys.exit(f"leak check: cannot walk: {e}")


hits, n = [], 0
for root, dirs, files in os.walk(sys.argv[1], onerror=walk_error):
    for name in dirs + files:
        if any(x in os.fsencode(name) for x in needles):
            hits.append(os.path.join(root, name))
    for f in files:
        p = os.path.join(root, f)
        if os.path.islink(p):
            continue
        with open(p, "rb") as fh:
            data = fh.read()
        n += 1
        if any(x in data for x in needles):
            hits.append(p)
print(f"SCANNED {n}")
print("\n".join(sorted(set(hits))))
