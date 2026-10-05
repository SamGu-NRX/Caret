import AppKit
import CaretHostCore
import UniformTypeIdentifiers
import XCTest
@testable import CaretHost

/// The reconcile against a real `NSPasteboard`: a private named one made for each test and released
/// after it, never the general pasteboard (BUILD-ORDER's clipboard rule).
final class GeneralPasteboardTests: XCTestCase {
    private var named: NSPasteboard!

    override func setUp() {
        named = NSPasteboard(name: NSPasteboard.Name("dev.caret.a17.test.\(UUID().uuidString)"))
        named.clearContents()
    }

    override func tearDown() {
        named.releaseGlobally()
        named = nil
    }

    /// Caret's read of a real pasteboard with some items left out of its item list, as Caret's read
    /// of the guest's general pasteboard was in V1b's check 4. The pasteboard's own list of types is
    /// reported in full, and everything written goes to the real pasteboard.
    final class Hiding: PasteboardBackend {
        let inner: GeneralPasteboard
        let hides: (PasteboardItemData) -> Bool
        /// Types a write to the real pasteboard leaves out, as an owner that reads its own type back
        /// differently would. The rehearsal keeps them.
        var drops: Set<String> = []

        init(_ pasteboard: NSPasteboard, hiding hides: @escaping (PasteboardItemData) -> Bool = { _ in false }) {
            inner = GeneralPasteboard(pasteboard)
            self.hides = hides
        }

        var changeCount: Int { inner.changeCount }

        func read() -> PasteboardRead {
            var read = inner.read()
            if read.items.contains(where: hides) {
                read.items.removeAll(where: hides)
                read.fileURLs = 0
            }
            return read
        }

        func rehearse(_ items: [PasteboardItemData]) -> PasteboardRead { inner.rehearse(items) }

        func replace(with items: [PasteboardItemData]) -> Int {
            inner.replace(with: items.map { PasteboardItemData($0.entries.filter { !drops.contains($0.type) }) })
        }
    }

    final class NoData: NSObject, NSPasteboardItemDataProvider {
        func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {}
    }

    final class Promise: NSObject, NSFilePromiseProviderDelegate {
        func filePromiseProvider(_ p: NSFilePromiseProvider, fileNameForType fileType: String) -> String { "a.txt" }
        func filePromiseProvider(_ p: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) { completionHandler(nil) }
    }

    private func richItem() -> NSPasteboardItem {
        let first = NSPasteboardItem()
        first.setData(Data("{\\rtf1 Hello}".utf8), forType: .rtf)
        first.setString("<b>Hello</b>", forType: .html)
        first.setString("Hello", forType: .string)
        first.setData(Data([0, 1, 2, 255]), forType: NSPasteboard.PasteboardType("com.example.private"))
        return first
    }

    private func writeRich() {
        named.clearContents()
        let second = NSPasteboardItem()
        second.setData(Data([0x89, 0x50, 0x4E, 0x47]), forType: .png)
        named.writeObjects([richItem(), second])
    }

    /// The paste as the executor and KeyType's inserter run it: check, arm, save, write, restore.
    /// Returns the check's refusals, or the restore's outcome.
    private func paste(_ backend: PasteboardBackend) -> (refused: [String], outcome: ReconcilingClipboard.Outcome?) {
        let pasteboard = ReconcilingPasteboard(backend: backend)
        switch pasteboard.clipboard.check() {
        case .refused(let reasons, _):
            return (reasons, nil)
        case .pasteable(let snapshot):
            pasteboard.clipboard.arm(snapshot)
            pasteboard.save()
            pasteboard.write("Lumen Labs")
            XCTAssertEqual(named.string(forType: .string), "Lumen Labs")
            pasteboard.restore()
            return ([], pasteboard.lastOutcome)
        }
    }

    /// The premise `ReconcilingClipboard` rests on: a clear moves the count by exactly one, and the
    /// items written after it do not move it again.
    func testAClearMovesTheCountByOneAndWritingDoesNot() {
        let backend = GeneralPasteboard(named)
        let before = backend.changeCount
        let cleared = backend.replace(with: [PasteboardItemData([(type: "public.utf8-plain-text", data: Data("x".utf8))])])
        XCTAssertEqual(cleared, before + 1)
        XCTAssertEqual(backend.changeCount, cleared)
    }

    /// Rich text, HTML, plain text, a private type and an image item: the rehearsal on Caret's own
    /// pasteboard reports every type the pasteboard does, so the check passes, and a fresh read after
    /// the restore matches type for type and byte for byte.
    func testRichMultiItemContentsComeBackWithEveryType() {
        writeRich()
        let backend = GeneralPasteboard(named)
        let prior = backend.read()
        XCTAssertEqual(prior.items.count, 2)
        let pasteboard = ReconcilingPasteboard(backend: backend)
        guard case .pasteable(let snapshot) = pasteboard.clipboard.check() else { return XCTFail("refused: \(pasteboard.clipboard.check())") }
        pasteboard.clipboard.arm(snapshot)
        pasteboard.save()
        pasteboard.write("Lumen Labs")
        XCTAssertEqual(named.string(forType: .string), "Lumen Labs")
        XCTAssertEqual(Set(named.pasteboardItems?.first?.types.map(\.rawValue) ?? []), Set(["public.utf8-plain-text"] + ReconcilingClipboard.markerTypes))
        pasteboard.restore()
        XCTAssertEqual(pasteboard.lastOutcome, .restored)
        let back = backend.read()
        XCTAssertEqual(back.items, prior.items, "every item, every type, the same bytes")
        XCTAssertEqual(Set(back.types), Set(prior.types))
        XCTAssertEqual(named.string(forType: .string), "Hello")
    }

    /// A file URL in an item Caret reads: the check refuses, Caret writes nothing, and the contents
    /// and change count stay as they were.
    func testAFileURLIsLeftUntouched() {
        named.clearContents()
        let second = NSPasteboardItem()
        second.setString("file:///tmp/a.txt", forType: .fileURL)
        named.writeObjects([richItem(), second])
        let count = named.changeCount
        let prior = GeneralPasteboard(named).read()
        let result = paste(GeneralPasteboard(named))
        XCTAssertTrue(result.refused.contains("item 2: public.file-url"), "\(result.refused)")
        XCTAssertTrue(result.refused.contains("pasteboard: 1 file URL(s)"), "\(result.refused)")
        XCTAssertNil(result.outcome)
        XCTAssertEqual(named.changeCount, count, "nothing written")
        XCTAssertEqual(GeneralPasteboard(named).read(), prior)
    }

    // MARK: - V1b: items Caret's read does not list

    /// V1b's check 4 on a real pasteboard: the second item holds only a file URL and Caret's read does
    /// not list it. Until H7b Caret pasted, restored the first item alone, and said `restored`. The
    /// pasteboard's types still name the file URL, so the check refuses and nothing is written.
    func testAFileURLItemCaretsReadDoesNotListIsLeftUntouched() {
        named.clearContents()
        let second = NSPasteboardItem()
        second.setString("file:///private/tmp/a17-prior.txt", forType: .fileURL)
        named.writeObjects([richItem(), second])
        assertRefusedAndUntouched(Hiding(named, hiding: { $0.types.contains("public.file-url") }), because: "pasteboard: public.file-url")
    }

    func testAFilePromiseCaretsReadDoesNotListIsLeftUntouched() {
        named.clearContents()
        let delegate = Promise()
        let provider = NSFilePromiseProvider(fileType: UTType.plainText.identifier, delegate: delegate)
        named.writeObjects([richItem(), provider])
        assertRefusedAndUntouched(Hiding(named, hiding: { $0.types.contains("com.apple.NSFilePromiseItemMetaData") }), because: "pasteboard: com.apple.NSFilePromiseItemMetaData")
        withExtendedLifetime(delegate) {}
    }

    func testAnUnreadableTypeCaretsReadDoesNotListIsLeftUntouched() {
        named.clearContents()
        let provider = NoData()
        let lazy = NSPasteboardItem()
        lazy.setDataProvider(provider, forTypes: [NSPasteboard.PasteboardType("dev.caret.test.lazy")])
        named.writeObjects([richItem(), lazy])
        assertRefusedAndUntouched(Hiding(named, hiding: { $0.unreadable.contains("dev.caret.test.lazy") }), because: "pasteboard: dev.caret.test.lazy: in no item Caret read")
        withExtendedLifetime(provider) {}
    }

    /// A type whose data reads as nil, in an item Caret does read, refuses too.
    func testATypeWhoseDataReadsNilIsRefused() {
        named.clearContents()
        let provider = NoData()
        let item = richItem()
        item.setDataProvider(provider, forTypes: [NSPasteboard.PasteboardType("dev.caret.test.lazy")])
        named.writeObjects([item])
        let count = named.changeCount
        let result = paste(GeneralPasteboard(named))
        XCTAssertEqual(result.refused, ["item 1: dev.caret.test.lazy: no data"])
        XCTAssertEqual(named.changeCount, count)
        withExtendedLifetime(provider) {}
    }

    private func assertRefusedAndUntouched(_ backend: Hiding, because reason: String, line: UInt = #line) {
        let count = named.changeCount
        let truth = GeneralPasteboard(named).read()
        XCTAssertEqual(truth.items.count, 2, "the pasteboard holds both items", line: line)
        let result = paste(backend)
        XCTAssertTrue(result.refused.contains(reason), "\(result.refused)", line: line)
        XCTAssertNil(result.outcome, "no paste, so nothing to restore", line: line)
        XCTAssertEqual(named.changeCount, count, "nothing written", line: line)
        let after = GeneralPasteboard(named).read()
        XCTAssertEqual(after.items.count, 2, "the hidden item is still there", line: line)
        XCTAssertEqual(after.items.map(\.types), truth.items.map(\.types), line: line)
    }

    // MARK: - Restored means a fresh read matched

    /// A private type is put back byte for byte, and the fresh read finds nothing different.
    func testAPrivateTypeComesBackByteForByte() {
        named.clearContents()
        let item = NSPasteboardItem()
        item.setString("Hello", forType: .string)
        item.setData(Data([0, 1, 2, 255, 0x7F]), forType: NSPasteboard.PasteboardType("com.example.private"))
        named.writeObjects([item])
        let prior = GeneralPasteboard(named).read()
        let result = paste(GeneralPasteboard(named))
        XCTAssertEqual(result.refused, [])
        XCTAssertEqual(result.outcome, .restored)
        XCTAssertEqual(GeneralPasteboard(named).read().items, prior.items)
    }

    /// A restore the real pasteboard does not keep whole is `notRestored`, naming what was lost. Until
    /// H7b it said `restored` and listed the difference beside it.
    func testARestoreTheFreshReadFindsDifferentIsNotRestored() {
        writeRich()
        let backend = Hiding(named)
        backend.drops = ["com.example.private"]
        let result = paste(backend)
        XCTAssertEqual(result.refused, [])
        XCTAssertEqual(result.outcome, .notRestored(lost: ["item 1: com.example.private: missing", "pasteboard: com.example.private: missing"]))
    }

    func testAnEmptyPasteboardIsEmptyAgain() {
        let backend = GeneralPasteboard(named)
        XCTAssertEqual(backend.read().items, [])
        let result = paste(backend)
        XCTAssertEqual(result.outcome, .restored)
        XCTAssertEqual(named.pasteboardItems?.count ?? 0, 0)
        XCTAssertNil(named.string(forType: .string))
    }

    /// Someone copies between Caret's write and the restore: their copy stays as they made it.
    func testACopyMadeMidPasteSurvives() {
        writeRich()
        let backend = GeneralPasteboard(named)
        let pasteboard = ReconcilingPasteboard(backend: backend)
        guard case .pasteable(let snapshot) = pasteboard.clipboard.check() else { return XCTFail("refused") }
        pasteboard.clipboard.arm(snapshot)
        pasteboard.save()
        pasteboard.write("Lumen Labs")
        named.clearContents()
        named.setString("copied mid-paste", forType: .string)
        let count = named.changeCount
        pasteboard.restore()
        XCTAssertEqual(pasteboard.lastOutcome, .skippedUserCopied)
        XCTAssertEqual(named.string(forType: .string), "copied mid-paste")
        XCTAssertEqual(named.changeCount, count)
    }

    /// The rehearsal leaves nothing of the user's clipboard on Caret's private pasteboard.
    func testTheRehearsalLeavesItsPasteboardEmpty() {
        writeRich()
        let backend = GeneralPasteboard(named)
        let back = backend.rehearse(backend.read().items)
        XCTAssertEqual(back.items.count, 2)
        XCTAssertEqual(backend.rehearsal.pasteboardItems?.count ?? 0, 0, "cleared after use")
        XCTAssertTrue(backend.rehearsal.name.rawValue.hasPrefix("dev.caret.host.rehearsal."), "never the general pasteboard")
    }
}
