## Admission leases

Before a heavy, GUI, container, VM or headless browser batch, request a lease with the batch's estimated additional memory and disk use. Estimates use GiB. Admission checks free disk, system memory pressure, free swap, per-kind counts and quiet windows. A lease does not authorize starting Docker, opening windows, or taking actions outside the run's brief. Keep the existing heavy.lock and GUI safety rules.

Take `gui` for anything that can open a window or receive keystrokes; take `browser` only for a headless browser batch that can do neither. A `browser` lease needs no `gui.lock`.

Acquire from a shell that will remain alive for the batch. Pass its PID explicitly so command substitution or a short-lived launcher does not become the owner.

```sh
lease="$HOME/.long-run/bin/lr-lease"
reaper="$HOME/.long-run/bin/lr-reap"
"$reaper" --run "$RUN_NAME"
if lease_id=$("$lease" acquire --run "$RUN_NAME" --kind heavy \
    --est-mem 2 --est-disk 3 --ttl 45 --owner-pid "$$"); then
    # Run the authorized batch under its existing heavy.lock or gui.lock.
    # Arrange release in the coordinator's existing exit cleanup as well.
    "$lease" release "$lease_id"
else
    printf '%s\n' "$lease_id"
    # Exit 75 means wait or reduce the batch; do not start the job.
fi
```

The example estimates and 45-minute TTL are assumed and unmeasured, not a measured budget. Omit `--ttl` to use the policy default. Without `--owner-pid`, the owner is the process that invoked the command. Do not use a launcher that exits before the batch ends.

Run `lr-reap --run "$RUN_NAME"` at each lead wake. It deletes only that run's dead-owner or expired lease records. Unfiltered `lr-reap` reaps stale records across all runs. Neither form deletes resources or signals processes. Expiry does not mean the job stopped: finish within the TTL, or stop the job before releasing and acquiring a new lease. There is no renewal command.

`lr-lease status` shows readings, outstanding records and decisions for zero additional estimates. A real request can still fail with larger estimates. Outstanding estimates remain reserved across kinds until release or reaping, even if some resources are already consumed. This conservative double-counting prevents concurrent grants from promising the same remaining disk or swap.

Policy is in `~/.long-run/lease-policy.json`. Initial counts and safety thresholds are unmeasured; VMs are disabled. Quiet windows use the existing `QUIET-UNTIL` format, epoch seconds in the first field. Invalid readings, policy or recognized lease records refuse admission rather than guessing. Reaping also stops on malformed records so a lead can inspect them.

Run the isolated checks with `node --test "$HOME/.long-run/bin/lr-lease.test.mjs"`. Tests create and remove their own temporary directories under `bin/`; they do not reap real runs.
