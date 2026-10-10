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
        let rig = Rig.atLook()
        let request = rig.request!
        rig.send(.firstLookReply(FirstLookReply(requestId: request.requestId, at: 1, outcome: .found, found: found)))
        rig.take()
        return rig
    }

    private func progress(_ phase: TaskProgress.Phase, task: String = "first-look-1.0", written: Int? = nil, restored: Int? = nil, notRestored: Int? = nil,
                          reason: TaskProgress.StopReason = .changed, step: Int? = nil, steps: Int = 2) -> TaskProgress {
        Fx.progress(task, phase, written: written, restored: restored, notRestored: notRestored, reason: reason, step: step, steps: steps)
    }

    private func line(_ rig: Rig) -> String? { rig.flow.state.first.run?.line()?.text }

    func testAFoundOfferShowsTheKeysThatTakeItHere() throws {
        let rig = shown(try found())
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(tab: true, digits: [2]))
        XCTAssertEqual(rig.flow.debugInfo().firstLookKeys, ["tab", "cmd-2"])
        XCTAssertEqual(try found().takeable.map(\.id), ["fillAll", "one"], "the down arrow's action needs the real surface")
        let nothing = Rig.atLook()
        nothing.send(.firstLookReply(FirstLookReply(requestId: nothing.request!.requestId, at: 1, outcome: .nothing)))
        XCTAssertEqual(nothing.flow.state.firstLookKeys, .none, "nothing to take: Tab keeps moving focus")
        XCTAssertEqual(Rig().flow.state.firstLookKeys, .none, "other screens take none of these")
    }

    func testTabSendsOfferAcceptWithTheOffersKeyAndTheLineWorks() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        XCTAssertEqual(rig.take(), [.accept(OfferAccept(offerId: "first-look-1.0", actionId: "fillAll", overrides: [:], at: 1_790_000_000_000))])
        XCTAssertEqual(line(rig), "Filling 4 fields", "a fill's working line counts its rows, as at the caret")
        XCTAssertEqual(rig.flow.state.firstLookKeys, .none, "taken once: a second Tab is the window's")
        rig.send(.key(.tab))
        XCTAssertEqual(rig.take(), [])
        XCTAssertEqual(rig.flow.state.first.run?.line()?.content.figure, .working)
        rig.clock.advance(by: 0.2)
        XCTAssertEqual(rig.flow.state.first.run?.line()?.content.figure, .absent, "the figure looks away and leaves")
        rig.clock.advance(by: 3)
        XCTAssertEqual(line(rig), "Filling 4 fields, 3 s")
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(stop: true))
    }

    func testTheLinesAreTheRealSurfacesOwn() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        rig.clock.advance(by: 4.2)
        let run = try XCTUnwrap(rig.flow.state.first.run)
        XCTAssertEqual(run.line(), WorkLines.working(app: "Safari", fillRows: 4, seconds: 4, figureLeft: true))
        rig.send(.taskProgress(progress(.verified)), .taskProgress(progress(.done, written: 4)))
        XCTAssertEqual(rig.flow.state.first.run?.line(), WorkLines.filled(4, from: "Mail"))
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
            guard case .asking(let id) = rig.flow.state.first.look else { return XCTFail("\(reason): \(rig.flow.state.first.look)") }
            XCTAssertEqual(rig.request?.requestId, id, "\(reason): a new request goes out")
            XCTAssertEqual(rig.flow.state.firstLookKeys, .none, "\(reason): Tab takes nothing while it looks")
        }
    }

    func testAPausedCaretLooksAgainForNothing() throws {
        let rig = shown(try found())
        var paused = CaretSettings()
        paused.paused = true
        rig.send(.settingsChanged(paused), withdrawn("first-look-1.0", .settings))
        XCTAssertEqual(rig.flow.state.first.look, .nothing, "paused asks for no family")
        XCTAssertNil(rig.request, "and sends no request")
    }

    func testASettingsWithdrawalAsksWithTheRolesAndLevelSavedSince() throws {
        let rig = shown(try found())
        var saved = CaretSettings()
        saved.roles.remove(.fill)
        saved.level = .quiet
        rig.send(.settingsChanged(saved), withdrawn("first-look-1.0", .settings))
        let request = try XCTUnwrap(rig.request)
        XCTAssertFalse(request.families.contains("fill"), "the family turned off is not asked for again")
        XCTAssertEqual(request.level, .quiet)
        XCTAssertEqual(rig.flow.state.roles, saved.roles)
    }

    func testAnyOtherWithdrawalLeavesNothingToTake() throws {
        for reason in [OfferWithdrawn.Reason.taken, .dismissed, .diverged, .idle, .stale, .expired] {
            let rig = shown(try found())
            rig.send(withdrawn("first-look-1.0", reason))
            XCTAssertEqual(rig.flow.state.first.look, .nothing, "\(reason)")
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
        XCTAssertEqual(rig.flow.state.first.run?.phase, .working, "the run's own progress ends it")
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
        XCTAssertEqual(try ended(.done, verified: 0), "Added to Safari", "nothing written: nothing to undo")
        XCTAssertEqual(try ended(.done, verified: 1, apps: nil), "Filled 1 field")
        XCTAssertEqual(try ended(.stopped, verified: 1), "Filled 1 field, then stopped: Safari changed while Caret worked")
        XCTAssertEqual(try ended(.handoff), "Your turn in Safari")
        XCTAssertNil(try ended(.paused), "paused: the line goes, as at the caret")
    }

    func testAnotherTasksProgressChangesNothing() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .taskProgress(progress(.done, task: "offer-5", written: 2)))
        XCTAssertEqual(rig.flow.state.first.run?.phase, .working)
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

    /// An action found by the first look (no fields block): Tab runs it; when its run says it wrote
    /// something, ⌘Z undoes it as on the real surfaces.
    private func foundAction() throws -> FirstLookReply.Found {
        let json = #"{"kind":"action","family":"pending","offerKey":"first-look-1.0","window":{"pid":5151,"windowId":"5151-2","appName":"Notes","title":"Draft"},"spec":{"v":1,"id":"fl","figure":"offering","blocks":[{"type":"header","title":{"text":"Write the note","ref":{"node":"5151-2/body"}}},{"type":"actions","items":[{"id":"run","label":"Write it","key":"tab"}]}]}}"#
        return try JSONDecoder().decode(FirstLookReply.Found.self, from: Data(json.utf8))
    }

    func testAnActionThatWroteTakesCommandZ() throws {
        let rig = Rig.atLook(settings: { var s = CaretSettings(); s.roles = [.fill, .watch]; return s }())
        rig.send(.firstLookReply(FirstLookReply(requestId: rig.request!.requestId, at: 1, outcome: .found, found: try foundAction())))
        rig.take()
        rig.send(.key(.tab), .taskProgress(progress(.done, written: 1)))
        XCTAssertEqual(rig.flow.state.firstLookKeys, FirstLookKeys(undo: true))
        XCTAssertEqual(rig.flow.state.first.run?.line()?.content.hints, [Hint(key: "⌘Z", label: "Undo")])
        rig.take()
        rig.send(.key(.undo))
        XCTAssertEqual(rig.take(), [.undo(TaskControl(taskId: "first-look-1.0", action: .undo))])

        let pressesOnly = Rig.atLook(settings: { var s = CaretSettings(); s.roles = [.fill, .watch]; return s }())
        pressesOnly.send(.firstLookReply(FirstLookReply(requestId: pressesOnly.request!.requestId, at: 1, outcome: .found, found: try foundAction())))
        pressesOnly.send(.key(.tab), .taskProgress(progress(.done, written: 0)))
        XCTAssertEqual(pressesOnly.flow.state.firstLookKeys, .none, "nothing written, nothing to undo")
    }

    func testTheHelpersStopCorrectsTheStepEscNamed() throws {
        let rig = shown(try found())
        rig.send(.key(.tab), .taskProgress(progress(.verified, step: 0, steps: 3)))
        rig.clock.advance(by: 3)
        rig.send(.key(.escape))
        XCTAssertEqual(line(rig), "You stopped it before step 2 of 3")
        rig.send(.taskProgress(progress(.verified, step: 1, steps: 3)), .taskProgress(progress(.stopped, reason: .you, step: 2, steps: 3)))
        XCTAssertEqual(line(rig), "You stopped it before step 3 of 3", "step 2 finished before the stop reached the helper")

        let finished = shown(try found())
        finished.send(.key(.tab))
        finished.clock.advance(by: 3)
        finished.send(.key(.escape), .taskProgress(progress(.done, written: 4)))
        XCTAssertEqual(line(finished), "Filled 4 fields from Mail", "the run finished before the stop reached it")

        let failed = shown(try found())
        failed.send(.key(.tab), .taskProgress(progress(.verified, step: 0, steps: 3)))
        failed.clock.advance(by: 3)
        failed.send(.key(.escape), .taskProgress(progress(.stopped, reason: .mismatch, step: 1, steps: 3)))
        XCTAssertEqual(line(failed), "Filled 1 field, then stopped: Safari didn't take the change", "the helper's failure is the true reason")
    }

    func testEscStopsOnlyAfterThreeSeconds() throws {
        let rig = shown(try found())
        rig.send(.key(.tab))
        rig.take()
        rig.clock.advance(by: 3)
        rig.send(.key(.escape))
        XCTAssertEqual(rig.take(), [.stop(OfferStop(offerId: "first-look-1.0", at: 1_790_000_003_000))])
        XCTAssertEqual(line(rig), "You stopped it", "no progress yet, so no step to name")
        XCTAssertEqual(rig.flow.state.step, .first)
        rig.send(.key(.escape))
        XCTAssertEqual(rig.flow.state.step, .first, "with nothing to stop and the offer taken, Esc does nothing")
        XCTAssertFalse(rig.flow.state.first.declined)
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
