import CaretHostCore
import XCTest

/// Bugs 6 and 7 (A18): ghost text between the user's words.
final class GhostSeamTests: XCTestCase {
    private func refusal(_ completion: String, _ before: String, _ after: String = "") -> GhostSeam.Refusal? {
        GhostSeam.refusal(completion: completion, before: before, after: after)
    }

    func testQ1MidSentenceRepeatOfTheFollowingWordsIsRefused() {
        // shots/s2c-01.png: "examples | feel a bit thin", typed "in section two ".
        XCTAssertEqual(refusal("could be a bit", "The intro and examples in section two ", "feel a bit thin."), .repeatsFollowing)
    }

    func testAWordDoubledAtTheSeamIsRefused() {
        XCTAssertEqual(refusal(" go over", "Could we", " over the intro"), .repeatsFollowing)
        XCTAssertEqual(refusal(" the", "I sent", " the notes"), .repeatsFollowing)
    }

    func testAFillThatLeadsIntoTheFollowingWordsPasses() {
        XCTAssertNil(refusal("notes", "I read your ", " and they were clear."))
        XCTAssertNil(refusal(" week", "We should schedule a call for next", " to go over it."))
        XCTAssertNil(refusal(" in section two", "The intro and examples", " feel a bit thin."))
    }

    func testOnlyTheCaretsLineIsCompared() {
        XCTAssertNil(refusal(" a bit more", "Could you say", "\nIt was a bit long"), "the next line is not what follows")
    }

    func testASentenceEndBeforeWordsThatContinueItIsRefused() {
        XCTAssertEqual(refusal(" today. Then", "I will send it", " to Dana"), .endsSentenceEarly)
        XCTAssertNil(refusal(" today.", "I will send it", " Then we meet."), "a capital may start a new sentence")
    }

    func testQ1CopyOfTheLineAboveIsRefused() {
        // shots/s4b-00.png: the line above ends "3pm PT … budget."; the new line was offered " 3pm PT".
        let before = "Call with Priya Thursday 3pm PT to go over the budget.\nThen a review with Dana on Friday about the budget"
        XCTAssertEqual(refusal(" 3pm PT", before), .copiesEarlierText)
        XCTAssertEqual(refusal(" go over the budget", before), .copiesEarlierText)
    }

    func testCommonPhrasesAndNewWordsAreNotCopies() {
        let before = "Call with Priya Thursday 3pm PT to go over the budget.\nI wanted to ask"
        XCTAssertNil(refusal(" about the", before), "function words only")
        XCTAssertNil(refusal(" about the timeline", before), "not in the line above")
        XCTAssertNil(refusal(" budget", before), "one word without a number is not a copy")
        XCTAssertEqual(refusal(" 3pm", before), .copiesEarlierText, "a number is a fact; one is enough")
    }

    func testOnlyTheNearestLineWithWordsAboveCounts() {
        let before = "Meeting at 3pm PT.\nSecond line.\n\nNow I"
        XCTAssertNil(refusal(" 3pm PT", before), "two lines up is not the line above")
        XCTAssertEqual(refusal(" second line", "Second line.\n\nNow I"), .copiesEarlierText, "blank lines are skipped")
    }

    func testCopyingEarlierOnTheCaretsOwnLineIsRefused() {
        XCTAssertEqual(refusal(" project plan", "the project plan and the"), .copiesEarlierText)
    }

    func testMidLineMeansWordsAfterTheCaret() {
        XCTAssertTrue(GhostSeam.isMidLine(after: " feel a bit thin"))
        XCTAssertFalse(GhostSeam.isMidLine(after: "  \nnext line"))
        XCTAssertFalse(GhostSeam.isMidLine(after: "."))
        XCTAssertTrue(GhostSeam.continuesSentence(after: " 3 more"))
        XCTAssertFalse(GhostSeam.continuesSentence(after: " Then"))
    }

    func testFitIsTheFirstWordAfterTheCaretAboveTheFloor() {
        // dev-run-3: " better" before "than the old one" -1.64; " are a bit" before "feel" -10.05.
        XCTAssertTrue(SuffixFit.fits(withCompletion: [-1.64]))
        XCTAssertFalse(SuffixFit.fits(withCompletion: [-10.05, -0.01]))
        XCTAssertTrue(SuffixFit.fits(withCompletion: [-7.0]), "the floor itself fits")
        XCTAssertFalse(SuffixFit.fits(withCompletion: []), "unscored never fits")
    }
}
