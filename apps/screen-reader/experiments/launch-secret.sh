# Sourced by the experiment scripts that start caret-screen and the helper (B23). It makes one launch secret per run,
# held in an unexported shell variable, and `secret_bytes` writes it for a child's standard input: start both with
# `--auth-fd 0 < <(secret_bytes)`. printf is a shell builtin, so the secret is in no process's arguments or
# environment. The reader sends and acts on nothing until the helper proves it holds the same secret.
caret_launch_secret=$(head -c 32 /dev/urandom | xxd -p -c 64)
secret_bytes() { printf '%s' "$caret_launch_secret" | xxd -r -p; }
