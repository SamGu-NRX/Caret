import CaretHostCore
import XCTest

/// Marks follow the text between checks, and a check runs only when a sentence has just ended.
final class WritingMarksTests: XCTestCase {
    let field = TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "w1", elementID: "body", elementRevision: "")

    func correction(_ word: String, in text: String, _ replacement: String) -> WritingCorrection {
        WritingCorrection(span: UTF16Span((text as NSString).range(of: word)), original: word, replacement: replacement, kind: .spelling, reason: "", source: .spellChecker)
    }

    func marks(_ text: String, _ found: [WritingCorrection]) -> WritingMarks {
        var m = WritingMarks()
        m.observe(field: field, value: text)
        let sentence = UTF16Span(start: 0, end: UTF16Text.length(text))
        XCTAssertTrue(m.record(found, sentence: sentence, checkedValue: text))
        return m
    }

    // MARK: - Boundaries

    func testASpaceAfterAPeriodEndsASentence() {
        let text = "I will recieve it. "
        XCTAssertEqual(WritingMarks.boundary(previous: "I will recieve it.", value: text, selection: .caret(19)), UTF16Span(start: 0, end: 18))
    }

    func testAReturnAfterAQuestionMarkEndsASentence() {
        XCTAssertNotNil(WritingMarks.boundary(previous: "Can you adress it?", value: "Can you adress it?\n", selection: .caret(19)))
    }

    func testClosingQuotesMayFollowThePunctuation() {
        XCTAssertNotNil(WritingMarks.boundary(previous: "He said “teh end.”", value: "He said “teh end.” ", selection: .caret(19)))
    }

    func testNoBoundaryMidSentenceOrOnDeletionOrWithASelection() {
        XCTAssertNil(WritingMarks.boundary(previous: "I will", value: "I will ", selection: .caret(7)), "a space alone")
        XCTAssertNil(WritingMarks.boundary(previous: "Done. Next", value: "Done. ", selection: .caret(6)), "deleting back to a boundary")
        XCTAssertNil(WritingMarks.boundary(previous: "Done.", value: "Done. ", selection: UTF16Selection(start: 0, end: 6)))
        XCTAssertNil(WritingMarks.boundary(previous: nil, value: "Done. ", selection: .caret(6)), "the first read of a field")
    }

    // MARK: - Following the text

    func testAnEditBeforeAMarkShiftsIt() {
        let text = "We will recieve it. "
        var m = marks(text, [correction("recieve", in: text, "receive")])
        m.observe(field: field, value: "So we will recieve it. ")
        XCTAssertEqual(m.marks.first?.correction.span, UTF16Span(start: 11, end: 18))
    }

    func testAnEditAfterAMarkKeepsIt() {
        let text = "We will recieve it. "
        var m = marks(text, [correction("recieve", in: text, "receive")])
        m.observe(field: field, value: text + "Then")
        XCTAssertEqual(m.marks.first?.correction.span, UTF16Span(start: 8, end: 15))
    }

    func testAnEditInsideOrAgainstAMarkDropsIt() {
        let text = "We will recieve it. "
        var inside = marks(text, [correction("recieve", in: text, "receive")])
        inside.observe(field: field, value: "We will receive it. ")
        XCTAssertEqual(inside.marks, [])
        var against = marks(text, [correction("recieve", in: text, "receive")])
        against.observe(field: field, value: "We will recieved it. ")
        XCTAssertEqual(against.marks, [], "the word was typed on")
    }

    func testAnotherFieldDropsEveryMark() {
        let text = "We will recieve it. "
        var m = marks(text, [correction("recieve", in: text, "receive")])
        var other = field
        other.elementID = "subject"
        XCTAssertTrue(m.observe(field: other, value: text))
        XCTAssertEqual(m.marks, [])
    }

    func testAStaleCheckIsIgnored() {
        var m = WritingMarks()
        m.observe(field: field, value: "Teh end. More")
        let found = [correction("Teh", in: "Teh end. ", "The")]
        XCTAssertFalse(m.record(found, sentence: UTF16Span(start: 0, end: 8), checkedValue: "Teh end. "))
        XCTAssertEqual(m.marks, [])
    }

    func testDeclinedStaysDeclinedWhenFoundAgain() {
        let text = "We will recieve it. "
        var m = marks(text, [correction("recieve", in: text, "receive")])
        m.decline(m.marks[0].correction)
        m.record([correction("recieve", in: text, "receive")], sentence: UTF16Span(start: 0, end: 19), checkedValue: text)
        XCTAssertEqual(m.marks.map(\.declined), [true])
        XCTAssertEqual(m.offerable(caret: 20), [])
    }

    func testOnlyTheCaretsParagraphIsOfferable() {
        let text = "Teh first.\nThe secnd one. "
        let m = marks(text, [correction("Teh", in: text, "The"), correction("secnd", in: text, "second")])
        XCTAssertEqual(m.offerable(caret: UTF16Text.length(text)).map(\.original), ["secnd"])
        XCTAssertEqual(m.offerable(caret: 2).map(\.original), ["Teh"])
    }

    func testOriginalRemovesTheMark() {
        let text = "We will recieve it. "
        var m = marks(text, [correction("recieve", in: text, "receive")])
        m.remove(m.marks[0].correction)
        XCTAssertEqual(m.marks, [])
    }
}
