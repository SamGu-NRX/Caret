import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// The system checker through `NativeChecker`, on fixed English sentences. These run against the
/// real `NSSpellChecker`; they skip only on a Mac without an English dictionary.
@MainActor
final class NativeCheckerTests: XCTestCase {
    let field = NativeChecker.FieldKey(pid: 4242, windowID: "4242-1", elementID: "body")

    override func setUp() async throws {
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
