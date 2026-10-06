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

    /// M1: noticed facts, an open Not right, a file in Caret's editor, a save conflict, a file's problems.
    func testTheMarkdownMemoryStatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.knows())
    }

    final class RecordingWorkspace: MemoryWorkspace {
        var revealed: [String] = []
        var opened: [String] = []
        func reveal(path: String) { revealed.append(path) }
        func openInEditor(path: String) { opened.append(path) }
        func editorName(forPath path: String) -> String? { "TextEdit" }
    }

    /// A controller with the gallery's noticed entries listed and its three files listed.
    private func m1Controller() -> (MemoryController, RecordingWorkspace, () -> [HelperMemory.Request], () -> [MemoryDocumentRequest], () -> [MemoryNotRight]) {
        let c = MemoryController(testHooks: true, clock: Gallery.StillClock())
        let workspace = RecordingWorkspace()
        c.workspace = workspace
        var sent: [HelperMemory.Request] = []
        var docs: [MemoryDocumentRequest] = []
        var wrong: [MemoryNotRight] = []
        c.send = { sent.append($0); return true }
        c.sendDocuments = { docs.append($0); return true }
        c.sendNotRight = { wrong.append($0); return true }
        c.linkChanged(true)
        c.receive(HelperMemory.Reply(requestId: sent.last!.requestId, error: nil, entries: Gallery.noticedEntries()))
        c.receive(MemoryDocumentReply(requestId: docs.last!.requestId, error: nil, conflict: nil, folder: Gallery.memoryFolder, documents: [
            Gallery.memoryDocument("about-me", revision: "sha256:aa01"), Gallery.memoryDocument("people", revision: "sha256:bb02"),
            Gallery.memoryDocument("preferences", revision: nil),
        ], text: nil))
        return (c, workspace, { sent }, { docs }, { wrong })
    }

    /// Show in Finder selects the section's file, or the folder while the file does not exist yet.
    func testShowInFinderSelectsTheFileOrItsFolder() {
        let (c, workspace, _, _, _) = m1Controller()
        c.perform(.showInFinder("about-me"))
        c.perform(.showInFinder("preferences"))
        XCTAssertEqual(workspace.revealed, ["\(Gallery.memoryFolder)/about-me.md", Gallery.memoryFolder])
    }

    /// Edit, typing, Save over the revision read, a conflict, Keep my text over the revision now, and
    /// "Open in" the user's editor: each control reaches the files.
    func testTheFileControlsReachTheFiles() {
        let (c, workspace, _, docs, _) = m1Controller()
        c.perform(.openFile("about-me"))
        XCTAssertEqual(docs().last?.op, .read(doc: "about-me"))
        c.receive(MemoryDocumentReply(requestId: docs().last!.requestId, error: nil, conflict: nil, folder: Gallery.memoryFolder,
                                      documents: [Gallery.memoryDocument("about-me", revision: "sha256:aa01")], text: Gallery.aboutText))
        c.perform(.fileText(Gallery.aboutText + "\n"))
        c.perform(.saveFile)
        XCTAssertEqual(docs().last?.op, .save(doc: "about-me", base: "sha256:aa01", text: Gallery.aboutText + "\n"))
        c.receive(MemoryDocumentReply(requestId: docs().last!.requestId, error: "about-me.md changed outside Caret", conflict: .some("sha256:aa02"),
                                      folder: Gallery.memoryFolder, documents: [], text: nil))
        c.perform(.keepMyText)
        XCTAssertEqual(docs().last?.op, .save(doc: "about-me", base: "sha256:aa02", text: Gallery.aboutText + "\n"))
        c.perform(.openInEditor)
        XCTAssertEqual(workspace.opened, ["\(Gallery.memoryFolder)/about-me.md"])
    }

    /// Keep and Not right on a noticed row: Keep sends the fact's own values as an edit; Not right
    /// opens the row's field, and Save sends what was typed as memoryNotRight.
    func testTheNoticedRowsControlsReachTheBook() {
        let (c, _, sent, _, wrong) = m1Controller()
        c.perform(.control("people-2", .keep, typed: false))
        XCTAssertEqual(sent().last?.op, .edit)
        XCTAssertEqual(sent().last?.fields, ["alias": .text("Sam"), "name": .text("Sam Okafor")])
        c.perform(.control("about-2", .notRight, typed: false))
        XCTAssertEqual(c.book.state.correcting?.entryId, "about-2")
        c.perform(.correction("5th floor, Northline"))
        c.perform(.sendCorrection(forget: false))
        XCTAssertEqual(wrong().last?.correction, "5th floor, Northline")
        XCTAssertNil(wrong().last?.offerKey, "from the window, not an offer")
    }

    /// The headless walk's commands: the same calls the window makes, with what was sent.
    func testTheSocketDrivesTheFilesAndTheNoticedFacts() throws {
        let (c, _, _, docs, wrong) = m1Controller()
        XCTAssertTrue(c.command(["memory", "open", "people"]).contains("\"sent\":true"))
        c.receive(MemoryDocumentReply(requestId: docs().last!.requestId, error: nil, conflict: nil, folder: Gallery.memoryFolder,
                                      documents: [Gallery.memoryDocument("people", revision: "sha256:bb02")], text: "# People\n"))
        _ = c.command(["memory", "text", "# People\\n\\n## Sam"])
        XCTAssertEqual(c.files.state.editor?.text, "# People\n\n## Sam")
        XCTAssertTrue(c.command(["memory", "savefile"]).contains("\"sent\":true"))
        _ = c.command(["memory", "notright", "about-2"])
        XCTAssertTrue(c.command(["memory", "forgetnoticed"]).contains("\"sent\":true"))
        XCTAssertNil(wrong().last?.correction)
        let info = try JSONDecoder().decode(MemoryController.DebugInfo.self, from: Data(c.command(["memory"]).utf8))
        XCTAssertEqual(info.files.documents["people"], "sha256:bb02")
        XCTAssertTrue(info.files.sent.contains("save:people:sha256:bb02"))
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
    /// the window's bottom. The footer's whole text must sit inside the window, in both appearances,
    /// under the list. v3's window is 600 tall (A11's was 780), so the seven rules scroll above a
    /// footer that stays put.
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
            XCTAssertNotNil(probe.frame("table"), "the rules are drawn")
            let scroll = try XCTUnwrap(probe.frame("scroll"))
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
