import CaretHostCore
import XCTest
@testable import CaretHost

/// PR #16 review: turning Caret off in an app stops a write already accepted there, and leaves the rewrite chord
/// to the app.
final class AppOffWriteTests: XCTestCase {
    let mark = HostStatus.InputMark(keys: 3, clicks: 0)

    func testAWriteRefusesOnceTheAppIsOff() {
        XCTAssertEqual(InsertionExecutor.refusal(live: true, mark: mark, now: mark, appOff: true), "appOff")
        XCTAssertEqual(InsertionExecutor.refusal(live: false, mark: mark, now: mark, appOff: true), "revoked", "a revoked claim says so first")
        XCTAssertEqual(InsertionExecutor.refusal(live: true, mark: mark, now: HostStatus.InputMark(keys: 4, clicks: 0)), "inputMoved")
        XCTAssertEqual(InsertionExecutor.refusal(live: true, mark: mark, now: mark), "targetNotAllowed")
    }

    func testTheRewriteKeyIsCaretsOnlyWhereWritingHelpIsOn() {
        let saved = AppSwitch.shared
        defer { saved.update(CaretSettings()) }
        var settings = CaretSettings()
        settings.setApp("com.tinyspeck.slackmacgap", off: true)
        AppSwitch.shared.update(settings)
        XCTAssertFalse(AppSwitch.shared.takesRewriteKey(bundleID: "com.tinyspeck.slackmacgap"), "off in that app")
        XCTAssertEqual(AppSwitch.shared.takesRewriteKey(bundleID: "com.apple.TextEdit"), HostGate.allowsGhostText(settings))
        settings.paused = true
        AppSwitch.shared.update(settings)
        XCTAssertFalse(AppSwitch.shared.takesRewriteKey(bundleID: "com.apple.TextEdit"), "paused")
    }

    /// PR #16 review: a refusal before any write (the field changed under it) is not Caret's misplaced edit.
    func testOnlyAWriteThatSettledWrongIsLookedAtForAMisplacedEdit() {
        XCTAssertTrue(InsertionExecutor.mayHaveMisplaced("writeMismatch"))
        for refusal in ["fieldChanged", "selectionMoved", "inputMoved", "targetNotAllowed", "writeIgnored", "appOff", nil] {
            XCTAssertFalse(InsertionExecutor.mayHaveMisplaced(refusal), refusal ?? "nil")
        }
    }
}
