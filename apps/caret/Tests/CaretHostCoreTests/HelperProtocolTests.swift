import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// helper/fixtures/golden/protocol.ndjson, written against the zod schemas in helper/src/protocol.ts.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func goldenLines() throws -> [Data] {
    try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
}

private func goldenProposal() throws -> FillProposal {
    for line in try goldenLines() {
        if case .fillProposal(let p) = try HelperInbound.decode(line) { return p }
    }
    throw XCTSkip("golden file has no fillProposal")
}

final class HelperProtocolGoldenTests: XCTestCase {
    func testEveryGoldenLineDecodesToWhatAConsumerDoesWithIt() throws {
        let kinds = try goldenLines().map { line -> String in
            switch try HelperInbound.decode(line) {
            case .fillProposal: return "fillProposal"
            case .error: return "error"
            case .notForConsumer(let type): return "skip:\(type)"
            case .unknown(let type): return "unknown:\(type)"
            }
        }
        XCTAssertEqual(kinds, [
            "skip:hello", "skip:snapshot", "skip:focus", "skip:appSwitch", "skip:windowClosed",
            "skip:pasteboard", "skip:fillRequest", "fillProposal", "error",
        ])
    }

    func testGoldenFillProposalFieldsDecodeExactly() throws {
        let p = try goldenProposal()
        XCTAssertEqual(p.id, "fill-1")
        XCTAssertEqual(p.at, 1_790_000_000_500)
        XCTAssertEqual(p.windowId, "5150-1")
        XCTAssertEqual(p.bundleId, "dev.caret.fixture")
        XCTAssertEqual(p.triggerKey, "dev.caret.fixture/standard/group:contact details/textfield:email~0")
        XCTAssertEqual(p.candidates, 24)
        XCTAssertEqual(p.cutoff, 0.75)
        XCTAssertEqual(p.jev.model, "jev-1.13.0")
        XCTAssertEqual(p.jev.latencyMs, 201.5)
        XCTAssertEqual(p.fields.count, 2)

        let email = p.fields[0]
        XCTAssertEqual(email.frame, Frame(x: 150, y: 120, width: 300, height: 24))
        XCTAssertEqual(email.choice, "c3")
        XCTAssertEqual(email.confidence, 0.97)
        XCTAssertEqual(email.value, "dana.whitfield@example.com")
        XCTAssertNil(email.withheld)
        XCTAssertEqual(email.source?.windowId, "5150-2")
        XCTAssertEqual(email.source?.appName, "Caret Fixture")
        XCTAssertEqual(email.source?.windowTitle, "Reference")
        XCTAssertEqual(email.source?.kind, .email)
        XCTAssertEqual(email.asks.map(\.choice), ["c3", "c3"])

        let promo = p.fields[1]
        XCTAssertNil(promo.frame)
        XCTAssertEqual(promo.choice, "none")
        XCTAssertNil(promo.value)
        XCTAssertNil(promo.source)
        XCTAssertEqual(promo.withheld, .disagree)
        XCTAssertEqual(promo.asks[1].value, "SAVE-10")
    }

    func testGoldenErrorDecodes() throws {
        let last = try XCTUnwrap(try goldenLines().last)
        XCTAssertEqual(try HelperInbound.decode(last), .error(try JSONDecoder().decode(HelperError.self, from: last)))
        guard case .error(let e) = try HelperInbound.decode(last) else { return XCTFail("not an error") }
        XCTAssertEqual(e.message, "unknown window 5150-9")
    }

    func testAnUnknownTypeIsNamedNotFatal() throws {
        let line = Data(#"{"type":"taskProgress","v":1,"at":1}"#.utf8)
        XCTAssertEqual(try HelperInbound.decode(line), .unknown(type: "taskProgress"))
    }

    func testAWrongVersionIsRejected() {
        let line = Data(#"{"type":"error","v":2,"at":1,"message":"x"}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }

    func testAMalformedProposalIsRejectedNotSkipped() {
        // asks must hold exactly two entries.
        let line = Data(#"{"type":"fillProposal","v":1,"id":"f","at":1,"windowId":"1-1","bundleId":"b","triggerKey":"k","fields":[{"key":"k","frame":null,"descriptor":"d","choice":"none","confidence":0,"value":null,"source":null,"withheld":null,"asks":[]}],"candidates":0,"jev":{"model":"m","latencyMs":1,"inputTokens":1,"costUsd":0},"cutoff":0.75}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }
}

final class FillResultTests: XCTestCase {
    func testEncodesEveryKeyWithNullsPresent() throws {
        let result = FillResult(
            at: 1_790_000_001_000, proposalId: "fill-1", windowId: "5150-1",
            fieldKey: "dev.caret.fixture/standard/group:contact details/textfield:email~0",
            outcome: .rejected, reason: "sourceChanged", method: nil, valueLength: 0
        )
        let data = try NDJSON.encoder().encode(result)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "v", "at", "proposalId", "windowId", "fieldKey", "outcome", "reason", "method", "valueLength"])
        XCTAssertEqual(object["type"] as? String, "fillResult")
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertTrue(object["method"] is NSNull, "nullable keys are sent as null, not omitted")
        XCTAssertEqual(try JSONDecoder().decode(FillResult.self, from: data), result)
    }

    func testRoundTripsEveryOutcomeAndMethod() throws {
        for outcome in [FillResult.Outcome.inserted, .rejected, .failed, .undone, .undoFailed] {
            for method in [FillResult.Method?.none, .pastePid, .axSelectedText, .axValue] {
                let r = FillResult(at: 1, proposalId: "p", windowId: "1-1", fieldKey: "k", outcome: outcome, reason: nil, method: method, valueLength: 3)
                XCTAssertEqual(try JSONDecoder().decode(FillResult.self, from: try JSONEncoder().encode(r)), r)
            }
        }
    }

    func testRejectsAMissingNullableKey() {
        let line = Data(#"{"type":"fillResult","v":1,"at":1,"proposalId":"p","windowId":"1-1","fieldKey":"k","outcome":"inserted","method":"pastePid","valueLength":3}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(FillResult.self, from: line))
    }

    func testTheHostRecognisesItsOwnMessageIfEchoed() throws {
        let r = FillResult(at: 1, proposalId: "p", windowId: "1-1", fieldKey: "k", outcome: .inserted, reason: nil, method: .pastePid, valueLength: 3)
        XCTAssertEqual(try HelperInbound.decode(try JSONEncoder().encode(r)), .notForConsumer(type: "fillResult"))
    }
}

final class LineFramerTests: XCTestCase {
    private func lines(_ items: [LineFramer.Item]) -> [String] {
        items.map { item in
            switch item {
            case .line(let d): return String(decoding: d, as: UTF8.self)
            case .oversized: return "<oversized>"
            }
        }
    }

    func testJoinsAPartialLineAcrossChunks() {
        var f = LineFramer()
        XCTAssertEqual(lines(f.append(Data(#"{"a":"#.utf8))), [])
        XCTAssertEqual(lines(f.append(Data("1}\n{\"b\":2}\n{\"c\"".utf8))), [#"{"a":1}"#, #"{"b":2}"#])
        XCTAssertEqual(lines(f.append(Data(":3}\n".utf8))), [#"{"c":3}"#])
    }

    func testSkipsBlankLines() {
        var f = LineFramer()
        XCTAssertEqual(lines(f.append(Data("\n  \n{}\n".utf8))), ["{}"])
    }

    func testDropsAnOversizedLineWholeAndResynchronizes() {
        var f = LineFramer(maxLineBytes: 8)
        XCTAssertEqual(lines(f.append(Data("0123456789".utf8))), ["<oversized>"])
        XCTAssertEqual(lines(f.append(Data("abc\n{}\n".utf8))), ["{}"], "the tail of the long line is not a message")
    }
}

final class FillSelectionTests: XCTestCase {
    private let emailFrame = Frame(x: 150, y: 120, width: 300, height: 24)

    func testTheFocusedFieldGetsItsProposedValue() throws {
        let result = FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "", secure: false)
        guard case .offer(let field, let origin) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(field.value, "dana.whitfield@example.com")
        XCTAssertEqual(origin.proposalID, "fill-1")
        XCTAssertEqual(origin.windowID, "5150-1")
        XCTAssertEqual(origin.fieldKey, field.key)
        XCTAssertEqual(origin.sourcePID, 5150)
        XCTAssertEqual(origin.sourceCaption, "from Caret Fixture, Reference")
    }

    func testAFrameWithinAPointStillMatches() throws {
        let nudged = Frame(x: 150.6, y: 119.4, width: 300, height: 24)
        guard case .offer = FillSelection.select(try goldenProposal(), focusedFrame: nudged, focusedValue: "", secure: false) else {
            return XCTFail("rounding between readers must not lose the match")
        }
    }

    func testAMovedWindowMatchesNothing() throws {
        let moved = Frame(x: 152, y: 120, width: 300, height: 24)
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: moved, focusedValue: "", secure: false), .skip(.noFieldAtFocus))
    }

    func testANoneAnswerShowsNoOffer() throws {
        var p = try goldenProposal()
        p.fields[1].frame = Frame(x: 150, y: 160, width: 300, height: 24)
        XCTAssertEqual(
            FillSelection.select(p, focusedFrame: Frame(x: 150, y: 160, width: 300, height: 24), focusedValue: "", secure: false),
            .skip(.answerNone)
        )
    }

    func testAFieldThatAlreadyHasTextIsNeverFilled() throws {
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "d", secure: false), .skip(.fieldNotEmpty))
    }

    func testASecureFieldIsNeverFilled() throws {
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "", secure: true), .skip(.unsuitableField))
    }

    func testSourceCaptionDropsARepeatedAppName() {
        let origin = FillOrigin(
            proposalID: "p", windowID: "1-1", fieldKey: "k", sourceAppName: "Caret Fixture",
            sourceWindowTitle: "Caret Fixture — Reference", sourceBundleID: "", sourcePID: 1, proposedAtMs: 0
        )
        XCTAssertEqual(origin.sourceCaption, "from Caret Fixture, Reference")
        var bare = origin
        bare.sourceWindowTitle = ""
        XCTAssertEqual(bare.sourceCaption, "from Caret Fixture")
    }

    func testWindowIDsParseToPIDs() {
        XCTAssertEqual(FillSelection.pid(fromWindowID: "5150-2"), 5150)
        XCTAssertNil(FillSelection.pid(fromWindowID: "nodash"))
    }
}
