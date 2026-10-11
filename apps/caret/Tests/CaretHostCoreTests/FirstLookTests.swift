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
        XCTAssertEqual(FirstLookRequest.families(for: s), ["fill", "pending", "loop", "routine", "event"])
        s.roles.remove(.repeats)
        XCTAssertEqual(FirstLookRequest.families(for: s), ["fill", "pending", "event"])
        s.level = .quiet
        XCTAssertEqual(FirstLookRequest.families(for: s), ["fill", "pending"], "the event card is off at Quiet (B16)")
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

    /// The helper records a found offer under `<requestId>.0` (helper/src/offers/first-look.ts),
    /// and Tab's `offerAccept` names that key: a reply with any other key is refused loudly.
    func testAFoundOffersKeyIsTheRequestsKeyDotZero() throws {
        XCTAssertEqual(FirstLookReply.offerKey(requestId: "first-look-ab12-3"), "first-look-ab12-3.0")
        let found = try String(decoding: lines()[1], as: UTF8.self)
        XCTAssertEqual(try FirstLookReply.decode(lines()[1]).found?.offerKey, "first-look-1.0")
        for key in ["first-look-1", "first-look-1.1", "first-look-2.0", "pop-1"] {
            let line = found.replacingOccurrences(of: #""offerKey":"first-look-1.0""#, with: #""offerKey":"\#(key)""#)
            XCTAssertNotEqual(line, found, key)
            XCTAssertThrowsError(try FirstLookReply.decode(Data(line.utf8)), key) { error in
                XCTAssertTrue(String(describing: error).contains("first-look-1.0"), "names the key it expected: \(error)")
            }
        }
    }
}
