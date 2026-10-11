import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Slice 1 on the desk: the task question, and a goal card as it previews, edits, runs, ends, and previews its
/// calendar part, light and dark, against their references.
///
/// The references are recorded on CI (record-snapshots.yml) and committed after the lead reviewed them as a contact
/// sheet; a missing one fails, as for every other gallery item.
@MainActor
final class GoalCardRenderTests: XCTestCase {
    func testGoalCardStatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.goalCards())
    }

    /// The press the user makes is the card's last line, set apart from the rows, never one of them.
    func testTheHandOffIsNotARow() {
        let card = Gallery.goalCard()
        XCTAssertEqual(card.listed.count, 2)
        XCTAssertFalse(card.listed.contains { $0.tier == .yours })
        XCTAssertNotNil(GoalCopy.handOff(card))
    }
}
