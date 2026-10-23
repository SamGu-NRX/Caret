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

    func testRequestsRejectWrongTypeVersionAndInvalidPid() throws {
        let request = ScreenTextRequest(id: "r", revision: 1, pid: 7, windowNumber: 101)
        let data = try JSONEncoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let changes: [[String: Any]] = [["type": "other"], ["v": 2], ["pid": 0], ["pid": -1], ["pid": 7.5], ["pid": NSNull()]]
        for change in changes {
            let invalid = object.merging(change) { _, new in new }
            XCTAssertThrowsError(try JSONDecoder().decode(ScreenTextRequest.self, from: JSONSerialization.data(withJSONObject: invalid)))
        }
        var missingPid = object
        missingPid.removeValue(forKey: "pid")
        XCTAssertThrowsError(try JSONDecoder().decode(ScreenTextRequest.self, from: JSONSerialization.data(withJSONObject: missingPid)))
    }

    func testRequestsRequireAPositiveWindowNumber() throws {
        let data = try JSONEncoder().encode(ScreenTextRequest(id: "r", revision: 1, pid: 7, windowNumber: 101))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for value: Any in [0, -1, 1.5, NSNull(), 4294967296] {
            let invalid = object.merging(["windowNumber": value]) { _, new in new }
            XCTAssertThrowsError(try JSONDecoder().decode(ScreenTextRequest.self, from: JSONSerialization.data(withJSONObject: invalid)))
        }
        var missing = object
        missing.removeValue(forKey: "windowNumber")
        XCTAssertThrowsError(try JSONDecoder().decode(ScreenTextRequest.self, from: JSONSerialization.data(withJSONObject: missing)))
    }

    func testReaderRevisionDecodesAndRejectsInvalidHeaders() throws {
        let update = ScreenTextRevision(revision: 42)
        XCTAssertEqual(try HelperInbound.decode(JSONEncoder().encode(update)), .screenTextRevision(update))
        for wire in [#"{"type":"screenTextRevision","v":2,"revision":42}"#,
                     #"{"type":"screenTextRevision","v":1,"revision":-1}"#] {
            XCTAssertThrowsError(try HelperInbound.decode(Data(wire.utf8)))
        }
    }
}
