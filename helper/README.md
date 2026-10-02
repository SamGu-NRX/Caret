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
