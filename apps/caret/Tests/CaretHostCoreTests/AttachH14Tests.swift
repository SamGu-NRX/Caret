@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// H14: attach rows in the page task panel. The goldens P3 and H14 wrote (goal-files.ndjson, saved-files.ndjson) round
/// trip; Tab alone never confirms a file; ⌘2, ⌘3 or a click confirms a saved file or opens the chooser; the file goes
/// with Tab as `confirmedFile` with its step and path, one per Tab; a preview that only attaches waits for a file; a
/// file the helper refuses gives the preview back; and the hello names goalFiles only when both paths are wired.
final class AttachH14Tests: XCTestCase {
    typealias Rig = PageTaskTests.Rig
    static let pid = PageTaskTests.chromePid
    static let resume = AttachFile(path: "/private/tmp/caret-fixture/Robin Vale Resume.pdf", name: "Robin Vale Resume.pdf", edited: 1_791_280_800_000)
    static let cover = AttachFile(path: "/private/tmp/caret-fixture/Robin Vale Cover Letter.pdf", name: "Robin Vale Cover Letter.pdf", edited: nil)

    // MARK: - The goldens

    func testTheSavedFilesFixtureIsTheHelpersGoldenFile() throws {
        let repo = WireH11Tests.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let copy = try Data(contentsOf: WireH11Tests.fixtures.appendingPathComponent("saved-files.ndjson"))
        let golden = try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/saved-files.ndjson"))
        XCTAssertEqual(copy, golden)
    }

    /// Every line of goal-files.ndjson and saved-files.ndjson decodes as the host's type for it and encodes back to the
    /// same JSON: what the helper sends the host, and what the host sends the helper. Only the two lines the host
    /// writes from types of its own (its hello, the desk's planRequest) are checked another way.
    func testEveryGoalFilesLineRoundTrips() throws {
        var seen = Set<String>()
        for name in ["goal-files", "saved-files"] {
            for line in try WireH11Tests.lines(name) {
                let type = try XCTUnwrap(WireH11Tests.object(line)["type"] as? String)
                seen.insert(type)
                switch type {
                case GoalProgress.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(GoalProgress.self, from: line), line)
                case GoalAccept.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(GoalAccept.self, from: line), line)
                case FileSaveOffer.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(FileSaveOffer.self, from: line), line)
                case FileSave.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(FileSave.self, from: line), line)
                case FileSaveReply.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(FileSaveReply.self, from: line), line)
                case SavedFilesRequest.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(SavedFilesRequest.self, from: line), line)
                case SavedFilesReply.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(SavedFilesReply.self, from: line), line)
                case "hello":
                    let caps = try XCTUnwrap(WireH11Tests.object(line)["capabilities"] as? [String])
                    XCTAssertTrue(caps.contains(GoalFiles.capability))
                case PlanRequest.type: continue
                default: XCTFail("\(name): no host type for \(type)")
                }
                // And the route the host takes for it: a helper message is decoded, never left unknown.
                if case .unknown(let t) = try HelperInbound.decode(line) { XCTFail("\(name): \(t) is unknown to the host") }
            }
        }
        XCTAssertTrue(seen.isSuperset(of: [GoalAccept.type, FileSaveOffer.type, FileSave.type, FileSaveReply.type, SavedFilesRequest.type, SavedFilesReply.type]))
    }

    func testTheGoldenAcceptanceCarriesTheConfirmedFileStepAndPath() throws {
        let accepts = try WireH11Tests.lines("goal-files").filter { try WireH11Tests.object($0)["type"] as? String == GoalAccept.type }
        let decoded = try accepts.map { try JSONDecoder().decode(GoalAccept.self, from: $0) }
        XCTAssertEqual(decoded.compactMap(\.confirmedFile), [
            GoalAccept.ConfirmedFile(step: 9, path: "/private/tmp/caret-fixture/Robin Vale Resume.pdf"),
            GoalAccept.ConfirmedFile(step: 2, path: "/private/tmp/caret-fixture/Robin Vale Cover Letter.pdf"),
        ])
        // The last acceptance names no file: its attach row is left to the user.
        XCTAssertNil(decoded.last?.confirmedFile)
    }

    func testAConfirmedFileNeedsAnAbsolutePath() throws {
        let accept = GoalAccept(goalId: "g", segment: 0, digest: String(repeating: "a", count: 64), at: 1, confirmedFile: .init(step: 1, path: "Resume.pdf"))
        XCTAssertThrowsError(try JSONDecoder().decode(GoalAccept.self, from: JSONEncoder().encode(accept)))
    }

    func testAPageFileRowNamesAnAttachStepOfTheSegment() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: try Self.goldenPreviewLine()) as? [String: Any])
        var page = try XCTUnwrap(object["page"] as? [String: Any])
        page["files"] = [["step": 0, "label": "Full name", "accept": []]]
        object["page"] = page
        XCTAssertThrowsError(try JSONDecoder().decode(GoalProgress.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    // MARK: - The hello

    func testTheHelloNamesGoalFilesOnlyWhenBothPathsAreWired() {
        let r = Rig()
        XCTAssertFalse(r.machine.filesWired)
        XCTAssertFalse(HostHello.capabilities(routing: false, goalFiles: r.machine.filesWired).contains(GoalFiles.capability))
        XCTAssertFalse(HostHello.capabilities(routing: true).contains(GoalFiles.capability))
        r.machine.canChooseFiles = true
        XCTAssertTrue(r.machine.filesWired)
        XCTAssertTrue(HostHello.capabilities(routing: false, goalFiles: r.machine.filesWired).contains(GoalFiles.capability))
    }

    // MARK: - Tab and the attach keys

    static func goldenPreviewLine() throws -> Data { try WireH11Tests.lines("saved-files")[7] }

    /// The golden page preview: a write, a file input (step 1) and a dropzone (step 2), with `edit` applied.
    static func preview(_ edit: (inout [String: Any]) throws -> Void = { _ in }) throws -> GoalProgress {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: try goldenPreviewLine()) as? [String: Any])
        try edit(&object)
        return try JSONDecoder().decode(GoalProgress.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// Step 1 offers the saved résumé instead of a chooser.
    static func savedPreview() throws -> GoalProgress {
        try preview { o in
            var steps = try XCTUnwrap(o["steps"] as? [[String: Any]])
            steps[1]["says"] = "Resume: Robin Vale Resume.pdf"
            steps[1]["file"] = ["source": "saved", "savedId": "file-1a2b3c4d", "path": resume.path, "name": resume.name, "edited": resume.edited!]
            o["steps"] = steps
        }
    }

    /// The writes taken out: a preview that only attaches.
    static func attachOnlyPreview() throws -> GoalProgress {
        try preview { o in
            var steps = try XCTUnwrap(o["steps"] as? [[String: Any]])
            steps.removeFirst()
            o["steps"] = steps
            var page = try XCTUnwrap(o["page"] as? [String: Any])
            page["rows"] = []
            o["page"] = page
        }
    }

    func cmd(_ r: Rig, _ digit: Int64) { r.press(KeyStroke(keyCode: 17 + digit, command: true, targetPID: Self.pid)) }

    func attachLine(_ r: Rig, step: Int) throws -> PageTaskPanel.Line {
        try XCTUnwrap(r.lastPanel?.sections.flatMap(\.lines).first { $0.attach?.step == step })
    }

    var choices: (Rig) -> [FileChoice] {
        { r in r.commands.compactMap { if case .chooseFile(let c) = $0 { return c } else { return nil } } }
    }

    func testTabAloneNeverConfirmsAFile() throws {
        // A saved file offered and a chooser: Tab runs the write and attaches neither.
        let r = Rig()
        r.machine.canChooseFiles = true
        XCTAssertTrue(r.machine.start(try Self.savedPreview()))
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .offered)
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
        XCTAssertNil(r.accepts[0].confirmedFile)
        XCTAssertTrue(choices(r).isEmpty)
        // After it, both attach rows are the user's.
        XCTAssertEqual(r.lastPanel?.yours.map(\.text), ["Attach 'Resume' yourself", "Attach 'Or drop your resume here' yourself", "You press Submit application."])
    }

    func testCommand2ConfirmsTheSavedFileAndTabSendsItsStepAndPath() throws {
        let r = Rig()
        r.machine.start(try Self.savedPreview())
        cmd(r, 2)
        // ⌘2 sent nothing and opened no chooser: the file waits for Tab.
        XCTAssertTrue(r.accepts.isEmpty)
        XCTAssertTrue(choices(r).isEmpty)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .confirmed)
        XCTAssertEqual(r.lastMotion, PageTaskMotion.none)
        XCTAssertTrue(r.machine.status.ownsTab)
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile, GoalAccept.ConfirmedFile(step: 1, path: Self.resume.path))
    }

    func testCommand3OpensTheChooserForTheDropzoneAndThePickGoesWithTab() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 3)
        XCTAssertEqual(choices(r).map { [$0.step: $0.label] }, [[2: "Or drop your resume here"]])
        XCTAssertEqual(choices(r).first?.accept, AcceptTypes([]))
        XCTAssertEqual(choices(r).first?.browserPid, Self.pid)
        XCTAssertTrue(r.accepts.isEmpty)
        r.machine.filePicked(token: try XCTUnwrap(choices(r).last).token, step: 2, file: Self.resume)
        XCTAssertEqual(try attachLine(r, step: 2).attach?.state, .confirmed)
        r.tab()
        // The golden's acceptance, but for its time.
        var expected = try JSONDecoder().decode(GoalAccept.self, from: WireH11Tests.lines("saved-files")[8])
        expected.at = try XCTUnwrap(r.accepts.first).at
        XCTAssertEqual(r.accepts, [expected])
    }

    func testTheChooserIsFilteredToTheControlsAcceptedTypes() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        XCTAssertEqual(choices(r).first?.accept, AcceptTypes([".pdf", ".doc", ".docx"]))
        XCTAssertEqual(choices(r).first?.accept.extensions, ["pdf", "doc", "docx"])
        XCTAssertEqual(AcceptTypes([".PDF", "application/pdf", "image/*"]), AcceptTypes([".pdf", "application/pdf", "image/*"]))
        XCTAssertEqual(AcceptTypes(["application/pdf", "image/*"]).mimeTypes, ["application/pdf", "image/*"])
    }

    func testAClickDoesWhatTheRowsKeyDoes() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.savedPreview())
        r.machine.attachRequested(step: 1)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .confirmed)
        // Clicked again, a confirmed row opens the chooser to change it.
        r.machine.attachRequested(step: 1)
        XCTAssertEqual(choices(r).map(\.step), [1])
        r.machine.chooserClosed(token: choices(r).last?.token ?? 0)
        // Closed with no file: the confirmed one stays.
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile?.path, Self.resume.path)
    }

    func testOneFileGoesWithOneTab() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.resume)
        cmd(r, 3)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 2, file: Self.cover)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .choose)
        XCTAssertEqual(try attachLine(r, step: 2).attach?.state, .confirmed)
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile, GoalAccept.ConfirmedFile(step: 2, path: Self.cover.path))
    }

    func testAPickForAnotherRowOrAfterTheTabIsDropped() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        // No chooser was opened for step 2.
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 2, file: Self.resume)
        XCTAssertEqual(try attachLine(r, step: 2).attach?.state, .choose)
        cmd(r, 2)
        r.tab()
        // Tab went out while the chooser was up: the pick changes nothing that was sent.
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.resume)
        XCTAssertNil(r.accepts.first?.confirmedFile)
        XCTAssertEqual(r.accepts.count, 1)
    }

    /// Review (H14 astra 1): a chooser opened for one preview, still open after Tab, the run and the next page, picks a
    /// file. The next page's attach row at the same step must not take it: only a pick made for that preview counts.
    func testAChooserLeftOpenNeverConfirmsAFileForALaterPreview() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        let stale = try XCTUnwrap(choices(r).last)
        r.tab()
        XCTAssertNil(r.machine.choosing)
        guard case .segment(let p) = try Self.preview().event else { return XCTFail() }
        r.machine.receive(GoalProgress(at: 1, goalId: "goal-3-a1", requestId: nil, event: .finished(.init(outcome: .handoff, verified: 1, skipped: 0, left: [], says: "Ready: 1 done. You press Submit application."))))
        var next = p
        next.reason = .nextPage
        next.replaces = "goal-3-a1"
        next.digest = String(repeating: "c", count: 64)
        r.machine.receive(GoalProgress(at: 2, goalId: "goal-3-a1~1", requestId: nil, event: .segment(next)))
        XCTAssertEqual(r.machine.status.page, 2)
        r.machine.filePicked(token: stale.token, step: stale.step, file: Self.resume)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .choose)
        r.tab()
        XCTAssertEqual(r.accepts.count, 2)
        XCTAssertNil(r.accepts[1].confirmedFile)
    }

    /// A second chooser replaces the first: the first one's answer counts for nothing, even for the same row.
    func testOnlyTheNewestChooserCounts() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        let first = try XCTUnwrap(choices(r).last)
        r.machine.attachRequested(step: 1)
        let second = try XCTUnwrap(choices(r).last)
        XCTAssertNotEqual(first.token, second.token)
        r.machine.filePicked(token: first.token, step: 1, file: Self.cover)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .choose)
        r.machine.filePicked(token: second.token, step: 1, file: Self.resume)
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile?.path, Self.resume.path)
    }

    /// prep-for-prod H14-2: only rows with a key are drawn as attach rows; a third is the user's, and no click or key
    /// opens a chooser for it.
    func testAnAttachRowPastTheKeysIsTheUsers() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview { o in
            var steps = try XCTUnwrap(o["steps"] as? [[String: Any]])
            steps.insert(["index": 3, "kind": "attach", "says": "Transcript: a file you choose", "file": ["source": "choose"]], at: 3)
            steps[4]["index"] = 4
            o["steps"] = steps
        })
        let lines = try XCTUnwrap(r.lastPanel?.sections.flatMap(\.lines))
        XCTAssertEqual(lines.compactMap(\.attach?.step), [1, 2])
        XCTAssertTrue(r.lastPanel?.yours.map(\.text).contains("Attach 'Transcript' yourself") == true)
        r.machine.attachRequested(step: 3)
        XCTAssertTrue(choices(r).isEmpty)
    }

    /// prep-for-prod H14-3: what Tab needs, or why a file was not taken, is said when it appears.
    func testTheRowsNoteIsAnnounced() throws {
        let r = Rig()
        r.machine.start(try Self.attachOnlyPreview())
        let before = try XCTUnwrap(r.lastPanel?.announcement)
        r.tab()
        let after = try XCTUnwrap(r.lastPanel?.announcement)
        XCTAssertNotEqual(before, after)
        XCTAssertTrue(after.contains(PageTaskCopy.chooseFirst), after)
    }

    /// prep-for-prod H14-4: the browser coming back from Caret's open panel follows a key or a click there: drawn at once.
    func testThePanelComesBackFromTheChooserAtOnce() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        r.machine.appActivated(pid: 999)
        XCTAssertTrue(r.hidden)
        let token = try XCTUnwrap(choices(r).last).token
        r.machine.filePicked(token: token, step: 1, file: Self.resume)
        r.machine.appActivated(pid: Self.pid)
        XCTAssertEqual(r.lastMotion, PageTaskMotion.none)
        XCTAssertTrue(r.machine.status.ownsTab)
        // Another app and back, with no chooser: the panel enters as it always has.
        r.machine.appActivated(pid: 999)
        r.machine.appActivated(pid: Self.pid)
        XCTAssertEqual(r.lastMotion, .enter)
    }

    func testTheLastAcceptanceIsKeptForTheDebugSocket() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 3)
        r.machine.filePicked(token: try XCTUnwrap(choices(r).last).token, step: 2, file: Self.resume)
        r.tab()
        let info = DebugState.PageTaskInfo(status: r.machine.status, choosing: r.machine.choosing, filesWired: true, panel: nil, lastAccept: r.machine.lastAccept)
        XCTAssertEqual(info.lastAccept, "goal-3-a1:0")
        XCTAssertEqual(info.lastAcceptFileStep, 2)
        XCTAssertEqual(info.lastAcceptFileName, "Robin Vale Resume.pdf")
    }

    /// Fix-check (H14 astra 2, P2): a click on a saved file republishes the preview while its old offer is still the
    /// arbiter's. With the runtime's displacement callback wired, the task must survive and Tab send the file.
    func testAClickOnASavedFileKeepsTheTaskWhenTheOfferIsRepublished() throws {
        let r = Rig()
        r.arbiter.onDisplaced = { [unowned r] offer in r.machine.displaced(offer) }
        r.machine.start(try Self.savedPreview())
        XCTAssertTrue(r.machine.status.ownsTab)
        r.machine.attachRequested(step: 1)
        XCTAssertEqual(r.machine.status.stage, "preview")
        XCTAssertTrue(r.machine.status.ownsTab)
        XCTAssertEqual(try attachLine(r, step: 1).attach?.state, .confirmed)
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile, GoalAccept.ConfirmedFile(step: 1, path: Self.resume.path))
    }

    /// Fix-check (H14 astra 2, P3): an ending that drops an open chooser says so, so the open panel closes even while the
    /// task panel is hidden behind it.
    func testAnEndingWhileTheChooserIsUpLetsItGo() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        r.machine.appActivated(pid: 999)
        let before = r.commands.count
        r.machine.linkChanged(up: false)
        XCTAssertNil(r.machine.choosing)
        XCTAssertTrue(r.commands[before...].contains(.count("pageTask.chooserDropped")))
    }

    func testWithoutAChooserNoOpenPanelIsAskedFor() throws {
        let r = Rig()
        r.machine.start(try Self.preview())
        cmd(r, 2)
        XCTAssertTrue(choices(r).isEmpty)
        XCTAssertTrue(r.machine.status.ownsTab)
    }

    func testAPreviewThatOnlyAttachesWaitsForAFile() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.attachOnlyPreview())
        XCTAssertEqual(r.lastPanel?.title, "Attach files on this page")
        XCTAssertEqual(r.lastPanel?.hints.map(\.key), ["Esc"])
        r.tab()
        XCTAssertTrue(r.accepts.isEmpty)
        XCTAssertEqual(r.machine.status.stage, "preview")
        XCTAssertTrue(r.machine.status.ownsTab)
        XCTAssertEqual(try attachLine(r, step: 1).note, PageTaskCopy.chooseFirst)
        cmd(r, 2)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.resume)
        XCTAssertEqual(r.lastPanel?.hints.map(\.key), ["Tab", "Esc"])
        XCTAssertEqual(r.lastPanel?.hints.first?.label, "Attach")
        r.tab()
        XCTAssertEqual(r.accepts.first?.confirmedFile?.step, 1)
    }

    func testAFileTheHelperRefusesGivesThePreviewBack() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.resume)
        r.tab()
        r.machine.helperError(HelperError(at: 1, message: "goalAccept refused: Caret can't attach the file you chose (it is a link); nothing ran, so choose another and accept again"))
        XCTAssertEqual(r.machine.status.stage, "preview")
        XCTAssertTrue(r.machine.status.ownsTab)
        let line = try attachLine(r, step: 1)
        XCTAssertEqual(line.attach?.state, .choose)
        XCTAssertEqual(line.note, "Caret can't attach the file you chose (it is a link). Choose another file.")
        cmd(r, 2)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.cover)
        r.tab()
        XCTAssertEqual(r.accepts.map { $0.confirmedFile?.path }, [Self.resume.path, Self.cover.path])
    }

    func testAnyOtherRefusalStillEndsTheTask() throws {
        let r = Rig()
        r.machine.canChooseFiles = true
        r.machine.start(try Self.preview())
        cmd(r, 2)
        r.machine.filePicked(token: choices(r).last?.token ?? 0, step: 1, file: Self.resume)
        r.tab()
        r.machine.helperError(HelperError(at: 1, message: "goalAccept refused: segment 1 of goal goal-3-a1 expired before it was accepted"))
        XCTAssertEqual(r.machine.status.stage, "ended:notRun")
    }

    // MARK: - What the row says

    func testTheRowShowsTheFilesNameAndLastEditedDateWhole() throws {
        var t = try XCTUnwrap(PageTask(preview: { guard case .segment(let p) = try Self.savedPreview().event else { fatalError() }; return p }(), goalId: "goal-3-a1"))
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let thursday = Date(timeIntervalSince1970: 1_791_460_800)
        var lines = PageTaskPanel(task: t, stoppable: false, now: thursday, calendar: utc).sections[0].lines
        XCTAssertEqual(lines[1].label, "Resume")
        XCTAssertEqual(lines[1].text, "Robin Vale Resume.pdf, edited Tue")
        XCTAssertEqual(lines[1].attach, PageTaskPanel.Line.Attach(step: 1, state: .offered, key: "⌘2", action: "Attach"))
        XCTAssertEqual(lines[2].text, PageTaskCopy.choose)
        XCTAssertEqual(lines[2].attach, PageTaskPanel.Line.Attach(step: 2, state: .choose, key: "⌘3", action: nil))
        XCTAssertTrue(t.confirmSaved(step: 1))
        lines = PageTaskPanel(task: t, stoppable: false, now: thursday, calendar: utc).sections[0].lines
        XCTAssertEqual(lines[1].attach?.action, "Change")
        XCTAssertTrue(lines.allSatisfy { $0.attach == nil || $0.wraps })
        // Sent with Tab, the row keeps the whole name and date as the run marks it.
        _ = t.tab(nowMs: 1)
        let sent = try XCTUnwrap(PageTaskPanel(task: t, stoppable: false, now: thursday, calendar: utc).sections[0].lines.first { $0.label == "Resume" })
        XCTAssertEqual(sent.text, "Robin Vale Resume.pdf, edited Tue")
        XCTAssertTrue(sent.wraps)
        // A file with no date is named alone.
        XCTAssertEqual(Self.cover.says(now: thursday, calendar: utc), "Robin Vale Cover Letter.pdf")
    }

    func testVoiceOverHearsTheRowsKey() throws {
        let r = Rig()
        r.machine.start(try Self.preview())
        let said = try XCTUnwrap(r.lastPanel?.announcement)
        XCTAssertTrue(said.contains("Resume: Command 2, Choose a file…"), said)
        XCTAssertTrue(said.contains("Or drop your resume here: Command 3, Choose a file…"), said)
    }

    func testAnAttachRowWithNoFileRowTakesItsNameFromTheStep() throws {
        let p = try Self.preview { o in
            var page = try XCTUnwrap(o["page"] as? [String: Any])
            page.removeValue(forKey: "files")
            o["page"] = page
        }
        guard case .segment(let s) = p.event, let t = PageTask(preview: s, goalId: p.goalId) else { return XCTFail() }
        XCTAssertEqual(t.current.attachRows.compactMap(\.attach?.label), ["Resume", "Or drop your resume here"])
        XCTAssertEqual(t.current.attachRows.compactMap(\.attach?.accept), [[], []])
    }
}

/// H14: the line offering to keep a file the user attached: quiet (no Tab), ⌘1 saves, Esc dismisses, and each answer.
final class FileSaveTests: XCTestCase {
    static let pid = PageTaskTests.chromePid
    static let place = FileSaveMachine.Place(pid: pid, bundleId: "com.google.chrome.for.testing", windowId: "page:eng1:7")

    final class Rig {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let machine: FileSaveMachine
        var commands: [FileSaveMachine.Command] = []

        init() {
            machine = FileSaveMachine(arbiter: arbiter, clock: clock)
            machine.output = { [unowned self] in self.commands.append($0) }
        }

        var sent: [FileSave] { commands.compactMap { if case .send(let s) = $0 { return s } else { return nil } } }
        var lastText: String? {
            for c in commands.reversed() { if case .draw(let l, _, _) = c { return l.text } }
            return nil
        }
        var hidden: Bool { if case .hide = commands.last { return true } else { return false } }

        @discardableResult
        func press(_ key: KeyStroke) -> OfferArbiter.Decision {
            let d = arbiter.handleKeyDown(key, now: clock.now)
            switch d {
            case .consume(let claim): machine.claimed(claim)
            case .closeOffer(let id):
                machine.offerClosed(id)
                machine.offerChanged(.closed)
            case .pass(let reason): machine.offerChanged(reason)
            default: break
            }
            return d
        }
    }

    static func offer() throws -> FileSaveOffer {
        let line = try WireH11Tests.lines("goal-files").first { try WireH11Tests.object($0)["type"] as? String == FileSaveOffer.type }
        return try JSONDecoder().decode(FileSaveOffer.self, from: XCTUnwrap(line))
    }

    func testTheOfferShowsTheHelpersQuestionWithCommand1AndEsc() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        guard case .draw(let line, let enters, let keyed)? = r.commands.last(where: { if case .draw = $0 { return true } else { return false } }) else { return XCTFail() }
        XCTAssertEqual(line.text, "Use Robin Vale Resume.pdf for 'Resume' next time?")
        XCTAssertEqual(line.hints.map(\.key), ["⌘1", "Esc"])
        XCTAssertTrue(enters)
        XCTAssertFalse(keyed)
        XCTAssertEqual(r.machine.phase, .offered)
    }

    func testTabNeverKeepsAFile() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        let d = r.press(.tab(to: Self.pid))
        guard case .pass = d else { return XCTFail("Tab was taken: \(d)") }
        XCTAssertTrue(r.sent.isEmpty)
        XCTAssertTrue(r.hidden)
        XCTAssertEqual(r.machine.phase, FileSaveMachine.Phase.none)
    }

    func testEscDismissesIt() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        r.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.pid))
        XCTAssertTrue(r.sent.isEmpty)
        XCTAssertTrue(r.hidden)
        guard case .hide(let fade)? = r.commands.last else { return XCTFail() }
        XCTAssertEqual(fade, 0)
    }

    func testCommand1SendsTheYesAndTheReplyIsShown() throws {
        let r = Rig()
        let o = try Self.offer()
        r.machine.receive(o, place: Self.place)
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.pid))
        XCTAssertEqual(r.sent, [FileSave(requestId: "file-save-1", offerId: o.id)])
        XCTAssertEqual(r.machine.phase, .saving)
        XCTAssertEqual(r.lastText, FileSaveCopy.saving.text)
        r.machine.receive(FileSaveReply(requestId: "file-save-1", outcome: .saved, fileId: "file-1a2b3c4d", says: "Caret will offer Robin Vale Resume.pdf for 'Resume' next time."))
        XCTAssertTrue(r.commands.contains(.saved))
        XCTAssertEqual(r.lastText, "Caret will offer Robin Vale Resume.pdf for 'Resume' next time.")
        r.clock.advance(by: FileSaveMachine.replyLifetime + 0.01)
        XCTAssertTrue(r.hidden)
    }

    func testARefusalSaysWhyAndKeepsNothing() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.pid))
        r.machine.receive(FileSaveReply(requestId: "file-save-1", outcome: .refused, fileId: nil, says: "That offer to keep the file has expired, so nothing was saved."))
        XCTAssertFalse(r.commands.contains(.saved))
        XCTAssertEqual(r.lastText, "That offer to keep the file has expired, so nothing was saved.")
    }

    func testNoAnswerSaysSo() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.pid))
        r.clock.advance(by: FileSaveMachine.replyWait + 0.01)
        XCTAssertEqual(r.lastText, FileSaveCopy.unanswered.text)
        // A late answer changes nothing.
        r.machine.receive(FileSaveReply(requestId: "file-save-1", outcome: .saved, fileId: "file-1", says: "Kept."))
        XCTAssertFalse(r.commands.contains(.saved))
    }

    func testItLapsesUnanswered() throws {
        let r = Rig()
        r.machine.receive(try Self.offer(), place: Self.place)
        r.clock.advance(by: FileSaveMachine.lifetime + 0.01)
        XCTAssertTrue(r.hidden)
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.pid))
        XCTAssertTrue(r.sent.isEmpty)
    }

    func testItIsNotShownWithoutItsPagePastItsExpiryOrOverAnotherOffer() throws {
        let r = Rig()
        var o = try Self.offer()
        r.machine.receive(o, place: nil)
        XCTAssertTrue(r.commands.allSatisfy { if case .count = $0 { return true } else { return false } })
        o.expires = Int64(r.clock.now.timeIntervalSince1970 * 1000) - 1
        r.machine.receive(o, place: Self.place)
        XCTAssertEqual(r.machine.phase, FileSaveMachine.Phase.none)
        // Another offer holds the browser's keys.
        let line = ActionLine(offerKey: "other", app: "", endState: PopupSpec.Value("x", ref: .derived(rule: "t", from: [])), actions: [PopupSpec.Action(id: "a", label: "A", key: .cmd1)])
        let target = TargetIdentity(pid: Self.pid, bundleID: "b", windowID: "w", elementID: "e", elementRevision: "")
        XCTAssertNotNil(r.arbiter.publish(Offer(text: "", source: .helper, kind: .action(line), target: target, fieldValue: "", caretUTF16: 0, createdAt: r.clock.now, maxAgeSeconds: 10)))
        r.machine.receive(try Self.offer(), place: Self.place)
        XCTAssertEqual(r.machine.phase, FileSaveMachine.Phase.none)
    }

    func testThePageTaskNamesThePageForItsGoalOnly() throws {
        let p = PageTaskTests.Rig()
        p.machine.start(try AttachH14Tests.preview())
        XCTAssertEqual(p.machine.place(forGoal: "goal-3-a1"), Self.place)
        XCTAssertNil(p.machine.place(forGoal: "goal-2-a1"))
    }
}

/// H14: the memory window's Files group.
final class SavedFilesBookTests: XCTestCase {
    final class Rig {
        let clock = ManualClock()
        let book: SavedFilesBook
        var sent: [SavedFilesRequest] = []
        var enabled = true

        init() {
            book = SavedFilesBook(clock: clock)
            book.send = { [unowned self] in self.sent.append($0); return true }
            book.enabled = { [unowned self] in self.enabled }
        }
    }

    static func replies() throws -> [SavedFilesReply] {
        try WireH11Tests.lines("saved-files").filter { try WireH11Tests.object($0)["type"] as? String == SavedFilesReply.type }
            .map { try JSONDecoder().decode(SavedFilesReply.self, from: $0) }
    }

    func testTheListComesOnConnectAndOnlyForAHostThatNamedGoalFiles() throws {
        let off = Rig()
        off.enabled = false
        off.book.linkChanged(true)
        XCTAssertTrue(off.sent.isEmpty)
        let r = Rig()
        r.book.linkChanged(true)
        XCTAssertEqual(r.sent.map(\.op), [.list])
        var reply = try Self.replies()[0]
        reply.requestId = r.sent[0].requestId
        r.book.receive(reply)
        XCTAssertTrue(r.book.state.loaded)
        XCTAssertEqual(r.book.state.files.map(\.name), ["Robin Vale Cover Letter.pdf", "Robin Vale Resume.pdf"])
    }

    func testForgetAsksFirstThenSendsAndTakesTheListAfter() throws {
        let r = Rig()
        r.book.linkChanged(true)
        var list = try Self.replies()[0]
        list.requestId = r.sent[0].requestId
        r.book.receive(list)
        r.book.askForget("file-1a2b3c4d")
        XCTAssertEqual(r.book.state.confirmingForget, "file-1a2b3c4d")
        XCTAssertEqual(r.sent.count, 1)
        r.book.keep()
        XCTAssertNil(r.book.state.confirmingForget)
        r.book.askForget("file-1a2b3c4d")
        XCTAssertTrue(r.book.confirmForget())
        XCTAssertEqual(r.sent.last, SavedFilesRequest(requestId: r.sent.last!.requestId, op: .forget, id: "file-1a2b3c4d"))
        XCTAssertEqual(r.book.state.forgetting, "file-1a2b3c4d")
        var after = try Self.replies()[1]
        after.requestId = r.sent.last!.requestId
        r.book.receive(after)
        XCTAssertNil(r.book.state.forgetting)
        XCTAssertEqual(r.book.state.files.map(\.id), ["file-5e6f7a8b"])
    }

    func testARefusalKeepsTheListAndSaysWhy() throws {
        let r = Rig()
        r.book.linkChanged(true)
        var list = try Self.replies()[0]
        list.requestId = r.sent[0].requestId
        r.book.receive(list)
        r.book.askForget("file-5e6f7a8b")
        r.book.confirmForget()
        var refused = try Self.replies()[2]
        refused.requestId = r.sent.last!.requestId
        r.book.receive(refused)
        XCTAssertEqual(r.book.state.files.count, 2)
        XCTAssertEqual(r.book.state.problem, "no saved file file-00000000 in files.md")
    }

    func testNoAnswerSaysSo() {
        let r = Rig()
        r.book.linkChanged(true)
        r.clock.advance(by: SavedFilesBook.answerTimeout + 0.01)
        XCTAssertEqual(r.book.state.problem, SavedFilesCopy.unanswered)
        XCTAssertFalse(r.book.state.loaded)
    }

    func testARowSaysWhatTheFileWasKeptForAndWhenItChanged() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let files = try Self.replies()[0].files
        let now = Date(timeIntervalSince1970: 1_790_200_000)
        XCTAssertEqual(SavedFilesCopy.detail(files[0], now: now, calendar: utc), "for 'Cover letter' on jobs.example-ats.test · edited yesterday")
        XCTAssertEqual(SavedFilesCopy.detail(files[1], now: now, calendar: utc), "for 'Resume' on jobs.example-ats.test · Not where it was kept")
    }
}
