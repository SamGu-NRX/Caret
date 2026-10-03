import AppKit
import CaretHost
import CaretHostCore

/// A minimal menu-bar shell: the figure as the status item (Carrot while work runs), the engine
/// state, pause, the activity list, the perch toggle, the settings (what Caret helps with, how
/// forward it is, the character), and Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runtime: HostRuntime
    private var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "Starting", action: nil, keyEquivalent: "")
    private var signalSources: [DispatchSourceSignal] = []
    private var isTerminating = false
    private var working = false
    private var characterItems: [NSMenuItem] = []
    private let perchItem = NSMenuItem(title: "Show Perch", action: nil, keyEquivalent: "")
    private let pauseItem = NSMenuItem(title: "Pause Caret", action: nil, keyEquivalent: "")
    private var roleItems: [NSMenuItem] = []
    private var levelItems: [NSMenuItem] = []

    init(configuration: HostRuntime.Configuration) {
        runtime = HostRuntime(configuration: configuration)
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
        do {
            try runtime.start()
        } catch {
            FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
            exit(1)
        }
        installStatusItem()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !isTerminating else { return .terminateLater }
        isTerminating = true
        Task {
            await runtime.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func shutdownAndExit() {
        guard !isTerminating else { return }
        isTerminating = true
        Task {
            await runtime.shutdown()
            exit(0)
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        stateItem.title = runtime.engineSummary
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
        // Pause stops every offer, ghost text included; work already accepted goes on.
        pauseItem.action = #selector(togglePause(_:))
        pauseItem.target = self
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        let setUpItem = NSMenuItem(title: "Set Up Caret…", action: #selector(setUp(_:)), keyEquivalent: "")
        setUpItem.target = self
        menu.addItem(setUpItem)
        let activityItem = NSMenuItem(title: "Activity", action: #selector(showActivity(_:)), keyEquivalent: "")
        activityItem.target = self
        menu.addItem(activityItem)
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
        let levelItem = NSMenuItem(title: "How Forward", action: nil, keyEquivalent: "")
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
