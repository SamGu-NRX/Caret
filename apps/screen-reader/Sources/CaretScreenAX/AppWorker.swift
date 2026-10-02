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
        queue.async { self.focusChanged(element: nil) }
    }

    /// Walks the window the user is leaving, once, at the moment of the switch.
    func leave() {
        queue.async {
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

    private func addObserver() {
        guard observer == nil else { return }
        var obs: AXObserver?
        guard AXObserverCreate(pid, observerCallback, &obs) == .success, let obs else {
            ctx.log("AXObserverCreate failed for \(app.name)")
            return
        }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var failed: [String] = []
        for n in Self.notifications where AXObserverAddNotification(obs, ax, n as CFString, refcon) != .success {
            failed.append(n)
        }
        if !failed.isEmpty { ctx.log("\(app.name): could not observe \(failed.joined(separator: ","))") }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
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
                let secure = AX.string(fe.el, kAXSubroleAttribute) == "AXSecureTextField"
                focusEmptyAtEvent = (fe, secure ? false : (AX.string(fe.el, kAXValueAttribute) ?? "").isEmpty)
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
        let subrole = AX.string(fe, kAXSubroleAttribute)
        let secure = subrole == "AXSecureTextField"
        let editable = Roles.editable.contains(role)
        // Emptiness as read when focus arrived; never read for a secure field.
        let empty: Bool
        if secure { empty = false } else if let (el, e) = focusEmptyAtEvent, el == f { empty = e } else {
            empty = (AX.string(fe, kAXValueAttribute) ?? "").isEmpty
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

    private func walkWindow(_ w: AXRef, reason: WalkReason, isFocused: Bool) {
        AXUIElementSetMessagingTimeout(w.el, AX.elementTimeout)
        var info = info(for: w)
        let fe = isFocused ? (focusElement?.el ?? AX.element(ax, kAXFocusedUIElementAttribute)) : nil
        let limits: WalkLimits = (reason == .background || reason == .initial) ? .background : .focused
        let walker = Walker(limits: limits, focused: fe)
        let raw = walker.readChildren(of: w.el)
        let result = Compactor(app: appPart, windowKind: info.kind).compact(windowChildren: raw)
        let walkMs = walker.elapsedMs
        var contexts: [AXRef: KeyContext] = [:]
        for (h, kc) in result.contexts { contexts[AXRef(walker.elements[h])] = kc }
        info.contexts = contexts
        info.lastWalk = CFAbsoluteTimeGetCurrent()

        let title = AX.string(w.el, kAXTitleAttribute) ?? ""
        let frame = AX.frame(of: w.el)
        var h = Hasher()
        h.combine(title); h.combine(isFocused); h.combine(result.nodes.count)
        for n in result.nodes { h.combine(n) }
        let hash = h.finalize()
        let unchanged = info.contentHash == hash && reason != .initial && reason != .focus
        info.contentHash = hash
        windows[w] = info
        if unchanged { return }

        let snap = Snapshot(seq: ctx.nextSeq(), at: nowMs(), reason: reason, app: app,
                            window: WindowRef(windowId: info.id, kind: info.kind, title: title, frame: frame),
                            focused: isFocused, root: nil, nodes: result.nodes, values: ctx.detector.values(for: result.nodes),
                            focusedKey: result.focusedKey,
                            stats: WalkStats(walkMs: (walkMs * 10).rounded() / 10, visited: walker.visited, truncated: walker.truncated))
        ctx.emitter.send(.snapshot(snap))
    }

    /// Re-reads just the element a notification named, when it was a kept node whose key does not
    /// depend on anything outside it. Returns false when the whole window must be walked instead.
    private func walkSubtree(_ el: AXRef) -> Bool {
        guard let (w, kc) = lookup(el), kc.leaf || kc.named, var info = windows[w] else { return false }
        let walker = Walker(limits: .focused, focused: focusElement?.el)
        guard let raw = walker.readSubtree(el.el), !walker.truncated,
              let result = Compactor(app: appPart, windowKind: info.kind).compactSubtree(raw, context: kc) else { return false }
        for (h, c) in result.contexts { info.contexts[AXRef(walker.elements[h])] = c }
        info.contentHash = nil
        windows[w] = info
        let snap = Snapshot(seq: ctx.nextSeq(), at: nowMs(), reason: .event, app: app,
                            window: WindowRef(windowId: info.id, kind: info.kind, title: AX.string(w.el, kAXTitleAttribute) ?? "", frame: AX.frame(of: w.el)),
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

    // MARK: - experiments

    /// Synchronous full walk returning raw results, for E8. Runs on the worker's queue.
    func walkForExperiment(titleFilter: (String) -> Bool) -> [(windowTitle: String, elements: [AXRef], contexts: [Int: KeyContext], nodes: [Node], ms: Double)] {
        queue.sync {
            guard let ws = AX.elements(ax, kAXWindowsAttribute) else { return [] }
            var out: [(String, [AXRef], [Int: KeyContext], [Node], Double)] = []
            for w in ws {
                let title = AX.string(w, kAXTitleAttribute) ?? ""
                guard titleFilter(title) else { continue }
                let r = AXRef(w)
                let i = info(for: r)
                let walker = Walker(limits: .background, focused: nil)
                let raw = walker.readChildren(of: w)
                let res = Compactor(app: appPart, windowKind: i.kind).compact(windowChildren: raw)
                out.append((title, walker.elements.map(AXRef.init), res.contexts, res.nodes, walker.elapsedMs))
            }
            return out
        }
    }
}
