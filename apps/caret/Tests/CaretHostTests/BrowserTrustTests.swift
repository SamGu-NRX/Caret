import XCTest
@testable import CaretHost

/// H8 decision 2: the acceptance build (`CARET_ACCEPTANCE_HOST`) may trust Chrome for Testing for a run,
/// in full-UI mode as in its narrow modes; the shipped build trusts no browser beyond `BridgeTrust`, whatever
/// it is handed. This target compiles without `CARET_ACCEPTANCE_HOST`, as the release build does.
@MainActor
final class BrowserTrustTests: XCTestCase {
    private let chromeForTesting = #"cdhash H"0123456789abcdef0123456789abcdef01234567""#

    func testTheShippedBuildDropsAnExtraBrowserRequirement() throws {
        let services = try CaretServices(mode: .attached(socket: "/tmp/caret-h8-none.sock", why: "test"), extraBrowserRequirements: [chromeForTesting])
        XCTAssertEqual(services.extraBrowserRequirements, [], "the release configuration ignores --acceptance-browser-requirement")
    }
}
