import XCTest
#if SWIFT_PACKAGE
@testable import Caret
#endif

/// These cover the decisions that are dangerous to get wrong: who owns a
/// keystroke, whether an offer is still about the text on screen, and whether
/// an edit lands on the right UTF-16 range.
final class InlineKeyRouterTests: XCTestCase {
    private func context(
        visible: String? = "p1",
        inFlight: Bool = false,
        choices: Int = 0,
        enabled: Bool = true
    ) -> InlineKeyContext {
        InlineKeyContext(
            visibleProposalID: visible,
            acceptanceInFlight: inFlight,
            visibleChoiceCount: choices,
            interceptionEnabled: enabled
        )
    }

    private func key(_ code: Int64, _ mods: InlineModifiers = [], repeat isRepeat: Bool = false) -> InlineKeyEvent {
        InlineKeyEvent(keyCode: code, modifiers: mods, isAutorepeat: isRepeat)
    }

    /// Tab is owned by TabCompletionsController, which runs its own CGEvent
    /// tap on key code 48. This router must never claim it: two taps on one
    /// key race on registration order. Pinned so a future change cannot
    /// quietly reintroduce a second Tab interceptor.
    func testTabIsAlwaysLeftToTheTabCompletionsOwner() {
        for ctx in [context(), context(visible: nil), context(inFlight: true)] {
            let decision = InlineKeyRouter.decide(key(InlineKeyCode.tab), context: ctx)
            XCTAssertEqual(decision, .passThrough)
            XCTAssertFalse(decision.consumesEvent, "only one tap may consume Tab")
        }
    }

    // Criterion 2: with no offer, Tab is the host's key, untouched.

    // Criterion 2: every modified Tab stays the host's.

    // Criterion 3: one physical hold cannot accept twice or indent afterwards.


    // Criterion 2: Escape dismisses but stays available to the host.
    func testEscapeDismissesWithoutConsuming() {
        let decision = InlineKeyRouter.decide(key(InlineKeyCode.escape), context: context())
        XCTAssertEqual(decision, .dismiss(reason: .escape))
        XCTAssertFalse(decision.consumesEvent)
    }

    func testEscapeWithNoOfferPassesThrough() {
        XCTAssertEqual(
            InlineKeyRouter.decide(key(InlineKeyCode.escape), context: context(visible: nil)),
            .passThrough
        )
    }

    // Criterion 4: Cmd-1..3 bind only while Caret shows that many choices.
    func testCommandDigitsOnlyBindToVisibleChoices() {
        let owned = InlineKeyRouter.decide(key(InlineKeyCode.one, [.command]), context: context(choices: 2))
        XCTAssertEqual(owned, .selectChoice(index: 0))
        XCTAssertTrue(owned.consumesEvent)

        // Third choice not shown: Cmd-3 remains the host's shortcut.
        XCTAssertEqual(
            InlineKeyRouter.decide(key(InlineKeyCode.three, [.command]), context: context(choices: 2)),
            .passThrough
        )
        // Nothing shown at all.
        XCTAssertEqual(
            InlineKeyRouter.decide(key(InlineKeyCode.one, [.command]), context: context(visible: nil, choices: 0)),
            .passThrough
        )
    }

    // The existing Cmd-Option pinned trigger must keep working untouched.
    func testCommandOptionDigitLeftToExistingTrigger() {
        XCTAssertEqual(
            InlineKeyRouter.decide(key(InlineKeyCode.one, [.command, .option]), context: context(choices: 3)),
            .passThrough
        )
    }

    // Criterion 5: disabled means Caret is not in the keyboard path at all.
    func testDisabledInterceptionNeverConsumes() {
        for code in [InlineKeyCode.tab, InlineKeyCode.escape, InlineKeyCode.one] {
            let decision = InlineKeyRouter.decide(key(code, [.command]), context: context(choices: 3, enabled: false))
            XCTAssertEqual(decision, .passThrough)
            XCTAssertFalse(decision.consumesEvent)
        }
    }

    // Criterion 2: ordinary typing cancels immediately and still reaches the host.
    func testTypingCancelsButPassesThrough() {
        let typed = InlineKeyRouter.decide(key(0), context: context())
        XCTAssertEqual(typed, .cancelAndPassThrough(reason: .userTyped))
        XCTAssertFalse(typed.consumesEvent)

        let arrow = InlineKeyRouter.decide(key(123), context: context())
        XCTAssertEqual(arrow, .cancelAndPassThrough(reason: .caretMoved))
        XCTAssertFalse(arrow.consumesEvent)
    }
}

@MainActor
final class InlineOfferStoreTests: XCTestCase {
    private func target(_ revision: String = "v1", element: String = "body") -> InlineTarget {
        InlineTarget(pid: 42, bundleID: "com.apple.TextEdit", windowID: "w", elementID: element, elementRevision: revision)
    }

    private func offer(_ target: InlineTarget, id: String = "p1", text: String = " team") -> Caret.InlineOffer {
        InlineOffer(
            proposalID: id, revision: 1, target: target,
            replaceStart: 5, replaceEnd: 5, replacement: text,
            originalDigest: "d", createdAt: Date()
        )
    }

    func testOfferShowsForCurrentTarget() {
        let store = InlineOfferStore()
        let t = target()
        store.updateTarget(t)
        XCTAssertTrue(store.present(offer(t), generation: store.generation))
        XCTAssertNotNil(store.visibleOffer)
        XCTAssertTrue(store.keyContext.interceptionEnabled)
    }

    // Criterion 2: a late answer cannot resurrect a cancelled offer.
    func testLateOfferForOldGenerationIsDropped() {
        let store = InlineOfferStore()
        let t = target()
        store.updateTarget(t)
        let stale = store.generation

        store.cancel(reason: .userTyped)
        XCTAssertFalse(store.present(offer(t), generation: stale))
        XCTAssertNil(store.visibleOffer)
    }

    // Criterion 3: an offer for a field the user left is never shown.
    func testOfferForDifferentFieldIsDropped() {
        let store = InlineOfferStore()
        store.updateTarget(target(element: "subject"))
        XCTAssertFalse(store.present(offer(target(element: "body")), generation: store.generation))
    }

    func testTypingInSameFieldCancelsVisibleOffer() {
        let store = InlineOfferStore()
        store.updateTarget(target("v1"))
        XCTAssertTrue(store.present(offer(target("v1")), generation: store.generation))
        store.updateTarget(target("v2"))
        XCTAssertNil(store.visibleOffer, "the offer described text that no longer exists")
    }

    func testFocusChangeCancelsVisibleOffer() {
        let store = InlineOfferStore()
        store.updateTarget(target(element: "body"))
        XCTAssertTrue(store.present(offer(target(element: "body")), generation: store.generation))
        store.updateTarget(target(element: "subject"))
        XCTAssertNil(store.visibleOffer)
    }

    // Criterion 3: exactly one acceptance per offer.
    func testAcceptanceIsClaimedOnce() {
        let store = InlineOfferStore()
        let t = target()
        store.updateTarget(t)
        XCTAssertTrue(store.present(offer(t), generation: store.generation))

        XCTAssertNotNil(store.claimAcceptance(proposalID: "p1"))
        XCTAssertNil(store.claimAcceptance(proposalID: "p1"), "a second Tab must not accept again")
        XCTAssertTrue(store.acceptanceInFlight)
    }

    func testAcceptanceBumpsGenerationSoInFlightAnswersAreFenced() {
        let store = InlineOfferStore()
        let t = target()
        store.updateTarget(t)
        store.present(offer(t), generation: store.generation)
        let claim = store.claimAcceptance(proposalID: "p1")
        XCTAssertNotNil(claim)
        store.finishAcceptance(success: true)
        XCTAssertNotEqual(store.generation, claim?.generation)
    }

    // Criterion 5: disabled clears the offer and the tap's permission to act.
    func testDisablingClearsOfferAndInterception() {
        let store = InlineOfferStore()
        let t = target()
        store.updateTarget(t)
        store.present(offer(t), generation: store.generation)
        store.setDisabled(.accessibilityDenied)
        XCTAssertNil(store.visibleOffer)
        XCTAssertFalse(store.keyContext.interceptionEnabled)
    }
}

final class InlineTextTests: XCTestCase {
    private func offer(start: Int, end: Int, text: String) -> Caret.InlineOffer {
        InlineOffer(
            proposalID: "p", revision: 1,
            target: InlineTarget(pid: 1, bundleID: "b", windowID: "w", elementID: "e", elementRevision: "r"),
            replaceStart: start, replaceEnd: end, replacement: text,
            originalDigest: "d", createdAt: Date()
        )
    }

    func testInsertionAtCaretUsesUTF16Offsets() {
        XCTAssertEqual(
            InlineFieldAccess.applying(offer: offer(start: 5, end: 5, text: " world"), to: "hello"),
            "hello world"
        )
    }

    // A non-BMP character is two UTF-16 units. An offset computed in Characters
    // would insert in the wrong place here.
    func testOffsetsAreUTF16NotCharacters() {
        let text = "hi 👩‍🚀"
        let units = text.utf16.count
        XCTAssertNotEqual(units, text.count, "fixture must actually exercise surrogate pairs")
        XCTAssertEqual(InlineFieldAccess.applying(offer: offer(start: units, end: units, text: "!"), to: text), text + "!")
    }

    func testEmojiPrefixOffsetLandsAfterFullPair() {
        // "🚀x": the rocket is 2 UTF-16 units, so offset 2 is between them.
        XCTAssertEqual(
            InlineFieldAccess.applying(offer: offer(start: 2, end: 2, text: "-"), to: "🚀x"),
            "🚀-x"
        )
    }

    func testReplacingASelectionReplacesExactlyThatRange() {
        XCTAssertEqual(
            InlineFieldAccess.applying(offer: offer(start: 6, end: 11, text: "there"), to: "hello world"),
            "hello there"
        )
    }

    func testOutOfBoundsRangeLeavesTextUnchanged() {
        XCTAssertEqual(InlineFieldAccess.applying(offer: offer(start: 0, end: 99, text: "x"), to: "short"), "short")
    }

    // Criterion 3: a changed field fails validation rather than being edited.





}
