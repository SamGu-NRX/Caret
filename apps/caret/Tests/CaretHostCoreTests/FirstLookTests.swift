import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The `firstLook` contract, against the fixture the screen track builds the helper's side from.
final class FirstLookTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/first-look.ndjson")

    private func lines() throws -> [Data] {
        try String(contentsOf: Self.fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testTheRequestEncodesToTheFixtureLine() throws {
        let request = FirstLookRequest(requestId: "first-look-1", at: 1_790_000_000_000, families: ["fill", "pending", "loop", "routine"], level: .balanced)
        XCTAssertEqual(try object(request.line()), try object(lines()[0]))
        XCTAssertEqual(try JSONDecoder().decode(FirstLookRequest.self, from: lines()[0]), request)
    }

    func testTheRequestRunsOnlyTheFamiliesTheSettingsEnable() {
        var s = CaretSettings()
        XCTAssertEqual(FirstLookRequest.families(for: s), ["fill", "pending", "loop", "routine"])
        s.roles.remove(.repeats)
        XCTAssertEqual(FirstLookRequest.families(for: s), ["fill", "pending"])
        s.level = .quiet
        s.roles = [.watch, .words]
        XCTAssertEqual(FirstLookRequest.families(for: s), ["pending"], "ghost text is never part of a first look")
    }

    func testEachReplyShapeDecodesAndRoundTrips() throws {
        let replies = try lines().dropFirst().map(FirstLookReply.decode)
        XCTAssertEqual(replies.map(\.outcome), [.found, .found, .nothing, .error])
        XCTAssertEqual(replies[0].found?.kind, .fill)
        XCTAssertEqual(replies[0].found?.title, "Fill 4 fields")
        XCTAssertEqual(replies[0].found?.sourceApps, ["Mail"], "a fill names its source apps, as OfferPopup does")
        XCTAssertNil(replies[1].found?.sourceApps, "optional: a report has none")
        XCTAssertEqual(replies[1].found?.kind, .report)
        XCTAssertEqual(replies[1].found?.window.appName, "Terminal")
        XCTAssertEqual(replies[3].error, "reader not connected")
        for (reply, line) in zip(replies, try lines().dropFirst()) {
            XCTAssertEqual(try object(JSONEncoder().encode(reply)), try object(line))
        }
    }

    func testTheProtocolRoutesTheReplyToTheHost() throws {
        guard case .firstLookReply(let reply) = try HelperInbound.decode(lines()[3]) else { return XCTFail("not routed") }
        XCTAssertEqual(reply.outcome, .nothing)
        XCTAssertEqual(try HelperInbound.decode(lines()[0]), .notForConsumer(type: "firstLook"), "our own request echoed is not for us")
    }

    func testAReplyWhoseFieldsContradictItsOutcomeIsRefused() throws {
        let found = try String(decoding: lines()[1], as: UTF8.self)
        let nothing = try String(decoding: lines()[3], as: UTF8.self)
        let error = try String(decoding: lines()[4], as: UTF8.self)
        let bad = [
            ("found with no offer", nothing.replacingOccurrences(of: #""outcome":"nothing""#, with: #""outcome":"found""#)),
            ("nothing with an offer", found.replacingOccurrences(of: #""outcome":"found""#, with: #""outcome":"nothing""#)),
            ("error with no reason", error.replacingOccurrences(of: #""error":"reader not connected""#, with: #""error":null"#)),
            ("error with an empty reason", error.replacingOccurrences(of: #""error":"reader not connected""#, with: #""error":"""#)),
            ("found and an error", found.replacingOccurrences(of: #""error":null"#, with: #""error":"x""#)),
            ("a missing nullable key", nothing.replacingOccurrences(of: #","error":null"#, with: "")),
            ("an unknown outcome", nothing.replacingOccurrences(of: #""outcome":"nothing""#, with: #""outcome":"maybe""#)),
            ("another protocol version", nothing.replacingOccurrences(of: #""v":1"#, with: #""v":2"#)),
            ("a spec without a header", found.replacingOccurrences(of: #"{"type":"header","title":{"text":"Fill 4 fields","ref":{"rule":"count","derived":[{"node":"5151-2/form"}]}}},"#, with: "")),
            ("a value with no ref", found.replacingOccurrences(of: #""text":"Dana Reyes","ref":{"node":"6060-1/message/body","quote":"Dana Reyes"}"#, with: #""text":"Dana Reyes""#)),
        ]
        for (name, line) in bad {
            XCTAssertThrowsError(try FirstLookReply.decode(Data(line.utf8)), name)
        }
        XCTAssertNotEqual(bad[8].1, found, "the header edit must apply")
        XCTAssertNotEqual(bad[9].1, found, "the ref edit must apply")
    }
}
