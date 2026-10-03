import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// The memory window rendered off screen in light and dark against committed references, and its
/// controller driven the way its window and the debug socket drive it, with a recorded socket.
@MainActor
final class MemoryHostTests: XCTestCase {
    func testEveryMemoryWindowStateMatchesItsReference() throws {
        try SnapshotTests.check(Gallery.memory())
    }

    private func controller(testHooks: Bool = true) -> (MemoryController, () -> [HelperMemory.Request]) {
        let c = MemoryController(testHooks: testHooks, clock: Gallery.StillClock())
        var sent: [HelperMemory.Request] = []
        c.send = { sent.append($0); return true }
        c.linkChanged(true)
        c.receive(HelperMemory.Reply(requestId: sent.last!.requestId, error: nil, entries: Gallery.memoryEntries()))
        return (c, { sent })
    }

    func testTheWindowsControlsReachTheBook() {
        let (c, sent) = controller()
        c.perform(.control("about-1", .edit, typed: false))
        c.perform(.draft("value", "Marcus Lowe, Operations"))
        c.perform(.save)
        XCTAssertEqual(sent().last?.op, .edit)
        c.perform(.control("routine-1", .forget, typed: false))
        XCTAssertEqual(c.book.state.confirmingForget, "routine-1")
        c.perform(.tab(.permissions))
        XCTAssertNil(c.book.state.confirmingForget, "switching tabs drops a pending Forget")
        c.perform(.setRule(.outbound, .act))
        XCTAssertNotEqual(sent().last?.fields?["rule"], .text("act"), "never sent")
    }

    func testTheSocketDrivesTheSameBookAndReportsWhatWasSent() throws {
        let (c, sent) = controller()
        XCTAssertTrue(c.command(["memory", "rule", "outbound", "act"]).contains("\"sent\":false"))
        XCTAssertTrue(c.command(["memory", "rule", "writeHere", "act"]).contains("\"sent\":true"))
        XCTAssertEqual(sent().last?.fields, ["rule": .text("act")])
        _ = c.command(["memory", "edit", "about-1"])
        _ = c.command(["memory", "draft", "value", "Marcus", "Lowe,", "Operations"])
        XCTAssertEqual(c.book.state.editor?.fields.last?.text, "Marcus Lowe, Operations", "the text keeps its words")
        _ = c.command(["memory", "remember", "Name", "Dana", "Whitfield"])
        XCTAssertEqual(sent().last?.fields?["value"], .text("Dana Whitfield"))
        let read = c.command(["memory"])
        let info = try JSONDecoder().decode(MemoryController.DebugInfo.self, from: Data(read.utf8))
        XCTAssertEqual(info.book.entries.count, 12)
        XCTAssertFalse(info.windowShown, "the socket never puts the window up")
    }

    func testWithoutTestHooksTheSocketOnlyReads() {
        let (c, sent) = controller(testHooks: false)
        let before = sent().count
        XCTAssertTrue(c.command(["memory", "pause", "about-1"]).contains("test hooks"))
        XCTAssertEqual(sent().count, before)
    }
}
