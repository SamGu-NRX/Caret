import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Brief item 6: which keys take ghost text is a setting with two presets. Caret's (Tab takes the
/// whole suggestion, ⌥→ the next word) stays the default; Cotypist's is Tab for the next word, the
/// key above Tab for the whole suggestion, and ⌥Tab for a real Tab.
final class GhostKeysTests: XCTestCase {
    static let pid = KeyOwnershipTests.pid
    static let grave = KeyStroke(keyCode: KeyStroke.graveKeyCode, text: "`", targetPID: pid)
    static let optionTab = KeyStroke(keyCode: KeyStroke.tabKeyCode, option: true, targetPID: pid)
    static let optionRight = KeyStroke(keyCode: KeyStroke.rightKeyCode, option: true, targetPID: pid)

    func arbiter(_ keys: GhostKeys, aboveTab: Int64 = KeyStroke.graveKeyCode) -> OfferArbiter {
        let arbiter = OfferArbiter(aboveTabKeyCode: aboveTab)
        arbiter.setGhostKeys(keys)
        arbiter.publish(KeyOwnershipTests.ghost())
        return arbiter
    }

    func taken(_ decision: OfferArbiter.Decision, file: StaticString = #filePath, line: UInt = #line) -> String? {
        guard case .consume(let claim) = decision else {
            XCTFail("not taken: \(decision)", file: file, line: line)
            return nil
        }
        return claim.insertionText
    }

    // MARK: - Caret's keys, the default

    func testCaretsKeysAreTheDefault() {
        XCTAssertEqual(CaretSettings().ghostKeys, .caret)
        let plain = OfferArbiter()
        plain.publish(KeyOwnershipTests.ghost())
        XCTAssertEqual(taken(plain.handleKeyDown(.tab(to: Self.pid))), "summary to the team")
    }

    func testCaretsKeysTakeTheWordWithOptionRightAndLeaveTheGraveKeyAlone() {
        XCTAssertEqual(taken(arbiter(.caret).handleKeyDown(Self.optionRight)), "summary")
        let a = arbiter(.caret)
        XCTAssertEqual(a.handleKeyDown(Self.grave), .pass(.dismissed), "a backtick is typing that diverges from the ghost")
        XCTAssertEqual(arbiter(.caret).handleKeyDown(Self.optionTab), .pass(.dismissed), "⌥Tab is the app's, as before")
    }

    // MARK: - Cotypist's keys

    func testCotypistTabTakesTheNextWord() {
        XCTAssertEqual(taken(arbiter(.cotypist).handleKeyDown(.tab(to: Self.pid))), "summary")
    }

    func testCotypistTabTakesLeadingSpacesWithTheWord() {
        let a = OfferArbiter()
        a.setGhostKeys(.cotypist)
        a.publish(KeyOwnershipTests.ghost([" to the team"]))
        XCTAssertEqual(taken(a.handleKeyDown(.tab(to: Self.pid))), " to")
    }

    func testCotypistKeyAboveTabTakesTheWholeSuggestion() {
        XCTAssertEqual(taken(arbiter(.cotypist).handleKeyDown(Self.grave)), "summary to the team")
    }

    func testCotypistOptionTabDismissesAndPassesAPlainTab() {
        let a = arbiter(.cotypist)
        XCTAssertEqual(a.handleKeyDown(Self.optionTab), .pass(.realTab))
        XCTAssertNil(a.snapshot().current)
    }

    func testCotypistOptionRightIsTheAppsWordMotion() {
        let a = arbiter(.cotypist)
        XCTAssertEqual(a.handleKeyDown(Self.optionRight), .pass(.dismissed))
    }

    func testCotypistKeysAreTheAppsWithNothingShown() {
        let a = OfferArbiter()
        a.setGhostKeys(.cotypist)
        XCTAssertEqual(a.handleKeyDown(Self.grave), .pass(.noOffer), "a backtick types normally")
        XCTAssertEqual(a.handleKeyDown(Self.optionTab), .pass(.noOffer))
        XCTAssertEqual(a.handleKeyDown(.tab(to: Self.pid)), .pass(.noOffer))
    }

    func testShiftedGraveIsATildeNotTheAcceptKey() {
        let a = arbiter(.cotypist)
        let tilde = KeyStroke(keyCode: KeyStroke.graveKeyCode, shift: true, text: "~", targetPID: Self.pid)
        XCTAssertEqual(a.handleKeyDown(tilde), .pass(.dismissed))
    }

    func testOnAnISOKeyboardTheSectionKeyIsAboveTab() {
        let section = KeyStroke(keyCode: KeyStroke.isoSectionKeyCode, text: "§", targetPID: Self.pid)
        XCTAssertEqual(taken(arbiter(.cotypist, aboveTab: KeyStroke.isoSectionKeyCode).handleKeyDown(section)), "summary to the team")
        // There, key code 50 sits beside the left Shift and types its own character.
        let iso = arbiter(.cotypist, aboveTab: KeyStroke.isoSectionKeyCode)
        XCTAssertEqual(iso.handleKeyDown(KeyStroke(keyCode: KeyStroke.graveKeyCode, text: "<", targetPID: Self.pid)), .pass(.dismissed))
    }

    func testCotypistTabInOpenAlternativesTakesTheChosenOneWhole() {
        let a = OfferArbiter()
        a.setGhostKeys(.cotypist)
        a.publish(KeyOwnershipTests.ghost(KeyOwnershipTests.four))
        _ = a.handleKeyDown(KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: Self.pid))
        XCTAssertEqual(taken(a.handleKeyDown(.tab(to: Self.pid))), "notes after lunch", "a list row is a choice, taken whole")
    }

    func testTypingTheGhostsHeadStillTypesThroughUnderCotypist() {
        let a = arbiter(.cotypist)
        XCTAssertEqual(a.handleKeyDown(.typing("s", to: Self.pid)), .pass(.typedThrough))
    }

    // MARK: - The setting

    func testSettingsWriteTheKeysOnlyWhenChosen() throws {
        var settings = CaretSettings()
        let plain = String(decoding: try JSONEncoder().encode(settings), as: UTF8.self)
        XCTAssertFalse(plain.contains("ghostKeys"), "a later default reaches a user who never chose")
        settings.ghostKeys = .cotypist
        let data = try JSONEncoder().encode(settings)
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: data).ghostKeys, .cotypist)
    }

    func testSettingsRefuseAnUnknownScheme() throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(CaretSettings())) as! [String: Any]
        object["ghostKeys"] = "vim"
        XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: JSONSerialization.data(withJSONObject: object)))
    }
}
