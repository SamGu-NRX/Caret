# Caret helper

Listens on `~/.caret-run/sockets/screen.sock` for `caret-screen` and for consumers. It holds the screen model, the change log and the transfer log, runs the shadow logger, and answers grounded-fill questions with Jev.

```sh
pnpm install
CARET_ENV_FILE=/path/to/.env node src/main.ts [--shadow] [--no-jev] [--data-dir DIR]
pnpm test        # tsc, then vitest
pnpm schema      # regenerate schemas/screen-protocol.schema.json after editing src/protocol.ts
```

Node 24 or later; the store uses the built-in `node:sqlite`.

## Protocol

`src/protocol.ts` is the contract, written in zod and exported to JSON Schema. Every client's first line is `hello` with a role. The reader then sends `snapshot`, `focus`, `appSwitch`, `windowClosed` and `pasteboard`. A consumer may send `fillRequest {windowId, fieldKey}` and receives every `fillProposal` and `error`.

A `fillProposal` holds one entry per empty field of the form: the field's key and frame, the derived descriptor, the agreed choice and its confidence, both asks, the chosen candidate's text copied verbatim (`value`, or null for "none"), and where it came from. Proposals are made on focus of an empty field in the frontmost app, or on request, and dropped if the field was filled, its window closed or the mode changed while Jev answered. Nothing here writes into any app; insertion belongs to the host.

## What is kept

- Plain screen text lives only in memory, in a rolling ten-minute window (`src/rolling-text.ts`).
- The store under `~/Library/Application Support/CaretV2/` holds daily counts, transfers and shadow episodes. Values and element keys appear only as HMAC-SHA256 hashes under a local salt (`salt`, mode 0600), with kinds, lengths, bundle identifiers and timings. Tests read the database files byte by byte to check that no plain value is there.
- In shadow mode the helper never calls Jev and publishes nothing.

## Jev

One request per form, one choice question per empty field, each offering every candidate span plus `none` (`src/fill/fill.ts`). Candidates come from every window but the form's own: typed values first, then single lines of text, with `Label: value` lines split so the value is the span. Each candidate line names its section, the first line of its block, its window, and whether that window is the one the user was in just before the form (`src/fill/candidates.ts`).

Every form is asked twice in parallel. The second ask shuffles the candidates inside each window, renumbers them, and rewords the field. A value is proposed only when both asks pick the same candidate and the lower confidence is at least 0.75. A proposal carries both asks and, for a field left blank, whether the asks disagreed or agreed below the cutoff. Calibration and acceptance runs are in `~/.caret-run/evidence/screen/fill-distractors-v2/calibration.md`.

The key is read from `TYPESAFE_API_KEY` or the `.env` named by `CARET_ENV_FILE` when a request is made, and is never logged.

## Executor

A plan (`src/executor/schema.ts`, exported to `schemas/plan.schema.json`, example in `fixtures/golden/plan.json`) is an ordered list of end states with `{{slots}}`: a field's value, an element that exists or is absent, a focused element, a window title, or a calendar event. A consumer sends `runPlan`, and the executor (`src/executor/executor.ts`) works through the steps, publishing `taskProgress` for each:

1. Re-read the step's window through the reader. A sheet over it, or a field that changed since the task started, stops the run at this step.
2. Skip the step if its end state already holds, so a finished plan reruns as a no-op.
3. Write the value or focus, or press the step's `via` target, or open its URL, or add the calendar event. A locator that matches several elements is put to Jev twice (shuffled, reworded), and the step stops unless both asks agree.
4. A press target whose label reads as send, submit, delete or pay (`src/executor/risk.ts`), or that has no label, is never pressed: the run ends as a hand-off at that step.
5. Compare: the written value must appear in the change log and the model, no other field may change, and a press must make its end state hold within four re-reads.

Every write is recorded with the value it replaced; `taskControl {action: "undo"}` restores them newest first, each only if the field still holds what Caret wrote. Real input in a window the task acts in pauses it before the next step; `taskControl {action: "resume"}` continues. The calendar is an interface with one implementation, `FakeCalendar`; nothing here links EventKit or opens URLs.

`node scripts/executor-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR` runs five fixture plans, the Send hand-off and injected faults against `caret-fixture` with the real reader.

## Patterns and memory

`src/patterns/` recognizes repeated work as transfers arrive, with no model in the path, and offers it through a gate.

A transfer's shape is the source and destination element keys with their ordinals removed (a static text's own label, which is its content, becomes `*`), plus the window kinds and which part of the source was copied. Its row is the element's position among same-shape elements in its window (`shape.ts`).

- **Loops** (`loops.ts`). Two rounds in a row of the same 1 to 3 transfers, one row further down the destination and 1 to 3 items further down the source, with each column keeping one value class (email, url, number, text). After round two the next round is read from the screen and published as a `patternOffer` of kind `loopNext`. When the user takes it, or types the same values, every remaining round becomes one `loopFinish` offer. A value shown in several windows counts for whichever window explains every round; a copy that cannot be described still breaks "in a row".
- **Routines** (`routines.ts`). The transfers into one window until it closes or goes quiet for two minutes form a bundle; two or more shapes make a routine, signed by their sorted keyed hashes. When a window opens holding a known routine's destination fields, empty, Caret predicts silently from the live windows and scores the prediction when the bundle closes.
- **Gate** (`gate.ts`). Rules first: shadow mode, paused, permission hand-off, "Don't offer this here", ignored twice today in this app, the hourly budget, proof (one matching round for `loopNext`, a confirmed round for `loopFinish`, two silent hits at 80% or better for a routine) and grounding. Every decision goes to the decision log with `(hits + 1) / (hits + misses + 2)` as its show probability; nothing calibrates or reads that number yet.
- **Memory** (`memory.ts`, `memory.sqlite` beside the store). Five typed kinds: about you, people, preferences, routines, permissions. Each entry's sentence is rendered by code. About-you, people and preference fields are sealed with AES-256-GCM under `memory.key` (0600); routines hold only keyed hashes, app names and positions. A forgotten routine is not relearned for 30 days.
- **Preferences** (`preferences.ts`). For a minute after Caret fills a field, a settled edit to it becomes memory: the same phone number reformatted is a format rule, a name extended is a People entry, anything else is an About-you value used instead for that field shape and source value. Every offer applies these before it shows a value, so editing the entry changes the next fill.

A consumer sends `offerControl {offerId, action: take | dismiss | dontOfferHere}`; take runs the offer's plan through the executor. `memoryRequest {requestId, op: list | edit | pause | resume | forget}` is answered with a `memoryReply` to that consumer only.

- `node scripts/patterns-eval.ts --out DIR` replays the planted and distractor streams in `test/stream.ts` at 50 events a second, then a forget-and-rerun and the edit scenario, and writes `results.json` and `summary.md`.
- `node scripts/patterns-fixture-eval.ts --bin ../apps/screen-reader/.build/debug --out DIR` runs the loop on `caret-fixture --windows roster,seating` with the real reader. It opens windows, so run it under `/usr/bin/lockf -k ~/.long-run/locks/gui.lock env CARET_GUI_LOCK=held`.
