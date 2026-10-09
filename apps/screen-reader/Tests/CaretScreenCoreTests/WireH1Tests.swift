import Foundation
import Testing
@testable import CaretScreenCore

/// H1: the protocol cases v2/next added, as the helper's golden lines and zod schemas state them
/// (helper/fixtures/golden/value-checks.ndjson, protocol.ndjson; helper/src/protocol.ts): FillWithheld's notExact,
/// unverified and outOfScope; the plan refusal outOfScope; FillField.basis.identity; Node.inputKind and autocomplete.
private let golden = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden")

private func lines(_ name: String) throws -> [Data] {
    try String(contentsOf: golden.appendingPathComponent(name), encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
}

private func swap(_ line: Data, _ from: String, _ to: String) throws -> Data {
    let s = String(decoding: line, as: UTF8.self)
    guard s.contains(from) else { throw ProtocolError("the line has no \(from)") }
    return Data(s.replacingOccurrences(of: from, with: to).utf8)
}

/// The line is refused. Its swap happens before, outside the expectation, so a swap that found nothing fails the test
/// rather than passing as a refusal.
private func refuses(_ line: Data) {
    #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: line) }
}

private func object(_ data: Data) throws -> NSDictionary {
    try #require(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
}

@Suite struct WireH1 {
    @Test func decodesEveryValueCheckLine() throws {
        let l = try lines("value-checks.ndjson")
        let kinds = try l.map { line -> String in
            switch try JSONDecoder().decode(Message.self, from: line) {
            case .hello: "hello"
            case .snapshot: "snapshot"
            case .fillProposal: "fillProposal"
            default: "other"
            }
        }
        #expect(kinds == ["hello", "snapshot", "fillProposal", "fillProposal"])
    }

    @Test func readsAPageInputsKindAndAutocompleteName() throws {
        let l = try lines("value-checks.ndjson")
        guard case .snapshot(let s) = try JSONDecoder().decode(Message.self, from: l[1]) else { Issue.record("line 2 is not a snapshot"); return }
        #expect(s.nodes.map(\.inputKind) == [.email, .text])
        #expect(s.nodes.map(\.autocomplete) == [.email, .organizationTitle])
        // Written back as the helper wrote them, and absent where the reader's own native nodes have none.
        let again = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(s.nodes[1])) as! [String: Any]
        #expect(again["inputKind"] as? String == "text" && again["autocomplete"] as? String == "organization-title")
        let native = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Node(key: "k", parent: nil, role: "AXTextField"))) as! [String: Any]
        #expect(native["inputKind"] == nil && native["autocomplete"] == nil)
    }

    /// Zod's enums are closed, and its optional fields are never null: so are these.
    @Test func refusesAKindOrNameZodRefuses() throws {
        let line = try lines("value-checks.ndjson")[1]
        refuses(try swap(line, #""inputKind":"email""#, #""inputKind":"color""#))
        refuses(try swap(line, #""autocomplete":"email""#, #""autocomplete":"cc-number""#))
        refuses(try swap(line, #""autocomplete":"email""#, #""autocomplete":null"#))
    }

    @Test func readsTheNewWithheldReasonsAndTheOldOnesInTheirPlace() throws {
        let l = try lines("value-checks.ndjson")
        guard case .fillProposal(let checked) = try JSONDecoder().decode(Message.self, from: l[2]),
              case .fillProposal(let old) = try JSONDecoder().decode(Message.self, from: l[3]) else { Issue.record("lines 3 and 4 are fill proposals"); return }
        #expect(checked.fields.map(\.withheld) == [nil, .notExact, .unverified])
        // A host without valueChecks is sent wrongKind for both (server.ts withOldReasons).
        #expect(old.fields.map(\.withheld) == [nil, .wrongKind, .wrongKind])
        for (line, p) in [(l[2], checked), (l[3], old)] {
            #expect(try object(try NDJSON.encoder().encode(Message.fillProposal(p))) == (try object(line)))
        }
        // I2: outOfScope, sent only to a host whose hello lists askScope.
        guard case .fillProposal(let scoped) = try JSONDecoder().decode(Message.self, from: try swap(l[2], #""withheld":"notExact""#, #""withheld":"outOfScope""#)) else { Issue.record("not a fill proposal"); return }
        #expect(scoped.fields.map(\.withheld) == [nil, .outOfScope, .unverified])
        refuses(try swap(l[2], #""withheld":"notExact""#, #""withheld":"guessed""#))
    }

    @Test func readsThePlanRefusalOutOfScope() throws {
        let line = try swap(try lines("protocol.ndjson")[56], #""code":"unseenWindow""#, #""code":"outOfScope""#)
        guard case .planProposal(let p) = try JSONDecoder().decode(Message.self, from: line) else { Issue.record("not a plan proposal"); return }
        #expect(p.error?.code == .outOfScope)
    }

    /// G2: a value that is exactly the user's identity in memory names that entry; zod requires the entry and key and
    /// closes kind and part.
    @Test func readsAFieldsIdentityBasisAndWritesItBack() throws {
        let proposal = try lines("value-checks.ndjson")[2]
        let identity = #","basis":{"identity":{"memoryId":"mem-name-1","kind":"name","key":"robin vale","part":"first"}}"#
        let first = #""asks":[{"choice":"c1","confidence":0.9,"value":"Robin Vale"},{"choice":"v1","confidence":0.91,"value":"Robin Vale"}]"#
        let line = try swap(proposal, first, first + identity)
        guard case .fillProposal(let p) = try JSONDecoder().decode(Message.self, from: line) else { Issue.record("not a fill proposal"); return }
        #expect(p.fields[0].basis == FillBasis(identity: .init(memoryId: "mem-name-1", kind: .name, key: "robin vale", part: .first)))
        #expect(p.fields[1].basis == nil)
        #expect(try object(try NDJSON.encoder().encode(Message.fillProposal(p))) == (try object(line)))
        refuses(try swap(line, #""memoryId":"mem-name-1""#, #""memoryId":"""#))
        refuses(try swap(line, #""key":"robin vale""#, #""key":"""#))
        refuses(try swap(line, #""kind":"name""#, #""kind":"address""#))
        refuses(try swap(line, #""part":"first""#, #""part":null"#))
    }
}
