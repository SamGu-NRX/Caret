import AppKit
import ApplicationServices
import CaretHostCore
import CoreGraphics
import SwiftUI

/// Onboarding's window, the one Caret window that may become key, and the system side of
/// `OnboardingFlow`: it reads the grants, opens System Settings, sends `firstLook`, writes the
/// choices to settings, and turns the window's keys into the flow's events.
///
/// `hidden` runs the same flow with no window, for socket-level runs while someone is using the
/// Mac: nothing is ordered on screen and System Settings is never opened.
@MainActor
final class OnboardingController {
    enum Mode: String {
        /// Never opens by itself; the menu's Set Up Caret opens it. The default, so test runs of
        /// the host never put a window up.
        case off
        /// Opens at launch until onboarding has reached its end once.
        case auto
        /// Opens at launch.
        case show
        /// Runs without a window; only the debug socket drives it.
        case hidden

        static var fromEnvironment: Mode {
            ProcessInfo.processInfo.environment["CARET_ONBOARDING"].flatMap(Mode.init(rawValue:)) ?? .off
        }
    }

    final class Model: ObservableObject {
        @Published var state: OnboardingFlow.State?
    }

    let mode: Mode
    private let testHooks: Bool
    private let store: SettingsStore
    private let model = Model()
    private var flow: OnboardingFlow?
    private var window: NSWindow?
    private var keyMonitor: Any?
    private var pollTimer: Timer?
    private var closeObserver: NSObjectProtocol?
    /// A test run's stand-in for the grants (`onboarding permissions`), read instead of the system.
    private var permissionsOverride: OnboardingPermissions?
    /// Sends a request to the helper; false when it is not connected.
    var sendFirstLook: (FirstLookRequest) -> Bool = { _ in false }
    /// What the window refused to do because it is hidden, for the debug state.
    private var suppressed: [String] = []

    init(mode: Mode, testHooks: Bool, store: SettingsStore = .shared) {
        self.mode = mode
        self.testHooks = testHooks
        self.store = store
    }

    /// The open flow has a window. False for a hidden run, and for a flow the debug socket opened.
    private var drawsWindow = false

    /// At launch: opens when the mode says so.
    func launch() {
        switch mode {
        case .off: return
        case .auto: if !store.settings.onboarded { open(drawing: true) }
        case .show: open(drawing: true)
        case .hidden: open(drawing: false)
        }
    }

    /// Starts the flow from the current settings and grants, with its window when `drawing` (the
    /// menu's Set Up Caret) and never on a hidden run. An open flow is brought forward rather than
    /// restarted.
    func open(drawing: Bool) {
        if let flow, !flow.state.finished {
            if drawsWindow, let window {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
            }
            return
        }
        drawsWindow = drawing && mode != .hidden
        let flow = OnboardingFlow(settings: store.settings, permissions: readPermissions(), clock: RunLoopClock())
        flow.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        self.flow = flow
        model.state = flow.state
        startPolling()
        guard drawsWindow else { return }
        showWindow()
    }

    func close() {
        stopPolling()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        window?.orderOut(nil)
        window = nil
    }

    func receive(_ reply: FirstLookReply) {
        flow?.send(.firstLookReply(reply))
    }

    // MARK: - The flow's commands

    private func perform(_ command: OnboardingFlow.Command) {
        switch command {
        case .changed: model.state = flow?.state
        case .saveChoices(let roles, let level, let onboarded):
            store.update(source: .onboarding) { s in
                s.roles = roles
                s.level = level
                if onboarded { s.onboarded = true }
            }
        case .openSystemSettings(let pane):
            guard drawsWindow else { return suppressed.append("openSystemSettings.\(pane.rawValue)") }
            Self.openSettings(pane)
        case .askFirstLook(let request):
            if !sendFirstLook(request) { flow?.send(.firstLookUnsent) }
        case .filled: break
        case .close: close()
        }
    }

    /// The system's own prompt where there is one, then the pane itself.
    private static func openSettings(_ pane: OnboardingFlow.Pane) {
        switch pane {
        case .accessibility:
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
        case .inputMonitoring:
            _ = CGRequestListenEventAccess()
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
        }
    }

    // MARK: - Grants

    private func readPermissions() -> OnboardingPermissions {
        permissionsOverride ?? OnboardingPermissions(accessibility: AXIsProcessTrusted(), inputMonitoring: CGPreflightListenEventAccess())
    }

    /// Twice a second while the flow runs, so the screen moves on when the grant appears. The
    /// trust flags cost a syscall each; nothing reads the screen.
    private func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func poll() {
        guard let flow, !flow.state.finished else { return stopPolling() }
        let now = readPermissions()
        if now != flow.state.permissions { flow.send(.permissions(now)) }
    }

    // MARK: - The window

    private func showWindow() {
        let hosting = NSHostingView(rootView: OnboardingRoot(model: model) { [weak self] event in self?.flow?.send(event) })
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: OnboardingView.size),
            styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false
        )
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.title = "Set up Caret"
        window.contentView = hosting
        window.setContentSize(OnboardingView.size)
        window.center()
        self.window = window
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            // Closed with the window button: the choices made so far are already saved; the flow
            // is left unfinished, and Set Up Caret starts it again.
            MainActor.assumeIsolated {
                self?.stopPolling()
                self?.flow = nil
                self?.window = nil
            }
        }
        installKeys()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Return continues and Esc goes back on every screen; on the try-it screen Tab, Delete and
    /// typed characters go to the staged field. These are the window's own key events (the app's
    /// local monitor), so the try-it completes only on a real Tab pressed in this window.
    private func installKeys() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let flow = self.flow, event.window === self.window else { return event }
                guard let mapped = Self.event(for: event, step: flow.state.step) else { return event }
                flow.send(mapped)
                return nil
            }
        }
    }

    static func event(for event: NSEvent, step: OnboardingStep) -> OnboardingFlow.Event? {
        let mods = event.modifierFlags.intersection([.command, .control, .option])
        guard mods.isEmpty else { return nil }
        switch event.keyCode {
        case 36, 76: return .next
        case 53: return .back
        default: break
        }
        guard step == .tryIt else { return nil }
        switch event.keyCode {
        case 48: return event.modifierFlags.contains(.shift) ? nil : .key(.tab)
        case 51, 117: return .key(.delete)
        default:
            // Arrows and other function keys arrive as private-use characters (U+F700 to U+F8FF).
            let typed = { (u: Unicode.Scalar) in !CharacterSet.controlCharacters.contains(u) && !(0xF700...0xF8FF).contains(u.value) }
            guard let text = event.characters, !text.isEmpty, text.unicodeScalars.allSatisfy(typed) else {
                return .key(.other)
            }
            return .key(.character(text))
        }
    }

    // MARK: - Debug socket

    func debugInfo() -> DebugState.OnboardingInfo? {
        guard var info = flow?.debugInfo() else { return nil }
        info.windowShown = window?.isVisible ?? false
        info.suppressed = suppressed.isEmpty ? nil : suppressed
        return info
    }

    /// `onboarding` reads the flow. With test hooks, the rest drive it as the window would:
    ///   onboarding open | close | next | back
    ///   onboarding role fill|repeat|watch|words on|off      onboarding level quiet|balanced|eager
    ///   onboarding key tab|delete|return|esc|other|char:<c>
    ///   onboarding permissions on|off on|off   (Accessibility, Input Monitoring: the run's own grants)
    ///   onboarding reply <firstLookReply json>              onboarding look-again
    func command(_ words: [String]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func reply() -> String {
            guard let info = debugInfo() else { return #"{"open":false}"# }
            return (try? String(decoding: encoder.encode(info), as: UTF8.self)) ?? "{}"
        }
        guard words.count > 1 else { return reply() }
        guard testHooks else { return #"{"error":"onboarding commands are test hooks: start the host with --test-hooks"}"# }
        let rest = Array(words.dropFirst())
        if rest == ["open"] {
            // The socket never puts a window up: it drives the flow as the window would.
            open(drawing: false)
            return reply()
        }
        guard let flow else { return #"{"error":"onboarding is not open"}"# }
        func onOff(_ w: String) -> Bool? { w == "on" ? true : (w == "off" ? false : nil) }
        switch (rest[0], rest.count) {
        case ("close", 1): close()
        case ("next", 1): flow.send(.next)
        case ("back", 1): flow.send(.back)
        case ("look-again", 1): flow.send(.lookAgain)
        case ("role", 3):
            guard let role = CaretRole(rawValue: rest[1]), let on = onOff(rest[2]) else { return #"{"error":"usage: onboarding role fill|repeat|watch|words on|off"}"# }
            flow.send(.setRole(role, on))
        case ("level", 2):
            guard let level = CaretLevel(rawValue: rest[1]) else { return #"{"error":"usage: onboarding level quiet|balanced|eager"}"# }
            flow.send(.setLevel(level))
        case ("key", 2):
            let key: TryItKey
            switch rest[1] {
            case "tab": key = .tab
            case "delete": key = .delete
            case "return": key = .returnKey
            case "esc": key = .escape
            case "other": key = .other
            case let k where k.hasPrefix("char:") && k.count == 6: key = .character(String(k.suffix(1)))
            default: return #"{"error":"usage: onboarding key tab|delete|return|esc|other|char:<c>"}"#
            }
            flow.send(.key(key))
        case ("permissions", 3):
            guard let ax = onOff(rest[1]), let im = onOff(rest[2]) else { return #"{"error":"usage: onboarding permissions on|off on|off"}"# }
            permissionsOverride = OnboardingPermissions(accessibility: ax, inputMonitoring: im)
            poll()
        case ("reply", _) where rest.count >= 2:
            let json = rest.dropFirst().joined(separator: " ")
            do {
                flow.send(.firstLookReply(try FirstLookReply.decode(Data(json.utf8))))
            } catch {
                return "{\"error\":\(HostRuntime.jsonString(String(describing: error)))}"
            }
        default:
            return #"{"error":"unknown onboarding command"}"#
        }
        return reply()
    }
}

/// The window's root: redraws the view whenever the flow's state changes.
private struct OnboardingRoot: View {
    @ObservedObject var model: OnboardingController.Model
    @ObservedObject private var figure = FigureSettings.shared
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        if let state = model.state {
            OnboardingView(state: state, character: figure.character, send: send)
        }
    }
}
