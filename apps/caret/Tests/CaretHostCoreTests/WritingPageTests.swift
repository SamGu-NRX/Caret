import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The Writing tab's state: which entries show, what can be added, and the count under About you.
final class WritingPageTests: XCTestCase {
    func testEntriesListSitesThenAppsByName() {
        var i = PersonalInstructions()
        i.setApp("com.tinyspeck.slackmacgap", "Casual.")
        i.setApp("com.apple.mail", "Formal.")
        i.setSite("https://mail.google.com", "Email.")
        let names = ["com.tinyspeck.slackmacgap": "Slack", "com.apple.mail": "Mail"]
        let e = WritingPage.entries(i, name: { names[$0] ?? $0 })
        XCTAssertEqual(e.map(\.name), ["mail.google.com", "Mail", "Slack"])
        XCTAssertEqual(e.map(\.kind), [.site, .app, .app])
    }

    func testOnlyTheAppAndPageYouWereInWithoutAnEntryCanBeAdded() {
        var s = WritingPage.State()
        s.hereApp = WritingPage.App(bundleID: "com.apple.mail", name: "Mail")
        s.herePage = "https://mail.google.com"
        XCTAssertEqual(s.addable.map(\.name), ["mail.google.com", "Mail"])
        s.entries = [WritingPage.Entry(kind: .app, key: "com.apple.mail", name: "Mail", text: "x")]
        XCTAssertEqual(s.addable.map(\.name), ["mail.google.com"])
    }

    func testTheCountSaysHowMuchReachesTheModel() {
        XCTAssertEqual(WritingPage.count("  I write plainly. "), "17 of 1,536 characters")
        XCTAssertEqual(WritingPage.count(String(repeating: "a", count: 2000)), "The model reads the first 1,536 characters; the rest is kept here.")
    }
}
