import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H6's states against their references, light and dark: "When Caret helps" in What Caret knows,
/// an Ask's question on the desk (B29), and the fill slip with ⌘1 Fill all (D2-04).
@MainActor
final class H6RenderTests: XCTestCase {
    func testH6StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h6())
    }

    /// The setting's two choices are the brief's words, and the slip names ⌘1 only when it fills the form.
    func testTheWordsAreTheOnesTheSettingAndTheSlipDecideWith() {
        XCTAssertEqual(RoutingCopy.choice(true), "Caret decides when to help")
        XCTAssertEqual(RoutingCopy.choice(false), "Always suggest as I type")
        XCTAssertEqual(FillOverlay.offerContent(caption: "from Mail", sourceApp: "Mail", fillAll: true).hints.map(\.key), ["Tab", "⌘1"])
        XCTAssertEqual(FillOverlay.offerContent(caption: "from Mail", sourceApp: "Mail").hints.map(\.key), ["Tab"])
    }
}
