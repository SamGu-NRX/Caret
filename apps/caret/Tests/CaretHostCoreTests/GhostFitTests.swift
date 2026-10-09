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

    // MARK: - Words that fit a single-line field (longer suggestions, brief item 1)

    /// One point per character: `fits` says whether a text fits `room` points.
    func fits(_ room: Int) -> (String) -> Bool { { $0.count <= room } }

    func testASuggestionThatFitsIsKeptWhole() {
        XCTAssertEqual(GhostFit.wordsThatFit(" to the team", fits: fits(40)), " to the team")
    }

    func testAnOverflowingSuggestionIsCutAtTheLastWholeWordThatFits() {
        XCTAssertEqual(GhostFit.wordsThatFit(" to the team by Friday", fits: fits(9)), " to the")
        XCTAssertEqual(GhostFit.wordsThatFit(" to the team by Friday", fits: fits(7)), " to the", "the word may end exactly at the edge")
        XCTAssertEqual(GhostFit.wordsThatFit(" to the team by Friday", fits: fits(6)), " to")
    }

    func testTheRestOfAWordBeingTypedCountsAsAWord() {
        XCTAssertEqual(GhostFit.wordsThatFit("ing the report", fits: fits(8)), "ing the")
        XCTAssertEqual(GhostFit.wordsThatFit("ing the report", fits: fits(3)), "ing")
    }

    func testNothingWhenNotEvenTheFirstWordFits() {
        XCTAssertNil(GhostFit.wordsThatFit(" tomorrow", fits: fits(4)))
        XCTAssertNil(GhostFit.wordsThatFit("", fits: fits(4)))
    }

    func testACutNeverEndsInSpaceAndKeepsPunctuationWithItsWord() {
        XCTAssertEqual(GhostFit.wordsThatFit(" well,  thanks again.", fits: fits(9)), " well,")
        XCTAssertEqual(GhostFit.wordsThatFit(" well,  thanks again.", fits: fits(15)), " well,  thanks")
    }
}
