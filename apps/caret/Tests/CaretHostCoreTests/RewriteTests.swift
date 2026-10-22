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

final class RewriteSpanTests: XCTestCase {
    func text(_ value: String, _ span: UTF16Span?) -> String? {
        span.flatMap { UTF16Text.slice(value, start: $0.start, end: $0.end) }
    }

    func testTheSentenceTheCaretIsIn() {
        let v = "Thanks for the notes. I think we should wait until Friday. See you then."
        let caret = (v as NSString).range(of: "should").location
        XCTAssertEqual(text(v, RewriteSpan.at(value: v, selection: .caret(caret))), "I think we should wait until Friday.")
    }

    func testTheSentenceJustEnded() {
        let v = "Thanks for the notes. I think we should wait."
        XCTAssertEqual(text(v, RewriteSpan.at(value: v, selection: .caret(v.utf16.count))), "I think we should wait.")
        let spaced = v + " "
        XCTAssertEqual(text(spaced, RewriteSpan.at(value: spaced, selection: .caret(spaced.utf16.count))), "I think we should wait.")
    }

    func testASentenceStillBeingWritten() {
        let v = "Thanks for the notes.\nI think we should"
        XCTAssertEqual(text(v, RewriteSpan.at(value: v, selection: .caret(v.utf16.count))), "I think we should")
    }

    func testTheSelectionWithoutItsOuterSpaces() {
        let v = "Please send the updated numbers soon."
        let r = (v as NSString).range(of: " send the updated numbers ")
        XCTAssertEqual(text(v, RewriteSpan.at(value: v, selection: UTF16Selection(start: r.location, end: r.location + r.length))), "send the updated numbers")
    }

    func testNothingToRewrite() {
        XCTAssertNil(RewriteSpan.at(value: "", selection: .caret(0)))
        XCTAssertNil(RewriteSpan.at(value: "Hi.", selection: .caret(3)), "one word")
        let long = String(repeating: "word ", count: 100) + "end."
        XCTAssertNil(RewriteSpan.at(value: long, selection: .caret(long.utf16.count)), "longer than the limit")
    }
}

final class RewriteOfferTests: XCTestCase {
    let value = "Thanks. Can you send me the numbers? Bye."
    var live: RangeEdit.Live {
        RangeEdit.Live(target: TargetIdentity(pid: 1, bundleID: "b", windowID: "w", elementID: "e", elementRevision: UTF16Text.digest(value)),
                       value: value, selection: .caret(36))
    }
    var span: UTF16Span { UTF16Span((value as NSString).range(of: "Can you send me the numbers?")) }

    func testOpensWithTheFirstRewriteHighlightedAndOriginalLast() throws {
        let offer = try XCTUnwrap(WritingOffer.rewrite(span: span, rewrites: ["Could you send me the numbers?", "Can I get the numbers?"], live: live))
        XCTAssertEqual(offer.presentation, .expanded)
        XCTAssertEqual(offer.producer, .explicitRequest)
        XCTAssertEqual(offer.alternatives.map(\.kind), [.rewrite, .rewrite, .original])
        XCTAssertEqual(offer.alternatives.last?.detail, "Can you send me the numbers?")
        XCTAssertEqual(offer.current, 0)
        XCTAssertTrue(offer.ownsTab)
    }

    func testArrowsMoveTabTakesEscKeepsTheOriginal() throws {
        var offer = try XCTUnwrap(WritingOffer.rewrite(span: span, rewrites: ["Could you send me the numbers?", "Can I get the numbers?"], live: live))
        XCTAssertEqual(offer.send(.down), .handled)
        guard case .apply(let edit) = offer.send(.tab) else { return XCTFail("Tab applies the highlighted rewrite") }
        XCTAssertEqual(edit.replacement, "Can I get the numbers?")
        XCTAssertEqual(edit.replace, span)
        var again = try XCTUnwrap(WritingOffer.rewrite(span: span, rewrites: ["Could you send me the numbers?"], live: live))
        XCTAssertEqual(again.send(.escape), .dismiss)
        _ = again.send(.down)
        XCTAssertEqual(again.send(.tab), .keepOriginal, "Original changes nothing")
    }

    func testNoValidRewriteMakesNoOffer() {
        XCTAssertNil(WritingOffer.rewrite(span: span, rewrites: [], live: live))
        XCTAssertNil(WritingOffer.rewrite(span: span, rewrites: ["Can you send me the numbers?"], live: live), "the same text is no change")
    }

    func testTheToastNamesTheNewWording() throws {
        let offer = try XCTUnwrap(WritingOffer.rewrite(span: span, rewrites: ["Could you send me the numbers?"], live: live))
        let toast = try XCTUnwrap(WritingOffer.toast(after: offer.alternatives[0]))
        XCTAssertEqual(toast.lead, "Rewritten")
        XCTAssertEqual(toast.text, "“Could you send me the numbers?”", "short enough to quote whole")
        XCTAssertEqual(WritingCopy.rewrittenAs("I'm sorry for the delayed response; I was out of the office."), "“I'm sorry for the delayed…”")
        XCTAssertEqual(toast.hints.first?.key, "⌘Z")
    }
}
