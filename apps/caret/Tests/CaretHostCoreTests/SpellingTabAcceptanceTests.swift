import CaretHostCore
import XCTest

/// The writing VM's text and acceptance sequence, without a window server. The checker result
/// and the app's write are fixtures; these tests do not prove macOS delivered the key or paste.
final class SpellingTabAcceptanceTests: XCTestCase {
    private let pid: Int32 = 4242

    private func live(_ value: String, selection: UTF16Selection? = nil) -> RangeEdit.Live {
        RangeEdit.Live(
            target: TargetIdentity(pid: pid, bundleID: "com.apple.TextEdit", windowID: "w1", elementID: "body",
                                   elementRevision: UTF16Text.digest(value)),
            value: value, selection: selection ?? .caret(UTF16Text.length(value))
        )
    }

    private func offer(_ field: RangeEdit.Live, word: String, fix: String, needsChoice: Bool = false) throws -> Offer {
        let correction = WritingCorrection(
            span: UTF16Span((field.value as NSString).range(of: word)), original: word, replacement: fix,
            kind: .spelling, reason: "Not in dictionary", source: .spellChecker, needsChoice: needsChoice
        )
        var marks = WritingMarks()
        marks.observe(field: field.target, value: field.value)
        XCTAssertTrue(marks.record([correction], sentence: correction.span, checkedValue: field.value))
        let writing = try XCTUnwrap(WritingOffer.correction(
            marks: marks.offerable(caret: try XCTUnwrap(field.selection).end),
            checkedRevision: UTF16Text.digest(field.value), live: field
        ))
        return Offer(text: "", kind: .writing(writing), target: field.target, fieldValue: field.value,
                     caretUTF16: try XCTUnwrap(field.selection).end)
    }

    private func claim(_ offer: Offer, arbiter: OfferArbiter) throws -> Claim {
        XCTAssertNotNil(arbiter.publish(offer))
        XCTAssertEqual(arbiter.snapshot().claimCount, 0, "showing the fix must not accept it")
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: pid)) else {
            throw Unexpected("the writing line did not claim Tab")
        }
        XCTAssertTrue(claim.insertsText)
        XCTAssertEqual(claim.insertionText, claim.rangeEdit?.replacement)
        return claim
    }

    func testClosedWordAndVMSentencesReachAVerifiedRangeEdit() throws {
        for (text, word, fix) in [
            ("teh ", "teh", "the"),
            ("We will recieve the parcel tomorrow. ", "recieve", "receive"),
            ("They will recieve it soon. ", "recieve", "receive"),
            ("👨‍👩‍👧 cafe\u{301} teh ", "teh", "the"),
        ] {
            let field = live(text)
            if word == "teh" {
                XCTAssertEqual(WordFix.closedWord(previous: String(text.dropLast()), value: text,
                                                  selection: try XCTUnwrap(field.selection)),
                               UTF16Span((text as NSString).range(of: word)))
            } else {
                XCTAssertNotNil(WritingMarks.boundary(previous: "", value: text, selection: try XCTUnwrap(field.selection)))
            }
            let arbiter = OfferArbiter()
            let claim = try claim(offer(field, word: word, fix: fix), arbiter: arbiter)
            let approved = try arbiter.confirmRange(claim, live: field).get()
            let edit = approved.edit
            let selected = live(text, selection: UTF16Selection(start: edit.replace.start, end: edit.replace.end))
            XCTAssertEqual(try edit.validate(selected, phase: .rangeSelected).get(), approved)
            XCTAssertEqual(approved.resultingValue, text.replacingOccurrences(of: word, with: fix))
            XCTAssertEqual(approved.resultingSelection, .caret(UTF16Text.length(approved.resultingValue)))
            XCTAssertEqual(FixPaste.afterPaste(value: approved.resultingValue, before: text, expected: approved.resultingValue), .applied)
            let written = live(approved.resultingValue, selection: approved.resultingSelection)
            let undo = try edit.verify(after: written, approved: approved).get()
            XCTAssertEqual(try undo.validate(written).get().resultingValue, text)
        }
    }

    func testWritingWinsOverGhostAndKeepsItsTab() throws {
        let field = live("teh ")
        let ghost = Offer(text: "cat", target: field.target, fieldValue: field.value, caretUTF16: 4)
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(ghost))
        XCTAssertNotNil(arbiter.publish(try offer(field, word: "teh", fix: "the")))
        XCTAssertNil(arbiter.publish(ghost))
        guard case .consume(let claim) = arbiter.handleKeyDown(.tab(to: pid)) else { return XCTFail("Tab must take writing") }
        XCTAssertEqual(claim.rangeEdit?.replacement, "the")
    }

    func testAnUnderlineOrAmbiguousLineDoesNotOwnTab() throws {
        let field = live("Can you adress the feedback? ")
        let arbiter = OfferArbiter()
        let ambiguous = try offer(field, word: "adress", fix: "address", needsChoice: true)
        XCTAssertFalse(try XCTUnwrap(ambiguous.kind.writing).ownsTab)
        XCTAssertNotNil(arbiter.publish(ambiguous))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: pid)), .pass(.dismissed))
        XCTAssertEqual(arbiter.snapshot().claimCount, 0)
    }

    func testTypingAfterTheOfferRefusesTheOldEdit() throws {
        let field = live("teh ")
        let arbiter = OfferArbiter()
        let claim = try claim(offer(field, word: "teh", fix: "the"), arbiter: arbiter)
        guard case .failure(.revisionChanged) = arbiter.confirmRange(claim, live: live("teh cat")) else {
            return XCTFail("the old offer must not edit text typed after it")
        }
        guard case .failure(.selectionMoved) = claim.rangeEdit?.validate(live("teh ", selection: .caret(0))) else {
            return XCTFail("a moved caret must refuse the edit")
        }
    }

    func testTypingKeyDismissesTheOfferBeforeTab() throws {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(try offer(live("teh "), word: "teh", fix: "the")))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("c", to: pid)), .pass(.dismissed))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: pid)), .pass(.noOffer))
        XCTAssertEqual(arbiter.snapshot().claimCount, 0)
    }
}
