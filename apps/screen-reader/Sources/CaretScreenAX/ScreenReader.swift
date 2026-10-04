// The coordinator. It keeps one AppWorker per app, follows app activation through NSWorkspace,
// makes the active app event-driven, walks every window on a background interval, and reports the
// pasteboard's change count. It runs on the main thread; workers do the reading on their queues.
import AppKit
import ApplicationServices
import CaretScreenCore
import Foundation
import IOKit.ps

public struct ReaderOptions: Sendable {
    /// Background windows are walked when their last walk is older than this. The deep plan's 30 s is an assumption.
    public var backgroundInterval: TimeInterval = 30
    /// Apps treated as event-driven even when not frontmost. For fixture experiments that must not take focus.
    public var eventPids: Set<pid_t> = []
    /// Apps with these bundle identifiers are event-driven too, whatever their pid. For E1's passive Electron sample.
    public var eventBundles: Set<String> = []
    /// When non-empty, only these processes are read. For experiments that must not read anything else.
    public var onlyPids: Set<pid_t> = []
    public var denyList: DenyList
    /// Processes the executor's write, press and raise verbs may act on without a grant, for fixture tests.
    /// Every other process needs a live act grant from the helper (`grants`).
    public var actPids: Set<pid_t> = []
    /// The helper's act grants, filled by the socket client as grant lines arrive.
    public var grants = GrantTable()
    public var pasteboardPoll: TimeInterval = 0.5
    /// The calendar adapter, only with --calendar-test; nil answers every calendar verb notAllowed.
    public var calendar: CalendarAdapter?
    /// False leaves AXManualAccessibility alone. A read-only audit beside another reader sets nothing in
    /// any app; the other reader has already asked Chromium and Electron apps for their trees.
    public var setManualAccessibility = true
    public init(denyList: DenyList) { self.denyList = denyList }
}

@MainActor
public final class ScreenReader {
    private let ctx: ReaderContext
    private var opts: ReaderOptions
    private var workers: [pid_t: AppWorker] = [:]
    private var frontmost: pid_t?
    private var manualAXSet: Set<pid_t> = []
    private var timers: [Timer] = []
    private var lastChangeCount = NSPasteboard.general.changeCount
    private var tokens: [NSObjectProtocol] = []
    private var started = false
    private var watchedPids: Set<pid_t> = []
    private var inputMonitor: Any?
    /// B20: windows whose user presses are reported, by process; taps and the monitor exist only while it is non-empty.
    private var pressWatch: [pid_t: Set<String>] = [:]
    /// A listen-only event tap per watched process. It sees a click posted to that process alone, which the
    /// global monitor does not (B20 experiment: 3 of 3 against 0 of 3), and only that process's clicks.
    private var pressTaps: [pid_t: (port: CFMachPort, source: CFRunLoopSource, box: PressTapBox)] = [:]
    /// The global monitor, for watched processes no tap could be made for (no Input Monitoring access).
    private var pressMonitor: Any?
    /// EventKit calls block, so calendar verbs run here, one at a time, off the main thread.
    private let calendarQueue = DispatchQueue(label: "caret.screen.calendar")

    public init(ctx: ReaderContext, options: ReaderOptions) {
        self.ctx = ctx
        self.opts = options
    }

    public var workerCount: Int { workers.count }

    public func start() {
        for app in NSWorkspace.shared.runningApplications { add(app) }
        let nc = NSWorkspace.shared.notificationCenter
        tokens.append(nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { self.add(app) }
        })
        tokens.append(nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { self.remove(app.processIdentifier) }
        })
        tokens.append(nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { self.activated(app) }
        })

        if let f = NSWorkspace.shared.frontmostApplication { activated(f, initial: true) }
        for w in workers.values {
            w.setEventDriven(opts.eventPids.contains(w.pid) || w.pid == frontmost, frontmost: w.pid == frontmost)
            w.backgroundPass(reason: .initial, minAge: 0)
        }
        started = true
        timers.append(Timer.scheduledTimer(withTimeInterval: opts.backgroundInterval, repeats: true) { _ in
            MainActor.assumeIsolated { self.backgroundTick() }
        })
        timers.append(Timer.scheduledTimer(withTimeInterval: opts.pasteboardPoll, repeats: true) { _ in
            MainActor.assumeIsolated { self.pollPasteboard() }
        })
        ctx.log("reading \(workers.count) apps; background every \(Int(opts.backgroundInterval)) s; deny list has \(opts.denyList.count) entries")
    }

    /// Walks everything again. After the helper reconnects (`newHelper`) it has no state: its watches are gone
    /// with it, so the reader drops its own until the new helper asks for some. A resync after dropped snapshots
    /// keeps the press watch, which the same helper still counts on (B20 review).
    public func resync(newHelper: Bool) {
        if newHelper { watchPresses([:]) }
        for w in workers.values {
            // The pending-state watch too: before B20 a drain resync dropped it while the helper still relied on it.
            if newHelper { w.setWatched([]) }
            w.backgroundPass(reason: .initial, minAge: 0)
        }
        if let f = frontmost { workers[f]?.activate() }
    }

    // MARK: - executor verbs

    /// Runs a command from the helper and sends its verbResult. Verbs for an app the reader does not
    /// read (denied, filtered out, or gone) answer noWindow; nothing is ever done to such an app.
    public func perform(_ cmd: ReaderCommand) {
        let emitter = ctx.emitter
        let answer: @Sendable (VerbOutcome, String?) -> Void = { outcome, detail in
            emitter.send(.verbResult(VerbResult(id: cmd.id, at: nowMs(), outcome: outcome, detail: detail)))
        }
        let pid: pid_t
        switch cmd.verb {
        case let .watchInput(pids):
            watch(Set(pids.map { pid_t($0) }))
            answer(.ok, nil)
            return
        case let .watchPresses(list):
            var byPid: [pid_t: Set<String>] = [:]
            for w in list { byPid[pid_t(w.pid), default: []].insert(w.windowId) }
            watchPresses(byPid)
            let unread = byPid.keys.filter { workers[$0] == nil }.sorted()
            answer(.ok, unread.isEmpty ? nil : "not read, so not watched: \(unread.map(String.init).joined(separator: ","))")
            return
        case let .watchWindows(list):
            // The list replaces every watch, so each worker gets its own windows or none.
            var byPid: [pid_t: Set<String>] = [:]
            for w in list { byPid[pid_t(w.pid), default: []].insert(w.windowId) }
            for (p, worker) in workers { worker.setWatched(byPid[p] ?? []) }
            let unread = byPid.keys.filter { workers[$0] == nil }.sorted()
            answer(.ok, unread.isEmpty ? nil : "not read, so not watched: \(unread.map(String.init).joined(separator: ","))")
            return
        case let .walk(p, _), let .write(p, _, _, _, _, _, _, _), let .press(p, _, _, _, _, _), let .raise(p, _, _):
            pid = pid_t(p)
        case .calendarFind, .calendarAdd, .calendarGet, .calendarRemove, .calendarDispose:
            guard let calendar = opts.calendar else {
                answer(.notAllowed, "the reader was not started with --calendar-test")
                return
            }
            let grants = opts.grants
            calendarQueue.async {
                let at = nowMs()
                // As with acts in a window: past the helper's deadline, it has already reported the step as failed.
                if at > cmd.expires {
                    emitter.send(.verbResult(VerbResult(id: cmd.id, at: at, outcome: .axError, detail: "the command expired before the calendar was reached")))
                    return
                }
                // A write needs its task's calendar grant, asked here, right before it: a revoke that came
                // while the command waited on this queue refuses it.
                if let task = cmd.verb.taskId, let no = grants.calendarRefusal(taskId: task, now: at, uptimeMs: uptimeMs()) {
                    emitter.send(.verbResult(VerbResult(id: cmd.id, at: at, outcome: .notAllowed, detail: no)))
                    return
                }
                let result: VerbResult
                switch calendar.perform(cmd.verb) {
                case let .ok(event): result = VerbResult(id: cmd.id, at: nowMs(), outcome: .ok, detail: nil, event: event)
                case let .blocked(b): result = VerbResult(id: cmd.id, at: nowMs(), outcome: .blocked, detail: nil, blocked: b)
                case let .refused(o, d): result = VerbResult(id: cmd.id, at: nowMs(), outcome: o, detail: d)
                }
                emitter.send(.verbResult(result))
            }
            return
        }
        guard let w = workers[pid] else {
            answer(.noWindow, "the reader does not read process \(pid)")
            return
        }
        w.perform(cmd.verb, gate: ActGate(actPid: opts.actPids.contains(pid), grants: opts.grants), expires: cmd.expires, reply: answer)
    }

    /// Reports real key presses and clicks that land in a watched process, so the executor can pause.
    /// Only the fact, the process and the click location are sent: never key codes or characters.
    /// The monitor exists only while some process is watched.
    private func watch(_ pids: Set<pid_t>) {
        watchedPids = pids
        if pids.isEmpty {
            if let m = inputMonitor { NSEvent.removeMonitor(m) }
            inputMonitor = nil
            return
        }
        guard inputMonitor == nil else { return }
        inputMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { e in
            let isKey = e.type == .keyDown
            let loc = NSEvent.mouseLocation
            MainActor.assumeIsolated { self.inputSeen(isKey: isKey, location: loc) }
        }
    }

    /**
     * Reports the user's presses of pressable elements in the named windows: clicks (B20), and Return, Enter or
     * Space on a button (B21, KeyPresses). Each watched process gets a listen-only event tap: it observes and
     * cannot change, block or post an event. A left button going down is read for its location and the window
     * it went to, matched to an element of a watched window; a key going down only for which of the three it
     * is, placed by the focus and default button the reader last read. A process no tap can be made for falls
     * back to the global mouse monitor, placed by the frontmost window under the click, and its keys go unseen.
     */
    private func watchPresses(_ byPid: [pid_t: Set<String>]) {
        pressWatch = byPid.filter { !$0.value.isEmpty }
        for (pid, tap) in pressTaps where pressWatch[pid] == nil {
            CGEvent.tapEnable(tap: tap.port, enable: false)
            CFRunLoopRemoveSource(CFRunLoopGetMain(), tap.source, .commonModes)
            CFMachPortInvalidate(tap.port)
            pressTaps.removeValue(forKey: pid)
        }
        for pid in pressWatch.keys where pressTaps[pid] == nil {
            if let tap = makePressTap(pid) { pressTaps[pid] = tap }
        }
        let untapped = pressWatch.keys.contains { pressTaps[$0] == nil }
        if !untapped {
            if let m = pressMonitor { NSEvent.removeMonitor(m) }
            pressMonitor = nil
            return
        }
        guard pressMonitor == nil else { return }
        ctx.log("press watch: no event tap for \(pressWatch.keys.filter { pressTaps[$0] == nil }.map(String.init).joined(separator: ",")); using the global monitor")
        pressMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { e in
            // Where the click was, not where the cursor is by the time this runs: for another app's event,
            // locationInWindow is in screen coordinates.
            let loc = e.window == nil ? e.locationInWindow : NSEvent.mouseLocation
            let at = nowMs()
            MainActor.assumeIsolated { self.pressSeen(location: loc, at: at) }
        }
    }

    /// A listen-only tap for the process's clicks and, when the system allows a keyboard tap, its Return, Enter
    /// and Space (B21). A process whose keyboard cannot be tapped still has its clicks watched; the log says so.
    private func makePressTap(_ pid: pid_t) -> (port: CFMachPort, source: CFRunLoopSource, box: PressTapBox)? {
        let click: @Sendable (CGPoint, Int?, Int64) -> Void = { [weak self] p, number, at in
            MainActor.assumeIsolated { self?.tapPress(pid: pid, at: p, number: number, time: at) }
        }
        let key: @Sendable (UserPress.Via, Int64) -> Void = { [weak self] via, at in
            MainActor.assumeIsolated { self?.tapKey(pid: pid, via: via, time: at) }
        }
        let mouse = CGEventMask(1 << CGEventType.leftMouseDown.rawValue)
        let keys = mouse | CGEventMask(1 << CGEventType.keyDown.rawValue)
        var box = PressTapBox(pid: pid, onPress: click, onKey: key)
        var tapped = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: keys,
                                             callback: pressTapCallback, userInfo: Unmanaged.passUnretained(box).toOpaque())
        if tapped == nil {
            ctx.log("press watch: no keyboard tap for \(pid); watching its clicks only")
            box = PressTapBox(pid: pid, onPress: click, onKey: nil)
            tapped = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mouse,
                                             callback: pressTapCallback, userInfo: Unmanaged.passUnretained(box).toOpaque())
        }
        guard let port = tapped else { return nil }
        box.port = port
        guard let source = CFMachPortCreateRunLoopSource(nil, port, 0) else {
            CFMachPortInvalidate(port)
            return nil
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return (port, source, box)
    }

    private func tapPress(pid: pid_t, at p: CGPoint, number: Int?, time at: Int64) {
        guard let ids = pressWatch[pid], let w = workers[pid] else { return }
        w.observePress(at: p, number: number, time: at, windows: ids)
    }

    private func tapKey(pid: pid_t, via: UserPress.Via, time at: Int64) {
        guard let ids = pressWatch[pid], let w = workers[pid] else { return }
        w.observeKey(via, time: at, windows: ids)
    }

    private func pressSeen(location: NSPoint, at: Int64) {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let p = CGPoint(x: location.x, y: primaryHeight - location.y)
        guard let owner = windowOwner(at: p), pressTaps[owner] == nil, let ids = pressWatch[owner], let w = workers[owner] else { return }
        w.observePress(at: p, number: nil, time: at, windows: ids)
    }

    private func inputSeen(isKey: Bool, location: NSPoint) {
        if isKey {
            guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, watchedPids.contains(front) else { return }
            ctx.emitter.send(.userInput(UserInput(at: nowMs(), pid: Int(front), kind: .key, point: nil)))
            return
        }
        // Accessibility coordinates have their origin at the top left of the primary screen.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        let p = CGPoint(x: location.x, y: primaryHeight - location.y)
        guard let owner = windowOwner(at: p), watchedPids.contains(owner) else { return }
        ctx.emitter.send(.userInput(UserInput(at: nowMs(), pid: Int(owner), kind: .mouse, point: [p.x, p.y])))
    }

    /// The process owning the frontmost normal window under a point. Bounds and owners need no Screen Recording grant.
    private func windowOwner(at p: CGPoint) -> pid_t? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  let b = info[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: b), r.contains(p) else { continue }
            return (info[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) }
        }
        return nil
    }

    private func add(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard workers[pid] == nil, pid != getpid() else { return }
        if !opts.onlyPids.isEmpty && !opts.onlyPids.contains(pid) { return }
        // A process named by --event-pids or --only-pids is read whatever its activation policy, so a
        // fixture run with --background-only (the prohibited policy) can be read without being event-driven.
        guard app.activationPolicy == .regular || app.activationPolicy == .accessory || opts.eventPids.contains(pid) || opts.onlyPids.contains(pid) else { return }
        let bundleId = app.bundleIdentifier ?? ""
        if opts.denyList.denies(bundleId) { return }
        if opts.eventBundles.contains(bundleId) { opts.eventPids.insert(pid) }
        let ref = AppRef(pid: Int(pid), bundleId: bundleId, name: app.localizedName ?? bundleId)
        enableManualAccessibility(app)
        let w = AppWorker(pid: pid, app: ref, ctx: ctx)
        workers[pid] = w
        // Apps present at start are walked once by start(); an app launched later is walked here.
        if started {
            w.setEventDriven(opts.eventPids.contains(pid), frontmost: false)
            w.backgroundPass(reason: .initial, minAge: 0)
        }
    }

    private func remove(_ pid: pid_t) {
        if pressWatch[pid] != nil {
            var rest = pressWatch
            rest.removeValue(forKey: pid)
            watchPresses(rest)
        }
        guard let w = workers.removeValue(forKey: pid) else { return }
        manualAXSet.remove(pid)
        w.stop()
    }

    private func activated(_ app: NSRunningApplication, initial: Bool = false) {
        let pid = app.processIdentifier
        let previous = frontmost
        frontmost = pid
        if !initial, previous != pid {
            let to = workers[pid]?.app ?? AppRef(pid: Int(pid), bundleId: app.bundleIdentifier ?? "", name: app.localizedName ?? "")
            ctx.emitter.send(.appSwitch(AppSwitch(at: nowMs(), from: previous.flatMap { workers[$0]?.app }, to: to)))
        }
        if let p = previous, p != pid, let old = workers[p] {
            old.leave()
            old.setEventDriven(opts.eventPids.contains(p), frontmost: false)
        }
        guard let w = workers[pid] else { return }
        w.setEventDriven(true, frontmost: true)
        if !initial { w.activate() }
    }

    private func backgroundTick() {
        if onLowBattery() { return }
        for w in workers.values { w.backgroundPass(reason: .background, minAge: opts.backgroundInterval * 0.9) }
    }

    private func pollPasteboard() {
        let c = NSPasteboard.general.changeCount
        guard c != lastChangeCount else { return }
        lastChangeCount = c
        ctx.emitter.send(.pasteboard(Pasteboard(at: nowMs(), changeCount: c)))
    }

    /// Electron builds its accessibility tree only on request. AXManualAccessibility asks for it without
    /// AXEnhancedUserInterface, which made Chromium replay typed keys in Screenpipe #3884. Chromium browsers are not
    /// asked (W2): Chromium's mac code does not handle the attribute (-25205 in the reader log), and Caret reads their
    /// pages through its page engine. Every app the reader adds gets one line saying which happened.
    private func enableManualAccessibility(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard opts.setManualAccessibility, !manualAXSet.contains(pid), let url = app.bundleURL else { return }
        let family = AppClassifier.family(bundleURL: url)
        let name = app.localizedName ?? "?"
        if family == .chromiumBrowser {
            manualAXSet.insert(pid)
            ctx.log("AXManualAccessibility not attempted on \(name): a Chromium browser, read by the page engine")
            return
        }
        guard family.setsManualAccessibility else { return }
        manualAXSet.insert(pid)
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, AX.elementTimeout)
        let r = AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        ctx.log("AXManualAccessibility on \(name) (\(family.rawValue)): \(r == .success ? "set" : "error \(r.rawValue)")")
    }

    /// Background walks pause on battery below 20%. The threshold is an assumption.
    private func onLowBattery() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return false }
        for ps in list {
            guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any] else { continue }
            let onBattery = (d[kIOPSPowerSourceStateKey] as? String) == kIOPSBatteryPowerValue
            if onBattery, let cap = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0, cap * 100 / max < 20 {
                return true
            }
        }
        return false
    }
}

/// What a press tap's callback needs: the process it watches, its port (to re-enable it after the system turns
/// it off for a slow callback), and where to send a click. Kept alive by the reader's tap table.
final class PressTapBox: @unchecked Sendable {
    let pid: pid_t
    var port: CFMachPort?
    let onPress: @Sendable (CGPoint, Int?, Int64) -> Void
    /// A press key went down (B21): which one, and when. Nil when the tap watches the mouse only.
    let onKey: (@Sendable (UserPress.Via, Int64) -> Void)?
    init(pid: pid_t, onPress: @escaping @Sendable (CGPoint, Int?, Int64) -> Void, onKey: (@Sendable (UserPress.Via, Int64) -> Void)?) {
        self.pid = pid
        self.onPress = onPress
        self.onKey = onKey
    }
}

/// Runs on the main run loop for each left button or key going down in a watched process. It only reads the
/// event and passes it on unchanged. Of a key it reads the key code, the modifier flags and whether it repeats,
/// and drops it at once unless it is Return, Enter or Space held alone (KeyPresses.via); characters are never read.
private let pressTapCallback: CGEventTapCallBack = { _, type, event, refcon in
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let box = Unmanaged<PressTapBox>.fromOpaque(refcon).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let port = box.port { CGEvent.tapEnable(tap: port, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if type == .keyDown {
        guard let onKey = box.onKey,
              let via = KeyPresses.via(keyCode: Int(event.getIntegerValueField(.keyboardEventKeycode)), flags: event.flags.rawValue,
                                       autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0) else { return Unmanaged.passUnretained(event) }
        onKey(via, nowMs())
        return Unmanaged.passUnretained(event)
    }
    guard type == .leftMouseDown else { return Unmanaged.passUnretained(event) }
    // CGEvent locations share Accessibility's space: origin at the top left of the primary screen.
    let number = Int(event.getIntegerValueField(.mouseEventWindowUnderMousePointer))
    box.onPress(event.location, number > 0 ? number : nil, nowMs())
    return Unmanaged.passUnretained(event)
}

/// Apps that are never walked. One bundle identifier prefix per line; "#" starts a comment.
public struct DenyList: Sendable {
    public let prefixes: [String]
    public var count: Int { prefixes.count }

    public static let defaults = [
        "com.apple.keychainaccess", "com.apple.Passwords", "com.bitwarden.desktop", "com.1password", "com.agilebits",
        "com.lastpass", "com.dashlane", "com.callpod.keeper", "org.keepassxc", "me.proton.pass", "ch.protonmail.pass",
        "in.sinew.Enpass", "com.nordsec.nordpass", "com.apple.systempreferences.passwords",
    ]

    public init(prefixes: [String]) { self.prefixes = prefixes }

    public func denies(_ bundleId: String) -> Bool {
        prefixes.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
    }

    /// Reads the file, creating it with the defaults when it does not exist. An unreadable file is an error, not an empty list.
    public static func load(path: String) throws -> DenyList {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            try fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            let body = "# Apps caret-screen never reads. One bundle identifier (or prefix) per line.\n" + defaults.joined(separator: "\n") + "\n"
            try body.write(toFile: path, atomically: true, encoding: .utf8)
        }
        let text = try String(contentsOfFile: path, encoding: .utf8)
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        return DenyList(prefixes: lines.filter { !$0.isEmpty && !$0.hasPrefix("#") })
    }
}
