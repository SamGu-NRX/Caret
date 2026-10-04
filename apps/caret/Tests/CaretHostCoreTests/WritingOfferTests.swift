import CaretHostCore
import XCTest

final class WritingOfferTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func live(_ value: String, caret: Int? = nil) -> RangeEdit.Live {
        let target = TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: "body", elementRevision: UTF16Text.digest(value))
        return RangeEdit.Live(target: target, value: value, selection: .caret(caret ?? UTF16Text.length(value)))
    }

    func mark(_ word: String, in text: String, _ replacement: String, others: [String] = [], kind: WritingCorrection.Kind = .grammar, after: Int = 0) -> WritingCorrection {
        let ns = text as NSString
        let r = ns.range(of: word, range: NSRange(location: after, length: ns.length - after))
        return WritingCorrection(span: UTF16Span(r), original: word, replacement: replacement, otherReplacements: others, kind: kind, reason: "Agreement", source: .spellChecker)
    }

    /// Two errors in one sentence; the caret at its end unless a test moves it.
    let text = "At the the cafe we was late."
    var marks: [WritingCorrection] {
        [mark("the the", in: text, "the"), mark("was", in: text, "were", others: ["are"])]
    }

    func testTheMarkNearestTheCaretIsActive() throws {
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.active.original, "was")
        let early = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text, caret: 2), now: t0))
        XCTAssertEqual(early.active.original, "the the")
    }

    func testAlternativesAreTheFixesThenOriginalThenFixAll() throws {
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.alternatives.map(\.kind), [.fix, .fix, .original, .fixAll])
        XCTAssertEqual(offer.alternatives.map(\.label), ["were", "are", "Original", "Fix all in this paragraph"])
        XCTAssertEqual(offer.alternatives[2].detail, "was")
        XCTAssertNil(offer.alternatives[2].edit, "Original changes nothing")
        XCTAssertEqual(offer.alternatives[3].detail, "2 fixes")
    }

    func testOriginalIsAlwaysThereEvenAlone() throws {
        let one = [mark("was", in: text, "were")]
        let offer = try XCTUnwrap(WritingOffer.correction(marks: one, live: live(text), now: t0))
        XCTAssertEqual(offer.alternatives.map(\.kind), [.fix, .original], "no Fix all for a single error")
    }

    func testFixAllIsOneRangeEditWithItsOwnDiff() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        let fixAll = try XCTUnwrap(offer.alternatives.last)
        XCTAssertEqual(fixAll.diff.map(\.original), ["the the", "was"])
        XCTAssertEqual(fixAll.diff.map(\.replacement), ["the", "were"])
        XCTAssertEqual(fixAll.diff.map(\.text), ["At the", "we were"])
        let edit = try XCTUnwrap(fixAll.edit)
        XCTAssertEqual(try edit.validate(live(text), now: t0).get().resultingValue, "At the cafe we were late.")

        // Highlighting it shows the diff; Tab then applies it.
        XCTAssertEqual(offer.send(.down), .handled)
        XCTAssertEqual(offer.shownDiff.count, 1)
        for _ in 0..<5 { _ = offer.send(.down) }
        XCTAssertEqual(offer.shownDiff.count, 2)
        XCTAssertEqual(offer.send(.tab), .apply(edit))
    }

    func testFixAllIsLeftOutWhileTheCaretSitsInsideItsRange() throws {
        // Between the two errors: one range over both would straddle the caret.
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text, caret: 15), now: t0))
        XCTAssertEqual(offer.active.original, "was")
        XCTAssertEqual(offer.alternatives.map(\.kind), [.fix, .fix, .original])
    }

    func testFixAllStaysInsideTheParagraph() throws {
        let two = "We was here.\nThey was there."
        let marks = [mark("was", in: two, "were"), mark("was", in: two, "were", after: 8)]
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(two), now: t0))
        XCTAssertFalse(offer.alternatives.contains { $0.kind == .fixAll }, "one error per paragraph")
    }

    // MARK: Keys

    func testAMarkAloneOwnsNoKeys() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), presentation: .mark, now: t0))
        XCTAssertFalse(offer.ownsTab)
        XCTAssertEqual(offer.send(.tab), .passThrough)
        XCTAssertEqual(offer.send(.down), .passThrough)
        XCTAssertEqual(offer.send(.commandDigit(1)), .passThrough)
    }

    func testTheLineOwnsTabAndTabAppliesTheActiveFix() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertTrue(offer.ownsTab)
        XCTAssertEqual(offer.linePreview.text, "we were")
        XCTAssertEqual(offer.lineHints, [Hint(key: "Tab", label: "fix"), Hint(key: "↓", label: "more")])
        // Up and Command digits are not shown on the line, so they stay the host's.
        XCTAssertEqual(offer.send(.up), .passThrough)
        XCTAssertEqual(offer.send(.commandDigit(2)), .passThrough)
        guard case .apply(let edit) = offer.send(.tab) else { return XCTFail() }
        XCTAssertEqual(edit.replacement, "were")
    }

    func testDownOpensWithoutChangingWhatTabDoes() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.send(.down), .handled)
        XCTAssertEqual(offer.presentation, .expanded)
        XCTAssertEqual(offer.current, 0)
        XCTAssertEqual(offer.send(.down), .handled)
        XCTAssertEqual(offer.current, 1)
        XCTAssertEqual(offer.send(.up), .handled)
        XCTAssertEqual(offer.send(.up), .handled)
        XCTAssertEqual(offer.current, 0)
    }

    func testOriginalMakesNoEdit() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        _ = offer.send(.down)
        XCTAssertEqual(offer.send(.commandDigit(3)), .keepOriginal)
        XCTAssertNil(WritingOffer.toast(after: offer.alternatives[2]), "no toast, no undo")
    }

    func testCommandDigitsReachOnlyNumberedRows() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        _ = offer.send(.down)
        XCTAssertEqual(offer.alternatives.count, 4)
        XCTAssertEqual(offer.send(.commandDigit(4)), .passThrough)
        guard case .apply(let edit) = offer.send(.commandDigit(2)) else { return XCTFail() }
        XCTAssertEqual(edit.replacement, "are")
    }

    func testAnyChangeOfContextDismisses() throws {
        for presentation in [WritingOffer.Presentation.mark, .line, .expanded] {
            var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), presentation: presentation, now: t0))
            XCTAssertEqual(offer.send(.contextChanged), .dismiss)
        }
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.send(.escape), .dismiss)
    }

    func testNoOfferWhenTheActiveFixCannotBeMade() {
        // The caret sits inside the error: the edit would straddle the user's caret.
        XCTAssertNil(WritingOffer.correction(marks: marks, live: live(text, caret: 20), now: t0))
    }

    // MARK: What it says

    func testToastSaysWhatChanged() throws {
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        let toast = try XCTUnwrap(WritingOffer.toast(after: offer.alternatives[0]))
        XCTAssertEqual(toast.lead, "Fixed")
        XCTAssertEqual(toast.text, "“was” to “were”")
        XCTAssertEqual(toast.hints, [Hint(key: "⌘Z", label: "Undo")])
        XCTAssertEqual(WritingOffer.toast(after: offer.alternatives[3])?.text, "2 fixes in this paragraph")
    }

    func testVoiceOverHearsReasonOriginalFixAndKeys() throws {
        let offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.spokenLine, "Agreement. Replace “was” with “were”. Tab fixes it, Down Arrow shows more.")
    }

    func testPreviewShowsSpacesAsWords() {
        let text = "I went  to the store."
        let p = WritingOffer.preview(UTF16Span(start: 6, end: 8), original: "  ", replacement: " ", in: text)
        XCTAssertEqual(p.text, "went to")
        XCTAssertEqual(WritingCopy.fixed(original: "  ", replacement: " "), "“␣␣” to “␣”")
    }

    // MARK: Priority

    func testPriorityOverOrdinaryCompletion() {
        let line = WritingOffer.Slot(producer: .correction, ownsTab: true, navigating: false)
        XCTAssertFalse(WritingOffer.incomingWins(.completion, over: line), "completion waits while the correction line holds Tab")
        XCTAssertFalse(WritingOffer.incomingWins(.wordFinding, over: line))
        XCTAssertTrue(WritingOffer.incomingWins(.correction, over: line), "a newer correction replaces the older")
        XCTAssertTrue(WritingOffer.incomingWins(.explicitRequest, over: line))
        XCTAssertTrue(WritingOffer.incomingWins(.correction, over: WritingOffer.Slot(producer: .completion, ownsTab: true, navigating: false)))
        XCTAssertTrue(WritingOffer.incomingWins(.wordFinding, over: WritingOffer.Slot(producer: .passiveRewrite, ownsTab: true, navigating: false)))
    }

    func testAQuietMarkHoldsNothing() {
        let mark = WritingOffer.Slot(producer: .correction, ownsTab: false, navigating: false)
        XCTAssertTrue(WritingOffer.incomingWins(.completion, over: mark))
    }

    func testNothingButAnExplicitRequestReplacesANavigatedOffer() {
        let navigated = WritingOffer.Slot(producer: .completion, ownsTab: true, navigating: true)
        XCTAssertFalse(WritingOffer.incomingWins(.passiveRewrite, over: navigated))
        XCTAssertFalse(WritingOffer.incomingWins(.correction, over: navigated))
        XCTAssertTrue(WritingOffer.incomingWins(.explicitRequest, over: navigated))
    }

    func testOfferSlotReportsNavigation() throws {
        var offer = try XCTUnwrap(WritingOffer.correction(marks: marks, live: live(text), now: t0))
        XCTAssertEqual(offer.slot, WritingOffer.Slot(producer: .correction, ownsTab: true, navigating: false))
        _ = offer.send(.down)
        XCTAssertTrue(offer.slot.navigating)
    }
}
