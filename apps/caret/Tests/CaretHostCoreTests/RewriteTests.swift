import XCTest
@testable import CaretHostCore

final class RewritePromptTests: XCTestCase {
    func testThePromptEndsWhereTheFirstRewriteStarts() {
        let prompt = RewritePrompt.prompt(for: "Can you send the numbers?\nThanks")
        XCTAssertTrue(prompt.hasSuffix("Sentence: Can you send the numbers? Thanks\nRewrite 1:"), "one line, ready for the first rewrite")
        XCTAssertTrue(prompt.hasPrefix(RewritePrompt.header))
    }

    func testParseReadsNumberedLinesInOrder() {
        let text = " Could you send the figures?\nRewrite 2: Can I get the numbers?\nRewrite 3: Send the numbers, please.\n\nSentence: next"
        XCTAssertEqual(RewritePrompt.parse(continuation: text), ["Could you send the figures?", "Can I get the numbers?", "Send the numbers, please."])
    }

    func testParseStopsAtALineOutOfOrder() {
        XCTAssertEqual(RewritePrompt.parse(continuation: " One.\nRewrite 3: Three."), ["One."])
    }

    func testANewlineAloneDoesNotEndTheAnswer() {
        XCTAssertFalse(RewritePrompt.isComplete(continuation: " One.\n"), "the second line has not started")
        XCTAssertFalse(RewritePrompt.isComplete(continuation: " One.\nRewrite 2: Two.\nRewrite 3: Thr"))
        XCTAssertTrue(RewritePrompt.isComplete(continuation: " One.\nRewrite 2: Two.\nRewrite 3: Three.\n"))
        XCTAssertTrue(RewritePrompt.isComplete(continuation: " One.\n\n"), "a blank line ends it")
        XCTAssertTrue(RewritePrompt.isComplete(continuation: " One.\nSentence:"))
    }
}

final class RewriteFilterTests: XCTestCase {
    let original = "Priya mentioned that the vendor might raise prices in March."

    func testARewriteKeepingTheFactsIsOffered() {
        XCTAssertEqual(RewriteFilter.offered(["Priya said the vendor may raise prices in March."], original: original),
                       ["Priya said the vendor may raise prices in March."])
    }

    func testARewriteThatDropsOrChangesAFactIsNot() {
        XCTAssertTrue(RewriteFilter.offered(["Priya mentioned that the vendor could raise prices next month."], original: original).isEmpty)
        XCTAssertTrue(RewriteFilter.offered(["The vendor might raise prices in March, Priya told Dana."], original: original).isEmpty, "a new name")
        XCTAssertTrue(RewriteFilter.offered(["Priya said prices rise 5% in March."], original: original).isEmpty, "a new number")
    }

    func testACapitalAtASentenceStartIsNotAName() {
        XCTAssertTrue(RewriteFilter.keepsFacts("Thanks. Let me know if Priya agrees.", original: "Thanks, let me know if Priya agrees."))
    }

    func testRepeatsTheOriginalAndBlanksAreDropped() {
        let offered = RewriteFilter.offered(
            ["", "Priya mentioned that the vendor might raise prices in March!", "Priya said the vendor may raise prices in March.",
             "priya said the vendor may raise prices in march"],
            original: original
        )
        XCTAssertEqual(offered, ["Priya said the vendor may raise prices in March."])
    }

    func testFarLongerOrShorterIsDropped() {
        XCTAssertTrue(RewriteFilter.offered(["Priya, March."], original: original).isEmpty)
    }
}
