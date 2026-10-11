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
        XCTAssertFalse(synthesizer.selectTextRange(location: 0, length: 0), "a selection change is a write too")
        XCTAssertEqual(synthesizer.refusedPosts, 6, "every send rechecks the target and refuses")
    }

    /// S1 audit #13: focus moves to another field between the check that passed and the next post.
    /// The synthesizer asks again before every event, so nothing more is sent once it has moved.
    /// No event is posted here: the check refuses before any reaches the system.
    func testFocusMovingAfterACheckStopsTheNextPost() {
        var checks = 0
        let synthesizer = PidKeystrokeSynthesizer(pid: Int32.max, element: nowhere, stillTarget: {
            checks += 1
            return false
        })
        synthesizer.paste()
        synthesizer.paste()
        XCTAssertEqual(checks, 2, "asked before each post, not once")
        XCTAssertEqual(synthesizer.refusedPosts, 2)
        XCTAssertEqual(synthesizer.pastesPosted, 0, "a refused paste is never counted as sent, so no stray is looked for")
    }

    /// A17: the AX write comes first; an app that refuses or ignores it is remembered for paste.
    func testAnAppLearnsThePasteRouteOnceAndKeepsIt() {
        let table = WriteMethodTable()
        XCTAssertEqual(table.method(for: "com.google.Chrome"), .axSelectedText, "AX selected text is the default")
        table.record(.pastePid, for: "com.google.Chrome")
        XCTAssertEqual(table.method(for: "com.google.Chrome"), .pastePid)
        XCTAssertEqual(table.method(for: "com.apple.TextEdit"), .axSelectedText, "learned per app")
        XCTAssertEqual(table.snapshot(), ["com.google.Chrome": "pastePid"])
    }

    func testThePolicyNamesExactlyTheAllowedPIDs() {
        let policy = TargetPolicy(allowedBundleIDs: nil, allowedPIDs: [41, 42])
        XCTAssertTrue(policy.allows(pid: 41, bundleID: nil))
        XCTAssertFalse(policy.allows(pid: 43, bundleID: "com.apple.TextEdit"))
        XCTAssertFalse(policy.allowsLive(pid: Int32.max), "a pid that is not running is never allowed")
        XCTAssertNil(TargetPolicy.pids(from: ""))
        XCTAssertEqual(TargetPolicy.pids(from: "41, 42"), [41, 42])
    }

    /// What `--allow-pids` and `CARET_ALLOW_PIDS` accept: a missing or mistyped list is refused, never read as "any".
    func testTheAllowedPidListIsReadStrictly() {
        XCTAssertEqual(TargetPolicy.strictPids("41, 42"), .success([41, 42]))
        XCTAssertEqual(TargetPolicy.strictPids("7"), .success([7]))
        XCTAssertEqual(TargetPolicy.strictPids(nil), .failure(.empty))
        XCTAssertEqual(TargetPolicy.strictPids(""), .failure(.empty))
        XCTAssertEqual(TargetPolicy.strictPids("  "), .failure(.empty))
        XCTAssertEqual(TargetPolicy.strictPids("41,abc"), .failure(.notAPid("abc")))
        XCTAssertEqual(TargetPolicy.strictPids("41,,42"), .failure(.notAPid("")))
        XCTAssertEqual(TargetPolicy.strictPids("0"), .failure(.notAPid("0")))
        XCTAssertEqual(TargetPolicy.strictPids("-5"), .failure(.notAPid("-5")))
        XCTAssertEqual(TargetPolicy.strictPids("--surfaces"), .failure(.notAPid("--surfaces")))
        XCTAssertThrowsError(try HostRuntime.allowedPIDs(nil)) { XCTAssertEqual("\($0)", "needs a comma-separated list of pids") }
    }

    /// The debug socket's acting commands need --test-hooks; reads do not (CodeRabbit on PR #9).
    func testActingDebugCommandsNeedTestHooks() {
        for words in [["key", "tab", "41"], ["control", "task-1", "undo"], ["click", "41"], ["settings", "set", "paused", "true"]] {
            let refusal = HostRuntime.testHookRefusal(words, testHooks: false)
            XCTAssertNotNil(refusal, "\(words) went through without test hooks")
            XCTAssertTrue(refusal?.contains("is a test hook") == true)
            XCTAssertNil(HostRuntime.testHookRefusal(words, testHooks: true), "\(words) refused with test hooks")
        }
        XCTAssertEqual(HostRuntime.testHookRefusal(["settings", "set", "x", "y"], testHooks: false),
                       #"{"error":"settings set is a test hook: start the host with --test-hooks"}"#)
        for words in [["state"], ["ping"], ["perch"], ["settings"], ["services"], ["activity", "open"], [String]()] {
            XCTAssertNil(HostRuntime.testHookRefusal(words, testHooks: false), "\(words) is a read and stays open")
        }
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
