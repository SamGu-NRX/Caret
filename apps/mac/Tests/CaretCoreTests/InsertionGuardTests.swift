import XCTest
@testable import CaretCore

final class InsertionGuardTests: XCTestCase {
    private let value = "I will send the "

    private func edit(
        target: TargetIdentity = Fixtures.target,
        start: Int = 16,
        end: Int = 16,
        replacement: String = " summary to the team",
        digest: String? = nil
    ) -> InlineEdit {
        let json = """
        {"kind":"inline","proposal_id":"p1","status":"ready_to_insert",
         "target":{"pid":\(target.pid),"bundle_id":"\(target.bundleID)","window_id":"\(target.windowID)",
                   "element_id":"\(target.elementID)","element_revision":"\(target.elementRevision)"},
         "replace_start":\(start),"replace_end":\(end),"replacement":"\(replacement)",
         "original_digest":"\(digest ?? UTF16Text.digest(value))"}
        """
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(InlineEdit.self, from: Data(json.utf8))
    }

    private func live(value: String? = nil, target: TargetIdentity = Fixtures.target, secure: Bool = false) -> InsertionGuard.LiveField {
        InsertionGuard.LiveField(target: target, value: value ?? self.value, secure: secure)
    }

    func testAnUnchangedTargetAndContentIsApproved() {
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, "I will send the  summary to the team")
        XCTAssertEqual(approved.replaceStart, 16)
        XCTAssertEqual(approved.replaceEnd, 16)
    }

    func testAMovedTargetIsRejected() {
        var moved = Fixtures.target
        moved.windowID = "w2"
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(target: moved),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .failure(.targetMoved(let expected, let actual)) = result else {
            return XCTFail("expected targetMoved, got \(result)")
        }
        XCTAssertEqual(expected.windowID, "w1")
        XCTAssertEqual(actual.windowID, "w2")
    }

    func testADifferentProcessIsRejectedEvenWithTheSameElementID() {
        var other = Fixtures.target
        other.pid = 5150
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(target: other),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testContentTheUserChangedIsRejected() {
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(value: "I will not send the "),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .failure(.contentChanged) = result else { return XCTFail("expected contentChanged, got \(result)") }
    }

    func testARangePastTheLiveValueIsRejected() {
        let result = InsertionGuard.approve(
            edit: edit(start: 40, end: 44),
            live: live(),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .failure(.rangeOutsideValue(_, _, let length)) = result else {
            return XCTFail("expected rangeOutsideValue, got \(result)")
        }
        XCTAssertEqual(length, 16)
    }

    func testARangeInsideASurrogatePairIsRejected() {
        let emoji = "hi 👋"
        let result = InsertionGuard.approve(
            edit: edit(start: 4, end: 4, digest: UTF16Text.digest(emoji)),
            live: live(value: emoji),
            windowOffset: 0,
            windowLength: 5,
            createdAt: Date()
        )
        guard case .failure(.rangeSplitsCharacter) = result else {
            return XCTFail("expected rangeSplitsCharacter, got \(result)")
        }
    }

    func testAnOfferOlderThanTheLimitIsRejected() {
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date(timeIntervalSinceNow: -45),
            maxAgeSeconds: 30
        )
        guard case .failure(.offerExpired) = result else { return XCTFail("expected offerExpired, got \(result)") }
    }

    func testASecureFieldIsRejectedBeforeAnythingElseIsChecked() {
        let result = InsertionGuard.approve(
            edit: edit(),
            live: live(secure: true),
            windowOffset: 0,
            windowLength: 16,
            createdAt: Date()
        )
        guard case .failure(let rejection) = result else { return XCTFail("expected a rejection") }
        XCTAssertEqual(rejection, .secureField)
    }
}
