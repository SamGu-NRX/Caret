import CaretHostCore
import XCTest

final class GhostReplayTests: XCTestCase {
    private let replay = GhostReplay(entries: [
        .init(before: "We should schedule a call for next", after: " to go over it.", text: " week"),
        .init(before: "The intro and examples", after: " feel a bit thin.", text: nil, reason: "doesNotFit"),
    ])

    func testAContextIsMatchedByItsEndsAndTheTextAfterTheCaret() {
        XCTAssertEqual(replay.outcome(before: "Hi Dana,\nWe should schedule a call for next", after: " to go over it.\n"), .text(" week"))
        XCTAssertEqual(replay.outcome(before: "The intro and examples", after: " feel a bit thin."), .silent("doesNotFit"))
    }

    func testAnotherContextIsNotGuessed() {
        XCTAssertNil(replay.outcome(before: "We should schedule a call for", after: " to go over it."))
        XCTAssertNil(replay.outcome(before: "We should schedule a call for next", after: " to go over them."))
    }

    func testTheFileShapeDecodes() throws {
        let json = #"{"entries":[{"before":"a","after":"","text":" b"},{"before":"c","after":" d","text":null,"reason":"repeatsFollowing"}]}"#
        let decoded = try JSONDecoder().decode(GhostReplay.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.outcome(before: "c", after: " d"), .silent("repeatsFollowing"))
    }
}
