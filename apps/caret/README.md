# Caret host (v2)

A menu-bar app that shows ghost text at the caret in any app and inserts it with Tab, and shows
the helper's grounded fill proposals as ghost values in empty form fields. The text engine is
KeyType's (`packages/keytype`), used by SwiftPM path and not edited. Helper messages are decoded
with the screen track's `CaretScreenCore` (`apps/screen-reader`), also by path and not edited.

## Layout

- `Sources/CaretHostCore`: decision logic with no AppKit or AX. `OfferArbiter` holds the one
  offer Tab may take (ghost text and its alternatives, a fill, an action line or a pop-up), its
  navigation state, the one write ⌘Z may revert and the working or error line, and hands each
  out once. `KeyOwnership` is the keyboard table of `SURFACES.md` section 8 as code.
  `PopupSpec` decodes a pop-up from the catalog of eight blocks and refuses an unknown block or a
  value without a `ref`; its golden file is `Tests/CaretHostCoreTests/Fixtures/popup-specs.json`.
  `LinePlacement` and `FillLineRule` place a fill's line in tight forms and keep one line on screen.
  `InsertionGuard` is a port of the team repo's guard; `UndoGuard` is its counterpart for ⌘Z.
  `FillSelection` matches a proposal to the focused field; `WriteFallback` decides paste versus AX
  write; `HelperProtocol` decodes helper lines and defines `fillResult`. `SurfaceMachine` decides
  alternatives, action lines and pop-ups: when one is drawn, held, retried or withdrawn, the
  working, result and error lines after Tab, and the toast's undo. It reads the system through
  `SurfaceWorld` as plain values, keeps time on a `SurfaceClock`, and answers with
  `SurfaceCommand`, so `SurfaceRig` tests every transition without a screen. `FillMachine` does
  the same for grounded fill (`FillRig`; `SharedToastSlotTests` runs both machines on one
  arbiter, as they share its one toast slot). `CaretSettings` holds what Caret helps with, how
  often it speaks up, the character and pause, and `GatePolicy` the rules they make. `OnboardingFlow`
  is onboarding's five screens as a state machine, `FirstLook` the `firstLook` request and
  reply (contract fixture: `Tests/CaretHostCoreTests/Fixtures/first-look.ndjson`), and
  `FirstLookRun` the found offer taken from onboarding. `WorkLines` are the working, result and
  undo lines both draw.
- `Sources/CaretHost`: everything that touches the system.
  - `Input/TapThread`: the only key tap, on its own thread.
  - `Accessibility/FocusObserver`: AX notifications in, KeyType snapshots out.
  - `Engine/GhostTextEngine`: KeyType's gates, prompt, constrained generation and filter.
  - `Overlay/GhostOverlay`: KeyType's renderer.
  - `Insertion/InsertionExecutor`: reread the target pid's field, guard, write, verify, undo.
    Every key it sends goes to the target's pid (`PidKeystrokes`), never to the HID stream.
  - `Helper/HelperClient`: the consumer connection to the helper's socket.
  - `Fill/`: proposals and form focus in, fill offers and the result toast out.
  - `Overlay/FillOverlay`: the ghost value, the source line and the toast (`SURFACES.md` 3, 5, 6).
  - `Design/`: tokens, the figure (pebble, seed, wren; `CARET_FIGURE` or the menu's Character),
    the pop-up blocks, the line, and `Gallery`, the off-screen renders the snapshot tests compare.
  - `Runtime/SurfaceCoordinator`: `SurfaceMachine`'s adapter. It answers the machine's reads
    from NSWorkspace, Accessibility and the window server, and draws its commands.
  - `Onboarding/`: the onboarding window (`OnboardingController`, the one Caret window that may
    become key) and its screens (`OnboardingView`), every control drawn in SwiftUI so the
    off-screen renders match the window.
  - `Runtime/`: wiring, shared status, the settings file (`SettingsStore`) and the debug socket.
- `Sources/Caret`: the app shell.

## Build

The llama.cpp binary is gitignored. Put the macOS slice of the `b9402` release at
`packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework` (KeyType ADR-007):

From the repository root:

```sh
gh release download b9402 --repo ggml-org/llama.cpp --pattern 'llama-b9402-xcframework.zip' --dir /tmp
unzip -d /tmp /tmp/llama-b9402-xcframework.zip 'build-apple/llama.xcframework/Info.plist' \
  'build-apple/llama.xcframework/macos-arm64_x86_64/*'
# Keep only the macOS library in Info.plist: the other slices were not extracted.
/usr/bin/python3 -c 'import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,"rb")); d["AvailableLibraries"]=[l for l in d["AvailableLibraries"] if l["SupportedPlatform"]=="macos"]; plistlib.dump(d,open(p,"wb"))' \
  /tmp/build-apple/llama.xcframework/Info.plist
mkdir -p packages/keytype/Packages/ModelRuntime/Vendor
mv /tmp/build-apple/llama.xcframework packages/keytype/Packages/ModelRuntime/Vendor/
```

The result holds `Info.plist` with one `macos` entry and `macos-arm64_x86_64/`.

On the shared Mac, run every build under the lock:

```sh
/usr/bin/lockf -k ~/.caret-run/locks/build.lock swift test        # from apps/caret
scripts/build-app.sh release                                       # .build/Caret.app
```

## Run

Launch by direct exec so the process inherits the launching app's Accessibility grant:

```sh
CARET_ALLOW_BUNDLES=com.apple.TextEdit .build/Caret.app/Contents/MacOS/Caret
```

- The model is Cotypist's Gemma 4 E2B GGUF, read in place
  (`~/Library/Application Support/app.cotypist.Cotypist/Models/gemma-4-E2B-i1-Q4_K_M.gguf`);
  override with `--model` or `CARET_MODEL_PATH`. The first launch builds an ACPF profile
  (about 25 MB) under `~/Library/Application Support/Caret/v2-host/Profiles`.
- `CARET_ALLOW_BUNDLES` (or `--allow`) limits offers to the listed apps, and `CARET_ALLOW_PIDS`
  (or `--allow-pids`) to the listed processes. Use them for test runs on a Mac someone else is
  using; the insertion queue rechecks the pid before every key it sends.
- `--helper-socket` (`CARET_SCREEN_SOCKET`) names the helper's socket, default
  `~/.caret-run/sockets/screen.sock`. The host reconnects every 2 s at most while it is absent.
- `--no-ghost` (`CARET_GHOST=off`) skips the model: fill only.
- `--no-fill-advance` (`CARET_FILL_ADVANCE=off`) keeps focus in a field after Tab fills it;
  by default the host posts Tab to the form's pid so focus moves on, as `SURFACES.md` section 5 asks.
- `--surfaces headless` (`CARET_SURFACES=headless`) decides the helper's offers without drawing
  them or writing anything: each offer is bound to the field the helper names, keys come from the
  debug socket's `key` hook, and a text claim is refused as `headless`. For socket-level runs
  while someone is using the Mac.
- `--settings <path>` (`CARET_SETTINGS_PATH`) names the settings file, default
  `~/Library/Application Support/Caret/v2-host/settings.json`. Test runs pass their own.
- `--onboarding off|auto|show|hidden` (`CARET_ONBOARDING`): `off` by default, so no test run puts
  a window up, and the menu's Set Up Caret opens it; `auto` opens it at launch until it has been
  finished once; `hidden` runs the flow with no window, for the debug socket.
- `--status-item off` (`CARET_STATUS_ITEM=off`): no menu bar item, for runs that put nothing on
  screen.
- SIGTERM and SIGINT shut down cleanly, freeing llama/Metal before exit.
- Model keys: see "Model keys in the packaged app" in the top-level README. Only `TYPESAFE_API_KEY` and
  `CARET_ENV_FILE` reach the helper; Groq works only through the env file.
- Calendar (H8): Tab on an event card adds the event to the calendar chosen in What Caret knows, else the
  default calendar for new events. The reader writes it (`caret-screen --calendar-user <settings file>`);
  Caret asks macOS for Calendar access the first time an event card is accepted, never at launch, and ⌘Z
  removes only the event Caret added, by its identifier.

## Asking Caret

The activity list opens with a field at its top, "Ask Caret to do something"; the menu bar's Ask
Caret… opens the list with that field focused. Nothing else needs a shortcut. Return sends the text
as `planRequest`; the helper's `planProposal` is drawn as a card listing each step, with the presses
it leaves to the user marked "You do this". Tab sends `offerAccept` and the helper runs the plan
under an act grant; its `taskProgress` marks the steps and ends the card with a line saying how it
ended and who stopped it. Esc stops a run, puts a card away, empties the field, then closes the
list. The list panel becomes key only for this field and never activates Caret.

## Offers from the helper

The helper sends `alternatives`, `action` and `popup` for one field each (`HelperOffer`, types
from `CaretScreenCore`). The host shows an offer only when its app is frontmost and the focused
element's frame matches the field's to within a point, in the same window: by the reader's window
number when both sides have one, else by title (`OfferField.window`, `FieldMatch`). Otherwise it
holds the offer and retries for 30 s. `offerWithdrawn` takes a shown or held offer away; the
helper ends every offer it makes (`expired` for timed ones), so the host sets no age limit of its
own and drops the helper's offers when the connection goes. Alternatives sent again under the
shown key redraw in place, and a loopFinish or routine withdrawn as `reoffered` is swapped in
place for its replacement. Alternatives are inserted by the host as ghost text is. Tab, the arrows and ⌘1 to ⌘3 on an action line or pop-up send `offerAccept`,
and the work runs as the helper task whose id is the offer's key: its `taskProgress` ends the
working line (done, stopped, handoff, paused). Esc on the working line after 3 s sends
`offerStop`. A pop-up with a fields block is a fill: when its run is done the line becomes
"Filled N fields from <app>" with ⌘Z, counting `taskProgress.written` and naming the pop-up's
`sourceApps`; ⌘Z sends `taskControl undo`, and the answer reads `restored` and `notRestored`.

## Debug socket

`~/.caret-run/sockets/host.sock` (override: `--socket`, `CARET_HOST_SOCKET`) answers one
command per connection with JSON: `state` (default), `latency-reset`, `ping`, and test hooks
(`inject` and `progress` only when the host runs with `--test-hooks` or `CARET_TEST_HOOKS=1`):

- `key <tab|shift-tab|opt-right|esc|up|down|left|right|return|space|cmd-z|cmd-1|cmd-2|cmd-3|char:c> <pid>`
  routes a key headed for `<pid>` through the event tap's own decision code without posting any
  event, and replies after the main thread has handled it.
- `inject <json>` shows an offer for the focused field of the pid it names: alternatives, an
  action line, a pop-up spec, or a helper line such as a `fillProposal` (`SurfaceInjection`).
  Injected offers are never reported to the helper.
- `progress done|error` ends the work an accepted action line or pop-up started.
- `settings` reads the settings file, the choices and the gate they make; `settings set role
  fill|repeat|watch|calendar|words on|off`, `level quiet|balanced|eager`, `character pebble|seed|wren`,
  `paused on|off`, `routing on|off` and `calendar <EventKit calendar id>|default` change one as the menu bar
  and What Caret knows do.
- `state` carries `calendar`: Calendar access, the event card's line ("Adding to Work") and the calendar's id.
- `activity open|close|more` opens or closes the activity list, or shows the next five Done rows.
- `ask` reads the ask field at the top of the activity list (`AskCaret`): its text, phase, card and
  line. With `--test-hooks`, `ask type <text>`, `ask submit` (Return), `ask key tab|esc` and `ask open`
  (the menu's Ask Caret) drive it as the field does: Return sends `planRequest`, Tab on the card sends
  `offerAccept`, Esc stops a run or puts the card away.
- `placement-bounds x y w h | clear` (test hooks): panels are placed within that rect, global top-left,
  instead of the screen's visible frame, to stand in for a small screen. An action line or pop-up
  with no spot that covers none of the app's fields or labels is drawn as its 20 pt compact line
  (`CompactOffer`, ↓ opens the card), and is not drawn at all when the compact line has none either.
- `onboarding` reads the onboarding flow. With `--test-hooks`, `onboarding open|close|next|back`,
  `role <r> on|off`, `level <l>`, `key tab|delete|return|esc|cmd-z|cmd-1|cmd-2|cmd-3|other|char:<c>`, `permissions on|off
  on|off` (stands in for the Accessibility and Input Monitoring grants), `reply <firstLookReply>`
  and `look-again` drive it as the window would. The socket never opens the window.
`scripts/host-state.py` wraps it and can wait for an offer or an insertion. The state carries
trust flags, the current offer, the last claim and insertion, tap timing and keystroke-to-paint
latency. Field text never appears; only digests and lengths, plus the model's own output.

## Test scripts

- `scripts/relaunch-trust.sh [n]`: launch n times and print the trust flags each reports.
- `scripts/e2e_textedit.py accept end|mid <dir>` and `latency <dir> [interval_ms]`: drive a
  TextEdit document the script creates. They need a Mac with no user input for 10 minutes
  (`CARET_E2E_IDLE_MIN`) and stop as soon as anyone else types or takes the foreground.
- `scripts/fixture-keys.swift`: posts keys at the HID level, refusing unless the fixture pid owns
  the focused element. cua-driver's background routes do not pass through a session event tap,
  so they cannot exercise the host's Tab handling.
- `Caret --probe [--bos on|off] "<text with | as caret>"`: print the engine's offer without a GUI.
- `scripts/fill_acceptance.py <dir>`: the fill acceptance run on caret-fixture's forms with live
  Jev. It starts and stops its own helper, fixtures, reader and host on their own sockets, moves
  focus with AX writes (`scripts/fixture-ax.swift`), and claims through the test hook. Under
  `lockf -k ~/.long-run/locks/gui.lock`, `realtab <dir>` presses one real Tab through the tap, only
  after the Mac has been idle for 5 minutes and only while the fixture is frontmost;
  `realtab-ghost <dir>` also loads the model, types a sentence into a fixture field key by key and
  reads back the keystroke-to-paint samples and the field's text.
- `scripts/fill_advance_check.py <dir>`: a verified fill moves focus to the next field and the
  next offer follows.
- `scripts/offers_socket_acceptance.ts --out <dir>`: the helper's real offers through a
  `--surfaces headless` host, with B7's simulated reader replaying the recorded sessions. Opens
  no window and posts no event.
- `scripts/surface_acceptance.py alternatives|fill <dir> [light|dark]`: alternatives, pop-ups and
  the fill line on caret-fixture through `inject` and `key`, with composed screenshots. The host
  draws only in the frontmost app, so the run asks the fixture for the foreground and keeps every
  gate in `fixture_app.py` (`CARET_SURFACE_IDLE_MIN`, default 300 s), and stops on any input that
  is not the host's own.
- `CARET_RECORD_SNAPSHOTS=1 swift test --filter SnapshotTests` rewrites the reference images in
  `Tests/CaretHostTests/References`; `CARET_SNAPSHOT_OUT=<dir>` also writes every render there.
- `--appearance light|dark` (`CARET_APPEARANCE`) pins the overlays' theme for screenshots.
- `scripts/onboarding_socket_walk.py <Caret binary> <dir>`: onboarding walked over the debug
  socket with `--onboarding hidden` and a fake helper that answers `firstLook` and runs the found
  offer when Tab takes it, every setting read back, and a relaunch reading the settings file.
  Opens no window and posts no event.
- `scripts/onboarding_window_walk.py <Caret binary> <dir> [light|dark]`: onboarding in its real
  window, moved through only with real keys pressed in it (Return, Tab on try-it and on the first
  look's offer, ⌘Z), answered by the socket walk's fake helper, with a screenshot of each screen.
  A foreground run: every gate in `fixture_app.py`.
- `scripts/fill_acceptance.py popup <dir>`: the helper's fill pop-up with live Jev on the Schedule
  form, a real Tab, every value read back, the toast, and a real ⌘Z. A foreground run.
- `scripts/fixture_app.py`: CaretFixture.app for the on-screen scripts, exec'd with `--foreground`
  (`CARET_FIXTURE_BIN_DIR` names the build), and the gates a foreground run keeps: the gui lease,
  gui.lock, 300 s idle and no quiet window. A foreground run starts with the fixture's own
  `activate legacy` and ends with `quit <previous pid>`. `Watchdog` reads HIDIdleTime every 0.2 s and stops
  the run on any input that is not the run's own key, and records the frontmost app over the run. `python3 scripts/fixture_app.py` prints
  what a run would decide now, without starting one.

## Which apps take a pid-posted paste

The host posts ⌘V to the target's pid. An app that leaves the field untouched for 0.5 s gets an
`AXSelectedText` write instead, and is remembered for the session (debug state `writeMethods`).
Seen so far: caret-fixture needs the AX write (it has no Edit menu, so ⌘V maps to nothing).
