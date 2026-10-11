@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// H11's page task panel: one segment per Tab bound to its digest, stale and repeated Tabs sending nothing,
/// rows resolving in place, the reveal and next-page continuations, ⌘Z over every task on the page, and the
/// panel's words. Driven by the helper's golden lines (Fixtures/page-goal.ndjson) through a real arbiter, with
/// keys decided as the tap decides them and the decisions routed as HostRuntime routes them.
final class PageTaskTests: XCTestCase {
    static let chromePid: Int32 = 4100

    struct Golden {
        let messages: [GoalProgress]
        let accepts: [GoalAccept]
        let undos: [TaskControl]

        init() throws {
            var messages: [GoalProgress] = []
            var accepts: [GoalAccept] = []
            var undos: [TaskControl] = []
            for line in try WireH11Tests.lines("page-goal") {
                let type = try XCTUnwrap(WireH11Tests.object(line)["type"] as? String)
                switch type {
                case GoalProgress.type: messages.append(try JSONDecoder().decode(GoalProgress.self, from: line))
                case GoalAccept.type: accepts.append(try JSONDecoder().decode(GoalAccept.self, from: line))
                case TaskControl.type: undos.append(try JSONDecoder().decode(TaskControl.self, from: line))
                default: continue
                }
            }
            self.messages = messages
            self.accepts = accepts
            self.undos = undos
        }

        /// The first goal's messages, the reveal's, and the 402 stop at the end.
        var first: [GoalProgress] { messages.filter { $0.goalId == "goal-2-a1" } }
        var reveal: [GoalProgress] { messages.filter { $0.goalId == "goal-2-a1~1" } }
        var refused: GoalProgress { messages.last! }
    }

    final class Rig {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let machine: PageTaskMachine
        var commands: [PageTaskCommand] = []

        init() {
            machine = PageTaskMachine(arbiter: arbiter, clock: clock)
            machine.output = { [unowned self] in self.commands.append($0) }
        }

        var sent: [PageTaskSend] { commands.compactMap { if case .send(let s) = $0 { return s } else { return nil } } }
        var accepts: [GoalAccept] { sent.compactMap { if case .accept(let a) = $0 { return a } else { return nil } } }
        var controls: [TaskControl] { sent.compactMap { if case .control(let c) = $0 { return c } else { return nil } } }
        var lastPanel: PageTaskPanel? {
            for c in commands.reversed() { if case .draw(let p, _, _) = c { return p } }
            return nil
        }
        var lastMotion: PageTaskMotion? {
            for c in commands.reversed() {
                if case .draw(_, let m, _) = c { return m }
                if case .hide(let m) = c { return m }
            }
            return nil
        }
        var hidden: Bool { if case .hide = commands.last { return true } else { return false } }

        /// One key, decided by the arbiter and routed as HostRuntime routes it.
        @discardableResult
        func press(_ key: KeyStroke) -> OfferArbiter.Decision {
            let d = arbiter.handleKeyDown(key, now: clock.now)
            switch d {
            case .consume(let claim): machine.claimed(claim)
            case .undo(let grant):
                if let id = grant.taskID, machine.ownsTask(id) { machine.undoStarted(grant) }
            case .closeOffer(let id):
                machine.offerClosed(id)
                machine.offerChanged(.closed)
            case .stopWork(let line): machine.stopWork(line)
            case .closeToast: machine.offerChanged(.toastDismissed)
            case .closeStatus: machine.offerChanged(.statusDismissed)
            case .pass(let reason): machine.offerChanged(reason)
            case .navigate: break
            }
            return d
        }

        func tab() { press(.tab(to: PageTaskTests.chromePid)) }
        func esc() { press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: PageTaskTests.chromePid)) }
        func undo() { press(KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: PageTaskTests.chromePid)) }
        func type(_ s: String) { press(.typing(s, to: PageTaskTests.chromePid)) }
        func feed(_ ms: [GoalProgress]) { for m in ms { machine.receive(m) } }
    }

    // MARK: - One segment per Tab

    func testOneTabSendsOneAcceptanceBoundToThePreviewsDigest() throws {
        let g = try Golden()
        let r = Rig()
        XCTAssertTrue(r.machine.start(g.first[0]))
        XCTAssertEqual(r.lastMotion, .enter)
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
        // The golden's own acceptance, but for its time.
        var expected = g.accepts[0]
        expected.at = r.accepts[0].at
        XCTAssertEqual(r.accepts[0], expected)
        // Tab started it: drawn at once.
        XCTAssertEqual(r.lastMotion, PageTaskMotion.none)
        // A second Tab while it runs sends nothing.
        r.tab()
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
    }

    func testATabAfterThePreviewExpiredSendsNothing() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        guard case .segment(let p) = g.first[0].event else { return XCTFail() }
        r.clock.advance(by: Double(p.expires) / 1000 - r.clock.now.timeIntervalSince1970 + 1)
        r.tab()
        XCTAssertEqual(r.accepts, [])
        XCTAssertEqual(r.lastPanel?.title, PageTaskCopy.expired)
        XCTAssertEqual(r.lastPanel?.hints, [])
    }

    func testTheSamePreviewDeliveredAgainIsNotASecondSegment() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.machine.receive(g.first[0])
        r.tab()
        r.machine.receive(g.first[0])
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
    }

    func testTabOnlyInTheBrowserTakesThePanel() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.press(.tab(to: 999))
        r.press(KeyStroke.tab)
        XCTAssertEqual(r.accepts, [])
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
    }

    func testEscBeforeTabPutsThePanelAwayAtOnceAndSendsNothing() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.esc()
        XCTAssertTrue(r.hidden)
        XCTAssertEqual(r.lastMotion, PageTaskMotion.none)
        r.tab()
        XCTAssertEqual(r.sent, [])
        XCTAssertNil(r.machine.task)
    }

    func testTypingInThePagePutsThePreviewAway() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.type("a")
        XCTAssertTrue(r.hidden)
        r.tab()
        XCTAssertEqual(r.sent, [])
    }

    func testAnotherProducersOfferForTheBrowserCannotTakeThePanelsTab() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        let target = TargetIdentity(pid: Self.chromePid, bundleID: "com.google.Chrome", windowID: "page:eng1:7", elementID: "f", elementRevision: "")
        XCTAssertNil(r.arbiter.publish(Offer(text: "Robin", target: target, fieldValue: "", caretUTF16: 0)))
        // An offer in another app is the user's attention moving there.
        let other = TargetIdentity(pid: 7001, bundleID: "com.apple.TextEdit", windowID: "1", elementID: "f", elementRevision: "")
        XCTAssertNotNil(r.arbiter.publish(Offer(text: "x", target: other, fieldValue: "", caretUTF16: 0)))
    }

    // MARK: - Progress

    func testRowsResolveInPlaceAsReceiptsCome() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        let preview = try XCTUnwrap(r.lastPanel)
        XCTAssertEqual(preview.title, "Fill 9 fields on this page")
        XCTAssertEqual(preview.from, "from TextEdit, Robin's details.txt")
        XCTAssertEqual(preview.hints, [Hint(key: "Tab", label: "Fill 9"), Hint(key: "Esc")])
        XCTAssertFalse(preview.sections[0].marks)
        let country = try XCTUnwrap(preview.sections[0].lines.first { $0.label == "Country" })
        XCTAssertEqual(country.text, "Canada")
        XCTAssertEqual(country.note, PageTaskCopy.picked)
        XCTAssertEqual(preview.sections[0].lines.first { $0.label == "Full name" }?.note, nil)
        XCTAssertTrue(preview.sections[0].lines.contains { $0.kind == .step && $0.text.hasPrefix("Tick ") })
        XCTAssertEqual(preview.sections[0].lines.filter { $0.kind == .withheld }.map(\.text), ["'Are you over 18?' is yours: the value Caret found could mean more than one thing."])
        XCTAssertEqual(preview.yours.map(\.text), ["Attach 'Resume' yourself"])

        r.tab()
        XCTAssertEqual(r.lastPanel?.sections[0].lines.first?.state, .writing)
        XCTAssertTrue(r.lastPanel?.sections[0].marks ?? false)
        let steps = g.first.filter { if case .step = $0.event { return true } else { return false } }
        r.machine.receive(steps[0])
        r.machine.receive(steps[1])
        let lines = try XCTUnwrap(r.lastPanel?.sections[0].lines)
        XCTAssertEqual(lines[0].state, .verified)
        XCTAssertEqual(lines[1].state, .verified)
        XCTAssertEqual(lines[2].state, .writing)
        // The helper's receipts redraw at once too; only a key's change keeps the figure still as well.
        XCTAssertEqual(r.lastMotion, .update)
        // No spinner at the caret: the only working signal is the rows, and Esc reads as Stop 3 s in.
        XCTAssertEqual(r.lastPanel?.hints, [])
        r.clock.advance(by: StatusLine.stoppableAfter)
        XCTAssertEqual(r.lastPanel?.hints, [Hint(key: "Esc", label: "Stop")])
    }

    func testEscAfterThreeSecondsStopsTheRunningSegment() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.clock.advance(by: StatusLine.stoppableAfter + 0.1)
        r.esc()
        XCTAssertEqual(r.controls, [TaskControl(taskId: "goal-2-a1:s0", action: .stop)])
        XCTAssertEqual(r.lastPanel?.title, PageTaskCopy.stopping)
    }

    // MARK: - Ending, reveal, undo

    func testTheEndingIsTheHelpersWordsWithUndo() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        let end = try XCTUnwrap(r.lastPanel)
        XCTAssertEqual(end.lead, "Partly done:")
        XCTAssertEqual(end.title, "9 steps verified. Left for you: 'Are you over 18?'.")
        XCTAssertEqual(end.hints, [Hint(key: "⌘Z", label: "Undo")])
        XCTAssertTrue(end.sections[0].lines.filter { $0.kind == .field || $0.kind == .step }.allSatisfy { $0.state == .verified })
        // A receipt that comes after the end changes nothing it decided.
        let toasts = r.arbiter.snapshot().toast?.id
        r.machine.receive(g.first[1])
        XCTAssertEqual(r.arbiter.snapshot().toast?.id, toasts)
    }

    func testTheRevealIsOfferedUnderAHairlineAndTabMovesToIt() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.machine.receive(g.reveal[0])
        XCTAssertEqual(r.lastMotion, .reveal)
        let panel = try XCTUnwrap(r.lastPanel)
        XCTAssertEqual(panel.sections.count, 2)
        XCTAssertEqual(panel.sections[1].caption, "1 more field appeared")
        XCTAssertEqual(panel.sections[1].lines.first?.label, "Province")
        XCTAssertEqual(panel.sections[1].lines.first?.note, PageTaskCopy.picked)
        // Earlier rows stay as receipts.
        XCTAssertTrue(panel.sections[0].marks)
        XCTAssertEqual(panel.hints, [Hint(key: "Tab", label: "Fill 1"), Hint(key: "Esc")])
        // ⌘Z is not offered while the reveal waits: it would take back the field that showed it.
        XCTAssertNil(r.arbiter.snapshot().toast)
        r.tab()
        var expected = g.accepts[1]
        expected.at = r.accepts[1].at
        XCTAssertEqual(r.accepts, [r.accepts[0], expected])
        r.feed(Array(g.reveal.dropFirst()))
        // ⌘Z undoes every task on the page, newest first: the golden's two undos.
        r.undo()
        XCTAssertEqual(r.controls, g.undos)
        XCTAssertEqual(r.lastPanel?.title, PageTaskCopy.undoing)
        for (id, n) in [("goal-2-a1~1:s0", 1), ("goal-2-a1:s0", 9)] {
            let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"\#(id)","planId":"p","phase":"undone","step":null,"steps":1,"says":null,"detail":null,"restored":\#(n),"notRestored":0}"#
            r.machine.taskProgress(try JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8)))
        }
        XCTAssertEqual(r.lastPanel?.lead, "Cleared")
        XCTAssertEqual(r.lastPanel?.title, "10 fields on this page")
        r.clock.advance(by: PageTaskMachine.undoneLifetime)
        XCTAssertTrue(r.hidden)
        XCTAssertEqual(r.lastMotion, .exit)
    }

    /// Review H11-2: a Tab held down from the last acceptance does not take the reveal that arrives while it repeats.
    func testAHeldTabsRepeatAcceptsNothing() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.machine.receive(g.reveal[0])
        r.press(KeyStroke(keyCode: KeyStroke.tabKeyCode, targetPID: Self.chromePid, isRepeat: true))
        XCTAssertEqual(r.accepts.count, 1)
        XCTAssertNotNil(r.machine.task, "the reveal still waits for a new Tab")
        r.tab()
        XCTAssertEqual(r.accepts.count, 2)
    }

    /// Review H11-1: until the preview is drawn it owns no key.
    func testThePreviewOwnsTabOnlyOnceDrawn() throws {
        let g = try Golden()
        let r = Rig()
        var drawnFirst = false
        r.machine.output = { [unowned r] c in
            r.commands.append(c)
            if case .draw = c, r.commands.filter({ if case .draw = $0 { return true } else { return false } }).count == 1 {
                // A Tab decided while the first draw is under way: the offer is not yet revealed.
                drawnFirst = true
                XCTAssertEqual(r.arbiter.handleKeyDown(.tab(to: PageTaskTests.chromePid), now: r.clock.now), .pass(.dismissed))
            }
        }
        r.machine.start(g.first[0])
        XCTAssertTrue(drawnFirst)
        XCTAssertEqual(r.accepts, [])
        XCTAssertNil(r.machine.task, "a key before the preview showed puts it away")
    }

    /// Review H11-4: switching away while the task rests, and back, still lets its continuation show.
    func testAContinuationAfterAnAppSwitchWhileRestingShows() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.machine.appActivated(pid: 7001)
        r.clock.advance(by: PageTaskMachine.undoLifetime)
        r.machine.appActivated(pid: Self.chromePid)
        r.machine.receive(g.reveal[0])
        XCTAssertEqual(r.lastMotion, .enter)
        r.tab()
        XCTAssertEqual(r.accepts.count, 2)
    }

    /// Review H11-6: the next page does not replace a page whose undo is under way.
    func testTheNextPageWaitsForAnUndoUnderWay() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.undo()
        guard case .segment(var p) = g.reveal[0].event else { return XCTFail() }
        p.reason = .nextPage
        p.replaces = "goal-2-a1"
        r.machine.receive(GoalProgress(at: 1, goalId: "goal-5-a1", requestId: nil, event: .segment(p)))
        XCTAssertEqual(r.machine.task?.page, 1)
        XCTAssertEqual(r.lastPanel?.title, PageTaskCopy.undoing)
    }

    /// Review H11-3: a verified write reported after the ending still gets its ⌘Z.
    func testAReceiptAfterTheEndingMakesUndoAvailable() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        let steps = g.first.filter { if case .step = $0.event { return true } else { return false } }
        guard let finished = g.first.last else { return XCTFail() }
        r.machine.receive(finished)
        XCTAssertNil(r.arbiter.snapshot().toast)
        r.machine.receive(steps[0])
        XCTAssertNotNil(r.arbiter.snapshot().toast)
        XCTAssertEqual(r.lastPanel?.hints, [Hint(key: "⌘Z", label: "Undo")])
        r.undo()
        XCTAssertEqual(r.controls, [TaskControl(taskId: "goal-2-a1:s0", action: .undo)])
    }

    func testARevealAfterThePanelLeftBringsTheSameTaskBack() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.clock.advance(by: PageTaskMachine.undoLifetime)
        XCTAssertTrue(r.hidden)
        XCTAssertNil(r.arbiter.snapshot().toast, "⌘Z left with the panel")
        // The fields the writes revealed (or the next page, P3) come later than the ending's time.
        r.clock.advance(by: 20)
        r.machine.receive(g.reveal[0])
        XCTAssertEqual(r.lastMotion, .enter)
        XCTAssertEqual(r.lastPanel?.sections.count, 2)
        r.tab()
        XCTAssertEqual(r.accepts.last?.goalId, "goal-2-a1~1")
    }

    func testAfterTheCarryWindowNothingContinuesTheTask() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        r.clock.advance(by: PageTaskMachine.undoLifetime + PageTaskMachine.carryWindow)
        XCTAssertNil(r.machine.task)
        r.machine.receive(g.reveal[0])
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
    }

    func testARevealOfAnotherGoalOrPageIsIgnored() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        // Before the goal ended, a reveal cannot come.
        r.machine.receive(g.reveal[0])
        XCTAssertEqual(r.lastPanel?.sections.count, 1)
        r.feed(Array(g.first.dropFirst()))
        // ⌘Z went out: what the writes revealed is no longer there to continue.
        r.undo()
        r.machine.receive(g.reveal[0])
        XCTAssertEqual(r.lastPanel?.sections.count, 1)
    }

    func testTheNextPageCrossfadesInTheSamePanel() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first.dropFirst()))
        // P3's next page: a fresh goal that replaces the one before, reason nextPage (shape from fast-browser.md).
        guard case .segment(var p) = g.reveal[0].event else { return XCTFail() }
        p.reason = .nextPage
        p.replaces = "goal-2-a1"
        let next = GoalProgress(at: g.reveal[0].at, goalId: "goal-5-a1", requestId: nil, event: .segment(p))
        r.machine.receive(next)
        XCTAssertEqual(r.lastMotion, .crossfade)
        let panel = try XCTUnwrap(r.lastPanel)
        XCTAssertEqual(panel.page, 2)
        XCTAssertEqual(panel.title, "Next page: fill 1 field")
        XCTAssertEqual(panel.sections.count, 1)
        XCTAssertEqual(panel.hints.first, Hint(key: "Tab", label: "Fill 1"))
        // The page ⌘Z would restore is gone.
        XCTAssertNil(r.arbiter.snapshot().toast)
        r.tab()
        XCTAssertEqual(r.accepts.last?.goalId, "goal-5-a1")
    }

    func testAStopIsTheHelpersSentenceAndMarksWhereItStopped() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        r.feed(Array(g.first[1...2]))
        let says = "'Email' changed while Caret was filling it, so Caret stopped after 2 of 9 steps."
        r.machine.receive(GoalProgress(at: 1, goalId: "goal-2-a1", requestId: nil, event: .stopped(.init(segment: 0, step: 2, reason: .targetChanged, says: says, freshPlan: nil))))
        let panel = try XCTUnwrap(r.lastPanel)
        XCTAssertEqual(panel.title, says)
        XCTAssertEqual(panel.lead, nil)
        XCTAssertEqual(panel.sections[0].lines[2].state, .failed)
        XCTAssertEqual(panel.hints, [Hint(key: "⌘Z", label: "Undo")])
    }

    func testARefusedAcceptanceEndsWithNothingRun() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.tab()
        let error = #"{"type":"error","v":1,"at":1,"message":"goalAccept refused: the preview expired"}"#
        r.machine.helperError(try JSONDecoder().decode(HelperError.self, from: Data(error.utf8)))
        XCTAssertEqual(r.lastPanel?.title, "Nothing ran: the preview expired.")
        XCTAssertEqual(r.lastPanel?.hints, [])
    }

    func testAStopFromTheDeskIsNotAPanel() throws {
        let g = try Golden()
        let r = Rig()
        XCTAssertFalse(r.machine.start(g.refused))
        XCTAssertNil(r.machine.task)
    }

    func testTheBrowserGoingBehindHidesThePanelAndGivesUpTab() throws {
        let g = try Golden()
        let r = Rig()
        r.machine.start(g.first[0])
        r.machine.appActivated(pid: 7001)
        XCTAssertTrue(r.hidden)
        r.tab()
        XCTAssertEqual(r.accepts, [])
        r.machine.appActivated(pid: Self.chromePid)
        XCTAssertEqual(r.lastMotion, .enter)
        r.tab()
        XCTAssertEqual(r.accepts.count, 1)
    }

    // MARK: - Words and placement

    func testThePressHandOffReadsAsTheUsersOwnStep() {
        XCTAssertEqual(PageTaskCopy.press("'Next' runs the page's own script; you press it"), "You press 'Next'.")
        XCTAssertEqual(PageTaskCopy.press("You press 'Submit Application'"), "You press 'Submit Application'.")
        XCTAssertEqual(PageTaskCopy.press("Check the totals"), "Check the totals.")
    }

    func testThePanelStandsBesideTheFirstFieldOrAtThePagesTopEdge() {
        let screen = CGRect(x: 0, y: 25, width: 1440, height: 875)
        let size = CGSize(width: 340, height: 300)
        let viewport = CGRect(x: 100, y: 150, width: 1200, height: 700)
        let beside = PageTaskPlacement.place(size: size, anchor: PageTaskAnchor(field: CGRect(x: 300, y: 300, width: 400, height: 30), viewport: viewport), screen: screen)
        XCTAssertEqual(beside.side, .right)
        XCTAssertEqual(beside.origin, CGPoint(x: 712, y: 294))
        // No room to the right inside the page: to its left.
        let left = PageTaskPlacement.place(size: size, anchor: PageTaskAnchor(field: CGRect(x: 600, y: 300, width: 600, height: 30), viewport: viewport), screen: screen)
        XCTAssertEqual(left.side, .left)
        XCTAssertFalse(left.origin.x + size.width > 600 - PageTaskPlacement.gap + 0.5)
        // No field: the page's top right corner.
        let top = PageTaskPlacement.place(size: size, anchor: PageTaskAnchor(field: nil, viewport: viewport), screen: screen)
        XCTAssertEqual(top.side, .top)
        XCTAssertEqual(top.origin, CGPoint(x: 1300 - 8 - 340, y: 158))
        // Never off the screen at the bottom.
        let low = PageTaskPlacement.place(size: size, anchor: PageTaskAnchor(field: CGRect(x: 300, y: 860, width: 400, height: 30), viewport: viewport), screen: screen)
        XCTAssertLessThanOrEqual(low.origin.y + size.height, screen.maxY - PageTaskPlacement.margin)
    }
}
