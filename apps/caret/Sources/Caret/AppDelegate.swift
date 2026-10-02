import AppKit
import CaretHost

/// A minimal menu-bar shell: the figure as the status item (Carrot while work runs), the engine
/// state, the character setting, and Quit.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runtime: HostRuntime
    private var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "Starting", action: nil, keyEquivalent: "")
    private var signalSources: [DispatchSourceSignal] = []
    private var isTerminating = false
    private var working = false
    private var characterItems: [NSMenuItem] = []

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
        let current = FigureSettings.shared.character
        for item in characterItems {
            item.state = item.representedObject as? String == current.rawValue ? .on : .off
        }
    }

    private func refreshGlyph() {
        statusItem?.button?.image = FigureGlyph.image(FigureSettings.shared.character, working: working)
    }

    @objc private func chooseCharacter(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let character = FigureCharacter(rawValue: raw) else { return }
        FigureSettings.shared.character = character
        refreshGlyph()
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        refreshGlyph()
        let menu = NSMenu()
        menu.delegate = self
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        // The figure is provisional until Sam picks one (OPEN-QUESTIONS.md 1); all three are kept.
        let characterMenu = NSMenu()
        for character in FigureCharacter.allCases {
            let choice = NSMenuItem(title: character.displayName, action: #selector(chooseCharacter(_:)), keyEquivalent: "")
            choice.target = self
            choice.representedObject = character.rawValue
            characterMenu.addItem(choice)
            characterItems.append(choice)
        }
        let characterItem = NSMenuItem(title: "Character", action: nil, keyEquivalent: "")
        characterItem.submenu = characterMenu
        menu.addItem(characterItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Caret", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
    }
}
