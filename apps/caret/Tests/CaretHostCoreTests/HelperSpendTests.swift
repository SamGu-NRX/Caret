import CaretHostCore
import XCTest

/// H8: the helper's spend lines (`Fixtures/spend.ndjson`, the helper's golden copy byte for byte).
final class HelperSpendTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/spend.ndjson")

    private static func lines() throws -> [Data] {
        try String(contentsOf: fixture, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    func testTheFixtureIsTheHelpersGoldenFile() throws {
        let repo = Self.fixture.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        XCTAssertEqual(try Data(contentsOf: Self.fixture), try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/spend.ndjson")))
    }

    func testEverySpendLineDecodesWithItsTotals() throws {
        let lines = try Self.lines()
        guard case .notForConsumer = try HelperInbound.decode(lines[0]) else { return XCTFail("line 1 is the host's hello") }
        guard case .spend(let start) = try HelperInbound.decode(lines[1]) else { return XCTFail("line 2 is spend") }
        XCTAssertEqual(start.totalUsd, 0)
        guard case .spend(let later) = try HelperInbound.decode(lines[2]) else { return XCTFail("line 3 is spend") }
        XCTAssertEqual(later, HelperSpend(
            at: 1790000061000, since: 1790000000000,
            jev: .init(calls: 3, failed: 1, inputTokens: 4200, outputTokens: 0, costUsd: 0.0001764),
            writer: .init(calls: 1, failed: 0, inputTokens: 1800, outputTokens: 420, costUsd: 0.00123)
        ))
        XCTAssertEqual(later.totalUsd, 0.0014064, accuracy: 1e-12)
    }

    func testTheHostAsksForSpendAndRefusesANegativeCount() throws {
        XCTAssertTrue(HostHello.capabilities(routing: false).contains(HelperSpend.capability))
        let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.lines()[0]) as? [String: Any])
        XCTAssertTrue((hello["capabilities"] as? [String])?.contains("spend") == true, "the golden hello names the capability")
        let bad = String(decoding: try Self.lines()[2], as: UTF8.self).replacingOccurrences(of: #""calls":3"#, with: #""calls":-3"#)
        XCTAssertThrowsError(try HelperInbound.decode(Data(bad.utf8)))
    }
}
