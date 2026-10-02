// One worker per app process. All of its Accessibility reads run on its own serial queue, so a
// slow or hung app delays only its own walks. The worker owns the app's window registry, the map
// from live elements to keys from its latest walks, and the event-driven walk schedule.
import ApplicationServices
import CaretScreenCore
import Foundation

/// Shared by all workers: where messages go, how values are detected, and an optional E1 sink.
public final class ReaderContext: @unchecked Sendable {
    public let emitter: Emitter
    public let detector = TypedValueDetector()
    private let seqLock = NSLock()
    private var seq = 0
    /// Called on the main thread for every AX notification, before any filtering. Experiment E1 only.
    public var notificationTap: (@Sendable (_ t: Date, _ pid: pid_t, _ name: String, _ element: AXRef) -> Void)?
    public var log: @Sendable (String) -> Void = { FileHandle.standardError.write(Data(("[caret-screen] " + $0 + "\n").utf8)) }

    public init(emitter: Emitter) { self.emitter = emitter }

    func nextSeq() -> Int {
        seqLock.lock(); defer { seqLock.unlock() }
        seq += 1
        return seq
    }
}

struct WindowInfo {
    let id: String
    var kind: String
    var lastWalk: CFAbsoluteTime = 0
    var contentHash: Int?
    var contexts: [AXRef: KeyContext] = [:]
}

private let observerCallback: AXObserverCallback = { _, element, notification, refcon in
    guard let refcon else { return }
    let worker = Unmanaged<AppWorker>.fromOpaque(refcon).takeUnretainedValue()
    worker.notified(notification as String, AXRef(element))
}

public final class AppWorker: @unchecked Sendable {
    public let pid: pid_t
    public let app: AppRef
    let appPart: String
    let ax: AXUIElement
    let queue: DispatchQueue
    let ctx: ReaderContext

    // Confined to `queue`.
    private var windows: [AXRef: WindowInfo] = [:]
    private var nextWindow = 1
    private var focusedWindow: AXRef?
    private var lastFocusEmitted: AXRef?
    private var eventDriven = false
    private var frontmost = false
    private var observer: AXObserver?
    private var nextAllowed: CFAbsoluteTime = 0
    private var walkScheduled = false
    private var pendingFull = false
    private var pendingFocus = false
    private var pendingSubtrees: [AXRef] = []
    private var focusEmptyAtEvent: (AXRef, Bool)?
    private var focusElement: AXRef?
    private var pendingRegistrations: [String] = []

    /// Notifications that schedule work. Registered on the application element while the app is event-driven.
    static let notifications: [String] = [
        kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
        kAXWindowCreatedNotification, kAXValueChangedNotification, kAXTitleChangedNotification,
        kAXUIElementDestroyedNotification, kAXLayoutChangedNotification, kAXRowCountChangedNotification,
        kAXSelectedChildrenChangedNotification, kAXSelectedTextChangedNotification, kAXCreatedNotification,
        "AXLoadComplete", "AXLiveRegionChanged", kAXSelectedRowsChangedNotification,
    ]

    public init(pid: pid_t, app: AppRef, ctx: ReaderContext) {
        self.pid = pid
        self.app = app
        self.appPart = ElementKey.appPart(bundleId: app.bundleId.isEmpty ? nil : app.bundleId, name: app.name)
        self.ax = AXUIElementCreateApplication(pid)
        self.queue = DispatchQueue(label: "caret.screen.app.\(pid)", qos: .utility)
        self.ctx = ctx
        AXUIElementSetMessagingTimeout(ax, AX.elementTimeout)
    }

    // MARK: - control (called from the coordinator; hops onto the queue)

    /// Event-driven apps get observers and walks on notifications. `frontmost` is whether the user is in this app.
    func setEventDriven(_ on: Bool, frontmost: Bool) {
        queue.async {
            self.frontmost = frontmost
            guard on != self.eventDriven else { return }
            self.eventDriven = on
            on ? self.addObserver() : self.removeObserver()
        }
    }

    func activate() {
        queue.async {
            // Returning to the same field is a new focus for the helper, so the last emitted one is forgotten.
            self.lastFocusEmitted = nil
            self.focusChanged(element: nil)
        }
    }

    /// Walks the window the user is leaving, once, at the moment of the switch.
    func leave() {
        queue.async {
            self.lastFocusEmitted = nil
            if let w = self.focusedWindow { self.walkWindow(w, reason: .leave, isFocused: false) }
        }
    }

    func backgroundPass(reason: WalkReason, minAge: TimeInterval) {
        queue.async { self.pass(reason: reason, minAge: minAge) }
    }

    func stop() {
        queue.sync {
            self.removeObserver()
            for (_, info) in self.windows { self.ctx.emitter.send(.windowClosed(WindowClosed(at: nowMs(), windowId: info.id))) }
            self.windows.removeAll()
        }
    }

    // MARK: - notifications

    /// Runs on the main thread inside the observer callback. Timestamp first, work later.
    func notified(_ name: String, _ el: AXRef) {
        if let tap = ctx.notificationTap { tap(Date(), pid, name, el) }
        queue.async { self.handle(name, el) }
    }

    private func handle(_ name: String, _ el: AXRef) {
        guard eventDriven else { return }
        switch name {
        case kAXFocusedUIElementChangedNotification:
            focusChanged(element: el)
        case kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification:
            focusChanged(element: nil)
        case kAXWindowCreatedNotification:
            walkWindow(el, reason: .event, isFocused: el == currentFocusedWindow())
        case kAXUIElementDestroyedNotification:
            if let info = windows.removeValue(forKey: el) {
                ctx.emitter.send(.windowClosed(WindowClosed(at: nowMs(), windowId: info.id)))
                if focusedWindow == el { focusedWindow = nil }
            } else {
                request(full: true, subtree: nil)
            }
        case kAXTitleChangedNotification:
            request(full: windows[el] != nil, subtree: windows[el] == nil ? el : nil)
        case kAXSelectedTextChangedNotification:
            break // caret movement; the value-changed notification covers edits
        case kAXValueChangedNotification, kAXRowCountChangedNotification, kAXSelectedChildrenChangedNotification,
             kAXSelectedRowsChangedNotification, "AXLiveRegionChanged":
            request(full: false, subtree: el)
        default:
            request(full: true, subtree: nil)
        }
    }

    /// Registers the observer. An app that is busy answers "cannot complete" (seen for TextEdit and
    /// Activity Monitor during E1), so those notifications are retried a few times, a second apart.
    private func addObserver(attempt: Int = 0) {
        if attempt > 0 {
            guard eventDriven, let obs = observer else { return }
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            let retry = pendingRegistrations
            pendingRegistrations = retry.filter { AXObserverAddNotification(obs, ax, $0 as CFString, refcon) == .cannotComplete }
            if !pendingRegistrations.isEmpty {
                if attempt < 5 { queue.asyncAfter(deadline: .now() + 1) { self.addObserver(attempt: attempt + 1) } } else {
                    ctx.log("\(app.name): gave up observing \(pendingRegistrations.joined(separator: ","))")
                }
            }
            return
        }
        guard observer == nil else { return }
        var obs: AXObserver?
        guard AXObserverCreate(pid, observerCallback, &obs) == .success, let obs else {
            ctx.log("AXObserverCreate failed for \(app.name)")
            return
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var failed: [String] = []
        pendingRegistrations = []
        for n in Self.notifications {
            let r = AXObserverAddNotification(obs, ax, n as CFString, refcon)
            if r == .cannotComplete { pendingRegistrations.append(n) } else if r != .success && r != .notificationAlreadyRegistered {
                failed.append("\(n)(\(r.rawValue))")
            }
        }
        if !failed.isEmpty { ctx.log("\(app.name): cannot observe \(failed.joined(separator: ","))") }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
        if !pendingRegistrations.isEmpty { queue.asyncAfter(deadline: .now() + 1) { self.addObserver(attempt: 1) } }
    }

    private func removeObserver() {
        guard let obs = observer else { return }
        for n in Self.notifications { AXObserverRemoveNotification(obs, ax, n as CFString) }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = nil
    }

    // MARK: - scheduling

    /// At most one event-driven walk per 100 ms, and after a slow walk, wait three times its length,
    /// so the reader spends at most about a quarter of its time in one app. The factor is an assumption.
    private func request(full: Bool, subtree: AXRef?) {
        if full { pendingFull = true } else if let s = subtree, !pendingSubtrees.contains(s) { pendingSubtrees.append(s) }
        guard !walkScheduled else { return }
        walkScheduled = true
        let delay = max(0, nextAllowed - CFAbsoluteTimeGetCurrent())
        queue.asyncAfter(deadline: .now() + delay) { self.runPending() }
    }

    private func runPending() {
        walkScheduled = false
        let start = CFAbsoluteTimeGetCurrent()
        let focus = pendingFocus
        var full = pendingFull || focus
        let subtrees = pendingSubtrees
        pendingFull = false; pendingFocus = false; pendingSubtrees = []

        if !full {
            for s in subtrees where !walkSubtree(s) {
                full = true
                break
            }
        }
        // The window holding the focused element, as the last focus event named it. A frontmost app's
        // own focused-window attribute is trusted first; for a background app it can name another window.
        let target = frontmost ? (currentFocusedWindow() ?? focusedWindow) : (focusedWindow ?? currentFocusedWindow())
        if full, let w = target {
            focusedWindow = w
            walkWindow(w, reason: focus ? .focus : .event, isFocused: true)
            if focus { emitFocus(window: w) }
        }
        let took = CFAbsoluteTimeGetCurrent() - start
        nextAllowed = start + max(0.1, 3 * took)
    }

    private func currentFocusedWindow() -> AXRef? {
        AX.element(ax, kAXFocusedWindowAttribute).map(AXRef.init)
    }

    /// `element` is the newly focused element when the notification named one. Its window comes from
    /// the element itself, because a background app's focused-window attribute can name a different window.
    private func focusChanged(element: AXRef?) {
        let fe = element ?? AX.element(ax, kAXFocusedUIElementAttribute).map(AXRef.init)
        var w: AXRef?
        if let fe {
            AXUIElementSetMessagingTimeout(fe.el, AX.elementTimeout)
            if AX.string(fe.el, kAXRoleAttribute) == kAXWindowRole {
                w = fe
            } else {
                w = AX.element(fe.el, kAXWindowAttribute).map(AXRef.init)
                // Read emptiness now, before a throttled walk: typing may start within tens of milliseconds.
                let secure = AX.isSecure(fe.el)
                focusEmptyAtEvent = (fe, secure ? false : (AX.valueUnlessSecure(fe.el) ?? "").isEmpty)
            }
        }
        focusElement = fe
        w = w ?? currentFocusedWindow()
        if let prev = focusedWindow, prev != w, windows[prev] != nil {
            walkWindow(prev, reason: .leave, isFocused: false)
        }
        focusedWindow = w
        pendingFocus = true
        request(full: true, subtree: nil)
    }

    private func emitFocus(window w: AXRef) {
        guard let info = windows[w], let f = focusElement ?? AX.element(ax, kAXFocusedUIElementAttribute).map(AXRef.init) else { return }
        let fe = f.el
        if f == lastFocusEmitted { return }
        lastFocusEmitted = f
        let kc = info.contexts[f]
        let role = kc?.role ?? AX.string(fe, kAXRoleAttribute) ?? "AXUnknown"
        let secure = AX.isSecure(role: role, subrole: AX.string(fe, kAXSubroleAttribute))
        let editable = Roles.editable.contains(role)
        // Emptiness as read when focus arrived; never read for a secure field.
        let empty: Bool
        if secure { empty = false } else if let (el, e) = focusEmptyAtEvent, el == f { empty = e } else {
            empty = (AX.valueUnlessSecure(fe) ?? "").isEmpty
        }
        ctx.emitter.send(.focus(Focus(at: nowMs(), app: app, windowId: info.id, key: kc?.key, role: role,
                                      editable: editable && !secure, empty: empty, frontmost: frontmost)))
    }

    // MARK: - walks

    private func info(for w: AXRef) -> WindowInfo {
        if let i = windows[w] { return i }
        let kind = ElementKey.windowKind(subrole: AX.string(w.el, kAXSubroleAttribute), identifier: AX.string(w.el, kAXIdentifierAttribute))
        let i = WindowInfo(id: "\(pid)-\(nextWindow)", kind: kind)
        nextWindow += 1
        windows[w] = i
        return i
    }

    /// Walks one window and sends its snapshot unless nothing changed. Returns the compacted nodes and whether the walk was cut short.
    /// `focusedElement` overrides how the focused element is found, for verbs that need the app's
    /// focus as it is now, whatever the reader last saw.
    @discardableResult
    private func walkWindow(_ w: AXRef, reason: WalkReason, isFocused: Bool, focusedElement: AXUIElement?? = nil) -> (nodes: [Node], truncated: Bool) {
        AXUIElementSetMessagingTimeout(w.el, AX.elementTimeout)
        var info = info(for: w)
        let fe = focusedElement ?? (isFocused ? (focusElement?.el ?? AX.element(ax, kAXFocusedUIElementAttribute)) : nil)
        let limits: WalkLimits = reason == .request ? .request : (reason == .background || reason == .initial) ? .background : .focused
        let walker = Walker(limits: limits, focused: fe)
        let raw = walker.readChildren(of: w.el)
        let title = AX.string(w.el, kAXTitleAttribute) ?? ""
        let result = Compactor(app: appPart, windowKind: info.kind, windowTitle: title).compact(windowChildren: raw)
        let walkMs = walker.elapsedMs
        var contexts: [AXRef: KeyContext] = [:]
        for (h, kc) in result.contexts { contexts[AXRef(walker.elements[h])] = kc }
        info.contexts = contexts
        info.lastWalk = CFAbsoluteTimeGetCurrent()

        let frame = AX.frame(of: w.el)
        var h = Hasher()
        h.combine(title); h.combine(isFocused); h.combine(result.nodes.count)
        for n in result.nodes { h.combine(n) }
        let hash = h.finalize()
        // A request walk always sends: the helper is waiting for it to judge an act.
        let unchanged = info.contentHash == hash && reason != .initial && reason != .focus && reason != .request
        info.contentHash = hash
        windows[w] = info
        if unchanged { return (result.nodes, walker.truncated) }

        let snap = Snapshot(seq: ctx.nextSeq(), at: nowMs(), reason: reason, app: app,
                            window: WindowRef(windowId: info.id, kind: info.kind, title: title, frame: frame),
                            focused: isFocused, root: nil, nodes: result.nodes, values: ctx.detector.values(for: result.nodes),
                            focusedKey: result.focusedKey,
                            stats: WalkStats(walkMs: (walkMs * 10).rounded() / 10, visited: walker.visited, truncated: walker.truncated))
        ctx.emitter.send(.snapshot(snap))
        return (result.nodes, walker.truncated)
    }

    /// Re-reads just the element a notification named, when it was a kept node whose key does not
    /// depend on anything outside it. Returns false when the whole window must be walked instead.
    private func walkSubtree(_ el: AXRef) -> Bool {
        guard let (w, kc) = lookup(el), kc.leaf || kc.named, var info = windows[w] else { return false }
        let walker = Walker(limits: .focused, focused: focusElement?.el)
        let title = AX.string(w.el, kAXTitleAttribute) ?? ""
        guard let raw = walker.readSubtree(el.el), !walker.truncated,
              let result = Compactor(app: appPart, windowKind: info.kind, windowTitle: title).compactSubtree(raw, context: kc) else { return false }
        for (h, c) in result.contexts { info.contexts[AXRef(walker.elements[h])] = c }
        info.contentHash = nil
        windows[w] = info
        let snap = Snapshot(seq: ctx.nextSeq(), at: nowMs(), reason: .event, app: app,
                            window: WindowRef(windowId: info.id, kind: info.kind, title: title, frame: AX.frame(of: w.el)),
                            focused: w == focusedWindow, root: kc.key, nodes: result.nodes, values: ctx.detector.values(for: result.nodes),
                            focusedKey: result.focusedKey,
                            stats: WalkStats(walkMs: (walker.elapsedMs * 10).rounded() / 10, visited: walker.visited, truncated: false))
        ctx.emitter.send(.snapshot(snap))
        return true
    }

    private func lookup(_ el: AXRef) -> (AXRef, KeyContext)? {
        for (w, info) in windows { if let kc = info.contexts[el] { return (w, kc) } }
        return nil
    }

    private func pass(reason: WalkReason, minAge: TimeInterval) {
        guard let ws = AX.elements(ax, kAXWindowsAttribute) else { return }
        let live = Set(ws.map(AXRef.init))
        for (w, info) in windows where !live.contains(w) {
            windows.removeValue(forKey: w)
            ctx.emitter.send(.windowClosed(WindowClosed(at: nowMs(), windowId: info.id)))
        }
        let focused = eventDriven ? (focusedWindow ?? currentFocusedWindow()) : nil
        let now = CFAbsoluteTimeGetCurrent()
        for w in ws.map(AXRef.init) {
            if let i = windows[w], now - i.lastWalk < minAge { continue }
            walkWindow(w, reason: reason, isFocused: w == focused)
        }
    }

    // MARK: - verbs

    /// Runs one executor verb on this app's queue and answers through `reply`. Write and press re-walk
    /// the window, find the element by key, check it is the same element the key named before, recheck
    /// role, label and value against what the helper expects, act, wait for the app to settle, and
    /// walk again, so the helper has the new state before the answer arrives. Every recheck fails
    /// closed: an attribute that cannot be read refuses the act. `mayAct` is false unless the reader
    /// was started with --act-pids for this app; `expires` is when the helper stops waiting.
    func perform(_ verb: ReaderVerb, mayAct: Bool, expires: Int64, reply: @escaping @Sendable (VerbOutcome, String?) -> Void) {
        queue.async {
            let (outcome, detail) = self.performNow(verb, mayAct: mayAct, expires: expires)
            reply(outcome, detail)
        }
    }

    /// Time for the app to apply an act before the window is walked again. Assumed, not measured.
    static let settle: TimeInterval = 0.15

    private func performNow(_ verb: ReaderVerb, mayAct: Bool, expires: Int64) -> (VerbOutcome, String?) {
        switch verb {
        case .watchInput:
            return (.ok, nil)
        case let .walk(_, windowId):
            guard let w = window(id: windowId) else { return (.noWindow, windowId) }
            if requestWalk(w).truncated { return (.axError, "the walk was cut short, so the window cannot be judged") }
            return (.ok, nil)
        case let .write(_, windowId, key, role, attribute, expect, value):
            guard mayAct else { return (.notAllowed, "the reader was not started with --act-pids \(pid)") }
            let found = target(windowId: windowId, key: key, role: role)
            guard case let .success((w, el, _)) = found else { return found.failure }
            switch AX.read(el, kAXSubroleAttribute) {
            case .failed(let e): return (.axError, "cannot read the subrole (\(e.rawValue)), so the field may be a password field")
            case .value(let v) where (v as? String) == "AXSecureTextField": return (.secure, nil)
            default: break
            }
            if role == "AXSecureTextField" { return (.secure, nil) }
            if nowMs() > expires { return (.axError, "the command expired before it could act") }
            let err: AXError
            if attribute == "focused" {
                err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            } else {
                // The value is read again right before the write, so a change since the walk is caught too.
                let current: String
                switch AX.read(el, kAXValueAttribute) {
                case .failed(let e): return (.axError, "cannot read the current value (\(e.rawValue))")
                case .absent: current = ""
                case .value(let v):
                    guard let str = v as? String else { return (.changed, "the value is not text") }
                    current = str
                }
                guard current == expect else { return (.changed, "value is '\(current.prefix(80))'") }
                err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
            }
            guard err == .success else { return (.axError, "AXUIElementSetAttributeValue \(err.rawValue)") }
            Thread.sleep(forTimeInterval: Self.settle)
            requestWalk(w)
            return (.ok, nil)
        case let .press(_, windowId, key, role, label):
            guard mayAct else { return (.notAllowed, "the reader was not started with --act-pids \(pid)") }
            let found = target(windowId: windowId, key: key, role: role)
            guard case let .success((w, el, _)) = found else { return found.failure }
            // The label is read from the element itself, not from the walk, right before the press:
            // the helper's risk check ran on `label`, so a control renamed since then is not pressed.
            guard let live = liveLabel(el) else { return (.axError, "cannot read the control's label") }
            guard live.trimmingCharacters(in: .whitespacesAndNewlines) == label else { return (.changed, "label is '\(live.prefix(80))'") }
            if nowMs() > expires { return (.axError, "the command expired before it could act") }
            let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
            guard err == .success else { return (.axError, "AXUIElementPerformAction \(err.rawValue)") }
            Thread.sleep(forTimeInterval: Self.settle)
            requestWalk(w)
            return (.ok, nil)
        }
    }

    private enum Found {
        case success((AXRef, AXUIElement, Node))
        case fail(VerbOutcome, String?)
        var failure: (VerbOutcome, String?) {
            if case let .fail(o, d) = self { return (o, d) }
            return (.ok, nil)
        }
    }

    /// Re-walks the window and finds the element for `key`. The element must be the same one the key
    /// named in the walk before, so a removed field cannot pass its key on to a sibling with the same
    /// label, and must still have the expected role.
    private func target(windowId: String, key: String, role: String) -> Found {
        guard let w = window(id: windowId) else { return .fail(.noWindow, windowId) }
        let before = element(key: key, in: w)
        let walk = requestWalk(w)
        if walk.truncated { return .fail(.axError, "the walk was cut short, so the target cannot be checked") }
        guard let el = element(key: key, in: w), let node = walk.nodes.first(where: { $0.key == key }) else { return .fail(.noElement, key) }
        if let b = before, !CFEqual(b, el) { return .fail(.changed, "another element now has this key") }
        AXUIElementSetMessagingTimeout(el, AX.elementTimeout)
        switch AX.read(el, kAXRoleAttribute) {
        case .value(let v) where (v as? String) == role: return .success((w, el, node))
        case .value(let v): return .fail(.changed, "role is \((v as? String) ?? "not text")")
        case .absent: return .fail(.changed, "the element has no role")
        case .failed(let e): return .fail(.axError, "cannot read the role (\(e.rawValue))")
        }
    }

    @discardableResult
    private func requestWalk(_ w: AXRef) -> (nodes: [Node], truncated: Bool) {
        walkWindow(w, reason: .request, isFocused: w == focusedWindow, focusedElement: .some(focusedElement(in: w)))
    }

    /// The control's name as the compactor derives it: title, else description. Nil when a read fails.
    private func liveLabel(_ el: AXUIElement) -> String? {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute] {
            switch AX.read(el, attr) {
            case .failed: return nil
            case .value(let v):
                if let s = v as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
            case .absent: continue
            }
        }
        return ""
    }

    /// The window with this reader-assigned id. A window the reader has not walked yet has no id the helper could know.
    private func window(id: String) -> AXRef? {
        windows.first(where: { $0.value.id == id })?.key
    }

    /// The live element whose key, in the window's latest walk, is `key`.
    private func element(key: String, in w: AXRef) -> AXUIElement? {
        windows[w]?.contexts.first(where: { $0.value.key == key })?.key.el
    }

    /// The app's focused element if it sits in `w`; nil otherwise.
    private func focusedElement(in w: AXRef) -> AXUIElement? {
        guard let fe = AX.element(ax, kAXFocusedUIElementAttribute) else { return nil }
        AXUIElementSetMessagingTimeout(fe, AX.elementTimeout)
        guard let fw = AX.element(fe, kAXWindowAttribute), CFEqual(fw, w.el) else { return nil }
        return fe
    }

    // MARK: - experiments

    /// Synchronous full walk returning raw results, for E8. Runs on the worker's queue.
    func walkForExperiment(titleFilter: (String) -> Bool) -> [(window: AXRef, windowTitle: String, elements: [AXRef], contexts: [Int: KeyContext], nodes: [Node], ms: Double)] {
        queue.sync {
            guard let ws = AX.elements(ax, kAXWindowsAttribute) else { return [] }
            var out: [(AXRef, String, [AXRef], [Int: KeyContext], [Node], Double)] = []
            for w in ws {
                let title = AX.string(w, kAXTitleAttribute) ?? ""
                guard titleFilter(title) else { continue }
                let r = AXRef(w)
                let i = info(for: r)
                let walker = Walker(limits: .background, focused: nil)
                let raw = walker.readChildren(of: w)
                let res = Compactor(app: appPart, windowKind: i.kind, windowTitle: title).compact(windowChildren: raw)
                out.append((r, title, walker.elements.map(AXRef.init), res.contexts, res.nodes, walker.elapsedMs))
            }
            return out
        }
    }
}
