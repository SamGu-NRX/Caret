import AppCompatibility
import AutocompleteCore
import XCTest
@testable import CaretHost

/// Bug 6 (A18): the model sees the text after the caret, so a completion can be made to fit it.
@MainActor
final class GhostPromptTests: XCTestCase {
    func testProductionWritingMemoryRejectsSecrets() {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        engine.recordWriting("password=bad", appBundleIdentifier: "com.apple.TextEdit", secure: false)
        engine.recordWriting("ordinary note", appBundleIdentifier: "com.apple.TextEdit", secure: false)
        let context = TextFieldContext(
            beforeCursor: "Start ", afterCursor: "", geometry: TextFieldGeometry(isAtEndOfLine: true),
            target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"), detectedLanguage: "en"
        )
        let prompt = engine.request(for: context).prompt
        XCTAssertFalse(prompt.contains("password=bad"))
        XCTAssertTrue(prompt.contains("ordinary note"))
    }

    func testExcludedAppsCannotRecordWritingMemory() {
        let policy = TargetPolicy(allowedBundleIDs: nil, allowedPIDs: nil)
        XCTAssertFalse(policy.allows(pid: 42, bundleID: "com.1password.1password"))
    }

    func testTheMidSentencePromptHoldsTheTextAfterTheCaret() {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        let context = TextFieldContext(
            beforeCursor: "The intro and examples in section two ", afterCursor: "feel a bit thin.",
            geometry: TextFieldGeometry(isAtEndOfLine: false),
            target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"), detectedLanguage: "en"
        )
        let prompt = engine.request(for: context).prompt
        XCTAssertTrue(prompt.contains("[Text after cursor]\nfeel a bit thin."), prompt)
        XCTAssertTrue(prompt.hasSuffix("examples in section two"), "the text before the caret ends the prompt, trimmed")
    }
}
