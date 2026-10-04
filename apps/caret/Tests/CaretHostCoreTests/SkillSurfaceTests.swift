import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// B19's skills at the caret (brief A15, part 2): the keep and promote questions under a run's toast,
/// and a skill's run with no Tab, drawn where the user is with Take over and ⌘Z. The messages are the
/// helper's golden lines (helper/fixtures/golden/protocol.ndjson), so the copy tested is the copy sent.
final class SkillSurfaceTests: XCTestCase {
    static let golden = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../helper/fixtures/golden/protocol.ndjson").standardized

    static func goldenLine(_ type: String, containing: String) throws -> Data {
        let lines = try String(contentsOf: golden, encoding: .utf8).split(separator: "\n")
        let line = try XCTUnwrap(lines.first { $0.contains("\"type\":\"\(type)\"") && $0.contains(containing) }, "\(type) with \(containing)")
        return Data(line.utf8)
    }

    /// The keep offer, re-aimed at `taskId`.
    static func offer(_ kind: String, task: String = "offer-5") throws -> SkillOffer {
        guard case .skillOffer(var o) = try HelperInbound.decode(goldenLine("skillOffer", containing: "\"kind\":\"\(kind)\"")) else {
            throw XCTSkip("not a skill offer")
        }
        o.taskId = task
        return o
    }

    /// The fixture's action line taken and done with one field written: its toast up, ⌘Z owned.
    private func doneRun() -> SurfaceRig {
        let rig = SurfaceRig()
        rig.screen.front()
        rig.machine.receive(Fx.action())
        rig.press(Fx.tab())
        rig.machine.taskProgress(Fx.progress("offer-5", .done, written: 1, steps: 3))
        XCTAssertEqual(rig.machine.toastInfo?.caption, "Done, in Sheet Fixture")
        return rig
    }

    private func undoOwned(_ rig: SurfaceRig) -> Bool {
        rig.arbiter.snapshot().toast.map { !$0.isExpired(at: rig.clock.now) } ?? false
    }

    // MARK: - Keep and promote

    func testTheKeepQuestionShowsUnderTheRunsToastAndTabKeepsIt() throws {
        let rig = doneRun()
        let keep = try Self.offer("keep")
        rig.machine.skillOffer(keep)
        guard case .line(let drawn)? = rig.panels.last else { return XCTFail("no line drawn") }
        XCTAssertEqual(drawn.text, "in Sheet Fixture", "the run's line stays on top")
        XCTAssertEqual(drawn.hints, [Hint(key: "⌘Z", label: "Undo")])
        XCTAssertEqual(drawn.question, LineContent.Question(
            text: "Keep this as Subject and To into Mail Fixture?", detail: "Caret will offer it when you start it again.",
            hints: [Hint(key: "Tab", label: "Keep"), Hint(key: "Esc", label: "No thanks")]
        ))
        // Past the run's own 5 s, ⌘Z still belongs to the run while the question shows.
        rig.clock.advance(by: 6)
        XCTAssertTrue(undoOwned(rig))
        rig.press(Fx.tab())
        XCTAssertEqual(rig.sent.last, "skill accept skill-offer-1")
        XCTAssertTrue(undoOwned(rig), "Tab answers the question and leaves ⌘Z with the run")
        XCTAssertEqual(rig.machine.debugInfo().question, "Keeping it as Subject and To into Mail Fixture", "pending until the helper says it took it")
        XCTAssertEqual(rig.machine.debugInfo().questionAnswered, true)
        XCTAssertNil(rig.arbiter.snapshot().current, "a second Tab finds nothing")
        rig.machine.withdrawn(OfferWithdrawn(at: 1, id: "skill-offer-1", reason: .taken))
        XCTAssertEqual(rig.machine.debugInfo().question, "Kept as Subject and To into Mail Fixture")
        rig.clock.advance(by: SurfaceMachine.answerHold)
        XCTAssertNil(rig.machine.lineText, "the answer shows for a moment, then the line goes")
        XCTAssertFalse(undoOwned(rig))
    }

    func testEscDeclinesAndClosesBoth() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("keep"))
        rig.press(Fx.esc())
        XCTAssertEqual(rig.sent.last, "skill decline skill-offer-1")
        XCTAssertNil(rig.machine.lineText)
        XCTAssertFalse(undoOwned(rig))
        XCTAssertNil(rig.arbiter.snapshot().current)
    }

    func testTypingDismissesBothAndAnswersNothing() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("keep"))
        rig.press(Fx.type("a"))
        XCTAssertEqual(rig.sent, ["accept offer-5 finish"], "no skillAnswer: typing on dismisses, never answers")
        XCTAssertTrue(rig.counts.contains("surface.skill.dismissed"))
        XCTAssertNil(rig.machine.lineText)
        XCTAssertFalse(undoOwned(rig))
    }

    func testCommandZUndoesTheRunAndTheQuestionGoesUnanswered() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("keep"))
        rig.press(Fx.cmdZ())
        XCTAssertEqual(rig.sent, ["accept offer-5 finish", "undo offer-5"])
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertNil(rig.machine.debugInfo().question)
        XCTAssertEqual(rig.machine.lineText, "Undoing")
    }

    func testAQuestionWhoseRunsToastIsGoneIsNotAsked() throws {
        let rig = doneRun()
        rig.press(Fx.type("a"))
        rig.machine.skillOffer(try Self.offer("keep"))
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertTrue(rig.counts.contains("surface.skill.notShown"))
        let other = doneRun()
        other.machine.skillOffer(try Self.offer("keep", task: "offer-77"))
        XCTAssertNil(other.arbiter.snapshot().current, "a question about another run is not asked under this one")
    }

    func testTheHelperWithdrawingTheQuestionLeavesTheToast() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("keep"))
        rig.machine.withdrawn(OfferWithdrawn(at: 1, id: "skill-offer-1", reason: .stale))
        XCTAssertNil(rig.arbiter.snapshot().current)
        guard case .line(let drawn)? = rig.panels.last else { return XCTFail("no line") }
        XCTAssertNil(drawn.question)
        XCTAssertTrue(undoOwned(rig))
    }

    func testTheQuestionGoesUnansweredAfterItsLifetime() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("keep"))
        rig.clock.advance(by: SurfaceMachine.questionLifetime + 0.1)
        XCTAssertNil(rig.machine.lineText)
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.sent, ["accept offer-5 finish"])
    }

    /// The brief's words for the promote offer, and the helper's: the question tells the truth about
    /// what saying yes does.
    func testThePromoteQuestionTellsTheTruth() throws {
        let rig = doneRun()
        rig.machine.skillOffer(try Self.offer("promote"))
        guard case .line(let drawn)? = rig.panels.last, let q = drawn.question else { return XCTFail("no question") }
        XCTAssertEqual("\(q.text) \(q.detail ?? "")", "Do this one on your own from now on? You'll see it happen and can undo it.")
        XCTAssertEqual(q.hints, [Hint(key: "Tab", label: "Do it on its own"), Hint(key: "Esc", label: "Keep asking")])
        rig.press(Fx.tab())
        XCTAssertEqual(rig.sent.last, "skill accept skill-offer-2")
        XCTAssertEqual(rig.machine.debugInfo().question, "Letting Subject and To into Mail Fixture run on its own")
        rig.machine.withdrawn(OfferWithdrawn(at: 1, id: "skill-offer-2", reason: .taken))
        XCTAssertEqual(rig.machine.debugInfo().question, "Subject and To into Mail Fixture runs on its own from now on")
    }

    // MARK: - Review fixes (A15)

    /// The tap took Tab or Esc on the question, then main drew a newer offer before the key's
    /// callback ran: the answer still goes, and goes once.
    func testAKeyTakenOnAQuestionIsAnsweredEvenIfANewerOfferReplacedItsLine() throws {
        let tab = doneRun()
        tab.machine.skillOffer(try Self.offer("keep"))
        tab.pressLate(Fx.tab())
        tab.machine.receive(Fx.action(key: "offer-6"))
        tab.deliver()
        XCTAssertEqual(tab.sent, ["accept offer-5 finish", "skill accept skill-offer-1"])
        let esc = doneRun()
        esc.machine.skillOffer(try Self.offer("keep"))
        esc.pressLate(Fx.esc())
        esc.machine.receive(Fx.action(key: "offer-6"))
        esc.deliver()
        XCTAssertEqual(esc.sent, ["accept offer-5 finish", "skill decline skill-offer-1"])
        XCTAssertEqual(esc.machine.shown?.offerKey, "offer-6", "the newer offer stays")
    }

    func testTheHelperLeavingOrAPauseTakesTheQuestionsKeys() throws {
        let gone = doneRun()
        gone.machine.skillOffer(try Self.offer("keep"))
        gone.machine.helperGone()
        XCTAssertNil(gone.arbiter.snapshot().current, "Tab is the app's again")
        let paused = doneRun()
        paused.machine.skillOffer(try Self.offer("keep"))
        paused.machine.gateClosed()
        XCTAssertNil(paused.arbiter.snapshot().current)
        guard case .line(let drawn)? = paused.panels.last else { return XCTFail("no line") }
        XCTAssertNil(drawn.question, "the toast stays, without the question")
    }

    func testAYesTheHelperDidNotTakeOrNeverConfirmedIsNotShownAsDone() throws {
        let expired = doneRun()
        expired.machine.skillOffer(try Self.offer("keep"))
        expired.press(Fx.tab())
        expired.machine.withdrawn(OfferWithdrawn(at: 1, id: "skill-offer-1", reason: .expired))
        XCTAssertEqual(expired.machine.debugInfo().question, "Caret couldn't save that, so nothing changed.")
        let silent = doneRun()
        silent.machine.skillOffer(try Self.offer("keep"))
        silent.press(Fx.tab())
        silent.clock.advance(by: SurfaceMachine.answerWait)
        XCTAssertEqual(silent.machine.debugInfo().question, "Caret didn't confirm that.")
        silent.clock.advance(by: SurfaceMachine.answerHold)
        XCTAssertNotNil(silent.machine.lineText, "a failure stays as long as other errors")
        silent.clock.advance(by: SurfaceMachine.answerFailHold - SurfaceMachine.answerHold)
        XCTAssertNil(silent.machine.lineText)
    }

    /// B19 counts a run that ends at its planned hand-off (Send left to the user) as clean, and may ask
    /// to keep it. The hand-off line has no toast; the question sits under it and keys the same way.
    func testAQuestionAfterAHandOffSitsUnderItsLine() throws {
        func handedOff() throws -> SurfaceRig {
            let rig = SurfaceRig()
            rig.screen.front()
            rig.machine.receive(Fx.action())
            rig.press(Fx.tab())
            rig.machine.taskProgress(Fx.progress("offer-5", .handoff, step: 2, steps: 3))
            XCTAssertEqual(rig.machine.lineText, "Your turn in Sheet Fixture")
            rig.machine.skillOffer(try Self.offer("keep"))
            XCTAssertNotNil(rig.arbiter.snapshot().current)
            return rig
        }
        let tab = try handedOff()
        tab.press(Fx.tab())
        XCTAssertEqual(tab.sent.last, "skill accept skill-offer-1")
        XCTAssertNotNil(tab.arbiter.snapshot().statusLine, "the hand-off line stays")
        let esc = try handedOff()
        esc.press(Fx.esc())
        XCTAssertEqual(esc.sent.last, "skill decline skill-offer-1")
        XCTAssertNil(esc.machine.lineText)
        XCTAssertNil(esc.arbiter.snapshot().statusLine)
    }

    /// The question makes the panel taller, so it is placed again around the run's field rather than
    /// grown where it stood.
    func testTheTallerPanelIsPlacedAgainAroundTheField() throws {
        let rig = doneRun()
        rig.takeLog()
        rig.machine.skillOffer(try Self.offer("keep"))
        XCTAssertEqual(rig.takeLog(), ["panel redraw Done, in Sheet Fixture"])
    }

    func testARunWithNoTabDoesNotTakeThePanelFromOtherWork() {
        let rig = runningOnItsOwn()
        rig.machine.receive(Fx.action())
        rig.press(Fx.tab())
        XCTAssertEqual(rig.machine.workingOn, "offer-5")
        rig.machine.taskProgress(Self.unprompted(.verified, step: 1))
        XCTAssertEqual(rig.machine.workingOn, "offer-5", "a run already drawn once is not drawn again")
        let busy = SurfaceRig()
        busy.screen.front()
        busy.machine.receive(Fx.action())
        busy.press(Fx.tab())
        busy.machine.activity(Self.record())
        busy.machine.taskProgress(Self.unprompted(.started))
        XCTAssertEqual(busy.machine.workingOn, "offer-5", "Tab'd work keeps the panel")
        XCTAssertTrue(busy.counts.contains("surface.unprompted.workRunning"))
    }

    func testARunInAnotherWindowOfTheSameAppIsNotDrawnAtThisCaret() {
        let rig = SurfaceRig()
        rig.screen.front()
        rig.machine.activity(Self.record(window: "Order queue"))
        rig.machine.taskProgress(Self.unprompted(.started))
        XCTAssertNil(rig.machine.workingOn)
        XCTAssertTrue(rig.counts.contains("surface.unprompted.otherWindow"))
    }

    func testTheInboundDecoderRoutesSkillOffersAndIgnoresEchoedAnswers() throws {
        guard case .skillOffer(let o) = try HelperInbound.decode(Self.goldenLine("skillOffer", containing: "keep")) else { return XCTFail("not routed") }
        XCTAssertEqual(o.id, "skill-offer-1")
        XCTAssertEqual(try HelperInbound.decode(Self.goldenLine("skillAnswer", containing: "skill-offer-1")), .notForConsumer(type: "skillAnswer"))
    }

    // MARK: - A run with no Tab

    static func record(_ id: String = "offer-15", says: String = "Subject and To into Mail Fixture", state: String = "running", window: String = "Contact details") -> TaskRecord {
        let json = #"{"id":"\#(id)","kind":"plan","state":"\#(state)","cause":null,"says":"\#(says)","app":{"pid":\#(Fx.app),"bundleId":"dev.caret.fixture","name":"Caret Fixture"},"windowId":"5150-1","windowTitle":"\#(window)","frame":[100,100,600,400],"step":0,"steps":3,"stepSays":null,"remaining":[],"detail":null,"undoable":false,"startedAt":1,"updatedAt":2,"pending":null}"#
        return try! JSONDecoder().decode(TaskRecord.self, from: Data(json.utf8))
    }

    static func unprompted(_ phase: TaskProgress.Phase, step: Int? = nil, written: Int? = nil, reason: TaskProgress.StopReason? = nil) -> TaskProgress {
        let extra = (written.map { ",\"written\":\($0)" } ?? "") + (reason.map { ",\"stopReason\":\"\($0.rawValue)\"" } ?? "")
        let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"offer-15","planId":"offer-15","phase":"\#(phase.rawValue)","step":\#(step.map(String.init) ?? "null"),"steps":3,"says":null,"detail":null\#(extra),"unprompted":true}"#
        return try! JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
    }

    /// The fixture in front with a field focused; the run's first progress, then its record.
    private func runningOnItsOwn() -> SurfaceRig {
        let rig = SurfaceRig()
        rig.screen.front()
        rig.machine.taskProgress(Self.unprompted(.started))
        XCTAssertNil(rig.machine.workingOn, "not drawn before its record says where it acts")
        rig.machine.activity(Self.record())
        return rig
    }

    func testARunWithNoTabIsDrawnWhereTheUserIsAndNamesTheSkill() {
        let rig = runningOnItsOwn()
        XCTAssertEqual(rig.machine.workingOn, "offer-15")
        XCTAssertEqual(rig.machine.debugInfo().unprompted, true)
        XCTAssertEqual(rig.machine.lineText, "On its own: Subject and To into Mail Fixture")
        guard case .line(let drawn)? = rig.panels.last else { return XCTFail("no line") }
        XCTAssertEqual(drawn.hints, [Hint(key: "Esc", label: "Take over")])
        XCTAssertEqual(drawn.figure, .working)
        XCTAssertTrue(rig.takeLog().contains { $0.hasPrefix("panel enter") }, "drawn at the field, entering")
    }

    func testEscTakesOverAtOnceAndTheHelpersPauseConfirmsIt() {
        let rig = runningOnItsOwn()
        rig.machine.taskProgress(Self.unprompted(.verified, step: 0))
        rig.clock.advance(by: 0.4)
        rig.press(Fx.esc())
        XCTAssertEqual(rig.sent, ["takeOver offer-15"], "one key, well before the 3 s a Tab'd run needs")
        XCTAssertEqual(rig.machine.lineText, "You took over before step 2 of 3")
        rig.clock.advance(by: 4)
        XCTAssertEqual(rig.machine.lineText, "You took over before step 2 of 3", "waits for the helper's pause")
        rig.machine.taskProgress(Self.unprompted(.paused, step: 1))
        rig.clock.advance(by: SurfaceMachine.stoppedLineLifetime)
        XCTAssertNil(rig.machine.lineText)
    }

    func testADoneRunWithNoTabEndsOnAToastNamingTheSkillWithLongerUndo() {
        let rig = runningOnItsOwn()
        rig.machine.taskProgress(Self.unprompted(.done, written: 3))
        XCTAssertEqual(rig.machine.toastInfo?.caption, "Done on its own: Subject and To into Mail Fixture")
        rig.clock.advance(by: SurfaceMachine.unpromptedToastLifetime - 0.5)
        XCTAssertTrue(undoOwned(rig))
        rig.press(Fx.cmdZ())
        XCTAssertEqual(rig.sent, ["undo offer-15"])
    }

    func testARunInAnAppBehindIsLeftToThePerch() {
        let rig = SurfaceRig()
        rig.screen.behind()
        rig.machine.activity(Self.record())
        rig.machine.taskProgress(Self.unprompted(.started))
        XCTAssertNil(rig.machine.workingOn)
        XCTAssertTrue(rig.counts.contains("surface.unprompted.offCaret"))
        XCTAssertEqual(rig.screen.fieldReads, [], "an app behind is never read")
        rig.screen.front()
        rig.machine.taskProgress(Self.unprompted(.acting, step: 1))
        XCTAssertEqual(rig.machine.workingOn, "offer-15", "the next progress tries again")
    }

    func testARunThatEndsBeforeItsRecordIsNeverDrawn() {
        let rig = SurfaceRig()
        rig.screen.front()
        rig.machine.taskProgress(Self.unprompted(.started))
        rig.machine.taskProgress(Self.unprompted(.done, written: 1))
        rig.machine.activity(Self.record(state: "done"))
        XCTAssertNil(rig.machine.workingOn)
        XCTAssertNil(rig.machine.lineText)
    }

    /// A Tab'd run's working line still takes Esc only after 3 s.
    func testATabbedRunStillWaitsThreeSecondsForEsc() {
        XCTAssertEqual(StatusLine(pid: 1, kind: .working(startedAt: Date())).surface(at: Date()), .working(stoppable: false))
        XCTAssertEqual(StatusLine(pid: 1, kind: .working(startedAt: Date()), takesOverAtOnce: true).surface(at: Date()), .working(stoppable: true))
    }
}
