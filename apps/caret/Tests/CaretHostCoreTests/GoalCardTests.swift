import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Slice 1 on the desk, against `Fixtures/ask-task.ndjson` (the helper's golden copy): the task question decodes and
/// re-encodes; a goal that is not a page's shows on the desk's own card instead of "Caret can't show a plan like that
/// here yet."; Tab sends the segment's acceptance under its digest, ⌘E and Return its edit, Esc puts it away or stops
/// it; receipts mark the rows; the press the user makes is drawn last, never as a row, and says what it sends, to
/// whom and for what.
final class GoalCardTests: XCTestCase {
    private static func lines() throws -> [Data] {
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-task.ndjson")
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private static func goal(_ index: Int, requestId: String? = nil) throws -> GoalProgress {
        var g = try JSONDecoder().decode(GoalProgress.self, from: lines()[index])
        if let requestId { g.requestId = requestId }
        return g
    }

    // MARK: - The wire

    func testEveryAskTaskLineDecodesAndTheHostsLinesAreTheGoldenLines() throws {
        let lines = try Self.lines()
        let kinds = try lines.map { line -> String in
            switch try HelperInbound.decode(line) {
            case .askQuestion(let q): return "question:\(q.part.rawValue)"
            case .goalProgress(let g):
                if case .segment(let p) = g.event { return "segment:\(p.steps.map { $0.tier?.rawValue ?? "-" }.joined(separator: ","))" }
                return "goal"
            case .notForConsumer(let type): return "skip:\(type)"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, ["skip:hello", "skip:planRequest", "question:task", "skip:askAnswer", "segment:write,write,yours", "skip:goalEdit", "segment:write,write,yours", "skip:goalAccept", "segment:write"])
        let q = try JSONDecoder().decode(AskQuestion.self, from: lines[2])
        XCTAssertEqual(try Self.object(JSONEncoder().encode(q)), try Self.object(lines[2]))
        for i in [4, 6, 8] { XCTAssertEqual(try Self.object(JSONEncoder().encode(Self.goal(i))), try Self.object(lines[i]), "line \(i + 1)") }
        XCTAssertEqual(try Self.object(NDJSON.line(JSONDecoder().decode(GoalEdit.self, from: lines[5]))), try Self.object(lines[5]))
        XCTAssertEqual(try Self.object(NDJSON.line(JSONDecoder().decode(GoalAccept.self, from: lines[7]))), try Self.object(lines[7]))
        let hello = try Self.object(lines[0])
        XCTAssertTrue((hello["capabilities"] as? [String])?.contains(AskQuestion.taskCapability) == true)
    }

    func testTheHostNamesAskTaskAsTheHelperSpellsItAndDeclaresIt() throws {
        XCTAssertEqual(AskQuestion.taskCapability, try WireH1Tests.helperConstant("ASK_TASK_CAPABILITY", in: "protocol.ts"))
        XCTAssertEqual(String(AskQuestion.maxTaskLabel), try Self.helperNumber("MAX_TASK_LABEL"))
        XCTAssertEqual(String(AskQuestion.maxTaskSays), try Self.helperNumber("MAX_TASK_SAYS"))
        for routing in [false, true] { XCTAssertTrue(HostHello.capabilities(routing: routing).contains(AskQuestion.taskCapability)) }
    }

    private static func helperNumber(_ name: String) throws -> String {
        let text = try WireH1Tests.helperSource("protocol.ts")
        let start = try XCTUnwrap(text.range(of: "export const \(name) = "))
        return String(text[start.upperBound...].prefix { $0.isNumber })
    }

    func testATaskQuestionTakesTwoReadingsAndBoundedWords() throws {
        let line = String(decoding: try Self.lines()[2], as: UTF8.self)
        XCTAssertNoThrow(try JSONDecoder().decode(AskQuestion.self, from: Data(line.utf8)))
        let one = line.replacingOccurrences(of: #",{"kind":"task","id":"o2","label":"Do the whole task","says":"Shows every step before anything runs. Sending stays yours."}"#, with: "")
        XCTAssertThrowsError(try JSONDecoder().decode(AskQuestion.self, from: Data(one.utf8)), "one reading is no question")
        let long = line.replacingOccurrences(of: "Only fill To and Message", with: String(repeating: "x", count: AskQuestion.maxTaskLabel + 1))
        XCTAssertThrowsError(try JSONDecoder().decode(AskQuestion.self, from: Data(long.utf8)))
        let many = line.replacingOccurrences(of: #""pick":"one""#, with: #""pick":"many""#)
        XCTAssertThrowsError(try JSONDecoder().decode(AskQuestion.self, from: Data(many.utf8)))
    }

    // MARK: - The desk

    private func asked() throws -> (AskCaret, ManualClock, () -> [AskCaret.Send]) {
        let clock = ManualClock()
        let ask = AskCaret(clock: clock)
        var sent: [AskCaret.Send] = []
        ask.send = { sent.append($0); return true }
        ask.linkChanged(true)
        ask.edit("answer dana, thursday at 3 works")
        XCTAssertTrue(ask.submit())
        return (ask, clock, { sent })
    }

    private func showing() throws -> (AskCaret, ManualClock, () -> [AskCaret.Send]) {
        let (ask, clock, sent) = try asked()
        guard case .plan(let request)? = sent().last else { throw XCTSkip("nothing sent") }
        XCTAssertTrue(ask.receive(try Self.goal(4, requestId: request.requestId), toForm: { _ in XCTFail("not a page's"); return false }))
        return (ask, clock, sent)
    }

    private func card(_ ask: AskCaret) throws -> GoalCard {
        guard case .goal(let c) = ask.phase else { throw Unexpected("no goal card: \(ask.phase)") }
        return c
    }

    func testAGoalThatIsNotAPagesShowsOnTheDesksCard() throws {
        let (ask, _, _) = try showing()
        let c = try card(ask)
        XCTAssertEqual(c.stage, .preview)
        XCTAssertEqual(c.listed.map(\.says), ["To: dana.whitfield@example.com", "Message: Thursday at 3 works for me. See you then."])
        XCTAssertEqual(c.listed.map(\.tier), [.write, .write])
        XCTAssertEqual(c.consequential?.says, "'Send' reads as outbound; you press it")
        XCTAssertEqual(GoalCopy.handOff(c), GoalCopy.HandOff(press: "You press Send", sends: "Message", to: "dana.whitfield@example.com", purpose: "\u{201C}answer dana, thursday at 3 works\u{201D}"))
        XCTAssertEqual(GoalCopy.title(c), "Re: Planning review")
        XCTAssertEqual(GoalCopy.eyebrow(c), "Mail · part 1 of 2")
        XCTAssertEqual(GoalCopy.action(c), "Fill 2 fields")
        XCTAssertEqual(ask.debugInfo.phase, "goal")
    }

    func testTabSendsTheSegmentUnderItsDigestOnceAndEscStopsTheRun() throws {
        let (ask, clock, sent) = try showing()
        XCTAssertTrue(ask.tab())
        guard case .goalAccept(let a)? = sent().last else { return XCTFail("no acceptance") }
        XCTAssertEqual(a, GoalAccept(goalId: "goal-4-ask-32", segment: 0, digest: String(repeating: "a", count: 64), at: a.at))
        XCTAssertEqual(ask.text, "", "the instruction is done with")
        XCTAssertEqual(try card(ask).stage, .running)
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(sent().filter { if case .goalAccept = $0 { return true } else { return false } }.count, 1, "a second Tab sends nothing")
        // A receipt marks its row and lights the next.
        XCTAssertTrue(ask.receive(GoalProgress(at: 2, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-4-ask-32:s0", step: 0, steps: 2, phase: .verified, says: "To"))), toForm: { _ in false }))
        XCTAssertEqual(try card(ask).rows.map(\.state), [.done, .running, .pending])
        XCTAssertTrue(ask.escape())
        guard case .control(let stop)? = sent().last else { return XCTFail("no stop") }
        XCTAssertEqual(stop, TaskControl(taskId: "goal-4-ask-32:s0", action: .stop))
        XCTAssertEqual(try card(ask).stage, .stopping)
        // The helper's stop ends the card in its words, before the stop deadline closes the connection.
        XCTAssertTrue(ask.receive(GoalProgress(at: 3, goalId: "goal-4-ask-32", requestId: nil, event: .stopped(.init(segment: 0, step: 1, reason: .you, says: "You stopped it before Message.", freshPlan: nil))), toForm: { _ in false }))
        XCTAssertEqual(try card(ask).stage, .ended(.init(kind: .stopped, line: "You stopped it before Message.")))
        var dropped = 0
        ask.dropSession = { dropped += 1 }
        clock.advance(by: SurfaceMachine.stopConfirmWait + 1)
        XCTAssertEqual(dropped, 0, "the goal's own stop answered the Esc")
    }

    func testEscPutsAPreviewAwayAndKeepsTheInstruction() throws {
        let (ask, _, sent) = try showing()
        let before = sent().count
        XCTAssertTrue(ask.escape())
        XCTAssertEqual(ask.phase, .idle)
        XCTAssertEqual(ask.text, "answer dana, thursday at 3 works")
        XCTAssertEqual(sent().count, before)
    }

    func testCommandEEditsTheDraftAndReturnSendsItAsAGoalEdit() throws {
        let (ask, _, sent) = try showing()
        XCTAssertTrue(ask.editGoal())
        XCTAssertEqual(try card(ask).stage, .editing(step: 1, text: "Thursday at 3 works for me. See you then."))
        XCTAssertFalse(ask.tab() == false, "Tab is taken and does nothing in the edit field")
        XCTAssertFalse(sent().contains { if case .goalAccept = $0 { return true } else { return false } })
        ask.goalDraftChanged("  Thursday at 3 works. I'll bring the Q3 numbers. ")
        XCTAssertTrue(ask.commitGoalEdit())
        guard case .goalEdit(let e)? = sent().last else { return XCTFail("no edit") }
        XCTAssertEqual(e, GoalEdit(goalId: "goal-4-ask-32", segment: 0, digest: String(repeating: "a", count: 64), step: 1, text: "Thursday at 3 works. I'll bring the Q3 numbers.", at: e.at))
        XCTAssertEqual(try card(ask).stage, .editSent(step: 1))
        // The helper's new preview, under a new digest, replaces the rows; the user's words are no draft.
        XCTAssertTrue(ask.receive(try Self.goal(6), toForm: { _ in false }))
        let c = try card(ask)
        XCTAssertEqual(c.stage, .preview)
        XCTAssertEqual(c.digest, String(repeating: "b", count: 64))
        XCTAssertNil(c.editable, "only Caret's draft can be edited")
        XCTAssertFalse(ask.editGoal())
        XCTAssertTrue(ask.tab())
        guard case .goalAccept(let a)? = sent().last else { return XCTFail("no acceptance") }
        XCTAssertEqual(a.digest, String(repeating: "b", count: 64))
    }

    func testEscClosesTheEditAndAnUnchangedDraftSendsNothing() throws {
        let (ask, _, sent) = try showing()
        let before = sent().count
        XCTAssertTrue(ask.editGoal())
        XCTAssertTrue(ask.escape())
        XCTAssertEqual(try card(ask).stage, .preview)
        XCTAssertTrue(ask.editGoal())
        XCTAssertTrue(ask.commitGoalEdit())
        XCTAssertEqual(try card(ask).stage, .preview)
        XCTAssertEqual(sent().count, before)
    }

    func testARefusedEditKeepsTheDraftAndSaysSo() throws {
        let (ask, _, _) = try showing()
        XCTAssertTrue(ask.editGoal())
        ask.goalDraftChanged("Thursday works")
        XCTAssertTrue(ask.commitGoalEdit())
        ask.helperError(HelperError(at: 4, message: "goalEdit refused: the field changed since Caret asked"))
        let c = try card(ask)
        XCTAssertEqual(c.stage, .preview)
        XCTAssertEqual(c.note, GoalCopy.editRefused)
        XCTAssertEqual(c.rows[1].drafted, "Thursday at 3 works for me. See you then.")
    }

    func testThePreviewExpiresWithNoTab() throws {
        let (ask, clock, _) = try showing()
        let c = try card(ask)
        clock.advance(by: Double(c.expires) / 1000 - clock.now.timeIntervalSince1970 + 1)
        XCTAssertEqual(try card(ask).stage, .ended(.init(kind: .notRun, line: PageTaskCopy.expired)))
        XCTAssertFalse(ask.tab() == false)
    }

    func testTheNextSegmentWaitsForItsOwnTabAndCommandZUndoesWhatWrote() throws {
        let (ask, _, sent) = try showing()
        XCTAssertTrue(ask.tab())
        for step in [0, 1] {
            XCTAssertTrue(ask.receive(GoalProgress(at: 2, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-4-ask-32:s0", step: step, steps: 2, phase: .verified, says: "ok"))), toForm: { _ in false }))
        }
        XCTAssertTrue(ask.receive(try Self.goal(8), toForm: { _ in false }))
        var c = try card(ask)
        XCTAssertEqual(c.stage, .preview)
        XCTAssertEqual(c.segment, 1)
        XCTAssertEqual(GoalCopy.action(c), "Add the event")
        XCTAssertEqual(c.warnings, ["Dana's email says 3:00 but not how long; Caret made it an hour."])
        XCTAssertNil(c.consequential)
        XCTAssertTrue(ask.tab())
        guard case .goalAccept(let a)? = sent().last else { return XCTFail() }
        XCTAssertEqual(a.segment, 1)
        XCTAssertTrue(ask.receive(GoalProgress(at: 5, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 1, taskId: "goal-4-ask-32:s1", step: 3, steps: 1, phase: .verified, says: "ok"))), toForm: { _ in false }))
        XCTAssertTrue(ask.receive(GoalProgress(at: 6, goalId: "goal-4-ask-32", requestId: nil, event: .finished(.init(outcome: .done, verified: 3, skipped: 0, left: [], says: "Done."))), toForm: { _ in false }))
        c = try card(ask)
        XCTAssertEqual(c.stage, .ended(.init(kind: .done, line: "Done.")))
        XCTAssertTrue(c.undoable)
        XCTAssertTrue(ask.ownsUndo("goal-4-ask-32:s1"), "the calendar event's task is undone too")
        let before = sent().count
        XCTAssertTrue(ask.undo())
        let undos = sent().dropFirst(before).compactMap { m -> TaskControl? in if case .control(let c) = m { return c } else { return nil } }
        XCTAssertEqual(undos, [TaskControl(taskId: "goal-4-ask-32:s1", action: .undo), TaskControl(taskId: "goal-4-ask-32:s0", action: .undo)], "newest first")
        ask.receive(try Self.undone("goal-4-ask-32:s1", restored: 1, notRestored: 0))
        XCTAssertEqual(try card(ask).stage.kind, .undoing, "one of two answered")
        ask.receive(try Self.undone("goal-4-ask-32:s0", restored: 1, notRestored: 1))
        XCTAssertEqual(try card(ask).stage.kind, .partial, "a change the helper could not put back is said, not hidden")
        XCTAssertEqual(try card(ask).rows.first?.state, .done)
    }

    private static func undone(_ taskId: String, restored: Int?, notRestored: Int?) throws -> TaskProgress {
        let counts = (restored.map { #","restored":\#($0)"# } ?? "") + (notRestored.map { #","notRestored":\#($0)"# } ?? "")
        return try JSONDecoder().decode(TaskProgress.self, from: Data(#"{"type":"taskProgress","v":1,"at":7,"taskId":"\#(taskId)","planId":"p","phase":"undone","step":null,"steps":1,"says":null,"detail":null\#(counts)}"#.utf8))
    }

    func testAnUndoThatSaysNothingOfWhatItPutBackIsNotTakenAsAll() throws {
        let (ask, _, _) = try showing()
        XCTAssertTrue(ask.tab())
        XCTAssertTrue(ask.receive(GoalProgress(at: 2, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-4-ask-32:s0", step: 0, steps: 2, phase: .verified, says: "ok"))), toForm: { _ in false }))
        XCTAssertTrue(ask.receive(GoalProgress(at: 3, goalId: "goal-4-ask-32", requestId: nil, event: .finished(.init(outcome: .handoff, verified: 1, skipped: 0, left: ["You press Send"], says: "Done. Send is yours."))), toForm: { _ in false }))
        XCTAssertTrue(ask.undo())
        ask.receive(try Self.undone("goal-4-ask-32:s0", restored: nil, notRestored: nil))
        XCTAssertEqual(try card(ask).stage.kind, .partial)
    }

    func testClosingTheEditKeepsThePreviewsExpiry() throws {
        let (ask, clock, _) = try showing()
        XCTAssertTrue(ask.editGoal())
        XCTAssertTrue(ask.escape())
        let c = try card(ask)
        clock.advance(by: Double(c.expires) / 1000 - clock.now.timeIntervalSince1970 + 1)
        XCTAssertEqual(try card(ask).stage, .ended(.init(kind: .notRun, line: PageTaskCopy.expired)))
    }

    func testAFreshPlanAfterAStopIsPreviewedOnTheCard() throws {
        let (ask, _, sent) = try showing()
        XCTAssertTrue(ask.tab())
        XCTAssertTrue(ask.receive(GoalProgress(at: 2, goalId: "goal-4-ask-32", requestId: nil, event: .stopped(.init(segment: 0, step: 0, reason: .targetChanged, says: "The To field changed before Caret reached it. Caret made a fresh plan.", freshPlan: "goal-4-ask-32~1"))), toForm: { _ in false }))
        var fresh = try Self.goal(4)
        fresh.goalId = "goal-4-ask-32~1"
        fresh.requestId = nil
        guard case .segment(var p) = fresh.event else { return XCTFail() }
        p.reason = .freshPlan
        p.replaces = "goal-4-ask-32"
        fresh.event = .segment(p)
        XCTAssertTrue(ask.receive(fresh, toForm: { _ in XCTFail("not a page's"); return false }))
        let c = try card(ask)
        XCTAssertEqual(c.goalId, "goal-4-ask-32~1")
        XCTAssertEqual(c.stage, .preview)
        let before = sent().count
        XCTAssertTrue(ask.tab())
        guard case .goalAccept(let a)? = sent().dropFirst(before).first else { return XCTFail("no acceptance of the fresh plan") }
        XCTAssertEqual(a.goalId, "goal-4-ask-32~1")
    }

    func testAPageGoalStillGoesToTheForm() throws {
        let (ask, _, sent) = try asked()
        guard case .plan(let request)? = sent().last else { return XCTFail() }
        let g = try PageTaskTests.Golden()
        guard case .segment(let p) = g.first[0].event else { return XCTFail() }
        var handed = 0
        XCTAssertTrue(ask.receive(GoalProgress(at: 1, goalId: "goal-2-a1", requestId: request.requestId, event: .segment(p)), toForm: { _ in handed += 1; return true }))
        XCTAssertEqual(handed, 1)
        XCTAssertEqual(ask.phase, .atForm)
    }

    // MARK: - Copy

    func testThePressNameAndTheHandOffComeFromTheHelpersWords() {
        XCTAssertEqual(GoalCopy.pressName("'Send' reads as outbound; you press it"), "Send")
        XCTAssertEqual(GoalCopy.pressName("You press Submit Application"), "Submit Application")
        XCTAssertNil(GoalCopy.pressName("The rest is yours"))
        XCTAssertEqual(GoalCopy.split("Message: Thursday at 3: works")?.field, "Message")
        XCTAssertNil(GoalCopy.split("Add 'Planning review' to your Caret calendar, Thursday: 3:00"))
        let h = GoalCopy.HandOff(press: "You press Send", sends: "Message", to: "dana.whitfield@example.com", purpose: "\u{201C}answer dana\u{201D}")
        XCTAssertEqual(GoalCopy.spokenHandOff(h), "You press Send. Caret never presses it. It sends Message to dana.whitfield@example.com. For \u{201C}answer dana\u{201D}.")
    }

    func testAHelperBeforeTiersStillSetsThePressApart() {
        let step = GoalProgress.Step(index: 2, kind: .handoff, says: "You press Send")
        XCTAssertEqual(GoalCard.row(step).tier, .yours)
        XCTAssertEqual(GoalCard.row(GoalProgress.Step(index: 3, kind: .handoff, says: "Caret leaves setting Size to you")).tier, .write)
    }
}

private extension GoalCard.Stage {
    var kind: GoalCard.Ending.Kind? { if case .ended(let e) = self { return e.kind } else { return nil } }
}
