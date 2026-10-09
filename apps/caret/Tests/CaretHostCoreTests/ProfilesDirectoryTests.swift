import XCTest
@testable import CaretHostCore

/// A run with its own --home wrote the engine's token profiles into the user's Library (EngineLoader's fixed path).
final class ProfilesDirectoryTests: XCTestCase {
    func testAnOverriddenHomeKeepsItsProfilesInside() throws {
        let home = try CaretHome.resolve(override: "/tmp/h13home/", userHome: "/Users/someone")
        XCTAssertEqual(home.profilesDirectory(userHome: "/Users/someone"), "/tmp/h13home/Profiles")
    }

    func testTheUsersOwnCaretKeepsTheFolderItHasAlwaysUsed() throws {
        let home = try CaretHome.resolve(override: nil, userHome: "/Users/someone/")
        XCTAssertEqual(home.profilesDirectory(userHome: "/Users/someone/"), "/Users/someone/Library/Application Support/Caret/v2-host/Profiles")
    }
}
