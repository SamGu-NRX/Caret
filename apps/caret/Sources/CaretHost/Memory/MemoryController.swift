import AppKit
import CaretHostCore
import SwiftUI

/// The memory window and the system side of `MemoryBook` and `MemoryFiles`: it hears the helper's
/// link and replies, writes their requests, and turns the window's clicks into their calls, Finder's
/// and the user's own editor's. Opened from the desk's "What Caret knows" and from the menu bar.
/// Unlike the desk, this window becomes key: editing takes typing.
///
/// The debug socket drives the same book and files without a window (`memory ...`); only the
/// `memory show` test hook puts the window up, for a foreground walk with real keys.
@MainActor
final class MemoryController {
    final class Model: ObservableObject {
        @Published var state = MemoryBook.State()
        @Published var files = MemoryFiles.State()
        @Published var tab: MemoryView.Tab = .memory
        /// "Not on this site" (H5): the Sites tab.
        @Published var sites = SitesPage.State()
        @Published var routing = false
        /// H8: "Calendar for new events".
        @Published var calendar: CalendarChoiceRow?
        /// H14: the Files group.
        @Published var savedFiles = SavedFilesBook.State()
        /// Brief items 4, 6 and 7: the Writing tab.
        @Published var writing = WritingPage.State()
    }

    let book: MemoryBook
    let files: MemoryFiles
    /// H14: the files the user kept for a question.
    let savedFiles: SavedFilesBook
    private let testHooks: Bool
    private let model = Model()
    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    /// Writes one request to the helper; false when it is not connected.
    var send: (HelperMemory.Request) -> Bool = { _ in false } {
        didSet { book.send = { [send] in send($0) } }
    }
    var sendNotRight: (MemoryNotRight) -> Bool = { _ in false } {
        didSet { book.sendNotRight = { [sendNotRight] in sendNotRight($0) } }
    }
    var sendDocuments: (MemoryDocumentRequest) -> Bool = { _ in false } {
        didSet { files.send = { [sendDocuments] in sendDocuments($0) } }
    }
    var sendSavedFiles: (SavedFilesRequest) -> Bool = { _ in false } {
        didSet { savedFiles.send = { [sendSavedFiles] in sendSavedFiles($0) } }
    }
    /// Brief item 8: the Model group's button (`ModelKeeper.toggle`), set by the runtime.
    var onModel: () -> Void = {}

    /// The Model group as the runtime's `ModelKeeper` says it now is.
    func showModel(_ panel: WritingPage.ModelPanel) { model.writing.model = panel }

    /// Finder and the user's editor, replaced in tests.
    var workspace: MemoryWorkspace = SystemWorkspace()

    init(testHooks: Bool, clock: SurfaceClock = RunLoopClock()) {
        self.testHooks = testHooks
        book = MemoryBook(clock: clock)
        files = MemoryFiles(clock: clock)
        savedFiles = SavedFilesBook(clock: clock)
        savedFiles.onChange = { [weak self] in
            guard let self else { return }
            self.model.savedFiles = self.savedFiles.state
        }
        book.onChange = { [weak self] in
            guard let self else { return }
            self.model.state = self.book.state
        }
        files.onChange = { [weak self] in
            guard let self else { return }
            self.model.files = self.files.state
        }
        // A saved file can change, add or remove facts: the rows read them again.
        files.onSaved = { [weak self] in self?.book.requestList() }
        // The sites list lives in the settings file, which the runtime sends to the helper on change.
        model.sites.off = SettingsStore.shared.settings.sitesOff
        model.sites.pageInline = SettingsStore.shared.settings.pageInline
        model.sites.pageInlineText = SettingsStore.shared.settings.pageInlineText
        model.sites.pageInlineContentEditable = SettingsStore.shared.settings.pageInlineContentEditable
        model.routing = SettingsStore.shared.settings.routing
        syncWriting(SettingsStore.shared.settings, keepDrafts: false)
        SettingsStore.shared.observe { [weak self] settings in
            MainActor.assumeIsolated {
                self?.syncWriting(settings, keepDrafts: true)
                self?.model.sites.off = settings.sitesOff
                self?.model.sites.pageInline = settings.pageInline
                self?.model.sites.pageInlineText = settings.pageInlineText
                self?.model.sites.pageInlineContentEditable = settings.pageInlineContentEditable
                self?.model.routing = settings.routing
                self?.readCalendars()
            }
        }
        // Reading the calendars asks nothing; with access not yet asked for, the row says when Caret asks.
        EventKitCalendars.shared.onChange = { [weak self] in MainActor.assumeIsolated { self?.readCalendars() } }
        readCalendars()
    }

    /// The calendar row, read again whenever the choice, the calendars or access may have changed: on a
    /// settings change, on EventKit's change notice, and when the window opens (access changed in System
    /// Settings sends nothing).
    private func readCalendars() {
        model.calendar = CalendarChoiceRow.make(choice: SettingsStore.shared.settings.eventCalendar, directory: EventKitCalendars.shared)
    }

    // MARK: - Writing (brief items 4, 6 and 7)

    /// The Writing tab from the settings. `keepDrafts`: a settings change made elsewhere (the menu) leaves what the
    /// user is typing alone, unless it matched the saved text.
    private func syncWriting(_ settings: CaretSettings, keepDrafts: Bool) {
        var w = model.writing
        let saved = settings.instructions.aboutMe
        if !keepDrafts || !w.aboutChanged { w.aboutDraft = saved }
        w.aboutSaved = saved
        w.entries = WritingPage.entries(settings.instructions, name: Self.appName)
        w.keys = settings.ghostKeys
        w.appsOff = settings.appsOff.map { WritingPage.App(bundleID: $0, name: Self.appName($0)) }
        model.writing = w
    }

    /// An app's name as Finder shows it, else its bundle identifier.
    static func appName(_ bundleID: String) -> String {
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first?.localizedName { return running }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return bundleID
    }

    private func performWriting(_ action: MemoryAction) {
        switch action {
        case .aboutText(let text):
            model.writing.aboutDraft = text
            model.writing.problem = nil
        case .saveAbout:
            let text = model.writing.aboutDraft
            if let problem = WritingPage.saveProblem(text) {
                model.writing.problem = problem
                return
            }
            SettingsStore.shared.update(source: .menu) { $0.instructions.aboutMe = text.trimmingCharacters(in: .whitespacesAndNewlines) }
        case .editEntry(let id):
            let entry = (model.writing.entries + model.writing.addable).first { $0.id == id }
            model.writing.editing = entry.map { ($0.id, $0.text) }
            model.writing.entryProblem = nil
        case .entryText(let text):
            if let id = model.writing.editing?.id { model.writing.editing = (id, text) }
            model.writing.entryProblem = nil
        case .saveEntry:
            guard let editing = model.writing.editing,
                  let entry = (model.writing.entries + model.writing.addable).first(where: { $0.id == editing.id }) else { return }
            if let problem = WritingPage.saveProblem(editing.draft) {
                model.writing.entryProblem = problem
                return
            }
            let text = editing.draft
            model.writing.editing = nil
            model.writing.entryProblem = nil
            SettingsStore.shared.update(source: .menu) { s in
                switch entry.kind {
                case .app: s.instructions.setApp(entry.key, text)
                case .site: s.instructions.setSite(entry.key, text)
                }
            }
        case .cancelEntry:
            model.writing.editing = nil
            model.writing.entryProblem = nil
        case .removeEntry(let id):
            guard let entry = model.writing.entries.first(where: { $0.id == id }) else { return }
            if model.writing.editing?.id == id { model.writing.editing = nil }
            SettingsStore.shared.update(source: .menu) { s in
                switch entry.kind {
                case .app: s.instructions.setApp(entry.key, "")
                case .site: s.instructions.setSite(entry.key, "")
                }
            }
        case .keys(let keys): SettingsStore.shared.update(source: .menu) { $0.ghostKeys = keys }
        case .appOff(let id): SettingsStore.shared.update(source: .menu) { $0.setApp(id, off: true) }
        case .appOn(let id): SettingsStore.shared.update(source: .menu) { $0.setApp(id, off: false) }
        default: break
        }
    }

    // MARK: - Not on this site

    /// Turns Caret off for `origin`, or for what the field holds when nil. A field that holds no web
    /// address says so and changes nothing.
    @discardableResult
    func turnSiteOff(_ origin: String?) -> Bool {
        guard let site = origin ?? SitesPage.origin(typed: model.sites.draft) else {
            model.sites.problem = SitesPage.notAnAddress
            return false
        }
        SettingsStore.shared.update(source: .menu) { $0.setSite(site, off: true) }
        if origin == nil { model.sites.draft = "" }
        model.sites.problem = nil
        return true
    }

    func turnSiteOn(_ origin: String) {
        SettingsStore.shared.update(source: .menu) { $0.setSite(origin, off: false) }
    }

    // MARK: - From the helper

    func linkChanged(_ up: Bool) {
        book.linkChanged(up)
        files.linkChanged(up)
        savedFiles.linkChanged(up)
    }

    func receive(_ reply: SavedFilesReply) { savedFiles.receive(reply) }

    func receive(_ reply: HelperMemory.Reply) { book.receive(reply) }

    func receive(_ reply: MemoryDocumentReply) { files.receive(reply) }

    /// Onboarding's typed name and email.
    func remember(_ items: [TypedAbout]) { book.remember(items) }

    /// Onboarding's Skip after an earlier Continue.
    func forgetTyped(labels: [String]) { book.dropTyped(labels: labels) }

    // MARK: - The window

    /// Brings the window forward, reading the list and the files again so it shows what the helper
    /// holds now.
    func open() {
        // Read while the browser is still the front app: the window coming forward ends that.
        model.sites.here = BrowserPage.frontOrigin()
        model.writing.herePage = model.sites.here
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier,
           let id = front.bundleIdentifier {
            model.writing.hereApp = WritingPage.App(bundleID: id, name: front.localizedName ?? Self.appName(id))
        }
        readCalendars()
        book.requestList()
        files.requestList()
        savedFiles.refresh()
        if let window {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        let root = MemoryRoot(model: model, editorApp: { [weak self] in self?.editorApp() }) { [weak self] action in self?.perform(action) }
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
        // An edit, a pending Forget or an open Not right does not outlive the window. A file with
        // typing in it does: the draft waits in the editor for the window's next opening, so closing
        // the window never throws away what was typed (review finding 2). One with nothing typed closes.
        book.cancelEdit()
        book.cancelNotRight()
        book.keep()
        savedFiles.keep()
        if files.state.editor?.edited != true { files.close() }
    }

    var windowShown: Bool { window?.isVisible ?? false }

    /// The app that opens the open file, by name, for "Open in …".
    private func editorApp() -> String? {
        guard let doc = files.state.editor?.doc, let path = files.state.document(doc)?.path else { return nil }
        return workspace.editorName(forPath: path)
    }

    /// What a switch on the Sites tab changes in the settings file; nil for every other action. The same change the
    /// window saves, so a test can read it back from a file of its own (`SettingsStoreTests`).
    static func settingsChange(for action: MemoryAction) -> ((inout CaretSettings) -> Void)? {
        switch action {
        case .pageInlineText(let on): return { $0.pageInlineText = on }
        case .pageInlineContentEditable(let on): return { $0.pageInlineContentEditable = on }
        default: return nil
        }
    }

    func perform(_ action: MemoryAction) {
        if let change = Self.settingsChange(for: action) {
            return SettingsStore.shared.update(source: .menu, change)
        }
        switch action {
        case .tab(let tab):
            model.tab = tab
            book.cancelEdit()
            book.cancelNotRight()
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
            case .keep: book.keepNoticed(id)
            case .notRight: book.beginNotRight(id)
            }
        case .answer(let id, let accept): book.answerOnItsOwn(id, accept: accept)
        case .confirmForget: book.confirmForget()
        case .keep: book.keep()
        case .draft(let key, let text): book.updateDraft(key, text)
        case .save: book.saveEdit()
        case .cancel: book.cancelEdit()
        case .setRule(let action, let rule): book.setRule(action, rule)
        case .retry:
            book.requestList()
            files.requestList()
            savedFiles.refresh()
        case .washed: book.clearChanged()
        case .correction(let text): book.updateCorrection(text)
        case .sendCorrection(let forget): book.sendCorrection(forget: forget)
        case .cancelCorrection: book.cancelNotRight()
        case .openFile(let doc): files.open(doc)
        case .showInFinder(let doc): showInFinder(doc)
        case .fileText(let text): files.updateText(text)
        case .saveFile: files.save()
        case .closeFile: files.close()
        case .reloadFile: files.reload()
        case .keepMyText: files.keepMine()
        case .openInEditor:
            if let doc = files.state.editor?.doc, let path = files.state.document(doc)?.path { workspace.openInEditor(path: path) }
        case .siteDraft(let text):
            model.sites.draft = text
            model.sites.problem = nil
        case .siteOff(let origin): turnSiteOff(origin)
        case .siteOn(let origin): turnSiteOn(origin)
        case .pageInline(let page, let on): SettingsStore.shared.update(source: .menu) { $0.pageInline.set(page, on: on) }
        case .routing(let on): SettingsStore.shared.update(source: .menu) { $0.routing = on }
        case .calendar(let id): SettingsStore.shared.update(source: .menu) { $0.eventCalendar = id }
        case .pageInlineText, .pageInlineContentEditable: break
        case .model: onModel()
        case .aboutText, .saveAbout, .editEntry, .entryText, .saveEntry, .cancelEntry, .removeEntry, .keys, .appOff, .appOn:
            performWriting(action)
        case .fileForget(let id):
            book.keep()
            savedFiles.askForget(id)
        case .fileConfirmForget: savedFiles.confirmForget()
        case .fileKeep: savedFiles.keep()
        case .fileShowInFinder(let id):
            // Finder selects the file the helper listed; a file that is gone has no button.
            if let f = savedFiles.state.files.first(where: { $0.id == id }), f.edited != nil { workspace.reveal(path: f.path) }
        }
    }

    /// The file when it exists, else the folder: Finder can only select what is there.
    private func showInFinder(_ doc: String?) {
        let d = doc.flatMap { files.state.document($0) }
        if let d, d.revision != nil { return workspace.reveal(path: d.path) }
        if let folder = files.state.folder { workspace.reveal(path: folder) }
    }

    // MARK: - Debug socket

    struct DebugInfo: Codable {
        var book: MemoryBook.DebugInfo
        var files: MemoryFiles.DebugInfo
        var tab: String
        var windowShown: Bool
        var sites: SitesPage.State
        /// H14: the Files group's ids, names and state; never a path.
        var savedFiles: [String]
        var savedFilesLoaded: Bool
    }

    func debugInfo() -> DebugInfo {
        DebugInfo(book: book.debugInfo(), files: files.debugInfo(), tab: model.tab.rawValue, windowShown: windowShown, sites: model.sites,
                  savedFiles: savedFiles.state.files.map { "\($0.id) \($0.name)" }, savedFilesLoaded: savedFiles.state.loaded)
    }

    /// `memory` reads the book and the files. With test hooks, the rest act as the window's controls would:
    ///   memory list                               read the helper's memory and its files again
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
    ///   memory keepnoticed <id>                   Keep, on a noticed fact
    ///   memory notright <id>                      Not right, on a noticed fact; then
    ///   memory correct <text...> | memory forgetnoticed | memory cancelnotright
    ///   memory open <doc>                         Edit on a section: about-me, people, preferences
    ///   memory text <text...>                     replace the open file's text (\n for a new line)
    ///   memory savefile | closefile | reload | keepmine
    ///   memory show | memory close                the window itself, as the menu opens it (foreground runs only)
    ///   memory tab sites                          the Sites tab (H5)
    ///   memory here <url>                         set "The page you were on", as opening over Chrome does
    ///   memory site off [<url>]                   Not on this site: the page you were on's button, or the field's
    ///   memory site draft <text...>               type into the Add a site field
    ///   memory site on <origin>                   Turn back on
    ///   memory switch web|rich on|off             H14: the Sites tab's switches
    ///   memory files                              H14: read the Files group again; memory fileforget <id>, fileconfirm, filekeep
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
        let tail = rest.dropFirst().joined(separator: " ")
        switch (rest[0], rest.count) {
        case ("list", 1):
            book.requestList()
            files.requestList()
        case ("tab", 2):
            guard let tab = MemoryView.Tab(rawValue: rest[1]) else { return #"{"error":"usage: memory tab memory|permissions|sites"}"# }
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
        case ("keepnoticed", 2): return reply(["sent": book.keepNoticed(rest[1])])
        case ("notright", 2): book.beginNotRight(rest[1])
        case ("correct", _) where rest.count >= 2:
            book.updateCorrection(tail)
            return reply(["sent": book.sendCorrection(forget: false)])
        case ("forgetnoticed", 1): return reply(["sent": book.sendCorrection(forget: true)])
        case ("cancelnotright", 1): book.cancelNotRight()
        case ("open", 2): return reply(["sent": files.open(rest[1])])
        case ("text", _) where rest.count >= 2:
            files.updateText(tail.replacingOccurrences(of: "\\n", with: "\n"))
        case ("savefile", 1): return reply(["sent": files.save()])
        case ("closefile", 1): files.close()
        case ("reload", 1): return reply(["sent": files.reload()])
        case ("keepmine", 1): return reply(["sent": files.keepMine()])
        case ("here", 2):
            guard let url = URL(string: rest[1]), let origin = SiteOrigin.of(url) else { return #"{"error":"usage: memory here <http(s) url>"}"# }
            model.sites.here = origin
        case ("site", _) where rest.count >= 2:
            switch rest[1] {
            case "off": return reply(["sent": turnSiteOff(rest.count > 2 ? (SitesPage.origin(typed: rest[2]) ?? rest[2]) : nil)])
            case "draft": perform(.siteDraft(rest.count > 2 ? text : ""))
            case "on" where rest.count == 3: turnSiteOn(rest[2])
            default: return #"{"error":"usage: memory site off [<url>] | draft <text> | on <origin>"}"#
            }
        case ("switch", 3):
            guard ["on", "off"].contains(rest[2]) else { return #"{"error":"usage: memory switch web|rich on|off"}"# }
            switch rest[1] {
            case "web": perform(.pageInlineText(rest[2] == "on"))
            case "rich": perform(.pageInlineContentEditable(rest[2] == "on"))
            default: return #"{"error":"usage: memory switch web|rich on|off"}"#
            }
        case ("files", 1): savedFiles.refresh()
        case ("fileforget", 2): perform(.fileForget(rest[1]))
        case ("fileconfirm", 1): return reply(["sent": savedFiles.confirmForget()])
        case ("filekeep", 1): savedFiles.keep()
        case ("show", 1): open()
        case ("close", 1): close()
        default:
            return #"{"error":"unknown memory command"}"#
        }
        return reply()
    }
}

/// Finder and the user's editor, so tests can see what the window asked for.
@MainActor
protocol MemoryWorkspace {
    func reveal(path: String)
    func openInEditor(path: String)
    func editorName(forPath path: String) -> String?
}

struct SystemWorkspace: MemoryWorkspace {
    func reveal(path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func openInEditor(path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    /// The app that opens a .md file: "TextEdit", "Typora". Nil when none does.
    func editorName(forPath path: String) -> String? {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: path)) else { return nil }
        return FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }
}

/// The window's root: redraws whenever the book, the files or the tab changes.
private struct MemoryRoot: View {
    @ObservedObject var model: MemoryController.Model
    @ObservedObject private var figure = FigureSettings.shared
    var editorApp: () -> String?
    var send: (MemoryAction) -> Void

    var body: some View {
        MemoryView(state: model.state, files: model.files, savedFiles: model.savedFiles, tab: model.tab, character: figure.character, sites: model.sites, routing: model.routing, calendarRow: model.calendar, writing: model.writing, editorApp: editorApp(), send: send)
    }
}
