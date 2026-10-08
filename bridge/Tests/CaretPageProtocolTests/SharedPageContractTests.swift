import Foundation
import Testing
@testable import CaretPageProtocol

@Suite struct SharedPageContract {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("helper/fixtures/contracts/page")
    }

    private func payload(_ message: PageMessage) -> any Encodable {
        switch message {
        case let .engineChallenge(v): v
        case let .engineHello(v): v
        case let .engineWelcome(v): v
        case let .engineReady(v): v
        case let .pageHello(v): v
        case let .pageCommand(v): v
        case let .pageSnapshot(v): v
        case let .pageResult(v): v
        case let .scopedActGrant(v): v
        case let .actRevoke(v): v
        case let .pagePing(v): v
        case let .pagePong(v): v
        case let .pageChunk(v): v
        case let .pageFocus(v): v
        case let .pageSitesOff(v): v
        case let .pageInput(v): v
        case let .pageReadText(v): v
        }
    }

    // Synthesized Codable omits nil fields that the page wire spells as null.
    private func withoutNullFields(_ value: Any) -> Any {
        if let object = value as? [String: Any] {
            return object.filter { !($0.value is NSNull) }.mapValues(withoutNullFields)
        }
        if let array = value as? [Any] { return array.map(withoutNullFields) }
        return value
    }

    @Test func decodesAndReencodesSharedExtensionFixtures() throws {
        let urls = try FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        #expect(urls.count == 25)
        for url in urls {
            let data = try Data(contentsOf: url)
            let expected = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let message = try JSONDecoder().decode(PageMessage.self, from: data)
            let encoded = try JSONEncoder().encode(payload(message))
            var actual = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            actual["type"] = expected["type"]
            let normalizedActual = try #require(withoutNullFields(actual) as? [String: Any])
            let normalizedExpected = try #require(withoutNullFields(expected) as? [String: Any])
            #expect(NSDictionary(dictionary: normalizedActual).isEqual(to: normalizedExpected), "\(url.lastPathComponent)")
            if case let .pageCommand(command) = message {
                let verb = try JSONEncoder().encode(command.verb)
                let verbAgain = try JSONDecoder().decode(PageVerb.self, from: verb)
                #expect(verbAgain == command.verb, "\(url.lastPathComponent)")
            }
        }
    }
}
