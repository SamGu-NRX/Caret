import CaretHostCore
import CaretScreenCore
import XCTest

/// D2-02's routing lines, from `Fixtures/routing.ndjson`: the helper's golden copy
/// (helper/fixtures/golden/routing.ndjson) byte for byte.
final class RoutingTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/routing.ndjson")

    private static func lines() throws -> [Data] {
        try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    /// The host's copies of the helper's golden lines must be the helper's bytes; a line the helper
    /// changes fails here until the copy is taken again.
    func testTheFixtureCopiesAreTheHelpersGoldenFiles() throws {
        let repo = Self.fixture.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        for name in ["routing", "fill-all", "ask-choices"] {
            let copy = try Data(contentsOf: Self.fixture.deletingLastPathComponent().appendingPathComponent("\(name).ndjson"))
            let golden = try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/\(name).ndjson"))
            XCTAssertEqual(copy, golden, "Fixtures/\(name).ndjson differs from helper/fixtures/golden/\(name).ndjson")
        }
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
        XCTAssertEqual(act, RouteDecision(
            at: 1790000012001, context: 15, windowId: "5150-7", key: "dev.caret.fixture/standard/textfield:email~0",
            textRevision: "9f2c0a6b1d4e7f80", outcome: .act, route: "fillAll", expires: 1790001812001
        ))
        guard case .routeDecision(let none) = try HelperInbound.decode(lines[10]) else { return XCTFail("line 11 is a routeDecision") }
        XCTAssertNil(none.key)
        guard case .routeDecision(let reopened) = try HelperInbound.decode(lines[4]) else { return XCTFail("line 5 is a routeDecision") }
        XCTAssertNil(reopened.outcome)
        XCTAssertNil(reopened.route)
    }

    /// Both messages re-encode to the golden bytes: the host sends contexts, and a decision written
    /// back (the debug state's record of one) is the line it came from.
    func testContextsAndDecisionsRoundTripByteForByte() throws {
        var seen = Set<String>()
        for (i, line) in try Self.lines().enumerated() {
            let type = try XCTUnwrap(Self.object(line)["type"] as? String)
            let encoded: Data
            switch type {
            case RoutingContext.type: encoded = try JSONEncoder().encode(JSONDecoder().decode(RoutingContext.self, from: line))
            case RouteDecision.type: encoded = try JSONEncoder().encode(JSONDecoder().decode(RouteDecision.self, from: line))
            default: continue
            }
            seen.insert(type)
            XCTAssertEqual(try Self.object(encoded), try Self.object(line), "line \(i + 1)")
            XCTAssertEqual(try Self.sortedJSON(encoded), try Self.sortedJSON(line), "line \(i + 1) keeps every key, nulls too")
        }
        XCTAssertEqual(seen, [RoutingContext.type, RouteDecision.type])
    }

    private static func sortedJSON(_ data: Data) throws -> String {
        let o = try JSONSerialization.jsonObject(with: data)
        return String(decoding: try JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), as: UTF8.self)
    }

    /// Every shape helper/test/routing-wire.test.ts refuses ("refuses the shapes the contract rules
    /// out"), from the same golden lines, plus the nullable keys zod requires.
    func testEveryShapeTheHelperRefusesIsRefusedHere() throws {
        let lines = try Self.lines()
        func line(_ type: String, _ n: Int = 0, _ change: (NSMutableDictionary) -> Void) throws -> Data {
            let matching = try lines.filter { try Self.object($0)["type"] as? String == type }
            let m = try XCTUnwrap(Self.object(matching[n]).mutableCopy() as? NSMutableDictionary)
            change(m)
            return try JSONSerialization.data(withJSONObject: m)
        }
        func refused(_ data: Data, _ why: String, file: StaticString = #filePath, lineNo: UInt = #line) {
            XCTAssertThrowsError(try HelperInbound.decode(data), why, file: file, line: lineNo)
        }
        XCTAssertNoThrow(try HelperInbound.decode(line(RouteDecision.type) { _ in }))
        XCTAssertNoThrow(try HelperInbound.decode(line(RoutingContext.type) { _ in }))
        // routing-wire.test.ts:34-43, in order.
        refused(try line(RouteDecision.type) { $0["route"] = "fillAll" }, "only act names a route")
        refused(try line(RouteDecision.type) { $0["key"] = NSNull() }, "write names its field")
        refused(try line(RouteDecision.type) { $0["outcome"] = "act"; $0["route"] = "" }, "a route is 1 to 80 characters")
        refused(try line(RouteDecision.type) { $0["outcome"] = "launch" }, "unknown outcome")
        refused(try line(RouteDecision.type) { $0["context"] = 0 }, "context is positive")
        refused(try line(RouteDecision.type, 1) { $0["route"] = "fillAll" }, "a null outcome names no route")
        refused(try line(RoutingContext.type) { $0["selection"] = "unknown" }, "selection is caret, range or none")
        refused(try line(RoutingContext.type) { $0["breakpoint"] = "word" }, "breakpoint is sentence or paragraph")
        refused(try line(RoutingContext.type) { $0["textRevision"] = "" }, "a revision is 1 to 64 characters")
        refused(try line(RoutingContext.type) { $0.removeObject(forKey: "key") }, "a context names its field")
        // zod's nullable: present, maybe null; and the revision's upper bound.
        refused(try line(RouteDecision.type) { $0.removeObject(forKey: "outcome") }, "outcome is nullable, not optional")
        refused(try line(RouteDecision.type) { $0["textRevision"] = String(repeating: "r", count: 65) }, "revision is at most 64")
        refused(try line(RoutingContext.type) { $0.removeObject(forKey: "breakpoint") }, "breakpoint is nullable, not optional")
    }

    func testTheHelloAsksForRoutingOnlyWhileTheSettingIsOn() throws {
        XCTAssertTrue(HostHello.capabilities(routing: true).contains(Routing.capability))
        XCTAssertFalse(HostHello.capabilities(routing: false).contains(Routing.capability))
        for on in [true, false] {
            let caps = HostHello.capabilities(routing: on)
            XCTAssertTrue(caps.contains(MemoryDocs.capability))
            XCTAssertTrue(caps.contains(HostHello.fillAllCapability))
            XCTAssertTrue(caps.contains(HostHello.askChoicesCapability))
            let hello = try Self.object(JSONEncoder().encode(HostHello.make(pid: 5151, routing: on)))
            XCTAssertEqual(hello["capabilities"] as? [String], caps)
        }
    }
}
