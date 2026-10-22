import CaretScreenCore
import Foundation
import XCTest
@testable import CaretHostCore

/// Brief item 4: personal instructions for the completion prompt: one "about me" for everywhere, and more for one app
/// or one site.
final class PersonalInstructionsTests: XCTestCase {
    // MARK: - What the prompt gets

    func testAboutMeAloneGoesEverywhere() {
        var i = PersonalInstructions()
        i.aboutMe = "I'm Sam, a student. I write short, plain sentences."
        XCTAssertEqual(i.lines(bundleID: "com.apple.mail", origin: nil), ["I'm Sam, a student. I write short, plain sentences."])
        XCTAssertEqual(PersonalInstructions().lines(bundleID: "com.apple.mail", origin: nil), [])
    }

    func testTheAppAndTheSiteComeBeforeAboutMe() {
        var i = PersonalInstructions()
        i.aboutMe = "About me."
        i.setApp("com.tinyspeck.slackmacgap", "Casual, lowercase is fine.")
        i.setSite("https://mail.google.com", "Formal email.")
        XCTAssertEqual(i.lines(bundleID: "com.tinyspeck.slackmacgap", origin: nil), ["Casual, lowercase is fine.", "About me."])
        XCTAssertEqual(i.lines(bundleID: "com.google.Chrome", origin: "https://mail.google.com"), ["Formal email.", "About me."])
    }

    func testTheyFitThePromptsBudgetAboutMeCutAtAWordEnd() {
        var i = PersonalInstructions()
        i.aboutMe = String(repeating: "word ", count: 600)
        i.setApp("com.apple.mail", "Mail rules.")
        let lines = i.lines(bundleID: "com.apple.mail", origin: nil)
        XCTAssertEqual(lines.first, "Mail rules.")
        let total = lines.joined(separator: "\n").count
        XCTAssertLessThanOrEqual(total, PersonalInstructions.promptCharacters)
        XCTAssertTrue(lines.last?.hasSuffix("word") == true, "cut at a word end, without a trailing space")
    }

    // MARK: - What is never kept

    /// `helper/fixtures/sensitive-cases.json` holds the cases the helper's `sensitive.ts` and this port must answer
    /// alike; the helper's memory-documents test reads the same file.
    func testEverySharedSensitiveCaseMatchesTheHelper() throws {
        struct Case: Decodable { let text: String; let kind: String? }
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: repo.appendingPathComponent("helper/fixtures/sensitive-cases.json")))
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            if let kind = c.kind { XCTAssertNotNil(SensitiveKind(rawValue: kind), "\(kind) is a kind the port knows") }
            XCTAssertEqual(SensitiveText.kind(in: c.text)?.rawValue, c.kind, c.text)
        }
    }

    /// A stated secret binds to the first one to three words after "is" or ":", as `statedSecretMatch` does, so a
    /// trailing clause ("put Jordan in Name") is not taken for the secret.
    func testAStatedSecretBindsToItsFirstWords() throws {
        let cases: [(String, SensitiveKind, [String])] = [
            ("my password is hunter22, put Jordan in Name", .password, ["hunter22", "hunter22 put", "hunter22 put jordan"]),
            ("my password for the portal is aaaaaa, put it in Notes", .password, ["aaaaaa", "aaaaaa put", "aaaaaa put it"]),
            ("my password is hunter 22", .password, ["hunter", "hunter 22"]),
            ("My PIN is 7319.", .password, ["7319"]),
        ]
        for (text, kind, candidates) in cases {
            let match = try XCTUnwrap(SensitiveText.statedSecretMatch(text), text)
            XCTAssertEqual(match.kind, kind, text)
            XCTAssertEqual(match.candidates, candidates, text)
        }
    }

    /// A phrase ordinary sentences use ("secret", "pin", "token") states a secret only owned by "my" or "our" and with a
    /// digit in the value's first three words.
    func testACommonPhraseNeedsAnOwnerAndADigit() {
        XCTAssertNil(SensitiveText.statedSecretMatch("my secret is consistency"))
        XCTAssertNil(SensitiveText.statedSecretMatch("the pin is 7319"), "a common phrase owned by \"the\" states nothing")
        XCTAssertNil(SensitiveText.statedSecretMatch("my pin is the one ending 7319"), "the digit is past the first three words")
        XCTAssertEqual(SensitiveText.statedSecretMatch("my pin is code 7319")?.kind, .password)
    }

    /// Value shapes are case-sensitive and run on the text as written: lowercasing first let these through.
    func testValueShapesReadTheTextAsWritten() {
        XCTAssertEqual(SensitiveText.valueKind("key AKIAIOSFODNN7EXAMPLE here"), .apiKey)
        XCTAssertEqual(SensitiveText.valueKind("-----BEGIN OPENSSH PRIVATE KEY-----"), .apiKey)
        XCTAssertNil(SensitiveText.valueKind("akiaiosfodnn7example"))
        XCTAssertNil(SensitiveText.valueKind("gb82 west 1234 5698 7654 32"), "an IBAN is written in capitals")
        XCTAssertEqual(SensitiveText.valueKind("card 4111 1111 1111 1111, order 1234567890123"), .cardNumber, "each digit run is checked on its own")
        XCTAssertNil(SensitiveText.valueKind("order 1234567890123"), "a run that fails Luhn is not a card")
    }

    func testSecretInstructionTextIsRefusedWithoutChangingSavedText() {
        for (text, expected) in [
            ("My password is violet-orchard-seven", SensitiveKind.password),
            ("Credit card number: 4111 1111 1111 1111", .cardNumber),
            ("My API key is sk-live-demo_123456789012", .apiKey),
            ("Verification code: 123456", .oneTimeCode),
        ] {
            var i = PersonalInstructions()
            i.aboutMe = "Keep this ordinary prose."
            XCTAssertEqual(i.setAboutMe(text), expected, text)
            XCTAssertEqual(i.aboutMe, "Keep this ordinary prose.")
            XCTAssertEqual(WritingPage.saveProblem(text), expected.message)
        }
    }

    /// Instructions that only mention a kind, or use a common phrase for something else, are kept.
    func testOrdinaryInstructionTextIsKept() {
        var i = PersonalInstructions()
        for text in ["I write short, plain sentences.", "never suggest passwords", "My secret is consistency."] {
            XCTAssertNil(i.setAboutMe(text), text)
            XCTAssertEqual(i.aboutMe, text)
        }
        XCTAssertNil(i.setApp("com.apple.mail", "Use a direct, friendly tone."))
        XCTAssertEqual(i.apps["com.apple.mail"], "Use a direct, friendly tone.")
    }

    func testEmptyTextRemovesAnAppOrSite() {
        var i = PersonalInstructions()
        i.setApp("com.apple.mail", "x")
        i.setApp("com.apple.mail", "   ")
        i.setSite("https://mail.google.com", "y")
        i.setSite("https://mail.google.com", "")
        XCTAssertEqual(i, PersonalInstructions())
    }

    func testOnlyRealAppsAndSitesAreKept() {
        var i = PersonalInstructions()
        i.setApp("not an app", "x")
        i.setSite("mail.google.com", "y")
        XCTAssertEqual(i, PersonalInstructions())
    }

    // MARK: - The settings file

    func testInstructionsAreWrittenOnlyWhenSetAndReadBack() throws {
        var s = CaretSettings()
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(s), as: UTF8.self).contains("instructions"))
        s.instructions.aboutMe = "About me."
        s.instructions.setApp("com.apple.mail", "Mail.")
        let back = try JSONDecoder().decode(CaretSettings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.instructions, s.instructions)
    }

    func testAMalformedEntryRefusesTheFile() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(CaretSettings())) as! [String: Any]
        object["instructions"] = ["aboutMe": "", "apps": ["bad id": "x"], "sites": [:] as [String: String]]
        XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    // MARK: - The debug socket never shows them

    func testTheSettingsReplyCarriesLengthsNotText() throws {
        var s = CaretSettings()
        s.instructions.aboutMe = "Private words"
        s.instructions.setSite("https://mail.google.com", "More private words")
        let info = DebugState.SettingsInfo(path: "/tmp/s.json", error: nil, settings: s, gate: s.gate)
        let json = String(decoding: try JSONEncoder().encode(info), as: UTF8.self)
        XCTAssertFalse(json.contains("Private words"))
        XCTAssertFalse(json.contains("More private words"))
        XCTAssertTrue(json.contains("13 characters"), json)
    }
}
