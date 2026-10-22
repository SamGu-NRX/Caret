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
        XCTAssertEqual(request.pid, 2001)
        XCTAssertEqual(request.appsOff, ["com.example.Secret"])
        XCTAssertEqual(request.sitesOff, ["https://secret.example"])
        XCTAssertEqual(request.site, "https://docs.example")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? NSDictionary
        let golden = try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? NSDictionary
        XCTAssertEqual(encoded, golden, "Swift must send the helper's exact field names")
        XCTAssertEqual(reply, ScreenTextReply(id: request.id, revision: request.revision, text: "Project brief\nShip the local suggestion"))
    }
}
