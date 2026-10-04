import Foundation
import Testing
@testable import CaretScreenCore

/// helper/fixtures/golden/popup-specs.json, the host's golden file copied verbatim. popup.ts and the
/// host's PopupSpecTests run the same file, so the three decoders refuse the same specs the same way.
private let specsURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/popup-specs.json")

private func fixture() throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: specsURL)) as? [String: Any])
}

private func data(_ object: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

@Suite struct PopupSpecGolden {
    @Test func everyValidSpecDecodesAndRoundTrips() throws {
        let valid = try #require(try fixture()["valid"] as? [String: Any])
        #expect(Set(valid.keys) == ["eventCard", "fillPreview", "picker"])
        for (name, raw) in valid {
            let spec = try PopupSpec.decode(data(raw))
            let again = try JSONDecoder().decode(PopupSpec.self, from: JSONEncoder().encode(spec))
            #expect(again == spec, "\(name)")
            // The encoding is the fixture's JSON, not only something that decodes to the same spec.
            let a = try JSONSerialization.jsonObject(with: data(raw)) as! NSDictionary
            let b = try JSONSerialization.jsonObject(with: JSONEncoder().encode(spec)) as! NSDictionary
            #expect(a == b, "\(name) re-encodes differently")
        }
    }

    @Test func everyInvalidSpecIsRefusedWithItsNamedError() throws {
        let invalid = try #require(try fixture()["invalid"] as? [[String: Any]])
        #expect(invalid.count == 13)
        for item in invalid {
            let name = item["name"] as? String ?? "?"
            let expected = item["error"] as? String ?? "?"
            do {
                _ = try PopupSpec.decode(data(item["spec"]!))
                Issue.record("\(name): decoded, expected \(expected)")
            } catch let error as PopupSpecError {
                #expect(error.short == expected, "\(name)")
            }
        }
    }

    @Test func readsTheEventCardAndItsReveal() throws {
        let valid = try #require(try fixture()["valid"] as? [String: Any])
        let card = try PopupSpec.decode(data(valid["eventCard"]!))
        #expect(card.actions.map(\.key) == [.tab, .cmd2])
        #expect(card.numberedDigits == [2] && card.rowCount == 0 && !card.hasDownAction)
        let revealed = card.applyingReveal(of: "changeTime")
        #expect(revealed.actions.map(\.id) == ["add"])
        #expect(revealed.blocks[1].id == "time" && revealed.rowCount == 3 && revealed.choices?.selected == 1)
        #expect(card.applyingReveal(of: "add") == card)
    }

    // CodeRabbit on PR #4: Int(Double) traps on a whole number past Int's range, so a spec like this crashed the reader.
    @Test func aWholeNumberPastIntsRangeIsAnErrorNotACrash() {
        let choices = #"{"type":"choices","selected":1e300,"rows":[{"label":{"text":"Dana Reyes","ref":{"memory":"person-reyes"}}}]}"#
        for spec in [#"{"v":1e300,"id":"x","figure":"offering","blocks":[]}"#, #"{"v":1,"id":"x","figure":"offering","blocks":[\#(choices)]}"#] {
            #expect(throws: PopupSpecError.self, "\(spec)") { try PopupSpec.decode(Data(spec.utf8)) }
        }
    }

    @Test func notJSONIsMalformedAndJSONDecoderSurfacesTheSpecificError() {
        #expect(throws: PopupSpecError.malformedJSON) { try PopupSpec.decode(Data("{".utf8)) }
        let map = Data(#"{"v":1,"id":"x","figure":"offering","blocks":[{"type":"map"}]}"#.utf8)
        #expect(throws: PopupSpecError.unknownBlock(type: "map", path: "blocks[0]")) { try JSONDecoder().decode(PopupSpec.self, from: map) }
    }
}

/// The offer messages run their values, bars and specs through the same parsers, and a refusal
/// comes out as the PopupSpecError itself.
@Suite struct OfferMessagesRefuse {
    private let field = #""field":{"pid":1,"windowId":"1-1","key":"k","frame":null,"window":{"number":null,"title":"T"}}"#

    @Test func aCandidateWithoutARef() {
        let line = Data(#"{"type":"alternatives","v":1,"offerKey":"o","at":1,\#(field),"candidates":[{"text":"Cara Diaz"}],"quoted":false}"#.utf8)
        #expect(throws: PopupSpecError.missingReference(path: "candidates[0]")) { try JSONDecoder().decode(Message.self, from: line) }
        let bare = Data(#"{"type":"alternatives","v":1,"offerKey":"o","at":1,\#(field),"candidates":[{"text":"a","ref":{"memory":"m"}},"b"],"quoted":false}"#.utf8)
        #expect(throws: PopupSpecError.missingReference(path: "candidates[1]")) { try JSONDecoder().decode(Message.self, from: bare) }
        let none = Data(#"{"type":"alternatives","v":1,"offerKey":"o","at":1,\#(field),"candidates":[],"quoted":false}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: none) }
    }

    @Test func anActionLineWithoutATabAction() {
        let line = Data(#"{"type":"action","v":1,"offerKey":"o","at":1,\#(field),"app":"Calendar","endState":{"text":"x","ref":{"memory":"m"}},"actions":[{"id":"add","label":"Add","key":"cmd-1"}]}"#.utf8)
        #expect(throws: PopupSpecError.noPrimaryAction(path: "actions")) { try JSONDecoder().decode(Message.self, from: line) }
        let twice = Data(#"{"type":"action","v":1,"offerKey":"o","at":1,\#(field),"app":"Calendar","endState":{"text":"x","ref":{"memory":"m"}},"actions":[{"id":"add","label":"Add","key":"tab"},{"id":"add","label":"Again","key":"cmd-1"}]}"#.utf8)
        #expect(throws: PopupSpecError.duplicateActionID(path: "actions[1]", id: "add")) { try JSONDecoder().decode(Message.self, from: twice) }
        let noApp = Data(#"{"type":"action","v":1,"offerKey":"o","at":1,\#(field),"app":"","endState":{"text":"x","ref":{"memory":"m"}},"actions":[{"id":"add","label":"Add","key":"tab"}]}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: noApp) }
    }

    @Test func aPopupWhoseSpecIsInvalid() {
        let line = Data(#"{"type":"popup","v":1,"offerKey":"o","at":1,\#(field),"spec":{"v":1,"id":"x","figure":"offering","blocks":[{"type":"header","title":{"text":"t","ref":{"memory":"m"}}}]}}"#.utf8)
        #expect(throws: PopupSpecError.missingBlock("actions")) { try JSONDecoder().decode(Message.self, from: line) }
    }
}
