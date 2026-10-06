import CaretHostCore
import CaretScreenCore
import XCTest

/// What the host takes from I6's merge of v2/screen (H13): the goal goldens P3 and I6 added (goal-files.ndjson,
/// goal-handoff.ndjson), the page lines (page.ndjson, page-field-text.ndjson), each copied byte for byte into
/// Fixtures; attach steps and the nextPage reason decoded; and a finished goal's hand-off sentence shown as the page
/// panel's last row, never repeated.
final class WireI6Tests: XCTestCase {
    static let names = ["goal-files", "goal-handoff", "page", "page-field-text", "page-goal", "page-inline"]

    func testTheFixtureCopiesAreTheHelpersGoldenFiles() throws {
        let repo = WireH11Tests.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        for name in Self.names {
            let copy = try Data(contentsOf: WireH11Tests.fixtures.appendingPathComponent("\(name).ndjson"))
            let golden = try Data(contentsOf: repo.appendingPathComponent("helper/fixtures/golden/\(name).ndjson"))
            XCTAssertEqual(copy, golden, "Fixtures/\(name).ndjson differs from helper/fixtures/golden/\(name).ndjson")
        }
    }

    /// Every goal line the helper may send this host decodes and encodes back to the same JSON, attach steps and
    /// their files included.
    func testEveryGoalProgressLineRoundTrips() throws {
        var kinds = Set<GoalProgress.Step.Kind>()
        var reasons = Set<GoalProgress.Preview.Reason>()
        for name in ["goal-files", "goal-handoff"] {
            for line in try WireH11Tests.lines(name) where try WireH11Tests.object(line)["type"] as? String == GoalProgress.type {
                let m = try JSONDecoder().decode(GoalProgress.self, from: line)
                try WireH11Tests.assertSameJSON(m, line)
                if case .segment(let p) = m.event {
                    reasons.insert(p.reason)
                    for s in p.steps { kinds.insert(s.kind) }
                }
            }
        }
        XCTAssertTrue(kinds.isSuperset(of: [.write, .attach, .handoff]))
        XCTAssertTrue(reasons.contains(.nextPage))
    }

    func testAnAttachStepNamesItsFileAndNoOtherStepDoes() throws {
        let line = try XCTUnwrap(try WireH11Tests.lines("goal-handoff").first)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
        var steps = try XCTUnwrap(object["steps"] as? [[String: Any]])
        steps[2].removeValue(forKey: "file")
        object["steps"] = steps
        XCTAssertThrowsError(try JSONDecoder().decode(GoalProgress.self, from: JSONSerialization.data(withJSONObject: object)))
        steps[2]["file"] = ["source": "choose"]
        steps[0]["file"] = ["source": "choose"]
        object["steps"] = steps
        XCTAssertThrowsError(try JSONDecoder().decode(GoalProgress.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    /// The preview of goal-handoff.ndjson's third line as a page segment, so the panel can show it.
    static func handoffTask() throws -> PageTask {
        let lines = try WireH11Tests.lines("goal-handoff")
        let m = try JSONDecoder().decode(GoalProgress.self, from: lines[2])
        guard case .segment(var p) = m.event else { throw ProtocolError("line 3 is a segment") }
        p.page = .init(windowId: "page:eng1:7", app: AppRef(pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing"),
                       anchor: nil, viewport: nil, from: "Notes", rows: [.init(step: 0, label: "Full name", value: "Robin Vale", picked: false),
                                                                       .init(step: 1, label: "Email", value: "robin@example.test", picked: false)], attach: [])
        return try XCTUnwrap(PageTask(preview: p, goalId: m.goalId))
    }

    func testAFinishedGoalsHandOffIsThePanelsLastRowOnce() throws {
        var task = try Self.handoffTask()
        _ = task.tab(nowMs: 1_790_300_000_400)
        let lines = try WireH11Tests.lines("goal-handoff")
        let finished = try JSONDecoder().decode(GoalProgress.self, from: lines[3])
        _ = task.receive(finished)
        let panel = PageTaskPanel(task: task, stoppable: false)
        XCTAssertEqual(panel.lead, "Done:")
        XCTAssertEqual(panel.title, "2 steps verified.")
        XCTAssertEqual(panel.yours.map(\.text), ["You press Next."])
        XCTAssertEqual(panel.yours.last?.kind, .yours)
        XCTAssertFalse(panel.hints.contains { $0.label?.contains("Next") == true }, "the hand-off is a row, never a key")
    }

    func testAFinishedHandOffWithNoRowForItGetsOne() throws {
        var task = try Self.handoffTask()
        task.groups[0].rows.removeAll { $0.yours }
        _ = task.tab(nowMs: 1_790_300_000_400)
        _ = task.receive(try JSONDecoder().decode(GoalProgress.self, from: try WireH11Tests.lines("goal-handoff")[3]))
        XCTAssertEqual(PageTaskPanel(task: task, stoppable: false).yours.map(\.text), ["You press Next."])
    }

    func testTheHandOffSentence() {
        XCTAssertEqual(PageTaskCopy.handoff("Done: 2 steps verified. You press Next."), "You press Next.")
        XCTAssertEqual(PageTaskCopy.handoff("Done: 2 steps verified. The rest is yours."), "The rest is yours.")
        XCTAssertNil(PageTaskCopy.handoff("Partly done: 9 fields verified. 'Email' no longer holds what Caret wrote."))
        XCTAssertNil(PageTaskCopy.handoff("Done: 3 fields verified."))
    }
}
