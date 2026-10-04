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

    /// A press shrinks a row button only while Reduce Motion is off; the Carrot fill shows it either way.
    func testAPressDoesNotScaleUnderReduceMotion() {
        XCTAssertEqual(RowButtonStyle.pressScale(pressed: true, reduceMotion: false), 0.97)
        XCTAssertEqual(RowButtonStyle.pressScale(pressed: true, reduceMotion: true), 1)
        XCTAssertEqual(RowButtonStyle.pressScale(pressed: false, reduceMotion: false), 1)
    }

    /// Every sentence must be true today: values do go to the cloud model when Caret works out a
    /// fill, so the window may not say everything stays on this Mac.
    func testTheSubtitleSaysWhereValuesGo() {
        XCTAssertEqual(MemoryView.subtitle, "Saved on this Mac. When Caret works out what to fill, the values it might use go to its cloud model.")
        XCTAssertFalse(MemoryView.subtitle.contains("stays on this Mac"))
    }

    /// A11's render cut "Sending, deleting, money and passwords never go past Ask first." off at
    /// the window's bottom. The footer's whole text must sit inside the window, in both
    /// appearances, and the table above it must fit without scrolling for the gallery's entries.
    func testThePermissionsFooterSitsInsideTheWindow() throws {
        for dark in [false, true] {
            let probe = LayoutProbe()
            let view = MemoryView(state: Gallery.memoryState(), tab: .permissions, character: .pebble, animated: false, now: Gallery.memoryNow)
                .environment(\.layoutProbe, probe)
            XCTAssertNotNil(Gallery.png(view, dark: dark))
            let window = CGRect(origin: .zero, size: MemoryView.size)
            let footer = try XCTUnwrap(probe.frame("footer"), "the permissions tab draws its footer")
            XCTAssertTrue(window.contains(footer), "footer \(footer) inside \(window), dark \(dark)")
            XCTAssertGreaterThan(footer.height, 12, "the line is drawn, not squeezed to nothing")
            let table = try XCTUnwrap(probe.frame("table"))
            let scroll = try XCTUnwrap(probe.frame("scroll"))
            XCTAssertLessThanOrEqual(table.maxY, scroll.maxY, "the table fits above the footer without scrolling, dark \(dark)")
            XCTAssertLessThanOrEqual(scroll.maxY, footer.minY + 0.5, "the footer is below the scroll, never over it")
        }
        let memoryTab = LayoutProbe()
        _ = Gallery.png(MemoryView(state: Gallery.memoryState(), tab: .memory, character: .pebble, animated: false, now: Gallery.memoryNow)
            .environment(\.layoutProbe, memoryTab), dark: false)
        XCTAssertNil(memoryTab.frame("footer"), "the memory tab has no permissions footer")
    }

    func testWithoutTestHooksTheSocketOnlyReads() {
        let (c, sent) = controller(testHooks: false)
        let before = sent().count
        XCTAssertTrue(c.command(["memory", "pause", "about-1"]).contains("test hooks"))
        XCTAssertEqual(sent().count, before)
    }
}
