# Inline Tab completion: app side

Audience: whoever lands `CaretCore` and whoever wires the app to it. This
records the seam between them and the two things the app cannot decide alone.

## Shape

The app owns capture, the preview, the keyboard and the edit. The core owns
judging and writing. They meet at one protocol,
`InlineCompletionProviding` (`apps/mac/Sources/Caret/InlineCompletionProvider.swift`).
Nothing else in the app names a bridge type, so landing the bridge is one new
file that conforms to that protocol plus one line in
`AppDelegate.startInlineCompletion`.

Flow: poll the focused AX field (0.2 s) -> bounded window around the caret ->
`requestCompletion` at most once per 2 s of *changed* text or caret ->
`onOffer` -> ghost text at the caret -> plain Tab -> `accept` -> revalidate ->
write through `kAXSelectedText`.

## Adapter signatures required from CaretCore

Read from `CoreBridgeClient.swift` on 2026-09-19:

```
CoreBridgeClient(configuration: CoreLaunchConfiguration)
func onEvent(_ handler: @escaping (CoreEvent) -> Void)
func start() throws
func hello() async throws -> HelloResult
func updateContext(_ frame: ContextFrame) async throws -> ContextUpdateResult
func accept(proposalID: String, revision: Int, target: TargetIdentity) async throws -> AcceptResult
func dismiss(proposalID: String) async throws -> Bool
```

The adapter converts `InlineTarget` <-> `TargetIdentity` (same five fields) and
maps `CoreEvent.offer(.inline)` -> `InlineOffer`, `.invalidated` -> a cancel,
`.failed` -> `InlineDisabledReason.providerError`. No other conversion exists.

## Both open questions are now answered by the bridge

Resolved by reading the bridge worktree on 2026-09-19. Those files are still
uncommitted there, so this records the mapping rather than depending on it.

**`original_digest` covers the replaced slice**, not the whole value and not
`nearby_text`: `InsertionGuard.approve` digests
`UTF16Text.slice(live.value, start: replaceStart, end: replaceEnd)`. For a
caret insertion the two ends are equal, so the digest is SHA-256 of the empty
string -- which is why the sample in `bridge-protocol.md` looked like a
placeholder and was not one. `InlineFieldAccess.digest` already implements the
identical algorithm; only its input needs pointing at the slice.

**`element_revision` is minted by `AXIdentityRegistry`**, and
`InsertionGuard.approve` compares it directly, so the app must stop deriving
its own. Delete `InlineFieldAccess.revisionToken` at integration.

### What the app should hand over at integration

The app built local equivalents while the bridge was unlanded, deliberately
isolated so they can be deleted rather than reconciled:

| App (delete)                          | Bridge (use)                          |
|---------------------------------------|---------------------------------------|
| `InlineFieldAccess.readFocusedField`  | `FocusedTargetCapture.capture` / `.liveTarget()` |
| `InlineFieldAccess.validate`          | `InsertionGuard.approve`              |
| `InlineFieldAccess.revisionToken`, `elementID` | `target.elementID` / `.windowID` as handed to you |
| `InlineWindowBuilder.window`          | `NearbyTextWindow.around`             |
| `InlineFieldAccess.digest`            | `UTF16Text.digest`                    |

What does **not** move: the event tap, the key router, the offer store's
generation fencing, the preview, and the `kAXSelectedText` write. Those are
app-side by nature and have no bridge counterpart.

`InsertionGuard.approve` is stricter than the local check in one useful way --
it rejects a range that splits a surrogate pair -- so adopting it is a net
gain, not a lateral move.

**Do not instantiate `AXIdentityRegistry`.** It is internal to CaretCore and
its tokens are counter values scoped to one registry instance, so a second
instance mints a colliding `el-1` for a different element and every guard then
fails with `targetMoved`. The tokens arrive already minted on the target you
are handed -- `InputSnapshot.target` from `capture()`, and
`InsertionGuard.LiveField.target` from `liveTarget()`. Treat them as opaque
and compare only for equality.

### Driving the poll from capture()

The coordinator currently runs its own 0.2 s AX poll and derives change
detection locally. Whoever writes the conforming type should drive it from
`FocusedTargetCapture.capture()` instead and map the outcomes:

- `.captured` -> send the frame.
- `.unchanged` -> send nothing, and leave a live offer alone.
- `.suppressed(_, invalidatesPriorContext: false)` -> skip this tick, leave the
  offer standing. This is the IME and unbounded-window case.
- `.suppressed(_, invalidatesPriorContext: true)` -> the user left the field:
  `InlineOfferStore.cancel(reason: .focusChanged)`.

Only the last one cancels.

## Caret geometry limits

Ghost text is drawn at the caret only where AX answers
`AXBoundsForRange`. Where it does not, the app falls back to a *labeled*
nearby card rather than passing a bubble off as inline text. See
`InlineCaretGeometry` for which app families are expected to support it; that
list comes from the AX APIs' documented behavior and has not yet been measured
app by app.

## What is deliberately absent

No mock provider. With no bridge configured the coordinator reports
`noProvider`, never arms the event tap and never touches a keystroke, so an
unconfigured machine is visibly unconfigured instead of producing output that
looks like a model result.
