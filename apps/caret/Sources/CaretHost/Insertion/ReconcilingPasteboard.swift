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
            var entries: [(type: String, data: Data)] = []
            var unreadable: [String] = []
            for type in item.types {
                // A type with no data form may still have a string one (some URL types).
                if let data = item.data(forType: type) ?? item.string(forType: type).map({ Data($0.utf8) }) {
                    entries.append((type: type.rawValue, data: data))
                } else {
                    unreadable.append(type.rawValue)
                }
            }
            return PasteboardItemData(entries, unreadable: unreadable)
        }
    }

    func replace(with items: [PasteboardItemData]) -> Int {
        let cleared = pasteboard.clearContents()
        // Fresh items, so a restore survives the paste having read the originals. An item with nothing
        // readable has nothing to write.
        let fresh = items.filter { !$0.entries.isEmpty }.map { item -> NSPasteboardItem in
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
    /// The types the last save could not read (`ReconcilingClipboard.lost`).
    var lastLost: [String] { clipboard.lost }

    init(backend: PasteboardBackend = GeneralPasteboard()) {
        clipboard = ReconcilingClipboard(backend: backend)
    }

    func save() {
        lastOutcome = nil
        clipboard.save()
    }

    func write(_ string: String) { _ = clipboard.writeOwn(string) }

    func restore() { lastOutcome = clipboard.restore() }
}
