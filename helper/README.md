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

A `fillProposal` holds one entry per empty field of the form: the field's key and frame, the derived descriptor, Jev's choice and confidence, the chosen candidate's text copied verbatim (`value`, or null for "none"), and where it came from. Proposals are made on focus of an empty field in the frontmost app, or on request, and dropped if the field was filled, its window closed or the mode changed while Jev answered. Nothing here writes into any app; insertion belongs to the host.

## What is kept

- Plain screen text lives only in memory, in a rolling ten-minute window (`src/rolling-text.ts`).
- The store under `~/Library/Application Support/CaretV2/` holds daily counts, transfers and shadow episodes. Values and element keys appear only as HMAC-SHA256 hashes under a local salt (`salt`, mode 0600), with kinds, lengths, bundle identifiers and timings. Tests read the database files byte by byte to check that no plain value is there.
- In shadow mode the helper never calls Jev and publishes nothing.

## Jev

One request per form, one choice question per empty field, each offering every candidate span plus `none` (`src/fill/fill.ts`). Candidates come from every window but the form's own: typed values first, then single lines of text, with `Label: value` lines split so the value is the span. The key is read from `TYPESAFE_API_KEY` or the `.env` named by `CARET_ENV_FILE` when a request is made, and is never logged.
