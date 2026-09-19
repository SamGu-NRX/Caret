import XCTest
#if SWIFT_PACKAGE
@testable import Caret
#endif

final class TypingPrefixLogicTests: XCTestCase {
    func testPrefersCapturedWhenLongerAndAxIsPrefix() {
        let result = TypingPrefixLogic.effectivePrefix(
            axPrefix: "Hi, my",
            capturedPrefix: "Hi, my name is"
        )
        XCTAssertEqual(result, "Hi, my name is")
    }

    func testUsesAxWhenLonger() {
        let result = TypingPrefixLogic.effectivePrefix(
            axPrefix: "please pull",
            capturedPrefix: "please"
        )
        XCTAssertEqual(result, "please pull")
    }

    func testCapturedWhenAxEmpty() {
        XCTAssertEqual(
            TypingPrefixLogic.effectivePrefix(axPrefix: nil, capturedPrefix: "hello"),
            "hello"
        )
    }
}

final class TabCompletionsPatternsTests: XCTestCase {
    private let instructions = """
    Expand the selection.

    - please pull github and rebase and push to github
    - Hi, my name is Teddy
    """

    func testMatchesBulletOnCurrentWordAfterOtherText() {
        let suffix = TabCompletionsPatterns.completionSuffix(
            prefix: "draft email:\nplease",
            instructions: instructions
        )
        XCTAssertTrue(suffix.hasPrefix(" pull github"))
    }

    func testFiveCharactersOnTokenIsEnough() {
        XCTAssertTrue(TabCompletionsPatterns.meetsMinimumTyping("xx please"))
        let match = TabCompletionsPatterns.completionMatch(
            fullPrefix: "notes please",
            instructions: instructions
        )
        XCTAssertNotNil(match)
        XCTAssertEqual(match?.token, "please")
    }
}
