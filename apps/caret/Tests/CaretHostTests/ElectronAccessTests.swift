import ApplicationServices
import CaretScreenCore
import XCTest
@testable import CaretHost

/// Brief item 2: the host asks an Electron app for its accessibility tree itself, once per process,
/// by the reader's rule (`AppFamily.setsManualAccessibility`), so ghost text in Slack or Notion does not
/// depend on the reader having run first.
@MainActor
final class ElectronAccessTests: XCTestCase {
    func access(_ family: AppFamily, calls: @escaping (pid_t) -> Void) -> ElectronAccess {
        ElectronAccess(family: { _ in family }, set: { pid in calls(pid); return .success })
    }

    func testAnElectronAppIsAskedOncePerProcess() {
        var asked: [pid_t] = []
        let a = access(.electron) { asked.append($0) }
        let url = URL(fileURLWithPath: "/Applications/Slack.app")
        XCTAssertTrue(a.ask(pid: 41, bundleURL: url))
        XCTAssertFalse(a.ask(pid: 41, bundleURL: url), "the same process is not asked twice")
        XCTAssertTrue(a.ask(pid: 42, bundleURL: url), "a relaunched app is a new process")
        XCTAssertEqual(asked, [41, 42])
    }

    func testChromiumBrowsersAndOtherAppsAreNeverAsked() {
        for family in [AppFamily.chromiumBrowser, .other] {
            var asked: [pid_t] = []
            let a = access(family) { asked.append($0) }
            XCTAssertFalse(a.ask(pid: 7, bundleURL: URL(fileURLWithPath: "/Applications/X.app")))
            XCTAssertEqual(asked, [], "\(family)")
        }
    }

    func testAnAppWithoutABundleIsNotAsked() {
        var asked: [pid_t] = []
        XCTAssertFalse(access(.electron) { asked.append($0) }.ask(pid: 9, bundleURL: nil))
        XCTAssertEqual(asked, [])
    }

    func testAFailedAskIsNotRetriedForThatProcess() {
        var calls = 0
        let a = ElectronAccess(family: { _ in .electron }, set: { _ in calls += 1; return .attributeUnsupported })
        XCTAssertFalse(a.ask(pid: 5, bundleURL: URL(fileURLWithPath: "/Applications/Y.app")), "no tree is coming, so no settle reads")
        XCTAssertFalse(a.ask(pid: 5, bundleURL: URL(fileURLWithPath: "/Applications/Y.app")))
        XCTAssertEqual(calls, 1)
    }
}
