@testable import CaretHostCore
import CaretScreenCore
import Darwin
import XCTest

/// L1: v41's page panel. The helper's source-excerpts golden round trips and decodes into rows with sources, excerpts
/// and blanks; an excerpt the panel could not point at is refused; the hello names `sourceExcerpts` only when the panel
/// draws the crop; no excerpt reaches the debug state; the owner bracket groups runs of rows from one source; a key's
/// change moves nothing; Reduce Motion keeps opacity only; Reduce Transparency makes the panel opaque.
final class LookL1Tests: XCTestCase {
    // MARK: - The wire

    func testTheFixtureIsTheHelpersGoldenFile() throws {
        let repo = WireH11Tests.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let copy = try Data(contentsOf: WireH11Tests.fixtures.appendingPathComponent("source-excerpts.ndjson"))
        let golden = try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/source-excerpts.ndjson"))
        XCTAssertEqual(copy, golden)
    }

    func testEverySourceExcerptsLineRoundTrips() throws {
        var seen = Set<String>()
        for line in try WireH11Tests.lines("source-excerpts") {
            let type = try XCTUnwrap(WireH11Tests.object(line)["type"] as? String)
            seen.insert(type)
            switch type {
            case GoalProgress.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(GoalProgress.self, from: line), line)
            case GoalAccept.type: try WireH11Tests.assertSameJSON(JSONDecoder().decode(GoalAccept.self, from: line), line)
            case "hello":
                let caps = try XCTUnwrap(WireH11Tests.object(line)["capabilities"] as? [String])
                XCTAssertTrue(caps.contains(SourceExcerpts.capability))
            case PlanRequest.type: continue
            default: XCTFail("no host type for \(type)")
            }
            if case .unknown(let t) = try HelperInbound.decode(line) { XCTFail("\(t) is unknown to the host") }
        }
        XCTAssertTrue(seen.contains(GoalProgress.type))
    }

    static func goldenPreview() throws -> (GoalProgress.Preview, String) {
        for line in try WireH11Tests.lines("source-excerpts") where try WireH11Tests.object(line)["event"] as? String == "segment" {
            let m = try JSONDecoder().decode(GoalProgress.self, from: line)
            if case .segment(let p) = m.event { return (p, m.goalId) }
        }
        throw XCTSkip("no segment in the golden")
    }

    func testTheGoldenPreviewBecomesRowsWithSourcesExcerptsAndBlanks() throws {
        let (p, goal) = try Self.goldenPreview()
        let rows = try XCTUnwrap(p.page?.rows)
        // Each excerpt points at its row's value, by UTF-16 offsets.
        for r in rows {
            guard let e = r.excerpt else { continue }
            XCTAssertEqual(e.spanText, r.value, r.label)
        }
        XCTAssertEqual(rows.map { $0.source?.kind }, [.window, .tab, .memory, .request])
        XCTAssertEqual(rows.first { $0.label == "Email" }?.excerpt?.tab, SourceExcerpt.Tab(title: "Robin Vale - Profile", host: "people.example.test"))
        XCTAssertNil(rows.first { $0.label == "Country" }?.excerpt)

        let task = try XCTUnwrap(PageTask(preview: p, goalId: goal))
        let panel = PageTaskPanel(task: task, stoppable: false)
        let lines = panel.sections[0].lines
        XCTAssertEqual(lines.filter { $0.kind == .field }.map(\.owner), ["TextEdit", "Google Chrome for Testing", "Memory", "You asked"])
        let blanks = lines.filter { $0.kind == .blank }
        XCTAssertEqual(blanks.map(\.label), ["Why do you want to volunteer?", "Nickname"])
        XCTAssertEqual(blanks.map(\.blank), [.hatch, .dotted])
        XCTAssertEqual(blanks.map(\.owner), ["yours to write", "not in your sources"])
        // A blank's sentence is not said twice: its warning is not a withheld line as well.
        XCTAssertTrue(lines.filter { $0.kind == .withheld }.isEmpty, "\(lines.map(\.text))")
        // Blank rows have keys of their own, below zero, for the crop and VoiceOver; a row's key is its step in the first group.
        XCTAssertTrue(blanks.allSatisfy { ($0.key ?? 0) < 0 && $0.step == nil })
        XCTAssertEqual(lines.filter { $0.kind == .field }.map(\.key), [0, 1, 2, 3])
        XCTAssertEqual(panel.yoursCount, "1 is yours")
    }

    func testAnExcerptThePanelCannotPointAtIsRefused() throws {
        func decode(_ json: String) throws -> SourceExcerpt { try JSONDecoder().decode(SourceExcerpt.self, from: Data(json.utf8)) }
        XCTAssertNoThrow(try decode(#"{"text":"Robin Vale","start":0,"end":5,"name":"Notes","edited":null}"#))
        // Seven lines, 601 characters, an empty or reversed span, a span past the text, a missing `edited`, both kinds.
        XCTAssertThrowsError(try decode(#"{"text":"1\n2\n3\n4\n5\n6\n7","start":0,"end":1,"name":"N","edited":null}"#))
        XCTAssertThrowsError(try decode("{\"text\":\"\(String(repeating: "a", count: 601))\",\"start\":0,\"end\":1,\"name\":\"N\",\"edited\":null}"))
        XCTAssertThrowsError(try decode(#"{"text":"abc","start":2,"end":2,"name":"N","edited":null}"#))
        XCTAssertThrowsError(try decode(#"{"text":"abc","start":1,"end":4,"name":"N","edited":null}"#))
        XCTAssertThrowsError(try decode(#"{"text":"abc","start":0,"end":1,"name":"N"}"#))
        XCTAssertThrowsError(try decode(#"{"text":"abc","start":0,"end":1,"name":"N","edited":null,"pdf":{"path":"/a.pdf","page":0},"tab":{"title":"t","host":"h"}}"#))
        // Offsets are UTF-16: an emoji is two units, and a span may not split it.
        XCTAssertEqual(try decode(#"{"text":"😀 Robin","start":3,"end":8,"name":"N","edited":null}"#).spanText, "Robin")
        XCTAssertThrowsError(try decode(#"{"text":"😀 Robin","start":1,"end":8,"name":"N","edited":null}"#))
    }

    func testAnExcerptNeverDescribesItsText() {
        let e = SourceExcerpt(text: "My secret address is 1 Hidden Lane", start: 21, end: 34, name: "Private note")
        for s in ["\(e)", String(describing: e), String(reflecting: e)] {
            XCTAssertFalse(s.contains("Hidden"), s)
            XCTAssertFalse(s.contains("Private note"), s)
        }
    }

    // MARK: - Gating

    func testTheHelloNamesSourceExcerptsOnlyWhenThePanelDrawsTheCrop() {
        XCTAssertFalse(HostHello.capabilities(routing: false).contains(SourceExcerpts.capability))
        XCTAssertFalse(HostHello.capabilities(routing: true, goalFiles: true).contains(SourceExcerpts.capability))
        XCTAssertTrue(HostHello.capabilities(routing: false, sourceExcerpts: true).contains(SourceExcerpts.capability))
        // A machine draws no crop until a coordinator on screen says it does.
        let rig = PageTaskTests.Rig()
        XCTAssertFalse(rig.machine.drawsCrops)
    }

    // MARK: - Privacy

    /// A task whose excerpts carry words no row shows.
    static func privateTask() throws -> PageTask {
        try XCTUnwrap(PageTask(preview: privatePreview(), goalId: "goal-1-a1"))
    }

    static func privatePreview() throws -> GoalProgress.Preview {
        let secret = "ZQ-line-one\nRobin Vale\nZQ-line-three"
        let page = GoalProgress.PageView(windowId: "page:eng1:7", app: AppRef(pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome"), anchor: nil, viewport: nil,
                                         from: "Notes", rows: [.init(step: 0, label: "Full name", value: "Robin Vale", picked: false, source: RowSource(kind: .window, name: "Notes"),
                                                                     excerpt: SourceExcerpt(text: secret, start: 12, end: 22, name: "ZQ-note-name"))], attach: [])
        return GoalProgress.Preview(segment: 0, segments: 1, reason: .start, replaces: nil, digest: String(repeating: "a", count: 64), expires: 4_102_444_800_000,
                                    place: .window(app: "Google Chrome", title: "Apply"), steps: [GoalProgress.Step(index: 0, kind: .write, says: "Full name: Robin Vale")], warnings: [], page: page)
    }

    func testNoExcerptReachesTheDebugState() throws {
        let task = try Self.privateTask()
        let panel = PageTaskPanel(task: task, stoppable: false)
        // What the debug socket carries for the panel: its spoken text, its status, and the crop's row, side and kind.
        var info = DebugState.PageTaskInfo(status: PageTaskMachine.Status(stage: "preview", goalId: "goal-1-a1", groups: 1, page: 1, ownsTab: true, hidden: false, undo: "none", lastHeld: nil),
                                           choosing: nil, filesWired: false,
                                           panel: DebugState.Panel(windowNumber: 1, frame: [0, 0, 340, 200], isKey: false, text: panel.spoken, takesClicks: nil, pointerMonitors: 2, pointerMoves: 9))
        info.crop = .init(step: 0, side: "trailing", kind: "window")
        var state = ShipsCoreTests.seededState()
        state.pageTask = info
        // The full state (development builds, CARET_DEBUG_SOCKET=full) and the release one.
        let json = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        let release = String(decoding: try JSONEncoder().encode(ReleaseState(state)), as: UTF8.self)
        XCTAssertTrue(json.contains("Robin Vale"), "the row's value is the panel's, as before")
        XCTAssertTrue(json.contains("\"side\":\"trailing\""), "the crop's place is reported")
        for secret in ["ZQ-line-one", "ZQ-line-three", "ZQ-note-name"] {
            XCTAssertFalse(json.contains(secret), "\(secret) reached the debug state")
            XCTAssertFalse(release.contains(secret), "\(secret) reached the release state")
            XCTAssertFalse(panel.spoken.contains(secret))
            XCTAssertFalse(panel.announcement.contains(secret))
        }
    }

    /// Every line the page task path could write to the log while a preview with excerpts shows, runs and ends (its
    /// counts, and the values themselves should anything interpolate them) goes into a log that then rotates: neither
    /// file holds the excerpt.
    func testNoExcerptReachesTheLog() throws {
        let dir = NSTemporaryDirectory() + "l1-log-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let log = HostLog(path: dir + "/host.log", cap: 200)
        let fd = try log.open()
        defer { close(fd) }
        let task = try Self.privateTask()
        let preview = try Self.privatePreview()
        let r = PageTaskTests.Rig()
        XCTAssertTrue(r.machine.start(GoalProgress(at: 1, goalId: "goal-1-a1", requestId: nil, event: .segment(preview))))
        r.tab()
        r.feed([GoalProgress(at: 2, goalId: "goal-1-a1", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-1-a1:s0", step: 0, steps: 1, phase: .verified, says: "Full name: Robin Vale"))),
                GoalProgress(at: 3, goalId: "goal-1-a1", requestId: nil, event: .finished(.init(outcome: .done, verified: 1, skipped: 0, left: [], says: "Done: 1 field verified.")))])
        let counted = r.commands.compactMap { c -> String? in if case .count(let n) = c { return n } else { return nil } }
        let panel = try XCTUnwrap(r.lastPanel)
        let row = try XCTUnwrap(preview.page?.rows.first)
        let lines = counted + ["page task \(task)", "row \(row)", String(reflecting: row), "panel \(panel)", String(describing: panel.sections), "\(preview)"]
        for line in lines + [String(repeating: "x", count: 300)] {
            _ = ("caret: " + line + "\n").withCString { Darwin.write(fd, $0, strlen($0)) }
        }
        XCTAssertTrue(log.rotateIfNeeded())
        let all = try String(contentsOfFile: log.path, encoding: .utf8) + String(contentsOfFile: log.rotatedPath, encoding: .utf8)
        XCTAssertTrue(all.contains("Robin Vale"), "the lines themselves are there")
        for secret in ["ZQ-line-one", "ZQ-line-three", "ZQ-note-name"] { XCTAssertFalse(all.contains(secret), "\(secret) in the log") }
    }

    // MARK: - Review L1: lifetime

    static func excerpts(_ t: PageTask?) -> [SourceExcerpt] { (t?.groups ?? []).flatMap { $0.rows.compactMap(\.excerpt) } }

    func testAHostThatDrawsNoCropKeepsNoExcerpt() throws {
        let preview = GoalProgress(at: 1, goalId: "goal-1-a1", requestId: nil, event: .segment(try Self.privatePreview()))
        let headless = PageTaskTests.Rig()
        XCTAssertTrue(headless.machine.start(preview))
        XCTAssertEqual(Self.excerpts(headless.machine.task), [])
        let drawing = PageTaskTests.Rig()
        drawing.machine.drawsCrops = true
        XCTAssertTrue(drawing.machine.start(preview))
        XCTAssertEqual(Self.excerpts(drawing.machine.task).count, 1)
    }

    func testAStopForgetsTheExcerpts() throws {
        let r = PageTaskTests.Rig()
        r.machine.drawsCrops = true
        XCTAssertTrue(r.machine.start(GoalProgress(at: 1, goalId: "goal-1-a1", requestId: nil, event: .segment(try Self.privatePreview()))))
        r.tab()
        XCTAssertEqual(Self.excerpts(r.machine.task).count, 1)
        // The helper stops the goal because its source went (a tab's text expired): no crop may show that text after.
        r.feed([GoalProgress(at: 2, goalId: "goal-1-a1", requestId: nil, event: .stopped(.init(segment: 0, step: 0, reason: .sourceChanged,
                                                                                                 says: "What Caret was copying from changed, so it stopped.", freshPlan: nil)))])
        XCTAssertNotNil(r.machine.task)
        XCTAssertEqual(Self.excerpts(r.machine.task), [])
    }

    func testAPanelAtRestKeepsNoExcerpt() throws {
        let r = PageTaskTests.Rig()
        r.machine.drawsCrops = true
        XCTAssertTrue(r.machine.start(GoalProgress(at: 1, goalId: "goal-1-a1", requestId: nil, event: .segment(try Self.privatePreview()))))
        r.tab()
        r.feed([GoalProgress(at: 2, goalId: "goal-1-a1", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-1-a1:s0", step: 0, steps: 1, phase: .verified, says: "Full name: Robin Vale"))),
                GoalProgress(at: 3, goalId: "goal-1-a1", requestId: nil, event: .finished(.init(outcome: .done, verified: 1, skipped: 0, left: [], says: "Done: 1 field verified.")))])
        // Done and after, the crop shows on hover while the panel does.
        XCTAssertEqual(Self.excerpts(r.machine.task).count, 1)
        r.clock.advance(by: 30)
        // The panel has left and the task rests for a late reveal: it holds no excerpt.
        XCTAssertTrue(r.hidden)
        XCTAssertNotNil(r.machine.task)
        XCTAssertEqual(Self.excerpts(r.machine.task), [])
    }

    // MARK: - The row grammar

    func testTheOwnerBracketGroupsRunsOfOneSource() {
        func field(_ label: String, _ kind: RowSource.Kind, _ name: String, _ state: PageTask.Row.State = .pending) -> PageTaskPanel.Line {
            PageTaskPanel.Line(kind: .field, label: label, text: label, state: state, owner: state == .already ? PageTaskCopy.already : PageTaskCopy.owner(RowSource(kind: kind, name: name)), sourceKind: kind)
        }
        let lines = PageTaskPanel.runs([
            field("First", .window, "Notes"), field("Last", .window, "Notes"), field("Email", .window, "Notes"),
            field("LinkedIn", .tab, "Google Chrome"),
            field("Website", .memory, ""),
            field("City", .window, "Notes"), field("Zip", .window, "Notes", .already), field("Country", .window, "Notes"),
            PageTaskPanel.Line(kind: .blank, label: "Why", text: "It is yours.", owner: "yours to write", blank: .hatch),
        ])
        XCTAssertEqual(lines.map(\.run), [.first, .middle, .last, .single, .single, .single, nil, .single, nil])
        XCTAssertEqual(lines.map(\.showsOwner), [true, false, false, true, true, true, true, true, true])
        XCTAssertEqual(lines[4].owner, "Memory")
        // Every field row names its source: on itself, or through the bracket from its run's first row.
        XCTAssertTrue(lines.filter { $0.kind == .field }.allSatisfy { $0.owner != nil })
    }

    func testARowSaysItsSourceToVoiceOver() throws {
        let panel = PageTaskPanel(task: try Self.privateTask(), stoppable: false)
        XCTAssertEqual(panel.sections[0].lines[0].spoken, "Full name, Robin Vale, from Notes")
    }

    // MARK: - Motion and material

    func testAKeysChangeMovesNothing() {
        XCTAssertEqual(PageTaskLook.Cause(.none), .key)
        XCTAssertEqual(PageTaskLook.Cause(.update), .helper)
        let m = PageTaskLook.motion(.key, reduceMotion: false)
        XCTAssertEqual(m.rule, .whole)
        XCTAssertNil(m.settle); XCTAssertNil(m.appear); XCTAssertNil(m.swap); XCTAssertNil(m.pan); XCTAssertNil(m.thread); XCTAssertNil(m.stagger)
        XCTAssertFalse(m.rises); XCTAssertFalse(m.blurs)
        XCTAssertEqual(PageTaskLook.motion(.key, reduceMotion: true).rule, .none)
    }

    func testTheHelpersAndThePointersChangesUseV41sVocabulary() {
        let helper = PageTaskLook.motion(.helper, reduceMotion: false)
        XCTAssertEqual(helper.rule, .draws(ms: 320))
        XCTAssertEqual(helper.settle, 120); XCTAssertEqual(helper.appear, 160); XCTAssertEqual(helper.swap, 140); XCTAssertEqual(helper.pan, 200)
        XCTAssertEqual(helper.thread, 320); XCTAssertEqual(helper.stagger, 30)
        XCTAssertTrue(helper.rises); XCTAssertTrue(helper.blurs)
        XCTAssertEqual(PageTaskLook.motion(.pointer, reduceMotion: false).thread, 200)
    }

    func testReduceMotionKeepsOpacityOnly() {
        for cause in [PageTaskLook.Cause.helper, .pointer] {
            let m = PageTaskLook.motion(cause, reduceMotion: true)
            XCTAssertEqual(m.rule, .none, "no rule: the value going solid and the check fading in are the change")
            XCTAssertFalse(m.rises); XCTAssertFalse(m.blurs)
            XCTAssertNil(m.pan); XCTAssertNil(m.thread); XCTAssertNil(m.stagger)
            XCTAssertEqual(m.appear, 120); XCTAssertEqual(m.settle, 120); XCTAssertEqual(m.swap, 120)
        }
    }

    func testReduceTransparencyMakesThePanelOpaque() {
        XCTAssertEqual(PageTaskLook.material(reduceTransparency: true, glassAvailable: true), .opaque)
        XCTAssertEqual(PageTaskLook.material(reduceTransparency: true, glassAvailable: false), .opaque)
        XCTAssertEqual(PageTaskLook.material(reduceTransparency: false, glassAvailable: true), .glass)
        XCTAssertEqual(PageTaskLook.material(reduceTransparency: false, glassAvailable: false), .visualEffect)
        XCTAssertEqual(PageTaskLook.tint(dark: false, material: .opaque), 1)
        XCTAssertEqual(PageTaskLook.tint(dark: true, material: .opaque), 1)
        XCTAssertEqual(PageTaskLook.tint(dark: false, material: .glass), 0.88)
        XCTAssertEqual(PageTaskLook.tint(dark: true, material: .visualEffect), 0.90)
    }

    // MARK: - The crop

    func testTheCropStandsWhereItFitsAndNeverOverTheField() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let field = CGRect(x: 100, y: 200, width: 400, height: 30)
        XCTAssertEqual(PageTaskLook.cropSide(panel: CGRect(x: 600, y: 150, width: 340, height: 400), screen: screen, field: field), .trailing)
        // No room to the right: to the left, when that covers no part of the field.
        XCTAssertEqual(PageTaskLook.cropSide(panel: CGRect(x: 1000, y: 150, width: 340, height: 400), screen: screen, field: field), .leading)
        // The left would cover the field: over the panel's rows.
        XCTAssertEqual(PageTaskLook.cropSide(panel: CGRect(x: 1000, y: 150, width: 340, height: 400), screen: screen, field: CGRect(x: 700, y: 200, width: 280, height: 30)), .overlay)
        XCTAssertEqual(PageTaskLook.cropSide(panel: CGRect(x: 100, y: 150, width: 1250, height: 400), screen: screen, field: nil), .overlay)
    }

    func testTheCropFollowsTheWritingRowThenThePointerOrVoiceOver() {
        let all: (Int) -> Bool = { _ in true }
        XCTAssertEqual(PageTaskLook.cropStep(running: true, writing: 3, voiceOver: 1, pointer: 2, shows: all), 3)
        XCTAssertNil(PageTaskLook.cropStep(running: true, writing: nil, voiceOver: 1, pointer: 2, shows: all), "it closes when the run has no row being written")
        XCTAssertEqual(PageTaskLook.cropStep(running: false, writing: nil, voiceOver: 1, pointer: 2, shows: all), 1)
        XCTAssertEqual(PageTaskLook.cropStep(running: false, writing: nil, voiceOver: nil, pointer: 2, shows: all), 2)
        XCTAssertNil(PageTaskLook.cropStep(running: false, writing: nil, voiceOver: nil, pointer: 2, shows: { $0 != 2 }), "a row with nothing to show shows no crop")
    }

    func testThePanPutsTheSpansLineInViewAtALineTop() {
        let tops: [CGFloat] = [9, 28, 47, 66, 85, 104, 123, 142]
        XCTAssertEqual(PageTaskLook.pan(lineTops: tops, spanLine: 1, drawingHeight: 170, window: 118), 0)
        // Line 6 at 123: 42% down a 118 pt window is 49.56 above it; the nearest line top at or above 73.44 is 66.
        XCTAssertEqual(PageTaskLook.pan(lineTops: tops, spanLine: 6, drawingHeight: 170, window: 118), 47, "clamped to the drawing's end (52), then to the line top above it")
        XCTAssertEqual(PageTaskLook.pan(lineTops: tops, spanLine: 6, drawingHeight: 400, window: 118), 66)
        XCTAssertEqual(PageTaskLook.pan(lineTops: tops, spanLine: 3, drawingHeight: 100, window: 118), 0, "a drawing that fits never pans")
    }
}
