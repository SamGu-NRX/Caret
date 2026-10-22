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

    /// PR #16 review: a run with its own home downloaded into the user's Library. No byte is fetched here: the
    /// download is refused for disk space before any request.
    func testADownloadGoesToTheFolderItWasGiven() throws {
        var folders: [URL] = []
        let inside = FileManager.default.temporaryDirectory.appendingPathComponent("keeper-\(UUID().uuidString)/Models")
        defer { try? FileManager.default.removeItem(at: inside.deletingLastPathComponent()) }
        let k = ModelKeeper(configured: ModelFiles.caretFile(home: home), home: home, downloadFolder: inside, exists: { _ in false },
                            makeDownload: { folders.append($0); return ModelDownload(folder: $0, freeBytes: { _ in 0 }) })
        k.toggle()
        XCTAssertEqual(folders, [inside])
    }

    func testANamedFileIsNamedAndOffersNothing() {
        let k = ModelKeeper(configured: URL(fileURLWithPath: "/tmp/other.gguf"), home: home, exists: { _ in true })
        XCTAssertEqual(k.line, "Using other.gguf, named at launch.")
        XCTAssertNil(k.action(menu: true))
    }
}
