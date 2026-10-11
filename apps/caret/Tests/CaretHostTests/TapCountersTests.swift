import CaretHostCore
import XCTest
@testable import CaretHost

/// Bug 18 (A18): the debug counters count real accepts, from the tap and the socket's key hook
/// alike, and a Tab Caret did not take is counted as passed.
final class TapCountersTests: XCTestCase {
    let pid: Int32 = 4242

    func ghost(_ text: String) -> Offer {
        let value = "I will send the"
        let target = TargetIdentity(pid: pid, bundleID: "com.example.Editor", windowID: "w1", elementID: "e1", elementRevision: UTF16Text.digest(value))
        return Offer(text: text, target: target, fieldValue: value, caretUTF16: UTF16Text.length(value))
    }

    func testATakenTabCountsAsConsumedAndClaimed() {
        let arbiter = OfferArbiter()
        let tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(claimed: { _ in }, offerChanged: { _, _ in }, undo: { _ in }, keyDown: { _ in }))
        arbiter.publish(ghost(" notes to the team"))
        XCTAssertTrue(tap.route(.tab(to: pid), fromHook: true))
        XCTAssertFalse(tap.route(.tab(to: pid), fromHook: true), "no offer: the app's Tab")
        let state = tap.debugState()
        XCTAssertEqual(state.consumed, 1)
        XCTAssertEqual(state.keyDowns, 2)
        XCTAssertEqual(state.tabs, 2)
        XCTAssertEqual(state.tabsPassed, 1)
        XCTAssertEqual(state.hookKeys, 2)
        XCTAssertEqual(arbiter.snapshot().claimCount, 1)
    }

    func testAWordTakenWithOptionRightCountsToo() {
        let arbiter = OfferArbiter()
        let tap = TapThread(arbiter: arbiter, callbacks: TapThread.Callbacks(claimed: { _ in }, offerChanged: { _, _ in }, undo: { _ in }, keyDown: { _ in }))
        arbiter.publish(ghost(" notes to the team"))
        XCTAssertTrue(tap.route(KeyStroke(keyCode: KeyStroke.rightKeyCode, option: true, targetPID: pid)))
        XCTAssertEqual(tap.debugState().consumed, 1)
        XCTAssertEqual(tap.debugState().tabs, 0)
        XCTAssertEqual(arbiter.snapshot().lastClaim?.wordOnly, true)
    }

    func testCotypistIsNamedAsAnotherTabOwner() {
        XCTAssertEqual(OtherTabOwners.running(in: ["com.apple.TextEdit", "app.cotypist.Cotypist"]), ["Cotypist"])
        XCTAssertEqual(OtherTabOwners.running(in: ["com.apple.TextEdit"]), [])
    }
}
