import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// A value question on the desk: its renders against their references, light and dark (as it opens with nothing
/// highlighted, with the value read from a window highlighted, and a list long enough to scroll, cut at the rows'
/// cap), and the height its rows give the panel, which `HostedPanel.measure` reads from a fresh hosting view.
@MainActor
final class AskValuesRenderTests: XCTestCase {
    func testValueQuestionStatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.askValues())
    }

    private func rowsHeight(_ ask: AskQuestion, offscreen: Bool) -> CGFloat {
        let rows = AskValueRows(question: AskCaret.Question(ask: ask), onChoose: { _ in })
            .frame(width: 400)
            .environment(\.rendersOffscreen, offscreen)
        return NSHostingView(rootView: rows).fittingSize.height
    }

    /// Three rows (two values over their sources, and Leave blank) take their own height, on screen as off it: the
    /// scroll view hugs them rather than reporting a viewport of its own.
    func testAShortListTakesItsRowsHeight() {
        let onScreen = rowsHeight(Gallery.askValueQuestion(), offscreen: false)
        XCTAssertEqual(onScreen, rowsHeight(Gallery.askValueQuestion(), offscreen: true), accuracy: 0.5)
        XCTAssertGreaterThan(onScreen, 3 * 18, "three rows, each at least 18 pt of text")
        XCTAssertLessThan(onScreen, AskValueRows.maxHeight)
    }

    /// Seven values over their sources and Leave blank run past the cap at 400 pt (about 40 pt a row), so the panel
    /// gets the cap and the rows scroll inside it.
    func testAnOverflowingListStopsAtTheCap() {
        XCTAssertEqual(rowsHeight(Gallery.askValueQuestion(long: true), offscreen: false), AskValueRows.maxHeight, accuracy: 0.5)
        XCTAssertEqual(rowsHeight(Gallery.askValueQuestion(long: true), offscreen: true), AskValueRows.maxHeight, accuracy: 0.5)
    }
}
