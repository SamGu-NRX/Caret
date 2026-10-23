import AppCompatibility
import CaretHostCore
import XCTest
@testable import CaretHost

@MainActor
final class GhostScreenTextTests: XCTestCase {
    private let target = ScreenTextTarget(pid: 2001, windowNumber: 101)

    func testPrefetchCarriesAXWindowReaderRevisionAndPrivacySettings() throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var settings = CaretSettings()
        settings.setApp("com.example.Secret", off: true)
        settings.setSite("https://secret.example", off: true)
        engine.screenTextSettings = { settings }
        var sent: [ScreenTextRequest] = []
        engine.screenTextSender = { sent.append($0); return true }

        engine.prefetchScreenText(for: target, origin: "https://docs.example")
        XCTAssertTrue(sent.isEmpty, "no request before the helper supplies its revision")
        engine.screenTextRevisionChanged(42)
        let request = try XCTUnwrap(sent.first)
        XCTAssertEqual(request.pid, target.pid)
        XCTAssertEqual(request.windowNumber, target.windowNumber)
        XCTAssertEqual(request.revision, 42)
        XCTAssertEqual(request.appsOff, settings.appsOff)
        XCTAssertEqual(request.sitesOff, settings.sitesOff)
        XCTAssertEqual(request.site, "https://docs.example")
        XCTAssertNil(engine.cachedScreenText(for: target, origin: "https://docs.example"), "a pending reply does not delay a cache read")
        engine.receiveScreenText(.init(id: request.id, revision: 42, text: "Nearby text"))
        XCTAssertEqual(engine.cachedScreenText(for: target, origin: "https://docs.example"), "Nearby text")
        engine.prefetchScreenText(for: target, origin: "https://docs.example")
        engine.screenTextRevisionChanged(42)
        XCTAssertEqual(sent.count, 1, "keystrokes and unchanged revisions do not request again")
    }

    func testWindowAndReaderRevisionChangesDropCachedAndLateReplies() throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var sent: [ScreenTextRequest] = []
        engine.screenTextSender = { sent.append($0); return true }
        engine.screenTextRevisionChanged(1)
        engine.prefetchScreenText(for: target)
        engine.receiveScreenText(.init(id: try XCTUnwrap(sent.last).id, revision: 1, text: "Window A"))
        XCTAssertEqual(engine.cachedScreenText(for: target), "Window A")
        let other = ScreenTextTarget(pid: target.pid, windowNumber: 102)
        XCTAssertNil(engine.cachedScreenText(for: other))
        engine.prefetchScreenText(for: other)
        let old = try XCTUnwrap(sent.last)
        engine.screenTextRevisionChanged(2)
        engine.receiveScreenText(.init(id: old.id, revision: 1, text: "Late B"))
        XCTAssertNil(engine.cachedScreenText(for: other))
        engine.receiveScreenText(.init(id: try XCTUnwrap(sent.last).id, revision: 2, text: "Current B"))
        XCTAssertEqual(engine.cachedScreenText(for: other), "Current B")
        XCTAssertNil(engine.cachedScreenText(for: target))
        engine.screenTextRevisionChanged(1)
        XCTAssertEqual(sent.count, 3, "an older notification does not roll back the cache")
    }

    func testSettingsAndPageOriginNeverReuseEarlierContext() throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var settings = CaretSettings()
        engine.screenTextSettings = { settings }
        var sent: [ScreenTextRequest] = []
        engine.screenTextSender = { sent.append($0); return true }
        engine.screenTextRevisionChanged(1)
        engine.prefetchScreenText(for: target, origin: "https://docs.example")
        engine.receiveScreenText(.init(id: try XCTUnwrap(sent.last).id, revision: 1, text: "Nearby"))
        settings.setApp("com.example.Secret", off: true)
        settings.setSite("https://secret.example", off: true)
        XCTAssertNil(engine.cachedScreenText(for: target, origin: "https://docs.example"))
        engine.refreshScreenText()
        XCTAssertEqual(sent.last?.appsOff, settings.appsOff)
        XCTAssertEqual(sent.last?.sitesOff, settings.sitesOff)
        engine.prefetchScreenText(for: target)
        XCTAssertNil(sent.last?.site)
        XCTAssertEqual(sent.count, 3)
        XCTAssertNil(engine.cachedScreenText(for: target))
    }

    func testDisconnectAndMissingWindowClearContextWithoutSending() throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var sent: [ScreenTextRequest] = []
        engine.screenTextSender = { sent.append($0); return true }
        engine.screenTextRevisionChanged(1)
        engine.prefetchScreenText(for: target)
        let request = try XCTUnwrap(sent.last)
        engine.receiveScreenText(.init(id: request.id, revision: 1, text: "Nearby"))
        engine.screenTextDisconnected()
        engine.receiveScreenText(.init(id: request.id, revision: 1, text: "Late"))
        XCTAssertNil(engine.cachedScreenText(for: target))
        engine.screenTextRevisionChanged(0)
        XCTAssertEqual(sent.count, 2, "a new connection can start at a lower revision")
        for missing in [nil, ScreenTextTarget(pid: 0, windowNumber: 101), ScreenTextTarget(pid: 7, windowNumber: 0)] {
            engine.prefetchScreenText(for: missing)
            XCTAssertNil(engine.cachedScreenText(for: target))
        }
        XCTAssertEqual(sent.count, 2)
    }
}
