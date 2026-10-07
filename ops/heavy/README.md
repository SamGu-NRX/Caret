# Caret heavy jobs on the shared queue

This directory is how Caret's heavy jobs (browser evals, the helper suite, Swift builds, R2's VM runs) go through the shared heavy-job queue at `/Users/samgu/Programming Projects/agent-heavy-job-queue-20261001/scripts/heavy-job-queue.py`. It replaces `~/.caret-run/queue/caret-heavy.sh`, which a review found unsafe to commission (STATE.md, "WRAPPER REVIEW (a221c41d) DISPOSITION").

Enqueueing records a job and returns. A queue runner, started separately, runs it. No job runs while `~/.caret-run/HOLD` exists.

## Commission a job

```sh
H='/Users/samgu/Programming Projects/caret-ops-heavy/ops/heavy/caret-heavy'
"$H" enqueue RECIPE caret-UNIQUE-ID --worktree /clean/worktree --rev FULL-SHA [recipe options]
"$H" status                     # runner, slot, and each Caret job's executed / validated / accepted
"$H" show caret-UNIQUE-ID       # outcome and evidence directory
"$H" accept caret-UNIQUE-ID --note "what the lead checked"
"$H" prune caret-UNIQUE-ID      # after a job has finished: delete its sealed input copies
```

Commit ops/heavy before enqueueing. Enqueue copies ops/heavy at HEAD of this checkout and refuses uncommitted changes under it. A job ID is used once. After any failure, enqueue again under a new ID.

Live recipes take the key file's path from `--env-file` or `CARET_ENV_FILE`. The plan records the path. Nothing in this directory opens the file except R2's feeder, which reads it on the host to hand the key to the guest.

## What a job is

Each job gets its own read-only directory, `~/.caret-run/queue/ops/jobs/<id>/`, made at enqueue:
- `ops/heavy/`: this directory at the committed HEAD (git archive). The supervisor and recipes run from here.
- `inputs/`: a clone (APFS clonefile, so no extra disk until a source changes) of every input git does not cover: the bridge build and Chrome for Testing, W4's saved pages, answer key, note and owners (the corpus set reads them from `~/.caret-run/evidence/browser/w4` by default), held-out pages, R2's ignored build inputs, and a staged VM job. Recipes read only these copies, never the shared paths, so a source changed after enqueue cannot reach the job.
- `plan.json`: the recipe and its arguments, the profile, the SHA-256 of every `ops/heavy` file, and a content manifest of every sealed input.

The queue job's argv carries the plan's SHA-256 and a short inline check. Before anything else runs, that check refuses the job (exit 65) if the plan, any `ops/heavy` file, or the set of those files changed. The supervisor checks the `ops/heavy` files, every sealed input and the worktree pin again on start, and once more after admission, immediately before it spawns the recipe, since the lease wait can last up to half an hour. Any change refuses the job (65). The queue itself pins the worktree (`--repo`, `--expect-rev`; never `--unpinned`) and rechecks it just before release.

A tree's digest covers every directory (an added empty one changes it), every file's content and executable bit, and every symlink's target text. A symlink that points out of its tree, or at nothing, is refused, so content the digest never read cannot stand in for an input. Held-out pages are a sealed tree: the record and every message carry only the digest, file count and byte count, never a name. A VM payload's `REV` must equal the job's pin. Its `CONFIG` and `spend-control.json` are left out of the digest, because vm.sh writes them at run time from the plan's arguments and the host's ledger.

Every Python a job starts runs with `-I -B -X pycache_prefix=/var/empty`, or with `PYTHONDONTWRITEBYTECODE=1 PYTHONPYCACHEPREFIX=/var/empty` in its environment when it is not isolated, so it neither writes bytecode nor reads a `.pyc` planted beside a sealed module.

## Who holds what

The queue's command is a relay that stays in the queue's process group. It starts the supervisor in a new session and hands it the queue's locked `slot.lock` descriptor. The relay forwards the queue's SIGTERM as one byte on a pipe. The supervisor reads end-of-file on that pipe as the relay's death. Either way it stops the job, finishes cleanup, and only then exits. The slot stays held until it exits, so the queue's SIGKILL of the relay 10 s after SIGTERM cuts no cleanup short.

### Custody: the recovery owner

Design: Astra's, `~/.caret-run/design/ops/ASTRA-Q3-design.md`. Before any lease or workload, the supervisor starts a launchd agent for this attempt (`recovery.py`, label `caret-heavy-recovery.<job>.<attempt prefix>`, KeepAlive on an unsuccessful exit) and sends it copies of the locked slot.lock and heavy.lock descriptors over a Unix socket (SCM_RIGHTS), with the attempt's secret token. The agent checks each descriptor holds its lock, writes the adoption to its journal (`<evidence>/recovery/journal.ndjson`, fsync before every reply, never the token), and only then answers. The agent lives outside the queue's group and the supervisor's process tree, so neither the queue's SIGKILL nor mem-guard's escalation through the supervisor's tree reaches it.

Resources are registered before they start. The recipe is held by a trampoline until its process group (leader pid and start time), the job's environment marker and its launchd label prefix are journalled; a cancellation that arrives first denies the release. A recipe that starts a launchd job registers its exact label first with `$CARET_HEAVY_REGISTER launchd LABEL`, and a process group it holds back with `$CARET_HEAVY_REGISTER group PGID` (`register.py`). The agent accepts either only from a process it already tracks as the job's: a label only under the job's prefix, a group only when its leader is a live child of one of the job's processes. The browser evals do both through `fixtures/web-form/rig.ts` on branch `ops/heavy-browser` (from v2/next 72a4b26, awaiting its merge): the test host's label carries the job's prefix and is registered before `launchctl bootstrap`, Chrome for Testing is held in a shell until its group is registered, and Chrome's stop waits for its whole group rather than its leader. `tests/test_rig_ts.py` checks that branch's rig.ts.

Every probe answers ABSENT, PRESENT or UNKNOWN (`procs.py`): a failed or unrecognised listing, a timeout, a permission error or a malformed `lr-lease status` is UNKNOWN, never an empty answer. Group members are known by identity: a reused pid is not ours, and a member nobody traced is UNKNOWN and never signalled. Nothing signals a process group as a whole.

- **Normal end, cancel, timeout.** The supervisor stops what it started, then asks the agent for an inventory. Only when every registered resource and its own scan are ABSENT does it settle the lease, tell the agent `clean` (the agent checks again and journals CLEAN), and release its own copies.
- **Anything PRESENT or UNKNOWN after the grace and a further minute:** QUARANTINED. The outcome says so, both holders keep the descriptors, and the stop and inventory are retried every second for a minute, then every 15 s, until they succeed. A deadline decides when to quarantine, never when to release.
- **The supervisor dies.** The agent sees its identity gone, stops the registered resources (SIGTERM, the grace, SIGKILL by verified identity, launchd bootout), inventories them, settles the lease and journals CLEAN. Otherwise it quarantines and keeps retrying.
- **The agent dies.** launchd restarts it within about a second; it reloads its journal and the supervisor adopts it again (every 5 s it checks, and every request retries once through a new adoption). A restarted agent has lost the token.
- **The queue's runner dies.** The relay can outlive it, so the supervisor watches the runner's identity itself and cancels the workload.

What custody cannot do: if every holder dies (supervisor, agent restarts without descriptors) while a resource survives, no kernel lock remains. The cleanup-required lease (`vendor/long-run`, not installed) is what keeps the exclusion rule then.

### Leases

On the live queue (heavy-job-queue 401c4d1 and later) the runner takes a heavy lr-lease for every job, owned by itself, with the profile's estimates, which enqueue passes as `--est-mem-gib` and `--est-disk-gib`. The supervisor reads that lease from the queue's job record and takes none of its own, since lr-lease grants one heavy lease at a time. The queue releases its lease once the relay's group is empty. If the queue kills the relay before cleanup is confirmed, the supervisor takes the heavy lease itself (run `caret`) and holds it until clean; if another run got it first, exclusion still rests on the locks. On an older queue the supervisor owns the job's heavy lease from the start, renews it every 300 s (TTL 15 minutes) so mem-guard keeps seeing it, and with the vendored lr-lease acquires it cleanup-required and acknowledges it with the token. Leases are reaped only when their owner is gone (see "Rig changes" below). Recipes take no lease of their own.

VM jobs are refused at enqueue on the live queue: rig-run takes the single heavy lease itself, which the queue's lease now holds for the job's whole life. On an older queue the supervisor takes none for them and rig-run takes the heavy and vm leases and heavy.lock.

Since the queue's commit 366e9c2, the runner takes heavy.lock as its last admission step and passes the locked descriptor to the job with slot.lock. The relay finds that inherited descriptor and proves it holds the lock (a flock through it succeeds while a fresh open of the file is refused). The supervisor then uses it instead of taking the lock, and passes it on to the recipe with `RIG_HEAVY_LOCK_FD`, which rig-run checks the same way before using it, so a VM job does not wait on its own runner. With no inherited descriptor, as with an older runner, the supervisor takes heavy.lock itself. If some other process holds heavy.lock without passing it, the job waits out its lease wait and ends with 75, with a reason that says so. The recipe inherits the slot and heavy.lock descriptors too, so if the supervisor itself is SIGKILLed, neither frees while a recipe process that kept them is alive.

Besides the registered resources, the supervisor's own scan treats as the job's every process that
- is in the process group the supervisor made for the recipe;
- descends from an owned process (recorded by pid and start time, so a reused pid never counts);
- started after the job and carries `CARET_HEAVY_MARK=<job-id>.<nonce>` in its environment;
- is a launchd job whose label starts with `caret-heavy.<job-id>.` (recipes read the prefix from `CARET_HEAVY_LAUNCHD_PREFIX`).

Stopping sends SIGTERM to all of them and boots out the launchd jobs, waits the profile's grace, then sends SIGKILL every second with a fresh scan until nothing owned is left. A rig-run gets SIGTERM first and alone, as rig-stop and mem-guard do. The recipe then gets the grace to finish by itself, so R2's feeder can leak-scan what came back. After a VM job the supervisor checks that each rig-run's clone directory and leases are gone. If they are not, it runs `rig-stop --orphans --grace 15` and `lr-reap --run rig`, up to three times. The lease, heavy.lock and slot are released last.

Known gaps. A process that leaves every tracked group, clears its environment and loses its parent between two samples (0.25 s for the supervisor, 0.5 s for the agent) is not found. The VM's Virtualization service is launchd's child. The supervisor waits up to 30 s for new ones to exit but never signals them, because it cannot attribute them to this job. Nothing proves the VM path with a real VM yet (see Tests).

## Profiles

All figures are unmeasured unless the evidence column says otherwise. The floor is the queue's free-disk admission and the supervisor's recheck under the lease. It must cover the lease's own 8 GiB floor plus the estimates, because the queue charges no estimates.

| Profile | Floor GiB | Estimates GiB (mem + disk) | Lease wait s | Execution s | Grace s | Queue timeout s | Evidence |
|---|---:|---|---:|---:|---:|---:|---|
| `caret-browser-eval` | 11 | 2.5 + 0.5 | 1800 | 3600 | 30 | 5730 | Unmeasured; 8 + 3 from Brief Q1. No whole three-set or live run has been timed. |
| `caret-helper-suite` | 12 | 3 + 0.5 | 1800 | 3600 | 30 | 5730 | Unmeasured; I1's estimates, lead's 12 GiB. W2's window step took 52 s. |
| `caret-swift` | 20 | 6 + 6 | 1800 | 7200 | 60 | 9360 | Unmeasured; h11/heavy.sh's estimates. Compiler time alone was 124 s. |
| `caret-laya` | 12 | 3.5 + 0.1 | 1800 | 7200 | 30 | 9330 | Unmeasured; LY1's estimates, the lead's 12 GiB. No complete run of the three checkpoints and the scoring. Fetches each checkpoint's weights (0.64 to 0.84 GB) into memory. |
| `caret-vm` | 15 | rig-run's 6 + 2 | 0 | 10800 | 60 | 11160 | Floor is Sam's figure. Estimates measured (VM peak 5.65 GiB, clone at most 0.51 GiB). Times unmeasured; grace covers rig-run's 45 s cleanup budget. Also waits on `~/.codex/local-ios-qa.lock` (advisory `--wait-flock`). |

The queue timeout is the backstop: lease wait + execution + grace + 300 s. The supervisor's own limits fire first. After the lease, the supervisor rechecks the floor, normal memory pressure and HOLD. A failed recheck releases the lease and waits again, within the lease wait. If the lease wait expires, the job ends with 75. Unlike a queue admission expiry, that uses up the job's ID.

## Recipes

| Recipe | Profile | Runs | Pinned inputs beyond the worktree |
|---|---|---|---|
| `helper-window --tag T` | helper-suite | offline frozen install, then helper `pnpm test`, extension `pnpm test`, fixtures `tsc --noEmit` and `node --test` | none (node_modules come from the committed lockfiles) |
| `canned-sets --tag T [--binaries-from W]` | browser-eval | the three canned sets; stops at the first wrong value | bridge, bridge test host, Chrome for Testing (from W when given), W4's pages, key, note and owners |
| `live-tasks --tag T --spend-limit USD [--heldout DIR]` | browser-eval | one live pass of the task pages, or of the held-out pages; stops the eval at the first wrong value | bridge, test host, Chrome for Testing, plus the held-out pages as a sealed tree |
| `laya` | laya | LY1's three checkpoints, then its scoring; it measures, so a wrong Laya pick is a result, and it fails only when a checkpoint or the scoring is incomplete | the Python 3.12 binary and standard library LY1 ran on, the MLX venv's packages, the tokenizers wheel, laya_mlx, the model config, the questions and weight digests; run with `-S`, so nothing else is imported. Weights by pinned revision and SHA-256 |
| `r2-prepare --harness h11\|h14 --work DIR [H11 stage options]` | swift | a fresh export of the pin (`recipes/r2/export.sh`, never reused by its `.REV`), then R2's build.sh and stage.sh; records the payload's digest | llama.xcframework, the Node tarball, helper and extension node_modules, Chrome for Testing |
| `r2-vm --harness h11\|h14 --job-dir DIR [--config off\|on] [--allowance USD --prior-spend USD]` | vm | writes the run's configuration and spend control into the sealed payload, then R2's feeder, which starts rig-run on the sealed job | the staged payload (REV = pin), job.sh, tcc.txt, display |

H11's stage options (`--pages`, `--sources`, `--next-page`, `--scenarios`) are arguments, so the plan records them. stage.sh writes them into the payload. The r2-vm plan records the payload's `h11-options.json`, and the check refuses guest results run with other options.

R2's feeder (`recipes/r2/run.sh`) takes the run directory from rig-run itself (`RIG_RUN_ID_FILE`), never from a glob of `runs/` by pid. A stop request makes it stop rig-run and still run the host leak scan. It records a clean scan of that exact directory in `rig-run-scanned`; vm.sh copies nothing into the job's evidence without it.

### What acceptance needs

Each recipe names its required steps. A required step that never recorded is 12, unless an earlier step already failed and the recipe stopped there (it is then listed as skipped and the earlier failure decides the code). A checker that exits with an undocumented code is logged to `checker-errors.txt` and makes the recipe 12. Evidence that is present but malformed is 12, whatever the step exited.

- **Browser sets** must report exactly the expected pages: the task fixture's `tasks/expect/*.json`, the held-out manifest, or the corpus forms plus the W4 sites present in the sealed copy. Every page must be walked, with no page error, press or POST, and on the goal path with a goal result (a task page with nothing eligible to fill excepted).
- **H11** needs, for each page in its options, the rows `h11-<page>-ask-at-form` (offered and right), `-tab` (right and verified), `-no-submit` (verified) and `-undo` (undone; with the next page on, `h11-wizard-2-undo` stands in for wizard-1's), and no note saying a scenario crashed or was not run. The h10 scenario needs at least one `fill-` and one `ask-` row.
- **H14** needs the rows attach-input, attach-dropzone, tab-never-confirms, click-opens (or click-opens-ungated), save-line, switches, zero-submits and both attach undo rows, and the setup checks fixture, caret-up, page and window-id, all passing.

## Exit codes and states

Recipes compute their own code with `recipes/check.py`, which writes `result.json`. When several steps fail, the job reports the first code in this order: 99, 98, 10, 13, 12, 11, 14.

| Code | Meaning | Set by |
|---:|---|---|
| 0 | every step passed and the evidence belongs to this job | recipe, adapter |
| 10 | a wrong value (a page's `wrong` list, a guest row with `wrong: yes`, or one seen in a live log) | recipe |
| 11 | a suite or eval failed: nonzero exit, failed tests, a page error, press or POST, an acceptance row not passing, a crashed or skipped scenario | recipe |
| 12 | evidence missing, malformed, incomplete (a missing page, row, goal result or required step), for another revision or other options, a leak check not saying CLEAN, or a checker failure | recipe |
| 13 | spend over the limit (host ledger growth, or guest spend over the allowance left) | recipe |
| 14 | preparation failed (offline install, binary copy, build, staging) | recipe |
| 64 | bad recipe arguments | recipe |
| 98, 99 | R2 host leak scan could not finish, or found a key | recipe (feeder) |
| 65 | refused: plan, snapshot, input or worktree changed since enqueue | boot check, supervisor |
| 66 | the recipe exited 0, but `result.json` is missing, foreign (job ID, plan, recipe, exit), or lists evidence that is missing, outside the run, or older than the run | adapter |
| 75 | not admitted within the lease wait (HOLD, lease, heavy.lock, floor or pressure) | supervisor |
| 124 | execution limit reached | supervisor |
| 125 | supervisor error (cleanup is then the recovery owner's), or VM cleanup could not be confirmed | supervisor |
| 143 | cancelled by the queue, the relay died, or the queue runner died | supervisor |

`outcome.json` in `~/.caret-run/evidence/ops/jobs/<id>/` records `cleanup` (clean, quarantined, or left to the recovery owner) and keeps three states apart. `executed` means the recipe ran to its own end. `validated` means it exited 0 and the adapter accepted its evidence. `accepted_by_lead` stays empty until `caret-heavy accept`, which refuses an unvalidated job. A queue state of "succeeded" means exit 0, which already implies validated. Acceptance is always the lead's separate step.

## HOLD

Every job is enqueued with `--wait-absent ~/.caret-run/HOLD`. While HOLD exists the queue keeps the job queued, and `run --max-wait` exits 75 with the job still queued and no attempt used. The supervisor checks HOLD again before the lease and after it. Only Sam or the coordinator removes HOLD.

## Tests

```sh
cd '/Users/samgu/Programming Projects/caret-ops-heavy/ops/heavy/tests'
/opt/homebrew/opt/python@3.14/bin/python3.14 -B -m unittest -v test_units test_recipes test_supervisor test_custody test_queue_lease   # about seven minutes
~/.long-run/rig/bin/test-rig-run-heavy-lock.sh
cd ~/.long-run/bin && node --test lr-lease.test.mjs
```

The tests run the shared queue at a fixed commit, copied into each test's temporary world, so they do not follow its owner's uncommitted work: `QUEUE_TEST_REV` in `tests/support.py` is the live queue (401c4d1); classes about the supervisor's own lease and VM jobs set `QUEUE_LEGACY_REV` (7ef4ccb). `test_custody` holds Astra's design tests 1 to 6 and 8 to 10 against a real launchd recovery agent; exclusion is checked by a separate contender that tries the locks. Test 10 runs the vendored lr-lease.

`test_supervisor` runs the real queue runner, relay, supervisor, lr-lease, lr-reap, rig-stop and launchd, with real processes, against a temporary queue state, HOLD path, lease directory, zero-floor lease policy, heavy.lock and scratch repositories. The profile and the evidence are synthetic. The runner holds the test's heavy.lock (`--heavy-lock`), as it holds the real one in production; `RunnerHeavyLock` also points it at an unrelated file to cover an older runner. `test_recipes` runs the recipe scripts directly with stub `pnpm`, `node`, `npx`, `rig-run` and Lume (`tests/stubs`); r2-prepare's build and staging have no test beyond `bash -n`. Each test waits up to 90 s for normal memory pressure and skips if it never comes. `RealVm` is written but skipped: it boots and cancels a real rig VM, and runs only with `CARET_HEAVY_VM_TEST=1`, HOLD released and 15 GiB free.

## Rig changes this relies on

- `~/.long-run/bin/lr-lease-core.mjs` reaps a lease only when its owner is gone, or its pid now belongs to a process started more than 2 s after the lease. Expiry alone no longer reaps a live owner. `lr-lease renew ID --owner-pid PID --ttl MIN` extends a live lease, because mem-guard only picks victims among unexpired leases.
  `renew` refuses a clock reading or an expiry that the lease record cannot represent.
- `~/.long-run/rig/bin/rig-run` takes `heavy.lock` after its two leases, so a VM cannot start beside a build that holds the lock. A busy lock counts as a refusal and releases both leases. With `RIG_HEAVY_LOCK_FD`, it uses an inherited descriptor instead, but only one proven to hold the lock. Once it holds both leases and the lock, it checks the lead's hold, memory pressure and free disk again (against `RIG_RUN_MIN_FREE_GIB` when the caller sets it) before any clone, and refuses with 75. `RIG_RUN_ID_FILE` receives the run's exact directory. Test: `test-rig-run-heavy-lock.sh`.

Backups of the originals are in `~/.long-run/backup/20261007-q2-lease-owner/`. These files are not under git and every run on this Mac uses them, so further changes are made in `vendor/long-run/` here first, and any change to admission for other runs is installed only after the coordinator approves it.
