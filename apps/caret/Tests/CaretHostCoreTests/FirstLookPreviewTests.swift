import Foundation
import XCTest
@testable import CaretHostCore

final class FirstLookPreviewTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/first-look-preview.ndjson")

    private func lines() throws -> [Data] {
        try String(contentsOf: Self.fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    func testRequestRoundTripsTheFixture() throws {
        let line = try lines()[0]
        let request = try JSONDecoder().decode(FirstLookPreviewRequest.self, from: line)
        XCTAssertEqual(request, FirstLookPreviewRequest(requestId: "preview-1", at: 1_790_000_000_000, families: ["fill", "event"], level: .balanced))
        XCTAssertEqual(try object(request.line()), try object(line))
        XCTAssertEqual(try request.line().last, 10)
    }

    func testAllowedAndEmptyPreviewsRoundTrip() throws {
        let fixtureLines = try lines().dropFirst()
        let previews = try fixtureLines.map(FirstLookPreview.decode)
        XCTAssertEqual(previews[0].totalChars, 18)
        XCTAssertEqual(previews[0].windows[0].lines.last, .init(text: "", sent: false))
        XCTAssertTrue(previews[1].windows.isEmpty)
        XCTAssertEqual(previews[1].totalChars, 0)
        for (preview, line) in zip(previews, fixtureLines) {
            XCTAssertEqual(try object(preview.line()), try object(line))
        }
    }

    func testPlaceholderTextAndIncorrectCountsAreRefused() throws {
        let line = String(decoding: try lines()[1], as: UTF8.self)
        for bad in [
            line.replacingOccurrences(of: #""sent":false,"text":"""#, with: #""sent":false,"text":"private""#),
            line.replacingOccurrences(of: #""totalChars":18"#, with: #""totalChars":19"#),
            line.replacingOccurrences(of: #""charsSent":18"#, with: #""charsSent":19"#),
            line.replacingOccurrences(of: #""v":1"#, with: #""v":2"#),
            line.replacingOccurrences(of: #""type":"firstLookPreview""#, with: #""type":"other""#),
        ] {
            XCTAssertNotEqual(bad, line)
            XCTAssertThrowsError(try FirstLookPreview.decode(Data(bad.utf8)))
        }
    }

    func testFirstLookRequestWritesPreviewIdIncludingNull() throws {
        var request = FirstLookRequest(requestId: "look-1", at: 1, families: ["fill"], level: .balanced)
        XCTAssertNil(request.previewId)
        XCTAssertEqual(try object(request.line())["previewId"] as? NSNull, NSNull())
        XCTAssertEqual(try JSONDecoder().decode(FirstLookRequest.self, from: request.line()), request)
        request.previewId = "preview-local-1"
        XCTAssertEqual(try object(request.line())["previewId"] as? String, "preview-local-1")
        XCTAssertEqual(try JSONDecoder().decode(FirstLookRequest.self, from: request.line()), request)
    }

    func testCountsUseTheHelpersUTF16Units() throws {
        let preview = FirstLookPreview(requestId: "unicode", at: 1, previewId: "local", windows: [
            .init(bundleId: "b", appName: "Notes", title: "", lines: [.init(text: "\u{1D11E}", sent: true)], charsSent: 2),
        ], totalChars: 2)
        XCTAssertEqual(try FirstLookPreview.decode(preview.line()), preview)
    }
}
