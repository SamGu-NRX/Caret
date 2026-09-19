import XCTest
@testable import CaretCore

/// Pins the exact JSON the core's validator accepts.
///
/// The expected values below were produced by running an encoded frame through
/// `caret.context.ContextFrame.from_dict` in the judge repository, so a rename
/// on either side fails here rather than at the pipe during a demo.
final class CoreJSONShapeTests: XCTestCase {
    private func encoded(_ value: some Encodable) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let data = try encoder.encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testFrameCarriesEveryKeyTheCoreRequires() throws {
        let frame = try encoded(Fixtures.frame())
        XCTAssertEqual(
            Set(frame.keys),
            ["snapshot", "permissions", "clipboard", "history", "observations", "sources", "workflow_active"]
        )
        let snapshot = try XCTUnwrap(frame["snapshot"] as? [String: Any])
        XCTAssertEqual(
            Set(snapshot.keys),
            ["revision", "captured_at", "target", "role", "nearby_text", "text_offset", "caret",
             "selection", "secure", "ime_composing", "app_excluded", "value_length"]
        )
        let target = try XCTUnwrap(snapshot["target"] as? [String: Any])
        XCTAssertEqual(Set(target.keys), ["pid", "bundle_id", "window_id", "element_id", "element_revision"])
    }

    func testDigestAgreesWithThePythonImplementation() {
        // caret.context.digest("I will send the 👋") in the judge repository.
        XCTAssertEqual(UTF16Text.digest("I will send the 👋"), "6f7cfaf82e767b2e")
        // The same string measured by caret.context.utf16_length.
        XCTAssertEqual(UTF16Text.length("I will send the 👋"), 18)
    }

    func testAnAvailableClipboardCarriesTextAndATimestamp() throws {
        let clipboard = try encoded(
            ClipboardContext(available: true, text: "copied", capturedAt: Date(timeIntervalSince1970: 1_790_000_000))
        )
        XCTAssertEqual(clipboard["available"] as? Bool, true)
        XCTAssertEqual(clipboard["text"] as? String, "copied")
        XCTAssertNotNil(clipboard["captured_at"] as? String)
    }

    func testAcceptParamsUseTheDocumentedNames() async throws {
        let transport = FakeTransport()
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        let task = Task { try await client.accept(proposalID: "p1", revision: 7, target: Fixtures.target) }
        guard let id = transport.awaitRequest() else { return XCTFail("no request was written") }
        let sent = try XCTUnwrap(transport.sentObject(at: 0))
        let params = try XCTUnwrap(sent["params"] as? [String: Any])
        XCTAssertEqual(Set(params.keys), ["proposal_id", "revision", "target"])
        XCTAssertEqual(params["proposal_id"] as? String, "p1")
        XCTAssertEqual(params["revision"] as? Int, 7)

        transport.emit(line: #"{"id":\#(id),"ok":false,"error":{"code":"acceptance_rejected","message":"stale"}}"#)
        _ = try? await task.value
    }

    func testDismissParamsUseTheDocumentedName() async throws {
        let transport = FakeTransport()
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        let task = Task { try await client.dismiss(proposalID: "p1") }
        guard let id = transport.awaitRequest() else { return XCTFail("no request was written") }
        let params = try XCTUnwrap(transport.sentObject(at: 0)?["params"] as? [String: Any])
        XCTAssertEqual(params["proposal_id"] as? String, "p1")

        transport.emit(line: #"{"id":\#(id),"ok":true,"result":{"dismissed":true}}"#)
        let dismissed = try await task.value
        XCTAssertTrue(dismissed)
    }
}
