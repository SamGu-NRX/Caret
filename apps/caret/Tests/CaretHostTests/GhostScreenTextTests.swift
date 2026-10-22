import AppCompatibility
import CaretHostCore
import XCTest
@testable import CaretHost

@MainActor
final class GhostScreenTextTests: XCTestCase {
    func testRequestCarriesCapturedPidPrivacySettingsAndPageOrigin() async throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var settings = CaretSettings()
        settings.setApp("com.example.Secret", off: true)
        settings.setSite("https://secret.example", off: true)
        engine.screenTextSettings = { settings }
        var sent: ScreenTextRequest?
        engine.screenTextProvider = { request in
            sent = request
            return nil
        }

        try await engine.updateScreenText(pid: 2001, revision: 42, origin: "https://docs.example")

        let request = try XCTUnwrap(sent)
        XCTAssertEqual(request.pid, 2001)
        XCTAssertEqual(request.revision, 42)
        XCTAssertEqual(request.appsOff, settings.appsOff)
        XCTAssertEqual(request.sitesOff, settings.sitesOff)
        XCTAssertEqual(request.site, "https://docs.example")
        XCTAssertEqual(request.maxCharacters, 2048)
        let wire = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(wire["appsOff"] as? [String], ["com.example.Secret"])
        XCTAssertEqual(wire["sitesOff"] as? [String], ["https://secret.example"])
        XCTAssertEqual(wire["pid"] as? Int, 2001)
        XCTAssertNil(wire["windowId"], "the reader, not the host, assigns window IDs")
        XCTAssertNil(engine.inlinePromptContext.screenText)
    }

    func testEachRequestReadsCurrentSettingsAndDoesNotReuseThePreviousPageOrigin() async throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var settings = CaretSettings()
        engine.screenTextSettings = { settings }
        var sent: [ScreenTextRequest] = []
        engine.screenTextProvider = { request in
            sent.append(request)
            return sent.count == 1 ? "Nearby static text" : nil
        }
        try await engine.updateScreenText(pid: 7, revision: 1, origin: "https://docs.example")
        XCTAssertEqual(engine.inlinePromptContext.screenText, "Nearby static text")

        settings.setApp("com.example.Secret", off: true)
        settings.setSite("https://secret.example", off: true)
        try await engine.updateScreenText(pid: 8, revision: 2, origin: nil)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.last?.appsOff, settings.appsOff)
        XCTAssertEqual(sent.last?.sitesOff, settings.sitesOff)
        XCTAssertNil(sent.last?.site, "a native field must not inherit a page's origin")
        XCTAssertNotEqual(sent.first?.id, sent.last?.id)
        XCTAssertNil(engine.inlinePromptContext.screenText, "an unavailable reply clears old screen text")
    }

    func testWithoutCapturedPidTheHostRequestsNoTextAndClearsPreviousContext() async throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        engine.screenTextProvider = { _ in
            XCTFail("no request is allowed without a captured positive pid")
            return "wrong app text"
        }
        let missingPids: [Int32?] = [nil, 0, -1]
        for pid in missingPids {
            engine.inlinePromptContext.screenText = "old text"
            try await engine.updateScreenText(pid: pid, revision: 1, origin: nil)
            XCTAssertNil(engine.inlinePromptContext.screenText)
        }
    }
}
