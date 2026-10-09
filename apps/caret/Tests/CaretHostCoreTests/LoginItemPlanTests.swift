import XCTest
@testable import CaretHostCore

/// The login item is registered after onboarding, never while it is switched off, and an existing one is started.
final class LoginItemPlanTests: XCTestCase {
    func testRegistrationWaitsForOnboarding() {
        XCTAssertEqual(LoginItemPlan.decide(status: .notRegistered, onboarded: false), .runHere(reason: LoginItemPlan.deferredReason, deferred: true))
        XCTAssertEqual(LoginItemPlan.decide(status: .notFound, onboarded: false), .runHere(reason: LoginItemPlan.deferredReason, deferred: true))
        XCTAssertEqual(LoginItemPlan.decide(status: .notRegistered, onboarded: true), .register)
    }

    func testASwitchedOffLoginItemIsNeverRegisteredAgain() {
        for onboarded in [false, true] {
            guard case .runHere(_, let deferred) = LoginItemPlan.decide(status: .requiresApproval, onboarded: onboarded) else {
                return XCTFail("requiresApproval must not register")
            }
            XCTAssertFalse(deferred)
        }
    }

    func testARegisteredLoginItemIsStartedWhateverTheStep() {
        XCTAssertEqual(LoginItemPlan.decide(status: .enabled, onboarded: false), .kickstart)
        XCTAssertEqual(LoginItemPlan.decide(status: .enabled, onboarded: true), .kickstart)
    }
}
