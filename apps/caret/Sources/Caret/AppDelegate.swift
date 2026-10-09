import AppKit
import CaretHost
import CaretHostCore

/// A minimal menu-bar shell: the figure as the status item (Carrot while work runs), the engine
/// state, pause, the activity list, the perch toggle, the settings (what Caret helps with, how
/// often it speaks up), and Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runtime: HostRuntime
    /// The helper, the reader and the bridge service Caret.app runs (H4).
    private let services: CaretServices
    private let home: CaretHome
    /// `--nmh-dir`: where Add to Chrome writes in a run with its own home.
    private let manifestDirectory: String?
    private var browserInstallResult: ChromeBridgeInstaller.Result?
    private var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "Starting", action: nil, keyEquivalent: "")
    /// Shown only after the helper or the reader crashed past the restart rule; choosing it starts both again.
    private let stoppedItem = NSMenuItem(title: "Caret stopped. Restart", action: nil, keyEquivalent: "")
    /// Under the state: another running app also takes Tab (`OtherTabOwners`), so Tab may never
    /// reach Caret. Hidden while none runs.
    private let tabOwnerItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private var signalSources: [DispatchSourceSignal] = []
    private var isTerminating = false
    private var working = false
    private let perchItem = NSMenuItem(title: "Show Perch", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause Caret", action: nil, keyEquivalent: "")
    private var roleItems: [NSMenuItem] = []
    private var levelItems: [NSMenuItem] = []
    /// Under the state while the helper runs without Jev because Caret has no key (H12); choosing it opens the key step.
    private let jevOffItem = NSMenuItem(title: "Jev is off. Add a key…", action: nil, keyEquivalent: "")

    private let showsStatusItem: Bool

    init(configuration: HostRuntime.Configuration, services: CaretServices, home: CaretHome, manifestDirectory: String?,
         showsStatusItem: Bool = true) {
        runtime = HostRuntime(configuration: configuration)
        self.services = services
        self.home = home
        self.manifestDirectory = manifestDirectory
        self.showsStatusItem = showsStatusItem
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SIGTERM and SIGINT free llama/Metal before exiting, so a scripted relaunch never kills
        // the process mid-model. Not via NSApp.terminate: called from this main-queue block, its
        // terminateLater wait would starve the main queue the shutdown Task needs.
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.shutdownAndExit() }
            source.resume()
            signalSources.append(source)
        }
        runtime.onWorkingChanged = { [weak self] working in
            self?.working = working
            self?.refreshGlyph()
        }
        runtime.services = services
        runtime.useJevKeys(services)
        runtime.onAddToChrome = { [weak self] in
            guard let self else { return }
            self.addToBrowser()
        }
        services.onChange = { [weak self] in self?.refreshStopped() }
        let services = self.services
        runtime.deferLoginItem({ services.registersAfterOnboarding }, due: { [weak self] in self?.handOffToLoginItem() })
        do {
            // The debug socket is how a second host is refused; take it before starting any helper or reader.
            try runtime.start()
        } catch {
            FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
            exit(1)
        }
        services.start()
        if showsStatusItem { installStatusItem() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isTerminating else { return .terminateLater }
        isTerminating = true
        Task {
            await runtime.shutdown()
            await services.stop()
            // Quit exits 0, which tells launchd (KeepAlive SuccessfulExit false) not to start Caret again.
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    /// Onboarding is done (or the browser step needs the bridge): register the login item, which launchd starts, and
    /// stop this copy. Services stop first, so the agent's copy finds the sockets free. If the hand-off fails, a fresh
    /// copy opens and runs in-process as before.
    private func handOffToLoginItem() {
        guard !isTerminating else { return }
        isTerminating = true
        Task {
            await runtime.shutdown()
            await services.stop()
            switch LoginAgent.handOff(onboarded: true) {
            case .handedOff(let why):
                FileHandle.standardError.write(Data("caret: \(why); this copy exits\n".utf8))
            case .runHere(let why):
                FileHandle.standardError.write(Data("caret: \(why); opening a fresh copy\n".utf8))
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-n", Bundle.main.bundlePath]
                try? p.run()
            }
            exit(0)
        }
    }

    private func shutdownAndExit() {
        guard !isTerminating else { return }
        isTerminating = true
        Task {
            await runtime.shutdown()
            await services.stop()
            exit(0)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        stateItem.title = browserInstallResult?.message ?? runtime.engineSummary
        // Show the install result on one menu opening, then resume reporting the engine state.
        browserInstallResult = nil
        let notice = OtherTabOwners.notice(OtherTabOwners.running(in: NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier)))
        tabOwnerItem.title = notice ?? ""
        tabOwnerItem.isHidden = notice == nil
        jevOffItem.isHidden = !services.jevOff
        perchItem.state = runtime.perchHidden ? .off : .on
        let settings = SettingsStore.shared.settings
        pauseItem.title = settings.paused ? "Resume Caret" : "Pause Caret"
        for item in roleItems {
            let role = (item.representedObject as? String).flatMap(CaretRole.init(rawValue:))
            item.state = role.map(settings.roles.contains) == true ? .on : .off
        }
        for item in levelItems {
            item.state = item.representedObject as? String == settings.level.rawValue ? .on : .off
        }
    }

    @objc private func setUp(_ sender: NSMenuItem) {
        runtime.openOnboarding()
    }

    @objc private func restartServices(_ sender: NSMenuItem) {
        services.restart()
    }

    @objc private func addToChrome(_ sender: NSMenuItem) {
        addToBrowser()
    }

    private func addToBrowser() {
        let result = ChromeBridgeInstaller.run(home: home, manifestOverride: manifestDirectory)
        browserInstallResult = result
        stateItem.title = result.message
        stateItem.toolTip = ([result.detail].filter { !$0.isEmpty } + result.manualSteps.enumerated().map { "\($0.offset + 1). \($0.element)" }).joined(separator: "\n")
    }

    @objc private func addJevKey(_ sender: NSMenuItem) {
        runtime.openJevKeyStep()
    }

    /// The login item goes, and with it this process: launchd stops a LaunchAgent it unregisters. Opening Caret again
    /// registers it again (LaunchRole.handOffToAgent), which the alert says.
    @objc private func stopOpeningAtLogin(_ sender: NSMenuItem) {
        let alert = NSAlert()
        alert.messageText = "Stop opening Caret at login?"
        alert.informativeText = "Caret quits now and won’t open when you log in. Opening Caret again turns this back on."
        alert.addButton(withTitle: "Stop Opening at Login")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let result = LoginAgent.unregister(LoginAgent.system())
        FileHandle.standardError.write(Data("caret: \(result.message)\n".utf8))
        guard !result.ok else { return }
        let failed = NSAlert()
        failed.messageText = "Caret couldn’t remove its login item."
        failed.informativeText = "Turn Caret off in System Settings › General › Login Items & Extensions. (\(result.message))"
        failed.runModal()
    }

    private func refreshStopped() {
        stoppedItem.isHidden = services.stoppedReason == nil
        stoppedItem.toolTip = services.stoppedReason
    }

    @objc private func togglePause(_ sender: NSMenuItem) {
        SettingsStore.shared.update(source: .menu) { $0.paused.toggle() }
    }

    @objc private func toggleRole(_ sender: NSMenuItem) {
        guard let role = (sender.representedObject as? String).flatMap(CaretRole.init(rawValue:)) else { return }
        SettingsStore.shared.update(source: .menu) { s in
            if s.roles.contains(role) { s.roles.remove(role) } else { s.roles.insert(role) }
        }
    }

    @objc private func chooseLevel(_ sender: NSMenuItem) {
        guard let level = (sender.representedObject as? String).flatMap(CaretLevel.init(rawValue:)) else { return }
        SettingsStore.shared.update(source: .menu) { $0.level = level }
    }

    private func refreshGlyph() {
        statusItem?.button?.image = FigureGlyph.image(FigureSettings.shared.character, working: working)
    }

    @objc private func showActivity(_ sender: NSMenuItem) {
        runtime.toggleActivityList()
    }

    @objc private func askCaret(_ sender: NSMenuItem) {
        runtime.askCaret()
    }

    @objc private func showMemory(_ sender: NSMenuItem) {
        runtime.openMemory()
    }

    @objc private func togglePerch(_ sender: NSMenuItem) {
        runtime.perchHidden.toggle()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        refreshGlyph()
        let menu = NSMenu()
        menu.delegate = self
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        tabOwnerItem.isEnabled = false
        tabOwnerItem.isHidden = true
        menu.addItem(tabOwnerItem)
        jevOffItem.action = #selector(addJevKey(_:))
        jevOffItem.target = self
        jevOffItem.isHidden = !services.jevOff
        menu.addItem(jevOffItem)
        stoppedItem.action = #selector(restartServices(_:))
        stoppedItem.target = self
        menu.addItem(stoppedItem)
        refreshStopped()
        // Pause stops every offer, ghost text included; work already accepted goes on.
        pauseItem.action = #selector(togglePause(_:))
        pauseItem.target = self
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        // Asking needs no shortcut to remember: it is here and at the top of the perch's list.
        let askItem = NSMenuItem(title: "Ask Caret…", action: #selector(askCaret(_:)), keyEquivalent: "")
        askItem.target = self
        menu.addItem(askItem)
        let setUpItem = NSMenuItem(title: "Set Up Caret…", action: #selector(setUp(_:)), keyEquivalent: "")
        setUpItem.target = self
        menu.addItem(setUpItem)
        // Never at first launch: the user chooses it here or in onboarding (H4). Chrome and Helium since H12.
        let chromeItem = NSMenuItem(title: "Add to Your Browser…", action: #selector(addToChrome(_:)), keyEquivalent: "")
        chromeItem.target = self
        menu.addItem(chromeItem)
        let activityItem = NSMenuItem(title: "Activity", action: #selector(showActivity(_:)), keyEquivalent: "")
        activityItem.target = self
        menu.addItem(activityItem)
        // What Caret remembers and what it may do, to see and change.
        let memoryItem = NSMenuItem(title: "What Caret Knows…", action: #selector(showMemory(_:)), keyEquivalent: "")
        memoryItem.target = self
        menu.addItem(memoryItem)
        // The perch can be hidden; work still shows in Activity and the glyph still tints.
        perchItem.action = #selector(togglePerch(_:))
        perchItem.target = self
        menu.addItem(perchItem)
        menu.addItem(.separator())
        // The same choices onboarding asks for, here to change later.
        let roleMenu = NSMenu()
        for role in CaretRole.allCases {
            let item = NSMenuItem(title: role.title, action: #selector(toggleRole(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = role.rawValue
            roleMenu.addItem(item)
            roleItems.append(item)
        }
        let roleItem = NSMenuItem(title: "Help With", action: nil, keyEquivalent: "")
        roleItem.submenu = roleMenu
        menu.addItem(roleItem)
        let levelMenu = NSMenu()
        for level in CaretLevel.allCases {
            let item = NSMenuItem(title: level.title, action: #selector(chooseLevel(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = level.rawValue
            item.toolTip = level.detail
            levelMenu.addItem(item)
            levelItems.append(item)
        }
        // Title case, as every item in this menu.
        let levelItem = NSMenuItem(title: CaretLevel.question.capitalized, action: nil, keyEquivalent: "")
        levelItem.submenu = levelMenu
        menu.addItem(levelItem)
        menu.addItem(.separator())
        // Only the launchd agent is a login item to remove; a development or test run never offers it (and must not
        // unregister the developer's own Caret).
        if services.isLoginAgent {
            let loginItem = NSMenuItem(title: "Stop Opening at Login", action: #selector(stopOpeningAtLogin(_:)), keyEquivalent: "")
            loginItem.target = self
            menu.addItem(loginItem)
        }
        menu.addItem(NSMenuItem(title: "Quit Caret", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
    }
}
