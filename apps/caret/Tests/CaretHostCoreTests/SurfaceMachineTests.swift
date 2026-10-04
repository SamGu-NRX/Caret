import CaretScreenCore
import CoreGraphics
import XCTest
@testable import CaretHostCore

private let popupTitle = "Fill 2 fields"
private let filling = "Filling 2 fields"
private let toast = "Filled 2 fields from Mail Fixture"
private let actionLine = "Sheet Fixture Finish the rest: 2 more values"
private let restored = "restored 2; not restored 0; presses not undoable 0"

/// The fill pop-up shown, Tab taken, both fields verified and the run done: the toast is up.
private let toastUp: [Step] = [
    .screen { $0.front() },
    .offer(Fx.fillPopup()),
    .press(Fx.tab()),
    .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done),
    .expect(.toast(toast)), .expect(.undoOwned(true)),
    .did(["panel enter \(popupTitle)", "clear caret", "line \(filling)", "working on", "working off", "toast slot", "line \(toast)"]),
]

/// The fill pop-up taken, its working line up.
private let working: [Step] = [
    .screen { $0.front() },
    .offer(Fx.fillPopup()),
    .press(Fx.tab()),
    .expect(.workingOn("fill-2")),
    .did(["panel enter \(popupTitle)", "clear caret", "line \(filling)", "working on"]),
]

/// The action line taken, its working line up.
private let actionWorking: [Step] = [
    .screen { $0.front() },
    .offer(Fx.action()),
    .press(Fx.tab()),
    .sent(["accept offer-5 finish"]),
    .did(["panel enter \(actionLine)", "clear caret", "line Adding to Sheet Fixture", "working on"]),
]

/// Each transition of `SurfaceMachine`, as steps against a fake screen and clock (brief A6).
final class SurfaceMachineTests: XCTestCase {
    func testAnOfferWaitsWhileTheGateIsClosedAndShowsWhenItOpens() {
        play([
            Transition("app behind, then in front", [
                .screen { $0.behind(); $0.focused[Fx.app] = Fx.field(.email) },
                .offer(Fx.fillPopup()),
                .expect(.held(.appNotFront)), .expect(.shown(nil)), .did([]),
                // The gate is checked before any Accessibility read of a background app.
                .expect(.fieldReads([])),
                .wait(0.5), .expect(.held(.appNotFront)), .did([]),
                .screen { $0.front() },
                .wait(0.5),
                .expect(.shown("fill-2")), .expect(.held(nil)), .expect(.tabTakes(true)),
                .did(["panel enter \(popupTitle)"]),
            ]),
            Transition("another window covers the caret, then moves", [
                .screen { $0.front(); $0.windows.insert(Fx.cover, at: 0) },
                .offer(Fx.fillPopup()),
                .expect(.held(.covered)), .did([]),
                .screen { $0.windows.removeFirst() },
                .wait(0.5),
                .expect(.shown("fill-2")), .did(["panel enter \(popupTitle)"]),
            ]),
            Transition("the app has no window under the caret", [
                .screen { $0.front(); $0.windows = [] },
                .offer(Fx.fillPopup()),
                .expect(.held(.notOnScreen)),
            ]),
            Transition("still closed after 30 s: dropped, and never drawn", [
                .screen { $0.behind() },
                .offer(Fx.fillPopup()),
                .wait(30), .expect(.held(.appNotFront)),
                .wait(0.5), .expect(.held(nil)),
                .screen { $0.front() },
                .wait(2), .expect(.shown(nil)), .did([]),
            ]),
            Transition("a pid outside the allow list is refused, not held", [
                .screen { $0.front(); $0.allowed = [Fx.other] },
                .offer(Fx.fillPopup()),
                .expect(.held(nil)), .expect(.counted("surface.refused.pidNotAllowed")), .expect(.fieldReads([])),
            ]),
            Transition("no snapshot of the field: nothing drawn and nothing held", [
                .screen { $0.front(); $0.caretOverride[Fx.app] = .noSnapshot },
                .offer(Fx.fillPopup()),
                .expect(.shown(nil)), .expect(.held(nil)), .did([]),
            ]),
        ])
    }

    func testAShownOfferGoesWhenItsGateCloses() {
        play([
            Transition("the app goes behind: withdrawn at the next half-second check", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .did(["panel enter \(popupTitle)"]),
                .screen { $0.behind() },
                .wait(0.4), .expect(.shown("fill-2")),
                .wait(0.1), .expect(.shown(nil)), .expect(.tabTakes(false)),
                .expect(.counted("surface.withdrawn.appNotFront")),
                .did(["clear caret", "hide 0.0"]),
            ]),
            Transition("another app activates: withdrawn at once", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .screen { $0.behind() }, .activated,
                .expect(.shown(nil)), .did(["panel enter \(popupTitle)", "clear caret", "hide 0.0"]),
            ]),
            Transition("a window comes over the caret", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .screen { $0.windows.insert(Fx.cover, at: 0) }, .wait(0.5),
                .expect(.shown(nil)), .expect(.counted("surface.withdrawn.covered")),
            ]),
            Transition("Tab after the withdrawal is the app's", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .screen { $0.behind() }, .activated,
                .press(Fx.tab()), .sent([]), .expect(.workingOn(nil)),
            ]),
        ])
    }

    func testFocusMovingDuringARetry() {
        play([
            Transition("held for the other field, shown once focus reaches its own", [
                .screen { $0.front(.phone) },
                .offer(Fx.fillPopup(at: .email)),
                .expect(.held(.fieldNotFocused)),
                .wait(0.5), .expect(.held(.fieldNotFocused)),
                .screen { $0.focused[Fx.app] = Fx.field(.email) },
                .wait(0.5), .expect(.shown("fill-2")), .did(["panel enter \(popupTitle)"]),
            ]),
            Transition("the hold reason changes; the 30 s count does not restart", [
                .screen { $0.behind() },
                .offer(Fx.fillPopup(at: .email)),
                .wait(20), .screen { $0.front(.phone) },
                .wait(0.5), .expect(.held(.fieldNotFocused)),
                .wait(10), .expect(.held(nil)),
                .screen { $0.focused[Fx.app] = Fx.field(.email) },
                .wait(1), .expect(.shown(nil)),
            ]),
            Transition("focus moves to another field while shown: withdrawn", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .focusMoved(.phone),
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.counted("surface.withdrawn.focusMoved")),
                .did(["panel enter \(popupTitle)", "clear caret", "hide 0.1"]),
            ]),
            Transition("focus moves with no notification: the Tab is refused, nothing is sent", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .screen { $0.focused[Fx.app] = Fx.field(.phone) },
                .press(Fx.tab()),
                .sent([]), .expect(.workingOn(nil)), .expect(.counted("surface.refused.targetMoved")),
                .expect(.custom("the claim ends as targetMoved") { $0.arbiter.snapshot().lastClaim?.outcome == .rejected("targetMoved") }),
                .did(["panel enter \(popupTitle)", "clear caret", "hide 0.1"]),
            ]),
        ])
    }

    func testTwoIdenticalFramesInDifferentWindows() {
        play([
            Transition("the reader's window number decides: the twin window's field waits", [
                .screen { $0.front(.email, window: Fx.twinWindow) },
                .offer(Fx.fillPopup(window: Fx.formWindow)),
                .expect(.held(.fieldNotFocused)),
                .screen { $0.focused[Fx.app] = Fx.field(.email, window: Fx.formWindow) },
                .wait(0.5), .expect(.shown("fill-2")),
            ]),
            Transition("the number decides over a title that changed as the document was edited", [
                .screen { $0.front(.email, window: WindowIdentity(number: 41, title: "Contact details, edited")) },
                .offer(Fx.fillPopup(window: Fx.formWindow)),
                .expect(.shown("fill-2")),
            ]),
            Transition("no number on the host's side: the title decides", [
                .screen { $0.front(.email, window: WindowIdentity(number: nil, title: "Invoice 2041")) },
                .offer(Fx.fillPopup(window: Fx.formWindow)),
                .expect(.held(.fieldNotFocused)),
                .screen { $0.focused[Fx.app] = Fx.field(.email, window: WindowIdentity(number: nil, title: "Contact details")) },
                .wait(0.5), .expect(.shown("fill-2")),
            ]),
            Transition("the reader read no number and no title: the frame decides alone", [
                .screen { $0.front(.email, window: Fx.twinWindow) },
                .offer(Fx.fillPopup(window: WindowIdentity(number: nil, title: nil))),
                .expect(.shown("fill-2")),
            ]),
        ])
    }

    func testANewerOfferArrivingDuringATab() {
        play([
            Transition("the Tab was on the older offer: it is taken, and the newer gives way", [
                .screen { $0.front() }, .offer(Fx.fillPopup()),
                .pressLate(Fx.tab()),
                .offer(Fx.action()),
                .expect(.shown("offer-5")),
                .deliver,
                .sent(["accept fill-2 fillAll"]),
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.workingOn("fill-2")),
                .expect(.counted("surface.claimAfterReplace")),
                .did([
                    "panel enter \(popupTitle)",
                    "clear caret", "hide 0.0", "panel enter \(actionLine)",
                    "clear caret", "hide 0.0", "clear caret", "line \(filling)", "working on",
                ]),
            ]),
            Transition("the newer offer arrives while alternatives' text is inserted: refused", [
                .screen { $0.front() }, .offer(Fx.alternatives()),
                .pressLate(Fx.tab()),
                .offer(Fx.action()),
                .expect(.shown(nil)),
                .expect(.custom("the arbiter refused the publish") { $0.arbiter.snapshot().refusedPublishCount == 1 }),
                .deliver,
                .sent([]), .expect(.workingOn(nil)),
                .inserted,
                .offer(Fx.action()), .expect(.shown("offer-5")),
            ]),
        ])
    }

    func testTwoToastsAtOnce() {
        play([
            Transition("the fill line's toast takes the slot: this toast goes, and ⌘Z is the fill line's", toastUp + [
                .fillLineToast,
                .expect(.toast(nil)), .expect(.line(nil)), .did(["hide 0.08"]),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
                .expect(.custom("the fill line's grant was taken") { $0.arbiter.snapshot().toast == nil }),
            ]),
            Transition("taking the slot tells the fill line", working + [
                .progress("fill-2", .verified), .progress("fill-2", .done),
                .did(["working off", "toast slot", "line Filled 1 field from Mail Fixture"]),
            ]),
            Transition("a new offer ends the toast and its undo", toastUp + [
                .offer(Fx.action()),
                .expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.shown("offer-5")),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
            ]),
            Transition("a second run's toast replaces the first", toastUp + [
                .offer(Fx.fillPopup(key: "fill-3")),
                .press(Fx.tab()),
                .progress("fill-3", .verified), .progress("fill-3", .done),
                .expect(.toast("Filled 1 field from Mail Fixture")),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll", "accept fill-3 fillAll", "undo fill-3"]),
            ]),
        ])
    }

    func testEscAndUndoBelongToTheAppWhileTheLineIsHidden() {
        play([
            Transition("working line hidden: Esc after 3 s stops nothing", working + [
                .wait(3),
                .screen { $0.behind() }, .activated,
                .expect(.escOwned(false)), .expect(.counted("surface.lineHidden.appNotFront")),
                // Redrawn as the figure leaves (0.2 s) and on each second's tick.
                .did(["line \(filling)", "line \(filling)", "line \(filling)", "line \(filling), 3 s", "hide 0.0"]),
                .press(Fx.esc()),
                .sent(["accept fill-2 fillAll"]), .expect(.workingOn("fill-2")),
                .wait(2), .did([]),
            ]),
            Transition("toast hidden: ⌘Z is the app's", toastUp + [
                .screen { $0.behind() }, .activated,
                .expect(.undoOwned(false)), .expect(.toast(nil)), .did(["hide 0.0"]),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
            ]),
            Transition("visible working line: Esc under 3 s dismisses the line, the work goes on", working + [
                .press(Fx.esc()),
                .expect(.escOwned(false)), .expect(.workingOn("fill-2")), .did(["hide 0.08"]),
                .sent(["accept fill-2 fillAll"]),
            ]),
            Transition("visible working line: Esc at 3 s stops the run", working + [
                .wait(3),
                .press(Fx.esc()),
                .sent(["accept fill-2 fillAll", "stop fill-2"]),
                .expect(.workingOn(nil)), .expect(.line("Stopping\u{2026}")),
                // The line says it stopped once the helper does, and lives its 3 s from there.
                .taskLine(Fx.progress("fill-2", .stopped, reason: .you, steps: 0)),
                .expect(.line("You stopped it")),
                .wait(3), .expect(.line(nil)), .expect(.escOwned(false)),
            ]),
        ])
    }

    func testWithdrawal() {
        play([
            Transition("withdrawn while its line is shown: it goes, and Tab is the app's", [
                .screen { $0.front() }, .offer(Fx.action()),
                .withdraw("offer-5", .dismissed),
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.counted("surface.withdrawn.helper.dismissed")),
                .did(["panel enter \(actionLine)", "clear caret", "hide 0.1"]),
                .press(Fx.tab()), .sent([]),
            ]),
            Transition("withdrawn while held: never drawn", [
                .screen { $0.behind() }, .offer(Fx.action()),
                .withdraw("offer-5", .stale),
                .expect(.held(nil)),
                .screen { $0.front() }, .wait(1), .expect(.shown(nil)), .did([]),
            ]),
            Transition("another key's withdrawal leaves the shown offer", [
                .screen { $0.front() }, .offer(Fx.action()),
                .withdraw("offer-9", .dismissed),
                .expect(.shown("offer-5")),
            ]),
            Transition("taken once its run starts: the working line stays", actionWorking + [
                .withdraw("offer-5", .taken),
                .expect(.workingOn("offer-5")), .expect(.line("Adding to Sheet Fixture")), .did([]),
            ]),
        ])
    }

    func testTaskProgressEndsTheLine() {
        play([
            Transition("done: the result for 5 s", actionWorking + [
                .progress("offer-5", .done),
                .did(["working off", "line Added to Sheet Fixture"]),
                .expect(.lastLine(LineContent(figure: .done, lead: "Added", text: "to Sheet Fixture", emphasis: .plain))),
                .expect(.escOwned(true)),
                .wait(4.9), .expect(.line("Added to Sheet Fixture")),
                .wait(0.1), .expect(.line(nil)), .expect(.escOwned(false)), .did(["hide 0.2"]),
            ]),
            Transition("stopped: the reason in words for 6 s", actionWorking + [
                .taskLine(Fx.progress("offer-5", .stopped, detail: "mismatch", reason: .mismatch)),
                .expect(.line("Sheet Fixture didn't take it. Open Sheet Fixture to add it.")),
                .wait(6), .expect(.line(nil)),
            ]),
            Transition("handoff: your turn, for 6 s", actionWorking + [
                .progress("offer-5", .handoff),
                .expect(.line("Your turn in Sheet Fixture")),
                .wait(5.9), .expect(.line("Your turn in Sheet Fixture")),
                .wait(0.1), .expect(.line(nil)),
            ]),
            Transition("a newer offer ends the result, and its timer with it", actionWorking + [
                .progress("offer-5", .done),
                .wait(1),
                .offer(Fx.action(key: "offer-6")),
                .wait(5),
                .expect(.shown("offer-6")), .expect(.line(actionLine)), .expect(.panelUp(true)),
            ]),
            Transition("paused: the line goes; the activity list carries it", actionWorking + [
                .progress("offer-5", .paused),
                .expect(.line(nil)), .expect(.workingOn(nil)), .did(["working off", "hide 0.08"]),
            ]),
            Transition("another task's end is ignored", actionWorking + [
                .progress("fill-9", .done),
                .expect(.workingOn("offer-5")), .did([]),
            ]),
            Transition("a fill done with nothing verified: no toast, nothing to undo", working + [
                .progress("fill-2", .done),
                .expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.line("Added to Caret Fixture")),
            ]),
            Transition("a fill stopped after one field", working + [
                .progress("fill-2", .verified), .taskLine(Fx.progress("fill-2", .stopped, reason: .changed)),
                .expect(.line("Filled 1 field, then stopped: Caret Fixture changed while Caret worked")),
            ]),
            Transition("Esc closes the result", actionWorking + [
                .progress("offer-5", .done), .did(["working off", "line Added to Sheet Fixture"]),
                .press(Fx.esc()),
                .expect(.line(nil)), .did(["hide 0.08"]),
            ]),
            Transition("the working line counts seconds and offers Stop from 3 s", working + [
                .wait(0.2),
                // A fill of two rows, none written yet: the bar holds at 8 percent.
                .expect(.lastLine(LineContent(figure: .absent, app: "Caret Fixture", text: filling, emphasis: .plain, progress: 0.08))),
                .wait(2.8),
                .expect(.lastLine(LineContent(
                    figure: .absent, app: "Caret Fixture", text: "\(filling), 3 s", emphasis: .plain,
                    hints: [Hint(key: "Esc", label: "Stop")], progress: 0.08
                ))),
            ]),
        ])
    }

    func testMessagesCarryTheClocksTime() {
        let rig = SurfaceRig()
        rig.screen.front()
        rig.machine.receive(Fx.fillPopup())
        rig.clock.advance(by: 1.25)
        rig.press(Fx.tab())
        rig.clock.advance(by: 3)
        rig.press(Fx.esc())
        let start = Int64(rig.clock.now.timeIntervalSince1970 * 1000) - 4250
        XCTAssertEqual(rig.sent, ["accept fill-2 fillAll", "stop fill-2"])
        XCTAssertEqual(rig.sentAt, [start + 1250, start + 4250])
    }

    func testAHideStillLandsWhileTheLastLineFades() {
        play([
            Transition("withdrawn (100 ms fade), then alternatives at once: the fade is cut short", [
                .screen { $0.front() }, .offer(Fx.action()),
                .withdraw("offer-5", .dismissed),
                .offer(Fx.alternatives()),
                .did(["panel enter \(actionLine)", "clear caret", "hide 0.1", "hide 0.0", "alternatives enter Cara Diaz quoted"]),
            ]),
            Transition("once the fade is over, nothing more to hide", [
                .screen { $0.front() }, .offer(Fx.action()),
                .withdraw("offer-5", .dismissed),
                .wait(0.1),
                .offer(Fx.alternatives()),
                .did(["panel enter \(actionLine)", "clear caret", "hide 0.1", "alternatives enter Cara Diaz quoted"]),
            ]),
        ])
    }

    func testUndoAndTheToastsLifetime() {
        play([
            Transition("⌘Z within the lifetime: undo is asked for and reported", toastUp + [
                .expect(.lastLine(LineContent(
                    figure: .done, lead: "Filled", text: "2 fields from Mail Fixture", emphasis: .plain,
                    hints: [Hint(key: "⌘Z", label: "Undo")]
                ))),
                .wait(4.9),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll", "undo fill-2"]),
                .expect(.toast("Undoing")), .did(["line Undoing"]),
                .progress("fill-2", .undone, detail: restored, restored: 2, notRestored: 0),
                .expect(.toast("Cleared 2 fields")), .did(["line Cleared 2 fields"]),
                .wait(2), .expect(.line(nil)), .did(["hide 0.2"]),
            ]),
            Transition("⌘Z after the toast expired: the app's, and nothing is sent", toastUp + [
                .wait(5),
                .expect(.toast(nil)), .expect(.undoOwned(false)), .did(["hide 0.2"]),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll"]),
            ]),
            Transition("an undo that could not restore every field", toastUp + [
                .press(Fx.cmdZ()),
                .progress("fill-2", .undone, detail: "restored 1; not restored 1; presses not undoable 0", restored: 1, notRestored: 1),
                .expect(.toast("1 field changed after the fill, so it was left as it is.")),
            ]),
            Transition("the helper never answers: Undoing for 10 s", toastUp + [
                .press(Fx.cmdZ()),
                .wait(9.9), .expect(.line("Undoing")),
                .wait(0.1), .expect(.line(nil)),
            ]),
            Transition("Esc closes the toast and gives ⌘Z back", toastUp + [
                .press(Fx.esc()),
                .expect(.toast(nil)), .expect(.undoOwned(false)), .did(["hide 0.08"]),
            ]),
        ])
    }

    func testAlternativesDrawingDecisions() {
        play([
            Transition("down opens them, Esc closes, typing the head keeps the rest", [
                .screen { $0.front() }, .offer(Fx.alternatives()),
                .did(["alternatives enter Cara Diaz quoted"]),
                .press(Fx.down()), .did(["alternatives redraw Cal Duarte open quoted"]),
                .press(Fx.esc()), .did(["alternatives redraw Cara Diaz quoted"]),
                .press(Fx.type("C")), .did(["typed rest ara Diaz"]),
                .press(Fx.tab()),
                .sent([]), .expect(.shown(nil)), .did(["clear caret"]),
                .expect(.custom("the claim names the top candidate") { $0.machine.lastAccepted?.candidate == 0 }),
            ]),
            Transition("a candidate wider than the field is held without retry", [
                .screen { $0.front() },
                .offer(Fx.alternatives(candidates: [String(repeating: "w", count: 40)])),
                .expect(.held(nil)), .expect(.shown(nil)), .expect(.counted("surface.held.wouldOverlapText")),
            ]),
            Transition("in a field holding text, a caret estimated flush with its bottom edge still shows them", [
                .screen {
                    $0.front()
                    $0.focused[Fx.app] = Fx.field(.email, value: "Dana ")
                    let email = Fx.Element.email.frame
                    $0.caretOverride[Fx.app] = .at(CGRect(x: email.minX + 39, y: email.maxY - 19, width: 2, height: 19))
                },
                .offer(Fx.alternatives()),
                .did(["alternatives enter Cara Diaz quoted"]),
            ]),
            Transition("alternatives take down a result line left on the panel", actionWorking + [
                .progress("offer-5", .done), .did(["working off", "line Added to Sheet Fixture"]),
                .offer(Fx.alternatives()),
                .expect(.line(nil)), .expect(.escOwned(false)), .did(["hide 0.0", "alternatives enter Cara Diaz quoted"]),
            ]),
        ])
    }

    func testHeadlessDecidesWithoutReadingOrDrawing() {
        play([
            Transition("fill pop-up to toast, with no panel command and no screen read", headless: true, [
                .offer(Fx.fillPopup()),
                .expect(.shown("fill-2")), .expect(.line(popupTitle)),
                .press(Fx.tab()),
                .sent(["accept fill-2 fillAll"]),
                .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done),
                .expect(.toast(toast)), .expect(.line(toast)),
                .press(Fx.cmdZ()),
                .sent(["accept fill-2 fillAll", "undo fill-2"]),
                .did(["working on", "working off", "toast slot"]),
                .expect(.fieldReads([])),
            ]),
            Transition("alternatives: the line names the candidate shown", headless: true, [
                .offer(Fx.alternatives()),
                .expect(.line("Cara Diaz")),
                .press(Fx.down()), .expect(.line("Cal Duarte")),
            ]),
        ])
    }
}
