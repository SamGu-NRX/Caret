import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// H10: grounded fill in a browser's page. The lines are the helper's golden ones
/// (helper/fixtures/golden/page-field.ndjson, read by path): a page proposal, the page field the
/// helper says has focus, the one-field fill the host asks for, its run and its undo.
final class PageFillTests: XCTestCase {
    private static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("helper/fixtures/golden/page-field.ndjson")

    private static func lines() throws -> [Data] {
        try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func inbound(_ i: Int) throws -> HelperInbound { try HelperInbound.decode(try lines()[i]) }

    private static func proposal() throws -> FillProposal {
        guard case .fillProposal(let p) = try inbound(0) else { throw Unexpected("line 1 is not a fillProposal") }
        return p
    }

    private static func field(_ i: Int = 1) throws -> PageField {
        guard case .pageField(let f) = try inbound(i) else { throw Unexpected("line \(i + 1) is not a pageField") }
        return f
    }

    private static func progress(_ i: Int) throws -> TaskProgress {
        guard case .taskProgress(let p) = try inbound(i) else { throw Unexpected("line \(i + 1) is not a taskProgress") }
        return p
    }

    static let chrome: Int32 = 4100
    static let first = "f0/form[apply]/text:first name~0"
    static let email = "f0/form[apply]/email:email~0"

    /// Chrome in front, its page's First name focused as the helper says, and the page's proposal held.
    private func rig(focus: PageField? = nil, bundle: String = "com.google.Chrome") throws -> FillRig {
        let rig = FillRig()
        rig.world.bundles[Self.chrome] = bundle
        rig.world.frontmostPID = Self.chrome
        rig.world.pages[Self.chrome] = try focus ?? Self.field()
        rig.propose(try Self.proposal())
        return rig
    }

    func testTheGoldenLinesDecodeAndWriteBackByteForByte() throws {
        let lines = try Self.lines()
        let f = try Self.field()
        XCTAssertEqual(f.key, Self.first)
        XCTAssertEqual(f.frame, Frame(x: 136, y: 213, width: 300, height: 24))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: try JSONEncoder().encode(f)) as? NSDictionary, try JSONSerialization.jsonObject(with: lines[1]) as? NSDictionary)
        XCTAssertNil(try Self.field(7).key)
        let request = try JSONDecoder().decode(FillAllRequest.self, from: lines[2])
        XCTAssertEqual(request.fieldKey, Self.first)
        XCTAssertEqual(request.taskID, try Self.progress(3).taskId, "the host names the task by the helper's rule")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: try JSONEncoder().encode(request)) as? NSDictionary, try JSONSerialization.jsonObject(with: lines[2]) as? NSDictionary)
        XCTAssertThrowsError(try JSONDecoder().decode(FillAllRequest.self, from: Data(#"{"type":"fillAll","v":1,"proposalId":"p","at":1,"fieldKey":""}"#.utf8)))
    }

    /// Q2's VM run: every page proposal was dropped as notAllowed, because the host parsed a pid out
    /// of its `page:` window id. The proposal's own pid, a running Chromium browser, is taken.
    func testAPageProposalIsOfferedAtTheFieldTheHelperSaysHasFocus() throws {
        let rig = try rig()
        XCTAssertNil(rig.machine.status.lastSkip)
        XCTAssertEqual(rig.draws.last?.value, "Robin")
        XCTAssertEqual(rig.draws.last?.field, CGRect(x: 136, y: 213, width: 300, height: 24), "drawn where the page engine puts the field on screen")
        XCTAssertEqual(rig.draws.last?.pid, Self.chrome)
        XCTAssertEqual(rig.draws.last?.caption, "from TextEdit, Robin's details.txt")
        XCTAssertEqual(rig.world.fieldReads, [], "no Accessibility read of a page field")
    }

    /// A proposal names its form's process: a page's must be a running browser whose bundle id is the
    /// proposal's, a reader window's must agree with its id, and any other id is refused, each by name
    /// in the log and the debug state.
    func testAProposalWithoutAProcessTheHostCanCheckIsRefusedWithItsReason() throws {
        let rig = try rig(bundle: "com.apple.TextEdit")
        XCTAssertTrue(rig.draws.isEmpty)
        XCTAssertEqual(rig.machine.status.lastSkip, "refused.pageAppMismatch")
        XCTAssertTrue(rig.takeLog().contains { $0.hasPrefix("log fill: proposal fill-9 for window page:eng7:12 (pid 4100, com.google.Chrome) refused: pageAppMismatch") })

        var p = try Self.proposal()
        let running: (Int32) -> String? = { _ in "com.google.Chrome" }
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: running), .process(4100))
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: { _ in nil }), .refused("pageAppGone"))
        p.bundleId = "com.apple.Notes"
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: { _ in "com.apple.Notes" }), .refused("pageNotBrowser"))
        p = try Self.proposal()
        p.windowId = "5150-1"
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: running), .refused("pidMismatch"))
        p.pid = 5150
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: running), .process(5150))
        p.windowId = "window-7"
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: running), .refused("unknownWindowID"))
        p.pid = 0
        XCTAssertEqual(FillSelection.formProcess(p, runningBundleID: running), .refused("noProcess"))
        XCTAssertTrue(ChromiumBrowsers.contains("com.google.Chrome.canary"))
        XCTAssertFalse(ChromiumBrowsers.contains("com.google.Chromeish"))
    }

    /// The field is matched by the page engine's focus, by key: focus moving to Email moves the offer
    /// there, and focus leaving every field takes it down.
    func testTheFocusedPageFieldIsMatchedFromThePageEnginesFocus() throws {
        let rig = try rig()
        var f = try Self.field()
        f.key = Self.email
        f.frame = Frame(x: 136, y: 253, width: 300, height: 24)
        rig.world.pages[Self.chrome] = f
        rig.machine.pageFieldChanged(pid: Self.chrome, at: 9)
        XCTAssertEqual(rig.draws.last?.value, "robin@example.test")
        XCTAssertEqual(rig.draws.last?.field, CGRect(x: 136, y: 253, width: 300, height: 24))
        // A scroll: the same field, drawn again where it is now.
        f.frame = Frame(x: 136, y: 223, width: 300, height: 24)
        rig.world.pages[Self.chrome] = f
        rig.machine.pageFieldChanged(pid: Self.chrome, at: 10)
        XCTAssertEqual(rig.draws.last?.field, CGRect(x: 136, y: 223, width: 300, height: 24))
        rig.world.pages[Self.chrome] = try Self.field(7)
        rig.machine.pageFieldChanged(pid: Self.chrome, at: 11)
        XCTAssertNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.machine.status.lastSkip, "pageNoFocus")
        // A field the page says holds text is not offered into.
        f.empty = false
        rig.world.pages[Self.chrome] = f
        rig.machine.pageFieldChanged(pid: Self.chrome, at: 12)
        XCTAssertNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.machine.status.lastSkip, "fieldNotEmpty")
    }

    /// Tab on a page field's offer types nothing: the helper writes the field, and its run's end is
    /// the toast a Tab's write gets, whose ⌘Z asks the helper to undo that run.
    func testTabOnAPageFieldAsksTheHelperToWriteItAndItsUndoGoesThere() throws {
        let rig = try rig()
        rig.takeLog()
        rig.press(KeyStroke.tab(to: Self.chrome))
        XCTAssertNil(rig.inserting, "the host writes no page field")
        XCTAssertEqual(rig.takeLog(), ["fillField fill-9 \(Self.first)", "working"])
        let task = FillAllRequest.fieldTask(proposalId: "fill-9", fieldKey: Self.first)
        XCTAssertTrue(rig.machine.ownsTask(task))
        rig.machine.taskProgress(try Self.progress(3))
        XCTAssertEqual(rig.takeLog(), [])
        rig.machine.taskProgress(try Self.progress(4))
        XCTAssertEqual(rig.takeLog(), ["toast done Filled 1 field from TextEdit ⌘Z", "toast slot"])
        XCTAssertEqual(rig.sent.last?.outcome, .inserted)
        XCTAssertEqual(rig.sent.last?.fieldKey, Self.first)
        rig.press(Fx.cmdZ(Self.chrome))
        XCTAssertEqual(rig.takeLog(), ["undoTask \(task)"])
        rig.machine.taskProgress(try Self.progress(6))
        XCTAssertEqual(rig.takeLog(), ["toast undone Cleared 1 field"])
        XCTAssertEqual(rig.sent.last?.outcome, .undone)
        XCTAssertFalse(rig.machine.ownsTask(task))
    }

    /// ⌘1 on a page's slip fills the form through the helper (D2-04), and its result now gets a toast
    /// with ⌘Z for the whole run.
    func testCommandOneOnAPageFillsTheFormAndItsToastUndoesTheRun() throws {
        let rig = try rig()
        XCTAssertEqual(rig.draws.last?.fillAll, true)
        rig.takeLog()
        rig.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.chrome))
        XCTAssertEqual(rig.takeLog(), ["fillAll fill-9", "hide offer"])
        let done = try JSONDecoder().decode(TaskProgress.self, from: Data(#"{"type":"taskProgress","v":1,"at":2,"taskId":"fill-9","planId":"fill-9","step":null,"steps":2,"says":null,"detail":null,"phase":"done","written":2}"#.utf8))
        rig.machine.taskProgress(done)
        XCTAssertEqual(rig.takeLog(), ["toast done Filled 2 fields from TextEdit ⌘Z", "toast slot"])
        XCTAssertTrue(rig.sent.isEmpty, "⌘1's run is the helper's task, never reported per field")
        rig.press(Fx.cmdZ(Self.chrome))
        XCTAssertEqual(rig.takeLog(), ["undoTask fill-9"])
    }

    /// A refused or stopped run says nothing was filled, and the value is not offered again there.
    func testAStoppedPageFillSaysWhyAndIsNotOfferedAgain() throws {
        let rig = try rig()
        rig.press(KeyStroke.tab(to: Self.chrome))
        rig.takeLog()
        let task = FillAllRequest.fieldTask(proposalId: "fill-9", fieldKey: Self.first)
        let stopped = try JSONDecoder().decode(TaskProgress.self, from: Data(#"{"type":"taskProgress","v":1,"at":2,"taskId":"\#(task)","planId":"\#(task)","step":null,"steps":0,"says":null,"detail":"no such fill proposal, or it expired","phase":"stopped","stopReason":"refused"}"#.utf8))
        rig.machine.taskProgress(stopped)
        XCTAssertEqual(rig.takeLog(), ["toast error Nothing was filled."])
        rig.machine.pageFieldChanged(pid: Self.chrome, at: 20)
        XCTAssertEqual(rig.machine.status.lastSkip, "suppressed")
    }
}
