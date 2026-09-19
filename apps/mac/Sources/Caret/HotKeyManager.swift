import AppKit
import ApplicationServices

final class HotKeyManager {
    var onHotKey: ((CGPoint) -> Void)?

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var trustTimer: Timer?
    private var chordArmed = false
    private var sawOtherKey = false

    func register() {
        installChordMonitors()

        if !AXIsProcessTrusted() {
            trustTimer?.invalidate()
            trustTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
                guard AXIsProcessTrusted() else { return }
                timer.invalidate()
                self?.trustTimer = nil
                self?.installChordMonitors()
            }
        }
    }

    func unregister() {
        trustTimer?.invalidate()
        trustTimer = nil
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }
    }

    deinit {
        unregister()
    }

    private func fire() {
        onHotKey?(NSEvent.mouseLocation)
    }

    private func installChordMonitors() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { [weak self] event in
            self?.handleChord(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown]) { [weak self] event in
            self?.handleChord(event)
            return event
        }
    }

    private func handleChord(_ event: NSEvent) {
        if event.type == .keyDown {
            if chordArmed { sawOtherKey = true }
            return
        }

        let flags = event.modifierFlags.intersection([.command, .option, .shift, .control])
        if flags == [.command, .option] {
            chordArmed = true
            sawOtherKey = false
            return
        }

        if chordArmed {
            chordArmed = false
            if !sawOtherKey {
                fire()
            }
            sawOtherKey = false
        }
    }
}
