import CaretHostCore
import XCTest
@testable import CaretHost

/// The "Caret is on" step's rows say what is true of this build (merge of v2/access into v2/next).
final class OnboardingOnCopyTests: XCTestCase {
    func testNextWordsNamesTheAppsFound() {
        XCTAssertEqual(OnboardingCopy.On.nextWords(HelloApps.list([HelloApp(bundleId: "com.apple.mail", name: "Mail"), HelloApp(bundleId: "com.apple.Notes", name: "Notes")])),
                       "As you type, in Mail and Notes. Tab takes them.")
    }

    func testNextWordsWithNoAppFoundNamesNone() {
        XCTAssertEqual(OnboardingCopy.On.nextWords(HelloApps.list([])), "As you type, in any app. Tab takes them.")
    }

    func testFixesRowFollowsWhereFixesRun() {
        XCTAssertEqual(OnboardingCopy.On.fixesState(webPages: true), "On in Mac apps\nand web pages")
        XCTAssertEqual(OnboardingCopy.On.fixesState(webPages: false), "On in Mac apps")
        XCTAssertFalse(OnboardingCopy.On.fixesState(webPages: false).contains("soon"))
    }
}
