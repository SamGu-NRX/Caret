import CaretHostCore
import CaretScreenCore
import XCTest

/// D2-02's routing lines (helper/fixtures/golden/routing.ndjson, read by path as protocol.ndjson is).
/// The host decodes them and does nothing else until H6.
final class RoutingTests: XCTestCase {
    private static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("helper/fixtures/golden/routing.ndjson")

    private static func lines() throws -> [Data] {
        try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testEveryRoutingLineDecodesAndDecisionsAreTheirOwnCase() throws {
        let kinds = try Self.lines().map { line -> String in
            switch try HelperInbound.decode(line) {
            case .routeDecision(let d): return "decision:\(d.outcome?.rawValue ?? "null")"
            case .notForConsumer(let type): return "skip:\(type)"
            default: return "other"
            }
        }
        XCTAssertEqual(kinds, [
            "skip:hello", "skip:routingContext", "decision:write", "skip:routingContext", "decision:null", "decision:act",
            "skip:routingContext", "decision:abstain", "skip:routingContext", "decision:act", "decision:abstain",
        ])
    }

    func testDecisionFieldsMatchTheGoldenLines() throws {
        let lines = try Self.lines()
        guard case .routeDecision(let act) = try HelperInbound.decode(lines[9]) else { return XCTFail("line 10 is a routeDecision") }
        XCTAssertEqual(act.context, 15)
        XCTAssertEqual(act.windowId, "5150-7")
        XCTAssertEqual(act.key, "dev.caret.fixture/standard/textfield:email~0")
        XCTAssertEqual(act.textRevision, "9f2c0a6b1d4e7f80")
        XCTAssertEqual(act.outcome, .act)
        XCTAssertEqual(act.route, "fillAll")
        XCTAssertEqual(act.expires, 1790001812001)
        guard case .routeDecision(let none) = try HelperInbound.decode(lines[10]) else { return XCTFail("line 11 is a routeDecision") }
        XCTAssertNil(none.key)
        guard case .routeDecision(let reopened) = try HelperInbound.decode(lines[4]) else { return XCTFail("line 5 is a routeDecision") }
        XCTAssertNil(reopened.outcome)
        XCTAssertNil(reopened.route)
    }

    /// The host will send these (H6): each golden context re-encodes to the same JSON object.
    func testContextsRoundTripToTheGoldenObjects() throws {
        for (i, line) in try Self.lines().enumerated() where String(decoding: line, as: UTF8.self).contains(#""type":"routingContext""#) {
            let context = try JSONDecoder().decode(RoutingContext.self, from: line)
            XCTAssertEqual(try Self.object(JSONEncoder().encode(context)), try Self.object(line), "line \(i + 1)")
        }
    }

    /// protocol.ts's two refinements, and the nullable keys zod requires.
    func testDecisionsTheHelperWouldRefuseAreRefusedHere() throws {
        let base: [String: Any] = [
            "type": "routeDecision", "v": 1, "at": 1, "context": 1, "windowId": "1-1", "key": "k",
            "textRevision": "r1", "outcome": "abstain", "route": NSNull(), "expires": 2,
        ]
        func line(_ change: (inout [String: Any]) -> Void) throws -> Data {
            var m = base
            change(&m)
            return try JSONSerialization.data(withJSONObject: m)
        }
        XCTAssertNoThrow(try HelperInbound.decode(line { _ in }))
        XCTAssertThrowsError(try HelperInbound.decode(line { $0["route"] = "fillAll" }), "only act names a route")
        XCTAssertThrowsError(try HelperInbound.decode(line { $0["outcome"] = "write"; $0["key"] = NSNull() }), "write names its field")
        XCTAssertThrowsError(try HelperInbound.decode(line { $0.removeValue(forKey: "outcome") }), "outcome is nullable, not optional")
        XCTAssertThrowsError(try HelperInbound.decode(line { $0["context"] = 0 }), "context is positive")
        XCTAssertThrowsError(try HelperInbound.decode(line { $0["textRevision"] = String(repeating: "r", count: 65) }), "revision is at most 64")
        XCTAssertThrowsError(try HelperInbound.decode(line { $0["outcome"] = "pounce" }), "unknown outcome")
    }

    /// Until H6 wires routing, the host does not ask for decisions.
    func testTheHostsHelloDoesNotAskForRouting() {
        XCTAssertFalse(HostHello.capabilities.contains(Routing.capability))
    }
}
