import CaretHostCore
import XCTest

/// The guarded range edit: one accepted case per shape of text, and a test for every refusal.
final class RangeEditTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func target(_ element: String = "body") -> TargetIdentity {
        TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: element, elementRevision: "")
    }

    /// The field as a reader reports it: the revision is the digest of the value.
    func live(_ value: String, caret: Int? = nil, selection: UTF16Selection? = nil, element: String = "body", secure: Bool = false, composing: Bool = false) -> RangeEdit.Live {
        var t = target(element)
        t.elementRevision = UTF16Text.digest(value)
        let sel = selection ?? caret.map { UTF16Selection.caret($0) } ?? .caret(UTF16Text.length(value))
        return RangeEdit.Live(target: t, value: value, selection: sel, secure: secure, composing: composing)
    }

    func span(of word: String, in text: String) -> UTF16Span {
        let r = (text as NSString).range(of: word)
        precondition(r.location != NSNotFound, word)
        return UTF16Span(r)
    }

    func make(_ field: RangeEdit.Live, _ word: String, _ replacement: String) throws -> RangeEdit {
        try RangeEdit.make(live: field, replace: span(of: word, in: field.value), replacement: replacement, now: t0).get()
    }

    func refusal(_ result: Result<RangeEdit.Approved, RangeEdit.Refusal>) -> RangeEdit.Refusal? {
        if case .failure(let r) = result { return r }
        return nil
    }

    // MARK: - Accepted

    func testReplacesAWordBehindTheCaretWithoutSelectingIt() throws {
        let field = live("We was planning to meet.")
        let edit = try make(field, "was", "were")
        XCTAssertEqual(edit.observedSelection, .caret(24), "the selection is bound apart from the range")
        XCTAssertEqual(edit.replace, UTF16Span(start: 3, end: 6))
        let approved = try edit.validate(field, now: t0).get()
        XCTAssertEqual(approved.resultingValue, "We were planning to meet.")
        XCTAssertEqual(approved.inserted, UTF16Span(start: 3, end: 7))
        XCTAssertEqual(approved.resultingSelection, .caret(25), "the caret after the range moves with the text")
    }

    func testTheExecutorsOwnSelectionOfTheRangeIsAuthorized() throws {
        let field = live("We was planning to meet.")
        let edit = try make(field, "was", "were")
        var selected = field
        selected.selection = UTF16Selection(start: 3, end: 6)
        XCTAssertNoThrow(try edit.validate(selected, phase: .rangeSelected, now: t0).get())
        // The same selection is not the user's observed one.
        XCTAssertEqual(refusal(edit.validate(selected, phase: .observed, now: t0))?.code, "selectionMoved")
        // And after selecting, the user's old caret is not the range.
        XCTAssertEqual(refusal(edit.validate(field, phase: .rangeSelected, now: t0))?.code, "selectionMoved")
    }

    func testASelectionCoveringTheRangeCoversTheReplacement() throws {
        let field = live("I saw teh dog.", selection: UTF16Selection(start: 6, end: 9))
        let approved = try make(field, "teh", "the").validate(field, now: t0).get()
        XCTAssertEqual(approved.resultingSelection, UTF16Selection(start: 6, end: 9))
    }

    func testEmojiBeforeTheRangeKeepUTF16Offsets() throws {
        let field = live("👨‍👩‍👧 🇺🇸 We was there.")
        let edit = try make(field, "was", "were")
        let approved = try edit.validate(field, now: t0).get()
        XCTAssertEqual(approved.resultingValue, "👨‍👩‍👧 🇺🇸 We were there.")
    }

    func testCombiningMarksStayOnTheirLetters() throws {
        // "café" with a combining accent, then a typo.
        let field = live("Le cafe\u{301} est tres bon.")
        let approved = try make(field, "tres", "très").validate(field, now: t0).get()
        XCTAssertEqual(approved.resultingValue, "Le cafe\u{301} est très bon.")
        // Replacing the whole "é" cluster is fine.
        let e = UTF16Span(start: 6, end: 8)
        XCTAssertNoThrow(try RangeEdit.make(live: field, replace: e, replacement: "e", now: t0).get())
    }

    func testRightToLeftTextUsesLogicalOffsets() throws {
        let hebrew = live("שלום עולם יפה")
        let approved = try make(hebrew, "עולם", "חבר").validate(hebrew, now: t0).get()
        XCTAssertEqual(approved.resultingValue, "שלום חבר יפה")
        // Mixed direction: an English word inside Arabic.
        let mixed = live("مرحبا teh عالم")
        XCTAssertEqual(try make(mixed, "teh", "the").validate(mixed, now: t0).get().resultingValue, "مرحبا the عالم")
    }

    // MARK: - Refusals, one test each

    func testRefusesASecureField() throws {
        let field = live("hunter2 hunter2")
        let edit = try make(field, "hunter2", "x")
        var secure = field
        secure.secure = true
        XCTAssertEqual(refusal(edit.validate(secure, now: t0)), .secureField)
        XCTAssertEqual(makeRefusal(secure, UTF16Span(start: 0, end: 7)), .secureField, "never offered in a secure field either")
    }

    func testRefusesWhileAnInputMethodIsComposing() throws {
        let field = live("We was here. にほん")
        let edit = try make(field, "was", "were")
        var composing = field
        composing.composing = true
        XCTAssertEqual(refusal(edit.validate(composing, now: t0)), .composing)
    }

    func testRefusesAnotherElement() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        XCTAssertEqual(refusal(edit.validate(live("We was here.", element: "subject"), now: t0)), .targetMoved)
    }

    func testRefusesAChangedField() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        // One character typed elsewhere in the field.
        XCTAssertEqual(refusal(edit.validate(live("We was here!", caret: 12), now: t0)), .revisionChanged)
    }

    func testRefusesAChangedValueUnderAStaleRevisionToken() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        var stale = field
        stale.value = "We was there."
        XCTAssertEqual(refusal(edit.validate(stale, now: t0)), .revisionChanged)
    }

    func testRefusesAnExpiredOffer() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        XCTAssertEqual(refusal(edit.validate(field, now: t0.addingTimeInterval(31)))?.code, "expired")
    }

    func testRefusesWhenTheSelectionCannotBeRead() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        var unread = field
        unread.selection = nil
        XCTAssertEqual(refusal(edit.validate(unread, now: t0)), .selectionUnreadable)
    }

    func testRefusesAMovedSelection() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        XCTAssertEqual(refusal(edit.validate(live("We was here.", caret: 0), now: t0)), .selectionMoved(expected: .caret(12), live: .caret(0)))
    }

    func testRefusesACaretOrSelectionInsideTheRange() {
        let was = UTF16Span(start: 3, end: 6)
        XCTAssertEqual(makeRefusal(live("We was here.", caret: 4), was, "were"), .selectionStraddlesRange)
        XCTAssertEqual(makeRefusal(live("We was here.", selection: UTF16Selection(start: 4, end: 9)), was, "were"), .selectionStraddlesRange)
    }

    func testRefusesARangeOutsideTheValue() throws {
        let field = live("We was here.")
        let result = RangeEdit.make(live: field, replace: UTF16Span(start: 10, end: 40), replacement: "x", now: t0)
        guard case .failure(.rangeOutsideValue) = result else { return XCTFail("\(result)") }
    }

    func testRefusesARangeThatSplitsASurrogatePair() {
        let field = live("👋 hi")
        XCTAssertEqual(makeRefusal(field, UTF16Span(start: 1, end: 3)), .rangeSplitsCharacter(offset: 1))
    }

    func testRefusesARangeThatSplitsAnEmojiSequence() {
        // Wave with a skin tone: the tone modifier at offset 2 belongs to the wave.
        XCTAssertEqual(makeRefusal(live("👋🏽 hi"), UTF16Span(start: 0, end: 2)), .rangeSplitsCharacter(offset: 2))
        // A family joined with ZWJ, and a flag of two regional indicators.
        XCTAssertEqual(makeRefusal(live("👨‍👩‍👧 hi"), UTF16Span(start: 0, end: 3)), .rangeSplitsCharacter(offset: 3))
        XCTAssertEqual(makeRefusal(live("🇺🇸 hi"), UTF16Span(start: 2, end: 4)), .rangeSplitsCharacter(offset: 2))
    }

    func testRefusesARangeThatSplitsACombiningMark() {
        // "e" plus U+0301: offset 7 sits between the letter and its accent.
        XCTAssertEqual(makeRefusal(live("Le cafe\u{301} est bon."), UTF16Span(start: 3, end: 7)), .rangeSplitsCharacter(offset: 7))
        // Arabic with a fatha on the first letter.
        XCTAssertEqual(makeRefusal(live("مَرحبا"), UTF16Span(start: 0, end: 1)), .rangeSplitsCharacter(offset: 1))
    }

    func testRefusesWhenTheReplacedTextIsNotTheOriginal() throws {
        let field = live("We was here.")
        var edit = try make(field, "was", "were")
        edit.originalDigest = UTF16Text.digest("are")
        XCTAssertEqual(refusal(edit.validate(field, now: t0)), .originalChanged)
    }

    func testRefusesAReplacementThatJoinsItsNeighbors() {
        // Starting with a combining accent would put it on the "s" before.
        XCTAssertEqual(makeRefusal(live("Yes cafe bon"), UTF16Span(start: 4, end: 8), "\u{301}cafe"), .replacementJoinsNeighbor)
        // Ending with a zero-width joiner would pull the next emoji into it.
        XCTAssertEqual(makeRefusal(live("x👍"), UTF16Span(start: 0, end: 1), "👨\u{200D}"), .replacementJoinsNeighbor)
        // A lone regional indicator beside another becomes a flag.
        XCTAssertEqual(makeRefusal(live("a🇸 b"), UTF16Span(start: 0, end: 1), "🇺"), .replacementJoinsNeighbor)
    }

    func testRefusesControlAndBidiCharactersInTheReplacement() {
        XCTAssertEqual(makeRefusal(live("We was here."), UTF16Span(start: 3, end: 6), "were\u{202E}"), .replacementHasControlCharacters)
        XCTAssertEqual(makeRefusal(live("We was here."), UTF16Span(start: 3, end: 6), "we\u{0007}re"), .replacementHasControlCharacters)
    }

    func testRefusesAnEditThatChangesNothing() {
        XCTAssertEqual(makeRefusal(live("We was here."), UTF16Span(start: 3, end: 6), "was"), .noChange)
    }

    // MARK: - Verify and undo

    func testVerifyRefusesAWriteThatDidNotLand() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        let approved = try edit.validate(field, now: t0).get()
        let wrong = live("We werewas here.")
        guard case .failure(.writeMismatch) = edit.verify(after: wrong, approved: approved, now: t0) else { return XCTFail() }
        guard case .failure(.targetMoved) = edit.verify(after: live(approved.resultingValue, element: "subject"), approved: approved, now: t0) else { return XCTFail() }
    }

    func testUndoIsOneExactRangeEditBackToTheOriginal() throws {
        let field = live("We was planning, and they was too.")
        // Fix all as one range: both "was" in one edit.
        let all = UTF16Span(start: 3, end: 30)
        let original = UTF16Text.slice(field.value, start: all.start, end: all.end)!
        let edit = try RangeEdit.make(live: field, replace: all, replacement: original.replacingOccurrences(of: "was", with: "were"), now: t0).get()
        let approved = try edit.validate(field, now: t0).get()
        XCTAssertEqual(approved.resultingValue, "We were planning, and they were too.")

        let written = live(approved.resultingValue, selection: approved.resultingSelection)
        let undo = try edit.verify(after: written, approved: approved, now: t0).get()
        XCTAssertEqual(undo.replace, approved.inserted)
        XCTAssertEqual(undo.replacement, original)
        let restored = try undo.validate(written, now: t0).get()
        XCTAssertEqual(restored.resultingValue, field.value)
        XCTAssertEqual(restored.resultingSelection, field.selection)
    }

    func testUndoIsRefusedOnceTheFieldChangesAgain() throws {
        let field = live("We was here.")
        let edit = try make(field, "was", "were")
        let approved = try edit.validate(field, now: t0).get()
        let written = live(approved.resultingValue, selection: approved.resultingSelection)
        let undo = try edit.verify(after: written, approved: approved, now: t0).get()
        XCTAssertEqual(refusal(undo.validate(live("We were here. A", caret: 15), now: t0)), .revisionChanged)
        XCTAssertEqual(refusal(undo.validate(written, now: t0.addingTimeInterval(UndoGrant.defaultLifetime + 1)))?.code, "expired")
    }

    func testRefusalCodesAreDistinct() {
        let all: [RangeEdit.Refusal] = [
            .secureField, .composing, .targetMoved, .revisionChanged, .expired(ageSeconds: 1, limit: 0), .selectionUnreadable,
            .selectionMoved(expected: .caret(0), live: .caret(1)), .selectionStraddlesRange,
            .rangeOutsideValue(UTF16Span(start: 0, end: 1), valueLength: 0), .rangeSplitsCharacter(offset: 0), .originalChanged,
            .replacementJoinsNeighbor, .replacementHasControlCharacters, .noChange, .writeMismatch,
        ]
        XCTAssertEqual(Set(all.map(\.code)).count, all.count)
    }

    // MARK: -

    private func makeRefusal(_ field: RangeEdit.Live, _ span: UTF16Span, _ replacement: String = "x") -> RangeEdit.Refusal? {
        if case .failure(let r) = RangeEdit.make(live: field, replace: span, replacement: replacement, now: t0) { return r }
        return nil
    }
}
