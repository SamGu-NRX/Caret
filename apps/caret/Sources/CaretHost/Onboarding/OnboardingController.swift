import AppKit
import ApplicationServices
import CaretHostCore
import CaretScreenCore
import CoreGraphics
import notify
import Security
import SwiftUI

/// Onboarding's window and the system side of `OnboardingFlow`: it reads the grant, raises macOS's Accessibility alert
/// and opens the pane, keeps the window beside System Settings as a guide while the switch is off, asks the local model
/// for the Hello field and the helper for the preview and the first look, records progress so a relaunch resumes, and
/// turns the window's keys into the flow's events.
///
/// `hidden` runs the same flow with no window, for socket-level runs while someone is using the Mac: nothing is ordered
/// on screen and System Settings is never opened.
@MainActor
final class OnboardingController {
    enum Mode: String {
        /// Never opens by itself; the menu's Set Up Caret opens it. A test run's default.
        case off
        /// The user's own Caret: at launch until finished, resuming where it was (`OnboardingLaunch.auto`).
        case auto
        /// Opens at launch, from the start.
        case show
        /// Runs without a window; only the debug socket drives it.
        case hidden
    }

    /// The key field's system side (H12), filled from `CaretServices` by the app shell. The default has a key already,
    /// so a runtime built without services never shows the field or touches a keychain.
    struct JevKeyHooks {
        var available: () -> Bool = { true }
        var stored: () -> Bool = { false }
        var check: (String) async -> JevKeyCheck.Outcome = { _ in .unreachable }
        var save: (String) -> Bool = { _ in false }
        var saved: () -> Void = {}
    }

    final class Model: ObservableObject {
        @Published var state: OnboardingFlow.State?
    }

    let mode: Mode
    private let testHooks: Bool
    private let store: SettingsStore
    /// Where `OnboardingProgress` is kept: beside the settings file, so a test run with its own settings never reads
    /// or writes the user's.
    private let progressPath: String?
    private let model = Model()
    private var flow: OnboardingFlow?
    private var window: NSWindow?
    private var keyMonitor: Any?
    private var pollTimer: Timer?
    private var closeObserver: NSObjectProtocol?
    private var completion: Task<Void, Never>?
    /// Test stand-ins (`onboarding permissions`, `onboarding model`, `onboarding tab-owners`).
    var permissionsOverride: OnboardingPermissions?
    private var modelOverride: ModelReadiness?
    private var tabOwnersOverride: [String]?
    /// Sends a request to the helper; false when it is not connected.
    var sendFirstLook: (FirstLookRequest) -> Bool = { _ in false }
    /// Asks the helper for the preview; false when it is not connected or does not speak it yet.
    var sendPreview: (_ requestId: String, _ families: [String], _ level: CaretLevel) -> Bool = { _, _, _ in false }
    var sendAccept: (OfferAccept) -> Bool = { _ in false }
    var sendStop: (OfferStop) -> Bool = { _ in false }
    var sendControl: (TaskControl) -> Bool = { _ in false }
    /// The local model's next words after `text`, or nil.
    var complete: (String) async -> String? = { _ in nil }
    var modelReadiness: () -> ModelReadiness = { .unavailable }
    /// H8: asks for Calendar access before a found event's accept goes.
    var calendars: CalendarAccessAsking = EventKitCalendars.shared
    private var calendarHeld: String?
    /// Add to your browser (`ChromeBridgeInstaller.run`), which the app shell owns.
    var onAddToBrowser: () -> Void = {}
    /// This copy runs in-process until onboarding ends (`CaretServices.registersAfterOnboarding`).
    var registersLoginItemLater: () -> Bool = { false }
    /// Register the login item and hand off to it (the app shell stops this copy).
    var onLoginItemDue: () -> Void = {}
    /// A grant changed while the flow runs (the runtime retries a key tap the system refused).
    var onPermissionsChanged: (OnboardingPermissions) -> Void = { _ in }
    /// What the window refused to do because it is hidden, for the debug state.
    private var suppressed: [String] = []
    var jevKey = JevKeyHooks()
    private var jevKeyGeneration = 0
    private let guide = GuidePlacement()
    /// "Drag Caret into the list above", inside System Settings while the switch is off.
    private let dragPanel = SettingsDragPanel()
    /// The window waits this long for System Settings to appear before it shows its own guide instead.
    private var settingsWait: Timer?

    init(mode: Mode, testHooks: Bool, store: SettingsStore = .shared, progressPath: String? = nil) {
        self.mode = mode
        self.testHooks = testHooks
        self.store = store
        self.progressPath = progressPath
        store.observe { [weak self] settings in self?.flow?.send(.settingsChanged(settings)) }
    }

    private var drawsWindow = false

    // MARK: - Progress

    var progress: OnboardingProgress? {
        guard let progressPath else { return nil }
        return OnboardingProgress.decode(FileManager.default.contents(atPath: progressPath))
    }

    /// Reads, changes and writes the progress file, making its folder (0700) when the settings folder does not exist
    /// yet. A write that fails is logged: resuming then starts at the beginning, which is safe but worse.
    private func updateProgress(_ change: (inout OnboardingProgress) -> Void) {
        guard let progressPath else { return }
        var p = progress ?? OnboardingProgress(step: .hello, at: 0)
        change(&p)
        p.at = Int64(Date().timeIntervalSince1970 * 1000)
        let url = URL(fileURLWithPath: progressPath)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try p.encoded().write(to: url, options: .atomic)
        } catch {
            FileHandle.standardError.write(Data("caret: onboarding progress not saved: \(error.localizedDescription)\n".utf8))
        }
    }

    private func saveProgress(_ step: OnboardingStep) { updateProgress { $0.step = step } }

    /// Until the person sends the first look or keeps everything on the Mac, only the local next words run: the roles
    /// that ask the cloud model are held (written down first, so a relaunch holds the same ones) and given back on
    /// Send. Returns the roles the flow looks with.
    private func holdCloudRoles() -> Set<CaretRole> {
        if let held = progress?.heldRoles ?? heldRoles { return Set(held.compactMap(CaretRole.init(rawValue:))) }
        let roles = store.settings.roles
        // Kept here as well as in the file, so a run whose progress cannot be written never loses the roles.
        heldRoles = roles.map(\.rawValue).sorted()
        updateProgress { $0.heldRoles = roles.map(\.rawValue).sorted() }
        store.update(source: .onboarding) { $0.roles = $0.roles.intersection([.words]) }
        return roles
    }

    private func decided(sent: Bool) {
        guard let held = progress?.heldRoles ?? heldRoles else { return }
        if sent { store.update(source: .onboarding) { $0.roles = Set(held.compactMap(CaretRole.init(rawValue:))) } }
        heldRoles = nil
        updateProgress { $0.heldRoles = nil }
    }

    private var heldRoles: [String]?

    private var coachShownCache: Bool?

    /// The coach slip has been shown on this install. Read from the file once, then kept, since it is asked on every
    /// ghost text.
    var coachShown: Bool {
        if let coachShownCache { return coachShownCache }
        let shown = progress?.coachShown == true
        coachShownCache = shown
        return shown
    }

    /// The coach slip was shown: never again on this install.
    func markCoachShown() {
        coachShownCache = true
        updateProgress { $0.coachShown = true }
    }

    // MARK: - Opening

    /// At launch: opens when the mode says so, where the last run left off.
    func launch() {
        guard let opening = launchOpening() else { return }
        open(drawing: mode != .hidden, opening: opening)
    }

    func launchOpening() -> OnboardingLaunch.Opening? {
        switch mode {
        case .off: return nil
        case .auto: return OnboardingLaunch.auto(onboarded: store.settings.onboarded, permissions: readPermissions(), progress: progress)
        case .show, .hidden: return OnboardingLaunch.Opening(step: .hello)
        }
    }

    /// Starts the flow with its window when `drawing`. An open flow is brought forward rather than restarted.
    func open(drawing: Bool, opening: OnboardingLaunch.Opening? = nil) {
        if let flow, !flow.state.finished {
            if drawing, drawsWindow, let window {
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
            }
            return
        }
        drawsWindow = drawing && mode != .hidden
        let permissions = readPermissions()
        let start = opening ?? OnboardingLaunch.Opening(step: permissions.accessibility ? .on : .hello)
        var settings = store.settings
        if !start.alone, !store.settings.onboarded { settings.roles = holdCloudRoles() }
        let flow = OnboardingFlow(
            settings: settings, permissions: permissions, clock: RunLoopClock(),
            token: String(UUID().uuidString.prefix(8)).lowercased(), opening: start,
            jevKeyAvailable: jevKey.available(), jevKeyStored: jevKey.stored()
        )
        flow.output = { [weak self] command in MainActor.assumeIsolated { self?.perform(command) } }
        self.flow = flow
        flow.send(.model(readModel()))
        flow.send(.apps(HelloAppsReader.read()))
        flow.send(.otherTabOwners(readTabOwners()))
        flow.send(Self.readBrowsers())
        flow.send(.otherCarets(Self.readOtherCarets()))
        flow.send(.staleGrant(AccessibilityAccess.isStale(grantedSignature: progress?.grantedSignature,
                                                          currentSignature: Self.ownSignature(), trusted: permissions.accessibility)))
        flow.start()
        startGrantDetection()
        if progress?.pendingBrowserAdd == true, flow.state.step == .browser, !registersLoginItemLater() {
            updateProgress { $0.pendingBrowserAdd = nil }
            flow.send(.next)
        }
        model.state = flow.state
        startPolling()
        guard drawsWindow else { return }
        showWindow()
    }

    /// The menu's "Caret can't see your apps": the switch step alone, which finishes when the grant lands.
    func openAccess() {
        open(drawing: true, opening: OnboardingLaunch.Opening(step: .access, alone: true))
        perform(.openSystemSettings)
    }

    /// The menu's "Jev is off": the `on` step alone, which carries the key field.
    func openKey() {
        open(drawing: true, opening: OnboardingLaunch.Opening(step: .on, alone: true))
    }

    /// Ends the window and polling. An unfinished flow is dropped; its progress file says where to resume.
    func close() {
        stopPolling()
        stopGrantDetection()
        completion?.cancel()
        completion = nil
        dragPanel.stop()
        settingsWait?.invalidate()
        settingsWait = nil
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

    func receive(_ reply: FirstLookReply) { flow?.send(.firstLookReply(reply)) }

    /// The helper heard a page engine say hello: the extension is connected through the bridge.
    func browserConnected() { flow?.send(.browserConnected) }

    /// What Add to <browser> did: a failure goes back to the step, which says why and offers Add again.
    func browserAddFinished(ok: Bool, message: String) {
        if !ok { flow?.send(.browserAddFailed(message)) }
    }

    /// Installed Chromium browsers, the default one first: those Caret's bridge trusts and those it does not yet.
    static func readBrowsers() -> OnboardingFlow.Event {
        let ws = NSWorkspace.shared
        let defaultID = ws.urlForApplication(toOpen: URL(string: "https://example.com")!).flatMap { Bundle(url: $0)?.bundleIdentifier }
        let installed = BridgeBrowser.allCases.filter { ws.urlForApplication(withBundleIdentifier: $0.bundleIdentifier) != nil }
            .sorted { ($0.bundleIdentifier == defaultID ? 0 : 1) < ($1.bundleIdentifier == defaultID ? 0 : 1) }
        return .browsers(trusted: installed.filter(\.isTrustedByBridge).map(\.displayName),
                         untrusted: installed.filter { !$0.isTrustedByBridge }.map(\.displayName))
    }
    func receive(_ withdrawn: OfferWithdrawn) { flow?.send(.offerWithdrawn(withdrawn)) }

    func receive(_ progress: TaskProgress) {
        guard flow?.state.first.run != nil else { return }
        flow?.send(.taskProgress(progress))
    }

    /// The helper's preview, in the screen's terms: a line that stays carries no text at all, whatever the wire held.
    func receive(_ preview: FirstLookPreview) {
        flow?.send(.previewReady(requestId: preview.requestId, Self.screenPreview(preview)))
    }

    static func screenPreview(_ p: FirstLookPreview) -> OnboardingPreview {
        OnboardingPreview(previewId: p.previewId, windows: p.windows.map { w in
            OnboardingPreview.Window(bundleId: w.bundleId, appName: w.appName, title: w.title,
                                     lines: w.lines.map { .init(text: $0.sent ? $0.text : nil) }, chars: w.charsSent)
        }, chars: p.totalChars)
    }

    // MARK: - The flow's commands

    private func perform(_ command: OnboardingFlow.Command) {
        switch command {
        case .changed:
            model.state = flow?.state
            dragPanel.landed = flow?.state.access.granted == true
            if flow?.state.step != .access {
                dragPanel.stop()
                settingsWait?.invalidate()
                settingsWait = nil
            }
            followFrame()
        case .finished:
            store.update(source: .onboarding) { $0.onboarded = true }
            if drawsWindow, registersLoginItemLater() { onLoginItemDue() }
        case .saveProgress(let step):
            saveProgress(step)
        case .addToBrowser:
            guard drawsWindow else { return suppressed.append("addToBrowser") }
            if registersLoginItemLater() {
                // Only the agent can vend the bridge the extension connects to: hand off now, and its copy adds.
                updateProgress { $0.pendingBrowserAdd = true }
                return onLoginItemDue()
            }
            onAddToBrowser()
        case .openSystemSettings:
            guard drawsWindow else { return suppressed.append("openSystemSettings") }
            // An entry this build isn't trusted under is another copy's or none: reset it first, so the drag adds one
            // bound to this build (AccessibilityAccess.resetsBeforeAsking). Then macOS's alert puts Caret in the list.
            if resetOwnEntries(AccessibilityAccess.resetsBeforeAsking(accessibility: AXIsProcessTrusted(), listenEvents: CGPreflightListenEventAccess(),
                                                                       postEvents: CGPreflightPostEventAccess()), why: "before asking") {
                updateProgress { $0.axAsked = nil; $0.grantedSignature = nil }
            }
            // macOS's alert is what first puts Caret in the list; after that it shows nothing, so only the pane opens.
            if AccessibilityAccess.shouldPrompt(asked: progress?.axAsked == true, trusted: AXIsProcessTrusted()) {
                updateProgress { $0.axAsked = true }
                // Caret in front first: from the login item or a launch behind another app, macOS's alert otherwise
                // opened behind the front app, where a person can miss it (after-run 263afe5, stale leg).
                NSApp.activate(ignoringOtherApps: true)
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                bringAlertForward()
            }
            openedSettingsAt = Date()
            Self.openAccessibilityPane()
            startDragPanel()
        case .resetGrant:
            guard drawsWindow else { return suppressed.append("resetGrant") }
            resetOwnGrant()
        case .bringForward:
            guard drawsWindow, let window else { return }
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
        case .complete(let id, let text):
            completion?.cancel()
            let complete = self.complete
            completion = Task { @MainActor [weak self] in
                let ghost = await complete(text)
                guard !Task.isCancelled else { return }
                self?.flow?.send(.ghost(requestId: id, text: ghost))
            }
        case .askPreview(let id, let families, let level):
            if !sendPreview(id, families, level) { flow?.send(.previewFailed(requestId: id, "helperNotConnected")) }
        case .checkJevKey(let key):
            checkJevKey(key)
        case .askFirstLook(var request, let previewId):
            request.previewId = previewId
            if !sendFirstLook(request) { flow?.send(.firstLookUnsent) }
        case .consent(let sent):
            decided(sent: sent)
        case .accept(let accept):
            if foundFamily(accept.offerId) == "event", calendars.access == .notDetermined {
                // H8: the first event accepted asks for Calendar access first.
                calendarHeld = accept.offerId
                flow?.send(.calendarAsking)
                calendars.requestAccess { [weak self] granted in MainActor.assumeIsolated { () -> Void in self?.calendarAnswered(accept, granted: granted.granted) } }
                return
            }
            if !sendAccept(accept) { flow?.send(.sendFailed(.accept)) }
        case .stop(let stop):
            if calendarHeld == stop.offerId { calendarHeld = nil; return }
            _ = sendStop(stop)
        case .undo(let control):
            if !sendControl(control) { flow?.send(.sendFailed(.undo)) }
        case .close:
            close()
        }
    }

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

    private func foundFamily(_ offerKey: String) -> String? {
        guard let found = flow?.state.firstLookFound, found.offerKey == offerKey else { return nil }
        return found.family
    }

    /// macOS answered. Denied: the run ends with its line (`calendarAnswered(false)`). Granted: the held accept goes
    /// while its run is still the one on screen.
    private func calendarAnswered(_ accept: OfferAccept, granted: Bool) {
        guard calendarHeld == accept.offerId else { return }
        calendarHeld = nil
        flow?.send(.calendarAnswered(granted))
        guard granted, let run = flow?.state.first.run, run.offerKey == accept.offerId, run.working else { return }
        var sent = accept
        sent.at = Int64(Date().timeIntervalSince1970 * 1000)
        if !sendAccept(sent) { flow?.send(.sendFailed(.accept)) }
    }

    /// The pane: each address in turn until one opens (`NSWorkspace.open` reports whether it did), then System Settings
    /// itself as the last resort.
    private static func openAccessibilityPane() {
        for url in AccessibilityAccess.paneURLs where NSWorkspace.shared.open(url) { return }
        if let settings = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
            NSWorkspace.shared.openApplication(at: settings, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    /// This build's code signature (its cdhash, hex), which macOS's Accessibility entry is bound to.
    static func ownSignature() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any], let unique = dict[kSecCodeInfoUnique as String] as? Data else { return nil }
        return unique.map { String(format: "%02x", $0) }.joined()
    }

    /// macOS's Accessibility alert belongs to its own process (universalAccessAuthWarn), which can open behind the front
    /// app. Brings that process forward once its window is up: checked every 0.1 s for up to 2 s after the ask.
    private func bringAlertForward(attempt: Int = 0) {
        let alert = NSWorkspace.shared.runningApplications.first { $0.executableURL?.lastPathComponent == "universalAccessAuthWarn" }
        if let alert, !alert.isTerminated {
            alert.activate()
            return
        }
        guard attempt < 20 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            MainActor.assumeIsolated { self?.bringAlertForward(attempt: attempt + 1) }
        }
    }

    /// Removes Caret's own Accessibility entry (never another app's: `AccessibilityAccess.resetArguments`), forgets
    /// that macOS was asked, and opens the pane again, alert first, so Caret goes back into the list.
    private func resetOwnGrant() {
        _ = resetOwnEntries(AccessibilityAccess.ownServices, why: "stale entry")
        updateProgress { $0.axAsked = nil; $0.grantedSignature = nil }
        perform(.openSystemSettings)
    }

    /// `tccutil reset SERVICE dev.caret.host` for each service (Caret's own entries only:
    /// `AccessibilityAccess.resetArguments`), each exit status in the host log. True when one ran and exited 0. A
    /// failure only logs: the flow carries on as before.
    @discardableResult
    private func resetOwnEntries(_ services: [String], why: String) -> Bool {
        var any = false
        for service in services {
            guard let args = try? AccessibilityAccess.resetArguments(service: service, bundleID: Bundle.main.bundleIdentifier) else { continue }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            p.arguments = args
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            do {
                try p.run()
                p.waitUntilExit()
                FileHandle.standardError.write(Data("caret: tccutil reset \(service) (\(why)) exited \(p.terminationStatus)\n".utf8))
                if p.terminationStatus == 0 { any = true }
            } catch {
                FileHandle.standardError.write(Data("caret: tccutil reset \(service) (\(why)) failed: \(error.localizedDescription)\n".utf8))
            }
        }
        return any
    }

    /// Hands the switch step to the panel inside System Settings: Caret's own window steps out of the way. If System
    /// Settings has not shown its window within 6 s, or closes before the switch, the window comes back as the guide.
    private func startDragPanel() {
        dragPanel.onSettingsClosed = { [weak self] in self?.showGuideWindow() }
        dragPanel.onDismissed = { [weak self] in self?.showGuideWindow() }
        // The panel's first appearance travels from where Caret's window was.
        dragPanel.start(from: window?.isVisible == true ? window?.frame : nil)
        window?.orderOut(nil)
        settingsWait?.invalidate()
        settingsWait = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.settingsWait = nil
                guard !self.dragPanel.isShown, self.flow?.state.step == .access else { return }
                self.showGuideWindow()
            }
        }
    }

    private func showGuideWindow() {
        settingsWait?.invalidate()
        settingsWait = nil
        guard drawsWindow, let window, flow?.state.step == .access, !dragPanel.isShown else { return }
        shownFrame = nil
        followFrame()
        window.orderFrontRegardless()
    }

    // MARK: - Reading the system

    private func readPermissions() -> OnboardingPermissions {
        permissionsOverride ?? OnboardingPermissions(accessibility: AXIsProcessTrusted(), inputMonitoring: CGPreflightListenEventAccess())
    }

    private func readModel() -> ModelReadiness { modelOverride ?? modelReadiness() }

    private func readTabOwners() -> [String] {
        tabOwnersOverride ?? OtherTabOwners.running(in: NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))
    }

    /// Twice a second while the flow runs (HANDOFF §2: `AXIsProcessTrusted` at 2 Hz), so the guide moves on by itself
    /// when the switch lands. Each read is one call; nothing reads the screen.
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

    // MARK: - Instant grant detection

    private var detection: GrantDetection?
    private var openedSettingsAt = Date.distantPast

    /// Every other installed copy of Caret, from LaunchServices: they all show in System Settings as "Caret".
    static func readOtherCarets() -> [OtherCaret] {
        let installed = OtherCarets.knownIDs.flatMap { id in
            NSWorkspace.shared.urlsForApplications(withBundleIdentifier: id).map { OtherCaret(bundleID: id, path: $0.path) }
        }
        return OtherCarets.others(installed: installed, runningPath: Bundle.main.bundlePath)
    }
    private var axObserver: NSObjectProtocol?
    private var tccToken: Int32 = NOTIFY_TOKEN_INVALID

    /// macOS posts `com.apple.accessibility.api` when the Accessibility list changes, and `com.apple.tcc.access.changed`
    /// (public libnotify, as AltTab uses it) when any TCC entry does. Either one reads `AXIsProcessTrusted` after it has
    /// settled (`GrantDetection`), so the switch lands in about a quarter second instead of at the next poll, which
    /// stays as the backup. No private TCC call is made.
    private func startGrantDetection() {
        stopGrantDetection()
        let detection = GrantDetection(clock: RunLoopClock()) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.poll()
                // A change macOS announced that did not make this Caret trusted: if another Caret is installed, its
                // switch was the one turned on. Not in the first seconds after Caret asked, when its own entry is added.
                // Still untrusted 2 s after the notice (AccessibilityAccess.staleAfterNotice): the entry that changed is
                // another Caret's, or an older copy of this one.
                guard let flow = self.flow, flow.state.step == .access, !flow.state.permissions.accessibility,
                      Date().timeIntervalSince(self.openedSettingsAt) > 3 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + AccessibilityAccess.staleAfterNotice) { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self, let flow = self.flow, flow.state.step == .access, !AXIsProcessTrusted() else { return }
                        flow.send(.accessChangedStillUntrusted)
                    }
                }
            }
        }
        self.detection = detection
        axObserver = DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { detection.changed() }
        }
        notify_register_dispatch("com.apple.tcc.access.changed", &tccToken, DispatchQueue.main) { _ in
            MainActor.assumeIsolated { detection.changed() }
        }
    }

    private func stopGrantDetection() {
        detection?.cancel()
        detection = nil
        if let axObserver { DistributedNotificationCenter.default().removeObserver(axObserver) }
        axObserver = nil
        if tccToken != NOTIFY_TOKEN_INVALID { notify_cancel(tccToken) }
        tccToken = NOTIFY_TOKEN_INVALID
    }

    private func poll() {
        guard let flow, !flow.state.finished else { return stopPolling() }
        let owners = readTabOwners()
        if owners != flow.state.otherTabOwners { flow.send(.otherTabOwners(owners)) }
        let readiness = readModel()
        if readiness != flow.state.hello.model { flow.send(.model(readiness)) }
        let now = readPermissions()
        if now != flow.state.permissions {
            flow.send(.permissions(now))
            onPermissionsChanged(now)
            if now.accessibility, permissionsOverride == nil, let signature = Self.ownSignature() {
                updateProgress { $0.grantedSignature = signature }
            }
        }
        if flow.state.frame == .guide { followFrame() }
    }

    // MARK: - The window

    private var shownFrame: OnboardingFlow.Frame?

    private func showWindow() {
        let hosting = NSHostingView(rootView: OnboardingRoot(model: model) { [weak self] event in self?.flow?.send(event) })
        let size = OnboardingView.size(for: model.state?.frame ?? .main)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.title = "Set up Caret"
        window.contentView = hosting
        window.setContentSize(size)
        window.center()
        self.window = window
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            // The close button: set aside like Set up later; the progress file says where to resume.
            MainActor.assumeIsolated { self?.close() }
        }
        installKeys()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        followFrame()
    }

    /// Keeps the window's frame what the step asks: the main window centred, or the guide beside System Settings,
    /// floating so it stays in view while System Settings is in front (HANDOFF §4: 220 ms in-out between them; a jump
    /// under Reduce Motion).
    private func followFrame() {
        guard drawsWindow, let window, let state = flow?.state else { return }
        let frame = state.frame
        let animate = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && shownFrame != nil && shownFrame != frame
        switch frame {
        case .main:
            window.level = .normal
            guard shownFrame != .main else { return }
            let size = OnboardingView.size(for: .main)
            let screen = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
            let content = NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
            Self.move(window, to: window.frameRect(forContentRect: content), animate: animate)
        case .guide:
            // While the panel sits inside System Settings (or System Settings is still opening), Caret's own window
            // stays out of the way.
            if dragPanel.isShown || settingsWait != nil { return }
            window.level = .floating
            let size = OnboardingView.size(for: .guide)
            let content = guide.placement(for: size, screen: nil)
            let target = window.frameRect(forContentRect: content)
            if shownFrame != .guide || target.origin.distance(to: window.frame.origin) > 1 {
                // Following System Settings as it moves is a jump; only stepping aside from the main window animates.
                Self.move(window, to: target, animate: animate && shownFrame != .guide)
            }
        }
        shownFrame = frame
    }

    /// The window steps between its two frames in 220 ms with HANDOFF §4's in-out curve; under Reduce Motion it jumps.
    private static func move(_ window: NSWindow, to frame: NSRect, animate: Bool) {
        guard animate else { return window.setFrame(frame, display: true) }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = Motion.caCurve(OnboardingMotion.inOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    /// Return is the primary everywhere, including in the Hello field (an input method's composition excepted). Esc is
    /// Not now on the first step and nothing elsewhere. Tab is the Hello field's while a ghost shows and the offer's while
    /// it is takeable; otherwise it moves focus.
    private func installKeys() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let flow = self.flow, event.window === self.window else { return event }
                let state = flow.state
                let composing = (event.window?.firstResponder as? NSTextView)?.hasMarkedText() ?? false
                if state.step != .first, let action = Self.editAction(for: event), NSApp.sendAction(action, to: nil, from: nil) { return nil }
                guard let mapped = Self.event(for: event, state: state, composing: composing) else { return event }
                flow.send(mapped)
                return nil
            }
        }
    }

    /// ⌘V, ⌘C, ⌘X and ⌘A as the Edit menu would send them (Caret has no main menu).
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

    static func event(for event: NSEvent, state: OnboardingFlow.State, composing: Bool = false) -> OnboardingFlow.Event? {
        if composing { return nil }
        let mods = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let keys = state.firstLookKeys
        if state.step == .first, mods == .command {
            switch event.keyCode {
            case 6 where keys.undo: return .key(.undo)
            case 18, 19, 20:
                let digit = Int(event.keyCode) - 17
                return keys.digits.contains(digit) ? .key(.commandDigit(digit)) : nil
            default: return nil
            }
        }
        guard mods.subtracting(.shift).isEmpty else { return nil }
        switch event.keyCode {
        case 36, 76: return .next
        case 53: return state.step == .first ? .key(.escape) : nil
        case 48 where !mods.contains(.shift):
            switch state.step {
            case .hello: return state.hello.ghost != nil ? .key(.tab) : nil
            case .first: return keys.tab ? .key(.tab) : nil
            case .access, .browser, .on: return nil
            }
        default: return nil
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
    ///   onboarding open [hello|access|on|first] | close | next | later | keep | help | accept | not-now
    ///   onboarding type <text...>                  (the Hello field's whole text)
    ///   onboarding key tab|return|esc|cmd-z|cmd-1|cmd-2|cmd-3|other
    ///   onboarding permissions on|off on|off      (Accessibility, Input Monitoring)
    ///   onboarding model ready|loading|unavailable
    ///   onboarding browsers none|<name...>       onboarding browser-connected    onboarding skip-browser
    ///   onboarding preview empty|fail|<n windows>  (a stand-in preview for the open request)
    ///   onboarding tab-owners none|<name...>      onboarding reply <firstLookReply json>
    ///   onboarding jev-key <text>
    ///   onboarding trust-probe                    (this host's AXIsProcessTrusted beside a fresh `Caret --trust-probe`'s)
    ///   onboarding reset-probe                    (`tccutil reset Accessibility dev.caret.host` from this process: exit, output)
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
        if rest == ["trust-probe"] { return Self.trustProbe() }
        if rest == ["reset-probe"] { return Self.resetProbe() }
        if rest.first == "open" {
            let step = rest.count > 1 ? OnboardingStep(rawValue: rest[1]) : nil
            if rest.count > 1, step == nil { return #"{"error":"usage: onboarding open [hello|access|on|first]"}"# }
            open(drawing: false, opening: step.map { OnboardingLaunch.Opening(step: $0) })
            return reply()
        }
        guard let flow else { return #"{"error":"onboarding is not open"}"# }
        func onOff(_ w: String) -> Bool? { w == "on" ? true : (w == "off" ? false : nil) }
        switch (rest[0], rest.count) {
        case ("close", 1): close()
        case ("next", 1): flow.send(.next)
        case ("later", 1): flow.send(.setUpLater)
        case ("keep", 1): flow.send(.keep)
        case ("help", 1): flow.send(.toggleHelp)
        case ("skip-browser", 1): flow.send(.skipBrowser)
        case ("browser-connected", 1): flow.send(.browserConnected)
        case ("browsers", _) where rest.count >= 2:
            flow.send(.browsers(trusted: rest[1] == "none" ? [] : Array(rest.dropFirst()), untrusted: []))
        case ("accept", 1): flow.send(.accept)
        case ("not-now", 1): flow.send(.notNow)
        case ("type", _): flow.send(.typed(rest.dropFirst().joined(separator: " ")))
        case ("jev-key", 2): flow.send(.setJevKey(rest[1]))
        case ("key", 2):
            let key: TryItKey
            switch rest[1] {
            case "tab": key = .tab
            case "return": key = .returnKey
            case "esc": key = .escape
            case "cmd-z": key = .undo
            case "cmd-1", "cmd-2", "cmd-3": key = .commandDigit(Int(String(rest[1].last!))!)
            case "other": key = .other
            default: return #"{"error":"usage: onboarding key tab|return|esc|cmd-z|cmd-1|cmd-2|cmd-3|other"}"#
            }
            flow.send(.key(key))
        case ("permissions", 3):
            guard let ax = onOff(rest[1]), let im = onOff(rest[2]) else { return #"{"error":"usage: onboarding permissions on|off on|off"}"# }
            permissionsOverride = OnboardingPermissions(accessibility: ax, inputMonitoring: im)
            poll()
        case ("model", 2):
            switch rest[1] {
            case "ready": modelOverride = .ready
            case "loading": modelOverride = .loading(nil)
            case "unavailable": modelOverride = .unavailable
            default: return #"{"error":"usage: onboarding model ready|loading|unavailable"}"#
            }
            poll()
        case ("preview", 2):
            guard case .building(let id) = flow.state.on.preview else { return #"{"error":"no preview is being built"}"# }
            switch rest[1] {
            case "empty": flow.send(.previewReady(requestId: id, OnboardingPreview(previewId: "test", windows: [], chars: 0)))
            case "fail": flow.send(.previewFailed(requestId: id, "test"))
            default:
                guard let n = Int(rest[1]), n > 0, n < 10 else { return #"{"error":"usage: onboarding preview empty|fail|<1-9>"}"# }
                let windows = (0..<n).map { i in
                    OnboardingPreview.Window(bundleId: "com.apple.mail", appName: "Mail", title: "Synthetic \(i + 1)",
                                             lines: [.init(text: "Thursday at 3 for coffee?"), .init(text: nil)], chars: 25)
                }
                flow.send(.previewReady(requestId: id, OnboardingPreview(previewId: "test-\(n)", windows: windows, chars: 25 * n)))
            }
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

extension OnboardingController {
    /// Runs Caret's own reset from this process, as `resetOwnEntries` does, and returns its exit status and output with
    /// this process's pid and parent (launchd's 1 for the login item). A test hook for finding where the reset takes:
    /// in the VM it exited 0 from the app and left the entry.
    static func resetProbe() -> String {
        guard let args = try? AccessibilityAccess.resetArguments(service: "Accessibility", bundleID: Bundle.main.bundleIdentifier) else {
            return #"{"error":"not dev.caret.host"}"#
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch {
            return "{\"error\":\(HostRuntime.jsonString(String(describing: error)))}"
        }
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return "{\"exit\":\(p.terminationStatus),\"out\":\(HostRuntime.jsonString(out)),\"pid\":\(getpid()),\"ppid\":\(getppid())}"
    }

    /// This process's Accessibility answer and a fresh child's (`Caret --trust-probe`), as JSON. A test hook: it blocks
    /// the main thread for the child's run, about a tenth of a second.
    static func trustProbe() -> String {
        let own = AXIsProcessTrusted()
        guard let exe = Bundle.main.executableURL else { return #"{"error":"no executable"}"# }
        let child = Process()
        child.executableURL = exe
        child.arguments = ["--trust-probe"]
        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = FileHandle.nullDevice
        do { try child.run() } catch {
            return "{\"error\":\(HostRuntime.jsonString(String(describing: error)))}"
        }
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        child.waitUntilExit()
        let answer = out == "true" ? "true" : (out == "false" ? "false" : "null")
        return "{\"own\":\(own),\"child\":\(answer)}"
    }
}

/// Where the guide sits while System Settings is open: beside its window, on the side with room, vertically aligned to
/// its top; at the left of the screen when System Settings has no window on screen. Window bounds and owner come from
/// `CGWindowListCopyWindowInfo`, which needs no permission for them.
@MainActor
final class GuidePlacement {
    /// System Settings' frontmost window, in AppKit screen coordinates (origin bottom left).
    static func settingsWindowFrame() -> NSRect? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first?.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        for info in list {
            guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid, (info[kCGWindowLayer as String] as? Int) == 0,
                  let b = info[kCGWindowBounds as String] as? [String: CGFloat], let w = b["Width"], let h = b["Height"], w > 320, h > 240 else { continue }
            return NSRect(x: b["X"] ?? 0, y: primaryHeight - (b["Y"] ?? 0) - h, width: w, height: h)
        }
        return nil
    }

    /// The guide's content rect: 24 pt from System Settings, left of it when that fits on its screen, else right of
    /// it, else the screen's left edge; never off the visible frame.
    /// `screen` nil: the display that holds System Settings' window, else the main one.
    func placement(for size: CGSize, screen: NSScreen?) -> NSRect {
        let settingsFrame = Self.settingsWindowFrame()
        let holder = screen ?? settingsFrame.flatMap { f in NSScreen.screens.max { $0.frame.intersection(f).area < $1.frame.intersection(f).area } } ?? NSScreen.main
        let visible = holder?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let gap: CGFloat = 24
        var origin: CGPoint
        if let settings = settingsFrame {
            let top = settings.maxY - size.height
            if settings.minX - gap - size.width >= visible.minX {
                origin = CGPoint(x: settings.minX - gap - size.width, y: top)
            } else if settings.maxX + gap + size.width <= visible.maxX {
                origin = CGPoint(x: settings.maxX + gap, y: top)
            } else {
                origin = CGPoint(x: visible.minX + gap, y: top)
            }
        } else {
            origin = CGPoint(x: visible.minX + 80, y: visible.midY - size.height / 2)
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - size.height - 8)
        return NSRect(origin: origin, size: size)
    }
}

private extension CGPoint {
    func distance(to other: CGPoint) -> CGFloat { hypot(x - other.x, y - other.y) }
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}

/// The apps the Hello line names, read before any permission (HANDOFF §2): LaunchServices and the running apps.
@MainActor
enum HelloAppsReader {
    static func read() -> [HelloApp] {
        let ws = NSWorkspace.shared
        func app(_ url: URL?) -> HelloApp? {
            guard let url, let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { return nil }
            return HelloApp(bundleId: id, name: FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: ""))
        }
        let running = ws.runningApplications.filter { $0.activationPolicy == .regular && HelloApps.isPersonApp(path: $0.bundleURL?.path) }.compactMap { r -> HelloApp? in
            guard let id = r.bundleIdentifier, let name = r.localizedName else { return nil }
            return HelloApp(bundleId: id, name: name)
        }
        let installed = HelloApps.wellKnown.compactMap { app(ws.urlForApplication(withBundleIdentifier: $0)) }
        return HelloApps.pick(
            defaultMail: app(ws.urlForApplication(toOpen: URL(string: "mailto:a@example.com")!)),
            defaultBrowser: app(ws.urlForApplication(toOpen: URL(string: "https://example.com")!)),
            running: running, installed: installed, excluded: { ExcludedApps.excludes(bundleID: $0) }
        )
    }
}

/// The window's root: redraws whenever the flow's state changes.
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
