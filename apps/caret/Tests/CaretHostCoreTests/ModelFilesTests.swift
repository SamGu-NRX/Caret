import XCTest
@testable import CaretHostCore

/// Brief item 8: Caret's own model copy first, Cotypist's as the fallback, what the menu says, and when a download may
/// start.
final class ModelFilesTests: XCTestCase {
    let home = URL(fileURLWithPath: "/Users/example")

    func testCaretsCopyComesFirst() {
        let both = ModelFiles.find(home: home, named: nil, exists: { _ in true })
        XCTAssertEqual(both?.source, .caret)
        XCTAssertEqual(both?.url.path, "/Users/example/Library/Application Support/Caret/v2-host/Models/gemma-4-E2B.i1-Q4_K_M.gguf")
    }

    func testCotypistsCopyIsTheFallback() {
        let found = ModelFiles.find(home: home, named: nil, exists: { $0.path.contains("app.cotypist.Cotypist") })
        XCTAssertEqual(found?.source, .cotypist)
        XCTAssertEqual(found?.url.lastPathComponent, "gemma-4-E2B-i1-Q4_K_M.gguf")
    }

    func testNothingWhenNeitherIsThere() {
        XCTAssertNil(ModelFiles.find(home: home, named: nil, exists: { _ in false }))
    }

    func testANamedPathWinsEvenWhenMissing() {
        let found = ModelFiles.find(home: home, named: "/tmp/other.gguf", exists: { _ in false })
        XCTAssertEqual(found, ModelFiles.Found(url: URL(fileURLWithPath: "/tmp/other.gguf"), source: .named))
        XCTAssertEqual(ModelFiles.find(home: home, named: "", exists: { _ in true })?.source, .caret, "an empty name is no name")
    }

    func testTheDownloadIsThePinnedPublicFile() {
        XCTAssertEqual(ModelFiles.url.absoluteString,
                       "https://huggingface.co/mradermacher/gemma-4-E2B-i1-GGUF/resolve/a9bf638e53783fc93778f357cc5c672eab5393b1/gemma-4-E2B.i1-Q4_K_M.gguf")
        XCTAssertEqual(ModelFiles.sha256, "3cc0e9c2b4bbffea7f3f6cfe1ffd1591f4dafe02c43f78952f1142a24172df65")
    }

    func testTheDiskMustHoldWhatIsLeftPlusTheMargin() {
        let total: Int64 = 3_000_000_000
        XCTAssertNil(ModelFiles.diskRefusal(freeBytes: total + ModelFiles.diskMargin, alreadyHave: 0, total: total))
        XCTAssertNotNil(ModelFiles.diskRefusal(freeBytes: total + ModelFiles.diskMargin - 1, alreadyHave: 0, total: total))
        XCTAssertNil(ModelFiles.diskRefusal(freeBytes: ModelFiles.diskMargin + 1_000, alreadyHave: total - 1_000, total: total),
                     "a resumed download needs room only for what is left")
        XCTAssertNotNil(ModelFiles.diskRefusal(freeBytes: nil, alreadyHave: 0), "unknown free space refuses")
    }

    func testTheMenuNamesTheFileInUseAndOffersTheDownloadOnlyWhenItHelps() {
        let cotypist = ModelFiles.Found(url: home.appendingPathComponent(ModelFiles.cotypistFile), source: .cotypist)
        let caret = ModelFiles.Found(url: ModelFiles.caretFile(home: home), source: .caret)
        XCTAssertEqual(ModelCopy.inUse(cotypist), "Using Cotypist's copy of Gemma 4 E2B, read in place.")
        XCTAssertEqual(ModelCopy.inUse(caret), "Using Caret's copy of Gemma 4 E2B.")
        XCTAssertEqual(ModelCopy.action(cotypist, .idle, menu: true), "Download Caret's Model (3.4 GB)…")
        XCTAssertEqual(ModelCopy.action(nil, .idle, menu: false), "Download Caret's model (3.4 GB)")
        XCTAssertNil(ModelCopy.action(caret, .idle, menu: true))
        XCTAssertNil(ModelCopy.action(cotypist, .ready, menu: true), "a finished copy waits for the next launch")
        XCTAssertEqual(ModelCopy.action(cotypist, .downloading(received: 1, total: 4), menu: true), "Stop Downloading the Model (25%)")
        XCTAssertEqual(ModelCopy.action(cotypist, .failed("x"), menu: false), "Download Caret's model (3.4 GB)", "a failure can be tried again")
    }
}
