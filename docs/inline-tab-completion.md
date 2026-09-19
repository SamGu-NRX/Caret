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

## Two open contract questions

**1. `original_digest` covers an unspecified string.** `docs/bridge-protocol.md`
shows `e3b0c44298fc1c14`, which is SHA-256 of the empty string truncated to 16
hex characters, so the algorithm is clear but the input is not: the full field
value, or the bounded `nearby_text` window. Rather than guess, the app gates
insertion on live content equality against the exact text the offer was
computed from (`InlineFieldAccess.validate`). That is strictly stronger than
comparing a 64-bit hash, so a wrong guess here cannot produce a wrong edit --
it would only ever refuse one. `InlineFieldAccess.digest` implements the
inferred rule and is checked against the documented sample in the tests; point
it at the right input once the core says which.

**2. `element_revision` has no producer yet.** The bridge calls it "a change
token for the element's value" but the native capture that mints it is still
being written. The app currently derives its own
(`InlineFieldAccess.revisionToken`: text digest + caret offset + length).
Staleness detection is entirely local, so this works standalone, but the app
and the capture owner must agree on one token before offers round-trip
correctly. If capture mints a different token, delete `revisionToken` and take
it from the snapshot.

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
