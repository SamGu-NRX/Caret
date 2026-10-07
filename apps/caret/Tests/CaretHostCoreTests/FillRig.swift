import CaretScreenCore
import CoreGraphics
import Foundation
import XCTest
@testable import CaretHostCore

/// The system as `FillMachine` sees it: which app is in front, what each app has focused, and
/// what would hide a surface.
final class FakeFillWorld: FillWorld {
    var allowed: Set<Int32>?
    var frontmostPID: Int32?
    var focused: [Int32: FillFieldRead] = [:]
    /// A surface's anchor is covered by another window.
    var covered = false
    /// Every Accessibility read of a focused field, by pid.
    var fieldReads: [Int32] = []
    /// Source windows that have closed, and ones whose read fails, by title.
    var closedSources: Set<String> = []
    var unknownSources: Set<String> = []

    func sourceOpen(_ source: FillOrigin.Window) -> Bool? {
        source.pid == nil || unknownSources.contains(source.title) ? nil : !closedSources.contains(source.title)
    }

    /// How far the fixture's fields have moved down since the proposal (a page that scrolled or
    /// put a message above them), and whether binding finds their elements.
    var layoutShift: CGFloat = 0
    var bindable = true
    private(set) var bindCalls = 0

    func frame(_ element: Fx.Element) -> CGRect { element.frame.offsetBy(dx: 0, dy: layoutShift) }

    /// The window ids binding was asked for.
    private(set) var bindWindows: [String] = []

    func elementIDs(pid: Int32, at frames: [String: Frame], window windowID: String) -> [String: String] {
        bindCalls += 1
        bindWindows.append(windowID)
        guard bindable, windowID == "5150-1" else { return [:] }
        var found: [String: String] = [:]
        for (key, frame) in frames {
            for element in [Fx.Element.email, .phone] {
                let f = self.frame(element)
                if FillSelection.matches(frame, Frame(x: f.minX, y: f.minY, width: f.width, height: f.height)) { found[key] = element.rawValue }
            }
        }
        return found
    }

    func allows(pid: Int32, bundleID: String?) -> Bool { allowed?.contains(pid) ?? true }
    /// The bundle id each running pid has; any other pid runs the fixture.
    var bundles: [Int32: String] = [:]
    func bundleID(pid: Int32) -> String? { bundles[pid] ?? "dev.caret.fixture" }

    /// H10: the page field the helper says has focus, by browser pid (`PageFocusSource`).
    var pages: [Int32: PageField] = [:]
    func pageFocus(pid: Int32) -> PageField? { pages[pid].flatMap { $0.key == nil ? nil : $0 } }

    func focusedField(pid: Int32) -> FillFieldRead? {
        fieldReads.append(pid)
        return focused[pid]
    }

    /// `Visibility.hold`, from the fake's state, in the same order: app in front, then focus, then
    /// the anchor uncovered.
    func hold(for target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool) -> SurfaceGate.Hold? {
        guard frontmostPID == target.pid else { return .appNotFront }
        if requireFocus, PageWindow.isPage(target.windowID) {
            let page = pageFocus(pid: target.pid)
            guard page?.key == target.elementID, page?.windowId == target.windowID else { return .fieldNotFocused }
        } else if requireFocus {
            let live = focused[target.pid]?.identity
            guard live?.elementID == target.elementID, live?.windowID == target.windowID else { return .fieldNotFocused }
        }
        return covered ? .covered : nil
    }

    /// The form app in front with `element` focused, holding `value`.
    func front(_ element: Fx.Element = .email, value: String = "") {
        frontmostPID = Fx.app
        focus(element, value: value)
    }

    func focus(_ element: Fx.Element, value: String = "") {
        focused[Fx.app] = FillFieldRead(
            identity: Fx.identity(element, window: "5150-1", value: value), value: value,
            selection: .caret(UTF16Text.length(value)), secure: false, frame: frame(element), readID: 7
        )
    }
}

enum FillFx {
    static let email = "dana.whitfield@example.com"
    static let phone = "+1 512 555 0142"
    static let caption = "from Caret Fixture, Reference"

    /// A proposal for the fixture's form: email and phone, both quoted from the Reference window.
    static var proposalLine: String { line() }

    /// The id of the About entry `memoryProposal` fills email from.
    static let emailEntry = "about-email"

    static func proposal(
        id: String = "fill-1", email: String? = FillFx.email, phone: String? = FillFx.phone, at: Int64 = 1_790_000_000_500,
        fromMemory: [Fx.Element: String] = [:], identity: [Fx.Element: String] = [:]
    ) -> FillProposal {
        let json = line(id: id, email: email, phone: phone, at: at, fromMemory: fromMemory, identity: identity)
        guard case .fillProposal(let proposal) = try! HelperInbound.decode(Data(json.utf8)) else { fatalError("not a proposal") }
        return proposal
    }

    /// Email from what the user told Caret (entry `emailEntry`), phone from the Reference window.
    static func memoryProposal(id: String = "fill-m") -> FillProposal {
        proposal(id: id, fromMemory: [.email: emailEntry])
    }

    /// `fromMemory`: the fields whose value comes from an About entry (its id) rather than a window. `identity` (H1): the
    /// window values that rest on an entry (its id) as the user's own email (`FillField.basis.identity`).
    static func line(
        id: String = "fill-1", email: String? = FillFx.email, phone: String? = FillFx.phone, at: Int64 = 1_790_000_000_500,
        fromMemory: [Fx.Element: String] = [:], identity: [Fx.Element: String] = [:]
    ) -> String {
        func field(_ element: Fx.Element, _ value: String?) -> String {
            let f = element.frame
            let entry = fromMemory[element]
            let source = value.map { _ in entry == nil ? #"{"pid":5150,"windowId":"5150-2","bundleId":"dev.caret.fixture","appName":"Caret Fixture","windowTitle":"Reference","nodeKey":"n","kind":"email"}"# : "null" } ?? "null"
            let memory = value.flatMap { _ in entry.map { #"{"id":"\#($0)","label":"Email","says":"what you told Caret"}"# } } ?? "null"
            let v = value.map { "\"\($0)\"" } ?? "null"
            let asks = #"{"choice":"\#(value == nil ? "none" : "c1")","confidence":0.9,"value":\#(v)}"#
            let basis = identity[element].map { #","basis":{"identity":{"memoryId":"\#($0)","kind":"email","key":"\#(value ?? "")"}}"# } ?? ""
            return #"{"key":"k:\#(element.rawValue)","frame":[\#(f.minX),\#(f.minY),\#(f.width),\#(f.height)],"descriptor":"d","choice":"\#(value == nil ? "none" : "c1")","confidence":0.9,"value":\#(v),"source":\#(source),"memory":\#(memory),"withheld":null,"asks":[\#(asks),\#(asks)]\#(basis)}"#
        }
        return #"{"type":"fillProposal","v":1,"id":"\#(id)","at":\#(at),"pid":5150,"windowId":"5150-1","bundleId":"dev.caret.fixture","triggerKey":"k:email","fields":[\#(field(.email, email)),\#(field(.phone, phone))],"candidates":4,"jev":{"model":"m","latencyMs":1,"inputTokens":1,"costUsd":0},"cutoff":0.75}"#
    }
}

/// One `FillMachine` with a fake world and clock, and the arbiter's decisions routed to it as the
/// tap thread and `HostRuntime` route them.
final class FillRig {
    let arbiter: OfferArbiter
    let clock: ManualClock
    let world = FakeFillWorld()
    let machine: FillMachine
    private(set) var log: [String] = []
    private(set) var counts: [String] = []
    private(set) var sent: [FillResult] = []
    private(set) var shownTriggers: [FillTrigger] = []
    /// The fill claim the insertion queue is writing.
    private(set) var inserting: Claim?
    /// Called on `toastSlotTaken`, as `HostRuntime` calls `SurfaceCoordinator.toastChanged`.
    var onToastSlotTaken: (() -> Void)?
    /// Every offer drawn, for what the log line leaves out (`fillAll`).
    var draws: [FillDraw] = []

    init(arbiter: OfferArbiter = OfferArbiter(), clock: ManualClock = ManualClock()) {
        self.arbiter = arbiter
        self.clock = clock
        machine = FillMachine(arbiter: arbiter, world: world, clock: clock)
        machine.output = { [unowned self] command in self.record(command) }
        let machine = machine
        arbiter.onDisplaced = { offer in machine.displaced(offer) }
    }

    private func record(_ command: FillCommand) {
        switch command {
        case .publish: return
        case .count(let name): counts.append(name)
        case .watchApp(let pid): log.append("watch \(pid)")
        case .unwatchApp(let pid): log.append("unwatch \(pid)")
        case .drawOffer(let d):
            draws.append(d)
            log.append("offer \(d.value) \(d.caption) \(d.line)")
        case .hideOffer(let byTyping): log.append("hide offer\(byTyping ? " typing" : "")")
        case .markWorking: log.append("working")
        case .fillAll(let id): log.append("fillAll \(id)")
        case .fillField(let id, let key): log.append("fillField \(id) \(key)")
        case .undoTask(let id): log.append("undoTask \(id)")
        case .log(let line): log.append("log \(line)")
        case .drawToast(let d): log.append("toast \(d.kind.rawValue) \([d.lead, d.text].compactMap { $0 }.joined(separator: " "))\(d.keycap.map { " \($0.key)" } ?? "")")
        case .hideToast(let byTyping): log.append("hide toast\(byTyping ? " typing" : "")")
        case .hideAll: log.append("hide all")
        case .remember: return
        case .toastSlotTaken:
            log.append("toast slot")
            onToastSlotTaken?()
        case .send(let result): sent.append(result)
        case .offerShown(let trigger): shownTriggers.append(trigger)
        }
    }

    @discardableResult
    func takeLog() -> [String] {
        defer { log = [] }
        return log
    }

    func propose(_ proposal: FillProposal = FillFx.proposal(), at uptime: UInt64 = 1) {
        machine.receive(proposal, at: uptime)
    }

    func press(_ key: KeyStroke) { route(arbiter.handleKeyDown(key, now: clock.now)) }

    /// `TapThread.handle` and `HostRuntime`'s callbacks, without the threads, for this machine.
    func route(_ decision: OfferArbiter.Decision) {
        switch decision {
        case .consume(let claim):
            if claim.insertsText { inserting = claim }
            machine.claimed(claim)
        case .undo(let grant): machine.undoStarted(grant)
        case .closeToast: machine.offerChanged(.toastDismissed)
        case .closeOffer: machine.offerChanged(.closed)
        case .closeStatus: machine.offerChanged(.statusDismissed)
        case .navigate, .stopWork, .pass(.noOffer), .pass(.otherApp), .pass(.modifierOnly): break
        case .pass(let reason): machine.offerChanged(reason)
        }
    }

    /// The insertion queue wrote the claim. `verified` true leaves an undo grant for the field.
    func inserted(verified: Bool = true, reason: String? = nil, grantsUndo: Bool = true) {
        guard let claim = inserting else { return XCTFail("no fill claim in flight") }
        inserting = nil
        arbiter.finishInsertion(claimID: claim.claimID, error: verified ? nil : reason)
        var grant: UndoGrant?
        if verified, grantsUndo {
            var target = claim.offer.target
            target.elementRevision = UTF16Text.digest(claim.insertionText)
            grant = UndoGrant(
                target: target, priorValue: "", writtenValue: claim.insertionText, insertedStart: 0,
                insertedLength: UTF16Text.length(claim.insertionText), origin: claim.offer.kind.fillOrigin, createdAt: clock.now
            )
        }
        machine.insertionFinished(FillInsertion(
            claim: claim, verified: verified, rejected: false, reason: verified ? nil : reason,
            method: .axSelectedText, undo: grant, insertedLength: UTF16Text.length(claim.insertionText)
        ))
    }

    /// S2: the insertion queue could not confirm the claim's write (`reason`), and its read of the
    /// empty field afterwards found `held` (nil: unreadable). The grant is what
    /// `InsertionExecutor.run` leaves: armed before the write, kept by `UnconfirmedInsert.grant`.
    func insertedUnconfirmed(held: String?, reason: String = "revoked") {
        guard let claim = inserting else { return XCTFail("no fill claim in flight") }
        inserting = nil
        arbiter.finishInsertion(claimID: claim.claimID, error: reason)
        let intent = UnconfirmedInsert.Intent(before: "", start: 0, end: 0, replacement: claim.insertionText)
        let edit = InsertionGuard.ApprovedEdit(
            target: claim.offer.target, replaceStart: 0, replaceEnd: 0, replacement: claim.insertionText, resultingValue: claim.insertionText
        )
        let armed = UndoGrant.armed(target: claim.offer.target, priorValue: "", edit: edit, origin: claim.offer.kind.fillOrigin, writeID: 7)
        let report = UnconfirmedInsert.read(intent, held: held)
        var grant = UnconfirmedInsert.grant(armed: armed, verified: false, report: report)
        grant?.createdAt = clock.now
        machine.insertionFinished(FillInsertion(
            claim: claim, verified: false, rejected: false, reason: reason, method: .pastePid, undo: grant,
            insertedLength: UTF16Text.length(claim.insertionText), recovery: report
        ))
    }
}
