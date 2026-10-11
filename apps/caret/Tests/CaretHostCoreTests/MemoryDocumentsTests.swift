import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// M1's markdown memory on the host's side, against `Fixtures/memory-documents.ndjson`: the helper's
/// golden file (helper/fixtures/golden/memory-documents.ndjson on v2/screen, blob 0f8f189) copied byte
/// for byte. Lines the host sends must encode to the golden line; lines it receives must decode to
/// exactly what the line says.
final class MemoryDocumentsTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/memory-documents.ndjson")

    static func lines() throws -> [Data] {
        try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    static func line(_ i: Int) throws -> Data { try lines()[i] }

    private func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testTheFixtureIsTheFourteenGoldenLines() throws {
        let types = try Self.lines().map { try object($0)["type"] as? String }
        XCTAssertEqual(types, [
            "hello", "memoryRequest", "memoryReply", "memoryProvenance", "memoryNotRight", "memoryReply", "memoryNotRight", "memoryReply",
            "memoryDocumentRequest", "memoryDocumentReply", "memoryDocumentRequest", "memoryDocumentReply", "memoryDocumentRequest", "memoryDocumentReply",
        ])
    }

    // MARK: - What the host sends

    /// M1's golden hello names memoryDocuments alone; the host's names it among the others (`RoutingTests`).
    func testTheHostsHelloNamesTheCapability() throws {
        let golden = try XCTUnwrap(object(Self.line(0)).mutableCopy() as? NSMutableDictionary)
        XCTAssertEqual(golden["capabilities"] as? [String], [MemoryDocs.capability])
        golden["capabilities"] = HostHello.capabilities(routing: false)
        XCTAssertEqual(try object(NDJSON.line(HostHello.make(pid: golden["pid"] as! Int, routing: false, host: true))), golden)
    }

    /// The people add: a person the user names, the same `memoryRequest add` as onboarding's About.
    func testThePeopleAddIsTheGoldenLine() throws {
        let request = HelperMemory.Request(requestId: "host-m1-1", op: .add, kind: .people, fields: ["alias": .text("Dana"), "name": .text("Dana Whitfield")])
        XCTAssertEqual(try object(request.line()), try object(Self.line(1)))
    }

    func testNotRightEncodesBothGoldenLines() throws {
        let correct = MemoryNotRight(requestId: "host-m1-2", memoryId: "about-5e6f7a8b", offerKey: "fill-12-5150-7", correction: "Marcus Lowe, Ops lead")
        XCTAssertEqual(try object(NDJSON.line(correct)), try object(Self.line(4)))
        let forget = MemoryNotRight(requestId: "host-m1-3", memoryId: "people-0a1b2c3d", offerKey: nil, correction: nil)
        XCTAssertEqual(try object(NDJSON.line(forget)), try object(Self.line(6)))
        // Nulls are present, not left out: the helper's schema has them nullable, not optional.
        let text = String(decoding: try NDJSON.line(forget), as: UTF8.self)
        XCTAssertTrue(text.contains(#""offerKey":null"#) && text.contains(#""correction":null"#), text)
    }

    func testDocumentRequestsEncodeTheGoldenLines() throws {
        XCTAssertEqual(try object(NDJSON.line(MemoryDocumentRequest(requestId: "host-m1-4", op: .list))), try object(Self.line(8)))
        XCTAssertEqual(try object(NDJSON.line(MemoryDocumentRequest(requestId: "host-m1-5", op: .read(doc: "about-me")))), try object(Self.line(10)))
        let save = MemoryDocumentRequest(requestId: "host-m1-6", op: .save(
            doc: "about-me", base: "sha256:9f2c0a6b1d4e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708", text: "# About me\n"
        ))
        XCTAssertEqual(try object(NDJSON.line(save)), try object(Self.line(12)))
    }

    /// A save of a file that does not exist yet sends `baseRevision: null`, not nothing: the helper
    /// refuses a save without the key.
    func testASaveOfANewFileSendsANullBase() throws {
        let line = try NDJSON.line(MemoryDocumentRequest(requestId: "r", op: .save(doc: "people", base: nil, text: "# People\n")))
        XCTAssertTrue(String(decoding: line, as: UTF8.self).contains(#""baseRevision":null"#))
        let list = try object(NDJSON.line(MemoryDocumentRequest(requestId: "r", op: .list)))
        XCTAssertNil(list["doc"])
        XCTAssertNil(list["baseRevision"])
        XCTAssertNil(list["text"])
    }

    // MARK: - What the host reads

    func testTheReplyWithANoticedFactReadsWhereItWasNoticed() throws {
        let reply = try HelperMemory.Reply.decode(Self.line(2))
        XCTAssertEqual(reply.unreadable, [])
        XCTAssertEqual(reply.entries.map(\.id), ["people-0a1b2c3d", "about-5e6f7a8b"])
        XCTAssertEqual(reply.entries[0].status, .active)
        XCTAssertNil(reply.entries[0].noticed)
        let about = reply.entries[1]
        XCTAssertEqual(about.status, .noticed)
        XCTAssertEqual(about.noticed, HelperMemory.Noticed(app: "Mail Fixture", windowTitle: "Re: dinner on Friday", at: 1_789_827_200_000))
        XCTAssertEqual(about.about, HelperMemory.About(label: "Guest", value: "Marcus Lowe (ops)", source: .edit))
    }

    func testProvenanceDecodesExactly() throws {
        guard case .memoryProvenance(let p) = try HelperInbound.decode(Self.line(3)) else { return XCTFail("not routed as provenance") }
        XCTAssertEqual(p, MemoryProvenance(at: 1_790_000_000_000, offerKey: "fill-12-5150-7", facts: [
            .init(memoryId: "about-5e6f7a8b", kind: .about, label: "Guest", says: "from what Caret noticed in Mail Fixture, Tue",
                  noticed: HelperMemory.Noticed(app: "Mail Fixture", windowTitle: "Re: dinner on Friday", at: 1_789_827_200_000)),
        ]))
        XCTAssertTrue(p.facts[0].correctable)
    }

    func testNotRightRepliesReadTheChangeAndTheForget() throws {
        let corrected = try HelperMemory.Reply.decode(Self.line(5))
        XCTAssertEqual(corrected.requestId, "host-m1-2")
        XCTAssertEqual(corrected.entries.first?.status, .active)
        XCTAssertEqual(corrected.entries.first?.about?.value, "Marcus Lowe, Ops lead")
        let forgotten = try HelperMemory.Reply.decode(Self.line(7))
        XCTAssertEqual(forgotten.requestId, "host-m1-3")
        XCTAssertEqual(forgotten.entries, [])
    }

    func testTheListReplyNamesEveryDocumentAndItsProblem() throws {
        guard case .memoryDocumentReply(let r) = try HelperInbound.decode(Self.line(9)) else { return XCTFail("not routed as a document reply") }
        XCTAssertNil(r.error)
        XCTAssertNil(r.conflict)
        XCTAssertNil(r.text)
        XCTAssertEqual(r.folder, "/Users/example/Library/Application Support/Caret/Memory")
        XCTAssertEqual(r.documents.map(\.doc), ["about-me", "people", "preferences"])
        XCTAssertEqual(r.documents[0].diagnostics, [MemoryDiagnostic(line: 14, field: "On its own", severity: .warning, message: "not a field Caret reads in an about record; it changes nothing")])
        XCTAssertEqual(r.documents[1].revision, nil, "people.md does not exist yet")
        XCTAssertEqual(r.documents[1].bytes, 0)
    }

    func testTheReadReplyCarriesTheText() throws {
        let r = try MemoryDocumentReply.decode(Self.line(11))
        XCTAssertEqual(r.documents.first?.revision, "sha256:9f2c0a6b1d4e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708")
        XCTAssertEqual(r.text, "# About me\n\n## Guest <!-- caret:id=about-5e6f7a8b kind=about -->\n- Label: Guest\n- Value: Marcus Lowe, Ops lead\n- Source: edit\n- Status: active\n")
    }

    func testTheConflictReplyNamesTheRevisionNow() throws {
        let r = try MemoryDocumentReply.decode(Self.line(13))
        XCTAssertEqual(r.error, "about-me.md changed outside Caret while it saved; keeping that version")
        XCTAssertEqual(r.conflict, .some("sha256:0d1e2f3a4b5c6d7e8f9091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6"))
        XCTAssertEqual(r.documents.first?.bytes, 640)
    }

    /// The host's own requests, echoed back, are named and not acted on.
    func testTheHostsOwnRequestsAreNotForItself() throws {
        for i in [4, 6, 8, 10, 12] {
            guard case .notForConsumer = try HelperInbound.decode(Self.line(i)) else { return XCTFail("line \(i + 1) routed to the host") }
        }
    }

    // MARK: - Refusals

    func testANoticedEntryThatDoesNotSayWhereIsUnreadable() throws {
        let line = #"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"about","id":"a-1","status":"noticed","says":"x","evidence":{"count":1,"lastSeen":1,"app":null},"fields":{"label":"Guest","value":"V","source":"edit"}}]}"#
        let reply = try HelperMemory.Reply.decode(Data(line.utf8))
        XCTAssertEqual(reply.entries, [])
        XCTAssertEqual(reply.unreadable.count, 1)
    }

    func testOnlyAboutPeopleAndPreferencesAreNoticed() throws {
        let line = #"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"routine","id":"r-1","status":"noticed","says":"x","evidence":{"count":1,"lastSeen":1,"app":null},"noticed":{"app":null,"windowTitle":null,"at":1},"fields":{"srcApps":["A"],"dstApp":"B","steps":1,"name":null,"silent":{"hits":0,"misses":0}}}]}"#
        XCTAssertEqual(try HelperMemory.Reply.decode(Data(line.utf8)).unreadable.count, 1)
        let provenance = #"{"type":"memoryProvenance","v":1,"at":1,"offerKey":"k","facts":[{"memoryId":"r-1","kind":"routine","label":"x","says":"y","noticed":{"app":null,"windowTitle":null,"at":1}}]}"#
        XCTAssertThrowsError(try MemoryProvenance.decode(Data(provenance.utf8)))
    }

    func testProvenanceWithNoFactsIsRefused() {
        let line = #"{"type":"memoryProvenance","v":1,"at":1,"offerKey":"k","facts":[]}"#
        XCTAssertThrowsError(try MemoryProvenance.decode(Data(line.utf8)))
    }

    func testAConflictWithoutAnErrorIsRefused() {
        let line = #"{"type":"memoryDocumentReply","v":1,"requestId":"r","error":null,"conflict":{"revision":null},"folder":"/f","documents":[],"text":null}"#
        XCTAssertThrowsError(try MemoryDocumentReply.decode(Data(line.utf8)))
    }

    func testADocumentThatIsAPathIsRefused() {
        for doc in ["../about-me", "/etc/passwd", "skills/ab", "skills/-abc", "notes"] {
            XCTAssertFalse(MemoryDocs.isDocId(doc), doc)
        }
        for doc in ["about-me", "people", "preferences", "skills/skill-1a2b3c4d"] {
            XCTAssertTrue(MemoryDocs.isDocId(doc), doc)
        }
        let line = #"{"type":"memoryDocumentReply","v":1,"requestId":"r","error":null,"conflict":null,"folder":"/f","documents":[{"doc":"../x","file":"x","path":"/x","revision":null,"bytes":0,"diagnostics":[]}],"text":null}"#
        XCTAssertThrowsError(try MemoryDocumentReply.decode(Data(line.utf8)))
    }

    /// Review finding 9: what protocol.ts refuses, the host refuses too.
    func testValuesTheHelpersSchemaRefusesAreRefused() throws {
        let negative = #"{"type":"memoryProvenance","v":1,"at":-1,"offerKey":"k","facts":[{"memoryId":"m","kind":"about","label":"x","says":"y","noticed":{"app":null,"windowTitle":null,"at":1}}]}"#
        XCTAssertThrowsError(try MemoryProvenance.decode(Data(negative.utf8)))
        let emptyMessage = #"{"type":"memoryDocumentReply","v":1,"requestId":"r","error":null,"conflict":null,"folder":"/f","documents":[{"doc":"people","file":"people.md","path":"/f/people.md","revision":null,"bytes":0,"diagnostics":[{"line":1,"field":null,"severity":"error","message":""}]}],"text":null}"#
        XCTAssertThrowsError(try MemoryDocumentReply.decode(Data(emptyMessage.utf8)))
        let nullNoticed = #"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"about","id":"a-1","status":"active","says":"x","evidence":{"count":1,"lastSeen":1,"app":null},"noticed":null,"fields":{"label":"Guest","value":"V","source":"edit"}}]}"#
        XCTAssertEqual(try HelperMemory.Reply.decode(Data(nullNoticed.utf8)).unreadable.count, 1)
    }

    func testAMissingNullableKeyIsRefused() {
        let line = #"{"type":"memoryDocumentReply","v":1,"requestId":"r","error":null,"folder":"/f","documents":[],"text":null}"#
        XCTAssertThrowsError(try MemoryDocumentReply.decode(Data(line.utf8)), "conflict must be present, null when there is none")
    }
}
