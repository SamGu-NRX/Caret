import XCTest
@testable import CaretHostCore

/// Alternatives and pop-up navigation: what each owned key does (`SURFACES.md` sections 2 to 4).
final class AlternativesTests: XCTestCase {
    typealias K = KeyOwnershipTests
    let pid = KeyOwnershipTests.pid

    func key(_ code: Int64, command: Bool = false, shift: Bool = false) -> KeyStroke {
        KeyStroke(keyCode: code, command: command, shift: shift, targetPID: pid)
    }
    var down: KeyStroke { key(KeyStroke.downKeyCode) }
    var up: KeyStroke { key(KeyStroke.upKeyCode) }
    var esc: KeyStroke { key(KeyStroke.escapeKeyCode) }
    func cmd(_ n: Int) -> KeyStroke { key(Int64(17 + n), command: true) }

    private func ui(_ decision: OfferArbiter.Decision, file: StaticString = #filePath, line: UInt = #line) -> OfferUI? {
        guard case .navigate(_, let ui) = decision else {
            XCTFail("expected navigate, got \(decision)", file: file, line: line)
            return nil
        }
        return ui
    }

    private func claim(_ decision: OfferArbiter.Decision, file: StaticString = #filePath, line: UInt = #line) throws -> Claim {
        guard case .consume(let claim) = decision else {
            XCTFail("expected a claim, got \(decision)", file: file, line: line)
            throw XCTSkip("no claim")
        }
        return claim
    }

    func testDownOpensOnTheSecondCandidateAndTheArrowsWrap() {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.candidate, 1, "one key, one change")
        XCTAssertTrue(arbiter.snapshot().ui.open)
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.candidate, 2)
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.candidate, 3)
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.candidate, 0)
        XCTAssertEqual(ui(arbiter.handleKeyDown(up))?.candidate, 3)
    }

    func testCommandDigitSelectsAndTabTakesTheSelection() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        _ = arbiter.handleKeyDown(down)
        _ = arbiter.handleKeyDown(down)
        XCTAssertEqual(ui(arbiter.handleKeyDown(cmd(2)))?.candidate, 1)
        let taken = try claim(arbiter.handleKeyDown(.tab(to: pid)))
        XCTAssertEqual(taken.insertionText, "notes after lunch")
        XCTAssertEqual(arbiter.snapshot().lastClaim?.candidate, 1)
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testCommandOnePassesThroughWhileOnlyGhostTextIsVisible() {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        XCTAssertEqual(arbiter.handleKeyDown(cmd(1)), .pass(.dismissed))
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testEscReturnsToTheFirstCandidateAndKeepsTheGhost() {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        _ = arbiter.handleKeyDown(down)
        let after = ui(arbiter.handleKeyDown(esc))
        XCTAssertEqual(after?.candidate, 0)
        XCTAssertEqual(after?.open, false)
        XCTAssertNotNil(arbiter.snapshot().current)
        // A second Esc closes the ghost itself.
        guard case .closeOffer = arbiter.handleKeyDown(esc) else { return XCTFail("second Esc did not close") }
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testTypingWhileOpenDismissesEverything() {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        _ = arbiter.handleKeyDown(down)
        XCTAssertEqual(arbiter.handleKeyDown(.typing("n", to: pid)), .pass(.dismissed))
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testTypingThroughTheTopCandidateHidesTheOthers() {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost(K.four))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("s", to: pid)), .pass(.typedThrough))
        // The others no longer fit what is in the field, so the down arrow is the app's again.
        XCTAssertEqual(arbiter.handleKeyDown(down), .pass(.dismissed))
    }

    func testShiftTabTakesOneWordOfTheCurrentCandidate() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.ghost([" summary to the team", "x"]))
        let taken = try claim(arbiter.handleKeyDown(key(KeyStroke.tabKeyCode, shift: true)))
        XCTAssertEqual(taken.insertionText, " summary")
        XCTAssertTrue(taken.choice.wordOnly)
        XCTAssertEqual(OfferArbiter.nextWord("word"), "word")
        XCTAssertEqual(OfferArbiter.nextWord("  two words"), "  two")
    }

    // MARK: - Pop-ups

    func testEventCardCommandTwoRevealsTimesThenTabAddsTheChosenOne() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.popup("eventCard"))
        let revealed = ui(arbiter.handleKeyDown(cmd(2)))
        XCTAssertEqual(revealed?.revealed, "changeTime")
        XCTAssertEqual(revealed?.highlight, 1, "the card's own time stays highlighted")
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.highlight, 2)
        XCTAssertEqual(ui(arbiter.handleKeyDown(cmd(1)))?.highlight, 0, "Command-digits now choose rows")
        let taken = try claim(arbiter.handleKeyDown(.tab(to: pid)))
        XCTAssertEqual(taken.choice.actionID, "add")
        XCTAssertEqual(taken.choice.row, 0)
        XCTAssertFalse(taken.insertsText)
        XCTAssertEqual(arbiter.snapshot().lastClaim?.outcome, .accepted)
        XCTAssertNil(arbiter.snapshot().insertingClaimID, "an accepted action does not block new offers")
    }

    func testPickerHighlightsWithCommandDigitAndTakesWithTab() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.popup("picker"))
        XCTAssertEqual(arbiter.snapshot().ui.highlight, 0)
        XCTAssertEqual(ui(arbiter.handleKeyDown(cmd(3)))?.highlight, 2)
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.highlight, 0)
        let taken = try claim(arbiter.handleKeyDown(.tab(to: pid)))
        XCTAssertEqual(taken.choice.actionID, "choose")
        XCTAssertEqual(taken.choice.row, 0)
    }

    func testFillPreviewDownArrowTakesItsAction() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.popup("fillPreview"))
        XCTAssertEqual(try claim(arbiter.handleKeyDown(down)).choice.actionID, "reviewOne")
    }

    func testActionLineDownOpensItsVariantsAsAPicker() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.actionLine(numbered: true, variants: true))
        let opened = ui(arbiter.handleKeyDown(down))
        XCTAssertEqual(opened?.expanded, true)
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.highlight, 1)
        XCTAssertEqual(ui(arbiter.handleKeyDown(up))?.highlight, 0)
        let taken = try claim(arbiter.handleKeyDown(.tab(to: pid)))
        XCTAssertEqual(taken.choice.actionID, "choose")
        XCTAssertEqual(taken.choice.row, 0)
    }

    func testActionLineCommandDigitTakesItsNumberedAction() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(K.actionLine(numbered: true, variants: false))
        XCTAssertEqual(try claim(arbiter.handleKeyDown(cmd(2))).choice.actionID, "open")
    }

    func testARevealBoundToTabRevealsInsteadOfAccepting() throws {
        var spec = K.spec("eventCard")
        // Rebind the reveal to the down arrow: whichever key carries it, it reveals.
        spec.blocks[3] = PopupSpec.Block(.actions(PopupSpec.Actions(items: [
            PopupSpec.Action(id: "add", label: "Add", key: .tab),
            PopupSpec.Action(id: "changeTime", label: "Change time", key: .down, reveal: spec.actions[1].reveal),
        ])))
        let arbiter = OfferArbiter()
        arbiter.publish(Offer(text: "", source: .debug, kind: .popup(PopupOffer(offerKey: "k", spec: spec)), target: K.target(), fieldValue: K.value, caretUTF16: 0))
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.revealed, "changeTime")
        XCTAssertEqual(ui(arbiter.handleKeyDown(down))?.highlight, 2, "after the reveal the arrow moves through the times")
    }

    func testAnActionLinesVariantsHonorTheirOwnReveal() throws {
        var line = K.actionLine(numbered: false, variants: false)
        guard case .action(var action) = line.kind else { return XCTFail() }
        action.variants = K.spec("eventCard")
        line.kind = .action(action)
        let arbiter = OfferArbiter()
        arbiter.publish(line)
        _ = arbiter.handleKeyDown(down)
        let revealed = ui(arbiter.handleKeyDown(cmd(2)))
        XCTAssertEqual(revealed?.revealed, "changeTime")
        XCTAssertEqual(arbiter.snapshot().current?.visibleSpec(ui: arbiter.snapshot().ui)?.rowCount, 3)
        XCTAssertEqual(try claim(arbiter.handleKeyDown(.tab(to: pid))).choice.row, 1)
    }

    func testPublishingOverAnOfferTellsWhoDrewIt() throws {
        let arbiter = OfferArbiter()
        final class Box: @unchecked Sendable { var displaced: [UInt64] = [] }
        let box = Box()
        arbiter.onDisplaced = { box.displaced.append($0.id) }
        let first = try XCTUnwrap(arbiter.publish(K.ghost()))
        arbiter.publish(K.popup("picker"))
        XCTAssertEqual(box.displaced, [first])
    }

    func testEscStopsWorkOnlyAfterThreeSeconds() {
        let arbiter = OfferArbiter()
        arbiter.showStatus(StatusLine(pid: pid, kind: .working(startedAt: Date(timeIntervalSinceNow: -3.2)), offerKey: "line-1"))
        guard case .stopWork(let line) = arbiter.handleKeyDown(esc) else { return XCTFail("Esc did not stop") }
        XCTAssertEqual(line.offerKey, "line-1")
    }
}
