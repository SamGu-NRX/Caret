import CaretHostCore
import XCTest
@testable import CaretHost

/// H14: the Sites tab's two switches change the settings file the way the window saves them, and the next launch
/// reads them back.
@MainActor
final class SwitchesH14Tests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-switches-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private var path: String { dir.appendingPathComponent("settings.json").path }

    func testTheDefaultsAreWebPagesAndRichEditorsOn() {
        let s = SettingsStore(path: path).settings
        XCTAssertTrue(s.pageInlineText)
        XCTAssertTrue(s.pageInlineContentEditable)
    }

    func testEachSwitchIsWrittenAndReadBackByTheNextLaunch() throws {
        let store = SettingsStore(path: path)
        store.update(source: .menu, try XCTUnwrap(MemoryController.settingsChange(for: .pageInlineText(false))))
        XCTAssertFalse(SettingsStore(path: path).settings.pageInlineText)
        store.update(source: .menu, try XCTUnwrap(MemoryController.settingsChange(for: .pageInlineContentEditable(true))))
        store.update(source: .menu, try XCTUnwrap(MemoryController.settingsChange(for: .pageInlineText(true))))
        let next = SettingsStore(path: path)
        XCTAssertNil(next.loadError)
        XCTAssertTrue(next.settings.pageInlineText)
        XCTAssertTrue(next.settings.pageInlineContentEditable)
        store.update(source: .menu, try XCTUnwrap(MemoryController.settingsChange(for: .pageInlineContentEditable(false))))
        XCTAssertFalse(SettingsStore(path: path).settings.pageInlineContentEditable)
    }

    func testNoOtherActionChangesSettingsThroughTheSwitchPath() {
        XCTAssertNil(MemoryController.settingsChange(for: .fileKeep))
        XCTAssertNil(MemoryController.settingsChange(for: .routing(true)))
    }
}
