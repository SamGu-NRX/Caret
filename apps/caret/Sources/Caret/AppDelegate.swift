import AppKit
import CaretHost

/// A minimal menu-bar shell. The visual identity is designed on another track; this only shows
/// that the host is running and lets it quit cleanly.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runtime: HostRuntime
    private var statusItem: NSStatusItem?
    private let stateItem = NSMenuItem(title: "Starting", action: nil, keyEquivalent: "")
    private var signalSources: [DispatchSourceSignal] = []
    private var isTerminating = false

    init(configuration: HostRuntime.Configuration) {
        runtime = HostRuntime(configuration: configuration)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            try runtime.start()
        } catch {
            FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
            exit(1)
        }
        installStatusItem()
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
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "character.cursor.ibeam", accessibilityDescription: "Caret")
        let menu = NSMenu()
        menu.delegate = self
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Caret", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }
}
