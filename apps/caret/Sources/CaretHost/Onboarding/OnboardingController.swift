import AppKit
import ApplicationServices
import CaretHostCore
import CaretScreenCore
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
        /// Never opens by itself; the menu's Set Up Caret opens it. A test run's default, so test
        /// runs of the host never put a window up (`OnboardingLaunch.defaultMode`).
        case off
        /// Opens at launch until onboarding has reached its end once, and after that on its
        /// permissions step alone while Accessibility is off (`OnboardingLaunch.auto`). The user's
        /// own Caret's default since H12.
        case auto
        /// Opens at launch.
        case show
        /// Runs without a window; only the debug socket drives it.
        case hidden

    }

    /// The key step's system side (H12): whether Caret has a key, the check with Jev, the keychain, and the helper's
    /// restart. The app shell fills it from `CaretServices`; the default has a key already, so a runtime built without
    /// services (a test) never shows the step or touches a keychain.
    struct JevKeyHooks {
        /// The helper has a key from anywhere: the keychain, or a development run's environment.
        var available: () -> Bool = { true }
        /// The keychain holds one.
        var stored: () -> Bool = { false }
        var check: (String) async -> JevKeyCheck.Outcome = { _ in .unreachable }
        /// Saves to the keychain; false when the keychain refused.
        var save: (String) -> Bool = { _ in false }
        /// After a save: start the helper again with the key.
        var saved: () -> Void = {}
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
    var permissionsOverride: OnboardingPermissions?
    /// A test run's stand-in for the running apps that also take Tab (`onboarding tab-owners`).
    private var tabOwnersOverride: [String]?
    /// Sends a request to the helper; false when it is not connected.
    var sendFirstLook: (FirstLookRequest) -> Bool = { _ in false }
    /// Take, stop and undo the first look's offer; each false when the helper is not connected.
    var sendAccept: (OfferAccept) -> Bool = { _ in false }
    var sendStop: (OfferStop) -> Bool = { _ in false }
    var sendControl: (TaskControl) -> Bool = { _ in false }
    /// H8: asks for Calendar access before a found event card's accept goes, as at the caret (`SurfaceMachine`).
    var calendars: CalendarAccessAsking = EventKitCalendars.shared
    /// The found event card's key while its accept waits on macOS's Calendar prompt.
    private var calendarHeld: String?
    /// The name and email typed on the `know` screen, for memory to keep.
    var onRemember: ([TypedAbout]) -> Void = { _ in }
    /// Skip after an earlier Continue: those values are not to be kept.
    var onForgetTyped: ([String]) -> Void = { _ in }
    /// A grant changed while the flow runs (the runtime retries a key tap the system refused).
    var onPermissionsChanged: (OnboardingPermissions) -> Void = { _ in }
    /// The permissions screen's Add to Chrome (H4); the app shell runs `ChromeBridgeInstaller`.
    var onAddToChrome: () -> Void = {}
    /// Whether the helper keeps typed values (`MemoryBook.State.acceptsAdd`), read when a flow opens.
    var knowAvailable: () -> Bool = { false }
    /// What the window refused to do because it is hidden, for the debug state.
    private var suppressed: [String] = []
    var jevKey = JevKeyHooks()
    /// Bumped by every key check this controller starts, in any flow. Only the newest may save: a check from a flow
    /// closed and opened again must not write over a key saved after it (H12 review).
    private var jevKeyGeneration = 0

    init(mode: Mode, testHooks: Bool, store: SettingsStore = .shared) {
        self.mode = mode
        self.testHooks = testHooks
        self.store = store
        store.observe { [weak self] settings in self?.flow?.send(.settingsChanged(settings)) }
    }

    /// The open flow has a window. False for a hidden run, and for a flow the debug socket opened.
    private var drawsWindow = false

    /// At launch: opens when the mode says so.
    func launch() {
        guard let opening = launchOpening() else { return }
        let drawing = mode != .hidden
        switch opening {
        case .all: open(drawing: drawing)
        case .only(let step): open(drawing: drawing, only: step)
        }
    }

    /// What `launch` opens, from the mode, the finished flag in Caret's settings and the grants.
    func launchOpening() -> OnboardingLaunch.Opening? {
        switch mode {
        case .off: return nil
        case .auto: return OnboardingLaunch.auto(onboarded: store.settings.onboarded, permissions: readPermissions())
        case .show, .hidden: return .all
        }
    }

    /// Starts the flow from the current settings and grants, with its window when `drawing` (the
    /// menu's Set Up Caret) and never on a hidden run. An open flow is brought forward rather than
    /// restarted. `only`: the flow is that one step (a returning user missing Accessibility, the
    /// menu's "Jev is off").
    func open(drawing: Bool, only: OnboardingStep? = nil) {
        if let flow, !flow.state.finished {
            // Only the menu brings a window forward; the socket never shows one.
            if drawing, drawsWindow, let window {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
            }
            return
        }
        drawsWindow = drawing && mode != .hidden
        let flow = OnboardingFlow(
            settings: store.settings, permissions: readPermissions(), clock: RunLoopClock(),
            token: String(UUID().uuidString.prefix(8)).lowercased(), showsKnow: only == nil && knowAvailable(),
            jevKeyAvailable: jevKey.available(), jevKeyStored: jevKey.stored(), only: only
        )
        flow.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        flow.send(.otherTabOwners(readTabOwners()))
        self.flow = flow
        model.state = flow.state
        startPolling()
        guard drawsWindow else { return }
        showWindow()
    }

    /// Ends the flow's window and polling. A finished flow is kept for the debug state; an
    /// unfinished one is dropped, so the next open starts it again (the choices already made are
    /// saved). The window's close button ends up here too.
    func close() {
        stopPolling()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        let closing = window
        window = nil
        closing?.orderOut(nil)
        if flow?.state.finished == false {
            flow?.cancelTimers()
            flow = nil
            calendarHeld = nil
        }
        model.state = flow?.state
    }

    /// The helper's memory list said, again or anew, whether it keeps typed values.
    func knowAvailableChanged(_ available: Bool) {
        guard let flow, flow.state.showsKnow != available else { return }
        flow.send(.knowAvailable(available))
    }

    func receive(_ reply: FirstLookReply) {
        flow?.send(.firstLookReply(reply))
    }

    /// Every withdrawal; the flow acts only on its found offer's.
    func receive(_ withdrawn: OfferWithdrawn) {
        flow?.send(.offerWithdrawn(withdrawn))
    }

    /// Progress of every task; the flow keeps the one it took (the first look's offer).
    func receive(_ progress: TaskProgress) {
        guard flow?.state.firstLookRun != nil else { return }
        flow?.send(.taskProgress(progress))
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
        case .remember(let items): onRemember(items)
        case .forgetTyped(let labels): onForgetTyped(labels)
        case .openSystemSettings(let pane):
            guard drawsWindow else { return suppressed.append("openSystemSettings.\(pane.rawValue)") }
            Self.openSettings(pane)
        case .addToChrome:
            guard drawsWindow else { return suppressed.append("addToChrome") }
            onAddToChrome()
        case .checkJevKey(let key):
            checkJevKey(key)
        case .askFirstLook(let request):
            if !sendFirstLook(request) { flow?.send(.firstLookUnsent) }
        case .accept(let accept):
            if foundFamily(accept.offerId) == "event", calendars.access == .notDetermined {
                // H8: the first event card accepted asks for Calendar access first, here as at the caret.
                calendarHeld = accept.offerId
                calendars.requestAccess { [weak self] _ in MainActor.assumeIsolated { self?.calendarAnswered(accept) } }
                return
            }
            if !sendAccept(accept) { flow?.send(.sendFailed(.accept)) }
        case .stop(let stop):
            // An accept still waiting on the Calendar prompt never reached the helper: nothing to stop there.
            if calendarHeld == stop.offerId { calendarHeld = nil; return }
            // A stop that cannot be written leaves nothing to stop: the helper and its run are gone.
            _ = sendStop(stop)
        case .undo(let control):
            if !sendControl(control) { flow?.send(.sendFailed(.undo)) }
        case .filled: break
        case .close: close()
        }
    }

    /// One request to Jev, then the keychain on an answer that keeps the key, then the helper. The save goes ahead even
    /// if the window closed meanwhile, since the user pressed Continue to keep it, unless a newer check has started
    /// since. Only the flow that asked hears the answer.
    private func checkJevKey(_ key: SecretText) {
        let hooks = jevKey
        let asking = flow
        jevKeyGeneration += 1
        let generation = jevKeyGeneration
        Task { @MainActor [weak self] in
            let outcome = await hooks.check(key.reveal)
            var saved = false
            if outcome.keepsKey, self?.jevKeyGeneration == generation {
                saved = hooks.save(key.reveal)
                if saved { hooks.saved() }
            }
            guard let self, let flow = self.flow, flow === asking else { return }
            flow.send(.jevKeyChecked(outcome, saved: saved))
        }
    }

    /// The first look's found offer's family, when `offerKey` is its key.
    private func foundFamily(_ offerKey: String) -> String? {
        guard case .found(let found)? = flow?.state.firstLook, found.offerKey == offerKey else { return nil }
        return found.family
    }

    /// macOS answered: the held accept goes only while its run is still the one on screen (not stopped,
    /// not closed with the flow).
    private func calendarAnswered(_ accept: OfferAccept) {
        guard calendarHeld == accept.offerId, let run = flow?.state.firstLookRun, run.offerKey == accept.offerId, run.working else {
            calendarHeld = nil
            return
        }
        calendarHeld = nil
        var sent = accept
        sent.at = Int64(Date().timeIntervalSince1970 * 1000)
        if !sendAccept(sent) { flow?.send(.sendFailed(.accept)) }
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

    /// `NSWorkspace.runningApplications` is kept current by AppKit, so reading it costs no walk.
    private func readTabOwners() -> [String] {
        tabOwnersOverride ?? OtherTabOwners.running(in: NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
    }

    private func poll() {
        guard let flow, !flow.state.finished else { return stopPolling() }
        // An app quit or launched while the flow runs: the try-it line follows it.
        let owners = readTabOwners()
        if owners != flow.state.otherTabOwners { flow.send(.otherTabOwners(owners)) }
        let now = readPermissions()
        guard now != flow.state.permissions else { return }
        flow.send(.permissions(now))
        onPermissionsChanged(now)
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
            MainActor.assumeIsolated { self?.close() }
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
                let state = flow.state
                // Return that commits an input method's composition (Japanese, Chinese) in the name
                // field belongs to the field, not to Continue.
                let composing = (event.window?.firstResponder as? NSTextView)?.hasMarkedText() ?? false
                // Caret has no main menu, which is where ⌘V, ⌘C, ⌘X and ⌘A reach a text field from in other apps;
                // without this, the key step's field could not take a paste.
                if state.step != .firstLook, let action = Self.editAction(for: event), NSApp.sendAction(action, to: nil, from: nil) { return nil }
                guard let mapped = Self.event(for: event, step: state.step, offerVisible: state.tryIt.offerVisible, firstLook: state.firstLookKeys, composing: composing) else { return event }
                flow.send(mapped)
                return nil
            }
        }
    }

    /// ⌘V, ⌘C, ⌘X and ⌘A as the Edit menu would send them, or nil for any other key.
    static func editAction(for event: NSEvent) -> Selector? {
        guard event.modifierFlags.intersection([.command, .control, .option, .shift]) == .command else { return nil }
        switch event.charactersIgnoringModifiers {
        case "v": return #selector(NSText.paste(_:))
        case "c": return #selector(NSText.copy(_:))
        case "x": return #selector(NSText.cut(_:))
        case "a": return #selector(NSText.selectAll(_:))
        default: return nil
        }
    }

    /// Tab is the staged field's only while its offer shows; otherwise it moves focus as usual. On
    /// the first look, Tab, ⌘1 to ⌘3, ⌘Z and Esc go to the offer and its line only while they
    /// take them (`FirstLookKeys`); otherwise they keep the window's meaning.
    static func event(for event: NSEvent, step: OnboardingStep, offerVisible: Bool, firstLook: FirstLookKeys = .none, composing: Bool = false) -> OnboardingFlow.Event? {
        // Keys that finish or cancel an input method's composition are the text field's.
        if composing { return nil }
        let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if step == .firstLook, mods == .command {
            switch event.keyCode {
            case 6 where firstLook.undo: return .key(.undo)
            case 18, 19, 20:
                let digit = Int(event.keyCode) - 17
                return firstLook.digits.contains(digit) ? .key(.commandDigit(digit)) : nil
            default: return nil
            }
        }
        guard mods.subtracting(.shift).isEmpty else { return nil }
        switch event.keyCode {
        case 36, 76: return .next
        case 53: return step == .firstLook && firstLook.stop ? .key(.escape) : .back
        case 48 where step == .firstLook: return firstLook.tab && !mods.contains(.shift) ? .key(.tab) : nil
        default: break
        }
        guard step == .tryIt else { return nil }
        switch event.keyCode {
        case 48: return event.modifierFlags.contains(.shift) || !offerVisible ? nil : .key(.tab)
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
    ///   onboarding role fill|repeat|watch|calendar|words on|off      onboarding level quiet|balanced|eager
    ///   onboarding key tab|delete|return|esc|cmd-z|cmd-1|cmd-2|cmd-3|other|char:<c>
    ///   onboarding permissions on|off on|off   (Accessibility, Input Monitoring: the run's own grants)
    ///   onboarding tab-owners none|<name...>   (the running apps that also take Tab, as the run says)
    ///   onboarding reply <firstLookReply json>              onboarding look-again
    ///   onboarding about name|email <text...>               onboarding skip
    ///   onboarding jev-key <text>                           (the key field's text, as pasting it would)
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
        case ("skip", 1): flow.send(.skip)
        case ("jev-key", 2):
            flow.send(.setJevKey(rest[1]))
        case ("about", _) where rest.count >= 2:
            guard let field = AboutField(rawValue: rest[1]) else { return #"{"error":"usage: onboarding about name|email <text>"}"# }
            flow.send(.setAbout(field, rest.dropFirst(2).joined(separator: " ")))
        case ("role", 3):
            guard let role = CaretRole(rawValue: rest[1]), let on = onOff(rest[2]) else { return #"{"error":"usage: onboarding role fill|repeat|watch|calendar|words on|off"}"# }
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
            case "cmd-z": key = .undo
            case "cmd-1", "cmd-2", "cmd-3": key = .commandDigit(Int(String(rest[1].last!))!)
            case "other": key = .other
            case let k where k.hasPrefix("char:") && k.count == 6: key = .character(String(k.suffix(1)))
            default: return #"{"error":"usage: onboarding key tab|delete|return|esc|cmd-z|cmd-1|cmd-2|cmd-3|other|char:<c>"}"#
            }
            flow.send(.key(key))
        case ("permissions", 3):
            guard let ax = onOff(rest[1]), let im = onOff(rest[2]) else { return #"{"error":"usage: onboarding permissions on|off on|off"}"# }
            permissionsOverride = OnboardingPermissions(accessibility: ax, inputMonitoring: im)
            poll()
        case ("tab-owners", _) where rest.count >= 2:
            tabOwnersOverride = rest[1] == "none" ? [] : Array(rest.dropFirst())
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
