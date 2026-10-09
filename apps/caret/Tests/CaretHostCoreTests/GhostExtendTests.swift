import XCTest
@testable import CaretHostCore

/// Brief item 1: when a painted suggestion is extended, and when an extension that came back may be drawn.
final class GhostExtendTests: XCTestCase {
    func testASuggestionThatEndsASentenceIsNotExtended() {
        XCTAssertFalse(GhostExtend.shouldExtend(" by Friday.", afterCursor: ""))
        XCTAssertFalse(GhostExtend.shouldExtend(" really?", afterCursor: ""))
        XCTAssertFalse(GhostExtend.shouldExtend("  ", afterCursor: ""))
    }

    func testOneThatStopsMidSentenceAtTheEndOfTheLineIs() {
        XCTAssertTrue(GhostExtend.shouldExtend(" to the team", afterCursor: ""))
        XCTAssertTrue(GhostExtend.shouldExtend(" to the team", afterCursor: "   \nNext paragraph"))
    }

    func testMidLineSuggestionsAreNotExtended() {
        XCTAssertFalse(GhostExtend.shouldExtend(" to the", afterCursor: " team"))
    }

    func testAnExtensionIsDrawnOnlyOnTheUntouchedOfferItWasAskedFor() {
        XCTAssertNil(GhostExtend.refusal(askedFor: 7, current: 7, typedSinceOffer: "", keyedSince: false, sameField: true, more: " by Friday."))
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: 7, typedSinceOffer: "t", keyedSince: false, sameField: true, more: " x"), "typed")
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: 7, typedSinceOffer: "", keyedSince: true, sameField: true, more: " x"), "typed")
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: nil, typedSinceOffer: "", keyedSince: false, sameField: true, more: " x"), "offerGone",
                       "Tab already took what was drawn")
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: 8, typedSinceOffer: "", keyedSince: false, sameField: true, more: " x"), "offerGone")
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: 7, typedSinceOffer: "", keyedSince: false, sameField: false, more: " x"), "fieldMoved")
        XCTAssertEqual(GhostExtend.refusal(askedFor: 7, current: 7, typedSinceOffer: "", keyedSince: false, sameField: true, more: " "), "empty")
    }

    func testTheCapIsTheMeasuredOne() {
        XCTAssertEqual(GhostExtend.tokens, 28)
    }
}
