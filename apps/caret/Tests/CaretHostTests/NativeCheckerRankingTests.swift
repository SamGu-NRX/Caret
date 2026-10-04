import CaretHostCore
import XCTest
@testable import CaretHost

/// The two lead decisions of 2026-10-04 on what the system checker's answers mean, as pure
/// functions: which guess is the fix, and which Englishes count as spelled right.
final class NativeCheckerRankingTests: XCTestCase {
    func testTheFirstGuessIsTheFix() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "recieve", autocorrection: "receive", lists: [["receive", "relieve"]]))
        XCTAssertEqual(ranked.fix, "receive")
        XCTAssertEqual(ranked.others, ["relieve"])
        XCTAssertFalse(ranked.needsChoice)
    }

    /// T1's corpus case: in "Can you adress the feedback", macOS 26.6 guessed "address" first and
    /// autocorrected to "dress", its second guess.
    func testAnAutocorrectionInATopThreeThatDisagreesNeedsAChoice() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "dress", lists: [["address", "dress", "dares", "a-dress"]]))
        XCTAssertEqual(ranked.fix, "address")
        XCTAssertEqual(ranked.others, ["dress", "dares"])
        XCTAssertTrue(ranked.needsChoice)
        let third = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "dares", lists: [["address", "dress", "dares"]]))
        XCTAssertEqual(third.others, ["dares", "dress"], "the answer that disagrees leads the alternatives")
        XCTAssertTrue(third.needsChoice)
    }

    func testAnAutocorrectionOutsideEveryTopThreeIsIgnored() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "a dress", lists: [["address", "dares", "dress", "a dress"]]))
        XCTAssertEqual(ranked.fix, "address")
        XCTAssertEqual(ranked.others, ["dares", "dress"])
        XCTAssertFalse(ranked.needsChoice)
    }

    func testAnAutocorrectionWithNoGuessOffersNothing() {
        XCTAssertNil(NativeChecker.rankGuesses(word: "zzq", autocorrection: "zap", lists: [[]]))
        XCTAssertNil(NativeChecker.rankGuesses(word: "zzq", autocorrection: nil, lists: [["zzq"], []]))
    }

    /// The lead's rerun at 3887f61: macOS ranked "a-dress" first for "adress". A fix that splits the
    /// word never stands alone while a one-word guess is in reach, so Tab cannot apply it unseen.
    func testAFixThatSplitsTheWordNeedsAChoiceWithTheWholeWord() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: "dress", lists: [["a-dress", "address", "dress"]]))
        XCTAssertEqual(ranked.fix, "a-dress")
        XCTAssertTrue(ranked.needsChoice)
        XCTAssertEqual(ranked.others, ["address", "dress"])
        let noAuto = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: nil, lists: [["a dress", "dares", "address"]]))
        XCTAssertTrue(noAuto.needsChoice)
        XCTAssertEqual(noAuto.others, ["dares", "address"], "every one-word guess in reach, in merged order")
    }

    /// Lists from more than one dictionary: the checking language's first, ties to it.
    func testTheMergeIsDeterministicWithThePrimaryListFirst() throws {
        let lists = [["address", "dress"], ["dares", "address"], ["address"]]
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: nil, lists: lists, primaryAccepts: { _ in true }))
        XCTAssertEqual(ranked.fix, "address", "position 0 in the primary list beats position 0 in a later one")
        XCTAssertTrue(ranked.needsChoice, "en-GB's first guess is a different word the checking language accepts")
        XCTAssertEqual(ranked.others, ["dares", "dress"])
        for _ in 0..<20 {
            let again = NativeChecker.rankGuesses(word: "adress", autocorrection: nil, lists: lists, primaryAccepts: { _ in true })
            XCTAssertEqual(again?.fix, ranked.fix)
            XCTAssertEqual(again?.others, ranked.others)
        }
    }

    /// When the primary list is the one that slipped, another dictionary's first guess is still
    /// offered: the real correction in any accepted dictionary's top three reaches the choice.
    func testAnotherDictionarysFirstGuessReachesTheChoice() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(word: "adress", autocorrection: nil, lists: [["a-dress"], ["address"], ["address"]]))
        XCTAssertEqual(ranked.fix, "a-dress")
        XCTAssertTrue(ranked.needsChoice)
        XCTAssertEqual(ranked.others, ["address"])
    }

    /// en-GB's "organisation" for "organizaton" is the same word in another spelling: no choice
    /// for a writer the checking language (en-US) serves.
    func testARegionalSpellingOfTheSameWordIsNoDisagreement() throws {
        let ranked = try XCTUnwrap(NativeChecker.rankGuesses(
            word: "organizaton", autocorrection: nil, lists: [["organization"], ["organisation"], ["organization"]],
            primaryAccepts: { $0 != "organisation" }
        ))
        XCTAssertEqual(ranked.fix, "organization")
        XCTAssertFalse(ranked.needsChoice)
        XCTAssertEqual(ranked.others, ["organisation"])
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
