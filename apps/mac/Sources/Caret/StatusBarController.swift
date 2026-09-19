import AppKit
import ApplicationServices

final class StatusBarController: NSObject, NSMenuDelegate {
    var onOpen: (() -> Void)?

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var accessibilityItem: NSMenuItem?

    func install() {
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Caret")
            image?.isTemplate = true
            button.image = image
            button.title = " Caret"
            button.toolTip = "Caret"
        }

        let menu = NSMenu()
        menu.delegate = self

        let openItem = NSMenuItem(title: "Open Caret (⌘⌥)", action: #selector(openPanel), keyEquivalent: "")
        openItem.target = self
        menu.addItem(openItem)

        menu.addItem(.separator())

        let axItem = NSMenuItem(title: "Accessibility…", action: #selector(openAccessibility), keyEquivalent: "")
        axItem.target = self
        menu.addItem(axItem)
        accessibilityItem = axItem

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Caret", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
        refresh()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    private func refresh() {
        let trusted = AXIsProcessTrusted()
        accessibilityItem?.title = trusted ? "Accessibility: On" : "Enable Accessibility…"
        if let button = statusItem.button {
            let name = trusted ? "sparkle" : "exclamationmark.triangle"
            let image = NSImage(systemSymbolName: name, accessibilityDescription: "Caret")
            image?.isTemplate = true
            button.image = image
        }
    }

    @objc private func openPanel() {
        onOpen?()
    }

    @objc private func openAccessibility() {
        AXHelpers.openAccessibilitySettings()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
