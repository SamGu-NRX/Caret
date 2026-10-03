import CaretScreenCore
import CoreGraphics
import Foundation
import XCTest
@testable import CaretHostCore

/// One thing that happens to the surface: the screen changes, the helper speaks, a key is
/// pressed, time passes. A transition is a list of steps with checks between them.
enum Step {
    case screen((FakeScreen) -> Void)
    /// A helper offer, optionally naming its field's window.
    case offer(HelperOffer, window: WindowIdentity? = nil)
    case press(KeyStroke)
    /// The tap decides the key now; main handles the decision at `deliver`.
    case pressLate(KeyStroke)
    case deliver
    case wait(TimeInterval)
    case progress(String, TaskProgress.Phase, detail: String? = nil)
    case withdraw(String, OfferWithdrawn.Reason)
    /// The focus observer reports a new focused element in the fixture app.
    case focusMoved(Fx.Element)
    /// Another app activated: the shown surface is rechecked at once.
    case activated
    case fillLineToast
    case helperDown
    /// Checks the state now.
    case expect(Expect)
    /// Checks the commands issued since the last `did`, in order.
    case did([String])
    /// Checks every message sent to the helper so far, in order.
    case sent([String])
}

/// A fact about the state after the steps so far.
enum Expect {
    /// The helper key of the offer shown; nil when nothing is.
    case shown(String?)
    case held(SurfaceGate.Hold?)
    /// What the panel says (the machine's record, drawn or headless).
    case line(String?)
    case panelUp(Bool)
    /// The toast's caption in the debug state.
    case toast(String?)
    case workingOn(String?)
    /// The arbiter holds an offer Tab could take.
    case tabTakes(Bool)
    /// The arbiter holds a toast ⌘Z could take for the fixture app.
    case undoOwned(Bool)
    /// The arbiter holds a working or result line Esc could act on.
    case escOwned(Bool)
    /// The last panel drawn showed this line.
    case lastLine(LineContent)
    case counted(String)
    /// Accessibility reads of focused fields, by pid, so far.
    case fieldReads([Int32])
    case custom(String, (SurfaceRig) -> Bool)
}

/// A named list of steps, run on a fresh rig.
struct Transition {
    let name: String
    var headless = false
    let steps: [Step]
    let file: StaticString
    let line: UInt

    init(_ name: String, headless: Bool = false, file: StaticString = #filePath, line: UInt = #line, _ steps: [Step]) {
        self.name = name
        self.headless = headless
        self.steps = steps
        self.file = file
        self.line = line
    }
}

extension XCTestCase {
    func play(_ transitions: [Transition]) {
        for t in transitions { play(t) }
    }

    func play(_ t: Transition) {
        let rig = SurfaceRig(headless: t.headless)
        for (index, step) in t.steps.enumerated() {
            let at = "\(t.name), step \(index + 1)"
            switch step {
            case .screen(let change): change(rig.screen)
            case .offer(let offer, let window): rig.machine.receive(offer, window: window)
            case .press(let key): rig.press(key)
            case .pressLate(let key): rig.pressLate(key)
            case .deliver: rig.deliver()
            case .wait(let seconds): rig.clock.advance(by: seconds)
            case .progress(let task, let phase, let detail): rig.machine.taskProgress(Fx.progress(task, phase, detail: detail))
            case .withdraw(let key, let reason): rig.machine.withdrawn(OfferWithdrawn(at: 1, id: key, reason: reason))
            case .focusMoved(let element):
                rig.screen.focused[Fx.app] = Fx.field(element)
                rig.machine.focusChanged(Fx.identity(element))
            case .activated: rig.machine.recheckVisibility()
            case .fillLineToast: rig.fillLineToast()
            case .helperDown: rig.helperConnected = false
            case .did(let expected):
                XCTAssertEqual(rig.takeLog(), expected, at, file: t.file, line: t.line)
            case .sent(let expected):
                XCTAssertEqual(rig.sent, expected, at, file: t.file, line: t.line)
            case .expect(let fact):
                check(fact, rig, at, t.file, t.line)
            }
        }
    }

    private func check(_ fact: Expect, _ rig: SurfaceRig, _ at: String, _ file: StaticString, _ line: UInt) {
        let m = rig.machine
        let arbiter = rig.arbiter.snapshot()
        switch fact {
        case .shown(let key): XCTAssertEqual(m.shown?.offerKey, key, "\(at): shown", file: file, line: line)
        case .held(let hold): XCTAssertEqual(m.held, hold, "\(at): held", file: file, line: line)
        case .line(let text): XCTAssertEqual(m.lineText, text, "\(at): line", file: file, line: line)
        case .panelUp(let up): XCTAssertEqual(m.panelUp, up, "\(at): panel", file: file, line: line)
        case .toast(let caption): XCTAssertEqual(m.toastInfo?.caption, caption, "\(at): toast", file: file, line: line)
        case .workingOn(let key): XCTAssertEqual(m.workingOn, key, "\(at): working on", file: file, line: line)
        case .tabTakes(let takes): XCTAssertEqual(arbiter.current != nil, takes, "\(at): Tab takes an offer", file: file, line: line)
        case .undoOwned(let owned):
            let live = arbiter.toast.map { !$0.isExpired(at: rig.clock.now) } ?? false
            XCTAssertEqual(live, owned, "\(at): ⌘Z owned", file: file, line: line)
        case .escOwned(let owned): XCTAssertEqual(arbiter.statusLine != nil, owned, "\(at): Esc line", file: file, line: line)
        case .lastLine(let content):
            guard case .line(let drawn)? = rig.panels.last else { return XCTFail("\(at): no line drawn", file: file, line: line) }
            XCTAssertEqual(drawn, content, "\(at): line drawn", file: file, line: line)
        case .counted(let name): XCTAssertTrue(rig.counts.contains(name), "\(at): counted \(name) in \(rig.counts)", file: file, line: line)
        case .fieldReads(let pids): XCTAssertEqual(rig.screen.fieldReads, pids, "\(at): field reads", file: file, line: line)
        case .custom(let what, let test): XCTAssertTrue(test(rig), "\(at): \(what)", file: file, line: line)
        }
    }
}
