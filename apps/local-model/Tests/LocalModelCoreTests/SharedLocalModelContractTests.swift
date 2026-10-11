import Foundation
import Testing
@testable import LocalModelCore

@Suite struct SharedLocalModelContract {
    private var fixtures: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("helper/fixtures/contracts/local-model")
    }
    private func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))
    }
    private func equalsFixture<T: Encodable>(_ value: T, _ name: String) throws {
        let expected = try #require(JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
        let encoded = try #require(JSONSerialization.jsonObject(with: encodeLine(value)) as? [String: Any])
        #expect(NSDictionary(dictionary: encoded).isEqual(to: expected), "\(name).json")
    }

    @Test func parsesSharedRequest() throws {
        let request = try parseRequest(fixture("request")).get()
        #expect(request == Request(id: "r1", prefix: "Synthetic prefix\n", prompt: "Synthetic prompt", grammar: "root ::= \"fixture\"", maxTokens: 8))
        let expected = try #require(JSONSerialization.jsonObject(with: fixture("request")) as? [String: Any])
        let actual: [String: Any] = ["id": request.id, "prefix": request.prefix, "prompt": request.prompt, "grammar": request.grammar, "maxTokens": request.maxTokens]
        #expect(NSDictionary(dictionary: actual).isEqual(to: expected))
    }

    // Response types are encode-only in production. Compare their own encoders with the same JSON TS parses.
    @Test func encodesSharedResponses() throws {
        let memory = MemoryUse(residentMB: 1, footprintMB: 2, peakFootprintMB: 3, peakResidentMB: 4)
        try equalsFixture(Ready(model: "fixture.gguf", loadMs: 5, nCtx: 4096, memory: memory), "ready")
        try equalsFixture(NotReady(error: "fixture model not found"), "notReady")
        try equalsFixture(Completion(id: "r1", text: "fixture", stop: .eog, prefixTokens: 1, prefixCached: false, promptTokens: 2, outputTokens: 3,
                                     ms: Timing(prefix: 1, prompt: 2, decode: 3, total: 6), memory: memory), "completion")
        try equalsFixture(Failure(id: "r1", error: "fixture request refused"), "failure")
        try equalsFixture(Failure(id: nil, error: "fixture invalid request"), "failure-null")
    }
}
