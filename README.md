# Caret

A Mac assistant that uses the current thread and calendar to propose an action, show its evidence, and carry it out. Jev chooses workflows and computer actions; ordinary code checks times, tracks effects and verifies results.

## Start here

The starter needs Python 3.11+ and, for the Mac app, macOS 14+ with Swift 5.9+ from Xcode or the Command Line Tools. The local core has no third-party Python dependencies. Upstream integrations have their own requirements.

```sh
git clone https://github.com/theodorexli/hackathon-2026-09-19.git
cd hackathon-2026-09-19
make test
make demo
make install    # Release Caret.app → /Applications
# make dmg      # also writes dist/Caret.dmg
```

Caret asks for Accessibility on first launch, then shows a blue asterisk button only next to text fields and text selections. Command–Option or the button opens a list of actions. Memories stay in the background and are used when an action runs.

**This is a contributor starter, not the finished ninety-second demo.** The sample thread, busy intervals and buffers are explicitly synthetic. Preview calculation and SQLite hold transitions run for real. Gmail, Google Calendar, Jev inference, background capture and browser execution are not connected. The app cannot send email, create external events or purchase anything. Accessibility is used only to place the Caret button beside the current field or selection.

## Where to work

| Component | Location | First integration |
| --- | --- | --- |
| Mac popup and evidence pane | `Caret.xcodeproj`, `apps/mac` | Capture current selection/thread beside the cursor, preserve host focus, accept natural input |
| Workflows | `caret/workflows.json`, `caret/planner.py` | Connect Jev routing and source-backed parameter extraction |
| Memory and run state | `caret/store.py` | Add source timestamps/IDs and external calendar event IDs |
| Computer use | `packages/jev-ultrafast`, `packages/skyvern` | Choose one browser executor and stop before payment |
| Gmail and calendar | `docs/integrations.md` | Implement the documented source and action contracts |

The Mac app invokes the Python CLI with argument arrays, receiving JSON. There is no server, container or web frontend in the default run. SQLite data stays in ignored `.local/` files. `python3 -m caret workflows` lists the seeds. `python3 -m caret --help` lists local operations.

## Public repositories

All referenced implementation repositories are pinned submodules under `packages/`. They keep their upstream names and licenses; Caret is the surrounding application. Pins and roles live in [sources.json](sources.json).

Fetch only what you need:

```sh
make sources   # KeyType and Jev browser code
git submodule update --init --depth 1 packages/skyvern
git submodule update --init --depth 1 packages/screenpipe
```

`git submodule update --init --depth 1` fetches all top-level sources. Avoid `--recursive` unless you need an upstream's dependencies. Nothing automatically installs or runs upstream code. Read each upstream's own setup instructions before running it. Make changes to Caret outside submodules unless your team intentionally maintains an upstream fork.

Screenpipe is pinned to its last pre-commercial-license commit, whose MIT grant excludes `ee/`. Skyvern and OpenRecall have AGPL terms; ActivityWatch has MPL terms. The root license applies only to original Caret files. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Hackathon target

Start with the Austin–Dallas corridor. Before the live demo, connect one reliable travel source or check in a sourced, dated cached timetable. The current synthetic buffer fixture is **not** a timetable and must not be used as factual travel evidence.

Open a real thread, invoke Caret, and inspect its filled request. Enter produces up to three supported options and evidence. Sending the approved draft creates tentative calendar holds. A labeled staged reply selects one option; one confirmation keeps it and removes only this workflow's other holds. The booking workflow uses the browser and stops at the payment page.

Drop options when source calls fail. Never ask a model to invent missing availability, travel times or fares. Do not add multi-party polling, hotel search or ticket purchases to this build. The three seeds are Book a flight, Book a calendar link and Revise; only meeting previews currently execute.

## Checks

`make check` runs the scheduling/store tests, verifies submodule pins and builds the Mac executable. CI runs the Python suite and manifest check on Linux, and the Swift build on macOS. No check uses live accounts or sends messages.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing shared contracts.
