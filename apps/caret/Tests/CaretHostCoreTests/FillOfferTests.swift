import XCTest
@testable import CaretHostCore

private let formPID: Int32 = 5150

private func field(_ element: String, value: String = "", pid: Int32 = formPID) -> TargetIdentity {
    TargetIdentity(pid: pid, bundleID: "pid:\(pid)", windowID: "form", elementID: element, elementRevision: UTF16Text.digest(value))
}

private func live(_ element: String, value: String = "", caret: Int? = nil, pid: Int32 = formPID) -> InsertionGuard.LiveField {
    InsertionGuard.LiveField(target: field(element, value: value, pid: pid), value: value, selection: .caret(caret ?? UTF16Text.length(value)))
}

private let origin = FillOrigin(
    proposalID: "fill-7", windowID: "5150-1", fieldKey: "app/standard/textfield:email~0",
    sourceAppName: "Caret Fixture", sourceWindowTitle: "Caret Fixture — Reference",
    sourceBundleID: "", sourcePID: formPID, proposedAtMs: 0
)

private func fillOffer(_ element: String = "email", value: String = "dana.whitfield@lumenlabs.example") -> Offer {
    Offer(text: value, kind: .fill(origin), target: field(element), fieldValue: "", caretUTF16: 0)
}

private func ghostOffer(pid: Int32 = formPID) -> Offer {
    let value = "I will send the "
    return Offer(
        text: "summary", target: TargetIdentity(pid: pid, bundleID: "b", windowID: "w", elementID: "compose", elementRevision: UTF16Text.digest(value)),
        fieldValue: value, caretUTF16: UTF16Text.length(value)
    )
}

private func cmd(_ keyCode: Int64, shift: Bool = false, pid: Int32? = formPID) -> KeyStroke {
    KeyStroke(keyCode: keyCode, command: true, shift: shift, targetPID: pid)
}

final class FillOfferLifecycleTests: XCTestCase {
    func testTabHeadedForTheFormTakesTheFillAndTheGuardApprovesTheExactValue() throws {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(fillOffer()))
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail("Tab did not claim") }
        XCTAssertEqual(claim.insertionText, "dana.whitfield@lumenlabs.example")
        XCTAssertEqual(claim.offer.kind.fillOrigin?.proposalID, "fill-7")
        guard case .success(let edit) = arbiter.confirm(claim, live: live("email")) else { return XCTFail("guard refused an unchanged empty field") }
        XCTAssertEqual(edit.resultingValue, "dana.whitfield@lumenlabs.example")
        XCTAssertEqual(edit.replaceStart, 0)
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: formPID)), .pass(.noOffer), "single use")
    }

    func testAFillIsNeverTakenByAKeyWhoseTargetIsUnknown() {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        XCTAssertEqual(arbiter.handleKeyDown(.tab), .pass(.otherApp))
        XCTAssertNotNil(arbiter.snapshot().current, "a key that is not the form's leaves the offer")
    }

    func testAGhostOfferIsNotTakenByAKeyWhoseTargetIsUnknown() {
        let arbiter = OfferArbiter()
        arbiter.publish(ghostOffer())
        XCTAssertEqual(arbiter.handleKeyDown(.tab), .pass(.otherApp))
        XCTAssertNotNil(arbiter.snapshot().current)
    }

    func testTabHeadedForAnotherAppPassesThroughAndLeavesTheOffer() {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 999)), .pass(.otherApp))
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: 0, text: "x", targetPID: 999)), .pass(.otherApp))
        guard case .consume = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail("offer was lost to another app's keys") }
    }

    func testTypingTheValuesFirstLetterRemovesTheFillRatherThanTypingThrough() {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: 2, text: "d", targetPID: formPID)), .pass(.dismissed))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: formPID)), .pass(.noOffer))
    }

    func testFocusMovingBeforeTabPassesTabThrough() {
        // The fill coordinator invalidates on the target's focus notification.
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        arbiter.invalidate(kind: "fill")
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: formPID)), .pass(.noOffer))
    }

    func testFocusMovingBetweenTabAndRereadIsRefusedByTheGuard() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail() }
        guard case .failure(let rejection) = arbiter.confirm(claim, live: live("phone")) else { return XCTFail("wrote into another field") }
        XCTAssertEqual(rejection.code, "targetMoved")
    }

    func testTextAppearingInTheFieldBeforeTheRereadIsRefused() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail() }
        guard case .failure(let rejection) = arbiter.confirm(claim, live: live("email", value: "d")) else { return XCTFail() }
        XCTAssertEqual(rejection.code, "fieldContentChanged")
    }

    func testClearingGhostStateLeavesAFillAlone() {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        arbiter.invalidate(kind: "ghost")
        XCTAssertNotNil(arbiter.snapshot().current)
        arbiter.invalidate(kind: "fill")
        XCTAssertNil(arbiter.snapshot().current)
    }

    func testTheNextEmptyFieldOfAFormIsOfferableAfterTheFirstIsFilled() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer("email"))
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail() }
        _ = arbiter.confirm(claim, live: live("email"))
        arbiter.finishInsertion(claimID: claim.claimID, error: nil)
        XCTAssertNotNil(arbiter.publish(fillOffer("phone", value: "+1 (512) 555-0142")),
                        "every empty field has the same revision; only the consumed field itself is stale")
    }

    func testTheConsumedFieldItselfIsNotReofferedFromTheSameState() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer("email"))
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail() }
        _ = arbiter.confirm(claim, live: live("email"))
        arbiter.finishInsertion(claimID: claim.claimID, error: nil)
        XCTAssertNil(arbiter.publish(fillOffer("email")))
    }
}

final class CommandDigitTests: XCTestCase {
    func testCommandDigitsPassThroughWhenOnlyGhostTextIsVisible() {
        for code: Int64 in [18, 19, 20] {
            let arbiter = OfferArbiter()
            arbiter.publish(ghostOffer())
            let decision = arbiter.handleKeyDown(cmd(code))
            XCTAssertEqual(decision, .pass(.dismissed), "⌘\(code - 17) must reach the host (browser tab switch)")
            XCTAssertNil(arbiter.snapshot().current, "a passed-through key dismisses what was shown")
        }
    }

    func testCommandDigitsPassThroughOverASingleFill() {
        let arbiter = OfferArbiter()
        arbiter.publish(fillOffer())
        XCTAssertEqual(arbiter.handleKeyDown(cmd(18)), .pass(.dismissed))
    }

    func testCommandDigitIsRecognisedOnlyWithCommandAlone() {
        XCTAssertEqual(cmd(18).commandDigit, 1)
        XCTAssertEqual(cmd(20).commandDigit, 3)
        XCTAssertNil(cmd(21).commandDigit, "⌘4 is not one of the three")
        XCTAssertNil(cmd(18, shift: true).commandDigit)
        XCTAssertNil(KeyStroke(keyCode: 18, text: "1").commandDigit)
    }
}

final class UndoToastTests: XCTestCase {
    private func grant(createdAt: Date = Date()) -> UndoGrant {
        let value = "dana.whitfield@lumenlabs.example"
        return UndoGrant(
            target: field("email", value: value), priorValue: "", writtenValue: value,
            insertedStart: 0, insertedLength: UTF16Text.length(value), origin: origin, createdAt: createdAt
        )
    }

    func testCommandZWhileTheToastIsVisibleIsCaretsOnce() {
        let arbiter = OfferArbiter()
        let id = arbiter.showToast(grant())
        guard case .undo(let g) = arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode)) else { return XCTFail("⌘Z not claimed") }
        XCTAssertEqual(g.id, id)
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode)), .pass(.noOffer), "the second ⌘Z is the host's")
    }

    func testEscapeClosesTheToast() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: formPID)), .closeToast)
        XCTAssertNil(arbiter.snapshot().toast)
    }

    func testAnyOtherKeyDismissesTheToastAndReturnsCommandZToTheHost() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: 0, text: "a", targetPID: formPID)), .pass(.toastDismissed))
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode)), .pass(.noOffer))
    }

    func testAnExpiredToastNoLongerOwnsCommandZ() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant(createdAt: Date().addingTimeInterval(-UndoGrant.defaultLifetime - 0.1)))
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode)), .pass(.noOffer))
    }

    func testCommandZInAnotherAppLeavesTheToast() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode, pid: 999)), .pass(.noOffer))
        XCTAssertNotNil(arbiter.snapshot().toast)
    }

    func testCommandZWithAnUnknownTargetLeavesTheToastAndIsNotTaken() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode, pid: nil)), .pass(.noOffer))
        XCTAssertNotNil(arbiter.snapshot().toast)
    }

    func testRedoIsNotUndo() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        XCTAssertEqual(arbiter.handleKeyDown(cmd(KeyStroke.zKeyCode, shift: true)), .pass(.toastDismissed))
    }

    func testTabWithAToastAndANextFieldOfferTakesTheOfferAndClosesTheToast() {
        let arbiter = OfferArbiter()
        arbiter.showToast(grant())
        arbiter.publish(fillOffer("phone", value: "+1 (512) 555-0142"))
        guard case .consume = arbiter.handleKeyDown(.tab(to: formPID)) else { return XCTFail() }
        XCTAssertNil(arbiter.snapshot().toast)
    }

    func testUndoGuardApprovesAnUnchangedField() {
        let g = grant()
        let result = UndoGuard.approve(g, live: live("email", value: g.writtenValue))
        XCTAssertEqual(result, .success(.init(start: 0, length: g.insertedLength, expectedValue: "")))
    }

    func testUndoGuardRefusesAFieldTheUserEdited() {
        let g = grant()
        XCTAssertEqual(UndoGuard.approve(g, live: live("email", value: g.writtenValue + "x")), .failure(.fieldChanged))
    }

    func testUndoGuardRefusesAnotherElement() {
        let g = grant()
        XCTAssertEqual(UndoGuard.approve(g, live: live("phone", value: g.writtenValue)), .failure(.targetMoved))
    }

    func testUndoGuardRefusesASpanThatDoesNotRestoreThePriorValue() {
        var g = grant()
        g.insertedLength -= 1
        XCTAssertEqual(UndoGuard.approve(g, live: live("email", value: g.writtenValue)), .failure(.spanInvalid))
    }

    func testUndoGuardHandlesAMidTextInsertion() {
        let prior = "Dear , thanks"
        let written = "Dear Dana, thanks"
        let g = UndoGrant(target: field("body", value: written), priorValue: prior, writtenValue: written,
                          insertedStart: 5, insertedLength: 4, origin: nil)
        XCTAssertEqual(UndoGuard.approve(g, live: live("body", value: written, caret: 9)), .success(.init(start: 5, length: 4, expectedValue: prior)))
    }
}
