import CaretHostCore
import XCTest

/// The static writing rules, one clear case per rule and the near misses each must leave alone.
final class WritingCheckTests: XCTestCase {
    /// Checks the last sentence of `text` (or all of it), returning (original, replacement, rule).
    private func fixes(_ text: String, language: String = "en", whole: Bool = false) -> [(String, String, WritingRule?)] {
        let sentence = whole
            ? UTF16Span(start: 0, end: UTF16Text.length(text))
            : WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        return WritingCheck.check(text, sentence: sentence, language: language).map { c in
            if case .rule(let rule) = c.source { return (c.original, c.replacement, rule) }
            return (c.original, c.replacement, nil)
        }
    }

    private func assertFix(_ text: String, _ original: String, _ replacement: String, _ rule: WritingRule, language: String = "en", file: StaticString = #filePath, line: UInt = #line) {
        let found = fixes(text, language: language)
        XCTAssertEqual(found.count, 1, "\(text): \(found)", file: file, line: line)
        XCTAssertEqual(found.first?.0, original, text, file: file, line: line)
        XCTAssertEqual(found.first?.1, replacement, text, file: file, line: line)
        XCTAssertEqual(found.first?.2, rule, text, file: file, line: line)
    }

    private func assertClean(_ text: String, language: String = "en", file: StaticString = #filePath, line: UInt = #line) {
        let found = fixes(text, language: language)
        XCTAssertTrue(found.isEmpty, "\(text) should be clean: \(found)", file: file, line: line)
    }

    // MARK: Repeated words

    func testRepeatedWord() {
        assertFix("I went to the the store.", "the the", "the", .doubledWord)
        assertFix("The the cat sat down.", "The the", "The", .doubledWord)
        assertFix("We can can meet later.", "can can", "can", .doubledWord)
    }

    func testRepeatsThatAreMeant() {
        assertClean("He had had enough of it.")
        assertClean("She said that that was fine.")
        assertClean("Well, well, look who is here.")
        assertClean("We flew to Walla Walla last May.")
        assertClean("It was very very cold.")
        // A line break between them is a layout, not a typo.
        XCTAssertTrue(fixes("Read the\nthe notes.", whole: true).isEmpty)
    }

    // MARK: Spaces

    func testTwoSpacesBetweenWords() {
        assertFix("I went  to the store.", "  ", " ", .doubledSpace)
        assertFix("Je suis  là.", "  ", " ", .doubledSpace, language: "fr")
    }

    func testSpacingThatIsMeant() {
        // Two spaces after a sentence is an old convention; four is alignment; after a colon, a label.
        let afterStop = "It ended.  Then we left."
        XCTAssertTrue(fixes(afterStop, whole: true).isEmpty)
        assertClean("Name:  Dana Reyes")
        assertClean("Total    42 items")
        XCTAssertTrue(fixes("He said \"stop.\"  We did.", whole: true).isEmpty)
    }

    func testSpaceBeforePunctuation() {
        assertFix("Thanks , see you soon.", " ,", ",", .spaceBeforePunctuation)
        assertFix("Are you coming ?", " ?", "?", .spaceBeforePunctuation)
        assertFix("That was close !!", " !!", "!!", .spaceBeforePunctuation)
        assertFix("We are done .", " .", ".", .spaceBeforePunctuation)
    }

    func testSpacesBeforeMarksThatAreMeant() {
        assertClean("Wait for it ...")
        assertClean("It costs .5 more per unit.")
        assertClean("We moved to .NET last year.")
        assertClean("That went well :)")
        assertClean("Vraiment ?", language: "fr")
        assertClean("Nous nous sommes vus hier.", language: "fr")
    }

    // MARK: Capitals

    func testCapitalAfterAFinishedSentence() {
        assertFix("I left early. then it rained.", "then", "Then", .sentenceCapital)
        assertFix("Is it ready? we need it now.", "we", "We", .sentenceCapital)
    }

    func testLowercaseThatIsAStyleOrNotASentence() {
        // A writer who never capitalizes, and a field that starts lowercase, are styles.
        assertClean("i left early. then it rained.")
        assertClean("then it rained.")
        // Abbreviations, initials, ellipses and numbers do not end a sentence.
        assertClean("We met at 3 p.m. then left.")
        assertClean("Bring a snack, e.g. fruit or nuts.")
        assertClean("Call Dr. smith tomorrow.")
        assertClean("He waited... then left.")
        assertClean("See section 4. then read on.")
        assertClean("It works. iPhone owners agree.")
        assertClean("Thanks. @dana will send it.")
    }

    // MARK: A and an

    func testArticleAgainstTheNextSound() {
        assertFix("I ate a apple today.", "a", "an", .article)
        assertFix("It took a hour to fix.", "a", "an", .article)
        assertFix("She attends an university nearby.", "an", "a", .article)
        assertFix("A apple a day is plenty.", "A", "An", .article)
        assertFix("That is a unusual idea.", "a", "an", .article)
        assertFix("We charge an one-time fee.", "an", "a", .article)
        assertFix("Every an user can log in.", "an", "a", .article)
        assertFix("It was an European trip.", "an", "a", .article)
    }

    func testArticleCasesCaretCannotTellOrAreRight() {
        assertClean("It took an hour to fix.")
        assertClean("She attends a university nearby.")
        assertClean("He is an FBI agent.")
        assertClean("He is a FBI agent.")
        assertClean("Add an herb or a herb.")
        assertClean("It was a historic day, an historic day.")
        assertClean("Plan a is fine.")
        assertClean("Choose part a or part b.")
        assertClean("It was a 8-hour day.")
        assertClean("It was an honest mistake.")
        assertClean("Paste a URL here, or a url.")
        assertClean("That was a one-off.")
        assertClean("It is an uninformed guess.")
        assertClean("Use a 'apple' token.")
    }

    func testArticleReasonNamesTheWord() {
        let text = "It took a hour."
        let c = WritingCheck.check(text, sentence: UTF16Span(start: 0, end: UTF16Text.length(text)))
        XCTAssertEqual(c.first?.reason, "“hour” starts with a vowel sound")
        XCTAssertEqual(c.first?.kind, .grammar)
    }

    // MARK: Spans the rules never touch

    func testCodeLinksAndAddressesAreLeftAlone() {
        assertClean("Run `echo  hi` and see.")
        assertClean("if (a == b) { return the the }")
        assertClean("Open https://example.com/the the now")
        assertClean("Ping @dana dana later")
        assertClean("Open /usr/the the folder later")
    }

    // MARK: Ranges

    func testSpansAreUTF16InTheFullText() {
        let text = "👋🏽 Hi. We met at the the café."
        let sentence = WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        XCTAssertEqual(UTF16Text.slice(text, start: sentence.start, end: sentence.end), "We met at the the café.")
        let c = WritingCheck.check(text, sentence: sentence)
        XCTAssertEqual(c.count, 1)
        XCTAssertEqual(UTF16Text.slice(text, start: c[0].span.start, end: c[0].span.end), "the the")
    }

    func testOnlyTheGivenSentenceIsChecked() {
        let text = "I saw the the dog. It ran ."
        let sentence = WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        XCTAssertEqual(fixes(text).map(\.0), [" ."])
        XCTAssertEqual(WritingCheck.check(text, sentence: sentence).allSatisfy { sentence.contains($0.span) }, true)
    }

    func testABadSentenceRangeChecksNothing() {
        let text = "e\u{301}e e"
        // Offset 1 splits "é" from its combining accent.
        XCTAssertTrue(WritingCheck.check(text, sentence: UTF16Span(start: 1, end: 5)).isEmpty)
        XCTAssertTrue(WritingCheck.check(text, sentence: UTF16Span(start: 0, end: 99)).isEmpty)
    }

    // MARK: The last sentence

    func testLastSentenceSkipsTheWordBeingTyped() {
        let text = "Hi there. We was plann"
        let s = WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        XCTAssertEqual(UTF16Text.slice(text, start: s.start, end: s.end), "We was")
    }

    func testLastSentenceAfterAbbreviationsAndLines() {
        let text = "Notes\nDr. Smith said it is fine. "
        let s = WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        XCTAssertEqual(UTF16Text.slice(text, start: s.start, end: s.end), "Dr. Smith said it is fine.")
        XCTAssertNil(WritingCheck.lastSentence(in: "", caret: 0))
        XCTAssertNil(WritingCheck.lastSentence(in: "Hello", caret: 5), "only a word in progress")
    }

    // MARK: Merging producers

    func testMergedPrefersTheFirstListOnOverlap() {
        func c(_ s: Int, _ e: Int, _ r: String) -> WritingCorrection {
            WritingCorrection(span: UTF16Span(start: s, end: e), original: "x", replacement: r, kind: .grammar, reason: "r", source: .spellChecker)
        }
        let merged = WritingCheck.merged([c(0, 3, "a")], [c(2, 5, "b"), c(6, 8, "c")])
        XCTAssertEqual(merged.map(\.replacement), ["a", "c"])
    }

    func testNameLikeWordsAreNotSpellingErrors() {
        XCTAssertTrue(WritingCheck.looksLikeName("Northline", atSentenceStart: false))
        XCTAssertFalse(WritingCheck.looksLikeName("Northline", atSentenceStart: true))
        XCTAssertTrue(WritingCheck.looksLikeName("NASA", atSentenceStart: true))
        XCTAssertTrue(WritingCheck.looksLikeName("iOS", atSentenceStart: true))
        XCTAssertTrue(WritingCheck.looksLikeName("v2beta", atSentenceStart: false))
        XCTAssertFalse(WritingCheck.looksLikeName("recieve", atSentenceStart: false))
    }
}
