import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H5's states against their references, light and dark: a control the user sets in the fill
/// preview and on the desk's card, the helper's own sentence on the desk, "Caret can't see this page
/// yet", and the Sites tab of What Caret knows.
@MainActor
final class H5RenderTests: XCTestCase {
    func testH5StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h5())
    }

    /// The line's words are the ones `PageSight` decides with, and VoiceOver hears the button's name.
    func testTheCantSeeLineSaysWhatItDecides() {
        XCTAssertEqual(PageSightView.content.text, "Caret can't see this page yet.")
        XCTAssertEqual(PageSight.action, "Add to Chrome…")
        XCTAssertEqual(SlipSpeech.label(PageSightView.content), "Caret can't see this page yet.")
    }
}
