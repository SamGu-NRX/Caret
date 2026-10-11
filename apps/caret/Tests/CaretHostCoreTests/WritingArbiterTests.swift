import CaretHostCore
import CaretScreenCore
import XCTest

/// A writing offer in the arbiter's one slot: who may replace whom (`WritingOffer.incomingWins`),
/// which keys it takes (`KeyOwnership` from `ownsTab`), and the claim Tab hands the executor.
final class WritingArbiterTests: XCTestCase {
    let pid: Int32 = 4242
    let text = "At the the cafe we was late."

    func target(_ value: String) -> TargetIdentity {
        TargetIdentity(pid: pid, bundleID: "com.apple.TextEdit", windowID: "w1", elementID: "body", elementRevision: UTF16Text.digest(value))
    }

    func live(_ value: String, caret: Int? = nil) -> RangeEdit.Live {
        RangeEdit.Live(target: target(value), value: value, selection: .caret(caret ?? UTF16Text.length(value)))
    }

    func mark(_ word: String, _ replacement: String, others: [String] = [], needsChoice: Bool = false) -> WritingCorrection {
        WritingCorrection(
            span: UTF16Span((text as NSString).range(of: word)), original: word, replacement: replacement, otherReplacements: others,
            kind: .grammar, reason: "Agreement", source: .spellChecker, needsChoice: needsChoice
        )
    }

    func writingOffer(_ marks: [WritingCorrection]? = nil) -> Offer {
        let writing = WritingOffer.correction(
            marks: marks ?? [mark("the the", "the"), mark("was", "were", others: ["are"])],
            checkedRevision: UTF16Text.digest(text), live: live(text)
        )!
        return Offer(text: "", kind: .writing(writing), target: target(text), fieldValue: text, caretUTF16: UTF16Text.length(text))
    }

    func ghostOffer() -> Offer {
        Offer(text: " Then", target: target(text), fieldValue: text, caretUTF16: UTF16Text.length(text))
    }

    func actionOffer() -> Offer {
        let line = ActionLine(
            offerKey: "k1", app: "Calendar", endState: PopupSpec.Value("Lunch, Tue 12:00", ref: .node(key: "4242-1/compose/body", quote: nil)),
            actions: [PopupSpec.Action(id: "add", label: "Add", key: .tab)]
        )
        return Offer(text: "", source: .helper, kind: .action(line), target: target(text), fieldValue: text, caretUTF16: 0)
    }

    func key(_ code: Int64, command: Bool = false, text: String? = nil) -> KeyStroke {
        KeyStroke(keyCode: code, command: command, text: text, targetPID: pid)
    }

    // MARK: - The slot

    func testACorrectionTakesTheSlotFromGhostText() {
        let arbiter = OfferArbiter()
        var displaced: [String] = []
        arbiter.onDisplaced = { displaced.append($0.kind.name) }
        XCTAssertNotNil(arbiter.publish(ghostOffer()))
        XCTAssertNotNil(arbiter.publish(writingOffer()))
        XCTAssertEqual(displaced, ["ghost"])
        XCTAssertEqual(arbiter.snapshot().current?.kind.name, "writing")
    }

    func testGhostTextCannotTakeTheSlotFromACorrectionLine() {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(writingOffer()))
        XCTAssertNil(arbiter.publish(ghostOffer()))
        XCTAssertEqual(arbiter.snapshot().current?.kind.name, "writing")
        XCTAssertEqual(arbiter.snapshot().refusedPublishCount, 1)
    }

    /// The line of a correction that needs a choice owns no Tab, but it still holds ↓ and Esc, so
    /// ghost text does not replace it under the user's eyes.
    func testALineThatNeedsAChoiceStillHoldsTheSlot() {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(writingOffer([mark("was", "were", others: ["are"], needsChoice: true)])))
        XCTAssertNil(arbiter.publish(ghostOffer()))
    }

    func testHelperOffersOutrankWriting() {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(writingOffer()))
        XCTAssertNotNil(arbiter.publish(actionOffer()), "a helper offer replaces a correction")
        XCTAssertNil(arbiter.publish(writingOffer()), "a correction does not replace a helper offer")
    }

    func testANewerCorrectionReplacesAnOlderOneUnlessTheUserIsInTheList() {
        let arbiter = OfferArbiter()
        let first = arbiter.publish(writingOffer())!
        let second = arbiter.publish(writingOffer())
        XCTAssertNotNil(second)
        XCTAssertNotEqual(second, first)
        _ = arbiter.handleKeyDown(key(KeyStroke.downKeyCode))
        XCTAssertNil(arbiter.publish(writingOffer()), "the open list is not replaced")
    }

    func testOtherOffersStillReplaceEachOtherAsBefore() {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(actionOffer()))
        XCTAssertNotNil(arbiter.publish(ghostOffer()), "newest wins when no writing offer is involved")
    }

    // MARK: - Keys

    func testKeyOwnershipOfTheWritingSurfaces() {
        XCTAssertTrue(KeyOwnership.owns(.writingLine(tabFixes: true), .tab))
        XCTAssertFalse(KeyOwnership.owns(.writingLine(tabFixes: false), .tab))
        XCTAssertTrue(KeyOwnership.owns(.writingLine(tabFixes: false), .down))
        XCTAssertTrue(KeyOwnership.owns(.writingLine(tabFixes: true), .escape))
        XCTAssertFalse(KeyOwnership.owns(.writingLine(tabFixes: true), .up))
        XCTAssertFalse(KeyOwnership.owns(.writingLine(tabFixes: true), .optionRight))
        XCTAssertFalse(KeyOwnership.owns(.writingLine(tabFixes: true), .commandDigit(1)), "no numbered row shows on the line")
        XCTAssertFalse(KeyOwnership.owns(.writingLine(tabFixes: true), .shiftTab))
        XCTAssertTrue(KeyOwnership.owns(.writingList(rows: 4), .up))
        XCTAssertTrue(KeyOwnership.owns(.writingList(rows: 4), .commandDigit(3)))
        XCTAssertFalse(KeyOwnership.owns(.writingList(rows: 2), .commandDigit(3)))
        XCTAssertFalse(KeyOwnership.owns(.writingList(rows: 4), .optionRight))
        XCTAssertFalse(KeyOwnership.owns(.writingList(rows: 4), .typing))
    }

    func testTabOnTheLineClaimsTheActiveFixOnly() throws {
        let arbiter = OfferArbiter()
        let id = arbiter.publish(writingOffer())!
        guard case .consume(let claim) = arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)) else { return XCTFail("Tab takes the fix") }
        XCTAssertEqual(claim.offer.id, id)
        let edit = try XCTUnwrap(claim.rangeEdit)
        XCTAssertEqual(edit.original, "was")
        XCTAssertEqual(edit.replacement, "were")
        XCTAssertTrue(claim.insertsText)
        XCTAssertEqual(claim.insertionText, "were")
        XCTAssertNil(arbiter.snapshot().current)
        XCTAssertNil(arbiter.publish(ghostOffer()), "nothing is offered while the fix is being written")
        XCTAssertEqual(arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)), .pass(.noOffer), "a second Tab is the app's")
    }

    func testTabOnALineThatNeedsAChoicePassesAndDismisses() {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer([mark("was", "were", others: ["are"], needsChoice: true)]))
        XCTAssertEqual(arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)), .pass(.dismissed))
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testDownOpensTheListAndTabTakesTheHighlightedRow() throws {
        let arbiter = OfferArbiter()
        let id = arbiter.publish(writingOffer())!
        guard case .navigate(let navID, let ui) = arbiter.handleKeyDown(key(KeyStroke.downKeyCode)) else { return XCTFail("↓ opens") }
        XCTAssertEqual(navID, id)
        XCTAssertTrue(ui.open)
        XCTAssertEqual(arbiter.snapshot().current?.kind.writing?.presentation, .expanded)
        guard case .navigate(_, let moved) = arbiter.handleKeyDown(key(KeyStroke.downKeyCode)) else { return XCTFail("↓ moves") }
        XCTAssertEqual(moved.candidate, 1)
        guard case .consume(let claim) = arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)) else { return XCTFail("Tab takes the row") }
        XCTAssertEqual(claim.rangeEdit?.replacement, "are")
        XCTAssertEqual(claim.choice.candidate, 1)
    }

    func testFixAllIsOneRangeEdit() throws {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer())
        _ = arbiter.handleKeyDown(key(KeyStroke.downKeyCode))
        let rows = try XCTUnwrap(arbiter.snapshot().current?.kind.writing?.alternatives.count)
        for _ in 0..<(rows - 1) { _ = arbiter.handleKeyDown(key(KeyStroke.downKeyCode)) }
        XCTAssertEqual(arbiter.snapshot().current?.kind.writing?.alternatives[rows - 1].kind, .fixAll)
        guard case .consume(let claim) = arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)) else { return XCTFail("Tab takes Fix all") }
        let edit = try XCTUnwrap(claim.rangeEdit)
        XCTAssertEqual(edit.original, "the the cafe we was")
        XCTAssertEqual(edit.replacement, "the cafe we were")
    }

    func testOriginalClosesTheOfferAndIsRecorded() {
        let arbiter = OfferArbiter()
        let id = arbiter.publish(writingOffer())!
        _ = arbiter.handleKeyDown(key(KeyStroke.downKeyCode))
        // Rows: were, are, Original, Fix all. ⌘3 is Original.
        XCTAssertEqual(arbiter.handleKeyDown(key(20, command: true)), .closeOffer(offerID: id))
        XCTAssertEqual(arbiter.snapshot().keptOriginalOfferID, id)
        XCTAssertNil(arbiter.snapshot().current)
        XCTAssertEqual(arbiter.snapshot().lastClaim, nil, "Original makes no claim and no edit")
    }

    func testEscClosesWithoutKeepingOriginal() {
        let arbiter = OfferArbiter()
        let id = arbiter.publish(writingOffer())!
        XCTAssertEqual(arbiter.handleKeyDown(key(KeyStroke.escapeKeyCode)), .closeOffer(offerID: id))
        XCTAssertNil(arbiter.snapshot().keptOriginalOfferID)
    }

    func testTypingDismissesTheLine() {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer())
        XCTAssertEqual(arbiter.handleKeyDown(key(0, text: "a")), .pass(.dismissed))
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testAKeyForAnotherAppTakesNothing() {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer())
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: KeyStroke.tabKeyCode, targetPID: 99)), .pass(.otherApp))
        XCTAssertNotNil(arbiter.snapshot().current)
    }

    // MARK: - Confirming the claim

    func testConfirmRangeChecksTheFieldAsItIsNow() throws {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer())
        guard case .consume(let claim) = arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)) else { return XCTFail() }
        let moved = arbiter.confirmRange(claim, live: live(text, caret: 3))
        XCTAssertEqual(moved, .failure(.selectionMoved(expected: .caret(UTF16Text.length(text)), live: .caret(3))))
        XCTAssertNil(arbiter.snapshot().insertingClaimID, "a refusal ends the claim")
        XCTAssertEqual(arbiter.snapshot().lastClaim?.outcome, .rejected("selectionMoved"))
    }

    func testConfirmRangeApprovesTheUnchangedField() throws {
        let arbiter = OfferArbiter()
        _ = arbiter.publish(writingOffer())
        guard case .consume(let claim) = arbiter.handleKeyDown(key(KeyStroke.tabKeyCode)) else { return XCTFail() }
        let approved = try arbiter.confirmRange(claim, live: live(text)).get()
        XCTAssertEqual(approved.resultingValue, "At the the cafe we were late.")
        XCTAssertEqual(arbiter.snapshot().lastClaim?.outcome, .approved)
        arbiter.finishInsertion(claimID: claim.claimID, error: nil)
        XCTAssertNil(arbiter.publish(writingOffer()), "the field state the fix consumed is not offered again")
    }
}
