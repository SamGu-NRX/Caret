import CaretHostCore
import XCTest

final class GhostFitTests: XCTestCase {
    func testACompletionThatFitsIsDrawnAsPlaced() {
        for rule in [GhostFit.OverflowRule.capsule, .drop] {
            XCTAssertEqual(GhostFit.decide(inlineOverflows: false, mirrorOverflows: false, canMirror: false, rule: rule), .asPlaced)
        }
    }

    func testAnOverflowingCompletionGoesInTheCapsule() {
        XCTAssertEqual(GhostFit.decide(inlineOverflows: true, mirrorOverflows: false, canMirror: false, rule: .capsule), .capsule)
    }

    func testDropKeepsKeyTypesRuleAndNamesTheCause() {
        XCTAssertEqual(GhostFit.decide(inlineOverflows: true, mirrorOverflows: false, canMirror: false, rule: .drop), .decline(.singleLineOverflow))
    }

    func testAMirrorOverflowIsDeclinedUnderEitherRule() {
        for rule in [GhostFit.OverflowRule.capsule, .drop] {
            XCTAssertEqual(GhostFit.decide(inlineOverflows: true, mirrorOverflows: true, canMirror: false, rule: rule), .decline(.mirrorOverflow))
        }
    }

    func testTheTextMirrorHandlesItsOwnOverflow() {
        XCTAssertEqual(GhostFit.decide(inlineOverflows: true, mirrorOverflows: true, canMirror: true, rule: .drop), .asPlaced)
    }

    func testARecordCarriesGeometryAndNoText() throws {
        let record = GhostFit.Record(outcome: .declined, cause: .singleLineOverflow, textWidth: 88, room: 3, fieldHeight: 24, caretQuality: "exact")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["outcome", "cause", "textWidth", "room", "fieldHeight", "caretQuality"])
    }
}
