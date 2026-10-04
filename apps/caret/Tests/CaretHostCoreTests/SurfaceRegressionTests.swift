import CaretScreenCore
import XCTest
@testable import CaretHostCore

private let actionLine = "Sheet Fixture Finish the rest: 2 more values"

private let toastUp: [Step] = [
    .screen { $0.front() },
    .offer(Fx.fillPopup()),
    .press(Fx.tab()),
    .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done),
    .expect(.undoOwned(true)),
]

/// The races fixed in review of the offer surfaces (fa56fec), each as the steps that showed it.
final class SurfaceRegressionTests: XCTestCase {
    /// R1. A Tab the tap took on an offer that a newer helper offer replaced before main ran is
    /// honored, and the newer one gives way, instead of the key vanishing with no offerAccept.
    func testR1LateTabOnAReplacedOfferIsHonored() {
        play(Transition("R1", [
            .screen { $0.front() }, .offer(Fx.fillPopup()),
            .pressLate(Fx.tab()),
            .offer(Fx.action()),
            .deliver,
            .sent(["accept fill-2 fillAll"]),
            .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.workingOn("fill-2")),
        ]))
    }

    /// R2. A late Tab on a replaced offer that the helper has since withdrawn is not honored.
    func testR2LateTabOnAWithdrawnReplacedOfferIsNotHonored() {
        play(Transition("R2", [
            .screen { $0.front() }, .offer(Fx.fillPopup()),
            .pressLate(Fx.tab()),
            .offer(Fx.action()),
            .withdraw("fill-2", .stale),
            .deliver,
            .sent([]), .expect(.shown("offer-5")), .expect(.tabTakes(true)), .expect(.workingOn(nil)),
        ]))
    }

    /// R3. A working or result line hidden because its app went behind gives up Esc and ⌘Z.
    func testR3AHiddenLineGivesUpEscAndUndo() {
        play([
            Transition("R3 working", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()),
                .wait(3),
                .screen { $0.behind() }, .wait(0.5),
                .expect(.escOwned(false)),
                .screen { $0.front() },
                .press(Fx.esc()),
                .sent(["accept fill-2 fillAll"]),
            ]),
            Transition("R3 result line", [
                .screen { $0.front() }, .offer(Fx.action()), .press(Fx.tab()),
                .progress("offer-5", .done), .expect(.escOwned(true)),
                .screen { $0.behind() }, .activated,
                .expect(.escOwned(false)), .expect(.line("Added to Sheet Fixture")), .expect(.panelUp(false)),
            ]),
            Transition("R3 Esc taken just before the line went down", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()),
                .wait(3),
                .pressLate(Fx.esc()),
                .screen { $0.behind() }, .activated,
                .deliver,
                .sent(["accept fill-2 fillAll", "stop fill-2"]),
                .expect(.escOwned(false)), .expect(.line(nil)), .expect(.workingOn(nil)),
            ]),
            Transition("R3 toast", toastUp + [
                .screen { $0.windows.insert(Fx.cover, at: 0) }, .wait(0.5),
                .expect(.undoOwned(false)), .expect(.counted("surface.lineHidden.covered")),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
            ]),
        ])
    }

    /// R4. A fill run that ends while its line is hidden grants no undo.
    func testR4AFillEndingWhileHiddenGrantsNoUndo() {
        play(Transition("R4", [
            .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()),
            .screen { $0.behind() }, .activated,
            .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done),
            .expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.line(nil)), .expect(.workingOn(nil)),
            .screen { $0.front() },
            .press(Fx.cmdZ()),
            .sent(["accept fill-2 fillAll"]),
        ]))
    }

    /// R5. The fill line's toast and the fill pop-up's share the arbiter's one toast slot, and
    /// each one taking it takes the other down.
    func testR5TheTwoToastsShareOneSlot() {
        play([
            Transition("R5 the pop-up's toast takes the slot from the fill line's", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()),
                .fillLineToast,
                .expect(.custom("the fill line's toast is up") { $0.fillToastID != nil }),
                .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done),
                .expect(.custom("the fill line's toast went") { $0.fillToastID == nil }),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll", "undo fill-2"]),
            ]),
            Transition("R5 the fill line's toast takes the slot from the pop-up's", toastUp + [
                .fillLineToast,
                .expect(.toast(nil)), .expect(.line(nil)), .expect(.panelUp(false)),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
                .expect(.custom("⌘Z took the fill line's grant") { $0.arbiter.snapshot().toast == nil }),
            ]),
        ])
    }

    /// R6. ⌘Z is tracked before `taskControl undo` is sent, and an unsent undo says so.
    func testR6UndoIsTrackedBeforeItIsSentAndAnUnsentOneSaysSo() {
        let rig = SurfaceRig()
        var trackedWhenSent: String?
        rig.onSend = { [unowned rig] message in
            if case .control = message { trackedWhenSent = rig.machine.undoing }
        }
        rig.screen.front()
        rig.machine.receive(Fx.fillPopup())
        rig.press(Fx.tab())
        for phase: TaskProgress.Phase in [.verified, .verified, .done] { rig.machine.taskProgress(Fx.progress("fill-2", phase)) }
        rig.helperConnected = false
        rig.press(Fx.cmdZ())
        XCTAssertEqual(trackedWhenSent, "fill-2", "the undo is tracked before the request goes")
        XCTAssertEqual(rig.sent, ["accept fill-2 fillAll", "undo fill-2"])
        XCTAssertEqual(rig.machine.toastInfo?.kind, "error")
        XCTAssertEqual(rig.machine.lineText, "Caret's helper isn't running, so nothing was undone.")
        XCTAssertNil(rig.machine.undoing)
        XCTAssertTrue(rig.counts.contains("surface.undo.unsent"))
    }

    /// R7. "Undoing" and the undo's result are not drawn over a newer offer or run.
    func testR7UndoReportsNowhereOnceANewerOfferHoldsThePanel() {
        play(Transition("R7", toastUp + [
            .pressLate(Fx.cmdZ()),
            .offer(Fx.action()),
            .deliver,
            .sent(["accept fill-2 fillAll", "undo fill-2"]),
            .expect(.toast(nil)), .expect(.line(actionLine)),
            .progress("fill-2", .undone, detail: "restored 2; not restored 0; presses not undoable 0", restored: 2, notRestored: 0),
            .expect(.toast(nil)), .expect(.line(actionLine)), .expect(.shown("offer-5")),
        ]))
    }

    /// R7, with a newer run rather than a newer offer holding the panel.
    func testR7UndoReportsNowhereOnceANewerRunHoldsThePanel() {
        play(Transition("R7 run", toastUp + [
            .pressLate(Fx.cmdZ()),
            .offer(Fx.action()), .press(Fx.tab()),
            .deliver,
            .sent(["accept fill-2 fillAll", "accept offer-5 finish", "undo fill-2"]),
            .expect(.toast(nil)), .expect(.line("Adding to Sheet Fixture")),
            .progress("fill-2", .undone, detail: "restored 2; not restored 0; presses not undoable 0", restored: 2, notRestored: 0),
            .expect(.toast(nil)), .expect(.line("Adding to Sheet Fixture")), .expect(.workingOn("offer-5")),
        ]))
    }

    /// R8. A hold that will not be retried also drops an older held offer.
    func testR8AHoldWithoutRetryDropsTheOlderHeldOffer() {
        play(Transition("R8", [
            .screen { $0.behind() },
            .offer(Fx.fillPopup()),
            .expect(.held(.appNotFront)),
            .screen { $0.front() },
            .offer(Fx.alternatives(key: "offer-7", candidates: [String(repeating: "w", count: 40)])),
            .expect(.held(nil)),
            .wait(2),
            .expect(.shown(nil)), .did([]),
        ]))
    }
}
