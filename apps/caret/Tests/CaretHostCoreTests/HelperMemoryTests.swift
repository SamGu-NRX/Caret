import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The memory protocol as the host reads and writes it, against `Fixtures/memory.ndjson` (the
/// helper's shapes, plus the host's `add` op and permission `uses`), and the permission table
/// against the helper's own source.
final class HelperMemoryTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/memory.ndjson")

    static func lines() throws -> [Data] {
        try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    static func reply(_ index: Int) throws -> HelperMemory.Reply {
        try HelperMemory.Reply.decode(lines()[index])
    }

    /// The fixture's line of this type for this request id. The file is the helper's golden copy
    /// (helper/fixtures/golden/memory.ndjson) byte for byte, as H1 left it (v2/hygiene 4153294).
    /// Lines are found by id, so a line added in the middle moves nothing.
    static func line(_ requestId: String, _ type: String) throws -> Data {
        let found = try lines().first { data in
            let o = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return o?["requestId"] as? String == requestId && o?["type"] as? String == type
        }
        return try XCTUnwrap(found, "no \(type) \(requestId) in Fixtures/memory.ndjson")
    }

    private func json(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    /// Every reply line reads in full: host-memory-6 and -7 (B21 and B22) and the `wrote` line
    /// (host-memory-9: A16's, which the helper's golden copy renamed from a second host-memory-7 in
    /// H1). There is no host-memory-8.
    func testEveryReplyLineReadsWithNothingUnreadable() throws {
        for id in [1, 2, 3, 4, 5, 6, 7, 9].map({ "host-memory-\($0)" }) {
            let reply = try HelperMemory.Reply.decode(Self.line(id, "memoryReply"))
            XCTAssertEqual(reply.unreadable, [], id)
        }
        let putBack = try HelperMemory.Reply.decode(Self.line("host-memory-6", "memoryReply"))
        XCTAssertEqual(putBack.entries.first?.skill?.onItsOwn, false)
        let offered = try HelperMemory.Reply.decode(Self.line("host-memory-7", "memoryReply"))
        XCTAssertEqual(offered.entries.first?.skill?.onItsOwn, false, "the skill comes back unchanged; only the offer's yes changes it")
        XCTAssertEqual(try HelperMemory.Reply.decode(Self.line("host-memory-9", "memoryReply")).entries.first?.wrote, [.writeElsewhere])
    }

    func testTheListReplyReadsEveryKind() throws {
        let reply = try Self.reply(1)
        XCTAssertNil(reply.error)
        XCTAssertEqual(reply.unreadable, [])
        XCTAssertEqual(reply.entries.count, 13)
        XCTAssertEqual(reply.entries.map(\.kind.rawValue).filter { $0 != "permission" }, ["about", "people", "preference", "preference", "preference", "routine"])
        let about = try XCTUnwrap(reply.entries[0].about)
        XCTAssertEqual(about, HelperMemory.About(label: "Guest", value: "Marcus Lowe (ops)", source: .edit))
        XCTAssertEqual(reply.entries[0].evidence, HelperMemory.Evidence(count: 1, lastSeen: 1_790_000_060_000, app: "Mail Fixture"))
        XCTAssertEqual(reply.entries[1].status, .paused)
        XCTAssertEqual(reply.entries[2].fields, .preference(.format(template: "###-###-####")))
        XCTAssertEqual(reply.entries[3].fields, .preference(.useInstead(field: "Guest", aboutId: "about-1a2b3c4d")))
        XCTAssertEqual(reply.entries[4].fields, .preference(.dontOffer(offerKind: "routine", appName: "Mail Fixture")))
        guard case .routine(let routine) = reply.entries[5].fields else { return XCTFail("not a routine") }
        XCTAssertNil(routine.name)
        XCTAssertEqual(routine.silent.hits, 0)
        let permissions = reply.entries.compactMap(\.permission)
        XCTAssertEqual(permissions.map(\.action), HelperMemory.ActionType.allCases)
        XCTAssertEqual(reply.entries.first { $0.permission?.action == .writeHere }?.uses?.count, 2)
        XCTAssertNil(reply.entries.first { $0.permission?.action == .outbound }?.uses, "no uses key: not reported")
    }

    func testRequestsMatchTheFixtureLines() throws {
        let lines = try Self.lines()
        let requests: [(Int, HelperMemory.Request)] = [
            (0, .init(requestId: "host-memory-1", op: .list)),
            (2, .init(requestId: "host-memory-2", op: .edit, id: "about-1a2b3c4d", fields: ["value": .text("Marcus Lowe, Operations")])),
            (4, .init(requestId: "host-memory-3", op: .add, kind: .about, fields: ["label": .text("Name"), "value": .text("Dana Whitfield"), "source": .text("typed")])),
            (6, .init(requestId: "host-memory-4", op: .edit, id: "permission-writeHere", fields: ["rule": .text("act")])),
            (8, .init(requestId: "host-memory-5", op: .edit, id: "permission-sensitive", fields: ["rule": .text("act")])),
        ]
        for (index, request) in requests {
            XCTAssertEqual(try json(request.line()), try json(lines[index]), "line \(index)")
        }
    }

    /// The host's contract for showing onboarding's know step: a list reply names the ops the
    /// helper accepts. Today's helper names none, and a name this host does not know is left out.
    func testOpsSayWhetherTheHelperKeepsTypedValues() throws {
        let contract = try Self.reply(1)
        XCTAssertEqual(contract.ops, [.list, .edit, .pause, .resume, .forget, .add, .offerOnItsOwn])
        XCTAssertTrue(contract.acceptsAdd)
        XCTAssertTrue(contract.offersOnItsOwn)
        let today = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[]}"#.utf8))
        XCTAssertNil(today.ops)
        XCTAssertFalse(today.acceptsAdd)
        let newer = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[],"ops":["list","merge"]}"#.utf8))
        XCTAssertEqual(newer.ops, [.list])
        XCTAssertFalse(newer.acceptsAdd)

        let book = MemoryBook(clock: ManualClock())
        var sent: [HelperMemory.Request] = []
        book.send = { sent.append($0); return true }
        book.linkChanged(true)
        var r = contract
        r.requestId = try XCTUnwrap(sent.last, "no request was sent").requestId
        book.receive(r)
        XCTAssertTrue(book.state.acceptsAdd)
        XCTAssertTrue(book.debugInfo().acceptsAdd)
        book.linkChanged(false)
        XCTAssertTrue(book.state.acceptsAdd, "kept across a dropped connection")
        book.linkChanged(true)
        var plain = today
        plain.requestId = try XCTUnwrap(sent.last, "no request was sent").requestId
        book.receive(plain)
        XCTAssertFalse(book.state.acceptsAdd, "a helper that stops saying so hides the step again")
    }

    func testAClearedRoutineNameIsSentAsNull() throws {
        let r = HelperMemory.Request(requestId: "r", op: .edit, id: "routine-1", fields: ["name": .null])
        let fields = try XCTUnwrap(try json(r.line())["fields"] as? NSDictionary)
        XCTAssertEqual(fields["name"] as? NSNull, NSNull())
    }

    func testAnEntryThisHostCannotReadIsCountedAndTheRestApply() throws {
        let line = #"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"habit","id":"h-1","status":"active","says":"x","evidence":{"count":1,"lastSeen":1,"app":null},"fields":{}},{"kind":"preference","id":"p-1","status":"active","says":"y","evidence":{"count":1,"lastSeen":1,"app":null},"fields":{"rule":"shout","x":1}},{"kind":"about","id":"a-1","status":"active","says":"Name: Dana (you typed this)","evidence":{"count":1,"lastSeen":1,"app":null},"fields":{"label":"Name","value":"Dana","source":"typed"}}]}"#
        let reply = try HelperMemory.Reply.decode(Data(line.utf8))
        // A kind this host does not know is kept and shown as something Caret noticed (A15); a known
        // kind whose fields it cannot read is still counted, never guessed at.
        XCTAssertEqual(reply.entries.map(\.id), ["h-1", "a-1"])
        XCTAssertEqual(reply.entries.first?.fields, .unrecognized(kind: "habit"))
        XCTAssertEqual(reply.unreadable.count, 1)
    }

    func testUsesOnAnythingButAPermissionIsRefused() throws {
        let line = #"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"about","id":"a-1","status":"active","says":"x","evidence":{"count":1,"lastSeen":1,"app":null},"fields":{"label":"Name","value":"Dana","source":"typed"},"uses":[]}]}"#
        XCTAssertEqual(try HelperMemory.Reply.decode(Data(line.utf8)).unreadable.count, 1)
    }

    func testTheEnvelopeIsStrict() {
        XCTAssertThrowsError(try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":2,"requestId":"r","error":null,"entries":[]}"#.utf8)))
        XCTAssertThrowsError(try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","entries":[]}"#.utf8)), "error must be present, null on success")
    }

    func testTheInboundDecoderRoutesMemoryReplies() throws {
        let line = try Self.line("host-memory-5", "memoryReply")
        guard case .memoryReply(let reply) = try HelperInbound.decode(line) else { return XCTFail("not routed") }
        XCTAssertEqual(reply.error, "sensitive can be handoff, not act")
        XCTAssertEqual(try HelperInbound.decode(Self.lines()[0]).typeName, "memoryRequest", "our own request echoed is not for us")
    }

    // MARK: - The permission table

    /// The helper's `PERMISSIONS` table, read from its source: each action's `allowed` list must be
    /// the host's, so the list never offers a rule the helper refuses or hides one it allows.
    func testThePermissionTableMatchesTheHelpers() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../helper/src/patterns/memory.ts").standardized
        let text = try String(contentsOf: source, encoding: .utf8)
        let pattern = try NSRegularExpression(pattern: #"^\s*(\w+): \{ rule: "(\w+)", allowed: \[([^\]]*)\]"#, options: .anchorsMatchLines)
        var seen: Set<HelperMemory.ActionType> = []
        for m in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            let name = String(text[Range(m.range(at: 1), in: text)!])
            let allowed = String(text[Range(m.range(at: 3), in: text)!])
                .split(separator: ",").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"")) }
            let action = try XCTUnwrap(HelperMemory.ActionType(rawValue: name), name)
            seen.insert(action)
            XCTAssertEqual(Set(PermissionPolicy.allowed(action).map(\.rawValue)), Set(allowed), name)
        }
        XCTAssertEqual(seen, Set(HelperMemory.ActionType.allCases), "every action type found in memory.ts")
    }

    func testSendingDeletingMoneyAndPasswordsNeverGoPastAskFirst() {
        for action in [HelperMemory.ActionType.outbound, .destructive, .sensitive] {
            XCTAssertFalse(PermissionPolicy.permits(action, .act), action.rawValue)
            XCTAssertFalse(PermissionPolicy.permits(action, .actIfApproved), action.rawValue)
            XCTAssertTrue(PermissionPolicy.permits(action, .handoff), action.rawValue)
        }
        XCTAssertTrue(PermissionPolicy.permits(.outbound, .ask))
        XCTAssertFalse(PermissionPolicy.permits(.sensitive, .ask), "money stays handed off")
        XCTAssertEqual(PermissionPolicy.allowed(.writeHere), [.ask, .act], "least autonomous first")
    }
}
