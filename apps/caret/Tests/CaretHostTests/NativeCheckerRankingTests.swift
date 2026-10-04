import CaretHostCore
import XCTest
@testable import CaretHost

/// The two lead decisions of 2026-10-04 on what the system checker's answers mean, as pure
/// functions: which guess is the fix, and which Englishes count as spelled right.
final class NativeCheckerRankingTests: XCTestCase {
    func testTheFirstGuessIsTheFix() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "recieve", autocorrection: "receive", guesses: ["receive", "relieve"]))
        XCTAssertEqual(ranked.fix, "receive")
        XCTAssertEqual(ranked.others, ["relieve"])
        XCTAssertFalse(ranked.needsChoice)
    }

    /// T1's corpus case: in "Can you adress the feedback", macOS 26.6 guesses "address" first and
    /// autocorrects to "dress", its second guess.
    func testAnAutocorrectionInTheTopThreeThatDisagreesNeedsAChoice() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "dress", guesses: ["address", "dress", "dares", "a-dress"]))
        XCTAssertEqual(ranked.fix, "address")
        XCTAssertEqual(ranked.others, ["dress", "dares"])
        XCTAssertTrue(ranked.needsChoice)
        let third = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "dares", guesses: ["address", "dress", "dares"]))
        XCTAssertEqual(third.others, ["dares", "dress"], "the autocorrection leads the alternatives")
        XCTAssertTrue(third.needsChoice)
    }

    func testAnAutocorrectionOutsideTheTopThreeIsIgnored() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "a dress", guesses: ["address", "dares", "dress", "a dress"]))
        XCTAssertEqual(ranked.fix, "address")
        XCTAssertEqual(ranked.others, ["dares", "dress"])
        XCTAssertFalse(ranked.needsChoice)
    }

    func testAnAutocorrectionWithNoGuessOffersNothing() {
        XCTAssertNil(NativeChecker.rankGuesses(word: "zzq", autocorrection: "zap", guesses: []))
        XCTAssertNil(NativeChecker.rankGuesses(word: "zzq", autocorrection: nil, guesses: ["zzq"]))
    }

    // MARK: - Languages

    /// `NSSpellChecker.availableLanguages` on Sam's Mac (macOS 26.6), English entries.
    let available = ["en", "en_CA", "en_GB", "en_AU", "en_IN", "en_SG", "en_ZA", "en_NZ", "en_JP", "fr", "de"]

    func testAnyEnglishInTheUsersListAcceptsUSBritishAndCanadianSpellings() {
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["en-US"], available: available), ["en", "en_GB", "en_CA"])
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["fr-FR", "en-GB"], available: available), ["en", "en_GB", "en_CA"])
    }

    /// en-AU's dictionary accepts "seperate" and "truely" on macOS 26.6, so it is a witness only for
    /// a user who lists it.
    func testOtherEnglishRegionsCountOnlyWhenListed() {
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["en-AU"], available: available), ["en", "en_GB", "en_CA", "en_AU"])
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["en-US", "en-NZ"], available: available), ["en", "en_GB", "en_CA", "en_NZ"])
    }

    func testAmAgreesOnlyWithI() {
        XCTAssertFalse(NativeChecker.agreesWithSubject("am", before: "Neither of the reports "))
        XCTAssertTrue(NativeChecker.agreesWithSubject("am", before: "Yes, I "))
        XCTAssertTrue(NativeChecker.agreesWithSubject("I am", before: "Tomorrow "))
        XCTAssertFalse(NativeChecker.agreesWithSubject("we am", before: ""))
        XCTAssertTrue(NativeChecker.agreesWithSubject("are", before: "They "), "other verbs are the checker's call")
    }

    func testNoEnglishInTheUsersListAcceptsNone() {
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["fr-FR", "de-DE"], available: available), [])
    }

    func testOnlyVariantsTheCheckerHasAreUsed() {
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["en-US"], available: ["en", "en_GB"]), ["en", "en_GB"])
        XCTAssertEqual(NativeChecker.englishVariants(preferred: ["en-AU"], available: ["en", "en_GB"]), ["en", "en_GB"])
    }

    func testTheCheckingLanguageComesFromTheUsersList() {
        XCTAssertEqual(NativeChecker.checkingLanguage(preferred: ["en-US"], available: available), "en")
        XCTAssertEqual(NativeChecker.checkingLanguage(preferred: ["en-GB"], available: available), "en_GB")
        XCTAssertEqual(NativeChecker.checkingLanguage(preferred: ["fr-CA", "en-US"], available: available), "fr")
        XCTAssertNil(NativeChecker.checkingLanguage(preferred: ["ja-JP"], available: available))
    }
}
