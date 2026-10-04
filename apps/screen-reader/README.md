# caret-screen

Caret's Accessibility reader. It keeps the helper's screen model current: every open window, compacted, keyed and annotated with typed values, streamed as NDJSON to `~/.caret-run/sockets/screen.sock`. The wire format is defined in `helper/src/protocol.ts`; `CaretScreenCore` mirrors it in Swift for any Swift consumer.

## Run

```sh
cd apps/screen-reader
/usr/bin/lockf -k ~/.caret-run/locks/build.lock swift build
(cd ../../helper && CARET_ENV_FILE=/path/to/.env node src/main.ts) &
./.build/debug/caret-screen            # or --shadow: log opportunities, show nothing, call no model
```

Start the binary directly, not through `open`, so it inherits the Accessibility grant of the process that starts it. It exits with a message if it is not trusted.

## What it reads, and when

- **The focused window of the frontmost app**, on Accessibility notifications, at most once per 100 ms, and after a slow walk, three walks' time later. A value change on a field it already knows re-reads that field alone. A focus change also sends a `focus` message.
- **The window being left**, once, at the moment of the switch.
- **Every other window**, every 30 s. An unchanged window sends nothing.
- **Windows under a pending-state watch** (`watchWindows` from the helper), as `watch` walks: when the app posts a notification about that window (at least 0.2 s apart, and four times the walk's average cost), and every 10 s. While an app has a watched window it keeps its observer even when it is not frontmost. Unnamed progress and busy indicators are kept in snapshots, because they mark unfinished work.
- Each app has its own queue, each element a 0.25 s messaging timeout, and each walk a deadline (0.4 s focused, 1 s background) and a 6,000-node budget. A cut-short walk says `truncated`.
- Chromium and Electron apps get `AXManualAccessibility` once per process. Electron accepts it; Chrome and Helium answer "unsupported" and expose their web content anyway. `AXEnhancedUserInterface` is never set.

Never read:

- the value of a secure text field (checked by role and subrole on every read path)
- apps on the deny list, `~/.caret-run/deny-apps.txt`: one bundle identifier or prefix per line, created with password managers and Keychain Access on first run.

## Acting for the executor

The helper sends `readerCommand` lines back over the same socket. `walk` re-reads one window. `write` (a field's value, or its focus) and `press` re-walk the window and find the element by key. They refuse when the key now names a different element than in the executor's last `walk`, when a sheet covers the window, when the walk left part of the tree out, when the command has expired, or when the role, the label (read from the element itself, right before a press) or the current value differs from what the helper expects. An attribute that cannot be read refuses the act. Then they act, wait 0.15 s, and walk again, so the helper holds the new state before the `verbResult` arrives. A secure field is never written.

Write, press and raise act only under a live act grant. The helper sends `actGrant` (a task, a process, one window, an expiry) when an accepted offer starts that task, and `actRevoke` when the task ends, pauses, is stopped or is taken over. A command acts only when it names the granted task (`taskId`), process and window; the reader checks before it re-walks and again right before the Accessibility call, ends every grant 120 s after it arrives at the latest, and drops all of them when the helper's connection closes. Otherwise the answer is `notAllowed`, with the reason in `detail`. Grants arrive only on the reader's own connection to the helper, and the helper accepts none from a consumer. For fixture tests, `--act-pids` (a subset of `--only-pids`) lets the executor act in named processes without a grant; the reader accepts it only with `CARET_SCREEN_FIXTURE_ACTS=fixture-only` in its environment, outside an app bundle, and for `caret-fixture` processes, each bound to its start time. Whatever the grant, a press goes through only when the reader's own risk table (`RiskTable.swift`, the same cases as `helper/src/executor/risk.ts` in `helper/fixtures/golden/press-risk.json`) positively allows it: a control of a pressable role, outside any system prompt (window subrole `AXSystemDialog` or `AXSystemFloatingWindow`, or a system prompt process), whose whole label is on the short safe list (navigation, archive, add note, save draft) and reads as no risk class. The user's own key or click in a watched window ends that window's grants at the reader before the helper hears of it. The last grant check comes right before each Accessibility call that changes something; a revoke after it cannot stop that one call (at most 0.25 s), only every later one. Window ids are `<pid>-<process start>-<worker generation>-<n>`, so a process that reuses a pid never matches an old id, and a process's grants end when it exits. The socket is non-blocking: grants and revokes are read on their own queue however much output waits, and a helper that stops reading (32 MB waiting, or 10 s without taking any) makes the reader drop every grant and connect again. `watchInput` turns on a global key and mouse monitor for the named processes and reports that input happened, its process and a click's location: never key codes or characters.

## Calendar

With `--calendar-test` the reader answers the helper's calendar verbs (`calendarFind`, `calendarAdd`, `calendarGet`, `calendarRemove`, `calendarDispose`) through EventKit, which needs a native process. `CalendarAdapter` (in `CaretScreenCore`, tested with a fake store) holds the rules, and `EventKitBackend` (`CaretScreenCalendar`) talks to EventKit:

- It never asks for Calendar access, since that would put a system prompt on the user's screen. Without full access every verb answers `blocked` with `blocked: tcc`, and no EventKit store is created.
- It writes only to calendars it created itself on a local (On My Mac) source, which no account syncs. With no local source an add answers `blocked: noLocalSource`. It looks events up only by the ids of events it added, and only while each is still in its calendar, so an event in any other calendar is never read.
- An add of an event already in its calendar is refused, so two tasks never share one event.
- A write names its task and needs that task's live `calendarGrant`, checked on the calendar queue right before the write. The helper sends one only for a task from an accepted offer, and `actRevoke` ends it.
- `calendarDispose`, and the reader stopping, delete the calendars it created. A reader that is killed leaves them behind.

Without the flag every calendar verb answers `notAllowed`. `--calendar-probe` prints the authorization status and nothing else, and `--calendar-audit TITLE` lists, through a store of its own, every event calendar with that title, its source and its event count. Both only read and need no Accessibility. Calendar is a per-user TCC service, decided for the responsible process by its real path. The VM run that exercised all of this against real EventKit is in `~/.caret-run/evidence/screen/b16/`.

## Element keys

`<app>/<window kind>/<named ancestors>/<role>:<label>~<ordinal>`. Labels are lowercased with digit runs masked as `#`, so counters and dates do not move keys. Unnamed containers are left out, so wrapping does not move keys. Page titles and labels equal to the window title are left out, since Chrome renames its top group and web area on every title change. The ordinal counts earlier siblings with the same role and label. E8 measured the result: 191 of 196 elements kept one key over 100 walks, and every drift was in a window built to cause it.

## Flags for experiments

`--event-pids`, `--event-bundles` and `--only-pids` make named apps event-driven or restrict reading to them; a process they name is read whatever its activation policy, so the fixture, which is background-only unless started with `--foreground`, can be read. `--act-pids` allows the executor's verbs in named `caret-fixture` processes without an act grant, under `CARET_SCREEN_FIXTURE_ACTS=fixture-only` only. `--record FILE` tees messages to a file and requires `--only-pids`, because a recording holds screen text. `--e1-log FILE` logs every notification with its callback time. `--e8 --pids … --out FILE` walks windows repeatedly and reports key stability. The scripts in `experiments/` run E1, E8, the shadow logger and the grounded-fill evaluation against `caret-fixture`, which shows synthetic data only. `caret-fixture --windows executor` adds the executor's window, which takes `reset`, `seed`, `remove`, `sheet` and `dump` commands on stdin. The fixture hands activation back whenever it becomes the active app, since a launch from the frontmost app once left it in front for a whole run. `--windows jobs` adds a test run, an upload and a notes window for the pending-state watch, and stdin `focus NAME` moves AX focus between the fixture's own windows, also when it is background-only. With `--foreground`, stdin `activate legacy` makes the fixture the active app (`activate cooperative` uses macOS 14's `NSApp.activate()`, which did not activate it in B9's proof), and `quit PID` hands activation back to that process before exiting; `experiments/run-activation-proof.sh` uses them, gated on an idle Mac. The timed focus modes (`--focus-forms`, `--activity`, `--e1`) need key windows and refuse to start without `--foreground`; `--appearance dark|light` fixes the fixture's appearance. macOS will not activate the bare executable, so `scripts/bundle-fixture.sh .build/debug` wraps it in `CaretFixture.app` (bundle ID `dev.caret.fixture`, signed ad hoc); the evaluation scripts exec `CaretFixture.app/Contents/MacOS/caret-fixture` directly, never through `open`, and stop with an error when the bundle is missing. Each snapshot's window carries `number`, the window server's CGWindowID read once through the private `_AXUIElementGetWindow`, when the app gives one.

## Tests

`swift test` covers element keys, compaction, typed-value detection, act and calendar grants, the calendar adapter's rules, the golden protocol fixture shared with the helper (`helper/fixtures/golden/protocol.ndjson`), and the date and time spans the event card's sentences hold (`helper/fixtures/golden/event-sentences.json`).
