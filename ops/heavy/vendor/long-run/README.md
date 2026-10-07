# Vendored long-run rig files

Copies of the live files in `~/.long-run/bin` and `~/.long-run/rig/bin`, which are not under git and which every run on this Mac uses. Changes for Caret's heavy jobs are made and tested here first. The coordinator approves installing any change that alters admission for other runs.

Installed state when vendored (2026-10-07): the live files match these copies. Pre-change originals are in `~/.long-run/backup/20261007-q2-lease-owner/` with SHA256SUMS. `diff -r` this directory against the live paths to see what is not installed.

Run the lease tests against this copy: `cd ops/heavy/vendor/long-run/bin && node --test lr-lease.test.mjs` (the test reads `../lease-policy.json` relative to itself, so copy the live policy beside `bin/` first, as `tests` does, or run it in a temporary tree).
