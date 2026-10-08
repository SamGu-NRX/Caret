# Caret heavy jobs on the shared queue

This directory is how Caret's heavy jobs (browser evals, the helper suite, Swift builds, R2's VM runs) go through the shared heavy-job queue at `/Users/samgu/Programming Projects/agent-heavy-job-queue-20261001/scripts/heavy-job-queue.py`. It replaces `~/.caret-run/queue/caret-heavy.sh`, which a review found unsafe to commission (STATE.md, "WRAPPER REVIEW (a221c41d) DISPOSITION").

Enqueueing records a job and returns. A queue runner, started separately, runs it. No job runs while `~/.caret-run/HOLD` exists.

## Commission a job

```sh
H='/Users/samgu/Programming Projects/caret-ops-heavy/ops/heavy/caret-heavy'
"$H" enqueue RECIPE caret-UNIQUE-ID --worktree /clean/worktree --rev FULL-SHA [recipe options]
"$H" status                     # each Caret job's queue state, lane and executed / validated / accepted
"$H" show caret-UNIQUE-ID       # outcome, evidence directory, and the queue's seq, state and lane
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

Every probe answers ABSENT, PRESENT or UNKNOWN (`procs.py`): a failed or unrecognised listing, a timeout, a permission error or a malformed `lr-lease status` is UNKNOWN, never an empty answer. Group members are known by identity: a reused pid is not ours, and a member nobody traced is UNKNOWN and never signalled. Likewise a process of this user, started during the job, whose environment cannot be read for the job's marker makes the inventory UNKNOWN, but is never treated as the job's: it is not signalled and its children are not walked. Nothing signals a process group as a whole.

- **Normal end, cancel, timeout.** The supervisor stops what it started, then asks the agent for an inventory. Only when every registered resource and its own scan are ABSENT does it settle the lease, tell the agent `clean` (the agent checks again and journals CLEAN), and release its own copies.
- **Anything PRESENT or UNKNOWN after the grace and a further minute:** QUARANTINED. The outcome says so, both holders keep the descriptors, and the stop and inventory are retried every second for a minute, then every 15 s, until they succeed. A deadline decides when to quarantine, never when to release.
- **A journal record fails** (disk full, I/O error). Nothing it records changes in memory: no adoption, lock, lease or member identity is kept, and descriptors that came with the request are closed. The failed bytes are cut from the journal before the next record. Member identities that were not recorded are written by the next tick.
- **The supervisor dies.** The agent sees its identity gone, stops the registered resources (SIGTERM, the grace, SIGKILL by verified identity, launchd bootout), inventories them, settles the lease and journals CLEAN. Otherwise it quarantines and keeps retrying. Before CLEAN it also settles any lease of this attempt it was never told about, because the supervisor can die between lr-lease creating a lease and the agent journalling it. With the vendored lr-lease such a lease names the attempt. With the live one, the agent matches a lease of run `caret`, owned by the dead supervisor, created between its adoption and its death. The clean record lists them under `reconciled`. The relay stays in the queue's group until the journal says CLEAN, so the queue keeps its lease while the agent cleans up. It waits whenever the supervisor sent no status, and whenever the status says the supervisor left an unconfirmed cleanup to the agent after an error. It leaves at once only when the journal shows no adoption: the supervisor then died before custody held anything.
- **The agent dies.** launchd restarts it within about a second; it reloads its journal and the supervisor adopts it again (every 5 s it checks, and every request retries once through a new adoption). A restarted agent has lost the token.
- **The queue's runner dies.** The relay can outlive it, so the supervisor watches the runner's identity itself and cancels the workload.

What custody cannot do: if every holder dies (supervisor, agent restarts without descriptors) while a resource survives, no kernel lock remains. The cleanup-required lease (`vendor/long-run`, not installed) is what keeps the exclusion rule then.

### Leases

On the live queue (heavy-job-queue 401c4d1 and later) the runner takes a heavy lr-lease for every job, owned by itself, with the profile's estimates, which enqueue passes as `--est-mem-gib` and `--est-disk-gib`. The supervisor reads that lease from the queue's job record and takes none of its own, since lr-lease grants one heavy lease at a time. The queue releases its lease once the relay's group is empty. The queue's SIGKILL of the relay, 10 s after its SIGTERM, empties that group while cleanup may still run. The supervisor therefore obliges the queue's lease (`lr-lease oblige ID --run RUN --attempt A --cleanup-token-sha256 H`, where RUN is the queue's `HEAVY_JOB_QUEUE_LEASE_RUN` when it passes one (ac3e70c and later; it must be the lease record's run, else the job is refused) and `heavy-job-queue` otherwise, once admission has passed and before the workload exists) and renews it by token, so the queue's release quarantines it and only this attempt's acknowledgement removes it. This needs the lr-lease installed on 2026-10-07; with an older lr-lease, a supervisor that sees the queue release its lease before cleanup is confirmed takes the heavy lease itself (run `caret`) and holds it until clean. A job sealed from ops/heavy before e5489c1 calls `oblige` without `--run`, which the installed lr-lease refuses, so it ends with 75. On an older queue the supervisor owns the job's heavy lease from the start, renews it every 300 s (TTL 15 minutes) so mem-guard keeps seeing it, and with the vendored lr-lease acquires it cleanup-required and acknowledges it with the token. Leases are reaped only when their owner is gone (see "Rig changes" below). Recipes take no lease of their own.

VM jobs on the live queue hand the queue's lease to rig-run (the coordinator's option b, 2026-10-07): one job, one heavy lease. The queue's lease for a VM job carries no estimates (0/0, as rig-run's own heavy lease did), since rig-run's vm lease carries the VM's 6 + 2 GiB. The supervisor obliges it, then sets `RIG_HEAVY_LEASE_ID` and rig-run's managed mode (`RIG_RUN_MANAGED=1`, `CARET_HEAVY_ATTEMPT`, `CARET_HEAVY_TOKEN_SHA256`). rig-run then takes no heavy lease, uses the handed one only if it is an active, cleanup-required heavy lease obliged to this attempt, takes its vm lease cleanup-required for the attempt, registers the VM with the recovery owner (`$CARET_HEAVY_REGISTER vm rig-run-<pid>`) before cloning, and leaves the vm lease to the job's custody. The conclusion acknowledges every lease of the attempt with the token. Enqueue refuses a VM job when `paths["rig_run"]` lacks the handoff. On an older queue the supervisor takes none for VM jobs and rig-run takes the heavy and vm leases and heavy.lock.

The recovery owner's `vm` resource is ABSENT only when the clone directory is gone, no process of this user runs `lume run <name>`, and no Virtualization process of this user started since the job began is alive. During the job its cleanup-required vm lease and heavy.lock keep any other rig VM from starting, so such a process is this VM's. The owner signals Lume by verified identity, never Virtualization, and hands a clone left after Lume is gone to `rig-stop --orphans` on its SIGKILL rounds. Design test 7 checks that a Virtualization process outliving Lume holds the job, through the supervisor and through the owner alone.

Since the queue's commit 366e9c2, the runner takes heavy.lock as its last admission step and passes the locked descriptor to the job with slot.lock. The relay finds that inherited descriptor and proves it holds the lock (a flock through it succeeds while a fresh open of the file is refused). The supervisor then uses it instead of taking the lock, and passes it on to the recipe with `RIG_HEAVY_LOCK_FD`, which rig-run checks the same way before using it, so a VM job does not wait on its own runner. With no inherited descriptor, as with an older runner, the supervisor takes heavy.lock itself. If some other process holds heavy.lock without passing it, the job waits out its lease wait and ends with 75, with a reason that says so. The recipe inherits the slot and heavy.lock descriptors too, so if the supervisor itself is SIGKILLed, neither frees while a recipe process that kept them is alive.

Besides the registered resources, the supervisor's own scan treats as the job's every process that
- is in the process group the supervisor made for the recipe;
- descends from an owned process (recorded by pid and start time, so a reused pid never counts);
- started after the job and carries `CARET_HEAVY_MARK=<job-id>.<nonce>` in its environment;
- is a launchd job whose label starts with `caret-heavy.<job-id>.` (recipes read the prefix from `CARET_HEAVY_LAUNCHD_PREFIX`).

Stopping sends SIGTERM to all of them and boots out the launchd jobs, waits the profile's grace, then sends SIGKILL every second with a fresh scan until nothing owned is left. A rig-run gets SIGTERM first and alone, as rig-stop and mem-guard do. The recipe then gets the grace to finish by itself, so R2's feeder can leak-scan what came back. After a VM job the supervisor checks that each rig-run's clone directory and leases are gone. If they are not, it runs `rig-stop --orphans --grace 15` and `lr-reap --run rig`, up to three times. The lease, heavy.lock and slot are released last.

Known gaps. A process that leaves every tracked group, clears its environment and loses its parent between two samples (0.25 s for the supervisor, 0.5 s for the agent) is not found. The VM's Virtualization service is launchd's child. The supervisor waits up to 30 s for new ones to exit but never signals them, because it cannot attribute them to this job. Nothing proves the VM path with a real VM yet (see Tests).

## Profiles

All figures are unmeasured unless the evidence column says otherwise. The floor is the queue's free-disk admission and the supervisor's recheck under the lease. On the live queue (401c4d1) the per-job lease charges the estimates against lr-lease's floor. `caret-swift` relies on that and uses the heavy floor itself; the older profiles still carry floors that cover 8 GiB plus their estimates.

| Profile | Floor GiB | Estimates GiB (mem + disk) | Lease wait s | Execution s | Grace s | Queue timeout s | Evidence |
|---|---:|---|---:|---:|---:|---:|---|
| `caret-browser-eval` | 11 | 2.5 + 0.5 | 1800 | 3600 | 30 | 5730 | Unmeasured; 8 + 3 from Brief Q1. No whole three-set or live run has been timed. |
| `caret-helper-suite` | 12 | 3 + 0.5 | 1800 | 3600 | 30 | 5730 | Unmeasured; I1's estimates, lead's 12 GiB. W2's window step took 52 s. |
| `caret-swift` | 8 | 4 + 2 | 1800 | 7200 | 60 | 9360 | Floor is lr-lease's heavy floor; the queue's lease charges the estimates. Memory 4 over swift-tests' one measured peak of 2.35 GiB (caret-swift-s2-70a6845-n2: apps/caret, apps/screen-reader and bridge, 364 s). r2-prepare's app build is unmeasured; the profile's 4 GiB memory cap stops a job (exit 76) before it uses more than it was charged, and records the peak. Disk 2 from the 1.5 GB of build output on record, peak unmeasured. |
| `caret-laya` | 12 | 3.5 + 0.1 | 1800 | 7200 | 30 | 9330 | Unmeasured; LY1's estimates, the lead's 12 GiB. No complete run of the three checkpoints and the scoring. Fetches each checkpoint's weights (0.64 to 0.84 GB) into memory. |
| `caret-vm` | none | rig-run's 6 + 2 | 0 | 10800 | 60 | 11160 | No floor of its own. Admission is lr-lease's vm decision for 6 + 2 GiB plus rig-run's clone gate (free > 12 GiB, strict): the queue waits, before heavy.lock, at lease-policy.json's vm floor + 6 + 2 (derived at enqueue and recorded in the plan as `admission`); under the lock the supervisor checks lr-lease's vm decision read-only (no lease; leases rig-run's `lr-reap --run rig` would remove first are left out) and ends the job with 75 if it would refuse. At exactly 12.0 GiB free lr-lease grants and rig-run's clone gate does not (a known disagreement, pinned by a test). The vm floor is 4 GiB since 2026-10-05, over the measured worst case (VM peak 5.65 GiB, clone at most 0.51 GiB). Times unmeasured; grace covers rig-run's 45 s cleanup budget. Also waits on `~/.codex/local-ios-qa.lock` (advisory `--wait-flock`). |

The queue timeout is the backstop: lease wait + execution + grace + 300 s. The supervisor's own limits fire first. After the lease, the supervisor rechecks the floor, normal memory pressure and HOLD. A failed recheck releases the lease and waits again, within the lease wait. If the lease wait expires, the job ends with 75. Unlike a queue admission expiry, that uses up the job's ID.

### Lanes

A queue with lanes (heavy-job-queue `feat/queue-lanes`, e21588d) runs a browser lane beside the heavy one: two browser slots, each with its own runner and slot lock (`slot-browser-1.lock`, `slot-browser-2.lock`), a browser lease, and never heavy.lock. Each profile has a `lease_kind` (`heavy` by default; every profile is heavy today, `caret-browser-eval` included), passed at enqueue as `--lease-kind` to a queue that has it and recorded in the plan as its `lane`; enqueue refuses a non-heavy lane on a queue without lanes. The plan names no slot path. The relay takes the slot lock from the queue's `HEAVY_JOB_QUEUE_SLOT_LOCK`, which must be one of its lane's slot locks in the queue's state directory, and checks `HEAVY_JOB_QUEUE_LEASE_KIND` against the lane (exit 65 on any mismatch). It then passes that path to the supervisor, which sends it in its custody adoption; the recovery owner validates it again and journals it. With neither variable set (an older queue) the job uses the plan's `slot.lock`, in the heavy lane only. A browser-lane job takes no heavy.lock.

A browser-lane job is a headless batch by lr-lease's rule. Once a second while it runs, and as it finishes, the supervisor checks that no process it owns has an on-screen window (`CGWindowListCopyWindowInfo`, the windows' owner pids against the job's tracked pids). If one does, or the window list cannot be read, it stops the job with exit 77 and says which pids.

### Memory

Every job's outcome records `memory`: the peak of its owned processes' summed physical footprint (`proc_pid_rusage`; what macOS's memory-pressure handling counts, Metal buffers included), when it happened, each process's lifetime maximum footprint (so a spike between two 0.25 s samples is still seen) and the number of samples. `memory.ndjson` in the run directory has the sum every 5 s. A profile with `mem_cap_gib` above 0 is stopped once that sum goes over the cap: SIGTERM, then SIGKILL after 2 s rather than the profile's grace, exit 76, with the usual cleanup and custody. With a cap set, an owned process whose footprint cannot be read also stops the job, since the cap could not be enforced. Laya has no default and `enqueue laya` requires `--mem-cap-gib`: its peak is unmeasured, and its first run was stopped by mem-guard at 17:31Z on 2026-10-07 (0.40 GiB free, swap 22.19 of 22.28 GB). A run under a cap is how that peak gets measured; nobody has run one yet. Light tests: `test_memory.py`.

## Recipes

| Recipe | Profile | Runs | Pinned inputs beyond the worktree |
|---|---|---|---|
| `helper-window --tag T` | helper-suite | offline frozen install, then helper `pnpm test`, extension `pnpm test`, fixtures `tsc --noEmit` and `node --test` | none (node_modules come from the committed lockfiles) |
| `canned-sets --tag T [--binaries-from W]` | browser-eval | the three canned sets; stops at the first wrong value | bridge, bridge test host, Chrome for Testing (from W when given), W4's pages, key, note and owners |
| `live-tasks --tag T --spend-limit USD [--heldout DIR] [--binaries-from W]` | browser-eval | one live pass of the task pages, or of the held-out pages; stops the eval at the first wrong value | bridge, test host, Chrome for Testing (from W when given), plus the held-out pages as a sealed tree |
| `laya` | laya | LY1's three checkpoints, then its scoring; it measures, so a wrong Laya pick is a result, and it fails only when a checkpoint or the scoring is incomplete | the Python 3.12 binary and standard library LY1 ran on, the MLX venv's packages, the tokenizers wheel, laya_mlx, the model config, the questions and weight digests; run with `-S`, so nothing else is imported. Weights by pinned revision and SHA-256 |
| `r2-prepare --harness h11\|h14 --work DIR [--inputs-from W] [H11 stage options]` | swift | a fresh export of the pin (`recipes/r2/export.sh`, never reused by its `.REV`), then R2's build.sh and stage.sh; records the payload's digest | keytype as an archive of the pin's gitlinked commit and its llama.xcframework (W's keytype checkout, at that commit), helper and extension node_modules (W's, whose lockfiles must be the pin's), the Node tarball sealed against the SHA-256 build-app.sh pins at the commit, Chrome for Testing |
| `swift-tests --tag T [--packages LIST] [--inputs-from W] [--env CARET_RECORD_SNAPSHOTS=1]` | swift | `swift test --disable-automatic-resolution` in each package (default apps/caret, apps/screen-reader, bridge) of a fresh export of the pin, built under TMPDIR and deleted after; every package runs; 11 on a failing test, 14 on a build error; per-package `<step>.summary.json` and `swift-times.ndjson`. With `--env CARET_RECORD_SNAPSHOTS=1`, the only `--env` taken, every image the tests add or change in the export is copied to `snapshots/` at its repository path, with `snapshots/manifest.json` of sha256 values | for apps/caret: keytype as an archive of the pin's gitlinked commit, and llama.xcframework, from W's keytype checkout (which must be at that commit), else the pinned worktree's. SwiftPM's remote dependencies (apps/caret's swift-argument-parser) come from its cache by the pinned Package.resolved |
| `vm-cancel-proof [--job-dir DIR] [--rig-wait S] [--boot-timeout S] [--vz-grace S]` | vm | boots a real rig VM on the sealed job (default the rig's smoke job), cancels its own rig-run once the guest is ready, then proves rig-run ended by the cancel (143), the clone, Lume and every Virtualization process the VM started are gone (waited for, never signalled), and the vm lease was released, or in managed mode left cleanup-required for this attempt; the job's CLEAN conclusion acknowledges the leases. 14 when no guest becomes ready, 11 when a check fails (`proof.json`) | the job's job.sh, and tcc.txt, display, no-reboot when present |
| `r2-vm --harness h11\|h14\|rae --job-dir DIR [--config off\|on] [--allowance USD --prior-spend USD]` | vm | writes the run's configuration and spend control into the sealed payload, then R2's feeder, which starts rig-run on the sealed job. H11 and RAE results are checked against the options recorded at enqueue (`h11-options.json`, `rae-options.json`). RAE's acceptance (check.py owns it): rae-options.json has mode probe or run and a non-empty list of distinct targets the payload stages, checked at enqueue and again by the checker; every target has a row; none crashed, not run or over budget; every ran row carries its scoring evidence (verdict, per-field outcome counts, takes, clipboard, wrong, undo and stop results; an undo or stop the read-back could not verify is bad evidence) and agrees with its target's `out/targets/<id>/score.json`, which vm.sh copies back so the run can be re-checked; no clipboard left changed, no evidence-incomplete row, no undo or stop that ran and failed; and in run mode at least one target with a take. Only a RAE probe guest, which holds no key, may say NO KEYS as its leak check | the staged payload (REV = pin), job.sh, tcc.txt, display |

Swift summaries keep each XCTest bundle's executed, failure and skipped counts in `xctest.bundles`, excluding nested suites and duplicate `All tests` rollups. `swift_testing.runs` keeps every Swift Testing run's tests, verdict and issues. Aggregate counts sum those entries; skipped XCTest tests are not passed tests. Swift Testing reports issues rather than failed-test counts, so `failed` includes each failed run's issues, or one failure when the run reports no issue count. Passed Swift Testing runs contribute their test counts to `passed`.

The Node tarball comes from `caret-heavy fetch-node --worktree W --rev SHA`: it reads `NODE_VERSION` and `NODE_SHA256` from `apps/caret/scripts/build-app.sh` at that commit (the hash build-app.sh traces to nodejs.org's signed SHASUMS256.txt, which is how D1 and H11 got theirs: build-app.sh downloaded it into `apps/caret/.build/node-dist` and checked it), downloads it from nodejs.org into `~/.caret-run/inputs/node-dist`, and keeps it only if the hash matches. r2-prepare refuses to enqueue until it is there, and sealing checks the hash again.

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
| 76 | the job's processes went over the profile's memory cap (`mem_cap_gib`), or a cap is set and an owned process's footprint cannot be read | supervisor |
| 77 | a browser-lane job's process owned an on-screen window, or the window list could not be read | supervisor |
| 124 | execution limit reached | supervisor |
| 125 | supervisor error (cleanup is then the recovery owner's), or VM cleanup could not be confirmed | supervisor |
| 143 | cancelled by the queue, the relay died, or the queue runner died | supervisor |

`outcome.json` in `~/.caret-run/evidence/ops/jobs/<id>/` records `cleanup` (clean, quarantined, or left to the recovery owner) and keeps three states apart. `executed` means the recipe ran to its own end. `validated` means it exited 0 and the adapter accepted its evidence. `accepted_by_lead` stays empty until `caret-heavy accept`, which refuses an unvalidated job. A queue state of "succeeded" means exit 0, which already implies validated. Acceptance is always the lead's separate step.

## HOLD

Every job is enqueued with `--wait-absent ~/.caret-run/HOLD`. While HOLD exists the queue keeps the job queued, and `run --max-wait` exits 75 with the job still queued and no attempt used. The supervisor checks HOLD again before the lease and after it. Only Sam or the coordinator removes HOLD.

## Tests

```sh
cd '/Users/samgu/Programming Projects/caret-ops-heavy/ops/heavy/tests'
/opt/homebrew/opt/python@3.14/bin/python3.14 -B -m unittest -v test_units test_recipes test_supervisor test_custody test_queue_lease test_rig_ts   # about nine minutes
~/.long-run/rig/bin/test-rig-run-heavy-lock.sh
cd ~/.long-run/bin && node --test lr-lease.test.mjs mem-guard.test.mjs
V='/Users/samgu/Programming Projects/caret-ops-heavy/ops/heavy/vendor/long-run'
RIG_RUN="$V/rig/bin/rig-run" ~/.long-run/rig/bin/test-rig-run-heavy-lock.sh   # the uninstalled rig-run, unmanaged path
"$V/rig/bin/test-rig-run-managed.sh"                                         # its handed lease and managed mode
```

The tests run the shared queue at a fixed commit, copied into each test's temporary world, so they do not follow its owner's uncommitted work: `QUEUE_TEST_REV` in `tests/support.py` is the live queue (401c4d1); classes about the supervisor's own lease and VM jobs set `QUEUE_LEGACY_REV` (7ef4ccb). `test_custody` holds Astra's design tests 1 to 10 against a real launchd recovery agent (test 7 with a fake rig-run in managed mode and a stand-in Virtualization process); exclusion is checked by a separate contender that tries the locks. Test 10, `QueueLeaseObliged` and `LeaseAcquiredButNotYetRegisteredCleanupRequired` run the vendored lr-lease.

`test_supervisor` runs the real queue runner, relay, supervisor, lr-lease, lr-reap, rig-stop and launchd, with real processes, against a temporary queue state, HOLD path, lease directory, zero-floor lease policy, heavy.lock and scratch repositories. The profile and the evidence are synthetic. The runner holds the test's heavy.lock (`--heavy-lock`), as it holds the real one in production; `RunnerHeavyLock` also points it at an unrelated file to cover an older runner. `test_recipes` runs the recipe scripts directly with stub `pnpm`, `node`, `npx`, `rig-run` and Lume (`tests/stubs`); r2-prepare's build and staging have no test beyond `bash -n`. Each test waits up to 90 s for normal memory pressure and skips if it never comes. `RealVm` is written but skipped: it boots and cancels a real rig VM, and runs only with `CARET_HEAVY_VM_TEST=1`, HOLD released and 15 GiB free.

## Rig changes this relies on

- `~/.long-run/bin/lr-lease-core.mjs` reaps a lease only when its owner is gone, or its pid now belongs to a process started more than 2 s after the lease. Expiry alone no longer reaps a live owner. `lr-lease renew ID --owner-pid PID --ttl MIN` extends a live lease, because mem-guard only picks victims among unexpired leases.
  `renew` refuses a clock reading or an expiry that the lease record cannot represent.
- `~/.long-run/rig/bin/rig-run` takes `heavy.lock` after its two leases, so a VM cannot start beside a build that holds the lock. A busy lock counts as a refusal and releases both leases. With `RIG_HEAVY_LOCK_FD`, it uses an inherited descriptor instead, but only one proven to hold the lock. Once it holds both leases and the lock, it checks the lead's hold, memory pressure and free disk again (against `RIG_RUN_MIN_FREE_GIB` when the caller sets it) before any clone, and refuses with 75. `RIG_RUN_ID_FILE` receives the run's exact directory. Test: `test-rig-run-heavy-lock.sh`.

- `~/.long-run/bin/lr-lease-core.mjs` and `lr-lease-cli.mjs` (installed 2026-10-07 with the coordinator's approval) add cleanup-required leases: `acquire --cleanup-attempt A --cleanup-token-sha256 H`; a dead owner or a plain release quarantines such a lease (kept, blocking its kind, never reaped); `ack ID --attempt A` and `renew ID --attempt A --ttl MIN` take the token on stdin; `oblige ID --run RUN --attempt A --cleanup-token-sha256 H` makes another owner's active lease of that run cleanup-required. `clear ID --reason TEXT` removes any lease and appends who, what and why to `~/.long-run/leases/clears.ndjson`. It is for an operator who has checked by hand that the attempt's registered resources (process groups, marked processes, launchd labels, VM clones and processes) are gone.
- `~/.long-run/rig/bin/rig-run` takes a handed heavy lease and has the managed mode described under "Leases" (installed 2026-10-07 18:55Z with the coordinator's approval; `test-rig-run-managed.sh` beside it). A caller that sets neither `RIG_HEAVY_LEASE_ID` nor `RIG_RUN_MANAGED` gets the behaviour above unchanged (`test-rig-run-heavy-lock.sh`). `clear` writes its whole log entry through short writes and cuts back a failed one (installed 18:54Z).

Backups of the originals are in `~/.long-run/backup/20261007-q2-lease-owner/` (first changes) and `~/.long-run/backup/20261007-q2-lease-install/` (before the lr-lease install), `~/.long-run/backup/20261007-q2-clear-fix/` (before the clear fix) and `~/.long-run/backup/20261007-q2-rig-run/` (before the rig-run install). These files are not under git and every run on this Mac uses them, so further changes are made in `vendor/long-run/` here first, and any change to admission for other runs is installed only after the coordinator approves it.
