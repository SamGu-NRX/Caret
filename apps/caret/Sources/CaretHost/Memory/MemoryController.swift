import AppKit
import CaretHostCore
import SwiftUI

/// The memory window and the system side of `MemoryBook`: it hears the helper's link and replies,
/// writes the book's requests, and turns the window's clicks into book calls. Opened from the
/// activity list's "What Caret knows" and from the menu bar. Unlike the activity list, this window
/// becomes key: editing a value takes typing.
///
/// The debug socket drives the same book without a window (`memory ...`); only the `memory show`
/// test hook puts the window up, for a foreground walk with real keys.
@MainActor
final class MemoryController {
    final class Model: ObservableObject {
        @Published var state = MemoryBook.State()
        @Published var tab: MemoryView.Tab = .memory
    }

    let book: MemoryBook
    private let testHooks: Bool
    private let model = Model()
    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    /// Writes one request to the helper; false when it is not connected.
    var send: (HelperMemory.Request) -> Bool = { _ in false } {
        didSet { book.send = { [send] in send($0) } }
    }

    init(testHooks: Bool, clock: SurfaceClock = RunLoopClock()) {
        self.testHooks = testHooks
        book = MemoryBook(clock: clock)
        book.onChange = { [weak self] in
            guard let self else { return }
            self.model.state = self.book.state
        }
    }

    // MARK: - From the helper

    func linkChanged(_ up: Bool) { book.linkChanged(up) }

    func receive(_ reply: HelperMemory.Reply) { book.receive(reply) }

    /// Onboarding's typed name and email.
    func remember(_ items: [TypedAbout]) { book.remember(items) }

    /// Onboarding's Skip after an earlier Continue.
    func forgetTyped(labels: [String]) { book.dropTyped(labels: labels) }

    // MARK: - The window

    /// Brings the window forward, reading the list again so it shows what the helper holds now.
    func open() {
        book.requestList()
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let root = MemoryRoot(model: model) { [weak self] action in self?.perform(action) }
        let hosting = NSHostingView(rootView: root)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: MemoryView.size),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.title = MemoryView.title
        window.contentView = hosting
        window.setContentSize(MemoryView.size)
        window.center()
        self.window = window
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.closed() }
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.close()
    }

    private func closed() {
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        window = nil
        // An edit or a pending Forget does not outlive the window.
        book.cancelEdit()
        book.keep()
    }

    var windowShown: Bool { window?.isVisible ?? false }

    func perform(_ action: MemoryAction) {
        switch action {
        case .tab(let tab):
            model.tab = tab
            book.cancelEdit()
            book.keep()
        case .control(let id, let control, let typed):
            if typed {
                if control == .forget { book.dropTyped(id) }
                return
            }
            switch control {
            case .edit: book.beginEdit(id)
            case .pause: book.pause(id)
            case .resume: book.resume(id)
            case .forget: book.askToForget(id)
            case .backOnTab: book.backOnTab(id)
            case .onItsOwn: book.letRunOnItsOwn(id)
            }
        case .answer(let id, let accept): book.answerOnItsOwn(id, accept: accept)
        case .confirmForget: book.confirmForget()
        case .keep: book.keep()
        case .draft(let key, let text): book.updateDraft(key, text)
        case .save: book.saveEdit()
        case .cancel: book.cancelEdit()
        case .setRule(let action, let rule): book.setRule(action, rule)
        case .retry: book.requestList()
        case .washed: book.clearChanged()
        }
    }

    // MARK: - Debug socket

    struct DebugInfo: Codable {
        var book: MemoryBook.DebugInfo
        var tab: String
        var windowShown: Bool
    }

    func debugInfo() -> DebugInfo {
        DebugInfo(book: book.debugInfo(), tab: model.tab.rawValue, windowShown: windowShown)
    }

    /// `memory` reads the book. With test hooks, the rest act as the window's controls would:
    ///   memory list                               read the helper's memory again
    ///   memory tab memory|permissions
    ///   memory edit <id>                          open the edit, as Edit does
    ///   memory draft <key> <text...>              type into one field of the open edit
    ///   memory save | memory cancel
    ///   memory pause|resume <id>
    ///   memory forget <id>                        ask, as Forget does; then memory confirm | memory keep
    ///   memory rule <action> <rule>               pick a rule on the permissions list
    ///   memory backontab <id>                     Put back on Tab, on a skill row or its permissions exception
    ///   memory onitsown <id>                      Let it run on its own…, on a skill row on Tab
    ///   memory answer <id> yes|no                 answer the offer that shows on that row
    ///   memory remember <label> <value...>        what onboarding's Continue hands over
    ///   memory remove <typedId>                   drop a typed value not kept yet
    ///   memory show | memory close                the window itself, as the menu opens it (foreground runs only)
    func command(_ words: [String]) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func reply(_ extra: [String: Bool] = [:]) -> String {
            var json = (try? String(decoding: encoder.encode(debugInfo()), as: UTF8.self)) ?? "{}"
            if let sent = extra["sent"], json.hasSuffix("}") {
                json.removeLast()
                json += ",\"sent\":\(sent)}"
            }
            return json
        }
        guard words.count > 1 else { return reply() }
        guard testHooks else { return #"{"error":"memory commands are test hooks: start the host with --test-hooks"}"# }
        let rest = Array(words.dropFirst())
        let text = rest.count > 2 ? rest.dropFirst(2).joined(separator: " ") : ""
        switch (rest[0], rest.count) {
        case ("list", 1): book.requestList()
        case ("tab", 2):
            guard let tab = MemoryView.Tab(rawValue: rest[1]) else { return #"{"error":"usage: memory tab memory|permissions"}"# }
            perform(.tab(tab))
        case ("edit", 2): book.beginEdit(rest[1])
        case ("draft", _) where rest.count >= 2:
            book.updateDraft(rest[1], rest.count > 2 ? text : "")
        case ("save", 1): return reply(["sent": book.saveEdit()])
        case ("cancel", 1): book.cancelEdit()
        case ("pause", 2): return reply(["sent": book.pause(rest[1])])
        case ("resume", 2): return reply(["sent": book.resume(rest[1])])
        case ("forget", 2): book.askToForget(rest[1])
        case ("confirm", 1): return reply(["sent": book.confirmForget()])
        case ("keep", 1): book.keep()
        case ("backontab", 2): return reply(["sent": book.backOnTab(rest[1])])
        case ("onitsown", 2): return reply(["sent": book.letRunOnItsOwn(rest[1])])
        case ("answer", 3):
            guard ["yes", "no"].contains(rest[2]) else { return #"{"error":"usage: memory answer <id> yes|no"}"# }
            return reply(["sent": book.answerOnItsOwn(rest[1], accept: rest[2] == "yes")])
        case ("rule", 3):
            guard let action = HelperMemory.ActionType(rawValue: rest[1]), let rule = HelperMemory.Rule(rawValue: rest[2]) else {
                return #"{"error":"usage: memory rule read|show|writeHere|writeElsewhere|outbound|destructive|sensitive act|actIfApproved|ask|handoff"}"#
            }
            return reply(["sent": book.setRule(action, rule)])
        case ("remember", _) where rest.count >= 3:
            book.remember([TypedAbout(label: rest[1], value: text)])
        case ("remove", 2): book.dropTyped(rest[1])
        case ("show", 1): open()
        case ("close", 1): close()
        default:
            return #"{"error":"unknown memory command"}"#
        }
        return reply()
    }
}

/// The window's root: redraws whenever the book or the tab changes.
private struct MemoryRoot: View {
    @ObservedObject var model: MemoryController.Model
    @ObservedObject private var figure = FigureSettings.shared
    var send: (MemoryAction) -> Void

    var body: some View {
        MemoryView(state: model.state, tab: model.tab, character: figure.character, send: send)
    }
}
