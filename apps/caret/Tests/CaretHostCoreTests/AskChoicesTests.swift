import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// B29's Ask questions and D2-04's fillAll as the host reads and writes them, against
/// `Fixtures/ask-choices.ndjson` and `Fixtures/fill-all.ndjson` (the helper's golden copies).
final class AskChoicesTests: XCTestCase {
    private static func lines(_ name: String) throws -> [Data] {
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("\(name).ndjson")
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private static func question(_ index: Int) throws -> AskQuestion {
        guard case .askQuestion(let q) = try HelperInbound.decode(lines("ask-choices")[index]) else { throw Unexpected("line \(index + 1) is no askQuestion") }
        return q
    }

    // MARK: - The wire

    func testEveryAskChoicesLineDecodesToWhatTheHostDoesWithIt() throws {
        let kinds = try Self.lines("ask-choices").map { line -> String in
            switch try HelperInbound.decode(line) {
            case .askQuestion(let q): return "question:\(q.part.rawValue)"
            case .planProposal(let p): return "plan:\(p.outcome.rawValue)"
            case .notForConsumer(let type): return "skip:\(type)"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, [
            "skip:hello", "skip:planRequest", "question:fields", "skip:askAnswer", "question:source", "skip:askAnswer",
            "plan:proposed", "question:person", "skip:askAnswer", "plan:error",
        ])
        guard case .planProposal(let gone) = try HelperInbound.decode(Self.lines("ask-choices")[9]) else { return XCTFail("line 10") }
        XCTAssertEqual(gone.error?.code, .questionGone)
    }

    /// The host's answers and its fillAll are the golden lines; a question re-encodes to itself.
    func testTheHostsLinesAreTheGoldenLines() throws {
        let ask = try Self.lines("ask-choices")
        for i in [3, 5, 8] {
            let answer = try JSONDecoder().decode(AskAnswer.self, from: ask[i])
            XCTAssertEqual(try Self.object(NDJSON.line(answer)), try Self.object(ask[i]), "ask-choices line \(i + 1)")
        }
        for i in [2, 4, 7] {
            XCTAssertEqual(try Self.object(JSONEncoder().encode(Self.question(i))), try Self.object(ask[i]), "ask-choices line \(i + 1)")
        }
        let fill = try Self.lines("fill-all")
        for i in [2, 6] {
            let request = try JSONDecoder().decode(FillAllRequest.self, from: fill[i])
            XCTAssertEqual(try Self.object(NDJSON.line(request)), try Self.object(fill[i]), "fill-all line \(i + 1)")
        }
    }

    func testEveryFillAllLineDecodes() throws {
        let kinds = try Self.lines("fill-all").map { line -> String in
            switch try HelperInbound.decode(line) {
            case .fillProposal: return "proposal"
            case .taskProgress(let p): return "progress:\(p.phase.rawValue)"
            case .error: return "error"
            case .notForConsumer(let type): return "skip:\(type)"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, [
            "skip:hello", "proposal", "skip:fillAll", "progress:started", "progress:verified", "progress:done",
            "skip:fillAll", "error", "progress:stopped", "skip:taskControl", "progress:undone",
        ])
        guard case .fillProposal(let p) = try HelperInbound.decode(Self.lines("fill-all")[1]) else { return XCTFail("line 2") }
        let shift = try XCTUnwrap(p.fields.first { $0.control == .select }?.handoff)
        XCTAssertEqual(shift.writes, true)
        let box = try XCTUnwrap(p.fields.first { $0.control == .checkbox && $0.handoff?.writes == true }?.handoff)
        XCTAssertNotNil(box.context, "a box's value names the line it was read from")
    }

    /// protocol.ts's refinements of askQuestion and askAnswer, refused here too.
    func testQuestionsAndAnswersTheHelperWouldRefuseAreRefusedHere() throws {
        let line = try Self.lines("ask-choices")[2]
        func changed(_ body: (NSMutableDictionary) -> Void) throws -> Data {
            let m = try XCTUnwrap(Self.object(line).mutableCopy() as? NSMutableDictionary)
            body(m)
            return try JSONSerialization.data(withJSONObject: m)
        }
        XCTAssertNoThrow(try HelperInbound.decode(line))
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["pick"] = "one" }), "a fields question picks many")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [] }), "at least one option")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [["kind": "memory", "id": "o1"]] }), "a fields question lists fields")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [["kind": "field", "id": "o1", "label": "A", "section": NSNull()], ["kind": "field", "id": "o1", "label": "B", "section": NSNull()]]
        }), "ids repeat")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [["kind": "field", "id": "o1", "label": "A"]] }), "section is nullable, not optional")
        let answer = try XCTUnwrap(Self.object(Self.lines("ask-choices")[3]).mutableCopy() as? NSMutableDictionary)
        answer["picks"] = []
        XCTAssertThrowsError(try HelperInbound.decode(JSONSerialization.data(withJSONObject: answer)), "an answer picks at least one")
    }

    // MARK: - The desk

    private var clock: ManualClock!
    private var ask: AskCaret!
    private var sent: [AskCaret.Send] = []

    override func setUp() {
        clock = ManualClock()
        ask = AskCaret(clock: clock)
        sent = []
        ask.send = { [unowned self] in sent.append($0); return true }
        ask.linkChanged(true)
    }

    /// Typed, Return, and the golden question back under this request's id.
    private func asked(_ index: Int) throws -> AskQuestion {
        ask.edit("do the landlord bit")
        XCTAssertTrue(ask.submit())
        guard case .plan(let request)? = sent.last else { throw Unexpected("no planRequest") }
        var q = try Self.question(index)
        q.requestId = request.requestId
        ask.receive(q)
        return q
    }

    private var lastAnswer: AskAnswer? {
        if case .answer(let a)? = sent.last { return a }
        return nil
    }

    func testAQuestionShowsItsChoicesAndTabAnswersWithTheHighlightedOne() throws {
        let q = try asked(4)
        guard case .question(let shown) = ask.phase else { return XCTFail("the desk shows the question") }
        XCTAssertEqual(shown.highlight, 0)
        XCTAssertTrue(ask.move(1))
        XCTAssertTrue(ask.toggle(), "Space is taken, so it is not typed into the instruction")
        guard case .question(let moved) = ask.phase else { return XCTFail("still the question") }
        XCTAssertEqual(moved.highlight, 1)
        XCTAssertEqual(moved.selected, [], "a question with one answer selects nothing")
        XCTAssertTrue(ask.tab())
        let answer = try XCTUnwrap(lastAnswer)
        XCTAssertEqual(answer.questionId, q.questionId)
        XCTAssertEqual(answer.picks, ["o2"])
        guard case .asking(let id) = ask.phase else { return XCTFail("the desk waits for the answer's reply") }
        XCTAssertEqual(id, answer.requestId)
        XCTAssertEqual(ask.text, "do the landlord bit", "the instruction stays")
    }

    func testSpaceSelectsSeveralFieldsAndTabSendsThemInTheQuestionsOrder() throws {
        _ = try asked(2)
        XCTAssertTrue(ask.move(1))
        XCTAssertTrue(ask.toggle())
        XCTAssertTrue(ask.move(-1))
        XCTAssertTrue(ask.toggle())
        XCTAssertTrue(ask.toggle())
        XCTAssertTrue(ask.toggle())
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(lastAnswer?.picks, ["o1", "o2"])
    }

    func testTabWithNothingSelectedAnswersWithTheHighlightedField() throws {
        _ = try asked(2)
        XCTAssertTrue(ask.move(-1), "Up from the first row wraps to the last")
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(lastAnswer?.picks, ["o2"])
    }

    func testEscDismissesTheQuestionAndKeepsTheInstruction() throws {
        _ = try asked(7)
        XCTAssertTrue(ask.escape())
        XCTAssertEqual(ask.phase, .idle)
        XCTAssertEqual(ask.text, "do the landlord bit")
        XCTAssertFalse(ask.move(1), "no question, no arrows")
        XCTAssertFalse(ask.tab())
    }

    func testTheReplyToAnAnswerIsAPlanOrAnotherQuestion() throws {
        _ = try asked(2)
        XCTAssertTrue(ask.tab())
        var next = try Self.question(4)
        next.requestId = try XCTUnwrap(lastAnswer).requestId
        ask.receive(next)
        guard case .question(let q) = ask.phase else { return XCTFail("the next question") }
        XCTAssertEqual(q.ask.part, .source)
        XCTAssertTrue(ask.tab())
        guard case .planProposal(var plan) = try HelperInbound.decode(Self.lines("ask-choices")[6]) else { return XCTFail("line 7") }
        plan.requestId = try XCTUnwrap(lastAnswer).requestId
        ask.receive(plan)
        guard case .proposed = ask.phase else { return XCTFail("the plan's card") }
    }

    func testAQuestionThatExpiresSaysSo() throws {
        let q = try asked(7)
        clock.advance(by: Double(q.expires - Int64(clock.now.timeIntervalSince1970 * 1000)) / 1000 + 1)
        guard case .failed(let sentence) = ask.phase else { return XCTFail("expired") }
        XCTAssertEqual(sentence, "That question has expired. Ask again.")
    }

    func testAQuestionForAnotherRequestIsNotThisDesks() throws {
        ask.edit("do the landlord bit")
        XCTAssertTrue(ask.submit())
        ask.receive(try Self.question(2))
        guard case .asking = ask.phase else { return XCTFail("still waiting for its own answer") }
    }

    func testTheRowsWordsAreTheOptionsOwn() {
        XCTAssertEqual(AskCopy.option(.field(id: "o1", label: "Landlord name", section: "Current residence")).title, "Landlord name")
        XCTAssertEqual(AskCopy.option(.field(id: "o1", label: "Landlord name", section: "Current residence")).detail, "Current residence")
        XCTAssertEqual(AskCopy.option(.window(id: "o1", app: "Mail", title: "Lease renewal")).detail, "Lease renewal")
        XCTAssertNil(AskCopy.option(.window(id: "o1", app: "Notes", title: "Notes")).detail, "a title that repeats the app is left out")
        XCTAssertEqual(AskCopy.option(.memory(id: "o3")).title, "What you told Caret")
        XCTAssertEqual(AskCopy.option(.person(id: "o2", name: "Gary Pruitt")).title, "Gary Pruitt")
    }
}
