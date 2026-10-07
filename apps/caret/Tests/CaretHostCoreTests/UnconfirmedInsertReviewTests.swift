import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// S2 review: before a restore deletes text, Caret proves the exact range and its exact contents,
/// or reports and does not touch the field. Each test here is a reviewer's finding.
final class UnconfirmedInsertReviewTests: XCTestCase {
    private static func identity(_ value: String, element: String = "body") -> TargetIdentity {
        TargetIdentity(pid: 5150, bundleID: "dev.caret.fixture", windowID: "w41", elementID: element, elementRevision: UTF16Text.digest(value))
    }

    private static func live(_ value: String, selection: UTF16Selection?) -> InsertionGuard.LiveField {
        InsertionGuard.LiveField(target: identity(value), value: value, selection: selection)
    }

    private static func partialGrant(before: String, at: Int, text: String, held: String) -> UndoGrant {
        let edit = InsertionGuard.ApprovedEdit(
            target: identity(before), replaceStart: at, replaceEnd: at, replacement: text,
            resultingValue: UTF16Text.slice(before, start: 0, end: at)! + text + UTF16Text.slice(before, start: at, end: UTF16Text.length(before))!
        )
        let armed = UndoGrant.armed(target: identity(before), priorValue: before, edit: edit, origin: nil, writeID: 3)
        let report = UnconfirmedInsert.read(UnconfirmedInsert.Intent(before: before, start: at, end: at, replacement: text), held: held)
        return UnconfirmedInsert.grant(armed: armed, verified: false, report: report)!
    }

    // MARK: - P1 1: the range and the quiet are proven right before the restore

    /// `runUndo` selects the span, reads the field again, and asks this before it writes: the value
    /// the guard approved, exactly the selected span, and no key or click since ⌘Z.
    func testTheRestoreNeedsTheExactValueSelectionAndQuiet() {
        let grant = Self.partialGrant(before: "Hi  there", at: 3, text: "Dana", held: "Hi Da there")
        guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live("Hi Da there", selection: .caret(5))) else { return XCTFail("refused") }
        let span = UTF16Selection(start: 3, end: 5)
        XCTAssertNil(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Da there", selection: span), quiet: true))
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Da there", selection: span), quiet: false), .inputDuringUndo)
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Da there", selection: UTF16Selection(start: 3, end: 4)), quiet: true), .selectionMoved)
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Da there", selection: .caret(5)), quiet: true), .selectionMoved)
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Da there", selection: nil), quiet: true), .selectionMoved, "a selection that cannot be read proves no range")
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: "Hi Da there", now: Self.live("Hi Dax there", selection: span), quiet: true), .fieldChanged)
        XCTAssertEqual(UndoGuard.Rejection.selectionMoved.code, "selectionMoved")
        XCTAssertEqual(UndoGuard.Rejection.inputDuringUndo.code, "inputDuringUndo")
    }

    // MARK: - P1 3: code units, not canonical equivalence

    /// "é" as one scalar and as "e" plus a combining accent are equal Swift Strings and different
    /// fields. A guard comparing Strings would delete across text that is not Caret's.
    func testCanonicallyEquivalentTextIsNotTheSameField() {
        let composed = "Caf\u{E9}"
        let decomposed = "Cafe\u{301}"
        XCTAssertEqual(composed, decomposed, "Swift's String equality is canonical")
        XCTAssertFalse(UTF16Text.same(composed, decomposed))
        XCTAssertTrue(UTF16Text.same(composed, "Caf\u{E9}"))

        // A verified write of "Café" whose field now holds the decomposed form: changed.
        var target = Self.identity("")
        target.elementRevision = UTF16Text.digest(composed)
        let verified = UndoGrant(target: target, priorValue: "", writtenValue: composed, insertedStart: 0, insertedLength: 4, origin: nil)
        var field = InsertionGuard.LiveField(target: target, value: decomposed)
        field.target.elementRevision = UTF16Text.digest(composed)
        XCTAssertEqual(UndoGuard.approve(verified, live: field), .failure(.fieldChanged))

        // The recheck before a restore compares code units too.
        let grant = Self.partialGrant(before: "", at: 0, text: "Caf\u{E9}s", held: composed)
        guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live(composed, selection: .caret(4))) else { return XCTFail("refused") }
        XCTAssertEqual(UndoGuard.recheck(revert, approvedValue: composed, now: Self.live(decomposed, selection: UTF16Selection(start: 0, end: 4)), quiet: true), .fieldChanged)
        XCTAssertTrue(UndoGuard.restored(revert, value: ""))
        XCTAssertFalse(UndoGuard.restored(UndoGuard.Revert(start: 0, length: 1, expectedValue: composed), value: decomposed))
    }

    // MARK: - P2 4: an AX write that may have been applied is not a refusal

    /// `.cannotComplete` (the app did not answer in time) says nothing about whether the text went
    /// in. It is not a reason to paste over it: the write fails as uncertain, and the field is read.
    func testAnUncertainAXWriteNeverFallsBackToPaste() {
        XCTAssertEqual(WriteFallback.afterAX(nil, answer: .uncertain), .failed(WriteFallback.writeUncertain))
        XCTAssertEqual(WriteFallback.afterAX(nil, answer: .refused), .fallBackToPaste)
        XCTAssertEqual(WriteFallback.afterAX(.matched, answer: .accepted), .verified)
        XCTAssertEqual(WriteFallback.afterAX(.different, answer: .accepted), .failed("writeMismatch"))
        XCTAssertTrue(WriteFallback.mayHaveWritten(.uncertain))
        XCTAssertTrue(WriteFallback.mayHaveWritten(.accepted))
        XCTAssertFalse(WriteFallback.mayHaveWritten(.refused))
        XCTAssertEqual(FillMachine.errorCaption(WriteFallback.writeUncertain), "The app didn't answer, so Caret didn't fill it again. Check the field.")
    }

    // MARK: - P2 5: inline text gets the same grant and an owner that shows it

    /// The insertion queue's own steps for a ghost Tab stopped after "th" of "there": `InsertAttempt`
    /// arms the grant before the first write whatever the claim's kind, the stop makes the field be
    /// read, and the partial read keeps the armed grant. Before S2's review the queue armed only
    /// a fill (`origin.map`), so a ghost insert stopped partway had no undo at all.
    func testAnInterruptedGhostInsertKeepsTheGrantArmedBeforeItsFirstWrite() {
        let claim = Self.ghostClaim("there")
        let before = InsertionGuard.LiveField(target: claim.offer.target, value: "Hi ", selection: .caret(3))
        let approved = InsertionGuard.ApprovedEdit(target: claim.offer.target, replaceStart: 3, replaceEnd: 3, replacement: "there", resultingValue: "Hi there")
        let attempt = InsertAttempt(claim: claim, before: before, approved: approved, writeID: 12)
        XCTAssertNil(claim.offer.kind.fillOrigin, "a ghost claim")
        XCTAssertEqual(attempt.armed.writeID, 12)
        XCTAssertEqual(attempt.armed.priorValue, "Hi ")
        XCTAssertEqual(attempt.armed.writtenValue, "Hi there")
        // Stopped after two typed keys: posted, not verified, no stray paste.
        XCTAssertTrue(InsertAttempt.needsRead(verified: false, dispatched: true, strayField: nil))
        let report = attempt.report(held: "Hi th")
        XCTAssertEqual(report.state, .partial(inserted: 2))
        let grant = attempt.grant(verified: false, report: report, at: Date(timeIntervalSince1970: 5))
        XCTAssertEqual(grant?.writeID, 12, "the grant is the one armed before the write, bound to its element")
        XCTAssertEqual(grant?.partialWrite, true)
        XCTAssertNil(grant?.origin)
        XCTAssertEqual(grant?.createdAt, Date(timeIntervalSince1970: 5))
        // A refusal before any key went out needs no read and leaves nothing.
        XCTAssertFalse(InsertAttempt.needsRead(verified: false, dispatched: false, strayField: nil))
        XCTAssertFalse(InsertAttempt.needsRead(verified: false, dispatched: true, strayField: "Email"))
        XCTAssertFalse(InsertAttempt.needsRead(verified: true, dispatched: true, strayField: nil))
        XCTAssertNil(attempt.grant(verified: false, report: nil, at: Date()))
        XCTAssertEqual(attempt.grant(verified: true, report: nil, at: Date())?.unconfirmed, false)
    }

    private static func ghostClaim(_ text: String = "summary to the team") -> Claim {
        let offer = Offer(text: text, target: Fx.identity(.email), fieldValue: "", caretUTF16: 0)
        return Claim(claimID: 41, offer: offer, typedSinceOffer: "", claimedAt: Date(timeIntervalSince1970: 1_790_000_000))
    }

    private static func inline(_ claim: Claim, held: String?) -> InlineInsertion {
        let intent = UnconfirmedInsert.Intent(before: "", start: 0, end: 0, replacement: claim.insertionText)
        let edit = InsertionGuard.ApprovedEdit(target: claim.offer.target, replaceStart: 0, replaceEnd: 0, replacement: claim.insertionText, resultingValue: claim.insertionText)
        let armed = UndoGrant.armed(target: claim.offer.target, priorValue: "", edit: edit, origin: nil, writeID: 9)
        let report = UnconfirmedInsert.read(intent, held: held)
        return InlineInsertion(claim: claim, recovery: report, undo: UnconfirmedInsert.grant(armed: armed, verified: false, report: report))
    }

    /// A ghost stopped partway: the line at the caret says so and owns ⌘Z while it shows; ⌘Z runs
    /// the insertion queue's undo and the line says what it did.
    func testAPartialInlineInsertShowsALineWhoseUndoTakesItOut() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        XCTAssertEqual(rig.takeLog(), ["toast slot", "panel enter Only part of the text went in."])
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z is not Caret's") }
        XCTAssertNil(grant.taskID)
        XCTAssertTrue(grant.partialWrite)
        rig.machine.undoStarted(grant)
        XCTAssertEqual(rig.takeLog(), ["line Undoing"])
        rig.machine.inlineUndoFinished(grantID: grant.id, ok: true, error: nil, partial: true, says: nil)
        XCTAssertEqual(rig.takeLog(), ["line Took out the part that went in"])
    }

    // MARK: - Re-review: the inline line's ownership

    /// No visible anchor (the app went behind, or its field cannot be read): ⌘Z stays with the host
    /// and a fill toast keeps its own, since a shortcut belongs to a visible offer or to the host.
    func testAnInlineResultWithNoVisibleAnchorLeavesCommandZAlone() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.fillLineToast()
        let fill = rig.arbiter.snapshot().toast?.id
        XCTAssertNotNil(fill)
        rig.screen.behind()
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertEqual(rig.arbiter.snapshot().toast?.id, fill, "the fill toast keeps ⌘Z")
        XCTAssertNil(rig.machine.toastGrantID)
        // In front, but another field has focus now: the line would describe a field the user left.
        let other = SurfaceRig()
        other.screen.front(.phone)
        other.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        XCTAssertEqual(other.takeLog(), [])
        XCTAssertNil(other.arbiter.snapshot().toast)
        XCTAssertEqual(other.arbiter.handleKeyDown(Fx.cmdZ(), now: other.clock.now), .pass(.noOffer))
    }

    /// The "Undoing" line ended (its 10 s ran out) before the queue answered: the late answer no
    /// longer owns the panel and draws nothing.
    func testALateInlineUndoAnswerDrawsNothingOnceItsLineEnded() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z is not Caret's") }
        rig.machine.undoStarted(grant)
        rig.clock.advance(by: 10.1)
        rig.takeLog()
        rig.machine.inlineUndoFinished(grantID: grant.id, ok: true, error: nil, partial: true, says: nil)
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertNil(rig.machine.lineText)
    }

    /// The queue's answer reached main before the tap's `undoStarted` did (an immediate refusal):
    /// it is still the line's answer, and the late start draws no "Undoing" over it.
    func testAnInlineUndoAnswerThatArrivesBeforeItsStartIsShown() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        rig.takeLog()
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z is not Caret's") }
        rig.machine.inlineUndoFinished(grantID: grant.id, ok: false, error: "inputDuringUndo", partial: false, says: nil)
        XCTAssertEqual(rig.takeLog(), ["line You typed as Caret was undoing, so Caret left the field as it is."])
        rig.machine.undoStarted(grant)
        XCTAssertEqual(rig.takeLog(), [])
    }

    /// The described-and-left line has no ⌘Z, but it is a result line: Esc closes it, and typing
    /// on takes it down, instead of it staying until its timeout.
    func testAnUngrantedInlineLineTakesEscAndTyping() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summX"))
        rig.takeLog()
        XCTAssertNotNil(rig.arbiter.snapshot().statusLine)
        rig.press(Fx.esc())
        XCTAssertEqual(rig.takeLog(), ["hide 0.08"])
        XCTAssertNil(rig.machine.lineText)
        let typed = SurfaceRig()
        typed.screen.front(.email)
        typed.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summX"))
        typed.takeLog()
        typed.press(Fx.type("a"))
        XCTAssertEqual(typed.takeLog(), ["hide 0.08"])
        XCTAssertNil(typed.arbiter.snapshot().statusLine)
    }

    func testAnUnrecognizedInlineInsertIsDescribedAndLeft() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summX"))
        XCTAssertEqual(rig.takeLog(), [#"panel enter The field now holds "summX"; before the write it held ""; Caret left it as it is."#])
        XCTAssertNil(rig.arbiter.snapshot().toast)
    }

    func testAnInlineInsertThatLeftTheFieldAsItWasShowsNothing() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: ""))
        XCTAssertEqual(rig.takeLog(), [])
        XCTAssertNil(rig.arbiter.snapshot().toast)
    }

    /// ⌘Z that found the field changed since: the line says what it holds, and nothing was written.
    func testAnInlineUndoThatWasRefusedSaysWhy() {
        let rig = SurfaceRig()
        rig.screen.front(.email)
        rig.machine.inlineInsertionFinished(Self.inline(Self.ghostClaim(), held: "summ"))
        rig.takeLog()
        guard case .undo(let grant) = rig.arbiter.handleKeyDown(Fx.cmdZ(), now: rig.clock.now) else { return XCTFail("⌘Z is not Caret's") }
        rig.machine.undoStarted(grant)
        rig.takeLog()
        rig.machine.inlineUndoFinished(grantID: grant.id, ok: false, error: "inputDuringUndo", partial: false, says: nil)
        XCTAssertEqual(rig.takeLog(), ["line You typed as Caret was undoing, so Caret left the field as it is."])
    }
}
