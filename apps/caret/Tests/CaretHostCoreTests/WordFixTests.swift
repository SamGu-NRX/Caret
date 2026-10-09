import CaretHostCore
import XCTest

/// Brief item 5: the word being typed is checked as soon as it is closed, not only at the end of its
/// sentence, so its fix is one Tab away while the user is still there.
final class WordFixTests: XCTestCase {
    func span(_ word: String, in text: String) -> UTF16Span {
        UTF16Span((text as NSString).range(of: word, options: .backwards))
    }

    // MARK: - Which word was just closed

    func testASpaceClosesTheWordBeforeIt() {
        let text = "I will recieve "
        XCTAssertEqual(WordFix.closedWord(previous: "I will recieve", value: text, selection: .caret(15)), span("recieve", in: text))
    }

    func testPunctuationThenASpaceClosesIt() {
        let text = "Thanks, teh, "
        XCTAssertEqual(WordFix.closedWord(previous: "Thanks, teh,", value: text, selection: .caret(13)), span("teh", in: text))
        XCTAssertEqual(WordFix.closedWord(previous: "Thanks, teh", value: "Thanks, teh,", selection: .caret(12)), span("teh", in: text))
    }

    func testAWordClosedInTheMiddleOfTheText() {
        let text = "I teh cat"
        XCTAssertEqual(WordFix.closedWord(previous: "I tehcat", value: text, selection: .caret(6)), UTF16Span(start: 2, end: 5))
    }

    func testAnApostropheIsPartOfTheWord() {
        let text = "it dosen't "
        XCTAssertEqual(WordFix.closedWord(previous: "it dosen't", value: text, selection: .caret(11)), span("dosen't", in: text))
    }

    func testASentenceEndIsLeftToTheSentenceCheck() {
        XCTAssertNil(WordFix.closedWord(previous: "It is teh.", value: "It is teh. ", selection: .caret(11)))
        XCTAssertNil(WordFix.closedWord(previous: "It is teh", value: "It is teh.", selection: .caret(10)))
    }

    func testNothingWhileTheWordIsOpenOrOnDeletionOrASelectionOrAFirstRead() {
        XCTAssertNil(WordFix.closedWord(previous: "I will reci", value: "I will reciv", selection: .caret(12)), "still typing the word")
        XCTAssertNil(WordFix.closedWord(previous: "I will recieve x", value: "I will recieve ", selection: .caret(15)), "deleting back to a space")
        XCTAssertNil(WordFix.closedWord(previous: "I will recieve", value: "I will recieve ", selection: UTF16Selection(start: 7, end: 15)))
        XCTAssertNil(WordFix.closedWord(previous: nil, value: "I will recieve ", selection: .caret(15)))
        XCTAssertNil(WordFix.closedWord(previous: "  ", value: "   ", selection: .caret(3)), "no word before the spaces")
    }

    // MARK: - What may be offered live

    func fix(_ original: String, _ replacement: String, kind: WritingCorrection.Kind = .spelling, needsChoice: Bool = false) -> WritingCorrection {
        WritingCorrection(span: UTF16Span(start: 0, end: UTF16Text.length(original)), original: original, replacement: replacement,
                          kind: kind, reason: "", source: .spellChecker, needsChoice: needsChoice)
    }

    func testAClearSpellingFixIsOfferedLive() {
        XCTAssertTrue(WordFix.offersLive(fix("teh", "the")))
        XCTAssertTrue(WordFix.offersLive(fix("recieve", "receive")))
        XCTAssertTrue(WordFix.offersLive(fix("Wendesday", "Wednesday")))
    }

    func testAFixTheCheckerIsUnsureOfWaitsForTheSentence() {
        XCTAssertFalse(WordFix.offersLive(fix("adress", "address", needsChoice: true)))
    }

    func testOnlySpellingIsOfferedLive() {
        XCTAssertFalse(WordFix.offersLive(fix("is", "are", kind: .grammar)))
    }

    func testAFarGuessIsNotOfferedLive() {
        // KeyType's cap (ADR-108): two edits up to eight letters, three beyond.
        XCTAssertFalse(WordFix.offersLive(fix("thx", "thanks")), "three edits on a short word")
        XCTAssertTrue(WordFix.offersLive(fix("acommodation", "accommodation")))
        XCTAssertFalse(WordFix.offersLive(fix("relevnt", "irrelevant")))
    }

    func testEditDistanceIgnoresCase() {
        XCTAssertEqual(WordFix.editDistance("Teh", "the"), 2)
        XCTAssertEqual(WordFix.editDistance("cat", "cat"), 0)
        XCTAssertEqual(WordFix.editDistance("", "abc"), 3)
    }

    // MARK: - Which words a live fix may touch

    func eligible(_ word: String, in text: String) -> Bool {
        WordFix.eligible(span(word, in: text), in: text)
    }

    func testOrdinaryWordsAndContractionsAreEligible() {
        XCTAssertTrue(eligible("recieve", in: "I will recieve it"))
        XCTAssertTrue(eligible("Wendesday", in: "See you Wendesday "))
        XCTAssertTrue(eligible("dosen't", in: "it dosen't "))
    }

    func testShortLongNumericAndOddWordsAreNot() {
        XCTAssertTrue(eligible("teh", in: "x teh "), "three letters is the minimum")
        XCTAssertFalse(eligible("ot", in: "I ot "))
        XCTAssertFalse(eligible("abc1", in: "see abc1 "))
        XCTAssertFalse(eligible("'tis", in: "and 'tis "), "a leading quote")
    }

    func testAcronymsCamelCaseAndAddressesAreNot() {
        XCTAssertFalse(eligible("NASA", in: "at NASA "))
        XCTAssertFalse(eligible("iPhone", in: "my iPhone "))
        XCTAssertFalse(eligible("exmaple", in: "mail me at sam@exmaple.com "))
        XCTAssertFalse(eligible("exmaple", in: "go to https://exmaple "))
        XCTAssertFalse(eligible("nmae", in: "the file_nmae "))
        XCTAssertFalse(eligible("exmaple", in: "open exmaple.org "))
    }
}
