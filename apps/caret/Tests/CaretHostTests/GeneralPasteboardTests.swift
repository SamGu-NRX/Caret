import AppKit
import CaretHostCore
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

    private func writeRich() {
        named.clearContents()
        let first = NSPasteboardItem()
        first.setData(Data("{\\rtf1 Hello}".utf8), forType: .rtf)
        first.setString("<b>Hello</b>", forType: .html)
        first.setString("Hello", forType: .string)
        let second = NSPasteboardItem()
        second.setData(Data([0x89, 0x50, 0x4E, 0x47]), forType: .png)
        named.writeObjects([first, second])
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

    func testRichMultiItemContentsComeBackWithEveryType() {
        writeRich()
        let backend = GeneralPasteboard(named)
        let prior = backend.read()
        XCTAssertEqual(prior.count, 2)
        let pasteboard = ReconcilingPasteboard(backend: backend)
        pasteboard.save()
        pasteboard.write("Lumen Labs")
        XCTAssertEqual(named.string(forType: .string), "Lumen Labs")
        XCTAssertEqual(Set(named.pasteboardItems?.first?.types.map(\.rawValue) ?? []), Set(["public.utf8-plain-text"] + ReconcilingClipboard.markerTypes))
        pasteboard.restore()
        XCTAssertEqual(pasteboard.lastOutcome, .restored)
        XCTAssertEqual(backend.read(), prior, "every item, every type, the same bytes")
        XCTAssertEqual(named.string(forType: .string), "Hello")
    }

    /// The refusal rule on a real pasteboard: with a file URL and a private type on it, the save
    /// refuses, Caret writes nothing, and the contents and change count stay as they were.
    func testAFileURLAndAPrivateTypeAreLeftUntouched() {
        named.clearContents()
        let first = NSPasteboardItem()
        first.setString("Hello", forType: .string)
        first.setData(Data([0, 1, 2, 255]), forType: NSPasteboard.PasteboardType("com.example.private"))
        let second = NSPasteboardItem()
        second.setString("file:///tmp/a.txt", forType: .fileURL)
        named.writeObjects([first, second])
        let backend = GeneralPasteboard(named)
        let prior = backend.read()
        let count = named.changeCount
        let pasteboard = ReconcilingPasteboard(backend: backend)
        pasteboard.save()
        XCTAssertEqual(pasteboard.clipboard.refused, ["item 1: com.example.private", "item 2: public.file-url"])
        pasteboard.write("Lumen Labs")
        pasteboard.restore()
        XCTAssertEqual(pasteboard.lastOutcome, .notWritten)
        XCTAssertEqual(named.changeCount, count, "nothing written")
        XCTAssertEqual(backend.read(), prior)
    }

    func testAnEmptyPasteboardIsEmptyAgain() {
        let backend = GeneralPasteboard(named)
        XCTAssertEqual(backend.read(), [])
        let pasteboard = ReconcilingPasteboard(backend: backend)
        pasteboard.save()
        pasteboard.write("Lumen Labs")
        pasteboard.restore()
        XCTAssertEqual(pasteboard.lastOutcome, .restored)
        XCTAssertEqual(named.pasteboardItems?.count ?? 0, 0)
        XCTAssertNil(named.string(forType: .string))
    }

    /// Someone copies between Caret's write and the restore: their copy stays as they made it.
    func testACopyMadeMidPasteSurvives() {
        writeRich()
        let backend = GeneralPasteboard(named)
        let pasteboard = ReconcilingPasteboard(backend: backend)
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
}
