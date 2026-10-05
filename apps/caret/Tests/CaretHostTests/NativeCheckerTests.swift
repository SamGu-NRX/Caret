import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// The system checker's live answers through `NativeChecker`, on fixed English sentences. They do
/// not gate: the checker's ranking moves between runs (the lead's rerun at 3887f61 had "a-dress"
/// first for "adress" where T2's runs had "address"). `CARET_LIVE_SPELLING=1` runs them; the corpus
/// eval (`WritingCorpusTests`) reports the same behavior in numbers. `NativeCheckerTests` gates.
@MainActor
final class NativeCheckerLiveTests: XCTestCase {
    let field = NativeChecker.FieldKey(pid: 4242, windowID: "4242-1", elementID: "body")

    override func setUp() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CARET_LIVE_SPELLING"] == "1", "live checker answers: CARET_LIVE_SPELLING=1")
        try XCTSkipUnless(NativeChecker.supports("en"), "no English spell checking on this Mac")
    }

    private func check(_ text: String, language: String = "en") async -> [WritingCorrection] {
        let checker = NativeChecker()
        let sentence = WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text))!
        guard case .corrections(let found) = await checker.check(text, sentence: sentence, language: language, field: field) else {
            XCTFail("stale with no newer check")
            return []
        }
        return found
    }

    func testAMisspelledWordComesBackWithAFix() async {
        let text = "I will recieve the package tomorrow."
        let found = await check(text)
        let spelling = found.filter { $0.kind == .spelling }
        XCTAssertEqual(spelling.map(\.original), ["recieve"])
        XCTAssertEqual(spelling.first?.replacement, "receive")
        XCTAssertEqual(spelling.first?.reason, WritingCopy.notInDictionary)
        XCTAssertEqual(spelling.first.flatMap { UTF16Text.slice(text, start: $0.span.start, end: $0.span.end) }, "recieve")
    }

    func testEveryResultSpanIsTheTextItNames() async {
        let sentences = [
            "Their going to the libary after lunch.",
            "She dont like the new shedule.",
            "We was planning to meet at the resturant.",
            "He have a apointment on tuesday.",
        ]
        var flagged = 0
        for text in sentences {
            for c in await check(text) {
                flagged += 1
                XCTAssertEqual(UTF16Text.slice(text, start: c.span.start, end: c.span.end), c.original, text)
                XCTAssertNotEqual(c.original, c.replacement, text)
            }
        }
        XCTAssertGreaterThanOrEqual(flagged, 4, "each sentence has a misspelled word")
    }

    func testNamesAndCapitalizedWordsAreLeftAlone() async {
        let found = await check("We met Dana Okafor at Northline yesterday.")
        XCTAssertEqual(found, [])
    }

    func testCommandsMentionsAndMeantRepeatsAreLeftAlone() async {
        for text in [
            "Run pnpm install, then ssh into the box.",
            "Never write “definately” in a report.",
            "What we need is is a plan.",
        ] {
            let found = await check(text)
            XCTAssertEqual(found.filter { $0.kind == .spelling }, [], text)
        }
        let repeated = await check("The answer is is simple.")
        XCTAssertTrue(repeated.isEmpty || repeated.allSatisfy { !WritingCheck.isMeantRepeat($0.original) })
    }

    func testOnlyTheGivenSentenceIsReported() async {
        let text = "Teh first one is here. Teh second one is there."
        let found = await check(text)
        XCTAssertEqual(found.count, 1)
        XCTAssertGreaterThan(found.first?.span.start ?? 0, 20)
    }

    func testLinksAndAddressesAreNotSpellingErrors() async {
        let found = await check("Send it to qwzx@northline.example or see https://qwzxv.example/plz now.")
        XCTAssertEqual(found, [])
    }

    func testANewerCheckOfTheSameFieldMakesTheOlderStale() async {
        let checker = NativeChecker()
        let text = "I will recieve the package tomorrow."
        let sentence = UTF16Span(start: 0, end: UTF16Text.length(text))
        let field = self.field
        let first = Task { await checker.check(text, sentence: sentence, language: "en", field: field) }
        let second = Task { await checker.check(text, sentence: sentence, language: "en", field: field) }
        let a = await first.value, b = await second.value
        XCTAssertEqual(a, .stale)
        guard case .corrections(let found) = b else { return XCTFail("the newer check answers") }
        XCTAssertEqual(found.map(\.original), ["recieve"])
    }



    func testTheLanguageIsPassedPerCheck() async throws {
        try XCTSkipUnless(NativeChecker.supports("fr"), "no French spell checking on this Mac")
        // French passes under French. Under English it passes too on this Mac: with the system's
        // automatic language setting on, the checker identifies the language itself and treats
        // the orthography as a starting point (measured 2026-10-04, macOS 26.6.2).
        let asFrench = await check("Nous sommes heureux de vous voir aujourd'hui.", language: "fr")
        XCTAssertEqual(asFrench.filter { $0.kind == .spelling }, [])
        let typo = await check("Je suis vraimment content.", language: "fr")
        XCTAssertEqual(typo.filter { $0.kind == .spelling }.map(\.original), ["vraimment"])
        XCTAssertEqual(typo.first?.replacement, "vraiment")
    }


    // MARK: - Lead decisions 1 and 2, on the real checker

    /// T1's two false corrections on a clean sentence. Valid in en-GB and en-AU, so any English in
    /// the user's languages accepts them.
    func testRegionalSpellingsAreNotErrors() async throws {
        try XCTSkipUnless(!NativeChecker.englishVariants(preferred: Locale.preferredLanguages, available: NSSpellChecker.shared.availableLanguages).isEmpty,
                          "no English in this Mac's languages")
        let found = await check("The colour palette was finalised in the London office.")
        XCTAssertEqual(found.filter { $0.kind == .spelling }.map(\.original), [])
        let typo = await check("The colour palette was finalisd in the London office.")
        XCTAssertEqual(typo.filter { $0.kind == .spelling }.map(\.original), ["finalisd"], "a real misspelling still shows")
    }

    /// macOS 26.6 autocorrects "adress" here to "dress", and ranks "address" or, in the lead's
    /// rerun, "a-dress" first.
    func testADisagreeingAutocorrectionNeedsAChoice() async throws {
        let found = await check("Can you adress the feedback from Marisol before Friday?")
        let mark = try XCTUnwrap(found.first { $0.original == "adress" })
        // Whatever the checker ranks first today, "address" is offered, and Tab never applies a
        // fix the answers disagree on.
        XCTAssertTrue(([mark.replacement] + mark.otherReplacements).contains("address"), "\(mark)")
        XCTAssertTrue(mark.needsChoice || mark.replacement == "address", "\(mark)")
    }
}

/// `NativeChecker` with the system checker replaced by fixed answers: the order of replies, the
/// document tags, the mapping of results, and lead decisions 1 and 2 end to end. Nothing here asks
/// the live checker for a guess, so its ranking cannot fail the suite.
@MainActor
final class NativeCheckerTests: XCTestCase {
    let field = NativeChecker.FieldKey(pid: 4242, windowID: "4242-1", elementID: "body")

    /// Fixed answers by language: guesses, the autocorrection (any language), and the words each
    /// dictionary accepts. Records the order dictionaries are asked in.
    final class FakeAnswers {
        var guesses: [String: [String]] = [:]
        var autocorrection: String?
        var accepted: [String: Set<String>] = [:]
        var asked: [String] = []

        var answers: NativeChecker.Answers {
            NativeChecker.Answers(
                guesses: { [unowned self] _, _, language, _ in
                    self.asked.append(language)
                    return self.guesses[language] ?? []
                },
                autocorrection: { [unowned self] _, _, _, _ in self.autocorrection },
                accepts: { [unowned self] word, language, _ in self.accepted[language]?.contains(word) ?? false }
            )
        }
    }

    /// A checker whose request flags exactly `word` in `text` as a spelling error.
    func checker(flagging word: String, in text: String, _ fake: FakeAnswers, variants: [String] = ["en", "en_GB", "en_CA"]) -> NativeChecker {
        let range = (text as NSString).range(of: word)
        return NativeChecker(checker: .shared, request: { _, _, _, _, done in
            done([NSTextCheckingResult.spellCheckingResult(range: range)])
        }, answers: fake.answers, variants: variants)
    }

    func corrections(_ checker: NativeChecker, _ text: String) async -> [WritingCorrection] {
        let sentence = UTF16Span(start: 0, end: UTF16Text.length(text))
        guard case .corrections(let found) = await checker.check(text, sentence: sentence, language: "en", field: field) else {
            XCTFail("stale with no newer check")
            return []
        }
        return found
    }

    let adress = "Can you adress the feedback from Marisol before Friday?"

    func testDecisionTwoOffersBothWhenTheAutocorrectionDisagrees() async throws {
        let fake = FakeAnswers()
        fake.guesses = ["en": ["address", "dress", "dares"], "en_GB": ["address", "dares"], "en_CA": ["address"]]
        fake.autocorrection = "dress"
        let found = await corrections(checker(flagging: "adress", in: adress, fake), adress)
        let mark = try XCTUnwrap(found.first)
        XCTAssertEqual(mark.replacement, "address")
        XCTAssertTrue(mark.needsChoice)
        XCTAssertEqual(mark.otherReplacements.first, "dress")
        XCTAssertEqual(fake.asked, ["en", "en_GB", "en_CA"], "the checking language first, then the others in order")
    }

    /// The lead's rerun: the live checker ranked "a-dress" first. The real correction in any
    /// accepted dictionary's top three reaches the choice, and Tab applies nothing.
    func testDecisionTwoOffersTheRealCorrectionWhenThePrimaryListSlips() async throws {
        let fake = FakeAnswers()
        fake.guesses = ["en": ["a-dress", "address", "dress"], "en_GB": ["address", "dress"], "en_CA": ["address"]]
        fake.autocorrection = "dress"
        fake.accepted = ["en": ["address", "dress", "a-dress"]]
        let found = await corrections(checker(flagging: "adress", in: adress, fake), adress)
        let mark = try XCTUnwrap(found.first)
        XCTAssertTrue(mark.needsChoice)
        XCTAssertTrue(([mark.replacement] + mark.otherReplacements).contains("address"), "\(mark)")
    }

    func testAnAgreeingCheckerFixesWithTab() async throws {
        let fake = FakeAnswers()
        fake.guesses = ["en": ["receive", "relieve"], "en_GB": ["receive"], "en_CA": ["receive"]]
        fake.autocorrection = "receive"
        let text = "I will recieve the package tomorrow."
        let found = await corrections(checker(flagging: "recieve", in: text, fake), text)
        let mark = try XCTUnwrap(found.first)
        XCTAssertEqual(mark.replacement, "receive")
        XCTAssertFalse(mark.needsChoice)
    }

    /// Lead decision 1, on T1's two false corrections: a word another accepted English takes is no
    /// error.
    func testDecisionOneAcceptsARegionalSpelling() async {
        let fake = FakeAnswers()
        fake.guesses = ["en": ["color"]]
        fake.accepted = ["en_GB": ["colour", "finalised"]]
        let text = "The colour palette was finalised in the London office."
        let found = await corrections(checker(flagging: "colour", in: text, fake), text)
        XCTAssertEqual(found, [])
    }

    func testDecisionOneNeedsAnEnglishTheUserWrites() async {
        let fake = FakeAnswers()
        fake.guesses = ["en": ["color"]]
        fake.accepted = ["en_AU": ["colour"]]
        let text = "The colour palette was finalised in the London office."
        let found = await corrections(checker(flagging: "colour", in: text, fake, variants: ["en", "en_GB", "en_CA"]), text)
        XCTAssertEqual(found.map(\.original), ["colour"], "en-AU is not asked unless the user lists it")
    }

    /// Replies arrive in the order the test chooses: a check started before its field closed and
    /// reopened answers last, and must come back stale.
    func testAnAnswerFromBeforeAFieldReopenedIsStale() async {
        final class Pending { var replies: [([NSTextCheckingResult]) -> Void] = [] }
        let pending = Pending()
        let checker = NativeChecker(checker: .shared) { _, _, _, _, done in pending.replies.append(done) }
        let text = "Hi. We was here."
        let sentence = UTF16Span(start: 4, end: 16)
        let grammar = NSTextCheckingResult.grammarCheckingResult(range: sentence.nsRange, details: [
            [NSGrammarRange: NSValue(range: NSRange(location: 3, length: 3)), NSGrammarCorrections: ["were"]],
        ])
        let field = self.field
        let old = Task { await checker.check(text, sentence: sentence, language: "en", field: field) }
        while pending.replies.count < 1 { await Task.yield() }
        checker.closeField(field)
        let new = Task { await checker.check(text, sentence: sentence, language: "en", field: field) }
        while pending.replies.count < 2 { await Task.yield() }
        pending.replies[0]([grammar])
        pending.replies[1]([grammar])
        let a = await old.value, b = await new.value
        XCTAssertEqual(a, .stale)
        guard case .corrections(let found) = b else { return XCTFail("the reopened field's own check answers") }
        XCTAssertEqual(found.map(\.original), ["was"])
    }

    func testEachFieldHasItsOwnDocumentTag() {
        let checker = NativeChecker()
        let other = NativeChecker.FieldKey(pid: 4242, windowID: "4242-1", elementID: "subject")
        let a = checker.tag(for: field), b = checker.tag(for: other)
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(checker.tag(for: field), a, "stable while the field is open")
        checker.closeField(field)
        XCTAssertNotEqual(checker.tag(for: field), a, "a closed field starts a new document")
        checker.closeAll()
    }

    /// The mapping alone, on hand-made results: grammar ranges are relative to their sentence
    /// (`NSSpellServer.h`), and a detail without corrections offers nothing.
    func testGrammarDetailRangesAreRelativeToTheirSentence() {
        let text = "Hi. We was here."
        let sentenceRange = NSRange(location: 4, length: 12)
        let result = NSTextCheckingResult.grammarCheckingResult(range: sentenceRange, details: [
            [NSGrammarRange: NSValue(range: NSRange(location: 3, length: 3)), NSGrammarCorrections: ["were"], NSGrammarUserDescription: "Use “were” with “we”."],
            [NSGrammarRange: NSValue(range: NSRange(location: 0, length: 2)), NSGrammarUserDescription: "No fix offered."],
        ])
        let found = NativeChecker.corrections(from: [result], text: text, sentence: UTF16Span(sentenceRange)) { _ in (nil, []) }
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found.first?.original, "was")
        XCTAssertEqual(found.first?.span, UTF16Span(start: 7, end: 10))
        XCTAssertEqual(found.first?.reason, "Use “were” with “we”.")
    }
}
