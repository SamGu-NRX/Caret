import CaretHostCore
import XCTest
@testable import CaretHost

/// Brief item 8: which file the keeper says is in use, and when it offers the download.
@MainActor
final class ModelKeeperTests: XCTestCase {
    let home = URL(fileURLWithPath: "/Users/example")

    func testCotypistsCopyInUseOffersCaretsOwn() {
        let k = ModelKeeper(configured: home.appendingPathComponent(ModelFiles.cotypistFile), home: home, exists: { _ in true })
        XCTAssertEqual(k.inUse?.source, .cotypist)
        XCTAssertEqual(k.action(menu: true), "Download Caret's Model (3.4 GB)…")
    }

    func testCaretsCopyInUseOffersNothing() {
        let k = ModelKeeper(configured: ModelFiles.caretFile(home: home), home: home, exists: { _ in true })
        XCTAssertEqual(k.line, "Using Caret's copy of Gemma 4 E2B.")
        XCTAssertNil(k.action(menu: true))
    }

    func testNoFileSaysSoAndOffersTheDownload() {
        let k = ModelKeeper(configured: ModelFiles.caretFile(home: home), home: home, exists: { _ in false })
        XCTAssertNil(k.inUse)
        XCTAssertEqual(k.line, "No model yet. Download Caret's copy to get suggestions.")
        XCTAssertNotNil(k.action(menu: false))
    }

    func testANamedFileIsNamedAndOffersNothing() {
        let k = ModelKeeper(configured: URL(fileURLWithPath: "/tmp/other.gguf"), home: home, exists: { _ in true })
        XCTAssertEqual(k.line, "Using other.gguf, named at launch.")
        XCTAssertNil(k.action(menu: true))
    }
}
