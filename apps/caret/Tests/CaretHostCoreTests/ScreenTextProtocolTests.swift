import XCTest
@testable import CaretHostCore

final class ScreenTextProtocolTests: XCTestCase {
    func testRepliesRejectWrongTypeAndVersion() throws {
        let decoder = JSONDecoder()
        let wrongType = Data(#"{"type":"other","v":1,"id":"r","revision":1,"text":"nearby"}"#.utf8)
        let wrongVersion = Data(#"{"type":"screenTextReply","v":2,"id":"r","revision":1,"text":"nearby"}"#.utf8)
        XCTAssertThrowsError(try decoder.decode(ScreenTextReply.self, from: wrongType)) { error in
            guard case DecodingError.dataCorrupted = error else { return XCTFail("expected dataCorrupted, got \(error)") }
        }
        XCTAssertThrowsError(try decoder.decode(ScreenTextReply.self, from: wrongVersion)) { error in
            guard case DecodingError.dataCorrupted = error else { return XCTFail("expected dataCorrupted, got \(error)") }
        }
    }

    func testStaleRepliesAndLateRepliesAreDropped() {
        let reply = ScreenTextReply(id: "r", revision: 4, text: "nearby")
        XCTAssertEqual(ScreenTextDecision.accept(reply, requestID: "r", revision: 4), "nearby")
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "r", revision: 5))
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "old", revision: 4))
        XCTAssertEqual(ScreenTextDecision.accept(reply, requestID: "r", revision: 4, elapsedNanoseconds: 40_000_000), "nearby")
        XCTAssertNil(ScreenTextDecision.accept(reply, requestID: "r", revision: 4, elapsedNanoseconds: 40_000_001))
    }
}
