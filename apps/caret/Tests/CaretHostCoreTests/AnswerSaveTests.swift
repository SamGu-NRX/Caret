@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// H11, saved answers on the host: the quiet offer to keep an answer (only ⌘1 says yes, Tab never does, Esc
/// dismisses, another offer is never displaced), an answer shown whole before it is written, and the desk
/// handing a page goal to the panel at the form.
final class AnswerSaveTests: XCTestCase {
    static let chrome: Int32 = 4100

    static func offer() throws -> AnswerSaveOffer {
        let line = try XCTUnwrap(try WireH11Tests.lines("answers").first { (try? WireH11Tests.object($0)["type"] as? String) == AnswerSaveOffer.type })
        return try JSONDecoder().decode(AnswerSaveOffer.self, from: line)
    }

    static func focus(windowId: String = "page-eng1-7", frame: String = "[10,320,400,30]") throws -> PageField {
        let json = #"{"type":"pageField","v":1,"at":1,"app":{"pid":4100,"bundleId":"com.google.Chrome","name":"Google Chrome"},"windowId":"\#(windowId)","title":"Apply","key":"form/textbox:next~0","role":"AXTextField","editable":true,"empty":true,"frame":\#(frame)}"#
        return try JSONDecoder().decode(PageField.self, from: Data(json.utf8))
    }

    static func reply(_ index: Int) throws -> AnswerSaveReply {
        let lines = try WireH11Tests.lines("answers").filter { (try? WireH11Tests.object($0)["type"] as? String) == AnswerSaveReply.type }
        return try JSONDecoder().decode(AnswerSaveReply.self, from: lines[index])
    }

    final class Rig {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let machine: AnswerSaveMachine
        var commands: [AnswerSaveMachine.Command] = []

        init() {
            machine = AnswerSaveMachine(arbiter: arbiter, clock: clock)
            machine.output = { [unowned self] in self.commands.append($0) }
        }

        var saves: [AnswerSave] { commands.compactMap { if case .send(let s) = $0 { return s } else { return nil } } }
        var lastLine: LineContent? {
            for c in commands.reversed() { if case .draw(let l, _, _, _) = c { return l } }
            return nil
        }
        var hidden: Bool { if case .hide = commands.last { return true } else { return false } }

        func press(_ key: KeyStroke) {
            switch arbiter.handleKeyDown(key, now: clock.now) {
            case .consume(let claim): machine.claimed(claim)
            case .closeOffer(let id):
                machine.offerClosed(id)
                machine.offerChanged(.closed)
            case .pass(let reason): machine.offerChanged(reason)
            default: break
            }
        }
    }

    func testOnlyCommandOneSavesAndTabPassesToThePage() throws {
        let r = Rig()
        let o = try Self.offer()
        r.machine.receive(o, focus: try Self.focus())
        XCTAssertEqual(r.lastLine?.text, "Save this answer for next time?")
        XCTAssertEqual(r.lastLine?.hints, [Hint(key: "⌘1", label: "Save"), Hint(key: "Esc")])
        // Tab moves to the next field, as it would with nothing shown, and saves nothing.
        let tab = r.arbiter.handleKeyDown(.tab(to: Self.chrome), now: r.clock.now)
        XCTAssertEqual(tab, .pass(.dismissed))
        r.machine.offerChanged(.dismissed)
        XCTAssertEqual(r.saves, [])
        XCTAssertTrue(r.hidden)
    }

    func testCommandOneSendsTheUsersYesAndShowsTheHelpersAnswer() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), focus: try Self.focus())
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.chrome))
        XCTAssertEqual(r.saves.count, 1)
        // ⌘1's change is drawn at once.
        if case .draw(_, _, _, let keyed) = r.commands.last { XCTAssertTrue(keyed) } else { XCTFail("no draw") }
        XCTAssertEqual(r.saves.first?.from, .offer(offerId: "answer-offer-1"))
        XCTAssertEqual(r.lastLine, AnswerSaveCopy.saving)
        var saved = try Self.reply(0)
        saved.requestId = try XCTUnwrap(r.saves.first?.requestId)
        r.machine.receive(saved)
        XCTAssertEqual(r.lastLine?.lead, "Saved")
        XCTAssertEqual(r.lastLine?.text, "your answer to \"What has been your proudest accomplishment?\".")
        r.clock.advance(by: AnswerSaveMachine.replyLifetime)
        XCTAssertTrue(r.hidden)
    }

    func testARefusalIsTheHelpersSentence() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), focus: try Self.focus())
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.chrome))
        var refused = try Self.reply(1)
        refused.requestId = try XCTUnwrap(r.saves.first?.requestId)
        r.machine.receive(refused)
        XCTAssertEqual(r.lastLine?.text, "You pasted some of this text, so Caret can't tell the words are yours.")
        // A refusal stays as an error line does; a confirmation goes sooner.
        r.clock.advance(by: AnswerSaveMachine.replyLifetime)
        XCTAssertFalse(r.hidden)
        r.clock.advance(by: AnswerSaveMachine.failureLifetime - AnswerSaveMachine.replyLifetime)
        XCTAssertTrue(r.hidden)
    }

    func testEscDismissesItAtOnceAndNothingIsSaved() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), focus: try Self.focus())
        r.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.chrome))
        XCTAssertTrue(r.hidden)
        if case .hide(let fade) = r.commands.last { XCTAssertEqual(fade, 0) }
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.chrome))
        XCTAssertEqual(r.saves, [])
    }

    func testItNeverTakesTheBrowserFromAnotherOffer() throws {
        let r = Rig()
        let target = TargetIdentity(pid: Self.chrome, bundleID: "com.google.Chrome", windowID: "page-eng1-7", elementID: "f", elementRevision: "")
        XCTAssertNotNil(r.arbiter.publish(Offer(text: "Robin", target: target, fieldValue: "", caretUTF16: 0)))
        r.machine.receive(try Self.offer(), focus: try Self.focus())
        XCTAssertNil(r.lastLine)
        XCTAssertEqual(r.arbiter.snapshot().current?.text, "Robin")
    }

    func testWithNoFieldInThatPageItIsNotShown() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), focus: try Self.focus(windowId: "page-other-1"))
        r.machine.receive(try Self.offer(), focus: nil)
        XCTAssertNil(r.lastLine)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testItLeavesAfterItsTime() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), focus: try Self.focus())
        r.clock.advance(by: AnswerSaveMachine.lifetime)
        XCTAssertTrue(r.hidden)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    // MARK: - Shown whole before it is written

    func testASavedAnswerIsNeverOfferedAsGhostTextOrCountedForCommandOne() throws {
        let line = try XCTUnwrap(try WireH11Tests.lines("answers").first { (try? WireH11Tests.object($0)["type"] as? String) == "fillProposal" })
        let proposal = try JSONDecoder().decode(FillProposal.self, from: line)
        let frame = try XCTUnwrap(proposal.fields.first?.frame)
        XCTAssertEqual(FillSelection.select(proposal, focusedFrame: frame, focusedValue: "", secure: false), .skip(.savedAnswer))
        XCTAssertEqual(FillSelection.fillAllWrites(proposal), 0)
    }

    func testThePopUpThatWritesAnAnswerCarriesItWhole() throws {
        let line = try XCTUnwrap(try WireH11Tests.lines("answers").first { (try? WireH11Tests.object($0)["type"] as? String) == "popup" })
        guard case .popup(let popup) = try HelperInbound.decode(line) else { return XCTFail("not a pop-up") }
        XCTAssertTrue(popup.spec.carriesSavedAnswer)
        let rows = popup.spec.blocks.flatMap { b -> [PopupSpec.Fields.Row] in if case .fields(let f) = b.content { return f.rows } else { return [] } }
        let answer = try XCTUnwrap(rows.first { $0.value.map(SavedAnswers.isSavedAnswer) ?? false })
        XCTAssertTrue(answer.value?.text.hasSuffix("The job now takes eleven minutes.") ?? false, "the whole answer, both paragraphs")
        // A pop-up that writes one never shrinks to a line whose Tab takes it unseen.
        let offer = Offer(text: "", source: .helper, kind: .popup(PopupOffer(offerKey: popup.offerKey, spec: popup.spec)),
                          target: TargetIdentity(pid: 4100, bundleID: "", windowID: "", elementID: "", elementRevision: ""), fieldValue: "", caretUTF16: 0)
        XCTAssertNil(SurfaceMachine.compactContent(for: offer, ui: OfferUI()))
    }

    // MARK: - The desk hands a page goal to the form

    func testTheDeskSaysPreviewAtTheFormAndStepsAside() throws {
        let clock = ManualClock()
        let ask = AskCaret(clock: clock)
        var sent: [AskCaret.Send] = []
        ask.send = { sent.append($0); return true }
        ask.linkChanged(true)
        var stepsAside = 0
        ask.onAtForm = { stepsAside += 1 }
        ask.edit("fill out this form from my note")
        XCTAssertTrue(ask.submit())
        guard case .plan(let request)? = sent.last else { return XCTFail("nothing sent") }
        let g = try PageTaskTests.Golden()
        guard case .segment(let p) = g.first[0].event else { return XCTFail() }
        let reply = GoalProgress(at: 1, goalId: "goal-2-a1", requestId: request.requestId, event: .segment(p))
        var handed: [GoalProgress] = []
        XCTAssertTrue(ask.receive(reply, toForm: { handed.append($0); return true }))
        XCTAssertEqual(handed, [reply])
        XCTAssertEqual(ask.phase, .atForm)
        XCTAssertEqual(ask.debugInfo.line, "Preview at the form")
        XCTAssertEqual(stepsAside, 1)
        // Tab in the desk while it says so: it gets out of the way, and sends nothing.
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(stepsAside, 2)
        XCTAssertEqual(sent.count, 1)
    }

    func testAPagesStopFromTheDeskIsTheHelpersWords() throws {
        let ask = AskCaret(clock: ManualClock())
        var sent: [AskCaret.Send] = []
        ask.send = { sent.append($0); return true }
        ask.linkChanged(true)
        ask.edit("fill out this form from my note")
        ask.submit()
        guard case .plan(let request)? = sent.last else { return XCTFail("nothing sent") }
        let g = try PageTaskTests.Golden()
        guard case .stopped(let stop) = g.refused.event else { return XCTFail() }
        let reply = GoalProgress(at: 1, goalId: "goal-3-a2", requestId: request.requestId, event: .stopped(stop))
        XCTAssertTrue(ask.receive(reply, toForm: { _ in XCTFail("a stop is not a preview"); return true }))
        XCTAssertEqual(ask.phase, .failed("Caret's model account is out of credits, so Caret can't do this. Add credits, then try again."))
    }

    func testAGoalThatAnswersAnotherRequestIsNotTheDesks() throws {
        let ask = AskCaret(clock: ManualClock())
        ask.send = { _ in true }
        ask.linkChanged(true)
        let g = try PageTaskTests.Golden()
        XCTAssertFalse(ask.receive(g.first[0], toForm: { _ in true }))
        XCTAssertEqual(ask.phase, .idle)
    }
}
