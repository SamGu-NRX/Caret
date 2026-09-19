import XCTest
#if SWIFT_PACKAGE
@testable import Caret
#endif

final class PinnedActionsStoreTests: XCTestCase {
    func testPinUpToThreeInOrder() {
        var store = PinnedActionsStore()
        XCTAssertTrue(store.pin(actionID: "a"))
        XCTAssertTrue(store.pin(actionID: "b"))
        XCTAssertTrue(store.pin(actionID: "c"))
        XCTAssertEqual(store.orderedActionIDs, ["a", "b", "c"])
        XCTAssertEqual(store.slot(for: "b"), 2)
        XCTAssertEqual(store.actionID(forSlot: 2), "b")
    }

    func testFourthPinRejected() {
        var store = PinnedActionsStore(orderedActionIDs: ["a", "b", "c"])
        XCTAssertFalse(store.pin(actionID: "d"))
        XCTAssertEqual(store.orderedActionIDs, ["a", "b", "c"])
    }

    func testToggleUnpins() {
        var store = PinnedActionsStore(orderedActionIDs: ["a", "b"])
        XCTAssertTrue(store.togglePin(actionID: "a"))
        XCTAssertEqual(store.orderedActionIDs, ["b"])
        XCTAssertNil(store.slot(for: "a"))
    }

    func testLoadSaveRoundTrip() {
        let defaults = UserDefaults(suiteName: "PinnedActionsStoreTests")!
        defaults.removeObject(forKey: PinnedActionsStore.storageKey)

        var store = PinnedActionsStore()
        XCTAssertTrue(store.pin(actionID: "book-flight"))
        store.save(to: defaults)

        let loaded = PinnedActionsStore.load(from: defaults)
        XCTAssertEqual(loaded.orderedActionIDs, ["book-flight"])
    }
}
