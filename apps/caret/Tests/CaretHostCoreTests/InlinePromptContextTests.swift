import XCTest
@testable import CaretHostCore

final class InlinePromptContextTests: XCTestCase {
    private struct Detector: InlineSecretDetecting {
        let secret: String
        func containsSecret(_ text: String) -> Bool { text.contains(secret) }
    }

    func testAbsentContextIsEmptyAndPresentSectionsAreRepresented() {
        XCTAssertFalse(InlinePromptContext().hasPromptContext)
        let context = InlinePromptContext(screenText: "Reply above", previousUserInputs: ["Short note"], pasteboardText: "Copied")
        XCTAssertTrue(context.hasPromptContext)
        XCTAssertEqual(context.screenText, "Reply above")
    }

    func testWritingMemoryIsPerAppSecretFreeAndExpires() {
        var memory = InlineWritingMemory()
        let now = Date(timeIntervalSince1970: 1000)
        let detector = Detector(secret: "password")
        memory.record("safe", appBundleIdentifier: "mail", at: now, secure: false, detector: detector)
        memory.record("password=bad", appBundleIdentifier: "mail", at: now, secure: false, detector: detector)
        memory.record("secure", appBundleIdentifier: "mail", at: now, secure: true, detector: detector)
        XCTAssertEqual(memory.samples(for: "mail", at: now), ["safe"])
        XCTAssertTrue(memory.samples(for: "notes", at: now).isEmpty)
        XCTAssertTrue(memory.samples(for: "mail", at: now.addingTimeInterval(InlineWritingMemory.retention + 1)).isEmpty)
    }

    func testPasteboardPolicyRejectsOptOutMarkersBudgetAndSecrets() {
        let policy = InlinePasteboardPolicy()
        let detector = Detector(secret: "token")
        XCTAssertNil(policy.acceptedText(enabled: false, plainText: "x", types: [], detector: detector, tokenCount: { _ in 1 }))
        XCTAssertNil(policy.acceptedText(enabled: true, plainText: "x", types: [InlinePasteboardPolicy.concealed], detector: detector, tokenCount: { _ in 1 }))
        XCTAssertNil(policy.acceptedText(enabled: true, plainText: "x", types: [], detector: detector, tokenCount: { _ in InlinePromptContext.clipboardTokenBudget + 1 }))
        XCTAssertNil(policy.acceptedText(enabled: true, plainText: "token", types: [], detector: detector, tokenCount: { _ in 1 }))
        XCTAssertEqual(policy.acceptedText(enabled: true, plainText: "safe", types: [], detector: detector, tokenCount: { _ in 1 }), "safe")
    }
}
