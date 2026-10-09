import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Every onboarding transition against a manual clock: no window, no screen, no System Settings.
final class OnboardingFlowTests: XCTestCase {
    final class Rig {
        let clock = ManualClock()
        let flow: OnboardingFlow
        private(set) var commands: [OnboardingFlow.Command] = []

        init(opening: OnboardingLaunch.Opening = .init(step: .hello), ax: Bool = false, model: ModelReadiness = .ready,
             settings: CaretSettings = CaretSettings(), key: Bool = true) {
            flow = OnboardingFlow(settings: settings, permissions: OnboardingPermissions(accessibility: ax, inputMonitoring: false),
                                  clock: clock, opening: opening, jevKeyAvailable: key)
            flow.output = { [unowned self] in if $0 != .changed { self.commands.append($0) } }
            flow.start()
            flow.send(.model(model))
        }

        var state: OnboardingFlow.State { flow.state }
        var step: OnboardingStep { flow.state.step }
        func send(_ events: OnboardingFlow.Event...) { for e in events { flow.send(e) } }

        @discardableResult
        func take() -> [OnboardingFlow.Command] {
            defer { commands = [] }
            return commands
        }

        func grant(_ on: Bool = true) { send(.permissions(OnboardingPermissions(accessibility: on, inputMonitoring: false))) }

        var previewAsk: String? {
            for case .askPreview(let id, _, _) in commands.reversed() { return id }
            return nil
        }

        var lookAsk: (FirstLookRequest, String?)? {
            for case .askFirstLook(let r, let p) in commands.reversed() { return (r, p) }
            return nil
        }

        /// Hello, the switch flipped, and the grant landed: on `on` with a preview being built.
        static func atOn(key: Bool = true) -> Rig {
            let rig = Rig(key: key)
            rig.send(.next)
            rig.grant()
            rig.clock.advance(by: OnboardingFlow.grantLanding)
            XCTAssertEqual(rig.step, .browser)
            rig.send(.next)  // no browser on this rig: Continue goes on
            XCTAssertEqual(rig.step, .on)
            return rig
        }

        static func preview(_ id: String = "pv-1", windows: Int = 2) -> OnboardingPreview {
            OnboardingPreview(previewId: id, windows: (0..<windows).map {
                .init(bundleId: "com.apple.mail", appName: "Mail", title: "Thursday? \($0)", lines: [.init(text: "Thursday at 3"), .init(text: nil)], chars: 13)
            }, chars: 13 * windows)
        }

        /// The look asked straight from `on` (opened there, as after a relaunch with the grant), so the clock has not
        /// moved: requests are stamped 1_790_000_000_000.
        static func atLook(settings: CaretSettings = CaretSettings()) -> Rig {
            let rig = Rig(opening: .init(step: .on), ax: true, settings: settings)
            rig.send(.previewReady(requestId: rig.previewAsk!, preview()), .next)
            XCTAssertNotNil(rig.lookAsk)
            return rig
        }

        var request: FirstLookRequest? { lookAsk?.0 }

        /// `on` with a ready preview, sent: the look is out.
        static func sent() -> Rig {
            let rig = atOn()
            let id = rig.previewAsk!
            rig.send(.previewReady(requestId: id, preview()), .next)
            XCTAssertEqual(rig.state.on.decision, .sent)
            return rig
        }
    }

    private func reply(_ id: String, _ outcome: FirstLookReply.Outcome, kind: FirstLookReply.Found.Kind? = nil, family: String = "fill") throws -> FirstLookReply {
        let lines = try String(contentsOf: FirstLookTests.fixture, encoding: .utf8).split(separator: "\n")
        var r = try FirstLookReply.decode(Data(lines[outcome == .found ? 1 : (outcome == .nothing ? 3 : 4)].utf8))
        r.requestId = id
        r.found?.offerKey = FirstLookReply.offerKey(requestId: id)
        r.found?.family = family
        if let kind { r.found?.kind = kind }
        return r
    }

    // MARK: - Launch

    func testAutoOpeningsByGrantAndProgress() {
        let off = OnboardingPermissions(accessibility: false, inputMonitoring: false)
        let on = OnboardingPermissions(accessibility: true, inputMonitoring: false)
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: off, progress: nil), .init(step: .hello))
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: off, progress: .init(step: .hello, at: 1)), .init(step: .hello))
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: off, progress: .init(step: .access, at: 1)), .init(step: .access, reopened: true))
        // Granted earlier, or relaunched after the grant: no welcome again.
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: on, progress: nil), .init(step: .on))
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: on, progress: .init(step: .access, at: 1)), .init(step: .on, reopened: true))
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: true, permissions: off, progress: nil), .init(step: .access, alone: true))
        XCTAssertNil(OnboardingLaunch.auto(onboarded: true, permissions: on, progress: nil))
    }

    func testProgressRoundTripsAndGarbageReadsAsNone() {
        let p = OnboardingProgress(step: .on, at: 42, coachShown: true)
        XCTAssertEqual(OnboardingProgress.decode(p.encoded()), p)
        XCTAssertNil(OnboardingProgress.decode(nil))
        XCTAssertNil(OnboardingProgress.decode(Data("{\"step\":\"welcome\",\"at\":1,\"coachShown\":false}".utf8)))
        XCTAssertNil(OnboardingProgress.decode(Data("not json".utf8)))
    }

    func testReopenedSwitchSaysSo() {
        let rig = Rig(opening: .init(step: .access, reopened: true))
        XCTAssertTrue(rig.state.access.reopened)
        XCTAssertEqual(rig.state.frame, .guide)
        XCTAssertEqual(rig.state.steps.count, 5)
    }

    // MARK: - Hello

    func testAsksTheModelOnlyAfterQuietAndTwoWords() {
        let rig = Rig()
        rig.send(.typed("Hi"))
        rig.clock.advance(by: 1)
        XCTAssertTrue(rig.take().isEmpty, "one word asks nothing")
        rig.send(.typed("Hi Dana, thanks"))
        rig.clock.advance(by: OnboardingFlow.completionIdle - 0.01)
        XCTAssertTrue(rig.take().isEmpty, "not before the idle wait")
        rig.clock.advance(by: 0.02)
        guard case .complete(let id, let text)? = rig.take().first else { return XCTFail("no completion asked") }
        XCTAssertEqual(text, "Hi Dana, thanks")
        rig.send(.ghost(requestId: id, text: " for getting back to me."))
        XCTAssertEqual(rig.state.hello.ghost, " for getting back to me.")
    }

    func testTypingClearsTheGhostAndDropsALateAnswer() {
        let rig = Rig()
        rig.send(.typed("Hi Dana, thanks"))
        rig.clock.advance(by: 1)
        guard case .complete(let id, _)? = rig.take().first else { return XCTFail("no completion asked") }
        rig.send(.ghost(requestId: id, text: " for that."))
        rig.send(.typed("Hi Dana, thanks s"))
        XCTAssertNil(rig.state.hello.ghost, "typing says no at once")
        rig.send(.ghost(requestId: id, text: " late"))
        XCTAssertNil(rig.state.hello.ghost, "an answer to an older text is dropped")
    }

    func testNoAskAfterASentenceEndsOrWhileTheModelLoads() {
        XCTAssertFalse(OnboardingFlow.asksCompletion(after: "Thanks so much."))
        XCTAssertFalse(OnboardingFlow.asksCompletion(after: "Are you free?"))
        XCTAssertTrue(OnboardingFlow.asksCompletion(after: "Are you free "))
        let rig = Rig(model: .loading(0.4))
        rig.send(.typed("Hi Dana, thanks"))
        rig.clock.advance(by: 2)
        XCTAssertTrue(rig.take().isEmpty)
    }

    func testTabTakesTheGhostOnlyWhileShown() {
        let rig = Rig()
        rig.send(.key(.tab))
        XCTAssertFalse(rig.state.hello.taken)
        rig.send(.typed("Hi Dana, thanks"))
        rig.clock.advance(by: 1)
        guard case .complete(let id, _)? = rig.take().first else { return XCTFail("no completion asked") }
        rig.send(.ghost(requestId: id, text: " for that."), .key(.tab))
        XCTAssertEqual(rig.state.hello.text, "Hi Dana, thanks for that.")
        XCTAssertNil(rig.state.hello.ghost)
        XCTAssertTrue(rig.state.hello.taken)
    }

    func testTurnOnCaretAsksMacOSAndBecomesTheGuide() {
        let rig = Rig()
        rig.take()
        rig.send(.key(.returnKey))
        XCTAssertEqual(rig.step, .access)
        XCTAssertEqual(rig.state.frame, .guide)
        XCTAssertEqual(rig.take(), [.openSystemSettings, .saveProgress(.access)])
        XCTAssertFalse(rig.state.canContinue, "the guide has no primary; the switch moves it")
    }

    func testSetUpLaterRemembersTheSwitchAndCloses() {
        let rig = Rig()
        rig.take()
        rig.send(.setUpLater)
        XCTAssertEqual(rig.take(), [.saveProgress(.access), .close])
    }

    // MARK: - The switch: poll and continue

    func testGrantMovesOnByItselfAfterTheLanding() {
        let rig = Rig()
        rig.send(.next)
        rig.take()
        rig.grant()
        XCTAssertTrue(rig.state.access.granted)
        XCTAssertEqual(rig.step, .access, "the check shows on the guide first")
        rig.clock.advance(by: OnboardingFlow.grantLanding - 0.01)
        XCTAssertEqual(rig.step, .access)
        rig.clock.advance(by: 0.02)
        XCTAssertEqual(rig.step, .browser)
        XCTAssertEqual(rig.state.frame, .main)
        let commands = rig.take()
        XCTAssertTrue(commands.contains(.saveProgress(.browser)))
        XCTAssertTrue(commands.contains(.bringForward))
    }

    func testRepeatedPollsDoNotRestartTheLanding() {
        let rig = Rig()
        rig.send(.next)
        rig.grant()
        rig.clock.advance(by: 0.5)
        rig.grant()
        rig.grant()
        rig.clock.advance(by: OnboardingFlow.grantLanding - 0.5 + 0.01)
        XCTAssertEqual(rig.step, .browser, "later polls with the same answer leave the first landing alone")
    }

    func testAGrantTakenBackBeforeTheLandingStays() {
        let rig = Rig()
        rig.send(.next)
        rig.grant()
        rig.clock.advance(by: 0.3)
        rig.grant(false)
        XCTAssertFalse(rig.state.access.granted)
        rig.clock.advance(by: 5)
        XCTAssertEqual(rig.step, .access)
        rig.grant()
        rig.clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertEqual(rig.step, .browser)
    }

    func testTheSwitchAloneFinishesOnTheGrant() {
        let rig = Rig(opening: .init(step: .access, alone: true))
        rig.take()
        XCTAssertEqual(rig.state.steps, [.access])
        rig.grant()
        rig.clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertTrue(rig.state.finished)
        XCTAssertEqual(rig.take(), [.finished, .close])
    }

    func testGrantOnAnotherStepChangesNothingButTheReading() {
        let rig = Rig()
        rig.grant()
        rig.clock.advance(by: 5)
        XCTAssertEqual(rig.step, .hello)
        XCTAssertTrue(rig.state.permissions.accessibility)
    }

    // MARK: - The browser step

    private func atBrowser(_ trusted: [String]) -> Rig {
        let rig = Rig(opening: .init(step: .browser), ax: true)
        rig.send(.browsers(trusted: trusted, untrusted: []))
        rig.take()
        return rig
    }

    func testAddToBrowserOpensTheExtensionThenItsConnectionMovesOn() {
        let rig = atBrowser(["Google Chrome", "Helium"])
        XCTAssertEqual(rig.state.browser.target, "Google Chrome")
        rig.send(.next)
        XCTAssertEqual(rig.take(), [.addToBrowser], "the native host is written and the extension's page opened")
        XCTAssertTrue(rig.state.browser.opened)
        XCTAssertEqual(rig.step, .browser, "it waits for the extension")
        rig.send(.browserConnected("Helium"))
        XCTAssertFalse(rig.state.browser.connected, "another browser's extension says nothing about Chrome's")
        rig.send(.browserConnected("Google Chrome"))
        XCTAssertTrue(rig.state.browser.connected)
        rig.clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertEqual(rig.step, .on, "the first connection moves on by itself")
        XCTAssertTrue(rig.take().contains(.bringForward))
    }

    func testAFailedAddSaysWhyAndCanBeTriedAgain() {
        let rig = atBrowser(["Google Chrome"])
        rig.send(.next)
        XCTAssertEqual(rig.take(), [.addToBrowser])
        rig.send(.browserAddFailed("Caret couldn't install its browser connection."))
        XCTAssertFalse(rig.state.browser.opened, "back to Add, not waiting for an extension that can't connect")
        XCTAssertEqual(rig.state.browser.failure, "Caret couldn't install its browser connection.")
        rig.take()
        rig.send(.next)
        XCTAssertEqual(rig.take(), [.addToBrowser], "Add runs again")
        XCTAssertNil(rig.state.browser.failure)
        XCTAssertEqual(rig.step, .browser)

        let elsewhere = Rig(opening: .init(step: .on), ax: true)
        elsewhere.send(.browserAddFailed("x"))
        XCTAssertNil(elsewhere.state.browser.failure, "only the browser step takes it")
    }

    func testTheBrowserStepIsSkippableAndContinuesWithoutWaiting() {
        let skip = atBrowser(["Helium"])
        skip.send(.skipBrowser)
        XCTAssertEqual(skip.step, .on)
        let opened = atBrowser(["Helium"])
        opened.send(.next, .next)
        XCTAssertEqual(opened.step, .on, "after opening the page, Continue goes on without the connection")
    }

    func testWithNoBrowserContinueGoesOnAndAddsNothing() {
        let rig = atBrowser([])
        XCTAssertNil(rig.state.browser.target)
        rig.send(.next)
        XCTAssertEqual(rig.step, .on)
        XCTAssertFalse(rig.take().contains(.addToBrowser))
    }

    func testAnExtensionConnectedEarlierNeedsNoClick() {
        let rig = Rig(opening: .init(step: .access), ax: false)
        rig.send(.browsers(trusted: ["Google Chrome"], untrusted: []), .browserConnected("Google Chrome"))
        rig.grant()
        rig.clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertEqual(rig.step, .browser)
        rig.take()
        rig.send(.next)
        XCTAssertEqual(rig.step, .on, "already connected: the primary is Continue")
        XCTAssertFalse(rig.take().contains(.addToBrowser))
    }

    func testARelaunchOnTheBrowserStepComesBackToIt() {
        let on = OnboardingPermissions(accessibility: true, inputMonitoring: false)
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: on, progress: .init(step: .browser, at: 1)), .init(step: .browser, reopened: true))
    }

    // MARK: - On: the preview and the decision

    func testSendAsksTheLookInsideThePreview() throws {
        let rig = Rig.atOn()
        let id = try XCTUnwrap(rig.previewAsk)
        XCTAssertFalse(rig.state.canContinue, "nothing to send until the preview is built")
        rig.send(.previewReady(requestId: "someone-else", Rig.preview()))
        XCTAssertEqual(rig.state.on.preview, .building(requestId: id))
        rig.send(.previewReady(requestId: id, Rig.preview("pv-9")))
        XCTAssertTrue(rig.state.canContinue)
        rig.take()
        rig.send(.next)
        let (request, previewId) = try XCTUnwrap(rig.lookAsk)
        XCTAssertEqual(previewId, "pv-9")
        XCTAssertEqual(rig.state.on.decision, .sent)
        XCTAssertEqual(rig.step, .on, "the looking line shows here until the reply")
        rig.send(.firstLookReply(try reply(request.requestId, .nothing)))
        XCTAssertEqual(rig.step, .first)
        XCTAssertEqual(rig.state.first.look, .nothing)
    }

    func testNothingToSendAndKeepBothFinishOnDone() {
        let empty = Rig.atOn()
        empty.send(.previewReady(requestId: empty.previewAsk!, Rig.preview(windows: 0)))
        XCTAssertEqual(empty.state.on.preview, .empty)
        empty.take()
        empty.send(.next)
        XCTAssertEqual(empty.take(), [.consent(sent: false), .finished, .close], "nothing shown, nothing agreed: Done keeps, so the held roles are dropped")
        XCTAssertEqual(empty.state.on.decision, .kept)

        let kept = Rig.atOn()
        kept.send(.previewReady(requestId: kept.previewAsk!, Rig.preview()))
        kept.take()
        kept.send(.keep)
        XCTAssertEqual(kept.state.on.decision, .kept)
        kept.send(.next)
        XCTAssertEqual(kept.take(), [.consent(sent: false), .finished, .close])
        XCTAssertNil(kept.lookAsk, "keeping sends no look")
    }

    func testAPreviewThatNeverComesLetsThePersonGoOn() {
        let rig = Rig.atOn()
        rig.clock.advance(by: OnboardingFlow.previewDeadline + 0.1)
        XCTAssertEqual(rig.state.on.preview, .failed("timedOut"))
        XCTAssertTrue(rig.state.canContinue)
    }

    func testAKeyIsCheckedThenThePreviewIsBuiltAgainForTheNewHelper() throws {
        let rig = Rig.atOn(key: false)
        rig.send(.previewReady(requestId: rig.previewAsk!, Rig.preview("pv-old")))
        XCTAssertTrue(rig.state.on.needsKey)
        XCTAssertFalse(rig.state.canContinue, "Send waits for a pasted key")
        rig.send(.setJevKey("not a key"), .next)
        XCTAssertEqual(rig.state.on.jevKey.phase, .malformed)
        rig.take()
        rig.send(.setJevKey("tsk_0123456789abcdef0123"), .next)
        guard case .checkJevKey(let key)? = rig.take().first else { return XCTFail("the key is checked first") }
        XCTAssertEqual(key.reveal, "tsk_0123456789abcdef0123")
        XCTAssertFalse(rig.state.canContinue, "no second press while the check runs")
        rig.send(.jevKeyChecked(.works, saved: true))
        XCTAssertTrue(rig.state.on.jevKey.stored)
        XCTAssertTrue(rig.state.on.jevKey.text.isEmpty, "the key is not held once saved")
        XCTAssertNil(rig.lookAsk, "saving the key restarts the helper, which forgot the old preview: nothing is sent on it")
        let fresh = try XCTUnwrap(rig.previewAsk)
        rig.send(.previewReady(requestId: fresh, Rig.preview("pv-new")), .next)
        XCTAssertEqual(rig.lookAsk?.1, "pv-new", "the person sends what the new preview shows")
    }

    func testAPreviewAskedBeforeTheHelperConnectsIsAskedAgain() throws {
        let rig = Rig.atOn()
        let first = try XCTUnwrap(rig.previewAsk)
        rig.send(.previewFailed(requestId: first, "helperNotConnected"))
        XCTAssertEqual(rig.state.on.preview, .building(requestId: first), "still reading, not failed")
        rig.take()
        rig.clock.advance(by: 1)
        let second = try XCTUnwrap(rig.previewAsk)
        XCTAssertNotEqual(second, first)
        for _ in 0..<OnboardingFlow.previewRetries {
            guard case .building(let id) = rig.state.on.preview else { break }
            rig.send(.previewFailed(requestId: id, "helperNotConnected"))
            rig.clock.advance(by: 1)
        }
        XCTAssertEqual(rig.state.on.preview, .failed("helperNotConnected"), "it gives up after the retries")
        XCTAssertTrue(rig.state.canContinue)
    }

    func testAGrantGivenBeforeTheGuideOpensLandsAtOnce() {
        let rig = Rig()
        rig.grant()
        XCTAssertEqual(rig.step, .hello)
        rig.send(.next)
        XCTAssertEqual(rig.step, .access)
        XCTAssertTrue(rig.state.access.granted)
        rig.clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertEqual(rig.step, .browser, "no poll change is needed to move on")
    }

    // MARK: - First

    func testFoundOfferTakesTabAndFinishesOnDone() throws {
        let rig = Rig.sent()
        let (request, _) = try XCTUnwrap(rig.lookAsk)
        rig.send(.firstLookReply(try reply(request.requestId, .found)))
        XCTAssertEqual(rig.step, .first)
        XCTAssertEqual(rig.state.firstLookKeys.tab, true)
        rig.take()
        rig.send(.key(.tab))
        guard case .accept(let accept)? = rig.take().first else { return XCTFail("Tab sends the accept") }
        XCTAssertEqual(accept.offerId, FirstLookReply.offerKey(requestId: request.requestId))
        XCTAssertTrue(rig.state.canContinue, "Done closes the window while the run goes on in the helper")
    }

    func testReturnTakesAFoundOfferAndADeclinedOneTakesNoKey() throws {
        let rig = Rig.sent()
        rig.send(.firstLookReply(try reply(rig.lookAsk!.0.requestId, .found, kind: .action, family: "event")))
        rig.take()
        rig.send(.key(.returnKey))
        guard case .accept? = rig.take().first else { return XCTFail("Return is the primary: it takes the offer") }

        let declined = Rig.sent()
        declined.send(.firstLookReply(try reply(declined.lookAsk!.0.requestId, .found, kind: .action, family: "event")), .notNow)
        declined.take()
        XCTAssertEqual(declined.state.firstLookKeys, .none)
        declined.send(.key(.tab), .accept)
        XCTAssertTrue(declined.take().allSatisfy { if case .accept = $0 { return false } else { return true } }, "a declined offer cannot be taken")
        declined.send(.next)
        XCTAssertTrue(declined.state.finished, "Done closes")
    }

    func testNotNowLeavesAnEventAloneAndClosesAFill() throws {
        let event = Rig.sent()
        event.send(.firstLookReply(try reply(event.lookAsk!.0.requestId, .found, kind: .action, family: "event")))
        event.take()
        event.send(.key(.escape))
        XCTAssertTrue(event.state.first.declined)
        XCTAssertFalse(event.state.finished, "the Left alone. pane shows")

        let fill = Rig.sent()
        fill.send(.firstLookReply(try reply(fill.lookAsk!.0.requestId, .found)))
        fill.take()
        fill.send(.notNow)
        XCTAssertEqual(fill.take(), [.finished, .close])
    }

    func testCalendarDeniedEndsTheRun() throws {
        let rig = Rig.sent()
        rig.send(.firstLookReply(try reply(rig.lookAsk!.0.requestId, .found, kind: .action, family: "event")))
        rig.send(.key(.tab), .calendarAsking)
        XCTAssertEqual(rig.state.firstLookKeys, .none, "nothing takes keys while macOS asks")
        rig.send(.calendarAnswered(false))
        XCTAssertEqual(rig.state.first.calendar, .denied)
        XCTAssertNil(rig.state.first.run)
        XCTAssertTrue(rig.state.canContinue)
    }

    func testALookThatNeverAnswersFailsToTheFirstStep() {
        let rig = Rig.sent()
        rig.clock.advance(by: Double(FirstLookRequest.defaultDeadlineMs) / 1000 + OnboardingFlow.firstLookGrace + 0.1)
        XCTAssertEqual(rig.step, .first)
        XCTAssertEqual(rig.state.first.look, .failed("timedOut"))
    }

    func testAWithdrawnOfferIsLookedForAgainInsideTheSamePreview() throws {
        let rig = Rig.sent()
        let (first, previewId) = try XCTUnwrap(rig.lookAsk)
        rig.send(.firstLookReply(try reply(first.requestId, .found)))
        rig.take()
        rig.send(.offerWithdrawn(OfferWithdrawn(at: 1, id: FirstLookReply.offerKey(requestId: first.requestId), reason: .reoffered)))
        let (again, againPreview) = try XCTUnwrap(rig.lookAsk)
        XCTAssertNotEqual(again.requestId, first.requestId)
        XCTAssertEqual(againPreview, previewId)
    }

    func testDebugInfoCarriesLengthsNotText() {
        let rig = Rig()
        rig.send(.typed("Hi Dana, thanks"))
        let info = rig.flow.debugInfo()
        XCTAssertEqual(info.hello?.textLength, 15)
        XCTAssertEqual(info.step, "hello")
        XCTAssertEqual(info.stepCount, 5)
        let json = String(decoding: try! JSONEncoder().encode(info), as: UTF8.self)
        XCTAssertFalse(json.contains("Dana"))
    }

    // MARK: - The apps the Hello line names

    func testHelloAppsOrderExclusionAndFloor() {
        let mail = HelloApp(bundleId: "com.apple.mail", name: "Mail")
        let chrome = HelloApp(bundleId: "com.google.Chrome", name: "Chrome")
        let slack = HelloApp(bundleId: "com.tinyspeck.slackmacgap", name: "Slack")
        let terminal = HelloApp(bundleId: "com.apple.Terminal", name: "Terminal")
        let caret = HelloApp(bundleId: "dev.caret.host", name: "Caret")
        let picked = HelloApps.pick(defaultMail: mail, defaultBrowser: chrome, running: [terminal, caret, slack, mail], installed: [],
                                    excluded: { ["com.apple.Terminal", "dev.caret.host"].contains($0) })
        XCTAssertEqual(picked.map(\.name), ["Mail", "Chrome", "Slack", "Notes"])
        XCTAssertEqual(HelloApps.list(picked), "Mail, Chrome, Slack and Notes")
        let bare = HelloApps.pick(defaultMail: nil, defaultBrowser: nil, running: [], installed: [], excluded: { _ in false })
        XCTAssertEqual(bare.map(\.name), ["Notes", "Mail", "Safari"], "never fewer than three names")
    }

    func testHelloNamesOnlyAppsAPersonTypesIn() {
        XCTAssertTrue(HelloApps.isPersonApp(path: "/Applications/Slack.app", home: "/Users/a"))
        XCTAssertTrue(HelloApps.isPersonApp(path: "/System/Applications/Notes.app", home: "/Users/a"))
        XCTAssertTrue(HelloApps.isPersonApp(path: "/Users/a/Applications/Arc.app", home: "/Users/a"))
        XCTAssertFalse(HelloApps.isPersonApp(path: "/System/Library/CoreServices/Setup Assistant.app", home: "/Users/a"), "the VM's Hello named it")
        XCTAssertFalse(HelloApps.isPersonApp(path: "/System/Library/CoreServices/Finder.app", home: "/Users/a"))
        XCTAssertFalse(HelloApps.isPersonApp(path: "/Users/a/Downloads/Tool.app", home: "/Users/a"))
        XCTAssertFalse(HelloApps.isPersonApp(path: nil, home: "/Users/a"))
    }
}
