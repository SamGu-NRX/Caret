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

    func testSharedSensitiveFixturesMatchSwiftDetector() throws {
        struct Case: Decodable { let text: String; let kind: String? }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("helper/fixtures/sensitive-cases.json"))
        for fixture in try JSONDecoder().decode([Case].self, from: data) {
            let actual = PersonalInstructions.refusal(for: fixture.text)?.rawValue
            XCTAssertEqual(actual, fixture.kind.map { $0 == "password" ? "passwords" : $0 == "cardNumber" ? "card numbers" : $0 == "accountNumber" ? "account numbers" : $0 == "governmentId" ? "government ID numbers" : $0 == "oneTimeCode" ? "one-time codes" : "API keys or tokens" }, fixture.text)
        }
    }

    func testSecretInstructionTextIsRefusedWithoutChangingSavedText() {
        for (text, expected) in [
            ("My password is violet-orchard-seven", PersonalInstructions.SaveRefusal.password),
            ("Credit card number: 4111 1111 1111 1111", PersonalInstructions.SaveRefusal.cardNumber),
            ("My API key is sk-live-demo_123456789012", PersonalInstructions.SaveRefusal.apiKey),
            ("One-time code: 123456", PersonalInstructions.SaveRefusal.oneTimeCode)
        ] {
            var i = PersonalInstructions()
            i.aboutMe = "Keep this ordinary prose."
            XCTAssertEqual(i.setAboutMe(text), expected)
            XCTAssertEqual(i.aboutMe, "Keep this ordinary prose.")
            XCTAssertEqual(WritingPage.saveProblem(text), expected.message)
        }
    }

    func testOrdinaryInstructionTextIsKept() {
        var i = PersonalInstructions()
        XCTAssertNil(i.setAboutMe("I write short, plain sentences."))
        XCTAssertEqual(i.aboutMe, "I write short, plain sentences.")
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
