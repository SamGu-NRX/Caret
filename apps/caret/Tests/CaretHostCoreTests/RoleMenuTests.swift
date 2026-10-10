import XCTest
@testable import CaretHostCore

/// The Help With menu while onboarding holds the cloud roles.
final class RoleMenuTests: XCTestCase {
    func testAHeldRoleOpensSetupAndSaysWhy() {
        let cap: Set<CaretRole> = [.words]
        for role in CaretRole.allCases where role != .words {
            XCTAssertEqual(RoleMenu.choice(role, cap: cap), .finishSetup, "\(role)")
            XCTAssertEqual(RoleMenu.note(role, cap: cap), "Finish setup to turn this on")
        }
        XCTAssertEqual(RoleMenu.choice(.words, cap: cap), .toggle, "next words stay the person's to switch")
        XCTAssertNil(RoleMenu.note(.words, cap: cap))
    }

    func testWithNothingHeldEveryRoleToggles() {
        for role in CaretRole.allCases {
            XCTAssertEqual(RoleMenu.choice(role, cap: nil), .toggle)
            XCTAssertNil(RoleMenu.note(role, cap: nil))
        }
    }
}
