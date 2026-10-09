import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Slice 1 on the desk: the task question, and a goal card as it previews, edits, runs, ends, and previews its
/// calendar part, light and dark, against their references.
///
/// The references are recorded on CI (record-snapshots.yml) and committed only after the lead reviews them as a
/// contact sheet. Until then none is in References/, and this test skips by name rather than fail every host run; once
/// any is committed, every one is checked.
@MainActor
final class GoalCardRenderTests: XCTestCase {
    func testGoalCardStatesMatchTheirReferences() throws {
        let items = Gallery.goalCards()
        let committed = items.contains { FileManager.default.fileExists(atPath: SnapshotTests.references.appendingPathComponent("\($0.name)-light.png").path) }
        try XCTSkipUnless(SnapshotTests.record || committed, "slice 1 references await the lead's review of the contact sheet; none is committed yet")
        try SnapshotTests.check(items)
    }

    /// The press the user makes is the card's last line, set apart from the rows, never one of them.
    func testTheHandOffIsNotARow() {
        let card = Gallery.goalCard()
        XCTAssertEqual(card.listed.count, 2)
        XCTAssertFalse(card.listed.contains { $0.tier == .yours })
        XCTAssertNotNil(GoalCopy.handOff(card))
    }
}
