import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Taking the first look's offer from onboarding: the keys it shows, Tab's `offerAccept`, and the
/// working and result lines, which must be the real surfaces' own (`WorkLines`).
final class FirstLookRunTests: XCTestCase {
    typealias Rig = OnboardingFlowTests.Rig

    private func found(sourceApps: [String]? = ["Mail"], actions: String = #"[{"id":"fillAll","label":"Fill all","key":"tab"},{"id":"one","label":"One at a time","key":"cmd-2"},{"id":"review","label":"Review","key":"down"}]"#) throws -> FirstLookReply.Found {
        let apps = sourceApps.map { ",\"sourceApps\":[" + $0.map { "\"\($0)\"" }.joined(separator: ",") + "]" } ?? ""
        let json = #"{"kind":"fill","family":"fill","offerKey":"first-look-1.0","window":{"pid":5151,"windowId":"5151-2","appName":"Safari","title":"Payment"},"spec":{"v":1,"id":"fl","figure":"offering","blocks":[{"type":"header","title":{"text":"Fill 4 fields","ref":{"rule":"count","derived":[{"node":"5151-2/form"}]}}},{"type":"fields","rows":[{"destination":{"text":"Name","ref":{"node":"n"}},"value":{"text":"Dana Reyes","ref":{"node":"m","quote":"Dana Reyes"}},"state":"ready"}],"more":3},{"type":"actions","items":\#(actions)}]}\#(apps)}"#
        return try JSONDecoder().decode(FirstLookReply.Found.self, from: Data(json.utf8))
    }

    /// At the first look with the offer found.
    private func shown(_ found: FirstLookReply.Found) -> Rig {
        let rig = Rig.atFirstLook()
        let request = rig.request!
        rig.send(.firstLookReply(FirstLookReply(requestId: request.requestId, at: 1, outcome: .found, found: found)))
        rig.take()
        return rig
    }

    private func progress(_ phase: TaskProgress.Phase, task: String = "first-look-1.0", written: Int? = nil, restored: Int? = nil, notRestored: Int? = nil) -> TaskProgress {
        Fx.progress(task, phase, written: written, restored: restored, notRestored: notRestored)
    }

    private func line(_ rig: Rig) -> String? { rig.flow.state.firstLookRun?.line(character: .pebble)?.text }

    func testAFoundOfferShowsTheKeysThatTakeItHere() throws {
        let rig = shown(try found())
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(tab: true, digits: [2]))
        XCTAssertEqual(rig.flow.debugInfo().firstLookKeys, ["tab", "cmd-2"])
        XCTAssertEqual(try found().takeable.map(\.id), ["fillAll", "one"], "the down arrow's action needs the real surface")
        let nothing = Rig.atFirstLook()
        nothing.send(.firstLookReply(FirstLookReply(requestId: nothing.request!.requestId, at: 1, outcome: .nothing)))
        XCTAssertEqual(nothing.flow.state.firstLookKeys, .none, "nothing to take: Tab keeps moving focus")
        XCTAssertEqual(Rig.atTryIt().flow.state.firstLookKeys, .none, "other screens take none of these")
    }

    func testTabSendsOfferAcceptWithTheOffersKeyAndTheLineWorks() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        XCTAssertEqual(rig.take(), [.accept(OfferAccept(offerId: "first-look-1.0", actionId: "fillAll", overrides: [:], at: 1_790_000_000_000))])
        XCTAssertEqual(line(rig), "Filling 4 fields", "a fill's working line counts its rows, as at the caret")
        XCTAssertEqual(rig.flow.state.firstLookKeys, .none, "taken once: a second Tab is the window's")
        rig.send(.key(.tab))
        XCTAssertEqual(rig.take(), [])
        XCTAssertEqual(rig.flow.state.firstLookRun?.line(character: .pebble)?.content.figure, .working)
        rig.clock.advance(by: 0.2)
        XCTAssertEqual(rig.flow.state.firstLookRun?.line(character: .pebble)?.content.figure, .absent, "the figure looks away and leaves")
        rig.clock.advance(by: 3)
        XCTAssertEqual(line(rig), "Filling 4 fields, 3 s")
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(stop: true))
    }

    func testTheLinesAreTheRealSurfacesOwn() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        rig.clock.advance(by: 4.2)
        let run = try XCTUnwrap(rig.flow.state.firstLookRun)
        XCTAssertEqual(run.line(character: .seed), WorkLines.working(app: "Safari", fillRows: 4, character: .seed, seconds: 4, figureLeft: true))
        rig.send(.taskProgress(progress(.verified)), .taskProgress(progress(.done, written: 4)))
        XCTAssertEqual(rig.flow.state.firstLookRun?.line(character: .pebble), WorkLines.filled(4, from: "Mail"))
        XCTAssertEqual(line(rig), "Filled 4 fields from Mail")
        XCTAssertEqual(rig.clock.live, 0, "no timer left once it is done")
    }

    // MARK: - Withdrawn before it is taken

    private func withdrawn(_ key: String, _ reason: OfferWithdrawn.Reason) -> OnboardingFlow.Event {
        .offerWithdrawn(OfferWithdrawn(at: 2, id: key, reason: reason, replacedBy: reason == .reoffered ? "\(key).r" : nil))
    }

    func testASettingsWithdrawalOfTheFoundOfferLooksAgain() throws {
        for reason in [OfferWithdrawn.Reason.settings, .reoffered] {
            let rig = shown(try found())
            rig.send(withdrawn("first-look-1.0", reason))
            guard case .asking(let id) = rig.flow.state.firstLook else { return XCTFail("\(reason): \(rig.flow.state.firstLook)") }
            XCTAssertEqual(rig.request?.requestId, id, "\(reason): a new request goes out")
            XCTAssertEqual(rig.flow.state.firstLookKeys, .none, "\(reason): Tab takes nothing while it looks")
        }
    }

    func testAPausedCaretLooksAgainForNothing() throws {
        let rig = shown(try found())
        var paused = CaretSettings()
        paused.paused = true
        rig.send(.settingsChanged(paused), withdrawn("first-look-1.0", .settings))
        XCTAssertEqual(rig.flow.state.firstLook, .nothing, "paused asks for no family")
        XCTAssertNil(rig.request, "and sends no request")
    }

    func testAnyOtherWithdrawalLeavesNothingToTake() throws {
        for reason in [OfferWithdrawn.Reason.taken, .dismissed, .diverged, .idle, .stale, .expired] {
            let rig = shown(try found())
            rig.send(withdrawn("first-look-1.0", reason))
            XCTAssertEqual(rig.flow.state.firstLook, .nothing, "\(reason)")
            rig.send(.key(.tab))
            XCTAssertEqual(rig.take(), [], "\(reason): Tab never names a withdrawn key")
        }
    }

    func testAWithdrawalOfAnotherOfferOrAfterTabChangesNothing() throws {
        let rig = shown(try found())
        rig.send(withdrawn("pop-1", .settings))
        XCTAssertEqual(rig.flow.state.firstLookFound?.offerKey, "first-look-1.0")
        XCTAssertEqual(rig.take(), [])
        rig.send(.key(.tab))
        rig.take()
        rig.send(withdrawn("first-look-1.0", .taken))
        XCTAssertEqual(rig.flow.state.firstLookRun?.phase, .working, "the run's own progress ends it")
        XCTAssertEqual(rig.take(), [])
    }

    func testCommandDigitTakesTheActionBoundToIt() throws {
        let rig = shown(try found())
        rig.send(.key(.commandDigit(3)))
        XCTAssertEqual(rig.take(), [], "nothing on ⌘3")
        rig.send(.key(.commandDigit(2)))
        XCTAssertEqual(rig.take(), [.accept(OfferAccept(offerId: "first-look-1.0", actionId: "one", overrides: [:], at: 1_790_000_000_000))])
    }

    func testEachEndingHasItsLine() throws {
        func ended(_ phase: TaskProgress.Phase, verified: Int = 0, apps: [String]? = ["Mail"]) throws -> String? {
            let rig = shown(try found(sourceApps: apps))
            rig.send(.key(.tab))
            for _ in 0..<verified { rig.send(.taskProgress(progress(.verified))) }
            rig.send(.taskProgress(progress(phase)))
            return line(rig)
        }
        XCTAssertEqual(try ended(.done, verified: 2), "Filled 2 fields from Mail", "no written count: the verified steps stand in")
        XCTAssertEqual(try ended(.done, verified: 0), "Done, in Safari", "nothing written: nothing to undo")
        XCTAssertEqual(try ended(.done, verified: 1, apps: nil), "Filled 1 field")
        XCTAssertEqual(try ended(.stopped, verified: 1), "Filled 1 field. The form changed, so the rest was left as it is.")
        XCTAssertEqual(try ended(.handoff), "Your turn in Safari")
        XCTAssertNil(try ended(.paused), "paused: the line goes, as at the caret")
    }

    func testAnotherTasksProgressChangesNothing() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .taskProgress(progress(.done, task: "offer-5", written: 2)))
        XCTAssertEqual(rig.flow.state.firstLookRun?.phase, .working)
    }

    func testCommandZUndoesAFillAndTheAnswerReadsTheCounts() throws {
        let rig = shown(try found())
        rig.send(.key(.undo))
        XCTAssertEqual(rig.take(), [], "⌘Z takes nothing before there is a result")
        rig.send(.key(.tab), .taskProgress(progress(.done, written: 4)))
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(undo: true))
        rig.take()
        rig.send(.key(.undo))
        XCTAssertEqual(rig.take(), [.undo(TaskControl(taskId: "first-look-1.0", action: .undo))])
        XCTAssertEqual(line(rig), "Undoing")
        rig.send(.taskProgress(progress(.undone, restored: 3, notRestored: 1)))
        XCTAssertEqual(line(rig), "1 field changed after the fill, so it was left as it is.")
        XCTAssertEqual(rig.flow.state.firstLookKeys, .none)
    }

    func testEscStopsOnlyAfterThreeSecondsOtherwiseGoesBack() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        rig.take()
        rig.clock.advance(by: 3)
        rig.send(.key(.escape))
        XCTAssertEqual(rig.take(), [.stop(OfferStop(offerId: "first-look-1.0", at: 1_790_000_003_000))])
        XCTAssertEqual(line(rig), "Stopped")
        XCTAssertEqual(rig.flow.state.step, .firstLook)
        rig.send(.key(.escape))
        XCTAssertEqual(rig.flow.state.step, .tryIt, "with nothing to stop, Esc is Back")
    }

    func testAHelperThatIsNotConnectedSaysSo() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .sendFailed(.accept))
        XCTAssertEqual(line(rig), "Caret's helper isn't running, so nothing was done.")
        XCTAssertEqual(rig.clock.live, 0)
        let undo = shown(try found())
        undo.send(.key(.tab), .taskProgress(progress(.done, written: 1)), .key(.undo), .sendFailed(.undo))
        XCTAssertEqual(line(undo), "Caret's helper isn't running, so nothing was undone.")
    }

    func testLeavingTheScreenEndsTheRunsTimersAndItsLine() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .back)
        XCTAssertNil(rig.flow.state.firstLookRun)
        XCTAssertEqual(rig.clock.live, 0)
        rig.send(.taskProgress(progress(.done, written: 4)))
        XCTAssertNil(rig.flow.state.firstLookRun, "the run goes on in the helper; the activity list reports it")
    }

    func testADroppedFlowLeavesNoTimerRunning() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        XCTAssertGreaterThan(rig.clock.live, 0)
        rig.flow.cancelTimers()
        XCTAssertEqual(rig.clock.live, 0, "closing the window mid-run stops the run's timers")
    }

    func testReturnFinishesEvenWhileItWorks() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .key(.returnKey))
        XCTAssertTrue(rig.flow.state.finished)
        XCTAssertEqual(rig.clock.live, 0)
    }

    func testFoundSourceAppsDecodeStrictly() throws {
        XCTAssertEqual(try found().sourceApps, ["Mail"])
        XCTAssertNil(try found(sourceApps: nil).sourceApps, "optional, as on OfferPopup")
        XCTAssertThrowsError(try found(sourceApps: ["Mail", "Mail"]))
        XCTAssertThrowsError(try found(sourceApps: []))
    }
}
