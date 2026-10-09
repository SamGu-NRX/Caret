import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Every decision `FillCoordinator` used to make on screen, made by `FillMachine` against a fake
/// world and a manual clock.
final class FillMachineTests: XCTestCase {
    private let filled = "toast done Filled 1 field from Caret Fixture ⌘Z"

    /// A proposal arrives with the form in front and the email field focused: the offer is shown.
    private func shown() -> FillRig {
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose()
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(FillFx.caption) showLine"])
        return rig
    }

    /// Tab taken and the write verified: the toast is up and owns ⌘Z.
    private func toastUp() -> FillRig {
        let rig = shown()
        rig.press(Fx.tab())
        rig.world.focus(.email, value: FillFx.email)
        rig.inserted()
        XCTAssertEqual(rig.takeLog(), ["working", filled, "toast slot"])
        return rig
    }

    /// D2-04: a proposal Caret writes two fields of shows ⌘1, and ⌘1 asks the helper to fill the
    /// form in one run: nothing is typed into this field, and the slip goes.
    func testCommandOneOnAFieldsFillSendsFillAllForTheProposal() {
        let rig = shown()
        XCTAssertEqual(rig.draws.last?.fillAll, true, "two fields with a value and a source")
        rig.press(KeyStroke(keyCode: 18, command: true, targetPID: Fx.app))
        XCTAssertEqual(rig.takeLog(), ["fillAll fill-1", "hide offer"])
        XCTAssertNil(rig.inserting, "⌘1 types nothing into the field")
        XCTAssertNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.counts.last, "fill.fillAll")
    }

    /// A field already taken by Tab leaves the form part filled: the helper would refuse a Fill all
    /// of the proposal, so the next field's slip offers Tab alone (H6 review).
    func testAProposalPartlyTakenByTabNoLongerOffersFillAll() {
        let rig = toastUp()
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 5)
        XCTAssertEqual(rig.draws.last?.value, FillFx.phone)
        XCTAssertEqual(rig.draws.last?.fillAll, false)
    }

    /// One field to write is what Tab already does: no ⌘1, and ⌘1 keeps the app's meaning.
    func testAProposalWithOneWritableFieldLeavesCommandOneToTheApp() {
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose(FillFx.proposal(phone: nil))
        XCTAssertEqual(rig.draws.last?.fillAll, false)
        rig.press(KeyStroke(keyCode: 18, command: true, targetPID: Fx.app))
        XCTAssertFalse(rig.takeLog().contains { $0.hasPrefix("fillAll") })
    }

    /// The helper's count (fill-popup.ts writtenFields): text with a value and where it came from, and
    /// a control whose hand-off says Caret writes it; a control left to the user does not count.
    func testFillAllCountsTheFieldsTheHelperWrites() throws {
        let lines = try String(contentsOf: RoutingTests.fixture.deletingLastPathComponent().appendingPathComponent("fill-all.ndjson"), encoding: .utf8)
            .split(separator: "\n").map { Data($0.utf8) }
        guard case .fillProposal(let p) = try HelperInbound.decode(lines[1]) else { return XCTFail("line 2 is the proposal") }
        XCTAssertEqual(FillSelection.fillAllWrites(p), 5, "fill-all.ndjson's run writes 5")
        XCTAssertEqual(p.fields.filter { $0.handoff?.writes == true }.count, FillSelection.fillAllWrites(p) - p.fields.filter { $0.control == .text && $0.value != nil }.count)
    }

    func testAProposalForTheFocusedEmptyFieldIsShownAndHeldByTheArbiter() {
        let rig = shown()
        XCTAssertEqual(rig.arbiter.snapshot().current?.id, rig.machine.shownOfferID)
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.email)
        XCTAssertEqual(rig.machine.status.offersShown, 1)
        XCTAssertNil(rig.machine.status.lastSkip)
        XCTAssertEqual(rig.shownTriggers, [.proposal(1)])
        XCTAssertTrue(rig.machine.isWatching)
    }

    func testAnUnchangedReevaluationDoesNotRepublish() {
        let rig = shown()
        let published = rig.arbiter.snapshot().publishedCount
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        XCTAssertEqual(rig.arbiter.snapshot().publishedCount, published)
        XCTAssertEqual(rig.takeLog(), [])
    }

    func testAProposalForAnAppOutsideThePolicyIsNotHeld() {
        let rig = FillRig()
        rig.world.allowed = [Fx.other]
        rig.world.front(.email)
        rig.propose()
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertEqual(rig.machine.status.lastSkip, "notAllowed")
        XCTAssertEqual(rig.machine.status.cachedProposals, 0)
        XCTAssertEqual(rig.world.fieldReads, [], "nothing is read in an app Caret may not offer into")
    }

    func testAFieldThatAlreadyHasTextIsNeverOffered() {
        let rig = FillRig()
        rig.world.front(.email, value: "typed")
        rig.propose()
        XCTAssertEqual(rig.takeLog(), ["watch 5150"])
        XCTAssertEqual(rig.machine.status.lastSkip, "fieldNotEmpty")
        XCTAssertNil(rig.arbiter.snapshot().current)
    }

    func testAFieldAnsweredNoneShowsNothing() {
        let rig = FillRig()
        rig.world.front(.phone)
        rig.propose(FillFx.proposal(phone: nil))
        XCTAssertEqual(rig.machine.status.lastSkip, "answerNone")
        XCTAssertNil(rig.arbiter.snapshot().current)
    }

    func testAProposalForAnAppBehindIsHeldThenShownWhenItComesToTheFront() {
        let rig = FillRig()
        rig.world.focus(.email)
        rig.world.frontmostPID = Fx.other
        rig.propose()
        XCTAssertEqual(rig.machine.status.lastSkip, "held.appNotFront")
        XCTAssertNil(rig.arbiter.snapshot().current)
        rig.world.frontmostPID = Fx.app
        rig.machine.appActivated(pid: Fx.app)
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(FillFx.caption) showLine"])
        XCTAssertNotNil(rig.arbiter.snapshot().current)
    }

    func testMovingFocusToTheNextFieldMovesTheOffer() {
        let rig = shown()
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 5)
        // Publishing the new offer displaces the old one, whose ghost goes first.
        XCTAssertEqual(rig.takeLog(), ["hide offer", "offer \(FillFx.phone) \(FillFx.caption) showLine"])
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.phone)
        XCTAssertEqual(rig.shownTriggers.last, .focus(5))
    }

    func testFocusOnAFieldTheProposalDoesNotNameWithdrawsTheOffer() {
        let rig = shown()
        // Another element at a frame the proposal does not name. (The same element at a new
        // frame is the field moved, which binding still matches: A18, bug 12.)
        rig.world.focused[Fx.app]?.frame = CGRect(x: 10, y: 10, width: 50, height: 20)
        rig.world.focused[Fx.app]?.identity.elementID = "notes"
        rig.machine.fieldChanged(pid: Fx.app, at: 5)
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
        XCTAssertNil(rig.arbiter.snapshot().current, "Tab passes through once the offer is gone")
        XCTAssertEqual(rig.machine.status.lastSkip, "noFieldAtFocus")
    }

    func testTypingDismissesTheOfferAndPassesTheKey() {
        let rig = shown()
        rig.press(Fx.type("x"))
        XCTAssertEqual(rig.takeLog(), ["hide offer typing"])
        XCTAssertNil(rig.machine.shownOfferID)
    }

    func testAVerifiedFillShowsTheToastWithUndoAndReportsTheResult() {
        let rig = toastUp()
        XCTAssertEqual(rig.sent.map(\.outcome), [.inserted])
        XCTAssertEqual(rig.sent.first?.valueLength, FillFx.email.utf16.count)
        XCTAssertEqual(rig.machine.status.toast?.caption, "Filled 1 field from Caret Fixture")
        XCTAssertNotNil(rig.machine.toastGrantID)
        XCTAssertEqual(rig.arbiter.snapshot().toast?.id, rig.machine.toastGrantID, "⌘Z belongs to Caret while the toast is up")
    }

    func testTheToastAndItsUndoEndTogetherAfterFiveSeconds() {
        let rig = toastUp()
        rig.clock.advance(by: 4.9)
        XCTAssertNotNil(rig.arbiter.snapshot().toast)
        rig.clock.advance(by: 0.2)
        XCTAssertEqual(rig.takeLog().filter { $0.hasPrefix("hide toast") }, ["hide toast"])
        XCTAssertNil(rig.arbiter.snapshot().toast, "⌘Z is the app's again")
        XCTAssertNil(rig.machine.status.toast)
    }

    func testTheFormIsReadAgainSoonAfterAWrite() {
        let rig = toastUp()
        rig.world.focus(.phone)
        rig.clock.advance(by: FillMachine.rereadAfterWrite)
        XCTAssertEqual(rig.takeLog(), ["offer \(FillFx.phone) \(FillFx.caption) deferLine"], "the next field waits behind a toast from the same source")
        XCTAssertNotNil(rig.arbiter.snapshot().toast, "the toast keeps its undo while the next line waits")
    }

    func testUndoClearsTheFieldAndTheValueIsNotOfferedThereAgain() {
        let rig = toastUp()
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z did not take the grant") }
        rig.machine.undoStarted(grant)
        XCTAssertNil(rig.machine.toastGrantID)
        rig.machine.undoFinished(FillUndo(grant: grant, ok: true, error: nil))
        XCTAssertEqual(rig.takeLog(), ["toast undone Cleared 1 field"])
        XCTAssertEqual(rig.sent.map(\.outcome), [.inserted, .undone])
        rig.world.focus(.email)
        rig.clock.advance(by: 2.1)
        rig.machine.fieldChanged(pid: Fx.app, at: 9)
        XCTAssertEqual(rig.machine.status.lastSkip, "suppressed")
        XCTAssertNil(rig.arbiter.snapshot().current)
    }

    func testAnUndoThatFindsTheFieldChangedSaysSo() {
        let rig = toastUp()
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z did not take the grant") }
        rig.machine.undoStarted(grant)
        rig.machine.undoFinished(FillUndo(grant: grant, ok: false, error: "fieldChanged"))
        XCTAssertEqual(rig.takeLog(), ["toast error The field changed after the fill, so it was left as it is."])
        XCTAssertEqual(rig.sent.last?.outcome, .undoFailed)
        rig.clock.advance(by: 5.9)
        XCTAssertNotNil(rig.machine.status.toast)
        rig.clock.advance(by: 0.2)
        XCTAssertNil(rig.machine.status.toast, "an error lives 6 s")
    }

    func testAWriteThatDidNotVerifyShowsWhatHappenedAndIsNotOfferedAgain() {
        let rig = shown()
        rig.press(Fx.tab())
        rig.inserted(verified: false, reason: "source.valueGone")
        XCTAssertEqual(rig.takeLog(), ["working", "toast error The source changed, so nothing was filled."])
        XCTAssertEqual(rig.sent.map(\.outcome), [.failed])
        XCTAssertEqual(rig.sent.first?.reason, "source.valueGone")
        XCTAssertNil(rig.arbiter.snapshot().toast, "nothing was written, so ⌘Z is not Caret's")
        rig.clock.advance(by: FillMachine.rereadAfterWrite)
        XCTAssertEqual(rig.machine.status.lastSkip, "suppressed")
    }

    func testTypingAfterTheFillDismissesTheToastAndHandsBackCommandZ() {
        let rig = toastUp()
        rig.press(Fx.type("a"))
        XCTAssertEqual(rig.takeLog(), ["hide toast"])
        XCTAssertNil(rig.arbiter.snapshot().toast)
        XCTAssertEqual(rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now), .pass(.noOffer))
    }

    func testAnOfferFromAnotherSourceReplacesTheToastAndItsUndo() {
        let rig = toastUp()
        var other = FillFx.proposal(id: "fill-2")
        for i in other.fields.indices { other.fields[i].source?.windowTitle = "Invoice 2041" }
        rig.world.focus(.phone)
        rig.propose(other, at: 3)
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.phone) from Caret Fixture, Invoice 2041 replaceToast"])
        XCTAssertNil(rig.arbiter.snapshot().toast)
        XCTAssertNil(rig.machine.status.toast)
    }

    func testLosingSightOfTheFormTakesEverythingDown() {
        let rig = toastUp()
        rig.world.frontmostPID = Fx.other
        rig.clock.advance(by: FillMachine.recheckInterval)
        XCTAssertEqual(rig.takeLog(), ["hide all"])
        XCTAssertNil(rig.arbiter.snapshot().toast)
        XCTAssertFalse(rig.machine.isWatching)
        XCTAssertTrue(rig.machine.status.lastSkip?.hasPrefix("held.appNotFront") ?? false)
    }

    func testACoveredFieldWithdrawsTheOffer() {
        let rig = shown()
        rig.world.covered = true
        rig.machine.appActivated(pid: Fx.other)
        XCTAssertEqual(rig.takeLog(), ["hide offer", "hide all"])
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.counts.filter { $0.hasPrefix("fill.withdrawn") }, ["fill.withdrawn.covered"])
    }

    func testAProposalOlderThanTwoMinutesIsDropped() {
        let rig = shown()
        rig.clock.advance(by: FillMachine.proposalMaxAge + 1)
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 9)
        XCTAssertEqual(rig.takeLog(), ["unwatch 5150", "hide offer"])
        XCTAssertEqual(rig.machine.status.cachedProposals, 0)
    }

    func testNothingIsReadWhileAClaimIsBeingWritten() {
        let rig = shown()
        rig.press(Fx.tab())
        rig.takeLog()
        let reads = rig.world.fieldReads.count
        rig.machine.fieldChanged(pid: Fx.app, at: 9)
        XCTAssertEqual(rig.world.fieldReads.count, reads)
        XCTAssertTrue(rig.counts.contains("fill.skip.inserting"))
    }

    func testAnotherProducersOfferDisplacesTheFill() {
        let rig = shown()
        rig.arbiter.publish(Offer(text: "hello", target: Fx.identity(.email, window: "5150-1"), fieldValue: "", caretUTF16: 0))
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
        XCTAssertNil(rig.machine.shownOfferID)
    }

    func testClosingTheGateDropsTheOfferAndEveryHeldProposal() {
        let rig = shown()
        rig.machine.gateClosed()
        XCTAssertEqual(rig.takeLog(), ["unwatch 5150", "hide offer"])
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.machine.status.cachedProposals, 0)
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 9)
        XCTAssertNil(rig.arbiter.snapshot().current, "a held proposal cannot come back after pause")
    }

    func testShutdownTakesTheFillOfferOutOfTheArbiter() {
        let rig = shown()
        rig.machine.shutdown()
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.takeLog(), ["hide all"])
        XCTAssertEqual(rig.clock.live, 0, "no timer outlives shutdown")
    }

    func testErrorCaptionsNameWhatHappenedAndWhatNext() {
        XCTAssertEqual(FillMachine.errorCaption("source.valueGone"), "The source changed, so nothing was filled.")
        XCTAssertEqual(FillMachine.errorCaption("targetMoved"), "The field changed, so nothing was filled.")
        XCTAssertEqual(FillMachine.errorCaption("offerExpired"), "That suggestion was too old, so nothing was filled.")
        XCTAssertEqual(FillMachine.errorCaption("writeIgnored"), "The field didn't take the value. Type it in to fill it.")
        XCTAssertEqual(FillMachine.errorCaption(nil), "Nothing was filled.")
    }
}

/// The arbiter's one toast slot, shared by its two real owners: `FillMachine`'s fill line and
/// `SurfaceMachine`'s fill pop-up. Wired as `HostRuntime` wires them: each one's
/// `toastSlotTaken` calls the other's `toastChanged`, and every key decision reaches both.
final class SharedToastSlotTests: XCTestCase {
    final class TwoOwners {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let surface: SurfaceRig
        let fill: FillRig

        init() {
            surface = SurfaceRig(arbiter: arbiter, clock: clock)
            fill = FillRig(arbiter: arbiter, clock: clock)
            let (s, f) = (surface.machine, fill.machine)
            surface.onToastSlotTaken = { f.toastChanged() }
            fill.onToastSlotTaken = { s.toastChanged() }
            arbiter.onDisplaced = { offer in
                s.displaced(offer)
                f.displaced(offer)
            }
        }

        /// One key, routed to both owners as `HostRuntime` routes the tap's decision.
        func press(_ key: KeyStroke) {
            switch arbiter.handleKeyDown(key, now: clock.now) {
            case .consume(let claim):
                surface.machine.claimed(claim)
                fill.route(.consume(claim))
            case .undo(let grant):
                if grant.taskID != nil { surface.machine.undoStarted(grant) } else { fill.machine.undoStarted(grant) }
            case .closeToast:
                surface.machine.offerChanged(.toastDismissed)
                fill.machine.offerChanged(.toastDismissed)
            case .navigate(let id, let ui): surface.machine.navigated(offerID: id, ui: ui)
            case .closeOffer:
                surface.machine.offerChanged(.closed)
                fill.machine.offerChanged(.closed)
            case .stopWork(let line): surface.machine.stopWork(line)
            case .closeStatus:
                surface.machine.offerChanged(.statusDismissed)
                fill.machine.offerChanged(.statusDismissed)
            case .pass(.noOffer), .pass(.otherApp), .pass(.modifierOnly): break
            case .pass(let reason):
                surface.machine.offerChanged(reason)
                fill.machine.offerChanged(reason)
            }
        }

        /// The fill pop-up shown in the email field and taken with Tab: its run is working.
        func popupWorking() {
            surface.screen.front(.email)
            surface.machine.receive(Fx.fillPopup())
            press(Fx.tab())
        }

        func popupDone() {
            for phase in [TaskProgress.Phase.verified, .verified, .done] { surface.machine.taskProgress(Fx.progress("fill-2", phase)) }
        }

        /// The user moves to the phone field and the fill line offers its value there.
        func fillLineOffered() {
            surface.screen.front(.phone)
            fill.world.front(.phone)
            fill.propose(FillFx.proposal(email: nil))
        }

        /// Tab on the fill line's value, and the insertion queue's answer.
        func fillLineTaken(verified: Bool = true) {
            press(Fx.tab())
            fill.world.focus(.phone, value: verified ? FillFx.phone : "")
            fill.inserted(verified: verified, reason: verified ? nil : "writeIgnored")
        }
    }

    func testThePopupRunsToastTakesTheSlotFromTheFillLine() {
        // The pop-up's run is still working when the user fills the next field with the fill line;
        // then the run finishes. Its toast is the newer, and takes the slot.
        let rig = TwoOwners()
        rig.popupWorking()
        rig.fillLineOffered()
        rig.fillLineTaken()
        XCTAssertNotNil(rig.fill.machine.toastGrantID)
        rig.fill.takeLog()
        rig.popupDone()
        XCTAssertNil(rig.fill.machine.toastGrantID, "the fill line gave up its ⌘Z")
        XCTAssertEqual(rig.fill.takeLog(), ["hide toast"], "and took its toast down")
        XCTAssertEqual(rig.arbiter.snapshot().toast?.taskID, "fill-2")
        rig.press(Fx.cmdZ())
        XCTAssertEqual(rig.surface.sent.last, "undo fill-2", "⌘Z undoes the run whose toast is on screen")
        XCTAssertEqual(rig.fill.sent.map(\.outcome), [.inserted], "and not the fill line's write")
    }

    func testTheFillLinesToastTakesTheSlotFromThePopupsToast() {
        let rig = TwoOwners()
        rig.popupWorking()
        rig.popupDone()
        XCTAssertNotNil(rig.surface.machine.toastGrantID)
        rig.fillLineOffered()
        rig.surface.takeLog()
        rig.fillLineTaken()
        XCTAssertNil(rig.surface.machine.toastGrantID, "the pop-up gave up its ⌘Z")
        XCTAssertNil(rig.surface.machine.toastInfo)
        XCTAssertEqual(rig.surface.takeLog(), ["hide 0.08"], "and took its line down")
        guard case .undo(let taken) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z did not go to the fill line") }
        XCTAssertNil(taken.taskID)
        XCTAssertEqual(taken.writtenValue, FillFx.phone)
    }

    func testATabOnTheFillLineTakesThePopupsToastDownEvenWhenTheFillFails() {
        // Regression: the Tab cleared the pop-up's grant in the arbiter, but SurfaceMachine heard
        // only `claimed` for an offer not its own and left "⌘Z Undo" on screen owning nothing.
        let rig = TwoOwners()
        rig.popupWorking()
        rig.popupDone()
        rig.fillLineOffered()
        rig.surface.takeLog()
        rig.fillLineTaken(verified: false)
        XCTAssertNil(rig.surface.machine.toastInfo)
        XCTAssertEqual(rig.surface.takeLog(), ["hide 0.08"])
        XCTAssertNil(rig.arbiter.snapshot().toast, "a failed fill leaves ⌘Z to the app")
    }

    func testATabOnTheFillLineTakesAnActionsResultLineDown() {
        // Review finding: a plain result line (no undo) stayed up after another owner's Tab
        // cleared its status in the arbiter.
        let rig = TwoOwners()
        rig.surface.screen.front(.email)
        rig.surface.machine.receive(Fx.action())
        rig.press(Fx.tab())
        rig.surface.machine.taskProgress(Fx.progress("offer-5", .done))
        XCTAssertNotNil(rig.surface.machine.lineText)
        rig.fillLineOffered()
        rig.surface.takeLog()
        rig.fillLineTaken()
        XCTAssertNil(rig.surface.machine.lineText)
        XCTAssertEqual(rig.surface.takeLog(), ["hide 0.08"])
    }

    func testPauseWithdrawsAShownOfferAndStopsAHeldOnesRetries() {
        let rig = TwoOwners()
        rig.surface.screen.behind()
        rig.surface.machine.receive(Fx.action())
        XCTAssertEqual(rig.surface.machine.held, .appNotFront)
        rig.surface.machine.gateClosed()
        XCTAssertNil(rig.surface.machine.held)
        rig.surface.screen.front(.email)
        rig.clock.advance(by: 2)
        XCTAssertNil(rig.surface.machine.shown, "nothing held is retried once paused")
        rig.surface.machine.receive(Fx.action())
        XCTAssertNotNil(rig.surface.machine.shown)
        rig.surface.machine.gateClosed()
        XCTAssertNil(rig.surface.machine.shown)
        XCTAssertNil(rig.arbiter.snapshot().current)
    }

    func testEscClosesTheToastOnScreenAndNothingElse() {
        let rig = TwoOwners()
        rig.popupWorking()
        rig.fillLineOffered()
        rig.fillLineTaken()
        rig.fill.takeLog()
        rig.press(Fx.esc())
        XCTAssertEqual(rig.fill.takeLog(), ["hide toast"])
        XCTAssertNil(rig.arbiter.snapshot().toast)
        XCTAssertEqual(rig.surface.machine.workingOn, "fill-2", "the pop-up's run goes on")
    }

    func testTheReplacedToastsTimerDoesNotEndTheNewerToast() {
        let rig = TwoOwners()
        rig.popupWorking()
        rig.fillLineOffered()
        rig.fillLineTaken()
        rig.clock.advance(by: 1)
        rig.popupDone()
        let popupGrant = rig.surface.machine.toastGrantID
        rig.clock.advance(by: 4.5)
        XCTAssertEqual(rig.arbiter.snapshot().toast?.id, popupGrant, "the fill line's 5 s ran out at 5 s, after it gave way")
        XCTAssertEqual(rig.fill.takeLog().filter { $0.hasPrefix("hide toast") }.count, 1)
        rig.clock.advance(by: 1)
        XCTAssertNil(rig.arbiter.snapshot().toast, "the pop-up's own 5 s end its toast")
    }
}

/// Per-field fills from what the user told Caret (brief A14, part 2): an About entry's value is
/// offered like a window's, named "from what you told Caret", and never from an entry the user
/// changed after the proposal came.
final class MemoryFillTests: XCTestCase {
    private let memoryCaption = "from what you told Caret"

    private func shown() -> FillRig {
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose(FillFx.memoryProposal())
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(memoryCaption) showLine"])
        return rig
    }

    func testAValueFromMemoryIsOfferedAndNamesWhatYouToldCaret() {
        let rig = shown()
        XCTAssertEqual(rig.arbiter.snapshot().current?.kind.fillOrigin?.source, .memory(id: FillFx.emailEntry))
        rig.press(Fx.tab())
        rig.world.focus(.email, value: FillFx.email)
        rig.inserted()
        XCTAssertEqual(rig.takeLog(), ["working", "toast done Filled 1 field from what you told Caret ⌘Z", "toast slot"])
        XCTAssertEqual(rig.sent.map(\.outcome), [.inserted])
    }

    func testTheSameProposalsWindowValueStillNamesItsWindow() {
        let rig = FillRig()
        rig.world.front(.phone)
        rig.propose(FillFx.memoryProposal())
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.phone) \(FillFx.caption) showLine"])
    }

    func testForgettingTheEntryTakesItsValueDownAndKeepsItDown() {
        let rig = shown()
        rig.clock.advance(by: 1)
        rig.machine.memoryChanged(id: FillFx.emailEntry)
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
        XCTAssertNil(rig.arbiter.snapshot().current, "Tab passes through once the value is gone")
        XCTAssertEqual(rig.machine.status.lastSkip, "memoryChanged")
        rig.machine.fieldChanged(pid: Fx.app, at: 3)
        XCTAssertNil(rig.arbiter.snapshot().current, "the held proposal is not offered from the entry again")
        // Its window value is unaffected.
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 4)
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.phone)
    }

    func testAChangeAtTheSameMomentAsTheProposalCountsAsAfterIt() {
        let rig = FillRig()
        rig.world.front(.email)
        rig.machine.memoryChanged(id: FillFx.emailEntry)
        rig.propose(FillFx.memoryProposal())
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.machine.status.lastSkip, "memoryChanged")
    }

    func testAProposalAfterTheChangeIsOffered() {
        let rig = shown()
        rig.clock.advance(by: 1)
        rig.machine.memoryChanged(id: FillFx.emailEntry)
        rig.takeLog()
        rig.clock.advance(by: 1)
        // The helper's next proposal is made from the entry as it is now.
        rig.propose(FillFx.memoryProposal(id: "fill-m2"))
        XCTAssertEqual(rig.arbiter.snapshot().current?.kind.fillOrigin?.proposalID, "fill-m2")
    }

    func testAChangeToAnEntryLeavesAWindowValueOnScreenUp() {
        let rig = FillRig()
        rig.world.front(.phone)
        rig.propose(FillFx.memoryProposal())
        rig.takeLog()
        let shownID = rig.machine.shownOfferID
        rig.clock.advance(by: 1)
        rig.machine.memoryChanged(id: FillFx.emailEntry)
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertEqual(rig.arbiter.snapshot().current?.id, shownID)
        // The email field is skipped when it is next evaluated.
        rig.world.focus(.email)
        rig.machine.fieldChanged(pid: Fx.app, at: 3)
        XCTAssertEqual(rig.machine.status.lastSkip, "memoryChanged")
    }

    func testAnotherEntrysChangeLeavesTheOfferUp() {
        let rig = shown()
        let shownID = rig.machine.shownOfferID
        rig.clock.advance(by: 1)
        rig.machine.memoryChanged(id: "about-name")
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertEqual(rig.arbiter.snapshot().current?.id, shownID)
    }

    // MARK: - Bug 12 (A18): a field focused after the page moved

    /// The proposal arrives at Email; the page then moves every field down 40 pt (HubSpot scrolled
    /// the next field into view). Phone, focused at its new frame, is matched by its element.
    func testAFieldFocusedAfterThePageMovedIsMatchedByItsElement() {
        let rig = FillRig()
        rig.world.front(.email, value: "typed")
        rig.propose()
        XCTAssertEqual(rig.world.bindCalls, 1)
        XCTAssertTrue(rig.counts.contains("fill.bound.all"))
        rig.world.layoutShift = 40
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.phone)
        XCTAssertEqual(rig.world.bindCalls, 1, "bound once per proposal")
    }

    func testAShownValueFollowsItsFieldWhenThePageMoves() {
        let rig = shown()
        rig.world.layoutShift = 40
        rig.world.focus(.email)
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        let log = rig.takeLog()
        XCTAssertEqual(log.first, "hide offer")
        XCTAssertEqual(log.count, 2)
        XCTAssertTrue(log.last?.hasPrefix("offer \(FillFx.email) ") == true, "drawn again at the new frame: \(log)")
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.email)
    }

    func testWithoutABindingAMovedFieldIsStillNotGuessed() {
        let rig = FillRig()
        rig.world.bindable = false
        rig.world.front(.email, value: "typed")
        rig.propose()
        rig.world.layoutShift = 40
        rig.world.focus(.phone)
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.machine.status.lastSkip, "noFieldAtFocus")
    }

    func testAProposalForAnAppBehindIsBoundOnlyOnceItIsInFront() {
        let rig = FillRig()
        rig.world.focus(.email)
        rig.world.frontmostPID = Fx.other
        rig.propose()
        XCTAssertEqual(rig.world.bindCalls, 0, "a background app is not hit-tested")
        rig.world.frontmostPID = Fx.app
        rig.machine.appActivated(pid: Fx.app)
        XCTAssertEqual(rig.world.bindCalls, 1)
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.email)
    }

    func testNothingIsBoundWhileTheFocusedFieldIsNotOneTheProposalNames() {
        let rig = FillRig()
        rig.world.front(.email, value: "typed")
        rig.world.focused[Fx.app]?.frame = CGRect(x: 10, y: 10, width: 50, height: 20)
        rig.propose()
        XCTAssertEqual(rig.world.bindCalls, 0, "no frame match: no evidence this window is the proposal's")
    }

    func testOnlyTheFocusedWindowsElementsAreBoundAndAPartialBindingIsRetried() {
        let rig = FillRig()
        rig.world.bindable = false
        rig.world.front(.email, value: "typed")
        rig.propose()
        XCTAssertEqual(rig.world.bindWindows, ["5150-1"], "bound in the focused field's window")
        rig.world.bindable = true
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        XCTAssertEqual(rig.world.bindCalls, 2, "a binding that found nothing is tried again")
        rig.machine.fieldChanged(pid: Fx.app, at: 3)
        XCTAssertEqual(rig.world.bindCalls, 2, "once every field is bound, no more hit-tests")
    }

    func testTheElementWinsOverAStaleFrame() {
        let proposal = FillFx.proposal()
        let email = Fx.Element.email.frame
        // Phone's element now sits where Email was proposed; the frame alone would say Email.
        let result = FillSelection.select(
            proposal, focusedFrame: Frame(x: email.minX, y: email.minY, width: email.width, height: email.height),
            focusedValue: "", secure: false, focusedElementID: "phone", bound: ["k:email": "email", "k:phone": "phone"]
        )
        guard case .offer(let field, _) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(field.key, "k:phone")
    }
}

/// CodeRabbit on PR #8, findings on FillMachine.swift.
final class FillMachineReviewTests: XCTestCase {
    private func shown() -> FillRig {
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose()
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(FillFx.caption) showLine"])
        return rig
    }

    /// A proposal held for a background app is evaluated when that app's focus or value changes. Its
    /// skip used to take down the offer the user was looking at in the front app.
    func testASkipInABackgroundAppLeavesTheFrontAppsOfferUp() throws {
        let rig = shown()
        let line = FillFx.line(id: "fill-other").replacingOccurrences(of: "\"pid\":5150,\"windowId\":\"5150-1\"", with: "\"pid\":\(Fx.other),\"windowId\":\"\(Fx.other)-1\"")
        guard case .fillProposal(let other) = try HelperInbound.decode(Data(line.utf8)) else { return XCTFail("not a proposal") }
        XCTAssertEqual(other.windowId, "\(Fx.other)-1")
        rig.propose(other)
        XCTAssertEqual(rig.machine.status.lastSkip, "fieldUnreadable", "the background app has no focused field to read")
        rig.machine.fieldChanged(pid: Fx.other, at: 3)
        XCTAssertNotNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.arbiter.snapshot().current?.id, rig.machine.shownOfferID)
        XCTAssertFalse(rig.takeLog().contains("hide offer"))
        // The front app's own skip still takes it down.
        rig.world.focused[Fx.app] = nil
        rig.machine.fieldChanged(pid: Fx.app, at: 4)
        XCTAssertNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
    }

    /// A verified write that left no undo grant filled the field. It said "Nothing was filled.".
    func testAVerifiedFillWithNoUndoSaysFilledWithoutUndo() {
        let rig = shown()
        rig.press(Fx.tab())
        rig.world.focus(.email, value: FillFx.email)
        rig.inserted(grantsUndo: false)
        XCTAssertEqual(rig.takeLog(), ["working", "toast done Filled 1 field from Caret Fixture", "toast slot"])
        XCTAssertEqual(rig.sent.last?.outcome, .inserted)
        XCTAssertNil(rig.machine.toastGrantID, "no ⌘Z without a grant")
        XCTAssertTrue(rig.machine.toastVisible)
        rig.clock.advance(by: UndoGrant.defaultLifetime + 0.1)
        XCTAssertFalse(rig.machine.toastVisible)
    }
}
