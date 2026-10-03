import ApplicationServices
import CaretHostCore
import XCTest
@testable import CaretHost

final class PidInsertionTests: XCTestCase {
    /// An element of a pid that cannot exist, so nothing in this test can reach a real app.
    private let nowhere = AXUIElementCreateApplication(Int32.max)

    func testNothingIsPostedOnceTheTargetIsNoLongerAllowed() {
        let synthesizer = PidKeystrokeSynthesizer(pid: Int32.max, element: nowhere, stillTarget: { false })
        synthesizer.paste()
        synthesizer.pasteAndMatchStyle()
        synthesizer.type("x")
        synthesizer.deleteBackward()
        synthesizer.tab()
        XCTAssertEqual(synthesizer.refusedPosts, 5, "every send rechecks the target and refuses")
    }

    func testAnAppLearnsTheAXRouteOnceAndKeepsIt() {
        let table = WriteMethodTable()
        XCTAssertEqual(table.method(for: "exe:caret-fixture"), .pastePid, "pid paste is the default")
        table.record(.axSelectedText, for: "exe:caret-fixture")
        XCTAssertEqual(table.method(for: "exe:caret-fixture"), .axSelectedText)
        XCTAssertEqual(table.method(for: "com.apple.TextEdit"), .pastePid, "learned per app")
        XCTAssertEqual(table.snapshot(), ["exe:caret-fixture": "axSelectedText"])
    }

    func testThePolicyNamesExactlyTheAllowedPIDs() {
        let policy = TargetPolicy(allowedBundleIDs: nil, allowedPIDs: [41, 42])
        XCTAssertTrue(policy.allows(pid: 41, bundleID: nil))
        XCTAssertFalse(policy.allows(pid: 43, bundleID: "com.apple.TextEdit"))
        XCTAssertFalse(policy.allowsLive(pid: Int32.max), "a pid that is not running is never allowed")
        XCTAssertNil(TargetPolicy.pids(from: ""))
        XCTAssertEqual(TargetPolicy.pids(from: "41, 42"), [41, 42])
    }

    func testTheDebugHookKeysCarryTheirTarget() {
        XCTAssertEqual(TestKeys.key("tab", pid: 7), .tab(to: 7))
        XCTAssertEqual(TestKeys.key("cmd-z", pid: 7)?.isUndo, true)
        XCTAssertEqual(TestKeys.key("cmd-1", pid: 7)?.commandDigit, 1)
        XCTAssertEqual(TestKeys.key("char:a", pid: 7)?.text, "a")
        XCTAssertNil(TestKeys.key("char:ab", pid: 7))
        XCTAssertNil(TestKeys.key("enter", pid: 7))
    }

    func testTheDebugHookRoutesThroughTheTapsOwnDecision() {
        let arbiter = OfferArbiter()
        let claims = Counter()
        let tap = TapThread(arbiter: arbiter, callbacks: .init(
            claimed: { _ in claims.add() }, offerChanged: { _, _ in }, undo: { _ in }, keyDown: { _ in }
        ))
        let target = TargetIdentity(pid: 7, bundleID: "pid:7", windowID: "w", elementID: "e", elementRevision: UTF16Text.digest(""))
        let origin = FillOrigin(proposalID: "p", windowID: "7-1", fieldKey: "k", sourceAppName: "A", sourceWindowTitle: "R",
                                sourceBundleID: "", sourcePID: 7, proposedAtMs: 0)
        arbiter.publish(Offer(text: "v", kind: .fill(origin), target: target, fieldValue: "", caretUTF16: 0))
        XCTAssertFalse(tap.route(.tab(to: 8)), "Tab headed elsewhere passes through")
        XCTAssertFalse(tap.route(KeyStroke(keyCode: 18, command: true, targetPID: 7)), "⌘1 passes through")
        XCTAssertEqual(claims.value, 0)
        arbiter.publish(Offer(text: "v", kind: .fill(origin), target: target, fieldValue: "", caretUTF16: 0))
        XCTAssertTrue(tap.route(.tab(to: 7)))
        XCTAssertEqual(claims.value, 1)
    }

    func testErrorCaptionsSayWhatAndWhatNext() {
        XCTAssertEqual(FillMachine.errorCaption("source.valueGone"), "The source changed, so nothing was filled.")
        XCTAssertEqual(FillMachine.errorCaption("targetMoved"), "The field changed, so nothing was filled.")
        XCTAssertEqual(FillMachine.errorCaption("writeIgnored"), "The field didn't take the value. Type it in to fill it.")
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func add() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
