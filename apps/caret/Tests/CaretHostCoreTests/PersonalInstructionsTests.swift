import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Brief item 4: personal instructions for the completion prompt: one "about me" for everywhere, and more for one app
/// or one site. Sam's Cotypist instructions are imported once, read from one key of Cotypist's preferences.
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
        object["instructions"] = ["aboutMe": "", "apps": ["bad id": "x"], "sites": [:] as [String: String], "cotypistChecked": false]
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

    // MARK: - Cotypist's instructions

    func plistDirectory(_ files: [String: [String: Any]]) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cotypist-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        for (name, object) in files {
            try PropertyListSerialization.data(fromPropertyList: object, format: .binary, options: 0).write(to: dir.appendingPathComponent(name))
        }
        return dir
    }

    func testTheUserPromptIsReadFromCotypistsPreferences() throws {
        let dir = try plistDirectory([
            "app.cotypist.Cotypist.plist": ["CompletionManager_userPrompt": "  Fixture: write like me.\n", "SomethingElse": "not read"],
            "com.other.app.plist": ["CompletionManager_userPrompt": "not Cotypist"],
        ])
        XCTAssertEqual(CotypistInstructions.read(preferencesDirectory: dir), "Fixture: write like me.")
    }

    func testNothingWhenTheKeyOrTheFileIsAbsent() throws {
        XCTAssertNil(CotypistInstructions.read(preferencesDirectory: try plistDirectory(["app.cotypist.Cotypist.plist": ["Other": 1]])))
        XCTAssertNil(CotypistInstructions.read(preferencesDirectory: try plistDirectory([:])))
        XCTAssertNil(CotypistInstructions.read(preferencesDirectory: try plistDirectory(["app.cotypist.Cotypist.plist": ["CompletionManager_userPrompt": "   "]])))
    }

    func testImportFillsAnEmptyAboutMeOnceAndNeverOverwrites() {
        var i = PersonalInstructions()
        i.importCotypist("From Cotypist.")
        XCTAssertEqual(i.aboutMe, "From Cotypist.")
        XCTAssertTrue(i.cotypistChecked)
        i.aboutMe = "Mine."
        i.importCotypist("From Cotypist again.")
        XCTAssertEqual(i.aboutMe, "Mine.", "the user's own words stay")
        var none = PersonalInstructions()
        none.importCotypist(nil)
        XCTAssertTrue(none.cotypistChecked, "an absent key is checked once and offers an empty field")
        XCTAssertEqual(none.aboutMe, "")
    }
}
