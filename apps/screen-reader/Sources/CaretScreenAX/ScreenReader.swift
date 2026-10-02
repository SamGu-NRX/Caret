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
    /// Processes the executor's write and press verbs may act on. Empty means no process: the reader
    /// only reads unless it is started with --act-pids naming fixture processes.
    public var actPids: Set<pid_t> = []
    public var pasteboardPoll: TimeInterval = 0.5
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

    /// After the helper reconnects it has no state, so walk everything again. Its watches are gone
    /// with it, so the reader drops its own until the new helper asks for some.
    public func resync() {
        for w in workers.values {
            w.setWatched([])
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
        case let .watchWindows(list):
            // The list replaces every watch, so each worker gets its own windows or none.
            var byPid: [pid_t: Set<String>] = [:]
            for w in list { byPid[pid_t(w.pid), default: []].insert(w.windowId) }
            for (p, worker) in workers { worker.setWatched(byPid[p] ?? []) }
            let unread = byPid.keys.filter { workers[$0] == nil }.sorted()
            answer(.ok, unread.isEmpty ? nil : "not read, so not watched: \(unread.map(String.init).joined(separator: ","))")
            return
        case let .walk(p, _), let .write(p, _, _, _, _, _, _), let .press(p, _, _, _, _):
            pid = pid_t(p)
        }
        guard let w = workers[pid] else {
            answer(.noWindow, "the reader does not read process \(pid)")
            return
        }
        w.perform(cmd.verb, mayAct: opts.actPids.contains(pid), expires: cmd.expires, reply: answer)
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

    /// Chromium and Electron build their accessibility tree only on request. AXManualAccessibility asks
    /// for it without AXEnhancedUserInterface, which made Chromium replay typed keys in Screenpipe #3884.
    private func enableManualAccessibility(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard !manualAXSet.contains(pid), let url = app.bundleURL, AppClassifier.isChromiumFamily(bundleURL: url) else { return }
        manualAXSet.insert(pid)
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, AX.elementTimeout)
        let r = AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        ctx.log("AXManualAccessibility on \(app.localizedName ?? "?"): \(r == .success ? "set" : "error \(r.rawValue)")")
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

public enum AppClassifier {
    /// True for Electron apps and Chromium browsers: a framework under Contents/Frameworks that is
    /// Electron's, or that ships a renderer helper app the way every Chromium build does.
    public static func isChromiumFamily(bundleURL: URL) -> Bool {
        let fm = FileManager.default
        let frameworks = bundleURL.appendingPathComponent("Contents/Frameworks")
        guard let items = try? fm.contentsOfDirectory(atPath: frameworks.path) else { return false }
        for f in items where f.hasSuffix(".framework") {
            if f == "Electron Framework.framework" { return true }
            let versions = frameworks.appendingPathComponent(f).appendingPathComponent("Versions")
            for v in (try? fm.contentsOfDirectory(atPath: versions.path)) ?? [] {
                let helpers = versions.appendingPathComponent(v).appendingPathComponent("Helpers")
                if let hs = try? fm.contentsOfDirectory(atPath: helpers.path), hs.contains(where: { $0.contains("Helper (Renderer)") }) {
                    return true
                }
            }
        }
        return false
    }
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
