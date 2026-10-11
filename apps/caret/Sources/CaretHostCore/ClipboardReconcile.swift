import Foundation

/// One pasteboard item: every type it carries, in the order the pasteboard listed them, with its data.
public struct PasteboardItemData: Equatable, Sendable {
    public var entries: [(type: String, data: Data)]
    /// Types the pasteboard listed for the item whose data read as nil, so a restore cannot bring
    /// them back. Reported, never guessed at.
    public var unreadable: [String]

    public init(_ entries: [(type: String, data: Data)], unreadable: [String] = []) {
        self.entries = entries
        self.unreadable = unreadable
    }

    public var types: [String] { entries.map { $0.type } }

    public static func == (a: Self, b: Self) -> Bool {
        a.unreadable == b.unreadable && a.entries.count == b.entries.count && zip(a.entries, b.entries).allSatisfy { $0.type == $1.type && $0.data == $1.data }
    }
}

/// One read of a pasteboard: everything it reports about its contents, so what Caret saved can be
/// checked against what the pasteboard says it holds.
public struct PasteboardRead: Equatable, Sendable {
    /// The change count before the read, and after it. A read whose counts differ saw two contents.
    public var changeCount: Int
    public var changeCountAfter: Int
    /// The types the pasteboard reports for its contents as a whole (`NSPasteboard.types`): every
    /// item's types and the older names the system derives from them.
    public var types: [String]
    public var items: [PasteboardItemData]
    /// How many file URLs the system's own reader finds (`readObjects` with file URLs only).
    public var fileURLs: Int

    public init(changeCount: Int, changeCountAfter: Int? = nil, types: [String], items: [PasteboardItemData], fileURLs: Int = 0) {
        self.changeCount = changeCount
        self.changeCountAfter = changeCountAfter ?? changeCount
        self.types = types
        self.items = items
        self.fileURLs = fileURLs
    }
}

/// The few pasteboard calls the reconcile needs, so it tests against a fake and runs against
/// `NSPasteboard` (`GeneralPasteboard` in CaretHost).
public protocol PasteboardBackend: AnyObject {
    var changeCount: Int { get }
    /// Everything the pasteboard reports, read afresh.
    func read() -> PasteboardRead
    /// Writes `items` to a private pasteboard of Caret's own, reads it back, and clears it: what a
    /// restore of exactly these items would report, before anything of the user's is touched.
    func rehearse(_ items: [PasteboardItemData]) -> PasteboardRead
    /// Clears the pasteboard and writes `items` (none leaves it empty), and says what happened.
    func replace(with items: [PasteboardItemData]) -> PasteboardWrite
}

/// What one `PasteboardBackend.replace` did.
public struct PasteboardWrite: Equatable, Sendable {
    /// The change count the clear produced. A write by anyone else between the caller's last check
    /// and the clear moves it past `checked + 1`.
    public var cleared: Int
    /// The pasteboard took every item (`NSPasteboard.writeObjects` said yes, or there were none).
    public var written: Bool
    /// The change count once the items were written. Writing does not move the count
    /// (`GeneralPasteboardTests` pins this), so anything but `cleared` means someone else wrote
    /// between the clear and the end of the write.
    public var countAfter: Int

    public init(cleared: Int, written: Bool = true, countAfter: Int? = nil) {
        self.cleared = cleared
        self.written = written
        self.countAfter = countAfter ?? cleared
    }

    /// The write landed whole and nobody else wrote in between.
    public var whole: Bool { written && countAfter == cleared }
}

/// A read of the user's clipboard that passed `ReconcilingClipboard.check`. Only the check makes
/// one, so nothing can be written over the user's clipboard, or restored, from an unchecked read.
public struct ClipboardSnapshot: Equatable, Sendable {
    public let read: PasteboardRead

    fileprivate init(_ read: PasteboardRead) { self.read = read }

    /// Each item's types, names only, for the debug state.
    public var types: [[String]] { read.items.map(\.types) }
}

/// Insertion through the general pasteboard, by Sam's decision of 2026-10-04: paste, then reconcile.
///
/// 1. `check` reads the pasteboard and either refuses, saying why, or returns a `ClipboardSnapshot`.
///    It refuses anything a restore could not put back exactly: a file URL or file promise anywhere,
///    a type whose data reads as nil, an item with no type, a type the pasteboard reports that no
///    item Caret read carries, and contents that a rehearsal on Caret's own private pasteboard does
///    not bring back type for type and byte for byte.
/// 2. `arm` takes that snapshot for the next paste.
/// 3. `writeOwn` writes Caret's text, marked with the nspasteboard.org transient, concealed and
///    auto-generated types so clipboard managers skip it, only while the pasteboard is still at the
///    snapshot's change count, and records the count its write produced.
/// 4. `restore`, once the paste has landed, puts the snapshot back only if the count is still
///    Caret's. Any other count means someone wrote in between (the user copied), and their copy
///    stays. It then reads the pasteboard afresh and says `restored` only if that read matches the
///    snapshot type for type and byte for byte; anything else is `notRestored`, with what was lost.
///
/// Why the checks go beyond the items Caret read: in V1b's VM run (check 4, 2026-10-05) Caret's
/// read of the general pasteboard listed one item where the pasteboard held two, the second a file
/// URL. Caret pasted, put back the one item it had, and reported `restored`.
///
/// Every key the paste posts asks `mayPost` first: once Caret has written, a ⌘V is posted only while
/// the pasteboard still holds Caret's item, since after the user's copy it would paste theirs.
///
/// Known limits: NSPasteboard has no compare-and-swap, so a copy made in the instant between a count
/// check and the clear after it (two adjacent calls on one thread) is overwritten. The clear's own
/// count shows that it happened, and the outcome is `notRestored` naming it; nothing can bring that
/// copy back. And the app reads the pasteboard when it handles the ⌘V, after `mayPost` said yes.
public final class ReconcilingClipboard {
    public enum Outcome: Equatable, Sendable {
        /// The snapshot is back, and a fresh read matched it type for type and byte for byte.
        case restored
        /// Someone wrote after Caret did; their contents stay and Caret's snapshot is dropped.
        case skippedUserCopied
        /// Something of the user's clipboard did not come back: each entry names what.
        case notRestored(lost: [String])
        /// Nothing was written by Caret, so there was nothing to put back.
        case notWritten

        /// The debug state's name for it.
        public var name: String {
            switch self {
            case .restored: return "restored"
            case .skippedUserCopied: return "skippedUserCopied"
            case .notRestored: return "notRestored"
            case .notWritten: return "notWritten"
            }
        }

        public var lost: [String] {
            if case .notRestored(let lost) = self { return lost }
            return []
        }
    }

    /// What `check` found.
    public enum Check: Equatable, Sendable {
        case pasteable(ClipboardSnapshot)
        /// Why a paste would not be put back exactly, and each item's types as read.
        case refused(reasons: [String], types: [[String]])
    }

    /// nspasteboard.org's markers. A clipboard manager that honours them does not record the item.
    public static let markerTypes = [
        "org.nspasteboard.TransientType",
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.AutoGeneratedType",
    ]
    public static let plainText = "public.utf8-plain-text"

    /// Types that name a file instead of carrying bytes, and file promises (an app's offer to write
    /// a file later). A17's VM probe (vm-insert run 1, clipboard/pasteboard.ndjson) put back an
    /// item holding `public.file-url` 5 of 5 times, reported `restored` with nothing unreadable,
    /// and the item was gone each time. The older names are listed because the pasteboard reports
    /// them beside the items' types (`PasteboardRead.types`).
    public static let fileTypes: Set<String> = [
        "public.file-url", "NSFilenamesPboardType", "CorePasteboardFlavorType 0x6675726C",
        "com.apple.NSFilePromiseItemMetaData", "Apple files promise pasteboard type", "NSPromiseContentsPboardType",
    ]

    /// Whether a type names or promises a file by its name alone: a type in `fileTypes` or any
    /// `com.apple.pasteboard.promised-` type.
    public static func namesFile(_ type: String) -> Bool {
        fileTypes.contains(type) || type.hasPrefix("com.apple.pasteboard.promised-")
    }

    /// Whether this entry names or promises a file: by its type, or a URL type whose data holds a
    /// file URL.
    public static func refersToFile(type: String, data: Data) -> Bool {
        if namesFile(type) { return true }
        guard type == "public.url" || type == "Apple URL pasteboard type" else { return false }
        return data.range(of: Data("file:".utf8)) != nil
    }

    /// Why `read` cannot be pasted over and put back exactly; empty when it can. `rehearse` writes
    /// items to Caret's private pasteboard and reads them back (`PasteboardBackend.rehearse`); it is
    /// called only when nothing else refused, so a refused clipboard is never copied anywhere.
    public static func refusals(_ read: PasteboardRead, rehearse: ([PasteboardItemData]) -> PasteboardRead) -> [String] {
        var out: [String] = []
        if read.changeCount != read.changeCountAfter {
            out.append("the pasteboard changed while Caret read it (count \(read.changeCount) to \(read.changeCountAfter))")
        }
        if read.fileURLs > 0 { out.append("pasteboard: \(read.fileURLs) file URL(s)") }
        out += read.types.filter(namesFile).map { "pasteboard: \($0)" }
        for (i, item) in read.items.enumerated() {
            if item.entries.isEmpty && item.unreadable.isEmpty { out.append("item \(i + 1): no type") }
            out += item.unreadable.map { "item \(i + 1): \($0): no data" }
            out += item.entries.filter { refersToFile(type: $0.type, data: $0.data) }.map { "item \(i + 1): \($0.type)" }
        }
        guard out.isEmpty else { return out }
        // Every type the pasteboard reports must be one that a restore of the items Caret read reports
        // too. A type outside every item Caret read belongs to something it did not read, which a
        // restore would drop; one inside them that the rehearsal lost would be lost by the restore.
        let rehearsal = rehearse(read.items)
        let itemTypes = Set(read.items.flatMap(\.types))
        let types = typeDifferences(expected: read.types, now: rehearsal.types)
        out += types.missing.filter { !itemTypes.contains($0) }.map { "pasteboard: \($0): in no item Caret read" }
        out += itemDifferences(expected: read.items, now: rehearsal.items).map { "rehearsal: \($0)" }
        out += types.missing.filter { itemTypes.contains($0) }.map { "rehearsal: pasteboard: \($0): missing" }
        out += types.added.map { "rehearsal: pasteboard: \($0): added" }
        return out
    }

    /// Where `now` differs from `expected`, entry by entry ("item 2: missing (public.file-url)",
    /// "item 1: com.example.private: 4 bytes came back as 0 different bytes", "pasteboard:
    /// public.rtf: missing"). Empty when every item came back with the same types in the same order
    /// and the same bytes, and the pasteboard reports the same set of types and file URLs.
    ///
    /// Each item's types are compared in order, since an item lists its forms from richest to
    /// poorest. The pasteboard's own list is compared as a set: apps pick a type by their own order
    /// of preference (`availableType(from:)`), so its order carries nothing a restore must keep.
    public static func differences(expected: PasteboardRead, now: PasteboardRead) -> [String] {
        var out: [String] = []
        if now.changeCount != now.changeCountAfter {
            out.append("the pasteboard changed while Caret read it back (count \(now.changeCount) to \(now.changeCountAfter))")
        }
        out += itemDifferences(expected: expected.items, now: now.items)
        let types = typeDifferences(expected: expected.types, now: now.types)
        out += types.missing.map { "pasteboard: \($0): missing" } + types.added.map { "pasteboard: \($0): added" }
        if now.fileURLs != expected.fileURLs { out.append("pasteboard: \(expected.fileURLs) file URL(s) came back as \(now.fileURLs)") }
        return out
    }

    static func itemDifferences(expected: [PasteboardItemData], now: [PasteboardItemData]) -> [String] {
        var out: [String] = []
        for (i, item) in expected.enumerated() {
            guard i < now.count else {
                out.append("item \(i + 1): missing (\(item.types.joined(separator: ", ")))")
                continue
            }
            let back = now[i]
            let backData = Dictionary(back.entries.map { ($0.type, $0.data) }, uniquingKeysWith: { a, _ in a })
            for entry in item.entries {
                guard let data = backData[entry.type] else { out.append("item \(i + 1): \(entry.type): missing"); continue }
                if data != entry.data { out.append("item \(i + 1): \(entry.type): \(entry.data.count) bytes came back as \(data.count) different bytes") }
            }
            let expectedTypes = Set(item.types)
            out += back.types.filter { !expectedTypes.contains($0) }.map { "item \(i + 1): \($0): added" }
            out += back.unreadable.map { "item \(i + 1): \($0): no data" }
            if back.types != item.types, Set(back.types) == expectedTypes { out.append("item \(i + 1): types came back in another order") }
        }
        if now.count > expected.count { out.append("\(now.count - expected.count) more item(s) than were saved") }
        return out
    }

    static func typeDifferences(expected: [String], now: [String]) -> (missing: [String], added: [String]) {
        let reported = Set(now), wanted = Set(expected)
        return (expected.filter { !reported.contains($0) }, now.filter { !wanted.contains($0) })
    }

    private let backend: PasteboardBackend
    /// The snapshot the next paste may write over and must restore.
    private var armed: ClipboardSnapshot?
    /// What the next restore must report as lost whatever it finds: a copy overwritten by Caret's own
    /// write.
    private var overwritten: [String] = []
    /// Why the last arming or write refused, or why posting stopped. While non-empty, `writeOwn`
    /// writes nothing and `mayPost` is false. The one write after a refusal is `restore` putting the
    /// user's snapshot back over Caret's own item.
    public private(set) var refused: [String] = []
    /// The change count of Caret's own clear, once it has written over the armed snapshot. Until the
    /// restore, the snapshot is pending and nothing may replace it.
    public private(set) var ownCount: Int?

    public init(backend: PasteboardBackend) { self.backend = backend }

    /// Reads the pasteboard now and checks it (`refusals`).
    public func check() -> Check {
        let read = backend.read()
        let reasons = Self.refusals(read, rehearse: backend.rehearse)
        return reasons.isEmpty ? .pasteable(ClipboardSnapshot(read)) : .refused(reasons: reasons, types: read.items.map(\.types))
    }

    /// Takes `snapshot` for the next paste, or refuses with a reason when the pasteboard has changed
    /// since it was read. Call immediately before the paste. While a write waits for its restore,
    /// it refuses and keeps that write's snapshot.
    public func arm(_ snapshot: ClipboardSnapshot) {
        guard ownCount == nil else { return latch("a write is still waiting for its restore") }
        overwritten = []
        guard backend.changeCount == snapshot.read.changeCount else {
            armed = nil
            refused = ["the pasteboard changed after Caret checked it (count \(snapshot.read.changeCount) to \(backend.changeCount))"]
            return
        }
        armed = snapshot
        refused = []
    }

    /// Ends an armed paste that has not written: the next `restore` reports `notWritten`. While a
    /// write waits for its restore, it only stops posting and keeps that write's snapshot.
    public func disarm(_ reason: String) {
        guard ownCount == nil else { return latch(reason) }
        armed = nil
        refused = [reason]
    }

    /// Whether a key may be posted to the target now: an armed snapshot, no refusal, and, once Caret
    /// has written, the pasteboard still at Caret's count. A ⌘V after someone else's copy would paste
    /// their contents into the field. The first false latches, so nothing later is posted either.
    /// What remains: the app reads the pasteboard when it handles the ⌘V, after this check.
    public func mayPost() -> Bool {
        guard refused.isEmpty, armed != nil else { return false }
        guard let own = ownCount else { return true }
        let now = backend.changeCount
        guard now == own else {
            latch("the pasteboard changed after Caret wrote its own item (count \(own) to \(now)); nothing more is posted")
            return false
        }
        return true
    }

    private func latch(_ reason: String) {
        if refused.isEmpty { refused = [reason] }
    }

    /// Writes `text` as Caret's own item over the armed snapshot. Returns the change count it
    /// produced, or nil when nothing was written, the write did not land whole, or a copy was
    /// overwritten: no paste may be posted.
    @discardableResult
    public func writeOwn(_ text: String) -> Int? {
        guard ownCount == nil else {
            latch("a write is still waiting for its restore")
            return nil
        }
        guard refused.isEmpty, let armed else {
            latch("no checked snapshot was armed")
            return nil
        }
        // Anyone's write since the check would be overwritten by Caret's.
        guard backend.changeCount == armed.read.changeCount else {
            self.armed = nil
            refused = ["the pasteboard changed after Caret checked it (count \(armed.read.changeCount) to \(backend.changeCount))"]
            return nil
        }
        var entries: [(type: String, data: Data)] = [(Self.plainText, Data(text.utf8))]
        for marker in Self.markerTypes { entries.append((marker, Data())) }
        // The clear's own count, never one read afterwards: a copy made between the write and a later
        // read would otherwise be taken for Caret's and overwritten by the restore (A17 review).
        let write = backend.replace(with: [PasteboardItemData(entries)])
        // From the clear on, the snapshot must go back, whatever else happened.
        ownCount = write.cleared
        if write.cleared != armed.read.changeCount + 1 {
            // Someone wrote in the instant between the count check and the clear, and Caret's clear
            // took it. The snapshot still goes back; the copy is reported lost, and nothing is pasted.
            overwritten.append("a copy made as Caret wrote its own item was overwritten (count \(armed.read.changeCount) to \(write.cleared - 1))")
        }
        if write.countAfter != write.cleared {
            // Someone wrote between Caret's clear and the end of its write: their copy may hold
            // Caret's item too, so Caret cannot say it is intact.
            overwritten.append("a copy made while Caret wrote its own item may hold Caret's text (count \(write.cleared) to \(write.countAfter))")
        }
        if !overwritten.isEmpty {
            refused = overwritten
            return nil
        }
        guard write.written else {
            refused = ["the pasteboard did not take Caret's own item"]
            return nil
        }
        return write.cleared
    }

    /// Puts the armed snapshot back if the pasteboard still holds Caret's write, then reads it afresh
    /// and compares.
    public func restore() -> Outcome {
        defer {
            armed = nil
            ownCount = nil
            overwritten = []
            refused = []
        }
        guard let own = ownCount, let armed else { return .notWritten }
        guard backend.changeCount == own else { return overwritten.isEmpty ? .skippedUserCopied : .notRestored(lost: overwritten) }
        let write = backend.replace(with: armed.read.items)
        var lost = overwritten
        if write.cleared != own + 1 { lost.append("a copy made as Caret restored the clipboard was overwritten (count \(own) to \(write.cleared - 1))") }
        if !write.written { lost.append("the pasteboard did not take the saved clipboard back") }
        // A fresh read, never the restore's own bookkeeping: a count says nothing about what an
        // owner's pasteboard type gives back. It must be of the restore's own write; after anyone
        // else's, it says nothing about the restore.
        let now = backend.read()
        if now.changeCount != write.cleared {
            lost.append("the pasteboard changed before the restore could be checked (count \(write.cleared) to \(now.changeCount))")
        } else {
            lost += Self.differences(expected: armed.read, now: now)
        }
        return lost.isEmpty ? .restored : .notRestored(lost: lost)
    }
}
