import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The line after a stopped run says who or what stopped it (A12, A13), one test per
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
            .expect(.lastLine(LineContent(figure: you ? .still : .error, text: says, emphasis: .plain))),
            .expect(.toast(nil)), .expect(.undoOwned(false)),
            .wait(you ? 2.9 : 5.9), .expect(.line(says)),
            .wait(0.1), .expect(.line(nil)),
        ]))
    }

    func testStoppedByYou() { stops(.you, says: "You stopped it before step 2 of 3") }
    func testStoppedBecauseTheScreenChanged() { stops(.changed, says: "Stopped before step 2 of 3: Sheet Fixture changed while Caret worked") }
    func testStoppedBecauseADialogOpened() { stops(.sheet, says: "Stopped before step 2 of 3: a dialog opened in Sheet Fixture") }
    func testStoppedBecauseTheWindowIsGone() { stops(.windowGone, says: "Stopped before step 2 of 3: the window closed or wasn't found") }
    func testStoppedBecauseSeveralWindowsMatched() { stops(.ambiguous, says: "Stopped before step 2 of 3: more than one Sheet Fixture window matched") }
    func testStoppedBecauseTheReaderRestarted() { stops(.readerRestarted, says: "Stopped before step 2 of 3: Caret lost its view of the screen") }
    func testStoppedBecauseTheReaderRefused() { stops(.reader, says: "Stopped before step 2 of 3: Caret couldn't read or change Sheet Fixture") }
    func testStoppedBecauseTheChangeDidNotHold() { stops(.mismatch, says: "Stopped before step 2 of 3: Sheet Fixture didn't take the change") }
    func testStoppedBecauseTheTargetWasNotFound() { stops(.unreachable, says: "Stopped before step 2 of 3: Caret couldn't reach the spot in Sheet Fixture") }
    func testStoppedBecauseNothingIsSetUp() { stops(.notConfigured, says: "Stopped before step 2 of 3: Caret isn't set up for this yet") }
    func testStoppedBecauseTheOfferWasRefused() { stops(.refused, says: "Caret couldn't run that offer, so nothing changed") }
    func testStoppedForAnotherReason() { stops(.error, says: "Stopped before step 2 of 3: something unexpected happened") }

    func testEveryReasonHasItsOwnWords() {
        let all: [TaskProgress.StopReason] = [.you, .changed, .sheet, .windowGone, .ambiguous, .readerRestarted, .reader, .mismatch, .unreachable, .notConfigured, .refused, .error]
        let words = all.map { Captions.stopped($0, app: "Mail", next: 1, steps: 3, fillFilled: nil) }
        XCTAssertEqual(Set(words).count, all.count, "no two reasons read the same")
        for w in words {
            XCTAssertFalse(w.contains("\u{2014}") || w.contains("!"), w)
        }
    }

    func testAFillSaysWhatItFilledBeforeTheReason() {
        XCTAssertEqual(Captions.stopped(.windowGone, app: "Safari", next: 2, steps: 3, fillFilled: 2), "Filled 2 fields, then stopped: the window closed or wasn't found")
        XCTAssertEqual(Captions.stopped(.windowGone, app: "Safari", next: 0, steps: 3, fillFilled: 0), "Stopped before filling anything: the window closed or wasn't found")
        XCTAssertEqual(Captions.stopped(.you, app: "Safari", next: 2, steps: 3, fillFilled: 2), "You stopped it before step 3 of 3", "a stop you asked for names the step, fill or not")
    }

    /// Brief A13: the line says who stopped it. With no step to name (one step, or none known),
    /// the sentence still says who; it never claims a step it does not know.
    func testTheLineSaysWhoStoppedItWithOrWithoutAStep() {
        XCTAssertEqual(Captions.stoppedByYou(next: 1, of: 3), "You stopped it before step 2 of 3")
        XCTAssertEqual(Captions.stoppedByYou(next: 0, of: 1), "You stopped it", "a one-step run has no step worth naming")
        XCTAssertEqual(Captions.stoppedByYou(next: nil, of: 3), "You stopped it")
        XCTAssertEqual(Captions.stoppedByYou(next: 3, of: 3), "You stopped it", "past the last step names none")
        XCTAssertEqual(Captions.stopped(.windowGone, app: "Mail", next: 1, steps: 3, fillFilled: nil), "Stopped before step 2 of 3: the window closed or wasn't found")
        XCTAssertEqual(Captions.stopped(.sheet, app: "Mail", next: nil, steps: 0, fillFilled: nil), "Stopped: a dialog opened in Mail")
        XCTAssertEqual(Captions.stopped(.sheet, app: "Mail", next: 0, steps: 1, fillFilled: nil), "Stopped: a dialog opened in Mail")
        for reason in [TaskProgress.StopReason.changed, .sheet, .windowGone, .ambiguous, .readerRestarted, .reader, .mismatch, .unreachable, .notConfigured, .error] {
            let line = Captions.stopped(reason, app: "Mail", next: 1, steps: 3, fillFilled: nil)
            XCTAssertTrue(line.hasPrefix("Stopped before step 2 of 3: "), line)
            XCTAssertFalse(line.hasPrefix("You"), "only the user's own stop says You: \(line)")
        }
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

    /// S1 audit #17: Esc says "Stopping…" until the helper's own ending says it stopped, never
    /// "You stopped it" before.
    func testEscSaysStoppingUntilTheHelperSaysWhereItStopped() {
        play(Transition("Esc at 3 s, the second of three steps acting", midRun + [
            .wait(3),
            .press(Fx.esc()),
            .sent(["accept offer-5 finish", "stop offer-5"]),
            .expect(.workingOn(nil)), .expect(.line("Stopping\u{2026}")),
            .expect(.lastLine(LineContent(figure: .absent, text: "Stopping\u{2026}", emphasis: .plain))),  // the figure is still away: its seat stays empty
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .expect(.line("You stopped it before step 2 of 3")), .expect(.counted("surface.stop.confirmed")),
            .wait(3), .expect(.line(nil)), .expect(.escOwned(false)),
        ]))
    }

    func testTheHelpersEndingSaysWhereItReallyStopped() {
        play(Transition("Esc, then step 2 verifies and the helper stops before step 3", midRun + [
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopping\u{2026}")),
            .taskLine(Fx.progress("offer-5", .verified, step: 1, steps: 3)),
            .expect(.line("Stopping\u{2026}")),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line("You stopped it before step 3 of 3")), .expect(.counted("surface.stop.corrected")),
            .wait(3), .expect(.line(nil)),
        ]))
        play(Transition("Esc, then the run turns out to have finished", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-5", .done, written: 1, steps: 3)),
            .expect(.line("Added to Sheet Fixture")), .expect(.toast(nil)),
        ]))
        play(Transition("Esc, then the helper reports the step had already failed", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .mismatch, step: 1, steps: 3)),
            .expect(.line("Stopped before step 2 of 3: Sheet Fixture didn't take the change")),
        ]))
        play(Transition("Esc, then the user's own input had paused it first", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-5", .paused, step: 1, steps: 3)),
            .expect(.line("You stopped it before step 2 of 3")),
        ]))
        play(Transition("a key took the stopping line down: a late ending does not bring it back", midRun + [
            .wait(3), .press(Fx.esc()),
            .press(Fx.esc()), .expect(.line(nil)),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line(nil)), .expect(.panelUp(false)),
        ]))
        play(Transition("another task's ending leaves the stopping line", midRun + [
            .wait(3), .press(Fx.esc()),
            .taskLine(Fx.progress("offer-9", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line("Stopping\u{2026}")),
        ]))
    }

    /// A15 part 1, the regression A14's on-screen run hit (Esc 1 of 3). The helper stops a run at
    /// its next step boundary, so its ending can come more than 3 s after Esc. Replayed with the
    /// helper's timing in A12's harness (act_end_to_end.ts): step 1 is held 5 s before it starts, the
    /// first step took 1.2 s on a loaded Mac, and Esc lands 3.2 s after Tab, so the helper's
    /// `stopped` arrives 3.0 s after Esc and the harness reads the line 0.2 s after that.
    func testTheStoppingLineWaitsForTheHelpersEndingAfterASlowStep() {
        let tabbed: [Step] = [
            .screen { $0.front() }, .offer(Fx.action()), .press(Fx.tab()),
            .taskLine(Fx.progress("offer-5", .started, steps: 3)),
            .taskLine(Fx.progress("offer-5", .acting, step: 0, steps: 3)),
            .wait(1.2),
            .taskLine(Fx.progress("offer-5", .verified, step: 0, steps: 3)),
            .wait(2.0),
            .press(Fx.esc()),
            .sent(["accept offer-5 finish", "stop offer-5"]),
            .expect(.line("Stopping\u{2026}")),
        ]
        play(Transition("the helper's ending 3.0 s after Esc", tabbed + [
            .wait(3.0),
            .expect(.line("Stopping\u{2026}")),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .wait(0.2),
            .expect(.line("You stopped it before step 2 of 3")), .expect(.escOwned(true)),
            // Its 3 s run from the ending.
            .wait(2.7), .expect(.line("You stopped it before step 2 of 3")),
            .wait(0.1), .expect(.line(nil)),
        ]))
        play(Transition("a late ending still corrects the step", tabbed + [
            .wait(3.5),
            .taskLine(Fx.progress("offer-5", .verified, step: 1, steps: 3)),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 2, steps: 3)),
            .expect(.line("You stopped it before step 3 of 3")), .expect(.counted("surface.stop.corrected")),
        ]))
        play(Transition("no ending ever comes: the line says so and the session is closed", tabbed + [
            .wait(SurfaceMachine.stopConfirmWait - 0.1), .expect(.line("Stopping\u{2026}")),
            .expect(.custom("the session is still open") { !$0.log.contains("drop session") }),
            .wait(0.1),
            .expect(.line(Captions.stopUnreached)), .expect(.counted("surface.stop.unconfirmed")),
            .expect(.custom("the session is closed so the helper revokes") { $0.log.contains("drop session") }),
            // A late ending after that says nothing new: the line already said it is not known.
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .expect(.line(Captions.stopUnreached)),
            .wait(SurfaceMachine.stopUnreachedLifetime), .expect(.line(nil)), .expect(.escOwned(false)),
        ]))
    }

    /// The stop's deadline belongs to the run, not to its line (A17 review): a key that takes the
    /// "Stopping…" line down does not cancel it, and only the run's ending does.
    func testTheStopDeadlineOutlivesItsLine() {
        play(Transition("Esc, then a key takes the line down, and no ending comes", midRun + [
            .wait(3), .press(Fx.esc()),
            .press(Fx.esc()), .expect(.line(nil)),
            .wait(SurfaceMachine.stopConfirmWait),
            .expect(.counted("surface.stop.unconfirmed")),
            .expect(.custom("the session is closed so the helper revokes") { $0.log.contains("drop session") }),
            .expect(.line(nil)),
        ]))
        play(Transition("Esc, the line taken down, then the ending: nothing more", midRun + [
            .wait(3), .press(Fx.esc()),
            .press(Fx.esc()), .expect(.line(nil)),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .wait(SurfaceMachine.stopConfirmWait),
            .expect(.custom("the session stays open") { !$0.log.contains("drop session") }),
        ]))
    }

    /// A stop that cannot be delivered says so at once, with no "Stopping…", and closes the session.
    func testAStopThatCannotBeDeliveredSaysTheRunMayStillBeGoing() {
        play(Transition("the helper's connection is gone when Esc is pressed", midRun + [
            .wait(3), .helperDown,
            .press(Fx.esc()),
            .expect(.line(Captions.stopUnreached)),
            .expect(.lastLine(LineContent(figure: .error, text: Captions.stopUnreached, emphasis: .plain))),
            .expect(.counted("surface.stop.unsent")),
            .expect(.custom("the session is closed so the helper revokes") { $0.log.contains("drop session") }),
            .wait(SurfaceMachine.stopUnreachedLifetime - 0.1), .expect(.line(Captions.stopUnreached)),
        ]))
        XCTAssertEqual(Captions.stopUnreached, "Couldn't reach Caret's helper, so the run may still be going. Quit Caret to stop it.")
    }

    func testTheHelperGoingAwayWhileStoppingSaysTheRunMayStillBeGoing() {
        play(Transition("the connection drops after Esc, before the helper's ending", midRun + [
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopping\u{2026}")),
            .linkLost,
            .expect(.line(Captions.stopUnreached)), .expect(.counted("surface.stop.helperGone")),
        ]))
    }

    /// A15 part 1, the second failure A14 and A15's on-screen runs hit: the stopped line was taken
    /// down as `covered` within half a second of Esc. The only window over the caret was Grammarly's
    /// ring around TextEdit's text area (measured: field grown 64 pt on every side, layer 1, an
    /// agent app), which the gate forgives only when it can read the app's focused frame. A read
    /// that failed while TextEdit was busy left nothing to measure the ring against. The watch now
    /// measures it against the field the line was drawn for.
    func testAWritingAidsRingDoesNotHideTheLineWhenTheFocusedFrameCannotBeRead() {
        let field = Fx.Element.email.frame
        let ring = SurfaceGate.Window(pid: 4242, bounds: field.insetBy(dx: -64, dy: -64), layer: 1, agent: true)
        play(Transition("Esc, then a recheck while the focused frame is unreadable", [
            .screen { $0.front(); $0.windows.insert(ring, at: 0) },
            .offer(Fx.action()), .press(Fx.tab()),
            .taskLine(Fx.progress("offer-5", .verified, step: 0, steps: 3)),
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopping\u{2026}")),
            .screen { $0.frameUnreadable = true },
            .wait(SurfaceMachine.recheckInterval),
            .expect(.line("Stopping\u{2026}")), .expect(.escOwned(true)),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, step: 1, steps: 3)),
            .expect(.line("You stopped it before step 2 of 3")),
        ]))
        play(Transition("a regular app's window over the caret still hides it", [
            .screen { $0.front() },
            .offer(Fx.action()), .press(Fx.tab()),
            .wait(3), .press(Fx.esc()),
            .screen { $0.frameUnreadable = true; $0.windows.insert(Fx.cover, at: 0) },
            .wait(SurfaceMachine.recheckInterval),
            .expect(.panelUp(false)), .expect(.escOwned(false)), .expect(.counted("surface.lineHidden.covered")),
            .expect(.custom("the debug state names the cover") { rig in
                let h = rig.machine.lastLineHidden
                return h?.hold == "covered" && h?.coverPID == Fx.other && h?.focusedFrameRead == false
            }),
        ]))
    }

    func testEscBeforeAnyProgressWaitsForTheHelper() {
        play(Transition("Esc at 3 s with no progress yet", [
            .screen { $0.front() }, .offer(Fx.action()), .press(Fx.tab()),
            .wait(3), .press(Fx.esc()),
            .expect(.line("Stopping\u{2026}")),
            .taskLine(Fx.progress("offer-5", .stopped, reason: .you, steps: 3)),
            .expect(.line("You stopped it")),
        ]))
    }

    // MARK: - An action's toast and ⌘Z

    func testAnActionThatWroteEndsOnAToastWhoseCommandZUndoesIt() {
        play(Transition("done with one field written", midRun + [
            .taskLine(Fx.progress("offer-5", .done, written: 1, steps: 3)),
            .expect(.toast("Added to Sheet Fixture")), .expect(.undoOwned(true)),
            .expect(.lastLine(LineContent(figure: .done, lead: "Added", text: "to Sheet Fixture", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")]))),
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
            .expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.line("Added to Sheet Fixture")),
        ]))
    }
}
