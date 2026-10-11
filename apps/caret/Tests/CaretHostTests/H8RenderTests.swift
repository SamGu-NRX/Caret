import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H8's states against their references, light and dark: the event card naming where Tab puts the
/// event, and "Calendar for new events" in What Caret knows before access, with the default, with a
/// chosen calendar, and with access refused.
@MainActor
final class H8RenderTests: XCTestCase {
    func testH8StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h8())
    }
}
