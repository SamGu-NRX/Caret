import XCTest
@testable import CaretCore

/// `datetime.now(timezone.utc).isoformat()` emits six fractional digits, which
/// is what a live offer's `created_at` carries. A parser matching only whole
/// seconds returns nil and the offer decodes as unknown.
final class CoreTimestampTests: XCTestCase {
    func testTheFormLivePythonActuallyEmitsParses() {
        // Captured from datetime.now(timezone.utc).isoformat() on this machine.
        XCTAssertNotNil(CoreTimestamp.date(from: "2026-09-19T18:59:20.828359+00:00"))
        XCTAssertNotNil(CoreTimestamp.date(from: "2026-09-19T18:55:48.704267+00:00"))
    }

    func testWholeSecondAndOffsetFormsStillParse() {
        // datetime(...).isoformat() with no microseconds, as fixtures produce.
        XCTAssertNotNil(CoreTimestamp.date(from: "2026-09-19T12:00:00+00:00"))
        XCTAssertNotNil(CoreTimestamp.date(from: "2026-09-19T12:00:00Z"))
        XCTAssertNotNil(CoreTimestamp.date(from: "2026-09-19T12:00:00.500Z"))
    }

    func testFractionalAndWholeFormsOfOneInstantAgree() throws {
        let whole = try XCTUnwrap(CoreTimestamp.date(from: "2026-09-19T12:00:00+00:00"))
        let fractional = try XCTUnwrap(CoreTimestamp.date(from: "2026-09-19T12:00:00.000000+00:00"))
        XCTAssertEqual(whole.timeIntervalSince1970, fractional.timeIntervalSince1970, accuracy: 0.001)
    }

    func testRoundTripThroughTheEncoderParses() {
        let now = Date()
        XCTAssertNotNil(CoreTimestamp.date(from: CoreTimestamp.string(from: now)))
    }

    func testNonsenseStillReturnsNil() {
        XCTAssertNil(CoreTimestamp.date(from: "not a timestamp"))
        XCTAssertNil(CoreTimestamp.date(from: ""))
        // No offset: the core refuses these too.
        XCTAssertNil(CoreTimestamp.date(from: "2026-09-19T12:00:00"))
    }

    // MARK: - Offers carrying a live timestamp

    func testAnInlineOfferWithFractionalSecondsDecodes() throws {
        let json = """
        {"kind":"inline","proposal_id":"p1","revision":7,
         "target":{"pid":4242,"bundle_id":"com.example.Editor","window_id":"w1",
                   "element_id":"compose","element_revision":"70f6d48e3934fde6"},
         "created_at":"2026-09-19T18:59:20.828359+00:00","replace_start":16,"replace_end":16,
         "replacement":" summary","original_digest":"e3b0c44298fc1c14"}
        """
        let offer = try JSONDecoder().decode(Offer.self, from: Data(json.utf8))
        guard case .inline(let inline) = offer else { return XCTFail("expected an inline offer") }
        XCTAssertEqual(inline.proposalID, "p1")
        XCTAssertEqual(inline.createdAt, CoreTimestamp.date(from: "2026-09-19T18:59:20.828359+00:00"))
    }

    func testAnActionOfferWithFractionalSecondsDecodes() throws {
        let json = """
        {"kind":"action","proposal_id":"p2","revision":9,
         "target":{"pid":4242,"bundle_id":"com.example.Editor","window_id":"w1",
                   "element_id":"compose","element_revision":"70f6d48e3934fde6"},
         "created_at":"2026-09-19T18:59:20.828359+00:00","workflow_id":"schedule",
         "title":"Schedule the sync","effect":"Creates a calendar event","evidence":["thread"],
         "required_inputs":[],"missing_inputs":[],"execution_method":"scheduler.rpc","sample_only":false}
        """
        let offer = try JSONDecoder().decode(Offer.self, from: Data(json.utf8))
        guard case .action(let action) = offer else { return XCTFail("expected an action offer") }
        XCTAssertEqual(action.workflowID, "schedule")
        XCTAssertEqual(action.title, "Schedule the sync")
    }

    func testAnEventLineCarryingAFractionalOfferReachesTheClient() throws {
        let transport = FakeTransport()
        let client = CoreBridgeClient(transport: transport)
        let received = Received()
        client.onEvent { received.append($0) }
        try client.start()

        transport.emit(line: """
        {"event":"offer","offer":{"kind":"inline","proposal_id":"p1","revision":7,\
        "target":{"pid":4242,"bundle_id":"com.example.Editor","window_id":"w1","element_id":"compose",\
        "element_revision":"70f6d48e3934fde6"},"created_at":"2026-09-19T18:59:20.828359+00:00",\
        "replace_start":16,"replace_end":16,"replacement":" summary","original_digest":"e3b0c44298fc1c14"}}
        """)

        // A parser that rejects fractional seconds turns this into .unknown.
        guard case .offer(let offer)? = received.all().first else {
            return XCTFail("expected an offer, got \(received.all())")
        }
        XCTAssertEqual(offer.proposalID, "p1")
    }
}
