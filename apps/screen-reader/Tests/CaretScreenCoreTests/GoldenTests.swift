import Foundation
import Testing
@testable import CaretScreenCore

/// helper/fixtures/golden/protocol.ndjson, written against the zod schemas in helper/src/protocol.ts.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func goldenLines() throws -> [Data] {
    let text = try String(contentsOf: goldenURL, encoding: .utf8)
    return text.split(separator: "\n").map { Data($0.utf8) }
}

@Suite struct GoldenProtocol {
    @Test func decodesEveryLineAsTheRightMessage() throws {
        let decoded = try goldenLines().map { try JSONDecoder().decode(Message.self, from: $0) }
        let kinds = decoded.map { m -> String in
            switch m {
            case .hello: "hello"
            case .snapshot: "snapshot"
            case .focus: "focus"
            case .appSwitch: "appSwitch"
            case .windowClosed: "windowClosed"
            case .pasteboard: "pasteboard"
            case .fillRequest: "fillRequest"
            case .fillProposal: "fillProposal"
            case .error: "error"
            case .readerCommand: "readerCommand"
            case .verbResult: "verbResult"
            case .userInput: "userInput"
            case .taskProgress: "taskProgress"
            case .fillResult: "fillResult"
            case .taskControl: "taskControl"
            case .activityRequest: "activityRequest"
            case .activity: "activity"
            case .activityReply: "activityReply"
            }
        }
        #expect(kinds == ["hello", "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard", "fillRequest", "fillProposal", "error",
                          "readerCommand", "verbResult", "userInput", "taskProgress",
                          "readerCommand", "fillResult", "taskControl", "activityRequest", "activity", "activityReply"])
    }

    @Test func reencodesEveryLineToTheSameJSON() throws {
        for line in try goldenLines() {
            let m = try JSONDecoder().decode(Message.self, from: line)
            let again = try NDJSON.encoder().encode(m)
            let a = try JSONSerialization.jsonObject(with: line) as! NSDictionary
            let b = try JSONSerialization.jsonObject(with: again) as! NSDictionary
            #expect(a == b, "round trip changed: \(String(decoding: line, as: UTF8.self).prefix(80))")
        }
    }

    @Test func readsSnapshotDetails() throws {
        let lines = try goldenLines()
        guard case .snapshot(let s) = try JSONDecoder().decode(Message.self, from: lines[1]) else {
            Issue.record("line 2 is not a snapshot"); return
        }
        #expect(s.root == nil)
        #expect(s.window.frame == Frame(x: 40, y: 60, width: 520, height: 420))
        let email = try #require(s.nodes.first { $0.role == "AXTextField" && $0.subrole == nil })
        #expect(email.editable)
        #expect(email.states == [.focused])
        #expect(s.nodes.first { $0.subrole == "AXSecureTextField" }?.value == nil)
        #expect(s.values == [TypedValue(kind: .id, text: "ORD-2026-48213", nodeKey: "dev.caret.fixture/standard/statictext:order ord-#-#~0")])
    }

    @Test func readsAReaderCommand() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[9]) else {
            Issue.record("line 10 is not a readerCommand"); return
        }
        guard case let .write(pid, _, _, role, attribute, expect, value) = c.verb else { Issue.record("not a write"); return }
        #expect(pid == 5150 && role == "AXTextField" && attribute == "value" && expect == "" && value == "dana.whitfield@example.com")
        let badVerb = Data(#"{"type":"readerCommand","v":1,"id":"x","verb":{"kind":"type","pid":1}}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: badVerb) }
    }

    @Test func readsTheActivityFeedAndWatchCommand() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[13]),
              case let .watchWindows(windows) = c.verb else { Issue.record("line 14 is not a watchWindows command"); return }
        #expect(windows == [WatchedWindow(pid: 5150, windowId: "5150-4")])
        guard case .activity(let a) = try JSONDecoder().decode(Message.self, from: lines[17]) else { Issue.record("line 18 is not an activity"); return }
        #expect(a.from == .running && a.task.state == .needsYou && a.task.kind == .watch && a.task.cause == .screen)
        #expect(a.task.pending?.waiting == PendingAnswer(choice: "yes", confidence: 0.97))
        guard case .activityReply(let r) = try JSONDecoder().decode(Message.self, from: lines[18]) else { Issue.record("line 19 is not an activityReply"); return }
        #expect(r.tasks.first?.step == 2 && r.tasks.first?.remaining.count == 2 && r.tasks.first?.pending == nil)
        guard case .fillProposal(let p) = try JSONDecoder().decode(Message.self, from: lines[7]) else { Issue.record("line 8 is not a fillProposal"); return }
        #expect(p.pid == 5150 && p.fields.compactMap(\.source).allSatisfy { $0.pid == 5150 })
        let badState = Data(#"{"type":"taskControl","v":1,"taskId":"t","action":"cancel"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: badState) }
    }

    @Test func rejectsAWrongVersionAndAnUnknownType() {
        let wrongVersion = Data(#"{"type":"pasteboard","v":2,"at":1,"changeCount":1}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: wrongVersion) }
        let unknown = Data(#"{"type":"mystery","v":1}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: unknown) }
        let falseEditable = Data(#"{"key":"k","parent":null,"role":"AXButton","editable":false}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: falseEditable) }
    }

    /// The same shapes zod rejects: a nullable field left out, and an optional field sent as null.
    @Test func rejectsWhatZodRejects() {
        let missingParent = Data(#"{"key":"k","role":"AXButton"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: missingParent) }
        let nullEditable = Data(#"{"key":"k","parent":null,"role":"AXButton","editable":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: nullEditable) }
        let nullLabel = Data(#"{"key":"k","parent":null,"role":"AXButton","label":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: nullLabel) }
        let noFocusKey = Data(#"{"type":"focus","v":1,"at":1,"app":{"pid":1,"bundleId":"b","name":"n"},"windowId":"w","role":"AXTextField","editable":true,"empty":true,"frontmost":true}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: noFocusKey) }
    }

    @Test func encodesNullableFieldsAsNullAndOmitsAbsentOptionals() throws {
        let n = Node(key: "k", parent: nil, role: "AXButton")
        let obj = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(n)) as! [String: Any]
        #expect(Set(obj.keys) == ["key", "parent", "role"])
        #expect(obj["parent"] is NSNull)
    }
}
