import AppCompatibility
import AutocompleteCore
import XCTest
@testable import CaretHost

/// PR #16 review: a site's instructions reach only the page path's request for that page's field, never a native
/// field in the same browser (its address bar), however recently the page reported.
@MainActor
final class SiteInstructionsTests: XCTestCase {
    func testOnlyARequestGivenAnOriginSeesIt() {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        var seen: [String?] = []
        engine.instructions = { _, origin in seen.append(origin); return [] }
        let context = TextFieldContext(beforeCursor: "Search for", target: AppTarget(bundleIdentifier: "com.google.Chrome", appName: "Chrome"))
        _ = engine.request(for: context)
        _ = engine.request(for: context, origin: "https://docs.example")
        XCTAssertEqual(seen, [nil, "https://docs.example"])
    }
}
