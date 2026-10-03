import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Every onboarding transition, against a manual clock: no window, no screen.
final class OnboardingFlowTests: XCTestCase {
    final class Rig {
        let clock = ManualClock()
        let flow: OnboardingFlow
        private(set) var commands: [OnboardingFlow.Command] = []

        init(settings: CaretSettings = CaretSettings(), ax: Bool = false, input: Bool = true) {
            flow = OnboardingFlow(settings: settings, permissions: OnboardingPermissions(accessibility: ax, inputMonitoring: input), clock: clock)
            flow.output = { [unowned self] in if $0 != .changed { self.commands.append($0) } }
        }

        var step: OnboardingStep { flow.state.step }

        func send(_ events: OnboardingFlow.Event...) { for e in events { flow.send(e) } }

        @discardableResult
        func take() -> [OnboardingFlow.Command] {
            defer { commands = [] }
            return commands
        }

        /// The last first-look request sent.
        var request: FirstLookRequest? {
            for case .askFirstLook(let r) in commands.reversed() { return r }
            return nil
        }

        /// Welcome, work and permissions passed with Accessibility already on.
        static func atTryIt() -> Rig {
            let rig = Rig(ax: true)
            rig.send(.next, .next, .next)
            XCTAssertEqual(rig.step, .tryIt)
            rig.take()
            return rig
        }

        static func atFirstLook(settings: CaretSettings = CaretSettings()) -> Rig {
            let rig = Rig(settings: settings, ax: true)
            rig.send(.next, .next, .next, .key(.tab), .next)
            XCTAssertEqual(rig.step, .firstLook)
            return rig
        }
    }

    private func reply(_ id: String, _ outcome: FirstLookReply.Outcome, family: String = "fill", error: String? = nil) throws -> FirstLookReply {
        let lines = try String(contentsOf: FirstLookTests.fixture, encoding: .utf8).split(separator: "\n")
        var r = try FirstLookReply.decode(Data(lines[outcome == .found ? 1 : (outcome == .nothing ? 3 : 4)].utf8))
        r.requestId = id
        r.found?.family = family
        if let error { r.error = error }
        return r
    }

    // MARK: - Welcome and work

    func testWelcomeOnlyGoesForward() {
        let rig = Rig()
        XCTAssertFalse(rig.flow.state.canGoBack)
        rig.send(.back)
        XCTAssertEqual(rig.step, .welcome)
        rig.send(.next)
        XCTAssertEqual(rig.step, .work)
        XCTAssertEqual(rig.flow.state.direction, .forward)
    }

    func testTheWorkScreenStartsFromTheSettingsAndChangesThem() {
        var s = CaretSettings()
        s.roles = [.fill]
        s.level = .quiet
        let rig = Rig(settings: s)
        rig.send(.next)
        XCTAssertEqual(rig.flow.state.roles, [.fill])
        rig.send(.toggleRole(.watch), .setRole(.fill, false), .setLevel(.eager))
        XCTAssertEqual(rig.flow.state.roles, [.watch])
        XCTAssertEqual(rig.flow.state.level, .eager)
    }

    func testLeavingTheWorkScreenWritesTheChoicesToSettings() {
        let rig = Rig()
        rig.send(.next, .setRole(.repeats, false), .setLevel(.quiet), .next)
        XCTAssertEqual(rig.step, .permissions)
        XCTAssertEqual(rig.take(), [.saveChoices(roles: [.fill, .watch, .words], level: .quiet, onboarded: false)])
    }

    func testWithNoRoleChosenTheWorkScreenWaits() {
        let rig = Rig()
        rig.send(.next)
        for role in CaretRole.allCases { rig.send(.setRole(role, false)) }
        XCTAssertFalse(rig.flow.state.canContinue)
        rig.send(.next)
        XCTAssertEqual(rig.step, .work)
        XCTAssertEqual(rig.take(), [])
    }

    func testChoicesAreOnlyChangedOnTheWorkScreen() {
        let rig = Rig()
        rig.send(.setLevel(.eager), .toggleRole(.fill))
        XCTAssertEqual(rig.flow.state.level, .balanced)
        XCTAssertTrue(rig.flow.state.roles.contains(.fill))
    }

    // MARK: - Permissions

    func testPermissionsWaitForAccessibilityThenMoveOnByThemselves() {
        let rig = Rig(ax: false, input: true)
        rig.send(.next, .next)
        XCTAssertEqual(rig.step, .permissions)
        XCTAssertFalse(rig.flow.state.canContinue)
        XCTAssertFalse(rig.flow.state.showsInputMonitoring, "Input Monitoring is not asked for when it is already on")
        rig.send(.next)
        XCTAssertEqual(rig.step, .permissions, "Continue waits for the grant")
        rig.send(.openSystemSettings(.accessibility))
        XCTAssertEqual(rig.take().last, .openSystemSettings(.accessibility))
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        XCTAssertTrue(rig.flow.state.advancingAfterGrant)
        XCTAssertEqual(rig.step, .permissions, "the check shows first")
        rig.clock.advance(by: OnboardingFlow.advanceAfterGrant)
        XCTAssertEqual(rig.step, .tryIt)
        XCTAssertFalse(rig.flow.state.advancingAfterGrant)
    }

    func testAGrantTakenBackBeforeTheMoveKeepsTheScreen() {
        let rig = Rig(ax: false)
        rig.send(.next, .next)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        rig.send(.permissions(OnboardingPermissions(accessibility: false, inputMonitoring: true)))
        rig.clock.advance(by: 2)
        XCTAssertEqual(rig.step, .permissions)
        XCTAssertFalse(rig.flow.state.canContinue)
    }

    func testAlreadyGrantedMeansNoJumpButContinueWorks() {
        let rig = Rig(ax: true)
        rig.send(.next, .next)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        rig.clock.advance(by: 2)
        XCTAssertEqual(rig.step, .permissions, "nothing appeared, so nothing moves")
        rig.send(.next)
        XCTAssertEqual(rig.step, .tryIt)
    }

    func testInputMonitoringIsAskedWhenMissingAndTheMoveWaitsForEveryShownRow() {
        let rig = Rig(ax: false, input: false)
        rig.send(.next, .next)
        XCTAssertTrue(rig.flow.state.showsInputMonitoring)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: false)))
        rig.clock.advance(by: 2)
        XCTAssertEqual(rig.step, .permissions, "Input Monitoring is still off")
        XCTAssertTrue(rig.flow.state.canContinue, "but it is optional")
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        XCTAssertTrue(rig.flow.state.showsInputMonitoring, "the row stays, reading On")
        rig.clock.advance(by: OnboardingFlow.advanceAfterGrant)
        XCTAssertEqual(rig.step, .tryIt)
    }

    func testLeavingThePermissionsScreenCancelsTheMove() {
        let rig = Rig(ax: false)
        rig.send(.next, .next)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)), .back)
        rig.clock.advance(by: 2)
        XCTAssertEqual(rig.step, .work)
    }

    // MARK: - Try it

    func testTryItCompletesOnTab() {
        let rig = Rig.atTryIt()
        XCTAssertTrue(rig.flow.state.tryIt.offerVisible)
        XCTAssertFalse(rig.flow.state.canContinue)
        rig.send(.key(.tab))
        XCTAssertEqual(rig.flow.state.tryIt.value, TryItSample.value)
        XCTAssertTrue(rig.flow.state.tryIt.completed)
        XCTAssertFalse(rig.flow.state.tryIt.offerVisible)
        XCTAssertTrue(rig.flow.state.canContinue)
        XCTAssertEqual(rig.take(), [.filled])
        rig.send(.key(.tab))
        XCTAssertEqual(rig.take(), [], "a second Tab takes nothing")
    }

    func testNothingButTabCompletesTryIt() {
        let others: [(String, [OnboardingFlow.Event])] = [
            ("Continue", [.next]),
            ("Return", [.key(.returnKey)]),
            ("another key", [.key(.other)]),
            ("Delete", [.key(.delete)]),
            ("typing", [.key(.character("4"))]),
            ("typing, then deleting it", [.key(.character("4")), .key(.delete)]),
        ]
        for (name, events) in others {
            let rig = Rig.atTryIt()
            for e in events { rig.send(e) }
            XCTAssertFalse(rig.flow.state.tryIt.completed, name)
            XCTAssertEqual(rig.step, .tryIt, name)
            XCTAssertFalse(rig.take().contains(.filled), name)
        }
    }

    func testTypingSaysNoAndDeletingBringsTheOfferBack() {
        let rig = Rig.atTryIt()
        rig.send(.key(.character("1")))
        XCTAssertFalse(rig.flow.state.tryIt.offerVisible)
        XCTAssertTrue(rig.flow.state.tryIt.declined)
        rig.send(.key(.tab))
        XCTAssertFalse(rig.flow.state.tryIt.completed, "Tab with no offer showing takes nothing")
        XCTAssertEqual(rig.flow.state.tryIt.tabs, 1)
        rig.send(.key(.delete))
        XCTAssertTrue(rig.flow.state.tryIt.offerVisible)
        rig.send(.key(.tab))
        XCTAssertTrue(rig.flow.state.tryIt.completed)
    }

    func testReturnContinuesOnlyOnceTryItIsDone() {
        let rig = Rig.atTryIt()
        rig.send(.key(.tab), .key(.returnKey))
        XCTAssertEqual(rig.step, .firstLook)
    }

    func testEscapeInTheFieldGoesBack() {
        let rig = Rig.atTryIt()
        rig.send(.key(.escape))
        XCTAssertEqual(rig.step, .permissions)
        XCTAssertEqual(rig.flow.state.direction, .back)
    }

    func testKeysForTheFieldDoNothingOnOtherScreens() {
        let rig = Rig(ax: true)
        rig.send(.next, .key(.tab))
        XCTAssertFalse(rig.flow.state.tryIt.completed)
        XCTAssertEqual(rig.flow.state.tryIt.tabs, 0)
    }

    // MARK: - First look

    func testTheFirstLookAsksForTheChosenFamiliesAndShowsWhatItFound() throws {
        var s = CaretSettings()
        s.roles = [.fill, .watch, .words]
        let rig = Rig.atFirstLook(settings: s)
        let request = try XCTUnwrap(rig.request)
        XCTAssertEqual(request.families, ["fill", "pending"])
        XCTAssertEqual(request.level, .balanced)
        XCTAssertEqual(rig.flow.state.firstLook, .asking(requestId: request.requestId))
        rig.send(.firstLookReply(try reply(request.requestId, .found)))
        guard case .found(let found) = rig.flow.state.firstLook else { return XCTFail("not found: \(rig.flow.state.firstLook)") }
        XCTAssertEqual(found.title, "Fill 4 fields")
        XCTAssertEqual(rig.flow.debugInfo().firstLookKind, "fill")
    }

    func testNothingFoundSaysNothingYet() throws {
        let rig = Rig.atFirstLook()
        rig.send(.firstLookReply(try reply(rig.request!.requestId, .nothing)))
        XCTAssertEqual(rig.flow.state.firstLook, .nothing)
        XCTAssertEqual(rig.flow.debugInfo().firstLook, "nothing")
    }

    func testAnErrorReplyFailsTheLookAndLookAgainAsksAfresh() throws {
        let rig = Rig.atFirstLook()
        let first = rig.request!.requestId
        rig.send(.firstLookReply(try reply(first, .error)))
        XCTAssertEqual(rig.flow.state.firstLook, .failed("reader not connected"))
        rig.send(.lookAgain)
        let second = rig.request!.requestId
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(rig.flow.state.firstLook, .asking(requestId: second))
        rig.send(.firstLookReply(try reply(first, .found)))
        XCTAssertEqual(rig.flow.state.firstLook, .asking(requestId: second), "the old look's late answer is ignored")
    }

    func testNoAnswerByTheDeadlineFailsTheLook() {
        let rig = Rig.atFirstLook()
        let wait = Double(FirstLookRequest.defaultDeadlineMs) / 1000 + OnboardingFlow.firstLookGrace
        rig.clock.advance(by: wait - 0.1)
        XCTAssertEqual(rig.flow.debugInfo().firstLook, "asking")
        rig.clock.advance(by: 0.2)
        XCTAssertEqual(rig.flow.state.firstLook, .failed("timedOut"))
    }

    func testAHelperThatIsNotConnectedFailsTheLookAtOnce() {
        let rig = Rig.atFirstLook()
        rig.send(.firstLookUnsent)
        XCTAssertEqual(rig.flow.state.firstLook, .failed("helperNotConnected"))
        XCTAssertEqual(rig.clock.live, 0, "no deadline left running")
    }

    func testAnOfferFromAFamilyNotAskedForIsRefused() throws {
        var s = CaretSettings()
        s.roles = [.watch]
        let rig = Rig.atFirstLook(settings: s)
        rig.send(.firstLookReply(try reply(rig.request!.requestId, .found, family: "fill")))
        XCTAssertEqual(rig.flow.state.firstLook, .failed("familyNotRequested"))
    }

    func testWithOnlyWordsChosenThereIsNothingToLookFor() {
        var s = CaretSettings()
        s.roles = [.words]
        let rig = Rig.atFirstLook(settings: s)
        XCTAssertNil(rig.request)
        XCTAssertEqual(rig.flow.state.firstLook, .nothing)
    }

    func testAReplyAfterLeavingTheScreenIsIgnoredAndComingBackAsksAgain() throws {
        let rig = Rig.atFirstLook()
        let first = rig.request!.requestId
        rig.send(.back)
        rig.send(.firstLookReply(try reply(first, .found)))
        XCTAssertEqual(rig.flow.state.firstLook, .idle)
        rig.send(.next)
        XCTAssertNotEqual(rig.request!.requestId, first)
        rig.clock.advance(by: 30)
        XCTAssertEqual(rig.flow.state.firstLook, .failed("timedOut"), "only the new look's deadline counts")
    }

    func testRequestIdsNameTheFlowSoALateReplyToAnEarlierFlowNeverMatches() throws {
        let clock = ManualClock()
        func flow(_ token: String) -> (OnboardingFlow, () -> FirstLookRequest?) {
            let f = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: true), clock: clock, token: token)
            var asked: FirstLookRequest?
            f.output = { if case .askFirstLook(let r) = $0 { asked = r } }
            for e: OnboardingFlow.Event in [.next, .next, .next, .key(.tab), .next] { f.send(e) }
            return (f, { asked })
        }
        let (first, firstAsked) = flow("a")
        let (second, secondAsked) = flow("b")
        XCTAssertNotEqual(firstAsked()?.requestId, secondAsked()?.requestId)
        second.send(.firstLookReply(try reply(firstAsked()!.requestId, .found)))
        XCTAssertEqual(second.debugInfo().firstLook, "asking", "the earlier flow's answer is not this flow's")
        XCTAssertEqual(first.debugInfo().firstLook, "asking")
    }

    func testWhilePausedTheFirstLookAsksForNothing() {
        var s = CaretSettings()
        s.paused = true
        let rig = Rig.atFirstLook(settings: s)
        XCTAssertNil(rig.request)
        XCTAssertEqual(rig.flow.state.firstLook, .nothing)
    }

    func testUnpausingFromTheMenuLetsTheNextLookAsk() {
        var s = CaretSettings()
        s.paused = true
        let rig = Rig.atFirstLook(settings: s)
        s.paused = false
        rig.send(.settingsChanged(s), .back, .next)
        XCTAssertNotNil(rig.request)
        XCTAssertEqual(rig.flow.debugInfo().firstLook, "asking")
    }

    func testTakingInputMonitoringBackDuringTheMoveStops() {
        let rig = Rig(ax: false, input: false)
        rig.send(.next, .next)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        XCTAssertTrue(rig.flow.state.advancingAfterGrant)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: false)))
        XCTAssertFalse(rig.flow.state.advancingAfterGrant)
        rig.clock.advance(by: 2)
        XCTAssertEqual(rig.step, .permissions)
        XCTAssertTrue(rig.flow.state.canContinue, "Input Monitoring is optional; Continue still works")
    }

    // MARK: - The end

    func testStartFinishesWritesTheChoicesAndClosesEvenWhileTheLookRuns() {
        let rig = Rig.atFirstLook()
        rig.take()
        rig.send(.next)
        XCTAssertTrue(rig.flow.state.finished)
        XCTAssertEqual(rig.take(), [.saveChoices(roles: Set(CaretRole.allCases), level: .balanced, onboarded: true), .close])
        XCTAssertEqual(rig.clock.live, 0)
        rig.send(.back, .next)
        XCTAssertEqual(rig.take(), [], "a finished flow takes no more events")
    }

    func testTheWholeWalkInOrder() throws {
        let rig = Rig(ax: false, input: false)
        rig.send(.next, .setRole(.watch, false), .setLevel(.eager), .next)
        rig.send(.permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true)))
        rig.clock.advance(by: OnboardingFlow.advanceAfterGrant)
        rig.send(.key(.character("x")), .key(.delete), .key(.tab), .next)
        let asked = try XCTUnwrap(rig.request)
        rig.send(.firstLookReply(try reply(asked.requestId, .nothing)), .next)
        XCTAssertEqual(rig.take(), [
            .saveChoices(roles: [.fill, .repeats, .words], level: .eager, onboarded: false),
            .filled,
            .askFirstLook(FirstLookRequest(requestId: asked.requestId, at: asked.at, families: ["fill", "loop", "routine"], level: .eager)),
            .saveChoices(roles: [.fill, .repeats, .words], level: .eager, onboarded: true),
            .close,
        ])
    }
}
