import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// helper/fixtures/golden/protocol.ndjson: B16's planRequest, its proposal (one write and a Send
/// left to the user) and a refused plan (untracedValue), written against the helper's zod schema.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func golden(_ type: String, _ index: Int = 0) throws -> Data {
    let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    let matching = lines.filter { (try? JSONSerialization.jsonObject(with: $0) as? [String: Any])?["type"] as? String == type }
    guard matching.indices.contains(index) else { throw XCTSkip("golden file has no \(type) #\(index)") }
    return matching[index]
}

/// The golden proposal, answering the request this test sent (its request id rewritten).
private func goldenProposal(answering id: String, error: Bool = false) throws -> PlanProposal {
    var p = try JSONDecoder().decode(PlanProposal.self, from: golden(PlanProposal.type, error ? 1 : 0))
    p.requestId = id
    return p
}

private func progress(_ task: String, _ phase: TaskProgress.Phase, step: Int?, steps: Int = 2, reason: TaskProgress.StopReason? = nil, blocked: String? = nil) -> TaskProgress {
    let why = reason.map { #","stopReason":"\#($0.rawValue)""# } ?? ""
    let block = blocked.map { #","blocked":"\#($0)""# } ?? ""
    let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"\#(task)","planId":"p","phase":"\#(phase.rawValue)","step":\#(step.map(String.init) ?? "null"),"steps":\#(steps),"says":null,"detail":null\#(why)\#(block)}"#
    return try! JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
}

final class AskCaretTests: XCTestCase {
    private var clock: ManualClock!
    private var ask: AskCaret!
    private var sent: [AskCaret.Send] = []
    private var connected = true

    override func setUp() {
        clock = ManualClock()
        ask = AskCaret(clock: clock)
        sent = []
        connected = true
        ask.send = { [unowned self] message in
            sent.append(message)
            return connected
        }
        ask.linkChanged(true)
    }

    private func asked() throws -> String {
        guard case .plan(let request)? = sent.last else { throw XCTSkip("no planRequest sent") }
        return request.requestId
    }

    /// Typed, Return, and the golden proposal back: the card the user sees.
    private func proposed() throws -> AskCaret.Card {
        ask.edit("Put the order number in Reference and send it")
        XCTAssertTrue(ask.submit())
        ask.receive(try goldenProposal(answering: asked()))
        guard case .proposed(let card) = ask.phase else { throw XCTSkip("no card: \(ask.phase)") }
        return card
    }

    // MARK: - Asking

    func testReturnSendsTheInstructionAsAPlanRequest() throws {
        ask.edit("  Put the order number in Reference  ")
        XCTAssertTrue(ask.submit())
        guard case .plan(let request)? = sent.last else { return XCTFail("nothing sent") }
        XCTAssertEqual(request.instruction, "Put the order number in Reference", "sent trimmed")
        XCTAssertNil(request.windowId, "the host does not know the reader's window ids, so the helper picks")
        XCTAssertEqual(ask.phase, .asking(requestId: request.requestId))
        let line = try NDJSON.line(request)
        XCTAssertNoThrow(try JSONDecoder().decode(PlanRequest.self, from: line), "the line decodes as the helper's schema does")
    }

    func testAnEmptyFieldSendsNothing() {
        ask.edit("   ")
        XCTAssertFalse(ask.submit())
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(ask.phase, .idle)
    }

    func testWithNoHelperTheFieldSaysSoAtOnce() {
        connected = false
        ask.edit("Set Name to Priya Raman")
        XCTAssertTrue(ask.submit())
        XCTAssertEqual(ask.phase, .failed("My helper isn't running, so I can't plan that."))
    }

    func testNoAnswerIn30SecondsEndsTheWait() throws {
        ask.edit("Set Name to Priya Raman")
        ask.submit()
        clock.advance(by: 29.9)
        XCTAssertEqual(ask.phase, .asking(requestId: try asked()))
        clock.advance(by: 0.2)
        XCTAssertEqual(ask.phase, .failed(AskCopy.noAnswer))
    }

    func testAnAnswerToAnotherRequestOrAfterEditingIsIgnored() throws {
        ask.edit("Set Name to Priya Raman")
        ask.submit()
        let id = try asked()
        ask.receive(try goldenProposal(answering: "someone-else"))
        XCTAssertEqual(ask.phase, .asking(requestId: id), "another asker's answer")
        ask.edit("Set Name to Dana")
        XCTAssertEqual(ask.phase, .idle, "typing again drops the wait")
        ask.receive(try goldenProposal(answering: id))
        XCTAssertEqual(ask.phase, .idle, "the late answer is not shown")
    }

    func testAnInstructionOverTheHelpersLimitIsRefusedHere() {
        ask.edit(String(repeating: "a", count: 501))
        XCTAssertTrue(ask.submit())
        XCTAssertTrue(sent.isEmpty, "the helper would refuse it")
        XCTAssertEqual(ask.phase, .failed(AskCopy.tooLong))
    }

    // MARK: - The card

    func testTheGoldenProposalIsACardWithTheSendLeftToTheUser() throws {
        let card = try proposed()
        XCTAssertEqual(card.title, "1 field in 'Caret Fixture — Executor'")
        XCTAssertEqual(card.steps, [
            AskCaret.Step(text: "Put \u{201C}ORD-2026-48213\u{201D} in Reference"),
            AskCaret.Step(text: "Press Send", yours: true),
        ])
        XCTAssertEqual(card.action, "Fill 1 field")
        XCTAssertEqual(card.actionId, "run")
        XCTAssertEqual(card.offerKey, "plan-1-ask-1")
        XCTAssertEqual(card.app, "Caret Fixture")
        XCTAssertEqual(card.press, "Send")
        XCTAssertEqual(card.writes, 1)
    }

    func testEscDismissesTheCardAndTabThenDoesNothing() throws {
        _ = try proposed()
        XCTAssertTrue(ask.escape())
        XCTAssertEqual(ask.phase, .idle)
        let before = sent.count
        XCTAssertFalse(ask.tab(), "no card: Tab is the field's")
        XCTAssertEqual(sent.count, before)
        XCTAssertFalse(ask.text.isEmpty, "the instruction stays to edit")
        XCTAssertTrue(ask.escape(), "then Esc empties the field")
        XCTAssertEqual(ask.text, "")
        XCTAssertFalse(ask.escape(), "then the list closes")
    }

    func testTypingReplacesTheCard() throws {
        _ = try proposed()
        ask.edit("Set Name to Priya Raman")
        XCTAssertEqual(ask.phase, .idle)
    }

    // MARK: - The run

    func testTabSendsOfferAcceptAndTheProgressMarksTheSteps() throws {
        let card = try proposed()
        XCTAssertTrue(ask.tab())
        guard case .accept(let accept)? = sent.last else { return XCTFail("no offerAccept") }
        XCTAssertEqual([accept.offerId, accept.actionId], ["plan-1-ask-1", "run"])
        XCTAssertEqual(accept.overrides, [:])
        XCTAssertEqual(ask.text, "", "the next instruction starts empty")
        guard case .running(let first) = ask.phase else { return XCTFail("not running") }
        XCTAssertEqual(first.steps.map(\.state), [.running, .pending])

        ask.receive(progress(card.offerKey, .acting, step: 0))
        ask.receive(progress(card.offerKey, .verified, step: 0))
        guard case .running(let mid) = ask.phase else { return XCTFail("not running") }
        XCTAssertEqual(mid.steps.map(\.state), [.done, .pending], "the user's own step never runs")
        ask.receive(progress("another-task", .done, step: nil))
        XCTAssertEqual(ask.phase, .running(mid), "another task's progress")

        ask.receive(progress(card.offerKey, .handoff, step: 1))
        guard case .ended(let ended, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(ended.steps.map(\.state), [.done, .pending])
        XCTAssertEqual(line.text, "Filled 1 field. Your turn: press Send in Caret Fixture")
        XCTAssertEqual(line.content.figure, .needsYou)
        XCTAssertFalse(sent.contains { if case .stop = $0 { return true } else { return false } }, "Caret never presses Send or stops on its own")
    }

    func testAPlanWithNoHandOffEndsDone() throws {
        var p = try goldenProposal(answering: "x")
        p.handoff = nil
        let card = try XCTUnwrap(AskCaret.card(p))
        XCTAssertEqual(card.steps.map(\.yours), [false])
        ask.edit("Put the order number in Reference")
        ask.submit()
        p.requestId = try asked()
        ask.receive(p)
        ask.tab()
        ask.receive(progress(card.offerKey, .done, step: nil, steps: 1))
        guard case .ended(let ended, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(ended.steps.map(\.state), [.done])
        XCTAssertEqual(line.text, "Done, in Caret Fixture")
    }

    func testEscStopsTheRunAndSaysYouStoppedIt() throws {
        let card = try proposed()
        ask.tab()
        ask.receive(progress(card.offerKey, .verified, step: 0))
        XCTAssertTrue(ask.escape())
        guard case .stop(let stop)? = sent.last else { return XCTFail("no offerStop") }
        XCTAssertEqual(stop.offerId, card.offerKey)
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line.text, "You stopped it before step 2 of 2")
        // The helper's own stop names the step it stopped before; a later progress changes nothing.
        ask.receive(progress(card.offerKey, .stopped, step: 1, steps: 2, reason: .you))
        guard case .ended(_, let same) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(same.text, "You stopped it before step 2 of 2")
        ask.receive(progress(card.offerKey, .verified, step: 1, steps: 2))
        guard case .running = ask.phase else { return XCTFail("a run continued from the list moves the same card") }
    }

    func testTheHelpersStopSaysWhatStoppedIt() throws {
        let card = try proposed()
        ask.tab()
        ask.receive(progress(card.offerKey, .acting, step: 0))
        ask.receive(progress(card.offerKey, .stopped, step: 0, steps: 2, reason: .windowGone))
        guard case .ended(let ended, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line.text, "Stopped before step 1 of 2: the window closed or wasn't found")
        XCTAssertEqual(ended.steps.map(\.state), [.failed, .pending])
    }

    func testRealInputPausesTheRunAndTheListCarriesIt() throws {
        let card = try proposed()
        ask.tab()
        ask.receive(progress(card.offerKey, .paused, step: 0))
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line.text, "Paused because you worked in Caret Fixture. Continue it from the list below.")
    }

    /// Losing the helper says nothing about how far its run got (review A13, finding 2): the line
    /// claims neither "nothing was done" nor a stop.
    func testTheHelperGoingAwayDuringARunClaimsNothing() throws {
        _ = try proposed()
        ask.tab()
        ask.linkChanged(false)
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line, AskCopy.lostTouch)
    }

    func testAStopThatCouldNotBeSentClaimsNoStop() throws {
        _ = try proposed()
        ask.tab()
        connected = false
        XCTAssertTrue(ask.escape())
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line, AskCopy.lostTouch)
    }

    func testAStopWhoseAnswerNeverCameIsNotLeftAsStopped() throws {
        _ = try proposed()
        ask.tab()
        ask.escape()
        ask.linkChanged(false)
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line, AskCopy.lostTouch)
    }

    func testAProposalGoesWithItsHelperOrItsWithdrawal() throws {
        let card = try proposed()
        ask.withdrawn(OfferWithdrawn(at: 1, id: "someone-elses", reason: .expired))
        XCTAssertEqual(ask.phase, .proposed(card), "another offer's withdrawal")
        ask.withdrawn(OfferWithdrawn(at: 1, id: card.offerKey, reason: .expired))
        XCTAssertEqual(ask.phase, .failed("That plan expired before it ran. Ask again."))
        XCTAssertFalse(ask.tab(), "Tab no longer sends the dead key")
        _ = try proposed()
        ask.linkChanged(false)
        XCTAssertEqual(ask.phase, .failed(AskCopy.planGone))
    }

    func testTheRunsOwnTakenWithdrawalLeavesItsCard() throws {
        let card = try proposed()
        ask.tab()
        ask.withdrawn(OfferWithdrawn(at: 1, id: card.offerKey, reason: .taken))
        if case .running = ask.phase {} else { XCTFail("still running: \(ask.phase)") }
    }

    /// Paused by real input, continued from the activity list, undone there: the same card follows.
    func testTheCardFollowsItsTaskThroughPauseResumeAndUndo() throws {
        let card = try proposed()
        ask.tab()
        ask.receive(progress(card.offerKey, .paused, step: 0))
        if case .ended = ask.phase {} else { return XCTFail("paused shows its line") }
        ask.receive(progress(card.offerKey, .acting, step: 0))
        guard case .running(let resumed) = ask.phase else { return XCTFail("continued: running again") }
        XCTAssertEqual(resumed.steps.map(\.state), [.running, .pending])
        ask.receive(progress(card.offerKey, .verified, step: 0))
        ask.receive(progress(card.offerKey, .handoff, step: 1))
        let undone = try JSONDecoder().decode(TaskProgress.self, from: Data(#"{"type":"taskProgress","v":1,"at":1,"taskId":"plan-1-ask-1","planId":"p","phase":"undone","step":null,"steps":2,"says":null,"detail":null,"restored":1,"notRestored":0}"#.utf8))
        ask.receive(undone)
        guard case .ended(let after, let line) = ask.phase else { return XCTFail("undone: ended") }
        XCTAssertEqual(line.text, "Cleared 1 field")
        XCTAssertEqual(after.steps.map(\.state), [.pending, .pending])
        ask.escape()
        ask.receive(progress(card.offerKey, .acting, step: 0))
        XCTAssertEqual(ask.phase, .idle, "a card put away follows nothing")
    }

    func testTabWithNoHelperSaysNothingRan() throws {
        _ = try proposed()
        connected = false
        XCTAssertTrue(ask.tab())
        guard case .ended(_, let line) = ask.phase else { return XCTFail("not ended") }
        XCTAssertEqual(line.text, Captions.acceptUnsent)
    }

    func testAReturnWhileARunGoesOnIsRefused() throws {
        _ = try proposed()
        ask.tab()
        ask.edit("Set Name to Priya Raman")
        XCTAssertFalse(ask.submit())
        if case .running = ask.phase {} else { XCTFail("the run's card stays") }
    }

    // MARK: - Why there is no plan

    func testTheGoldenRefusalNamesTheValueItCouldNotFind() throws {
        ask.edit("Put ORD-2026-99999 in Reference")
        ask.submit()
        ask.receive(try goldenProposal(answering: asked(), error: true))
        XCTAssertEqual(ask.phase, .failed("I couldn't find \u{201C}ORD-2026-99999\u{201D} on screen, in what I remember, or in what you asked."))
    }

    /// One sentence per code; the helper's detail formats (validate.ts, planner.ts) give the value
    /// where they carry one, and any other detail gives the code's sentence alone.
    func testEveryErrorCodeHasAPlainSentence() {
        let codes: [PlanProposal.ErrorCode] = [
            .schema, .noWindow, .unsure, .nothingToDo, .unsupportedStep, .multipleWindows, .unknownWindow, .ambiguousWindow,
            .unknownTarget, .ambiguousTarget, .notEditable, .untracedValue, .stepAfterHandoff, .riskMismatch, .unavailable, .jevFailed, .privacy, .internal,
        ]
        for code in codes {
            let words = AskCopy.planError(PlanProposal.Failure(code: code, detail: "something only the helper reads"))
            XCTAssertFalse(words.isEmpty, code.rawValue)
            XCTAssertFalse(words.contains("Jev") || words.contains("helper's") || words.contains("!") || words.contains("\u{2014}"), "\(code): \(words)")
            XCTAssertTrue(words.hasSuffix("."), "\(code): a sentence")
        }
        func say(_ code: PlanProposal.ErrorCode, _ detail: String) -> String { AskCopy.planError(PlanProposal.Failure(code: code, detail: detail)) }
        XCTAssertEqual(say(.untracedValue, "step 1 ('Reference holds $1,315.50'): '$1,315.50' is not in any window, in memory or in your instruction"),
                       "I couldn't find \u{201C}$1,315.50\u{201D} on screen, in what I remember, or in what you asked.")
        XCTAssertEqual(say(.untracedValue, "something else"), "I couldn't find that value on screen, in what I remember, or in what you asked.")
        XCTAssertEqual(say(.nothingToDo, "'Caret Fixture — Executor' has no field Caret could fill from what is on screen, in memory or in your instruction, and no button"),
                       "I couldn't find anything to fill or press in \u{201C}Caret Fixture — Executor\u{201D}.")
        XCTAssertEqual(say(.notEditable, "step 2 ('Total holds 4'): 'Total' is not a field Caret can write"), "I can't write in \u{201C}Total\u{201D}.")
        XCTAssertEqual(say(.notEditable, "step 2 ('Password holds x'): its target is a password field, which is left to you"), "That's a password field, which I leave to you.")
        XCTAssertEqual(say(.unknownWindow, "step 1 ('Name holds Dana'): no open window matches 'Invoices'"), "I couldn't find a window called \u{201C}Invoices\u{201D}.")
        XCTAssertEqual(say(.unknownWindow, "'Invoices' closed while Caret planned, and another window took its title"), "The window I planned for closed while I planned.")
        // A value holding the prefix's own "'): '" cannot be split surely: no value is named (review A13, finding 8).
        XCTAssertEqual(say(.untracedValue, "step 1 ('Name holds Anna'): 'Bob'): 'Anna'): 'Bob' is not in any window, in memory or in your instruction"),
                       "I couldn't find that value on screen, in what I remember, or in what you asked.")
    }
}

/// The event card's words while the calendar is undecided (brief A13, part 2).
final class EventCardCopyTests: XCTestCase {
    /// The helper's event offer as event-card.ts builds it: the line, and the card ↓ opens.
    static let line = #"""
    {"type":"action","v":1,"offerKey":"event-1","at":1,"field":{"pid":5150,"windowId":"5150-1","key":"k:message","frame":[200,140,260,22],"window":{"number":41,"title":"Contact details"}},"app":"Calendar","endState":{"text":"Coffee with Dana, Thu 3:00 to 3:30 PM","ref":{"rule":"eventCard","derived":[{"node":"5150-1/k:message","quote":"coffee with Dana on Thursday at 3"}]}},"actions":[{"id":"add","label":"Add","key":"tab"}],"variants":{"v":1,"id":"event-1","figure":"offering","blocks":[{"type":"header","title":{"text":"Coffee with Dana","ref":{"rule":"eventTitle","derived":[{"node":"5150-1/k:message","quote":"coffee with Dana on Thursday at 3"}]}}},{"type":"facts","rows":[{"label":"When","value":{"text":"Thu 3:00 to 3:30 PM","ref":{"rule":"eventTime","derived":[{"node":"5150-1/k:message","quote":"coffee with Dana on Thursday at 3"}]}}},{"label":"Calendar","value":{"text":"Caret","ref":{"rule":"eventCalendar","derived":[{"node":"5150-1/k:message","quote":"coffee with Dana on Thursday at 3"}]}}}]},{"type":"source","value":{"text":"I'll grab coffee with Dana on Thursday at 3.","ref":{"node":"5150-1/k:message","quote":"coffee with Dana on Thursday at 3"}}},{"type":"actions","items":[{"id":"add","label":"Add","key":"tab"}]}]}}
    """#

    static func offer() throws -> OfferAction {
        guard case .action(let m) = try HelperInbound.decode(Data(line.utf8)) else { throw XCTSkip("not an action") }
        return m
    }

    func testTheCardNamesNoCalendarAndSaysAddToCalendar() throws {
        let m = try Self.offer()
        XCTAssertTrue(EventCardCopy.isEvent(m))
        let card = try XCTUnwrap(ActionLine(m).variants)
        var labels: [String?] = []
        var values: [String] = []
        for block in card.blocks { if case .facts(let f) = block.content { labels += f.rows.map(\.label); values += f.rows.map(\.value.text) } }
        XCTAssertEqual(labels, ["When", nil], "the row naming the helper's calendar is gone; the sentence has no label")
        XCTAssertFalse(values.contains("Caret"))
        XCTAssertEqual(values.last, "\u{201C}I'll grab coffee with Dana on Thursday at 3.\u{201D}", "the sentence, quoted, not as \"from …\"")
        XCTAssertEqual(card.actions.map(\.label), ["Add to calendar"])
        XCTAssertEqual(card.actions.map(\.id), ["add"], "Tab still sends the helper's action")
        XCTAssertEqual(card.header?.title.text, "Coffee with Dana")
        XCTAssertNil(card.sourceText)
    }

    func testOtherActionLinesAreDrawnAsSent() throws {
        let m = try Self.offer()
        var other = m
        other.endState = PopupSpec.Value("Finish the rest", ref: .derived(rule: "loopFinish", from: [.node(key: "n", quote: nil)]))
        XCTAssertFalse(EventCardCopy.isEvent(other))
        XCTAssertEqual(ActionLine(other).variants, m.variants, "only the helper's event card is reworded")
    }

    /// B16's blocked hand-off (golden line 45): no Calendar access. The line says what is missing
    /// and where to give it; Caret never asks for it.
    func testABlockedCalendarStepSaysWhatIsMissing() {
        XCTAssertEqual(Captions.blocked(.tcc), "Nothing was added: Caret needs Calendar access in Privacy & Security.")
        XCTAssertEqual(Captions.blocked(.noLocalSource), "Nothing was added: Caret adds events only to an On My Mac calendar.")
        XCTAssertEqual(OfferLifecycle.ending(of: progress("event-1", .handoff, step: 0, steps: 1, blocked: "tcc"), workKey: "event-1"), .handoff(blocked: .tcc))
    }

    func testTabOnTheEventLineEndsOnTheBlockedLine() throws {
        let offer = HelperOffer.action(try Self.offer())
        play(Transition("the event line taken without Calendar access", [
            .screen { $0.front() },
            .offer(offer),
            .expect(.shown("event-1")),
            .press(Fx.tab()),
            .sent(["accept event-1 add"]),
            .taskLine(progress("event-1", .handoff, step: 0, steps: 1, blocked: "tcc")),
            .expect(.line(Captions.blocked(.tcc))),
        ]))
    }
}

/// Part 3: no clear spot for a panel means its compact line; none for that either means nothing.
final class CompactFallbackTests: XCTestCase {
    private func isPopup(_ c: PanelContent) -> Bool { if case .popup = c { return true } else { return false } }
    private func isLine(_ c: PanelContent) -> Bool { if case .line = c { return true } else { return false } }

    func testAPopUpWithNoClearSpotIsItsCompactLineAndDownOpensTheCard() {
        play(Transition("crowded: only the compact line fits", [
            .screen { $0.front(); $0.clearPanel = { c in if case .compactLine = c { return true } else { return false } } },
            .offer(Fx.fillPopup()),
            .expect(.shown("fill-2")), .expect(.counted("surface.compact.popup")),
            .did(["panel enter compact Fill 2 fields"]),
            .expect(.custom("the compact line names the title, Tab's action and ↓", { rig in
                guard case .compactLine(let line)? = rig.panels.last else { return false }
                return line.text == "Fill 2 fields" && line.hints == [Hint(key: "Tab", label: "Fill all"), CompactOffer.moreHint]
            })),
            .expect(.custom("the arbiter knows it is compact", { $0.arbiter.snapshot().ui.compact })),
            .press(Fx.down()),
            .expect(.custom("↓ opens the full card", { rig in
                guard case .popup? = rig.panels.last else { return false }
                return !rig.arbiter.snapshot().ui.compact
            })),
            .did(["panel redraw Fill 2 fields"]),
            .press(Fx.tab()),
            .sent(["accept fill-2 fillAll"]),
        ]))
    }

    func testTabOnTheCompactLineTakesThePrimaryAction() {
        play(Transition("Tab without opening the card", [
            .screen { $0.front(); $0.clearPanel = { c in if case .compactLine = c { return true } else { return false } } },
            .offer(Fx.fillPopup()),
            .press(Fx.tab()),
            .sent(["accept fill-2 fillAll"]),
        ]))
    }

    func testAnActionLineWithNoClearSpotIsCompact() {
        play(Transition("the 28 pt line covers something; the 20 pt one does not", [
            .screen { $0.front(); $0.clearPanel = { c in if case .compactLine = c { return true } else { return false } } },
            .offer(Fx.action()),
            .expect(.shown("offer-5")), .expect(.counted("surface.compact.action")),
            .did(["panel enter compact Sheet Fixture Finish the rest: 2 more values"]),
            .expect(.custom("no ↓ hint without variants to open", { rig in
                guard case .compactLine(let line)? = rig.panels.last else { return false }
                return !line.hints.contains(CompactOffer.moreHint)
            })),
            .press(Fx.tab()),
            .sent(["accept offer-5 finish"]),
        ]))
    }

    func testWhenEvenTheCompactLineCoversALabelNothingIsDrawn() {
        play(Transition("no clear spot at all", [
            .screen { $0.front(); $0.clearPanel = { _ in false } },
            .offer(Fx.fillPopup()),
            .expect(.shown(nil)), .expect(.held(nil)), .expect(.counted("surface.held.noClearSpot")),
            .expect(.tabTakes(false)), .did([]),
            .press(Fx.tab()), .sent([]),
            .wait(2), .expect(.shown(nil)), .did([]),
        ]))
    }

    func testAClearSpotDrawsTheFullPanelAsBefore() {
        play(Transition("room for the pop-up", [
            .screen { $0.front() },
            .offer(Fx.fillPopup()),
            .did(["panel enter Fill 2 fields"]),
            .expect(.custom("asked once, about the full pop-up", { rig in rig.screen.clearAsked.count == 1 && self.isPopup(rig.screen.clearAsked[0]) })),
            .expect(.custom("not compact", { !$0.arbiter.snapshot().ui.compact })),
        ]))
        play(Transition("alternatives are not panels", [
            .screen { $0.front() },
            .offer(Fx.alternatives()),
            .expect(.custom("never asked", { $0.screen.clearAsked.isEmpty })),
        ]))
    }

    func testAPickerSaysWhichRowTabTakes() {
        let spec = PopupSpec(id: "which", figure: .needsYou, blocks: [
            .init(.header(.init(title: .init("Which Dana?", ref: .memory(id: "m"))))),
            .init(.choices(.init(rows: [.init(label: .init("Dana Reyes", ref: .memory(id: "a"))), .init(label: .init("Dana Kim", ref: .memory(id: "b")))], selected: 1))),
            .init(.actions(.init(items: [.init(id: "choose", label: "Choose", key: .tab)]))),
        ])
        let line = CompactOffer.line(spec, highlight: nil)
        XCTAssertEqual(line.text, "Which Dana? Dana Kim")
        XCTAssertEqual(line.figure, .needsYou)
        XCTAssertEqual(CompactOffer.line(spec, highlight: 0).text, "Which Dana? Dana Reyes")
    }
}
