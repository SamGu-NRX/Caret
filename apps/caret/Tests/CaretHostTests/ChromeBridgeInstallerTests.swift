import CaretHostCore
import XCTest
@testable import CaretHost

/// Add to Chrome's manifest writing, in a directory of the test's own: what it writes, what it leaves alone, and that a
/// run with its own Caret home never falls back to the user's browser.
final class ChromeBridgeInstallerTests: XCTestCase {
    private var dir = ""
    private let bridge = "/Applications/Caret.app/Contents/Helpers/caret-bridge"

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-nmh-\(UUID().uuidString)").path
    }

    override func tearDownWithError() throws {
        chmod(dir + "/ai.caret.bridge.json", 0o644)
        try? FileManager.default.removeItem(atPath: dir)
    }

    private var file: String { dir + "/ai.caret.bridge.json" }

    func testWritesIntoADirectoryChromeHasNotMadeYetThenLeavesItUnchanged() throws {
        XCTAssertEqual(ChromeBridgeInstaller.writeManifest(bridgePath: bridge, directory: dir), .installed("wrote \(file)"))
        XCTAssertEqual(FileManager.default.contents(atPath: file), NativeMessagingManifest(bridgePath: bridge).encoded())
        XCTAssertEqual(ChromeBridgeInstaller.writeManifest(bridgePath: bridge, directory: dir), .installed("\(file) already starts \(bridge)"))
    }

    func testReplacesAManifestForAMovedCaret() throws {
        _ = ChromeBridgeInstaller.writeManifest(bridgePath: "/Users/robin/Downloads/Caret.app/Contents/Helpers/caret-bridge", directory: dir)
        XCTAssertEqual(ChromeBridgeInstaller.writeManifest(bridgePath: bridge, directory: dir), .installed("wrote \(file)"))
        XCTAssertEqual(FileManager.default.contents(atPath: file), NativeMessagingManifest(bridgePath: bridge).encoded())
    }

    func testLeavesAForeignFileAlone() throws {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let foreign = Data(#"{"name":"ai.caret.bridge","description":"x","path":"/usr/local/bin/other","type":"stdio","allowed_origins":[]}"#.utf8)
        FileManager.default.createFile(atPath: file, contents: foreign)
        guard case .refused = ChromeBridgeInstaller.writeManifest(bridgePath: bridge, directory: dir) else { return XCTFail() }
        XCTAssertEqual(FileManager.default.contents(atPath: file), foreign)
    }

    func testLeavesAFileItCannotReadAlone() throws {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: file, contents: Data("someone else's".utf8))
        chmod(file, 0o000)
        guard case .refused(let why) = ChromeBridgeInstaller.writeManifest(bridgePath: bridge, directory: dir) else {
            return XCTFail("an unreadable file was replaced")
        }
        XCTAssertTrue(why.contains("can't read it"), why)
        chmod(file, 0o644)
        XCTAssertEqual(FileManager.default.contents(atPath: file), Data("someone else's".utf8))
    }

    func testARunWithItsOwnHomeWritesOnlyWhereItIsTold() throws {
        let test = try CaretHome.resolve(override: "/tmp/caret-x", userHome: "/Users/robin")
        let all: (BridgeBrowser) -> Bool = { _ in true }
        guard case .refused = ChromeBridgeInstaller.destination(home: test, override: nil, userHome: "/Users/robin", installed: all) else { return XCTFail() }
        XCTAssertEqual(ChromeBridgeInstaller.destination(home: test, override: "/tmp/nmh", userHome: "/Users/robin", installed: all),
                       .targets([.init(browser: nil, directory: "/tmp/nmh")]))
        guard case .refused = ChromeBridgeInstaller.destination(home: test, override: "", userHome: "/Users/robin", installed: all) else { return XCTFail() }
        let user = try CaretHome.resolve(override: nil, userHome: "/Users/robin")
        XCTAssertEqual(ChromeBridgeInstaller.destination(home: user, override: nil, userHome: "/Users/robin", installed: { $0 == .chrome }),
                       .targets([.init(browser: .chrome, directory: "/Users/robin/Library/Application Support/Google/Chrome/NativeMessagingHosts")]))
    }
}
