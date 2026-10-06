import XCTest
@testable import CaretHostCore

/// Mirrors the team repo's `InsertionGuardTests` (same values and digests) and adds the UTF-16
/// cases the host meets in real fields: emoji outside the BMP and CJK text.
final class InsertionGuardTests: XCTestCase {
    private func identity(_ value: String, mutate: ((inout TargetIdentity) -> Void)? = nil) -> TargetIdentity {
        var target = TargetIdentity(
            pid: 4242, bundleID: "com.example.Editor", windowID: "w1",
            elementID: "compose", elementRevision: UTF16Text.digest(value)
        )
        mutate?(&target)
        return target
    }

    private func insertion(into value: String, at offset: Int, _ text: String) -> InlineEdit {
        InlineEdit(
            target: identity(value), replaceStart: offset, replaceEnd: offset,
            replacement: text, originalDigest: UTF16Text.digest("")
        )
    }

    private func live(
        _ value: String,
        selection: UTF16Selection? = nil,
        secure: Bool = false,
        mutate: ((inout TargetIdentity) -> Void)? = nil
    ) -> InsertionGuard.LiveField {
        InsertionGuard.LiveField(target: identity(value, mutate: mutate), value: value, selection: selection, secure: secure)
    }

    // MARK: - Digests match the team repo

    func testDigestsMatchTheCoresValues() {
        XCTAssertEqual(UTF16Text.digest(""), "e3b0c44298fc1c14")
        XCTAssertEqual(UTF16Text.digest("I will send the "), "70f6d48e3934fde6")
        XCTAssertEqual(UTF16Text.digest("I will send the draft"), "800b1c99db9494ef")
        XCTAssertEqual(UTF16Text.digest("draft"), "7743ce348d9284d6")
    }

    // MARK: - Approval

    func testAnInsertionAtAnUnchangedCaretIsApproved() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, " summary to the team"),
            live: live("I will send the ", selection: .caret(16)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "I will send the  summary to the team")
    }

    func testAReplacementOfAnUnchangedSelectionIsApproved() {
        let value = "I will send the draft"
        let edit = InlineEdit(
            target: identity(value), replaceStart: 16, replaceEnd: 21,
            replacement: "final report", originalDigest: UTF16Text.digest("draft")
        )
        let result = InsertionGuard.approve(edit: edit, live: live(value, selection: UTF16Selection(start: 16, end: 21)), createdAt: Date())
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "I will send the final report")
    }

    func testAMidSentenceInsertionKeepsTheSuffix() {
        let value = "Thanks for the notes. See you"
        let result = InsertionGuard.approve(
            edit: insertion(into: value, at: 14, " detailed"),
            live: live(value, selection: .caret(14)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "Thanks for the detailed notes. See you")
    }

    // MARK: - Every rejection

    func testAMovedWindowIsRejected() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, "x"),
            live: live("I will send the ") { $0.windowID = "w2" },
            createdAt: Date()
        )
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testADifferentProcessIsRejected() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, "x"),
            live: live("I will send the ") { $0.pid = 5150 },
            createdAt: Date()
        )
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testADifferentElementOrAppIsRejected() {
        for mutate: (inout TargetIdentity) -> Void in [{ $0.elementID = "subject" }, { $0.bundleID = "com.example.Other" }] {
            let result = InsertionGuard.approve(
                edit: insertion(into: "I will send the ", at: 16, "x"),
                live: live("I will send the ", mutate: mutate),
                createdAt: Date()
            )
            guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
        }
    }

    func testTextTypedElsewhereInTheFieldIsRejected() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, "x"),
            live: live("XI will send the ", selection: .caret(16)),
            createdAt: Date()
        )
        guard case .failure(.fieldContentChanged) = result else {
            return XCTFail("expected fieldContentChanged, got \(result)")
        }
    }

    func testAChangedSelectionIsRejected() {
        let value = "I will send the draft"
        let edit = InlineEdit(
            target: identity(value), replaceStart: 16, replaceEnd: 21,
            replacement: "final report", originalDigest: UTF16Text.digest("draft")
        )
        let result = InsertionGuard.approve(edit: edit, live: live(value, selection: .caret(0)), createdAt: Date())
        guard case .failure(.selectionMoved) = result else { return XCTFail("expected selectionMoved, got \(result)") }
    }

    func testAReplacedSpanThatNoLongerMatchesIsRejected() {
        // The field digest matches the live value, so the span check is what fires.
        let value = "I will send the other"
        let edit = InlineEdit(
            target: identity(value), replaceStart: 16, replaceEnd: 21,
            replacement: "final report", originalDigest: UTF16Text.digest("draft")
        )
        let result = InsertionGuard.approve(edit: edit, live: live(value, selection: UTF16Selection(start: 16, end: 21)), createdAt: Date())
        guard case .failure(.replacedTextChanged) = result else {
            return XCTFail("expected replacedTextChanged, got \(result)")
        }
    }

    func testARangePastTheLiveValueIsRejected() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 40, "x"),
            live: live("I will send the "),
            createdAt: Date()
        )
        guard case .failure(.rangeOutsideValue(_, _, let length)) = result else {
            return XCTFail("expected rangeOutsideValue, got \(result)")
        }
        XCTAssertEqual(length, 16)
    }

    func testAnOfferOlderThanTheLimitIsRejected() {
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, "x"),
            live: live("I will send the "),
            createdAt: Date(timeIntervalSinceNow: -45),
            maxAgeSeconds: 30
        )
        guard case .failure(.offerExpired) = result else { return XCTFail("expected offerExpired, got \(result)") }
    }

    func testASecureFieldIsRejectedFirst() {
        // Also moved and changed: secure must still win, so no other check reads the value.
        let result = InsertionGuard.approve(
            edit: insertion(into: "I will send the ", at: 16, "x"),
            live: live("other", secure: true) { $0.pid = 1 },
            createdAt: Date()
        )
        guard case .failure(let rejection) = result else { return XCTFail("expected a rejection") }
        XCTAssertEqual(rejection, .secureField)
    }

    // MARK: - UTF-16 offsets

    func testAnInsertionAfterAnEmojiCountsTwoCodeUnits() {
        let value = "hi 👋 there"
        XCTAssertEqual(UTF16Text.length("hi 👋"), 5, "the wave is a surrogate pair")
        let result = InsertionGuard.approve(
            edit: insertion(into: value, at: 5, " all"),
            live: live(value, selection: .caret(5)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "hi 👋 all there")
    }

    func testARangeInsideASurrogatePairIsRejected() {
        let value = "hi 👋"
        let result = InsertionGuard.approve(edit: insertion(into: value, at: 4, "x"), live: live(value), createdAt: Date())
        guard case .failure(.rangeSplitsCharacter) = result else {
            return XCTFail("expected rangeSplitsCharacter, got \(result)")
        }
    }

    func testACaretCountedInCharactersInsteadOfCodeUnitsIsRejected() {
        // "👋👋" is 2 Characters but 4 code units. A caret counted in Characters (2, the end) lands
        // at UTF-16 offset 2, between the emoji. The live selection says 4, so the guard rejects
        // rather than inserting in the wrong place.
        let value = "👋👋"
        let result = InsertionGuard.approve(
            edit: insertion(into: value, at: 2, "x"),
            live: live(value, selection: .caret(4)),
            createdAt: Date()
        )
        guard case .failure(.selectionMoved) = result else { return XCTFail("expected selectionMoved, got \(result)") }
    }

    func testAnInsertionIntoCJKTextUsesCodeUnitOffsets() {
        let value = "你好世界"
        XCTAssertEqual(UTF16Text.length(value), 4)
        let result = InsertionGuard.approve(
            edit: insertion(into: value, at: 2, "，"),
            live: live(value, selection: .caret(2)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "你好，世界")
    }

    func testAReplacementOfCJKAfterAnEmoji() {
        // "🙂我爱北京": the emoji takes offsets 0..<2, so "北京" is 4..<6.
        let value = "🙂我爱北京"
        let edit = InlineEdit(
            target: identity(value), replaceStart: 4, replaceEnd: 6,
            replacement: "上海", originalDigest: UTF16Text.digest("北京")
        )
        let result = InsertionGuard.approve(edit: edit, live: live(value, selection: UTF16Selection(start: 4, end: 6)), createdAt: Date())
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "🙂我爱上海")
    }

    func testAnOffsetPastTheEndCountsCodeUnitsNotCharacters() {
        let value = "👋"
        guard case .success = InsertionGuard.approve(edit: insertion(into: value, at: 2, "x"), live: live(value), createdAt: Date()) else {
            return XCTFail("offset 2 is the end of a one-emoji value")
        }
        let result = InsertionGuard.approve(edit: insertion(into: value, at: 3, "x"), live: live(value), createdAt: Date())
        guard case .failure(.rangeOutsideValue(_, _, 2)) = result else {
            return XCTFail("expected rangeOutsideValue with length 2, got \(result)")
        }
    }
}
