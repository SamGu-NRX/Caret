# Caret host (v2)

A menu-bar app that shows ghost text at the caret in any app and inserts it with Tab, and shows
the helper's grounded fill proposals as ghost values in empty form fields. The text engine is
KeyType's (`packages/keytype`), used by SwiftPM path and not edited. Helper messages are decoded
with the screen track's `CaretScreenCore` (`apps/screen-reader`), also by path and not edited.

## Layout

- `Sources/CaretHostCore`: decision logic with no AppKit or AX. `OfferArbiter` holds the one
  offer Tab may take (ghost or fill) and the one write ⌘Z may revert, and hands each out once.
  `InsertionGuard` is a port of the team repo's guard; `UndoGuard` is its counterpart for ⌘Z.
  `FillSelection` matches a proposal to the focused field; `WriteFallback` decides paste versus AX
  write; `HelperProtocol` decodes helper lines and defines `fillResult`.
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
  - `Runtime/`: wiring, shared status and the debug socket.
- `Sources/Caret`: the app shell.

## Build

The llama.cpp binary is gitignored. Put the macOS slice of the `b9402` release at
`packages/keytype/Packages/ModelRuntime/Vendor/llama.xcframework` (KeyType ADR-007):

```sh
gh release download b9402 --repo ggml-org/llama.cpp --pattern 'llama-b9402-xcframework.zip'
unzip llama-b9402-xcframework.zip 'build-apple/llama.xcframework/Info.plist' \
  'build-apple/llama.xcframework/macos-arm64_x86_64/*'
# Then remove the non-macOS entries from Info.plist's AvailableLibraries (plutil -remove).
```

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
- SIGTERM and SIGINT shut down cleanly, freeing llama/Metal before exit.

## Debug socket

`~/.caret-run/sockets/host.sock` (override: `--socket`, `CARET_HOST_SOCKET`) answers one
command per connection with JSON: `state` (default), `latency-reset`, `ping`, and the test hook
`key <tab|esc|cmd-z|cmd-1|cmd-2|cmd-3|char:c> <pid>`, which routes a key headed for `<pid>`
through the event tap's own decision code without posting any event.
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
  after the Mac has been idle for 5 minutes and only while the fixture is frontmost.

## Which apps take a pid-posted paste

The host posts ⌘V to the target's pid. An app that leaves the field untouched for 0.5 s gets an
`AXSelectedText` write instead, and is remembered for the session (debug state `writeMethods`).
Seen so far: caret-fixture needs the AX write (it has no Edit menu, so ⌘V maps to nothing).
