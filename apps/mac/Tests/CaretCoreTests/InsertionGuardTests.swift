import XCTest
@testable import CaretCore

/// The offer JSON below was produced by `caret/router.py::build_inline_offer`
/// in the judge repository, run read-only with bytecode disabled, not written
/// by hand. `original_digest` is the digest of the replaced span alone.
final class InsertionGuardTests: XCTestCase {
    /// Insertion at the caret of "I will send the ". digest("") is e3b0c442...
    private static let insertionOfferJSON = """
    {"proposal_id":"c536e084-bca3-4f86-9bb9-3d845bb0e9eb","kind":"inline","revision":7,
     "target":{"pid":4242,"bundle_id":"com.example.Editor","window_id":"w1","element_id":"compose",
               "element_revision":"70f6d48e3934fde6"},
     "created_at":"2026-09-19T12:00:00+00:00","replace_start":16,"replace_end":16,
     "replacement":" summary to the team","original_digest":"e3b0c44298fc1c14"}
    """

    /// Replacing the selected "draft" in "I will send the draft".
    private static let replacementOfferJSON = """
    {"proposal_id":"63c21b2a-08a3-4e10-b347-80e0846391c5","kind":"inline","revision":7,
     "target":{"pid":4242,"bundle_id":"com.example.Editor","window_id":"w1","element_id":"compose",
               "element_revision":"800b1c99db9494ef"},
     "created_at":"2026-09-19T12:00:00+00:00","replace_start":16,"replace_end":21,
     "replacement":"final report","original_digest":"7743ce348d9284d6"}
    """

    private func edit(_ json: String) throws -> InlineEdit {
        try JSONDecoder().decode(InlineEdit.self, from: Data(json.utf8))
    }

    private func offer(_ json: String) throws -> InlineOffer {
        try JSONDecoder().decode(InlineOffer.self, from: Data(json.utf8))
    }

    private func live(_ value: String, selection: TextSelection? = nil, secure: Bool = false, mutate: ((inout TargetIdentity) -> Void)? = nil) -> InsertionGuard.LiveField {
        var target = TargetIdentity(
            pid: 4242, bundleID: "com.example.Editor", windowID: "w1",
            elementID: "compose", elementRevision: UTF16Text.digest(value)
        )
        mutate?(&target)
        return InsertionGuard.LiveField(target: target, value: value, selection: selection, secure: secure)
    }

    // MARK: - Contract with the core's own output

    func testAnAcceptResultCarriesTheSameRangeFieldsPlusAStatus() throws {
        // engine.accept returns the offer's range fields with kind, status and
        // a note added; the offer event itself has no status.
        let accepted = try edit(Self.insertionOfferJSON.replacingOccurrences(
            of: "\"kind\":\"inline\"",
            with: "\"kind\":\"inline\",\"status\":\"ready_to_insert\""
        ))
        XCTAssertEqual(accepted.status, "ready_to_insert")
        XCTAssertEqual(accepted.replaceStart, 16)
        XCTAssertNil(try edit(Self.insertionOfferJSON).status)
    }

    func testTheCoreUsesTheEmptyDigestForAnInsertion() throws {
        let edit = try edit(Self.insertionOfferJSON)
        XCTAssertEqual(edit.originalDigest, UTF16Text.digest(""))
        XCTAssertEqual(edit.replaceStart, edit.replaceEnd)
        // The whole-window digest is a different value; comparing against it
        // would reject every insertion.
        XCTAssertNotEqual(edit.originalDigest, UTF16Text.digest("I will send the "))
        XCTAssertEqual(UTF16Text.digest("I will send the "), edit.target.elementRevision)
    }

    func testTheCoreUsesTheSelectedTextDigestForAReplacement() throws {
        let edit = try edit(Self.replacementOfferJSON)
        XCTAssertEqual(edit.originalDigest, UTF16Text.digest("draft"))
        XCTAssertEqual(UTF16Text.digest("I will send the draft"), edit.target.elementRevision)
    }

    func testCreatedAtParsesTheOffsetFormTheCoreActuallyEmits() throws {
        // The core emits "+00:00" from datetime.isoformat(), not "Z".
        let offer = try offer(Self.insertionOfferJSON)
        XCTAssertEqual(offer.createdAt, CoreTimestamp.date(from: "2026-09-19T12:00:00+00:00"))
        XCTAssertNotNil(offer.createdAt)
    }

    // MARK: - Approval

    func testAnInsertionAtAnUnchangedCaretIsApproved() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("I will send the ", selection: TextSelection(start: 16, end: 16)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "I will send the  summary to the team")
    }

    func testAReplacementOfAnUnchangedSelectionIsApproved() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.replacementOfferJSON),
            live: live("I will send the draft", selection: TextSelection(start: 16, end: 21)),
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "I will send the final report")
    }

    // MARK: - Rejection

    func testAMovedTargetIsRejected() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("I will send the ") { $0.windowID = "w2" },
            createdAt: Date()
        )
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testADifferentProcessIsRejected() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("I will send the ") { $0.pid = 5150 },
            createdAt: Date()
        )
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testTextTypedElsewhereInTheFieldIsRejected() throws {
        // Same caret, same replaced span (still empty), different field value.
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("XI will send the ", selection: TextSelection(start: 16, end: 16)),
            createdAt: Date()
        )
        guard case .failure(.fieldContentChanged) = result else {
            return XCTFail("expected fieldContentChanged, got \(result)")
        }
    }

    func testAChangedSelectionIsRejected() throws {
        var target = TargetIdentity(
            pid: 4242, bundleID: "com.example.Editor", windowID: "w1",
            elementID: "compose", elementRevision: "800b1c99db9494ef"
        )
        target.elementRevision = UTF16Text.digest("I will send the draft")
        let result = InsertionGuard.approve(
            edit: try edit(Self.replacementOfferJSON),
            live: InsertionGuard.LiveField(
                target: target,
                value: "I will send the draft",
                selection: TextSelection(start: 0, end: 0)
            ),
            createdAt: Date()
        )
        guard case .failure(.selectionMoved) = result else { return XCTFail("expected selectionMoved, got \(result)") }
    }

    func testAReplacedSpanThatNoLongerMatchesIsRejected() throws {
        // Field digest is forced to match so the span check is what fires.
        var target = TargetIdentity(
            pid: 4242, bundleID: "com.example.Editor", windowID: "w1",
            elementID: "compose", elementRevision: "800b1c99db9494ef"
        )
        _ = target
        let json = Self.replacementOfferJSON.replacingOccurrences(
            of: "\"element_revision\":\"800b1c99db9494ef\"",
            with: "\"element_revision\":\"\(UTF16Text.digest("I will send the other"))\""
        )
        let result = InsertionGuard.approve(
            edit: try edit(json),
            live: live("I will send the other", selection: TextSelection(start: 16, end: 21)),
            createdAt: Date()
        )
        guard case .failure(.replacedTextChanged) = result else {
            return XCTFail("expected replacedTextChanged, got \(result)")
        }
    }

    func testARangePastTheLiveValueIsRejected() throws {
        let json = Self.insertionOfferJSON
            .replacingOccurrences(of: "\"replace_start\":16,\"replace_end\":16", with: "\"replace_start\":40,\"replace_end\":44")
        let result = InsertionGuard.approve(
            edit: try edit(json),
            live: live("I will send the "),
            createdAt: Date()
        )
        guard case .failure(.rangeOutsideValue(_, _, let length)) = result else {
            return XCTFail("expected rangeOutsideValue, got \(result)")
        }
        XCTAssertEqual(length, 16)
    }

    func testARangeInsideASurrogatePairIsRejected() throws {
        let value = "hi 👋"
        let json = Self.insertionOfferJSON
            .replacingOccurrences(of: "\"replace_start\":16,\"replace_end\":16", with: "\"replace_start\":4,\"replace_end\":4")
            .replacingOccurrences(of: "\"element_revision\":\"70f6d48e3934fde6\"", with: "\"element_revision\":\"\(UTF16Text.digest(value))\"")
        let result = InsertionGuard.approve(edit: try edit(json), live: live(value), createdAt: Date())
        guard case .failure(.rangeSplitsCharacter) = result else {
            return XCTFail("expected rangeSplitsCharacter, got \(result)")
        }
    }

    func testAnOfferOlderThanTheLimitIsRejected() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("I will send the "),
            createdAt: Date(timeIntervalSinceNow: -45),
            maxAgeSeconds: 30
        )
        guard case .failure(.offerExpired) = result else { return XCTFail("expected offerExpired, got \(result)") }
    }

    func testASecureFieldIsRejectedFirst() throws {
        let result = InsertionGuard.approve(
            edit: try edit(Self.insertionOfferJSON),
            live: live("I will send the ", secure: true),
            createdAt: Date()
        )
        guard case .failure(let rejection) = result else { return XCTFail("expected a rejection") }
        XCTAssertEqual(rejection, .secureField)
    }
}
