import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// An entry for "Caret" switched on that the running build isn't trusted under: the rig VM's golden image had one with
/// another build's signature, and Sam's beta.1 very likely met the same (DF1 runs 20261009T114954Z-80410 and n3).
final class StaleEntryTests: XCTestCase {
    func testOnlyUntrustedServicesAreResetBeforeAsking() {
        XCTAssertEqual(AccessibilityAccess.resetsBeforeAsking(accessibility: false, listenEvents: false, postEvents: false),
                       ["Accessibility", "ListenEvent", "PostEvent"])
        XCTAssertEqual(AccessibilityAccess.resetsBeforeAsking(accessibility: false, listenEvents: true, postEvents: false),
                       ["Accessibility", "PostEvent"], "a grant this build holds is kept")
        XCTAssertEqual(AccessibilityAccess.resetsBeforeAsking(accessibility: true, listenEvents: false, postEvents: false), [],
                       "trusted: nothing to reset, nothing is touched")
    }

    func testEveryResetNamesOnlyCaretsOwnEntryUnderItsOwnServices() throws {
        for service in AccessibilityAccess.ownServices {
            XCTAssertEqual(try AccessibilityAccess.resetArguments(service: service, bundleID: "dev.caret.host"), ["reset", service, "dev.caret.host"])
            for other in ["com.apple.Terminal", "dev.caret.hackathon", "dev.caret", "", "dev.caret.host.evil"] {
                XCTAssertThrowsError(try AccessibilityAccess.resetArguments(service: service, bundleID: other), "\(service) \(other)")
            }
            XCTAssertThrowsError(try AccessibilityAccess.resetArguments(service: service, bundleID: nil))
        }
        for service in ["All", "Calendar", "ScreenCapture", "SystemPolicyAllFiles", ""] {
            XCTAssertThrowsError(try AccessibilityAccess.resetArguments(service: service, bundleID: "dev.caret.host"), service)
        }
        XCTAssertTrue(AccessibilityAccess.resetsBeforeAsking(accessibility: false, listenEvents: false, postEvents: false)
            .allSatisfy { AccessibilityAccess.ownServices.contains($0) })
    }

    private func flowAtTheSwitch(others: [OtherCaret]) -> OnboardingFlow {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: false, inputMonitoring: false),
                                  clock: ManualClock(), opening: .init(step: .access), jevKeyAvailable: true)
        flow.start()
        flow.send(.otherCarets(others))
        return flow
    }

    func testAChangeThatLeavesCaretUntrustedWithNoOtherCaretOffersTheReset() {
        let flow = flowAtTheSwitch(others: [])
        XCTAssertFalse(flow.state.access.stale)
        flow.send(.accessChangedStillUntrusted)
        XCTAssertTrue(flow.state.access.stale, "the entry turned on is an older copy of this Caret")
        XCTAssertFalse(flow.state.access.wrongCaret)
        var commands: [OnboardingFlow.Command] = []
        flow.output = { if $0 != .changed { commands.append($0) } }
        flow.send(.resetGrant)
        XCTAssertEqual(commands, [.resetGrant])
        XCTAssertFalse(flow.state.access.stale)
    }

    func testWithAnotherCaretInstalledItNamesThatOneInstead() {
        let flow = flowAtTheSwitch(others: [OtherCaret(bundleID: "dev.caret.hackathon", path: "/Applications/Caret.app")])
        flow.send(.accessChangedStillUntrusted)
        XCTAssertTrue(flow.state.access.wrongCaret)
        XCTAssertFalse(flow.state.access.stale)
    }

    func testAnotherCopyWithThisBundleIDSharesTheEntrySoItOffersTheReset() {
        let flow = flowAtTheSwitch(others: [OtherCaret(bundleID: "dev.caret.host", path: "/Users/sam/Downloads/Caret.app")])
        flow.send(.accessChangedStillUntrusted)
        XCTAssertTrue(flow.state.access.stale, "one entry per bundle id: turning on 'the other one' is the same switch")
        XCTAssertFalse(flow.state.access.wrongCaret)
    }

    func testOnceTrustedNoChangeNoticeOffersAReset() {
        let flow = flowAtTheSwitch(others: [])
        flow.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: false)))
        flow.send(.accessChangedStillUntrusted)
        XCTAssertFalse(flow.state.access.stale)
    }
}
