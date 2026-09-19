# Contributing

Clone without recursive submodules, then run `make check` on a Mac. Fetch an upstream with `git submodule update --init --depth 1 packages/<name>` when needed. Python core work can run `make test` on Linux.

Keep work in the component directories listed in the README. Discuss changes to CLI JSON fields before changing both the Swift caller and Python core. Do not modify unrelated submodules or advance a source pin without checking its license and recording why.

Tests should protect scheduling arithmetic, failed-source handling, state transitions and duplicate external effects. Use offset-aware timestamps and retain source evidence. Never replace a failed tool result with plausible model text.

Keep a pull request focused; related changes can stay together. Explain the resulting behavior and checks actually run. Include a running-app capture when changing the UI. The `size:*` label describes the effective diff and is not a merge gate.

CI checks are `Core checks`, `Mac build` and `Sync label definitions`. Branch protection is not configured by this starter. PR checks have no production credentials. A green run proves only the checks it ran, not live Gmail, calendar or browser acceptance.
