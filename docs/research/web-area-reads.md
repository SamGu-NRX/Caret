# What the native reader takes from web pages, and where it lands

**Audit** · base `alpha@558f6f1e` (Merge #52 into beta) · every file:line in this document was read at that commit.
Companion pin: `helper/test/web-area-boundary.test.ts` (same commit). No runtime code changes.

## Verdict

The extension boundary from #52 holds: a page walk sends `hasValue` and `rev`, never a text
control's value (`helper/src/protocol.ts:3018` refuses one outright). The **native** boundary
does not exist. A Mac app that exposes an `AXWebArea` — Safari always, Chromium once any
assistive process turns its accessibility tree on — gives the reader's walks every text
field's value and every piece of static text on the page. Nothing on the path to the helper
checks that a value came from inside a web area, nothing checks a page origin (the deny list
only sees extension traffic), and the ledger's inventory holds what arrives as
request-quotable text. Today a login form's revealed password field, filled by a "show
password" button so it is no longer secure and labelled by an icon, rides into the helper
inside a snapshot and sits in the inventory as a part a request builder can quote.

The rule this document proposes and the pin states:

> **Text-control values under an `AXWebArea` never reach the helper. The focused field's
> caret text is for inline writing only.**

Enforcement belongs in the reader (it is the only place that can see the ancestry before the
snapshot is built), with the helper's admission rules as backstop. What it costs and what
replaces the lost capability is priced at the end.

## The paths that read a page

### 1. Window walks

`Walker.read` (`apps/screen-reader/Sources/CaretScreenAX/Walker.swift:74`) copies
`kAXValueAttribute` for every role in `Roles.valueBearing` that is not secure. There is no
`AXWebArea` special case anywhere in the walk: a web area is just a container with children,
and its children are page fields and static text like any other node. Walk limits are
mechanical, not semantic — `maxValueChars: 20_000` per window (`Walker.swift:17-22`), with
flavours `focused`, `background` and `request`.

Chromium exposure deserves its own line. Safari exposes its accessibility tree to any
process holding the Accessibility permission. Chromium does not expose it unless something
sets `AXManualAccessibility`. The reader deliberately never sets it for Chromium —
`enableManualAccessibility` (`ScreenReader.swift:416-424`) logs "a Chromium browser, read by
the page engine" and skips it. But the attribute is process-global and not reader-owned: any
assistive app (a screen reader, a password manager, a testing tool) can turn the tree on,
and from that moment the reader's walks see the browser's whole DOM-backed tree, fields and
values included. The page engine being Caret's preferred Chromium path does not keep the
native path closed; it only means Caret itself did not open it.

Every walk flavour funnels through the same emit — `AppWorker.walkWindow` and
`walkSubtree` build the `Snapshot` with `nodes: result.nodes, values:
ctx.detector.values(for: result.nodes)` (`AppWorker.swift` around `:658` and `:694`) — and
walks are triggered by focus change, `AXValueChangedNotification`, background passes and the
pending-state watch. A page that changes under a stationary caret re-walks.

### 2. The focused element

`focusChanged`/`emitFocus` read the focused element's whole value at event time and keep
only its emptiness: `focusEmptyAtEvent = (fe, secure ? false : (AX.valueUnlessSecure(fe.el)
?? "").isEmpty)` (`AppWorker.swift:568`), the same derivation again before the `.focus`
emit (`:599`). The comment says why — "typing may start within tens of milliseconds" — and
the full value is dropped; this is the one native read with an on-purpose short half-life,
and it is the model for what every other path should do.

### 3. Act read-back and the 80-character quotes

Every write, press or raise ends in a `requestWalk` whose snapshot carries page values
again. The write verb re-reads the target's value right before acting (`AppWorker.swift`
`:870-877`) to catch a change since the walk, and when a re-check finds a mismatch the verb
answers `.changed` quoting the field's actual value to 80 characters:

- `guard current == expect else { return (.changed, "value is '\(current.prefix(80))'") }`
  (`:877`)
- the post-write re-check: `(.changed, "\(when) the value is '\(now.prefix(80))'")` (`:965`)
- the focus re-check: `(.changed, "after focus the value is '\(now.prefix(80))'")` (`:1038`)

These strings are mismatch details on a verb answer. They reach the helper through no
snapshot at all — they are prose the reader sends about a field it just touched, and on a
Safari page field the "field" is page content. The focused-text tripwire below does not see
them.

### 4. The host's own reads

- `FieldReader` (`apps/caret/Sources/CaretHost/Accessibility/FieldReader.swift:20-27`) reads
  the focused field's whole value and selection for the insertion guard and inline. This is
  the legitimate caret-text path — it feeds inline writing and the insertion guard, and it
  has a cloud-side tripwire (below).
- `PageInline.nativeYields` (`apps/caret/Sources/CaretHostCore/PageInline.swift:145-149`)
  hands inline text to the page engine when the page reports the field the user is in —
  documented as "Chrome ignores Accessibility writes there". Safari has no page engine, so
  for Safari web fields the native path stays the inline source.
- `BrowserPage.frontOrigin` (`apps/caret/Sources/CaretHost/Accessibility/BrowserPage.swift:30-48`)
  walks a Chromium window's tree looking for an `AXWebArea` and reads its `AXURL`. It reads
  the page's URL, not its text — the one web-area read that carries origin, and it exists
  for Chromium only.

## Where it lands in the helper

The reader sends `Snapshot`s over its socket; `helper/src/protocol.ts` parses a `Node` with
`label`, `value`, `placeholder` fields. **The reader marks a native text control under
`AXWebArea` with `unread: true` while omitting its value.** The helper also follows each
`Node.parent` chain to an `AXWebArea` as a backstop. Then:

1. **The model keeps it.** `ScreenModel.apply` stores each node's `value`. The pin's first
   test holds: a revealed password's value sits in `win.nodes.get(key).value`.
2. **Admission rules do not catch it.** The exclusion rules
   (`helper/src/privacy/exclude.ts`) catch: secure roles or states (`:190`, `:217`),
   page-provided secret marks, labels naming a secret kind, and secret-shaped values
   (`excludedValue` scans for formats — emails, cards, keys — not prose passwords,
   `exclude.ts:129-132`). A 24-character diceware-style password revealed in a plain
   `AXTextField` with an icon label matches none of them, and `admitValues`
   (`exclude.ts:280-295`) keeps the node's values. The pin's `excludedValue(PASSWORD) ===
   null` test holds.
3. **The reader's typed-value detector scans walked nodes too.** The snapshot's `values[]`
   (`ctx.detector.values(for: result.nodes)`) can carry page field content as typed values;
   the helper's `admitValues` admits them for non-excluded nodes.
4. **The ledger's inventory holds it as request-quotable.** `partsOf`
   (`helper/src/privacy/ledger/source.ts:151-178`) lists the title and each node's label,
   **value**, placeholder and section texts as parts — exactly what the ledger counts
   against a conversation cap and what request builders quote spans of. The pin asserts the
   password's value is present under `nodePart(key, "value")`, and it is.
5. **A cloud request can carry it.** From the inventory, an admitted value can reach a Jev
   (cloud) request as quoted window context, and typed values become fill candidates and
   provenance for an Ask value question's source line. This document traces the code path to
   the request builders; it is a source trace, not an observed live request.
6. **The one cloud guard.** The focused field's caret text has a tripwire
   (`helper/src/privacy/focus-tripwire.ts`): the helper refuses to send a request while
   focused text is in flight. Nothing equivalent covers a **non-focused** page field's value
   that arrived in a walk.
7. **No origin, no deny list.** `DENIED_HOSTS` (`extension/src/worker/left-tab.ts:112`,
   mirrored in `helper/src/privacy/denied-origins.ts:6`) applies where page content enters
   with an origin attached — the extension's page traffic. A native snapshot carries no page
   origin at all, so the deny list structurally cannot cover the native path. Banking and
   health sites that the extension refuses to read are readable through Accessibility the
   moment their native window is walked.

## The boundary that already exists (extension side, #52)

For contrast, the page engine's contract: a page text control is sent as `TextPageControl`
with `hasValue: boolean` and `rev: number`; the schema **refuses** a `value` field with the
error "a text control's value never leaves the page (counsel 2026-10-09)"
(`helper/src/protocol.ts:3018`). Page-side verbs handle writes, compares and restores, and
answers carry outcomes, not text. The asymmetry is the finding: the extension was closed on
counsel's advice; the native path, which can reach the same fields (and Safari's, which the
extension cannot), was not.

## The rule, and what it costs

**Rule.** Text-control values under an `AXWebArea` never reach the helper; the focused
field's caret text is for inline writing only. The reader enforces it where it can see
ancestry — the walk skips `kAXValueAttribute` below a web area for text controls while
marking non-empty controls `unread`, and focused inline reads stay local. The helper
backstops by following `Node.parent` ancestry and admitting no values for editable
 descendants of an `AXWebArea`.

What depends on helper-visible web-field values today, and therefore breaks:

- **Fill verification for Safari page fields.** A fill's verification compares the field's
  value against the expectation; with no value in the helper, Safari fills verify as
  outcome-only.
- **S1 undo for Safari page fields.** Undo records and checks the field's value around a
  write; the same loss.
- **Native inline text in Safari web fields.** `PageInline.nativeYields` sends Safari fields
  to the native host path, which reads the value for the insertion guard; the guard needs a
  replacement, not just a removal.

The replacement is #52's own pattern turned native: the reader does the compare and the undo
held reader-side (the equivalent of `pageCompare`/`pageRestore`'s contract), answers carry
outcomes only, and the 80-character verb-detail quotes drop to counts or booleans. The host
`FieldReader` keeps its focused-field read — inline writing is the caret's legitimate
business — but stays behind the existing tripwire.

**Recommendation.** Reader-side enforcement is the primary change (ancestry is only visible
there); helper-side admission is defence in depth and needs the reader to send a web-area
mark first. Until the reader change lands, the pin's four `it.fails` tests document exactly
what is open.

## What would change this verdict

- A live trace of a Jev request carrying a web-area node's value as quoted inventory text
  would upgrade "can reach" to "reaches"; a demonstration that request builders never quote
  node values would downgrade it.
- A Chromium deployment that reliably keeps `AXManualAccessibility` off (an MDM attestation,
  not a convention) would shrink the Chromium half of the exposure; Safari's half stands.
- If the reader's walks already skipped web-area values on another branch, this audit's
  premise is stale — the pin's passing tests are the falsifier: they hold at `558f6f1e`.
