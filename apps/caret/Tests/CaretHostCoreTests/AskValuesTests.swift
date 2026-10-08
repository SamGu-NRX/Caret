import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Value questions (docs/input-pipeline.md, "value questions in the Ask panel"): which value goes in one field, as the
/// host reads and answers them, against `Fixtures/ask-values.ndjson` (the helper's golden copy).
final class AskValuesTests: XCTestCase {
    private static func lines() throws -> [Data] {
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-values.ndjson")
        return try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private static func question(_ index: Int) throws -> AskQuestion {
        guard case .askQuestion(let q) = try HelperInbound.decode(lines()[index]) else { throw Unexpected("line \(index + 1) is no askQuestion") }
        return q
    }

    // MARK: - The wire

    func testEveryAskValuesLineDecodesToWhatTheHostDoesWithIt() throws {
        let kinds = try Self.lines().map { line -> String in
            switch try HelperInbound.decode(line) {
            case .askQuestion(let q): return "question:\(q.part.rawValue)"
            case .notForConsumer(let type): return "skip:\(type)"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, ["skip:hello", "skip:planRequest", "question:value", "skip:askAnswer", "question:value", "skip:askAnswer"])
    }

    func testAValueQuestionDecodesItsValuesItsBlankAndWhatItFills() throws {
        let q = try Self.question(2)
        XCTAssertEqual(q.part, .value)
        XCTAssertEqual(q.pick, .one)
        XCTAssertEqual(q.options, [
            .value(id: "o1", value: "grace.oduya@example.com", source: "Your saved Email"),
            .value(id: "o2", value: "g.oduya@lumen.example", source: "Venue deposit and Thursday review: Grace's other address: g.oduya@lumen.example"),
            .blank(id: "o3"),
        ])
        XCTAssertEqual(q.filling, ["First name: Grace", "Last name: Oduya"])
        XCTAssertEqual(try Self.question(4).options.last, .blank(id: "o2"))
    }

    /// The host's answers are the golden lines, and each question re-encodes to itself.
    func testTheHostsLinesAreTheGoldenLines() throws {
        let lines = try Self.lines()
        for i in [3, 5] {
            let answer = try JSONDecoder().decode(AskAnswer.self, from: lines[i])
            XCTAssertEqual(try Self.object(NDJSON.line(answer)), try Self.object(lines[i]), "ask-values line \(i + 1)")
        }
        for i in [2, 4] {
            XCTAssertEqual(try Self.object(JSONEncoder().encode(Self.question(i))), try Self.object(lines[i]), "ask-values line \(i + 1)")
        }
    }

    /// protocol.ts's refinements of a value question, refused here too.
    func testValueQuestionsTheHelperWouldRefuseAreRefusedHere() throws {
        let line = try Self.lines()[2]
        func changed(_ body: (NSMutableDictionary) -> Void) throws -> Data {
            let m = try XCTUnwrap(Self.object(line).mutableCopy() as? NSMutableDictionary)
            body(m)
            return try JSONSerialization.data(withJSONObject: m)
        }
        let value: [String: Any] = ["kind": "value", "id": "o1", "value": "a@example.com", "source": "Your saved Email"]
        XCTAssertNoThrow(try HelperInbound.decode(line))
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["pick"] = "many" }), "a value question picks one")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [value] }), "no blank")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [["kind": "blank", "id": "o2"]] }), "a blank alone lists no value")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [["kind": "blank", "id": "o2"], value] }), "the blank comes last")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [value, ["kind": "blank", "id": "o2"], ["kind": "blank", "id": "o3"]]
        }), "exactly one blank")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [["kind": "field", "id": "o1", "label": "A", "section": NSNull()], ["kind": "blank", "id": "o2"]]
        }), "a value question lists only value and blank options")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [["kind": "value", "id": "o1", "value": "", "source": "Your saved Email"], ["kind": "blank", "id": "o2"]]
        }), "a value is not empty")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [["kind": "value", "id": "o1", "value": "a@example.com", "source": ""], ["kind": "blank", "id": "o2"]]
        }), "a value says where it was read")
        XCTAssertThrowsError(try HelperInbound.decode(changed {
            $0["options"] = [["kind": "value", "id": "o1", "value": "a@example.com"], ["kind": "blank", "id": "o2"]]
        }), "source is required")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["options"] = [value, ["kind": "blank", "id": "o1"]] }), "ids repeat")
        XCTAssertThrowsError(try HelperInbound.decode(changed { $0["filling"] = [] }), "filling lists at least one value")

        let fields = try XCTUnwrap(Self.object(RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-choices.ndjson")
            .readLines()[2]).mutableCopy() as? NSMutableDictionary)
        fields["options"] = [["kind": "field", "id": "o1", "label": "A", "section": NSNull()], ["kind": "blank", "id": "o2"]]
        XCTAssertThrowsError(try HelperInbound.decode(JSONSerialization.data(withJSONObject: fields)), "only a value question lists a blank")
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
    @discardableResult
    private func asked(_ index: Int) throws -> AskQuestion {
        ask.edit("can u put my name and work email in")
        XCTAssertTrue(ask.submit())
        guard case .plan(let request)? = sent.last else { throw Unexpected("no planRequest") }
        var q = try Self.question(index)
        q.requestId = request.requestId
        ask.receive(q)
        return q
    }

    private var shown: AskCaret.Question? {
        if case .question(let q) = ask.phase { return q }
        return nil
    }

    private var answers: [AskAnswer] {
        sent.compactMap { if case .answer(let a) = $0 { return a } else { return nil } }
    }

    func testAValueQuestionOpensWithNothingHighlighted() throws {
        try asked(2)
        XCTAssertNil(try XCTUnwrap(shown).highlight)
        XCTAssertNil(ask.debugInfo.highlight)
    }

    func testTabWithNothingHighlightedIsTakenAndSendsNothing() throws {
        try asked(2)
        XCTAssertTrue(ask.tab(), "Tab is the card's while the question shows")
        XCTAssertEqual(answers, [])
        XCTAssertNotNil(shown, "the question stays")
    }

    func testDownGoesToTheFirstRowUpToTheLastThenTheyWrap() throws {
        try asked(2)
        XCTAssertTrue(ask.move(1))
        XCTAssertEqual(shown?.highlight, 0)
        XCTAssertTrue(ask.move(-1))
        XCTAssertEqual(shown?.highlight, 2, "Up from the first row wraps to the last")
        XCTAssertTrue(ask.move(1))
        XCTAssertEqual(shown?.highlight, 0, "Down from the last row wraps to the first")

        try asked(2)
        XCTAssertTrue(ask.move(-1))
        XCTAssertEqual(shown?.highlight, 2, "Up from nothing goes to the last row, the blank")
    }

    func testTabAnswersWithTheHighlightedValueAsTheGoldenLine() throws {
        let q = try asked(2)
        XCTAssertTrue(ask.move(1))
        XCTAssertTrue(ask.tab())
        let answer = try XCTUnwrap(answers.last)
        XCTAssertEqual(answer.questionId, q.questionId)
        XCTAssertEqual(answer.picks, ["o1"])
        XCTAssertEqual(try Self.object(NDJSON.line(AskAnswer(requestId: "ask-22", at: 1_790_000_506_000, questionId: answer.questionId, picks: answer.picks))),
                       try Self.object(Self.lines()[3]))
        guard case .asking(let id) = ask.phase else { return XCTFail("the desk waits for the answer's reply") }
        XCTAssertEqual(id, answer.requestId)
    }

    func testTheNextValueQuestionOpensWithNothingHighlightedAndTheBlankAnswersIt() throws {
        try asked(2)
        XCTAssertTrue(ask.move(1))
        XCTAssertTrue(ask.tab())
        var next = try Self.question(4)
        next.requestId = try XCTUnwrap(answers.last).requestId
        ask.receive(next)
        XCTAssertEqual(shown?.ask.questionId, next.questionId)
        XCTAssertNil(shown?.highlight, "the next question highlights nothing either")
        XCTAssertTrue(ask.move(-1))
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(answers.last?.picks, ["o2"])
        XCTAssertEqual(try Self.object(NDJSON.line(AskAnswer(requestId: "ask-23", at: 1_790_000_510_000, questionId: next.questionId, picks: ["o2"]))),
                       try Self.object(Self.lines()[5]))
    }

    /// A value question names what Caret fills in `filling`, but that never makes an empty answer: only a fields
    /// question answers with no picks.
    func testAValueQuestionNeverAnswersWithNoPicks() throws {
        let q = try asked(2)
        XCTAssertNotNil(q.filling)
        XCTAssertEqual(try XCTUnwrap(shown).picks, [])
        XCTAssertTrue(ask.tab())
        XCTAssertTrue(ask.toggle(), "Space is taken, so it is not typed into the instruction")
        XCTAssertTrue(ask.tab())
        XCTAssertEqual(answers, [])
        XCTAssertEqual(shown?.selected, [], "a value question selects nothing")
    }

    func testEscWritesNothingAndKeepsTheInstruction() throws {
        try asked(2)
        XCTAssertTrue(ask.move(1))
        XCTAssertTrue(ask.escape())
        XCTAssertEqual(ask.phase, .idle)
        XCTAssertEqual(answers, [])
        XCTAssertEqual(ask.text, "can u put my name and work email in")
    }

    /// VoiceOver's Choose on a row answers with that row, wherever the highlight is.
    func testARowsChooseActionAnswersWithThatRow() throws {
        try asked(2)
        XCTAssertTrue(ask.choose(option: "o2"))
        XCTAssertEqual(answers.map(\.picks), [["o2"]])
    }

    func testChooseNamesOnlyThisQuestionsRows() throws {
        try asked(2)
        XCTAssertTrue(ask.choose(option: "o9"), "taken while the question shows")
        XCTAssertEqual(answers, [], "an id the question doesn't list answers nothing")
        XCTAssertNotNil(shown)
    }

    func testChooseIsAValueQuestionsOnly() throws {
        ask.edit("do the landlord bit")
        XCTAssertTrue(ask.submit())
        guard case .plan(let request)? = sent.last else { return XCTFail("no planRequest") }
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-choices.ndjson")
        guard case .askQuestion(var source) = try HelperInbound.decode(url.readLines()[4]) else { return XCTFail("line 5") }
        source.requestId = request.requestId
        ask.receive(source)
        XCTAssertEqual(shown?.highlight, 0, "a question that isn't a value question still opens on its first row")
        XCTAssertFalse(ask.choose(option: "o1"))
        XCTAssertEqual(answers, [])
        XCTAssertFalse(AskCaret(clock: clock).choose(option: "o1"), "no question, no Choose")
    }

    // MARK: - The words

    func testARowsWordsAreItsValueAndWhereCaretReadIt() throws {
        let q = try Self.question(2)
        XCTAssertEqual(AskCopy.option(q.options[0]).title, "grace.oduya@example.com")
        XCTAssertEqual(AskCopy.option(q.options[0]).detail, "Your saved Email")
        XCTAssertEqual(AskCopy.option(q.options[2]).title, "Leave blank")
        XCTAssertNil(AskCopy.option(q.options[2]).detail)
    }

    func testTheKeysWordsOnAValueQuestion() throws {
        let q = try asked(2)
        XCTAssertEqual(AskCopy.answerLabel(try XCTUnwrap(shown)), "Choose", "not Fill, though the question names what it fills")
        XCTAssertTrue(ask.move(1))
        XCTAssertEqual(AskCopy.answerLabel(try XCTUnwrap(shown)), "Choose")
        XCTAssertEqual(AskCopy.questionHint(q), "Up and Down move between the values. Tab chooses one. Escape writes nothing.")
    }

    func testTheCaretWillFillLineListsTheCheckedValues() throws {
        XCTAssertEqual(AskCopy.willFill(try Self.question(2)), "Caret will fill First name: Grace, Last name: Oduya")
        XCTAssertEqual(AskCopy.willFill(try Self.question(4)), "Caret will fill First name: Grace, Last name: Oduya, Work email: grace.oduya@example.com")
        var none = try Self.question(2)
        none.filling = nil
        XCTAssertNil(AskCopy.willFill(none))
    }

    /// A fields question names what it fills in its own text ("Caret will fill Landlord name. Which…"), so it gets no
    /// second line saying so.
    func testAFieldsQuestionGetsNoCaretWillFillLine() throws {
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-choices.ndjson")
        guard case .askQuestion(let fields) = try HelperInbound.decode(url.readLines()[10]) else { return XCTFail("line 11") }
        XCTAssertNotNil(fields.filling)
        XCTAssertNil(AskCopy.willFill(fields))
    }

    // MARK: - VoiceOver

    func testEachRowReadsItsValueThenFromThenItsSource() throws {
        let q = try Self.question(2)
        XCTAssertEqual(AskCopy.spokenOption(q.options[0]), "grace.oduya@example.com, from Your saved Email")
        XCTAssertEqual(AskCopy.spokenOption(q.options[2]), "Leave blank")
        XCTAssertEqual(AskCopy.spokenOption(.field(id: "o1", label: "Landlord name", section: "Current residence")), "Landlord name, Current residence",
                       "other rows read as before")
        XCTAssertEqual(AskCopy.spokenOption(.memory(id: "o3")), "What you told Caret")
    }

    func testOpeningAValueQuestionSaysTheQuestionAndHowManyValues() throws {
        XCTAssertEqual(AskCopy.questionAnnouncement(try Self.question(2)), "Which email should go in Work email? 2 values.")
        XCTAssertEqual(AskCopy.questionAnnouncement(try Self.question(4)), "Should Caret tick Subscribe to the product newsletter? 1 value.")
        let url = RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("ask-choices.ndjson")
        guard case .askQuestion(let source) = try HelperInbound.decode(url.readLines()[4]) else { return XCTFail("line 5") }
        XCTAssertEqual(AskCopy.questionAnnouncement(source), "Where should Caret copy from? 3 choices.", "other questions read as before")
    }

    func testEachUpOrDownSaysTheHighlightedRow() throws {
        try asked(2)
        XCTAssertNil(AskCopy.highlightAnnouncement(try XCTUnwrap(shown)), "nothing highlighted, nothing said")
        XCTAssertTrue(ask.move(1))
        XCTAssertEqual(AskCopy.highlightAnnouncement(try XCTUnwrap(shown)), "grace.oduya@example.com, from Your saved Email")
        XCTAssertTrue(ask.move(-1))
        XCTAssertEqual(AskCopy.highlightAnnouncement(try XCTUnwrap(shown)), "Leave blank")
    }
}

private extension URL {
    func readLines() throws -> [Data] {
        try String(contentsOf: self, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }
}
