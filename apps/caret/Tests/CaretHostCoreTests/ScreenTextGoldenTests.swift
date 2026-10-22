import Foundation
import XCTest
@testable import CaretHostCore

final class ScreenTextGoldenTests: XCTestCase {
    private var fixture: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("helper/fixtures/golden/screen-text.ndjson")
    }

    func testSharedRequestAndReplyDecode() throws {
        let lines = try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n")
        let request = try JSONDecoder().decode(ScreenTextRequest.self, from: Data(lines[0].utf8))
        let reply = try JSONDecoder().decode(ScreenTextReply.self, from: Data(lines[1].utf8))
        XCTAssertEqual(request.id, "screen-golden-1")
        XCTAssertEqual(request.revision, 42)
        XCTAssertEqual(request.windowID, "2001-7")
        XCTAssertEqual(reply, ScreenTextReply(id: request.id, revision: request.revision, text: "Project brief\nShip the local suggestion"))
    }
}
