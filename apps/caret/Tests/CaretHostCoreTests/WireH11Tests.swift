import CaretHostCore
import CaretScreenCore
import XCTest

/// H11's wire: goal plans (plan-run.ndjson, page-goal.ndjson), saved answers (answers.ndjson) and the
/// local model (local-model.ndjson), from the helper's golden files copied byte for byte into Fixtures.
final class WireH11Tests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
    static let names = ["plan-run", "page-goal", "answers", "local-model"]

    static func lines(_ name: String) throws -> [Data] {
        try String(contentsOf: fixtures.appendingPathComponent("\(name).ndjson"), encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    /// What the host sends must be the golden line's JSON (key order aside).
    static func assertSameJSON<T: Encodable>(_ value: T, _ line: Data, file: StaticString = #filePath, line number: UInt = #line) throws {
        XCTAssertEqual(try object(JSONEncoder().encode(value)), try object(line), file: file, line: number)
    }

    func testTheFixtureCopiesAreTheHelpersGoldenFiles() throws {
        let repo = Self.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        for name in Self.names {
            let copy = try Data(contentsOf: Self.fixtures.appendingPathComponent("\(name).ndjson"))
            let golden = try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/\(name).ndjson"))
            XCTAssertEqual(copy, golden, "Fixtures/\(name).ndjson differs from helper/fixtures/golden/\(name).ndjson")
        }
    }

    /// Every line decodes, and none is unknown: a host that declares a capability decodes all it is sent.
    func testEveryGoldenLineDecodes() throws {
        for name in Self.names {
            for (i, line) in try Self.lines(name).enumerated() {
                let decoded = try HelperInbound.decode(line)
                if case .unknown(let type) = decoded { XCTFail("\(name) line \(i + 1): \(type) is unknown") }
            }
        }
    }

    // MARK: - Goals

    func testThePageGoalLinesDecodeAsThePanelReadsThem() throws {
        let lines = try Self.lines("page-goal")
        var previews: [GoalProgress.Preview] = []
        var receipts = 0
        var ends: [GoalProgress.End] = []
        var stops: [GoalProgress.Stop] = []
        for line in lines {
            guard case .goalProgress(let m) = try HelperInbound.decode(line) else { continue }
            switch m.event {
            case .segment(let p): previews.append(p)
            case .step: receipts += 1
            case .finished(let e): ends.append(e)
            case .stopped(let s): stops.append(s)
            }
        }
        XCTAssertEqual(previews.map(\.reason), [.start, .afterReveal])
        XCTAssertEqual(receipts, 10)
        XCTAssertEqual(ends.map(\.outcome), [.partial, .partial])
        let first = try XCTUnwrap(previews.first?.page)
        XCTAssertEqual(first.windowId, "page:eng1:7")
        XCTAssertEqual(first.anchor, Frame(x: 100, y: 150, width: 200, height: 20))
        XCTAssertEqual(first.viewport, Frame(x: 100, y: 150, width: 800, height: 500))
        XCTAssertEqual(first.from, "TextEdit, Robin's details.txt")
        XCTAssertEqual(first.rows.first(where: { $0.label == "Country" }), .init(step: 2, label: "Country", value: "Canada", picked: true))
        XCTAssertEqual(first.attach, ["Resume"])
        XCTAssertEqual(previews.last?.page?.rows, [.init(step: 0, label: "Province", value: "Ontario", picked: true)])
        XCTAssertEqual(stops.map(\.says), ["Caret's model account is out of credits, so Caret can't do this. Add credits, then try again."])
    }

    func testTheHostsGoalLinesAreTheGoldenOnes() throws {
        for name in ["plan-run", "page-goal"] {
            for line in try Self.lines(name) {
                let type = try XCTUnwrap(Self.object(line)["type"] as? String)
                switch type {
                case GoalAccept.type: try Self.assertSameJSON(JSONDecoder().decode(GoalAccept.self, from: line), line)
                case TaskControl.type: try Self.assertSameJSON(JSONDecoder().decode(TaskControl.self, from: line), line)
                case GoalProgress.type: try Self.assertSameJSON(JSONDecoder().decode(GoalProgress.self, from: line), line)
                default: continue
                }
            }
        }
    }

    func testAPageRowThatIsNotAWriteStepIsRefused() throws {
        let line = try XCTUnwrap(try Self.lines("page-goal").first { (try? Self.object($0)["event"] as? String) == "segment" })
        let o = try XCTUnwrap(Self.object(line).mutableCopy() as? NSMutableDictionary)
        let page = try XCTUnwrap((o["page"] as? NSDictionary)?.mutableCopy() as? NSMutableDictionary)
        page["rows"] = [["step": 99, "label": "x", "value": "y", "picked": false]]
        o["page"] = page
        XCTAssertThrowsError(try HelperInbound.decode(JSONSerialization.data(withJSONObject: o)))
    }

    func testNextPageIsTakenForP3() throws {
        let line = try XCTUnwrap(try Self.lines("page-goal").first { (try? Self.object($0)["event"] as? String) == "segment" })
        let o = try XCTUnwrap(Self.object(line).mutableCopy() as? NSMutableDictionary)
        o["reason"] = "nextPage"
        guard case .goalProgress(let m) = try HelperInbound.decode(JSONSerialization.data(withJSONObject: o)), case .segment(let p) = m.event else {
            return XCTFail("not a segment")
        }
        XCTAssertEqual(p.reason, .nextPage)
    }

    // MARK: - Saved answers

    func testASavedAnswerDecodesWholeBesideItsValue() throws {
        let proposal = try XCTUnwrap(try Self.lines("answers").compactMap { line -> FillProposal? in
            if case .fillProposal(let p) = try HelperInbound.decode(line) { return p }
            return nil
        }.first)
        let offered = try XCTUnwrap(proposal.fields.first)
        XCTAssertEqual(offered.answer?.id, "answer-1a2b3c4d")
        XCTAssertNil(offered.answer?.withheld)
        XCTAssertEqual(offered.value?.hasSuffix("The job now takes eleven minutes."), true)
        let withheld = try XCTUnwrap(proposal.fields.last)
        XCTAssertNil(withheld.value)
        XCTAssertEqual(withheld.answer?.withheld?.why, "otherOrganization")
    }

    func testAnOfferedAnswerMustBeTheFieldsOwnValue() throws {
        let line = try XCTUnwrap(try Self.lines("answers").first { (try? Self.object($0)["type"] as? String) == "fillProposal" })
        let text = try XCTUnwrap(String(data: line, encoding: .utf8))
        // The answer names another memory entry than the value came from.
        let forged = text.replacingOccurrences(of: #""answer":{"id":"answer-1a2b3c4d""#, with: #""answer":{"id":"answer-ffffffff""#)
        XCTAssertNotEqual(forged, text)
        XCTAssertThrowsError(try HelperInbound.decode(Data(forged.utf8)))
    }

    func testTheSaveLines() throws {
        var kinds: [String] = []
        for line in try Self.lines("answers") {
            switch try HelperInbound.decode(line) {
            case .answerSaveOffer(let o):
                kinds.append("offer")
                XCTAssertEqual(o.says, "Save this answer for next time?")
                XCTAssertEqual(o.answer.hasSuffix("eleven minutes."), true)
            case .answerSaveReply(let r): kinds.append("reply:\(r.outcome.rawValue)")
            case .notForConsumer(let type) where type == AnswerSave.type:
                kinds.append("save")
                try Self.assertSameJSON(JSONDecoder().decode(AnswerSave.self, from: line), line)
            case .memoryDocumentReply(let r): kinds.append("docs:\(r.documents.map(\.doc).joined(separator: ","))")
            default: continue
            }
        }
        XCTAssertEqual(kinds, ["offer", "save", "reply:saved", "save", "reply:refused", "reply:refused", "docs:answers"])
        XCTAssertTrue(MemoryDocs.isDocId("answers"))
    }

    // MARK: - Local model

    func testEveryLocalTextRequestIsAnsweredUnavailable() throws {
        let lines = try Self.lines("local-model")
        let requests = try lines.compactMap { line -> LocalTextRequest? in
            if case .localTextRequest(let r) = try HelperInbound.decode(line) { return r }
            return nil
        }
        XCTAssertEqual(requests.map(\.id), ["lt-1", "lt-2", "lt-3"])
        for r in requests {
            let reply = LocalText.unavailable(r)
            XCTAssertEqual(reply.outcome, .unavailable)
            XCTAssertNil(reply.text)
        }
        // The golden's own unavailable reply is the host's, to the byte's meaning.
        try Self.assertSameJSON(LocalText.unavailable(requests[2]), lines[6])
    }

    func testTheHelloNamesNoLocalModel() {
        XCTAssertFalse(HostHello.capabilities(routing: true).contains(LocalText.capability))
        XCTAssertFalse(HostHello.capabilities(routing: false).contains(LocalText.capability))
    }
}
