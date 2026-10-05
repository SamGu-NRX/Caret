import AppKit
import CaretHostCore

/// `PasteboardBackend` over an `NSPasteboard`: the general one in the product, a private named one
/// in tests and experiments (BUILD-ORDER's clipboard rule).
final class GeneralPasteboard: PasteboardBackend {
    let pasteboard: NSPasteboard
    /// Where a restore is rehearsed before the user's clipboard is touched: a pasteboard private to
    /// this process, cleared after every use so no copy of the user's clipboard stays in it.
    let rehearsal: NSPasteboard

    init(_ pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
        rehearsal = NSPasteboard(name: NSPasteboard.Name("dev.caret.host.rehearsal.\(ProcessInfo.processInfo.processIdentifier).\(UUID().uuidString)"))
    }

    deinit { rehearsal.releaseGlobally() }

    var changeCount: Int { pasteboard.changeCount }

    func read() -> PasteboardRead { Self.read(pasteboard) }

    func rehearse(_ items: [PasteboardItemData]) -> PasteboardRead {
        _ = Self.write(items, to: rehearsal)
        let back = Self.read(rehearsal)
        rehearsal.clearContents()
        return back
    }

    func replace(with items: [PasteboardItemData]) -> PasteboardWrite { Self.write(items, to: pasteboard) }

    /// Everything `pasteboard` reports. A type's data is read as data and nothing else: a type whose
    /// data reads as nil is unreadable, never filled in from its string form, which a restore would
    /// write back as different bytes.
    static func read(_ pasteboard: NSPasteboard) -> PasteboardRead {
        let count = pasteboard.changeCount
        let types = pasteboard.types?.map(\.rawValue) ?? []
        let items = (pasteboard.pasteboardItems ?? []).map { item in
            var entries: [(type: String, data: Data)] = []
            var unreadable: [String] = []
            for type in item.types {
                if let data = item.data(forType: type) {
                    entries.append((type: type.rawValue, data: data))
                } else {
                    unreadable.append(type.rawValue)
                }
            }
            return PasteboardItemData(entries, unreadable: unreadable)
        }
        let files = (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL])?.count ?? 0
        return PasteboardRead(changeCount: count, changeCountAfter: pasteboard.changeCount, types: types, items: items, fileURLs: files)
    }

    /// Clears `pasteboard` and writes fresh copies of `items`, so a restore survives the paste having
    /// read the originals. The copies are made before the clear, so the clear and the write are two
    /// adjacent calls. An item with nothing readable is never written here:
    /// `ReconcilingClipboard.check` refuses such contents before any write.
    private static func write(_ items: [PasteboardItemData], to pasteboard: NSPasteboard) -> PasteboardWrite {
        let fresh = items.map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for entry in item.entries { copy.setData(entry.data, forType: NSPasteboard.PasteboardType(entry.type)) }
            return copy
        }
        let cleared = pasteboard.clearContents()
        let written = fresh.isEmpty || pasteboard.writeObjects(fresh)
        return PasteboardWrite(cleared: cleared, written: written, countAfter: pasteboard.changeCount)
    }
}
