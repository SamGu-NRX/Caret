@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// `PageTask` alone, without the arbiter in front of it: the authority boundary holds by itself. A Tab while
/// a segment runs, after it was accepted, or after the preview expired returns nothing to send.
final class PageTaskValueTests: XCTestCase {
    func testTheValueItselfAcceptsEachSegmentOnceAndNeverLate() throws {
        let g = try PageTaskTests.Golden()
        guard case .segment(let p) = g.first[0].event else { return XCTFail() }
        var t = try XCTUnwrap(PageTask(preview: p, goalId: "goal-2-a1"))
        guard case .accept = t.tab(nowMs: p.expires) else { return XCTFail("the last millisecond is still in time") }
        XCTAssertEqual(t.tab(nowMs: p.expires), .held("a segment is running"))
        t.stage = .preview
        XCTAssertEqual(t.tab(nowMs: p.expires), .held("this segment was accepted"))

        var late = try XCTUnwrap(PageTask(preview: p, goalId: "goal-2-a1"))
        XCTAssertEqual(late.tab(nowMs: p.expires + 1), .held("the preview expired"))
        XCTAssertEqual(late.stage, .ended(.notRun(PageTaskCopy.expired)))
    }

    func testAPreviewForAnotherPageWindowNeverJoinsTheTask() throws {
        let g = try PageTaskTests.Golden()
        guard case .segment(let p) = g.first[0].event, case .segment(var other) = g.reveal[0].event else { return XCTFail() }
        var t = try XCTUnwrap(PageTask(preview: p, goalId: "goal-2-a1"))
        _ = t.tab(nowMs: 1)
        for m in g.first.dropFirst() { _ = t.receive(m) }
        other.page?.windowId = "page:eng1:8"
        XCTAssertEqual(t.receive(GoalProgress(at: 1, goalId: "goal-2-a1~1", requestId: nil, event: .segment(other))), .ignored)
    }
}
