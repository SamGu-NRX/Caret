import CoreGraphics
import XCTest
@testable import CaretHostCore

/// The drag panel's place inside System Settings, by T3 Code's numbers.
final class SettingsDragPanelPlacementTests: XCTestCase {
    func testCentredInTheContentColumnNearTheBottom() {
        let settings = CGRect(x: 100, y: 80, width: 900, height: 640)
        let f = SettingsDragPanelPlacement.frame(settings: settings)
        XCTAssertEqual(f.width, 560)
        XCTAssertEqual(f.height, 140)
        XCTAssertEqual(f.minX, 100 + 216 + (900 - 216 - 560) / 2)
        XCTAssertEqual(f.minY, 80 + 640 - 140 - 16)
        XCTAssertTrue(settings.contains(f), "inside the window")
        XCTAssertGreaterThanOrEqual(f.minX, settings.minX + 216, "clear of the sidebar")
    }

    func testANarrowWindowNarrowsThePanel() {
        let settings = CGRect(x: 0, y: 0, width: 600, height: 400)
        let f = SettingsDragPanelPlacement.frame(settings: settings)
        XCTAssertEqual(f.width, 600 - 216 - 32)
        XCTAssertEqual(f.minX, 216 + 16)
    }

    func testPicksSettingsMainWindowOnly() {
        let windows: [SettingsDragPanelPlacement.Window] = [
            .init(ownerPid: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 900, height: 600)),
            .init(ownerPid: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 300, height: 200)),
            .init(ownerPid: 7, layer: 3, bounds: CGRect(x: 0, y: 0, width: 1200, height: 900)),
            .init(ownerPid: 8, layer: 0, bounds: CGRect(x: 0, y: 0, width: 1400, height: 900)),
            .init(ownerPid: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 1000, height: 700), onScreen: false),
        ]
        XCTAssertEqual(SettingsDragPanelPlacement.settingsWindow(in: windows, settingsPid: 7), CGRect(x: 0, y: 0, width: 900, height: 600))
        XCTAssertNil(SettingsDragPanelPlacement.settingsWindow(in: windows, settingsPid: 9))
        XCTAssertNil(SettingsDragPanelPlacement.settingsWindow(in: [.init(ownerPid: 7, layer: 0, bounds: CGRect(x: 0, y: 0, width: 499, height: 600))], settingsPid: 7),
                     "a window under 500x350 is not the pane")
    }

    func testStepsAsideWhileSomethingAsksOverSettings() {
        let settings = CGRect(x: 100, y: 100, width: 900, height: 600)
        let pane = SettingsDragPanelPlacement.Window(ownerPid: 7, layer: 0, bounds: settings, ownerName: "System Settings")
        let sheet = SettingsDragPanelPlacement.Window(ownerPid: 7, layer: 0, bounds: CGRect(x: 420, y: 230, width: 260, height: 340), ownerName: "System Settings")
        let menu = SettingsDragPanelPlacement.Window(ownerPid: 7, layer: 101, bounds: CGRect(x: 500, y: 300, width: 180, height: 60), ownerName: "System Settings")
        let agent = SettingsDragPanelPlacement.Window(ownerPid: 40, layer: 0, bounds: CGRect(x: 300, y: 200, width: 400, height: 300), ownerName: "SecurityAgent")
        let elsewhere = SettingsDragPanelPlacement.Window(ownerPid: 7, layer: 0, bounds: CGRect(x: 1200, y: 100, width: 300, height: 300), ownerName: "System Settings")
        let caret = SettingsDragPanelPlacement.Window(ownerPid: 12, layer: 0, bounds: CGRect(x: 50, y: 50, width: 640, height: 660), ownerName: "Caret")

        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane], settingsPid: 7, settings: settings), "the pane alone")
        XCTAssertTrue(SettingsDragPanelPlacement.somethingAsks(in: [pane, sheet], settingsPid: 7, settings: settings), "System Settings' password sheet")
        XCTAssertTrue(SettingsDragPanelPlacement.somethingAsks(in: [pane, agent], settingsPid: 7, settings: settings), "a password dialog")
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, menu], settingsPid: 7, settings: settings), "a menu over the pane does not hide the panel")
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, elsewhere], settingsPid: 7, settings: settings), "a window clear of the pane")
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, caret], settingsPid: 7, settings: settings), "another app's window is not asking")
        var hidden = sheet
        hidden.onScreen = false
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, hidden], settingsPid: 7, settings: settings))
        var clear = sheet
        clear.alpha = 0
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, clear], settingsPid: 7, settings: settings), "listed at alpha 0 shows nothing")
        let spentAlert = SettingsDragPanelPlacement.Window(ownerPid: 41, layer: 0, bounds: CGRect(x: 500, y: 300, width: 260, height: 300), ownerName: "universalAccessAuthWarn")
        XCTAssertFalse(SettingsDragPanelPlacement.somethingAsks(in: [pane, spentAlert], settingsPid: 7, settings: settings),
                       "macOS keeps the answered Accessibility alert's window listed over the pane")
    }
}
