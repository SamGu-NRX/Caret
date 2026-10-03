import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Brief A13's renders, compared with their references like the other surfaces: the ask field and
/// its card in the activity list, the event card, and the compact fallback on a crowded form.
@MainActor
final class AskSnapshotTests: XCTestCase {
    func testTheAskFieldAndItsCardMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.ask())
    }

    func testTheEventSurfacesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.events())
    }

    /// A12's small-screen case on the claim form's geometry: the event card has no spot that covers
    /// nothing, so the offer is drawn as its compact line, which covers no field and no label.
    func testOnACrowdedFormTheCompactLineCoversNoLabel() throws {
        let scene = CompactPlacementScene(spec: EventCardCopy.card(Gallery.helperEventCard))
        let card = scene.cardChoice
        XCTAssertNotEqual(card.overlap, 0, "the full card has no clear spot here: \(card)")
        let line = scene.lineChoice
        XCTAssertEqual(line.overlap, 0, "the compact line has one: \(line)")
        for i in PanelPlacementScene.rows.indices where i != scene.focusRow {
            XCTAssertFalse(PanelPlacementScene.field(i).intersects(line.frame), "covers field \(i)")
        }
        for i in PanelPlacementScene.rows.indices {
            if let label = PanelPlacementScene.label(i) { XCTAssertFalse(label.intersects(line.frame), "covers label \(i)") }
        }
        XCTAssertFalse(PanelPlacementScene.field(scene.focusRow).intersects(line.frame), "never over the field it is about")
        try SnapshotTests.check([Gallery.Item(name: "placement-compact-fallback", view: AnyView(scene))])
    }
}
