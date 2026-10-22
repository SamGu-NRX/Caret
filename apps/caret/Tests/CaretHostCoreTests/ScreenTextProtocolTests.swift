import XCTest
@testable import CaretHostCore

final class ScreenTextProtocolTests: XCTestCase {
    func testStaleRepliesAndLateRepliesAreDropped() {
        let reply = ScreenTextReply(id: "r", revision: 4, text: "nearby")
        XCTAssertEqual(ScreenTextDecision.accept(reply, requestID: "r", revision: 4), "nearby")
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "r", revision: 5))
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "old", revision: 4))
        XCTAssertEqual(ScreenTextDecision.accept(reply, requestID: "r", revision: 4, elapsedNanoseconds: 40_000_000), "nearby")
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "r", revision: 4, elapsedNanoseconds: 40_000_001))
    }
}
