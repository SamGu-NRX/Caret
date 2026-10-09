// Issue #26: which keys count as the user's input on a field, where they are placed, and the wire form the helper
// reads (helper/fixtures/golden/field-input.ndjson, checked against protocol.ts there too).
import CaretScreenCore
import Foundation
import Testing

private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/field-input.ndjson")

@Suite struct FieldInputsTests {
    let window = "5150-7"
    let name = "dev.caret.fixture/standard/textfield:name~0"

    @Test func neverReportsEscWhichStopsTheRun() {
        #expect(FieldInputs.report(keyCode: 53, at: 1, pid: 5150, windowId: window, key: name, focusMoved: false) == nil)
        #expect(FieldInputs.report(keyCode: 53, at: 1, pid: 5150, windowId: nil, key: nil, focusMoved: true) == nil)
    }

    @Test func placesEveryOtherKeyAtTheFocusedElement() {
        // A letter, Return, Space, Delete, an arrow, and Tab itself, which goes to the element it leaves.
        for code: UInt16 in [0, 36, 49, 51, 123, 48] {
            #expect(FieldInputs.report(keyCode: code, at: 7, pid: 5150, windowId: window, key: name, focusMoved: false)
                    == FieldInput(at: 7, pid: 5150, windowId: window, key: name), "key code \(code)")
        }
    }

    // PR #33 review: Caret's own focusing of a field may move focus to another window of the app, so neither is kept.
    @Test func placesAKeyInNoWindowOnceFocusMayHaveMoved() {
        #expect(FieldInputs.movesFocus(keyCode: 48))
        for code: UInt16 in [0, 36, 49, 53, 123] { #expect(!FieldInputs.movesFocus(keyCode: code), "key code \(code)") }
        #expect(FieldInputs.report(keyCode: 0, at: 7, pid: 5150, windowId: window, key: name, focusMoved: true)
                == FieldInput(at: 7, pid: 5150, windowId: nil, key: nil))
    }

    @Test func placesAKeyInNoWindowWhenTheFocusedWindowIsUnknown() {
        #expect(FieldInputs.report(keyCode: 0, at: 7, pid: 5150, windowId: nil, key: name, focusMoved: false)
                == FieldInput(at: 7, pid: 5150, windowId: nil, key: nil))
    }

    @Test func readsAndWritesTheGoldenLinesExactly() throws {
        let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
        let decoded = try lines.map { try JSONDecoder().decode(Message.self, from: $0) }
        let reports = decoded.compactMap { m -> FieldInput? in
            if case .fieldInput(let f) = m { return f }
            return nil
        }
        #expect(reports == [
            FieldInput(at: 1_790_000_000_900, pid: 5150, windowId: window, key: name),
            FieldInput(at: 1_790_000_000_950, pid: 5150, windowId: window, key: nil),
            FieldInput(at: 1_790_000_001_000, pid: 5150, windowId: nil, key: nil),
        ])
        // Unknown places are sent as null, never left out: the helper's schema requires both fields.
        for (line, m) in zip(lines, decoded) {
            let again = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(m)) as? NSDictionary
            let golden = try JSONSerialization.jsonObject(with: line) as? NSDictionary
            #expect(again == golden)
        }
    }

    @Test func refusesALineWithoutItsKeyField() throws {
        let line = Data(#"{"type":"fieldInput","v":1,"at":1,"pid":5150,"windowId":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: line) }
    }
}
