import XCTest
import CaretCore
@testable import Caret

/// Decoding against the timestamp shapes the real Python core emits.
///
/// The core builds created_at from datetime.now(timezone.utc).isoformat(),
/// which carries six fractional digits. A formatter built with
/// .withInternetDateTime alone parses "+00:00" and still returns nil for
/// ".828359+00:00", so every live offer would arrive undecodable while whole
/// second fixtures kept passing. That is the case this pins.
final class BridgeContractTests: XCTestCase {
    private func offerLine(createdAt: String) -> Data {
        Data("""
        {"event":"offer","offer":{"kind":"inline","proposal_id":"p1","revision":7,
        "target":{"pid":501,"bundle_id":"com.apple.TextEdit","window_id":"win-1",
        "element_id":"el-1","element_revision":"abc123"},
        "created_at":"\(createdAt)","replace_start":16,"replace_end":16,
        "replacement":" summary to the team","original_digest":"e3b0c44298fc1c14"}}
        """.utf8)
    }

    private struct Line: Decodable { let offer: Offer }

    func testDecodesFractionalSecondTimestampFromRealCore() throws {
        let line = try JSONDecoder().decode(Line.self, from: offerLine(createdAt: "2026-09-19T18:59:20.828359+00:00"))
        guard case .inline(let offer) = line.offer else { return XCTFail("expected an inline offer") }
        XCTAssertEqual(offer.proposalID, "p1")
        XCTAssertEqual(offer.replaceStart, 16)
    }

    func testDecodesWholeSecondAndZuluForms() throws {
        for stamp in ["2026-09-19T18:59:20+00:00", "2026-09-19T18:59:20Z", "2026-09-19T18:59:20.828359Z"] {
            let line = try JSONDecoder().decode(Line.self, from: offerLine(createdAt: stamp))
            guard case .inline = line.offer else { return XCTFail("expected an inline offer for \(stamp)") }
        }
    }

    /// An offer event carries no "status"; only the accept result does.
    func testOfferDecodesWithoutStatusField() throws {
        let line = try JSONDecoder().decode(Line.self, from: offerLine(createdAt: "2026-09-19T18:59:20.1+00:00"))
        guard case .inline(let offer) = line.offer else { return XCTFail("expected an inline offer") }
        XCTAssertEqual(offer.originalDigest, "e3b0c44298fc1c14")
    }

    /// A caret insertion digests the empty replaced span, which is why the
    /// protocol sample looks like a placeholder and is not one.
    func testInsertionDigestsTheEmptyReplacedSpan() {
        XCTAssertEqual(UTF16Text.digest(""), "e3b0c44298fc1c14")
    }

    /// The app must round-trip its own offer into the shape the guard reads.
    func testCoreEditRoundTripsThroughTheWireEncoding() throws {
        let target = InlineTarget(pid: 501, bundleID: "b", windowID: "win-1", elementID: "el-1", elementRevision: "r")
        let offer = Caret.InlineOffer(
            proposalID: "p1", revision: 3, target: target,
            replaceStart: 5, replaceEnd: 5, replacement: " world",
            originalDigest: UTF16Text.digest(""), createdAt: Date()
        )
        let edit = try XCTUnwrap(offer.coreEdit)
        XCTAssertEqual(edit.proposalID, "p1")
        XCTAssertEqual(edit.target.elementID, "el-1")
        XCTAssertEqual(edit.replaceStart, 5)
        XCTAssertNil(edit.status, "an offer-derived edit carries no status")
    }

    /// A catalog entry is describable but not runnable, so it must never be
    /// presented as a choice Cmd-1 can execute.
    func testCatalogEntryIsNotExecutable() {
        var offer = CaretActionOffer(
            proposalID: "a1", revision: 1,
            target: TargetIdentity(pid: 1, bundleID: "b", windowID: "w", elementID: "e", elementRevision: "r"),
            workflowID: "book-flight", title: "Book flight", effect: "", evidence: [],
            missingInputs: [], executionMethod: "", sampleOnly: true
        )
        XCTAssertFalse(offer.isExecutable)
        XCTAssertNotNil(offer.unavailabilityText)

        offer.sampleOnly = false
        XCTAssertFalse(offer.isExecutable, "no execution method is still not runnable")

        offer.executionMethod = "adapter"
        offer.missingInputs = ["calendar"]
        XCTAssertFalse(offer.isExecutable, "a missing input is not runnable")
        XCTAssertEqual(offer.unavailabilityText, "Needs calendar before it can run.")

        offer.missingInputs = []
        XCTAssertTrue(offer.isExecutable)
        XCTAssertNil(offer.unavailabilityText)
    }

    /// The codes mean different things to a user: a refused acceptance means
    /// nothing ran, a workflow error means it ran and failed, and
    /// internal_error means the core itself broke. Collapsing them would tell
    /// the user a workflow failed when it never started.
    func testErrorCodesMapToDistinctStates() {
        func state(_ code: String, _ message: String = "boom") -> CaretActionOffer.State {
            CoreBridgeProvider.actionState(for: BridgeError.core(code: code, message: message))
        }

        guard case .unavailable = state("acceptance_rejected") else {
            return XCTFail("a refused acceptance must not read as a failed run")
        }
        guard case .failed(let workflow) = state("workflow_error") else {
            return XCTFail("workflow_error is a failed run")
        }
        XCTAssertEqual(workflow, "boom")

        guard case .failed(let internalSummary) = state("internal_error") else {
            return XCTFail("internal_error displays as a failure")
        }
        XCTAssertTrue(
            internalSummary.contains("unexpected"),
            "internal_error should say the core broke, not blame a provider"
        )

        guard case .failed = state("provider_error") else {
            return XCTFail("provider_error is a failed run")
        }
    }

    /// A transport death is not a core error code and must not be reported as
    /// one.
    func testTransportFailureIsNotACoreCode() {
        guard case .failed(let summary) = CoreBridgeProvider.actionState(for: BridgeError.notRunning) else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(summary.contains("stopped responding"))
    }
}
