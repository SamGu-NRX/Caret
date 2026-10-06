import CaretHostCore
import TextInsertion

/// KeyType's `CompletionPasteboard` seam over `ReconcilingClipboard`, so `PasteboardCompletionInserter`
/// pastes through Caret's marked item and the executor reconciles after the field settles.
///
/// The executor checks and arms the clipboard (`ReconcilingClipboard.check`, `arm`) before KeyType's
/// inserter runs, so the inserter's `save` reads nothing: what it would save is the armed snapshot,
/// and `write` writes only over that.
final class ReconcilingPasteboard: CompletionPasteboard {
    let clipboard: ReconcilingClipboard
    /// What the last `restore` did, for the debug state.
    private(set) var lastOutcome: ReconcilingClipboard.Outcome?

    init(backend: PasteboardBackend = GeneralPasteboard()) {
        clipboard = ReconcilingClipboard(backend: backend)
    }

    func save() { lastOutcome = nil }

    func write(_ string: String) { _ = clipboard.writeOwn(string) }

    func restore() { lastOutcome = clipboard.restore() }
}
