import AppKit
import XCTest
@testable import CaretHost

/// The error figure's color against the surfaces it stands on, by the WCAG relative-luminance
/// formula: a graphic needs 3:1 (WCAG 1.4.11).
final class TokenContrastTests: XCTestCase {
    private func resolved(_ color: NSColor, dark: Bool) throws -> (Double, Double, Double) {
        var out: NSColor?
        NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
            out = color.usingColorSpace(.sRGB)
        }
        let c = try XCTUnwrap(out)
        return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent))
    }

    private func luminance(_ rgb: (Double, Double, Double)) -> Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
    }

    private func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private func gray(_ hex: Double) -> (Double, Double, Double) { (hex / 255, hex / 255, hex / 255) }

    func testTheErrorFigureReachesThreeToOneOnLight() throws {
        let graphite = try resolved(Tokens.graphite, dark: false)
        XCTAssertGreaterThanOrEqual(contrast(graphite, gray(255)), 3, "on white")
        // The light surface is white at 0.94 over whatever is behind it; over black that is #F0F0F0.
        XCTAssertGreaterThanOrEqual(contrast(graphite, gray(240)), 3, "on the light surface over a dark window")
    }

    func testTheErrorFigureReachesThreeToOneOnDark() throws {
        let graphite = try resolved(Tokens.graphite, dark: true)
        XCTAssertGreaterThanOrEqual(contrast(graphite, (0x2C / 255.0, 0x2C / 255.0, 0x2E / 255.0)), 3, "on the dark surface")
    }

    func testTheErrorFigureStaysLighterThanSecondaryText() throws {
        // Graphite is a figure, not text: it must not read as the secondary words beside it.
        XCTAssertGreaterThan(luminance(try resolved(Tokens.graphite, dark: false)), luminance(try resolved(Tokens.secondary, dark: false)))
    }
}

/// Clicking the perch or the activity list must leave the app being typed in key and frontmost.
/// The events are built in process and handed to the panel; nothing is posted to the system and
/// no window is ordered on screen.
@MainActor
final class PanelFocusTests: XCTestCase {
    private func click(_ window: NSWindow) {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = NSEvent.mouseEvent(
                with: type, location: NSPoint(x: 4, y: 4), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1
            )
            if let event { window.sendEvent(event) }
        }
    }

    func testThePerchNeverBecomesKeyOrMainWhenClicked() {
        let panel = PerchPanel.make()
        XCTAssertFalse(panel.canBecomeKey)
        XCTAssertFalse(panel.canBecomeMain)
        XCTAssertTrue(panel.styleMask.contains(.nonactivatingPanel), "a click must not activate Caret")
        click(panel)
        panel.makeKey()
        XCTAssertFalse(panel.isKeyWindow)
        XCTAssertFalse(panel.isMainWindow)
        XCTAssertFalse(NSApp.keyWindow === panel)
    }

    func testTheActivityListTakesClicksWithoutBecomingKey() {
        let list = HostedPanel(radius: 12, interactive: true)
        XCTAssertFalse(list.panel.ignoresMouseEvents, "its buttons take clicks")
        XCTAssertFalse(list.panel.canBecomeKey)
        XCTAssertTrue(list.panel.styleMask.contains(.nonactivatingPanel))
        click(list.panel)
        list.panel.makeKey()
        XCTAssertFalse(list.panel.isKeyWindow)
        XCTAssertFalse(NSApp.keyWindow === list.panel)
    }
}

/// The obstacle probe's grid: a line is sampled as it always was, a card leaves no gap a label
/// could hide in.
final class ObstacleProbeGridTests: XCTestCase {
    func testALineIsProbedOnTwoRowsAndFourColumns() {
        let points = ObstacleProbe.points(in: CGRect(x: 100, y: 200, width: 200, height: 28))
        XCTAssertEqual(points.count, 8)
        XCTAssertEqual(Set(points.map(\.y)), [200 + 28 * 0.2, 200 + 28 * 0.8])
    }

    func testACardHasNoRowGapWiderThanASmallLabel() {
        let card = CGRect(x: 100, y: 200, width: 240, height: 170)
        let rows = Array(Set(ObstacleProbe.points(in: card).map(\.y))).sorted()
        XCTAssertLessThanOrEqual(rows.first! - card.minY, 8)
        XCTAssertLessThanOrEqual(card.maxY - rows.last!, 8)
        for (a, b) in zip(rows, rows.dropFirst()) { XCTAssertLessThanOrEqual(b - a, 14, "a 16 pt label fits in no gap") }
        let columns = Array(Set(ObstacleProbe.points(in: card).map(\.x))).sorted()
        for (a, b) in zip(columns, columns.dropFirst()) { XCTAssertLessThanOrEqual(b - a, 80, "a 110 pt label fits in no gap") }
    }
}
