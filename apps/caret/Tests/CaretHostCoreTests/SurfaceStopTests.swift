import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The line after a stopped run names the helper's reason in plain words (A12), one test per
/// `TaskProgress.StopReason`; Esc names the step it stopped before; an action that wrote something
/// ends on a toast whose ⌘Z asks the helper to undo it.
final class SurfaceStopTests: XCTestCase {
    /// The action line taken, its working line up, two of its three steps' progress seen: the
    /// first verified, the second acting.
    private var midRun: [Step] {
        [
            .screen { $0.front() },
            .offer(Fx.action()),
            .press(Fx.tab()),
            .sent(["accept offer-5 finish"]),
            .taskLine(Fx.progress("offer-5", .acting, step: 0, steps: 3)),
            .taskLine(Fx.progress("offer-5", .verified, step: 0, steps: 3)),
            .taskLine(Fx.progress("offer-5", .acting, step: 1, steps: 3)),
        ]
    }

    /// The helper stops the run at its second step for `reason`: the line says `says`, with the
    /// calm figure for a stop the user asked for and the error figure otherwise, for 3 or 6 s.
    private func stops(_ reason: TaskProgress.StopReason, says: String, file: StaticString = #filePath, line: UInt = #line) {
        let you = reason == .you
        play(Transition("stopped: \(reason.rawValue)", file: file, line: line, midRun + [
            .taskLine(Fx.progress("offer-5", .stopped, detail: "the helper's own words, never shown", reason: reason, step: 1, steps: 3)),
            .expect(.workingOn(nil)),
            .expect(.line(says)),
            .expect(.lastLine(LineContent(figure: you ? .done : .error, text: says, emphasis: .plain))),
            .expect(.toast(nil)), .expect(.undoOwned(false)),
            .wait(you ? 2.9 : 5.9), .expect(.line(says)),
            .wait(0.1), .expect(.line(nil)),
        ]))
    }

    func testStoppedByYou() { stops(.you, says: "Stopped before step 2 of 3") }
    func testStoppedBecauseTheScreenChanged() { stops(.changed, says: "Stopped because Sheet Fixture changed while Caret was working.") }
    func testStoppedBecauseADialogOpened() { stops(.sheet, says: "Stopped because a dialog opened in Sheet Fixture.") }
    func testStoppedBecauseTheWindowIsGone() { stops(.windowGone, says: "Stopped because Caret couldn't find the Sheet Fixture window.") }
    func testStoppedBecauseSeveralWindowsMatched() { stops(.ambiguous, says: "Stopped because more than one Sheet Fixture window matched.") }
    func testStoppedBecauseTheReaderRestarted() { stops(.readerRestarted, says: "Stopped because Caret lost its view of the screen.") }
    func testStoppedBecauseTheReaderRefused() { stops(.reader, says: "Stopped because Caret couldn't read or change Sheet Fixture.") }
    func testStoppedBecauseTheChangeDidNotHold() { stops(.mismatch, says: "Stopped because Sheet Fixture didn't take the change.") }
    func testStoppedBecauseTheTargetWasNotFound() { stops(.unreachable, says: "Stopped because Caret couldn't find the spot in Sheet Fixture.") }
    func testStoppedBecauseNothingIsSetUp() { stops(.notConfigured, says: "Stopped because Caret isn't set up for this yet.") }
    func testStoppedBecauseTheOfferWasRefused() { stops(.refused, says: "Caret couldn't run that offer, so nothing changed.") }
    func testStoppedForAnotherReason() { stops(.error, says: "Stopped because something unexpected happened.") }

    func testEveryReasonHasItsOwnWords() {
        let all: [TaskProgress.StopReason] = [.you, .changed, .sheet, .windowGone, .ambiguous, .readerRestarted, .reader, .mismatch, .unreachable, .notConfigured, .refused, .error]
        let words = all.map { Captions.stopped($0, app: "Mail", next: 1, steps: 3, fillFilled: nil) }
        XCTAssertEqual(Set(words).count, all.count, "no two reasons read the same")
        for w in words {
            XCTAssertFalse(w.contains("\u{2014}") || w.contains("!"), w)
        }
    }

    func testAFillSaysWhatItFilledBeforeTheReason() {
        XCTAssertEqual(Captions.stopped(.windowGone, app: "Safari", next: 2, steps: 3, fillFilled: 2), "Filled 2 fields, then stopped because Caret couldn't find the Safari window.")
        XCTAssertEqual(Captions.stopped(.windowGone, app: "Safari", next: 0, steps: 3, fillFilled: 0), "Filled nothing, because Caret couldn't find the Safari window.")
        XCTAssertEqual(Captions.stopped(.you, app: "Safari", next: 2, steps: 3, fillFilled: 2), "Stopped before step 3 of 3", "a stop you asked for names the step, fill or not")
    }

    // MARK: - A writing aid's ring around the field

    /// The A12 desktop case on the fake screen: a background agent's layer-1 window rings the
    /// focused field by 64 pt. The offer shows and its line stays up; the same window from a
    /// regular app holds it as covered.
    func testAnAgentsRingAroundTheFieldDoesNotHideTheOffer() {
        let ring = Fx.Element.email.frame.insetBy(dx: -64, dy: -64)
        play(Transition("a writing aid's ring", [
            .screen { $0.front(); $0.windows.insert(SurfaceGate.Window(pid: 777, bounds: ring, layer: 1, agent: true), at: 0) },
            .offer(Fx.action()),
            .expect(.shown("offer-5")),
            .wait(2), .expect(.shown("offer-5")),
        ]))
        play(Transition("the same window from a regular app", [
            .screen { $0.front(); $0.windows.insert(SurfaceGate.Window(pid: 777, bounds: ring, layer: 1), at: 0) },
            .offer(Fx.action()),
            .expect(.shown(nil)), .expect(.held(.covered)),
        ]))
    }

    // MARK: - Esc

    func testEscMidRunStopsAndNamesTheStep() {
        play(Transition("Esc at 3 s, the second of three steps acting", midRun + [
            .wait(3),
            .press(Fx.esc()),
            .sent(["accept offer-5 finish", "stop offer-5"]),
            .expect(.workingOn(nil)), .expect(.line("Stopped before step 2 of 3")),
            // The helper's own stop arrives after; the line already said it.
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .expect(.line("Stopped before step 2 of 3")),
            .wait(3), .expect(.line(nil)), .expect(.escOwned(false)),
        ]))
    }

    func testAStepThatFinishedBeforeTheStopCorrectsTheLine() {
        play(Transition("Esc, then step 2 verifies and the helper stops before step 3", midRun + [
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopped before step 2 of 3")),
            .taskLine(Fx.progress("offer-5", .verified, step: 1, steps: 3)),
            .expect(.line("Stopped before step 2 of 3")),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line("Stopped before step 3 of 3")), .expect(.counted("surface.stop.corrected")),
            .wait(3), .expect(.line(nil)),
        ]))
        play(Transition("Esc, then the run turns out to have finished", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-5", .done, written: 1, steps: 3)),
            .expect(.line("Done, in Sheet Fixture")), .expect(.toast(nil)),
        ]))
        play(Transition("Esc, then the helper reports the step had already failed", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .mismatch, step: 1, steps: 3)),
            .expect(.line("Stopped because Sheet Fixture didn't take the change.")),
        ]))
        play(Transition("a key took the stopped line down: a late ending does not bring it back", midRun + [
            .wait(3), .press(Fx.esc()),
            .press(Fx.esc()), .expect(.line(nil)),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line(nil)), .expect(.panelUp(false)),
        ]))
        play(Transition("another task's ending leaves the stopped line", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-9", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line("Stopped before step 2 of 3")),
        ]))
    }

    func testEscBeforeAnyProgressJustStops() {
        play(Transition("Esc at 3 s with no progress yet", [
            .screen { $0.front() }, .offer(Fx.action()), .press(Fx.tab()),
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopped")),
        ]))
    }

    // MARK: - An action's toast and ⌘Z

    func testAnActionThatWroteEndsOnAToastWhoseCommandZUndoesIt() {
        play(Transition("done with one field written", midRun + [
            .taskLine(Fx.progress("offer-5", .done, written: 1, steps: 3)),
            .expect(.toast("Done, in Sheet Fixture")), .expect(.undoOwned(true)),
            .expect(.lastLine(LineContent(figure: .done, lead: "Done,", text: "in Sheet Fixture", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")]))),
            .expect(.counted("surface.toast.action")),
            .press(Fx.cmdZ()),
            .sent(["accept offer-5 finish", "undo offer-5"]),
            .expect(.toast("Undoing")),
            .taskLine(Fx.progress("offer-5", .undone, restored: 1, notRestored: 0, steps: 3)),
            .expect(.toast("Cleared 1 field")),
        ]))
    }

    func testAnActionThatWroteNothingHasNothingToUndo() {
        play(Transition("done with nothing written: presses only", midRun + [
            .taskLine(Fx.progress("offer-5", .done, written: 0, steps: 3)),
            .expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.line("Done, in Sheet Fixture")),
        ]))
    }
}
