import CaretScreenCore
import CoreGraphics
import Foundation
import XCTest
@testable import CaretHostCore

/// A `SurfaceClock` that moves only when a test advances it. Timers due within an advance fire in
/// time order, each with `now` set to its due time.
final class ManualClock: SurfaceClock {
    private final class Entry: SurfaceTimer {
        var due: Date
        let interval: TimeInterval?
        let fire: () -> Void
        var cancelled = false

        init(due: Date, interval: TimeInterval?, fire: @escaping () -> Void) {
            self.due = due
            self.interval = interval
            self.fire = fire
        }

        func cancel() { cancelled = true }
    }

    private(set) var now = Date(timeIntervalSince1970: 1_790_000_000)
    private var entries: [Entry] = []

    func schedule(after seconds: TimeInterval, repeats: Bool, _ fire: @escaping () -> Void) -> SurfaceTimer {
        let entry = Entry(due: now.addingTimeInterval(seconds), interval: repeats ? seconds : nil, fire: fire)
        entries.append(entry)
        return entry
    }

    func advance(by seconds: TimeInterval) {
        let end = now.addingTimeInterval(seconds)
        while let next = entries.filter({ !$0.cancelled && $0.due <= end }).min(by: { $0.due < $1.due }) {
            now = next.due
            if let interval = next.interval { next.due = next.due.addingTimeInterval(interval) } else { next.cancelled = true }
            next.fire()
        }
        entries.removeAll { $0.cancelled }
        now = end
    }

    /// Timers still scheduled.
    var live: Int { entries.filter { !$0.cancelled }.count }
}

/// The system as `SurfaceMachine` sees it, set by each test: which app is in front, what each app
/// has focused, and which windows lie over which.
final class FakeScreen: SurfaceWorld {
    var allowed: Set<Int32>?
    var frontmostPID: Int32?
    var focused: [Int32: FocusedField] = [:]
    var caretOverride: [Int32: CaretRead] = [:]
    var windows: [SurfaceGate.Window] = []
    var names: [Int32: String] = [Fx.app: "Caret Fixture", Fx.other: "Notes"]
    var character: FigureCharacter = .pebble
    var reduceMotion = false
    /// Every Accessibility read of a focused field, by pid: a background app must never be read.
    var fieldReads: [Int32] = []

    func allows(pid: Int32) -> Bool { allowed?.contains(pid) ?? true }

    func focusedField(pid: Int32) -> FocusedField? {
        fieldReads.append(pid)
        return focused[pid]
    }

    func caret(of field: FocusedField) -> CaretRead {
        if let read = caretOverride[field.identity.pid] { return read }
        guard let frame = field.frame else { return .noCaret }
        return .at(CGRect(x: frame.minX + 4, y: frame.minY + 3, width: 1, height: 16))
    }

    func focusedIdentity(pid: Int32) -> TargetIdentity? { focused[pid]?.identity }
    func windowStack() -> WindowStack { WindowStack(windows: windows, ownPID: Fx.caret) }
    /// 7 pt a character.
    func textWidth(_ text: String, readID: UInt64) -> CGFloat { CGFloat(text.count) * 7 }
    func appName(pid: Int32) -> String? { names[pid] }

    /// The fixture app in front with `element` focused, its window over everything else.
    func front(_ element: Fx.Element = .email, window: WindowIdentity? = Fx.formWindow) {
        frontmostPID = Fx.app
        focused[Fx.app] = Fx.field(element, window: window)
        windows = [Fx.appWindow, Fx.otherWindow]
    }

    /// Another app in front, its window over the fixture's.
    func behind() {
        frontmostPID = Fx.other
        windows = [Fx.otherWindow, Fx.appWindow]
    }
}

/// The synthetic fixture: one form app with two fields, and another app.
enum Fx {
    static let app: Int32 = 5150
    static let other: Int32 = 7000
    static let caret: Int32 = 999

    enum Element: String {
        case email, phone
        var frame: CGRect {
            switch self {
            case .email: return CGRect(x: 200, y: 140, width: 260, height: 22)
            case .phone: return CGRect(x: 200, y: 170, width: 260, height: 22)
            }
        }
    }

    static let formWindow = WindowIdentity(number: 41, title: "Contact details")
    /// A second window of the same app, laid out the same.
    static let twinWindow = WindowIdentity(number: 42, title: "Contact details")
    static let appWindow = SurfaceGate.Window(pid: app, bounds: CGRect(x: 100, y: 100, width: 600, height: 400))
    static let otherWindow = SurfaceGate.Window(pid: other, bounds: CGRect(x: 0, y: 0, width: 1400, height: 900))
    /// A small window of another app over the email field's caret.
    static let cover = SurfaceGate.Window(pid: other, bounds: CGRect(x: 150, y: 120, width: 200, height: 80))

    static func identity(_ element: Element, window: String = "w41", value: String = "") -> TargetIdentity {
        TargetIdentity(pid: app, bundleID: "dev.caret.fixture", windowID: window, elementID: element.rawValue, elementRevision: UTF16Text.digest(value))
    }

    static func field(_ element: Element, window: WindowIdentity? = formWindow, value: String = "") -> FocusedField {
        let windowID = window?.number.map { "w\($0)" } ?? "w41"
        return FocusedField(
            identity: identity(element, window: windowID, value: value), value: value,
            selection: .caret(UTF16Text.length(value)), frame: element.frame, window: window, readID: 1
        )
    }

    static func frameJSON(_ frame: CGRect) -> String { "[\(frame.minX),\(frame.minY),\(frame.width),\(frame.height)]" }

    static func decode(_ json: String) -> HelperOffer {
        HelperOffer(try! HelperInbound.decode(Data(json.utf8)))!
    }

    /// Two values from a mail for the email and phone fields (the golden `popup` line).
    static func fillPopup(key: String = "fill-2", at element: Element = .email) -> HelperOffer {
        decode("""
        {"type":"popup","v":1,"offerKey":"\(key)","at":1,"field":{"pid":\(app),"windowId":"\(app)-1","key":"k:\(element.rawValue)","frame":\(frameJSON(element.frame))},"spec":{"v":1,"id":"\(key)","figure":"offering","blocks":[{"type":"header","title":{"text":"Fill 2 fields","ref":{"rule":"count","derived":[{"node":"n"}]}}},{"type":"source","value":{"text":"Mail Fixture, Order ORD-2026-48213","ref":{"node":"m"}}},{"type":"fields","rows":[{"destination":{"text":"Email","ref":{"node":"e"}},"value":{"text":"dana.whitfield@example.com","ref":{"node":"m","quote":"dana.whitfield@example.com"}},"state":"ready"},{"destination":{"text":"Phone","ref":{"node":"p"}},"value":{"text":"+1 512 555 0142","ref":{"node":"m","quote":"+1 512 555 0142"}},"state":"ready"}]},{"type":"actions","items":[{"id":"fillAll","label":"Fill all","key":"tab"}]}]}}
        """)
    }

    /// "Finish the rest" in another app (the golden `action` line, without variants).
    static func action(key: String = "offer-5", at element: Element = .email) -> HelperOffer {
        decode("""
        {"type":"action","v":1,"offerKey":"\(key)","at":1,"field":{"pid":\(app),"windowId":"\(app)-1","key":"k:\(element.rawValue)","frame":\(frameJSON(element.frame))},"app":"Sheet Fixture","endState":{"text":"Finish the rest: 2 more values","ref":{"rule":"loopFinish","derived":[{"node":"n","quote":"Dev Patel"}]}},"actions":[{"id":"finish","label":"Finish","key":"tab"}]}
        """)
    }

    static func alternatives(key: String = "offer-4.0", at element: Element = .email, candidates: [String] = ["Cara Diaz", "Cal Duarte"], quoted: Bool = true) -> HelperOffer {
        let values = candidates.map { #"{"text":"\#($0)","ref":{"node":"n","quote":"\#($0)"}}"# }.joined(separator: ",")
        return decode("""
        {"type":"alternatives","v":1,"offerKey":"\(key)","at":1,"field":{"pid":\(app),"windowId":"\(app)-1","key":"k:\(element.rawValue)","frame":\(frameJSON(element.frame))},"candidates":[\(values)],"quoted":\(quoted)}
        """)
    }

    static func progress(_ task: String, _ phase: TaskProgress.Phase, detail: String? = nil) -> TaskProgress {
        let json = """
        {"type":"taskProgress","v":1,"at":1,"taskId":"\(task)","planId":"p","phase":"\(phase.rawValue)","step":null,"steps":2,"says":null,"detail":\(detail.map { "\"\($0)\"" } ?? "null")}
        """
        return try! JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
    }

    static func tab(_ pid: Int32 = app) -> KeyStroke { .tab(to: pid) }
    static func esc(_ pid: Int32 = app) -> KeyStroke { KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: pid) }
    static func down(_ pid: Int32 = app) -> KeyStroke { KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: pid) }
    static func cmdZ(_ pid: Int32 = app) -> KeyStroke { KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: pid) }
    static func type(_ text: String, _ pid: Int32 = app) -> KeyStroke { .typing(text, to: pid) }
}

/// One `SurfaceMachine` with a fake screen and clock, and the arbiter's decisions routed to it as
/// the tap thread and `HostRuntime` route them.
final class SurfaceRig {
    let arbiter: OfferArbiter
    let clock: ManualClock
    let screen = FakeScreen()
    let machine: SurfaceMachine
    /// Commands since the last `takeLog`, in a short readable form; `publish` and counts left out.
    private(set) var log: [String] = []
    private(set) var counts: [String] = []
    private(set) var sent: [String] = []
    /// The `at` of each offerAccept and offerStop sent, in milliseconds.
    private(set) var sentAt: [Int64] = []
    /// A text claim the insertion queue is still writing (`inserted` ends it).
    private(set) var inserting: UInt64?
    /// The fill line's toast, as `FillCoordinator` holds it: dropped when another toast takes the
    /// arbiter's slot and says so (`toastSlotTaken`).
    private(set) var fillToastID: UInt64?
    private(set) var panels: [PanelContent] = []
    /// What `sendToHelper` answers: false is a helper that is not connected.
    var helperConnected = true
    /// Called with each message as it is sent, before the machine hears whether it went.
    var onSend: ((SurfaceSend) -> Void)?
    /// A decision the tap made that main has not handled yet (`pressLate`, `deliver`).
    private var inFlight: OfferArbiter.Decision?
    /// Called on `toastSlotTaken`, as `HostRuntime` calls `FillCoordinator.toastChanged`.
    var onToastSlotTaken: (() -> Void)?

    /// `arbiter` and `clock` are shared when a test runs `FillMachine` beside this machine.
    init(headless: Bool = false, arbiter: OfferArbiter = OfferArbiter(), clock: ManualClock = ManualClock()) {
        self.arbiter = arbiter
        self.clock = clock
        machine = SurfaceMachine(arbiter: arbiter, world: screen, clock: clock, headless: headless)
        machine.output = { [unowned self] command in self.record(command) }
        machine.sendToHelper = { [unowned self] message in
            self.onSend?(message)
            switch message {
            case .accept(let a): self.sent.append("accept \(a.offerId) \(a.actionId)"); self.sentAt.append(a.at)
            case .stop(let s): self.sent.append("stop \(s.offerId)"); self.sentAt.append(s.at)
            case .control(let c): self.sent.append("\(c.action.rawValue) \(c.taskId)")
            }
            return self.helperConnected
        }
        let machine = machine
        arbiter.onDisplaced = { offer in machine.displaced(offer) }
    }

    private func record(_ command: SurfaceCommand) {
        switch command {
        case .publish: return
        case .count(let name): counts.append(name)
        case .drawAlternatives(let d):
            log.append("alternatives \(d.entering ? "enter" : "redraw") \(d.currentText)\(d.ui.open ? " open" : "")\(d.quoted ? " quoted" : "")")
        case .typedThrough(_, _, let remainder, _): log.append("typed rest \(remainder)")
        case .clearCaret: log.append("clear caret")
        case .showPanel(let content, let text, let placement):
            panels.append(content)
            switch placement {
            case .atCaret(_, let entering): log.append("panel \(entering ? "enter" : "redraw") \(text)")
            case .inPlace: log.append("line \(text)")
            }
        case .hidePanel(let exit): log.append("hide \(exit)")
        case .workingChanged(let on): log.append(on ? "working on" : "working off")
        case .toastSlotTaken:
            log.append("toast slot")
            // FillCoordinator.toastChanged: its toast is gone once the slot holds another.
            if let id = fillToastID, arbiter.snapshot().toast?.id != id { fillToastID = nil }
            onToastSlotTaken?()
        }
    }

    func takeLog() -> [String] {
        defer { log = [] }
        return log
    }

    func press(_ key: KeyStroke) { route(arbiter.handleKeyDown(key, now: clock.now)) }

    /// The tap decides the key now; main handles the decision at `deliver`.
    func pressLate(_ key: KeyStroke) { inFlight = arbiter.handleKeyDown(key, now: clock.now) }

    func deliver() {
        guard let decision = inFlight else { return XCTFail("nothing in flight") }
        inFlight = nil
        route(decision)
    }

    /// `TapThread.handle` and `HostRuntime`'s callbacks, without the threads.
    private func route(_ decision: OfferArbiter.Decision) {
        switch decision {
        case .consume(let claim):
            // The tap hands a text claim to the insertion queue before main hears of it; a headless
            // host refuses it there. Here it stays in flight until `inserted`.
            if claim.insertsText {
                if machine.headless { arbiter.abandon(claimID: claim.claimID, reason: "headless") } else { inserting = claim.claimID }
            }
            machine.claimed(claim)
        case .undo(let grant):
            if grant.taskID != nil { machine.undoStarted(grant) }
        case .closeToast: machine.offerChanged(.toastDismissed)
        case .navigate(let offerID, let ui): machine.navigated(offerID: offerID, ui: ui)
        case .closeOffer: machine.offerChanged(.closed)
        case .stopWork(let line): machine.stopWork(line)
        case .closeStatus: machine.offerChanged(.statusDismissed)
        case .pass(.noOffer), .pass(.otherApp), .pass(.modifierOnly): break
        case .pass(let reason): machine.offerChanged(reason)
        }
    }

    /// The insertion queue finished writing the text claim.
    func inserted() {
        guard let claimID = inserting else { return XCTFail("no text claim in flight") }
        inserting = nil
        arbiter.finishInsertion(claimID: claimID, error: nil)
    }

    /// The fill line's own toast takes the arbiter's toast slot, as `FillCoordinator` does.
    func fillLineToast() {
        fillToastID = arbiter.showToast(UndoGrant(
            target: Fx.identity(.phone), priorValue: "", writtenValue: "x", insertedStart: 0, insertedLength: 1, origin: nil,
            createdAt: clock.now
        ))
        machine.toastChanged()
    }
}
