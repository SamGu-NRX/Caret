import AppKit
import CaretHostCore
import TextInsertion

/// `PasteboardBackend` over an `NSPasteboard`: the general one in the product, a private named one
/// in tests and experiments (BUILD-ORDER's clipboard rule).
final class GeneralPasteboard: PasteboardBackend {
    let pasteboard: NSPasteboard

    init(_ pasteboard: NSPasteboard = .general) { self.pasteboard = pasteboard }

    var changeCount: Int { pasteboard.changeCount }

    func read() -> [PasteboardItemData] {
        (pasteboard.pasteboardItems ?? []).map { item in
            PasteboardItemData(item.types.compactMap { type -> (type: String, data: Data)? in
                item.data(forType: type).map { (type: type.rawValue, data: $0) }
            })
        }
    }

    func replace(with items: [PasteboardItemData]) -> Int {
        let cleared = pasteboard.clearContents()
        // Fresh items, so a restore survives the paste having read the originals.
        let fresh = items.map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for entry in item.entries { copy.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type)) }
            return copy
        }
        if !fresh.isEmpty { pasteboard.writeObjects(fresh) }
        return cleared
    }
}

/// KeyType's `CompletionPasteboard` seam over `ReconcilingClipboard`, so `PasteboardCompletionInserter`
/// pastes through Caret's marked item and the executor reconciles after the field settles.
final class ReconcilingPasteboard: CompletionPasteboard {
    let clipboard: ReconcilingClipboard
    /// What the last `restore` did, for the debug state.
    private(set) var lastOutcome: ReconcilingClipboard.Outcome?

    init(backend: PasteboardBackend = GeneralPasteboard()) {
        clipboard = ReconcilingClipboard(backend: backend)
    }

    func save() {
        lastOutcome = nil
        clipboard.save()
    }

    func write(_ string: String) { clipboard.writeOwn(string) }

    func restore() { lastOutcome = clipboard.restore() }
}
