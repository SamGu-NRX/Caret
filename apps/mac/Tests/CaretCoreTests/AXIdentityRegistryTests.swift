import ApplicationServices
import XCTest
@testable import CaretCore

/// `AXUIElementCreateApplication` builds a real element from a pid without
/// needing the Accessibility grant, which is enough to check that identity is
/// decided by `CFEqual` and not by a readable attribute.
final class AXIdentityRegistryTests: XCTestCase {
    func testTheSameElementKeepsOneToken() {
        let registry = AXIdentityRegistry(prefix: "el")
        let element = AXUIElementCreateApplication(getpid())
        let first = registry.token(for: element)
        let second = registry.token(for: AXUIElementCreateApplication(getpid()))
        XCTAssertEqual(first, second)
    }

    func testDistinctElementsGetDistinctTokens() {
        let registry = AXIdentityRegistry(prefix: "el")
        let mine = registry.token(for: AXUIElementCreateApplication(getpid()))
        let other = registry.token(for: AXUIElementCreateApplication(getppid()))
        XCTAssertNotEqual(mine, other)
    }

    func testTokensAreNotDerivedFromAttributesThatCanCollide() {
        // Two windows can share a title and two fields can share a position, so
        // a token must not be a function of either. Counter values are unique.
        let registry = AXIdentityRegistry(prefix: "win")
        let a = registry.token(for: AXUIElementCreateApplication(getpid()))
        let b = registry.token(for: AXUIElementCreateApplication(getppid()))
        XCTAssertEqual(Set([a, b]).count, 2)
        XCTAssertTrue(a.hasPrefix("win-"))
    }
}
