# Sourced by the experiment scripts that start caret-screen and the helper (B23). It makes one launch secret per run,
# held in an unexported shell variable, and `secret_bytes` writes it for a child's standard input: start both with
# `--auth-fd 0 < <(secret_bytes)`. printf is a shell builtin, so the secret is in no process's arguments or
# environment. The reader sends and acts on nothing until the helper proves it holds the same secret.
caret_launch_secret=$(head -c 32 /dev/urandom | xxd -p -c 64)
secret_bytes() { printf '%s' "$caret_launch_secret" | xxd -r -p; }
# The host key, HMAC-SHA256(secret, "caret-host-key") as helper/src/host-auth.ts derives it, for a script that must be
# the helper's host: the helper sends proposals only to a consumer that proves it. Pass it on a pipe, never a file:
# `--host-key-fd 3 3< <(host_key_bytes)`. The secret reaches node on standard input, so it is on no argv.
host_key_bytes() {
  secret_bytes | node --input-type=module -e 'import { createHmac } from "node:crypto"; const c = []; for await (const b of process.stdin) c.push(b); const s = Buffer.concat(c); if (s.length !== 32) throw new Error(`a launch secret is 32 bytes, not ${s.length}`); process.stdout.write(createHmac("sha256", s).update("caret-host-key", "utf8").digest());'
}
