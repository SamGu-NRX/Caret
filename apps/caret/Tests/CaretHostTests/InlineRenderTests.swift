import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// The Writing tab against its references, light and dark (brief items 4, 6 and 7).
@MainActor
final class InlineRenderTests: XCTestCase {
    func testWritingTabStatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.inline())
    }

    func testTheWordsUseNoDashes() {
        let words = [WritingPageCopy.intro, WritingPageCopy.aboutIntro, WritingPageCopy.aboutPlaceholder, WritingPageCopy.entriesIntro, WritingPageCopy.entriesEmpty,
                     WritingPageCopy.nothingToImport, WritingPageCopy.offEmpty] + GhostKeys.allCases.map(GhostKeysCopy.detail)
        for w in words { XCTAssertFalse(w.contains("—") || w.contains("–"), w) }
    }
}
