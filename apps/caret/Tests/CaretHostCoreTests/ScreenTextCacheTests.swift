import XCTest
@testable import CaretHostCore

final class ScreenTextCacheTests: XCTestCase {
    private func key(window: UInt32 = 101, revision: UInt64 = 7, appsOff: [String] = [], site: String? = nil) -> ScreenTextCache.Key {
        .init(target: .init(pid: 7, windowNumber: window), revision: revision, appsOff: appsOff, sitesOff: [], site: site)
    }

    func testReadsNeverWaitAndPrefetchesOnlyWhenTheKeyChanges() throws {
        var cache = ScreenTextCache()
        let request = try XCTUnwrap(cache.prefetch(key(), id: "first"))
        XCTAssertNil(cache.text(for: key()), "a pending prefetch is not screen text")
        XCTAssertNil(cache.prefetch(key(), id: "duplicate"))
        cache.receive(.init(id: request.id, revision: 7, text: "nearby"))
        XCTAssertEqual(cache.text(for: key()), "nearby")
        XCTAssertNil(cache.prefetch(key(), id: "already-cached"))
    }

    func testSameAppDifferentWindowAndOlderRevisionNeverSupplyText() throws {
        var cache = ScreenTextCache()
        _ = cache.prefetch(key(), id: "a")
        cache.receive(.init(id: "a", revision: 7, text: "window A"))
        XCTAssertNil(cache.text(for: key(window: 102)))
        XCTAssertNil(cache.text(for: key(revision: 8)))
        XCTAssertNotNil(cache.prefetch(key(window: 102), id: "b"))
        cache.receive(.init(id: "a", revision: 7, text: "late A"))
        XCTAssertNil(cache.text(for: key(window: 102)))
        cache.receive(.init(id: "b", revision: 7, text: "window B"))
        XCTAssertEqual(cache.text(for: key(window: 102)), "window B")
        XCTAssertNotNil(cache.prefetch(key(window: 102, revision: 8), id: "b-new"))
        cache.receive(.init(id: "b-new", revision: 7, text: "old revision"))
        XCTAssertNil(cache.text(for: key(window: 102, revision: 8)))
    }

    func testPrivacyChangesAndDisconnectInvalidateTheCacheIncludingLateReplies() {
        var cache = ScreenTextCache()
        _ = cache.prefetch(key(), id: "a")
        cache.receive(.init(id: "a", revision: 7, text: "nearby"))
        XCTAssertNil(cache.text(for: key(appsOff: ["dev.test.app"])))
        XCTAssertNil(cache.text(for: key(site: "https://other.example")))
        XCTAssertNotNil(cache.prefetch(key(appsOff: ["dev.test.app"]), id: "policy"))
        XCTAssertNil(cache.text(for: key()))
        cache.clear()
        cache.receive(.init(id: "policy", revision: 7, text: "late"))
        XCTAssertNil(cache.text(for: key(appsOff: ["dev.test.app"])))
        XCTAssertNotNil(cache.prefetch(key(), id: "reconnected"))
    }

    func testNullReplyDoesNotReuseThePreviousText() {
        var cache = ScreenTextCache()
        _ = cache.prefetch(key(), id: "a")
        cache.receive(.init(id: "a", revision: 7, text: "nearby"))
        _ = cache.prefetch(key(revision: 8), id: "b")
        cache.receive(.init(id: "b", revision: 8, text: nil))
        XCTAssertNil(cache.text(for: key(revision: 8)))
    }
}
