import AppKit
import CaretHost
import CaretHostCore

/// A minimal menu-bar shell: the figure as the status item (Carrot while work runs), the engine
/// state, pause, the activity list, the perch toggle, the settings (what Caret helps with, how
/// often it speaks up, the character), and Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runtime: HostRuntime
    /// The helper, the reader and the bridge service Caret.app runs (H4).
    private let services: CaretServices
    private let home: CaretHome
    /// `--nmh-dir`: where Add to Chrome writes in a run with its own home.
    private let manifestDirectory: String?
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
    private var characterItems: [NSMenuItem] = []
    private let perchItem = NSMenuItem(title: "Show Perch", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause Caret", action: nil, keyEquivalent: "")
    private var roleItems: [NSMenuItem] = []
    private var levelItems: [NSMenuItem] = []

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
        runtime.onAddToChrome = { [weak self] in
            guard let self else { return }
            ChromeBridgeInstaller.run(home: self.home, manifestOverride: self.manifestDirectory)
        }
        services.onChange = { [weak self] in self?.refreshStopped() }
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
        stateItem.title = runtime.engineSummary
        let notice = OtherTabOwners.notice(OtherTabOwners.running(in: NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier)))
        tabOwnerItem.title = notice ?? ""
        tabOwnerItem.isHidden = notice == nil
        perchItem.state = runtime.perchHidden ? .off : .on
        let current = FigureSettings.shared.character
        for item in characterItems {
            item.state = item.representedObject as? String == current.rawValue ? .on : .off
        }
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
        ChromeBridgeInstaller.run(home: home, manifestOverride: manifestDirectory)
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

    @objc private func chooseCharacter(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let character = FigureCharacter(rawValue: raw) else { return }
        FigureSettings.shared.character = character
        refreshGlyph()
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
        // Never at first launch: the user chooses it here or in onboarding (H4).
        let chromeItem = NSMenuItem(title: "Add to Chrome…", action: #selector(addToChrome(_:)), keyEquivalent: "")
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
        // The pebble is the default (Sam, 2026-10-02); seed and wren stay as choices.
        let characterMenu = NSMenu()
        for character in FigureCharacter.allCases {
            let choice = NSMenuItem(title: character.displayName, action: #selector(chooseCharacter(_:)), keyEquivalent: "")
            choice.target = self
            choice.representedObject = character.rawValue
            characterMenu.addItem(choice)
            characterItems.append(choice)
        }
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
        let characterItem = NSMenuItem(title: "Character", action: nil, keyEquivalent: "")
        characterItem.submenu = characterMenu
        menu.addItem(characterItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Caret", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
    }
}
