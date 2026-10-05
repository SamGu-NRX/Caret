import CaretHostCore
import XCTest

/// The rules Caret.app's launcher and bridge install follow (H4), each with one correct answer.
final class RestartBudgetTests: XCTestCase {
    func testFiveRestartsInAMinuteThenTheSixthExitStops() {
        var b = RestartBudget()
        for i in 0..<5 { XCTAssertEqual(b.exited(at: 100 + Double(i)), .restart(after: 1), "exit \(i + 1)") }
        XCTAssertEqual(b.exited(at: 105), .stop(exits: 6))
    }

    func testRestartsOlderThanTheWindowNoLongerCount() {
        var b = RestartBudget()
        for i in 0..<5 { _ = b.exited(at: Double(i)) }
        // 61 s after the first: that one has left the window, so there is room for one more.
        XCTAssertEqual(b.exited(at: 61), .restart(after: 1))
        XCTAssertEqual(b.restarts, [1, 2, 3, 4, 61])
        // Still 61 s: the restarts at 1 to 4 s and this one's predecessor fill the window.
        XCTAssertEqual(b.exited(at: 61), .stop(exits: 6))
    }

    func testAnExitExactlyOneWindowLaterStillCounts() {
        // launch.ts drops a restart only when now - t > window; at exactly 60 s it still counts.
        var b = RestartBudget()
        for _ in 0..<5 { _ = b.exited(at: 0) }
        XCTAssertEqual(b.exited(at: 60), .stop(exits: 6))
    }

    func testResetStartsTheCountAgain() {
        var b = RestartBudget()
        for i in 0..<5 { _ = b.exited(at: Double(i)) }
        b.reset()
        XCTAssertEqual(b.restarts, [])
        XCTAssertEqual(b.exited(at: 6), .restart(after: 1))
    }

    func testTheDefaultsAreLaunchTsRule() {
        XCTAssertEqual(RestartBudget.defaultLimit, 5)
        XCTAssertEqual(RestartBudget.defaultWindow, 60)
        XCTAssertEqual(RestartBudget.restartDelay, 1)
    }
}

final class CaretHomeTests: XCTestCase {
    func testTheDefaultHomeIsTheHelpersOwnDataDirectory() throws {
        let h = try CaretHome.resolve(override: nil, userHome: "/Users/robin")
        XCTAssertFalse(h.isOverride)
        XCTAssertEqual(h.root, "/Users/robin/Library/Application Support/CaretV2")
        XCTAssertEqual(h.dataDirectory, h.root)
        XCTAssertEqual(h.screenSocket, "/Users/robin/Library/Application Support/CaretV2/sockets/screen.sock")
        XCTAssertEqual(h.pageSocket, "/Users/robin/Library/Application Support/CaretV2/sockets/page.sock")
        XCTAssertEqual(h.denyList, "/Users/robin/Library/Application Support/CaretV2/deny-apps.txt")
    }

    func testAnEmptyOverrideIsRefusedNotReadAsTheUsersHome() {
        XCTAssertThrowsError(try CaretHome.resolve(override: "", userHome: "/Users/robin")) { e in
            XCTAssertEqual(e as? CaretHome.Problem, .notAbsolute(""))
        }
    }

    func testAnOverrideHoldsEverythingIncludingTheHostsSocketAndSettings() throws {
        let h = try CaretHome.resolve(override: "/tmp/caret-run-1/", userHome: "/Users/robin")
        XCTAssertTrue(h.isOverride)
        XCTAssertEqual(h.root, "/tmp/caret-run-1")
        XCTAssertEqual(h.socketsDirectory, "/tmp/caret-run-1/sockets")
        XCTAssertEqual(h.hostSocket, "/tmp/caret-run-1/sockets/host.sock")
        XCTAssertEqual(h.settingsFile, "/tmp/caret-run-1/host-settings.json")
    }

    func testARelativeHomeIsRefused() {
        XCTAssertThrowsError(try CaretHome.resolve(override: "caret-run", userHome: "/Users/robin")) { e in
            XCTAssertEqual(e as? CaretHome.Problem, .notAbsolute("caret-run"))
        }
    }

    func testAHomeWhoseSocketPathWouldNotFitIsRefusedByName() {
        let root = "/tmp/" + String(repeating: "x", count: 80)
        XCTAssertThrowsError(try CaretHome.resolve(override: root, userHome: "/Users/robin")) { e in
            guard case .socketPathTooLong(let path, let bytes) = e as? CaretHome.Problem else { return XCTFail("\(e)") }
            XCTAssertEqual(path, root + "/sockets/screen.sock")
            XCTAssertEqual(bytes, 105)
        }
        // 103 bytes is the longest that fits.
        let fits = "/tmp/" + String(repeating: "x", count: 78)
        XCTAssertEqual((fits + "/sockets/screen.sock").utf8.count, 103)
        XCTAssertNoThrow(try CaretHome.resolve(override: fits, userHome: "/Users/robin"))
    }
}

final class LaunchRoleTests: XCTestCase {
    private func facts(marker: Bool = false, launchd: Bool = true, ls: Bool = true, signed: Bool = true, home: Bool = false) -> LaunchRole.Facts {
        .init(agentMarker: marker, parentIsLaunchd: launchd, openedByLaunchServices: ls, teamSigned: signed, homeOverridden: home)
    }

    func testOnlyTheMarkedLaunchdJobIsTheAgent() {
        XCTAssertEqual(LaunchRole.decide(facts(marker: true)), .agent)
        // An ad hoc build under launchd is still the agent; PageBridgeVendor then refuses to vend for the signature.
        XCTAssertEqual(LaunchRole.decide(facts(marker: true, signed: false)), .agent)
        XCTAssertEqual(LaunchRole.decide(facts(marker: true, home: true)), .agent)
    }

    func testTheMarkerFromAShellIsNotTheAgent() {
        guard case .inProcess = LaunchRole.decide(facts(marker: true, launchd: false)) else { return XCTFail() }
    }

    func testOnlyAnOpenedTeamSignedCopyWithItsDefaultHomeHandsOff() {
        XCTAssertEqual(LaunchRole.decide(facts()), .handOffToAgent)
    }

    func testNothingElseEverRegistersTheAgent() {
        // Every combination but the one above runs in-process: a direct exec (even one reparented to launchd), a copy
        // LaunchServices did not open, a debug build, a run with --home.
        for launchd in [false, true] {
            for ls in [false, true] {
                for signed in [false, true] {
                    for home in [false, true] where !(launchd && ls && signed && !home) {
                        guard case .inProcess = LaunchRole.decide(facts(launchd: launchd, ls: ls, signed: signed, home: home)) else {
                            return XCTFail("launchd \(launchd) ls \(ls) signed \(signed) home \(home) would register the agent")
                        }
                    }
                }
            }
        }
    }

    func testADirectExecReparentedToLaunchdDoesNotHandOff() {
        XCTAssertEqual(LaunchRole.decide(facts(launchd: true, ls: false)), .inProcess(reason: "started directly, not opened by LaunchServices"))
    }

    func testTheReasonSaysWhichRuleHeldItBack() {
        XCTAssertEqual(LaunchRole.decide(facts(launchd: false)), .inProcess(reason: "started directly, not opened by LaunchServices"))
        XCTAssertEqual(LaunchRole.decide(facts(signed: false)), .inProcess(reason: "this build is not team-signed"))
        XCTAssertEqual(LaunchRole.decide(facts(home: true)), .inProcess(reason: "this run has its own Caret home"))
    }
}

final class NativeMessagingManifestTests: XCTestCase {
    private let bridge = "/Applications/Caret.app/Contents/Helpers/caret-bridge"

    func testTheManifestIsTheSpecsByteForByte() throws {
        let m = NativeMessagingManifest(bridgePath: bridge)
        XCTAssertEqual(m.fileName, "ai.caret.bridge.json")
        let text = String(decoding: m.encoded(), as: UTF8.self)
        XCTAssertEqual(text, """
        {
          "allowed_origins" : [
            "chrome-extension://idbkbnaepbamcdecogahbinlcodkbmmj/"
          ],
          "description" : "Caret page bridge",
          "name" : "ai.caret.bridge",
          "path" : "/Applications/Caret.app/Contents/Helpers/caret-bridge",
          "type" : "stdio"
        }
        """)
    }

    func testTheExtensionIdIsTheOneTheExtensionsKeyGives() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../extension/EXTENSION_ID").standardized
        let id = try String(contentsOf: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertEqual(NativeMessagingManifest.extensionId, id)
    }

    func testPlans() {
        let m = NativeMessagingManifest(bridgePath: bridge)
        XCTAssertEqual(m.plan(existing: nil), .write)
        XCTAssertEqual(m.plan(existing: m.encoded()), .unchanged)
        let moved = NativeMessagingManifest(bridgePath: "/Users/robin/Downloads/Caret.app/Contents/Helpers/caret-bridge")
        XCTAssertEqual(m.plan(existing: moved.encoded()), .replace(previousPath: moved.path))
        // The same manifest written by hand with other spacing is ours: rewrite it.
        let compact = try! JSONEncoder().encode(m)
        XCTAssertEqual(m.plan(existing: compact), .write)
    }

    func testAFileThatIsNotOursIsLeftAlone() {
        let m = NativeMessagingManifest(bridgePath: bridge)
        guard case .refuse(let why) = m.plan(existing: Data("not json".utf8)) else { return XCTFail() }
        XCTAssertTrue(why.contains("not a Native Messaging manifest"), why)
        let other = #"{"name":"ai.caret.bridge","description":"x","path":"/usr/local/bin/something-else","type":"stdio","allowed_origins":[]}"#
        guard case .refuse(let why2) = m.plan(existing: Data(other.utf8)) else { return XCTFail() }
        XCTAssertTrue(why2.contains("/usr/local/bin/something-else"), why2)
    }

    func testChromesDirectory() {
        XCTAssertEqual(BridgeBrowser.chrome.nativeMessagingDirectory(userHome: "/Users/robin"),
                       "/Users/robin/Library/Application Support/Google/Chrome/NativeMessagingHosts")
    }
}
