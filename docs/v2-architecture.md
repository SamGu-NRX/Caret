# Caret v2 — architecture reference

Written from `98596a0d` on `v2/next`; behaviour was read, not run — no signed host, Accessibility session, or Chrome profile was exercised.

## 1. Processes and trust

Four parts, two boundaries:

- **Host** (`apps/caret`, `dev.caret.host`): event tap, ghost text, insertion, toasts.
- **Helper** (`helper/`, Node ≥ 24): screen model, transfer log, Jev calls, plans, executor; no Accessibility, no event tap.
- **Reader** (`apps/screen-reader`, `caret-screen`): the only Accessibility client.
- **Bridge + extension** (`bridge/`, `extension/`): a Native Messaging host; the extension (`ai.caret.bridge`) is its only client and the only page-touching part.

The helper launches both peers (`ServiceLauncher.swift`, `helper/src/launch.ts`) with a fresh 32-byte secret; the reader acts on nothing until the helper answers its challenge, and page engines key from it. A reader outliving its helper lets the next one undo a crash-cut run (§5).

The bridge relays frames between Chrome's stdin/stdout and the host's XPC Mach service `dev.caret.host.page-bridge`, never touching `page.sock` or any key. Signatures are checked both ways — bridge `dev.caret.bridge` with a known browser as parent, host `dev.caret.host` (`bridge/Sources/caret-bridge/main.swift`, `bridge/Sources/CaretBridgeXPC/Trust.swift`); only the XPC service (`bridge/Sources/CaretBridgeXPC/HostRelay.swift`) touches `page.sock`, keyed from the launch secret.

## 2. Reader: the only hands

`ScreenReader.swift` holds the deny list (password managers, terminals, Caret; mirrored in `read-policy.ts`) and walks windows into snapshots. Acting is gated twice: the **act grant** table (`CaretScreenCore/Grants.swift`) — one task, one pid, one window, ≤120 s on a monotonic deadline a wall-clock change cannot stretch or revive; revoked on task end, process exit, or user input in that window; checked just before every write, press, raise; and the **risk table** (`RiskTable.swift`), refusing any unallowed press. Undo restores only into elements the reader itself recorded (**mark**).

## 3. Inline typing: tap → arbiter → guarded write

**Capture.** One CGEvent key tap on its own thread (`CaretHost/Input/TapThread.swift`). Each key-down becomes a `KeyStroke` carrying `eventTargetUnixProcessID`, the pid the key is headed for. Caret's own synthesized events are ignored. Real input in an app a run acts in pauses that run (`CaretHostCore/InputPause.swift`); a watch never pauses on input in a window the user owns.

**The one offer.** `CaretHostCore/OfferArbiter.swift` owns the single offer Tab may take, on an unfair lock — the tap callback never waits on model work. A plain Tab claims; typing the offer's next characters shortens it; a diverging key, expiry, or another app's target removes it; a second Tab finds nothing. What each key does comes from the surface alone (`CaretHostCore/KeyOwnership.swift`, "SURFACES.md §8 as code").

**Suggestion.** `CaretHost/Engine/GhostTextEngine.swift` runs the KeyType pipeline in-process over `llama.xcframework` — gates, token healing, a sectioned prompt, constrained generation, a fit score against the text after the caret; the cloud model never sees keystrokes.

**Write.** `CaretHost/Insertion/InsertionExecutor.swift` inserts on one serial queue: reread the focused field of the offer's own pid, run the arbiter's guard against that reread, write — `AXSelectedText` by default, else a clipboard-restoring paste — rechecking before every call that authorization is live, the process unchanged (start time), and the element still focused; then poll until the field holds exactly the predicted value. A verified fill builds an `UndoGrant` (`CaretHostCore/UndoGrant.swift`): ⌘Z reverses exactly Caret's span as an edit, never a whole-value write, which would cost apps their undo history. Range fixes go through `Writing/RangeEdit.swift` — select, revalidate, write as selected text so app undo survives, restore the caret, verify; never a paste. `Writing/InputMethodState.swift` blocks writes during IME composition, invisible to Accessibility.

## 4. Ask and fill: scope, whose, the write contract

Jev — the cloud model run by TypeSafe — decides; code vetoes.

- **Scope** (`planner/intent-heads.ts`): a route head (fill/plan/refuse) and the scope ask in two wordings; a field is in scope only when both answer "asks" at `SCOPE_CUTOFF` 0.5 (589 hand-labelled fields). No code path adds a field Jev did not choose; hand-written scope reading was removed after twelve rounds of widening phrasings (A2). Vetoes: never-typed kinds, one person per ask, literal values only as exact instruction spans, named sources only in narrow windows.
- **Settlement** (`fill/ask-scope.ts`, I2): one frozen scope per request, enforced by the contract and re-checked at the executor's guard — four paths had each written outside scope.
- **Candidates** (`fill/candidates.ts`): ≤80 spans from every window but the form's — typed values first, then lines, `Label: value` split — under 15 ms. `whose.ts` (G2): *identity* (exact email, phone, name) is code-decided; *placement* (a To: line, a sentence naming another person) is shown to Jev, never a rule.
- **The write contract** (`fill/contract.ts`, W2): only a `CheckedValue` may be written — created by `checkValues` or `mintExempt`, identity-recorded so clones and look-alikes fail `isChecked`. Shape checks (`wrongKind`), then a two-wording Jev verifier: minted only when both answer *exact* at ≥ `VERIFY_CUTOFF` 0.75, else refused. Named exemptions (an option's own label, a resolved date, a user transfer, a draft) skip the verifier, never the never-typed check. Every page-step compiler demands a mint (`ContractError`).

The host (`FillCoordinator.swift`, `FillMachine`) draws offers and toasts; the helper never writes.

## 5. Plans and the executor

A plan is steps with target, means, and an **end state** (`executor/schema.ts`: value-equals, exists, focused, window title, `handoff`). Per step the executor (`executor/executor.ts`) re-reads the window and stops if anything it saw at the start changed, skips steps whose end state already holds, predicting the change, acts through a reader verb that rechecks the exact target, re-reads and compares — a mismatch stops the run there. Pauses (§3) and stops revoke the act grant the moment they are recorded, refusing any queued act.

Presses are classified by code (`helper/src/executor/risk.ts`): a Jev yes/no on send-or-delete scored 0.55–0.62 — noise — so a label table decides. Send/submit/delete/pay words and anything in a system prompt is never pressed: the run stops, handing the press to the user. `safe` requires the whole label in `SAFE_PRESSES`; anything else is `unclassified` and also handed over (B22).

**Recovery journal** (`executor/journal.ts`, B23): before every write, press and calendar add, and after each lands, the executor saves the task — plan, ledger — AES-256-GCM-sealed into `recovery.sqlite`. A leftover row at start is a crash-cut run: its skill goes back on Tab, and its undo restores only into reader-recorded elements; entries whose read-back was unrecognized (`mayIncludeInput`) or a proper prefix (`partialWrite`) are undo-refused or guarded.

## 6. Privacy: what may leave the Mac

Four layers, each with a test that holds the code to it:

1. **Never enters the model** (`privacy/exclude.ts`, at read-in): secure or sensitive-labelled nodes lose their values; known secret shapes (cards, keys, high-entropy tokens — thresholds assumed, not measured) become `[withheld]`; switched-off apps and sites never enter (`privacy/read-policy.ts`, re-checked at every send).
2. **Bounds per request** (`helper/src/privacy/ledger/`): screen text is declared as snippets, charged through the output ledger. A conversation sends under half its text and at most `CONVERSATION_CHARS`; other windows at most 1,200 characters; the shortest revealing run is 12 normalized scalars (`RUN_MIN`). Whole notes up to 2,000 chars may go for *whose* decisions (`OWNER_NOTE_CHARS`) only because `PRIVACY_PROMISE` discloses it; `ownerNoteGate` enforces that.
3. **The I/O boundary** (`privacy/send.ts`): a transport only ever posts the bytes `seal` made, re-verified each attempt; stores write only through `storedLine` — `test/sc1-boundary.test.ts` holds every POST body and request store in `src` to this.
4. **What lives where**: plain screen text lives only in memory, ten minutes (`rolling-text.ts`); the store keeps HMACs and counts, never values; memory (`memory/sensitive.ts`) refuses passwords, financial and government numbers, one-time codes and API keys by kind (plaintext markdown).

## 7. The Chrome side

`extension/src/worker.ts` holds the only Native Messaging port and is the last check before anything touches a page: every mutating verb re-checks the task's grant (tab, frame, origin, navigation generation, expiry — `shared/grants.ts`, 120 s cap, dropped with the port), then the live frame, then hands the verb to that frame's content script pinned to the document. `content/walker.ts` keeps controls only, excluding password, payment and self-identification controls before anything leaves the page. A frame a grant covers is *armed*: a trusted pointer or key press there drops every grant acting on it at once. "Not on this site" (`sitesOff`) walks nothing, acts on nothing, reports no focus. The just-left tab's text read (`worker/left-tab.ts`) is single-shot, refused on any document or generation change. Inline typing gets its web context from `extension/src/content/field-text.ts` (2,000 before the caret, 500 after), because Chrome exposes no web content through Accessibility.

## 8. Tests and evidence

- **Helper** (`pnpm test`: tsc + vitest): privacy declarations and bounds, the boundary test, exclusion near-misses, ledger fuzz (2,400 cases), the guard adversary (writes outside a named exemption fail the run), the oracle (`realfill-oracle.ts`: perfect scope answers), the generator bench.
- **Host**: `apps/caret/Tests/` (FillMachine, ClipboardReconcile, Ask*, …).
- **Golden fixtures** pin cross-side tables: `press-risk.json` (helper ↔ reader), `self-identification.json`, `section-names.json`.
- Store tests read the sqlite bytes for plain values; leak checks compare keyed hashes; review evidence lives under `~/.caret-run/evidence/screen/`.

## Handoff

Not verifiable without a macOS rig: insertion against real apps, tap timing, live Jev quality. The task brief's "KeyHold" names nothing in this tree; the mechanisms are `KeyOwnership` and `InputPause`. Some `docs/` files describe the v1 starter (`AGENTS.md`). Next: `OfferArbiter.confirm` vs `InsertionGuard.approve`, `helper/src/goals/`, `helper/src/engines/decide/`.
