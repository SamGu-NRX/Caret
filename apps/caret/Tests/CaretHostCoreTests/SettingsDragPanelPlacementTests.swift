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
}
