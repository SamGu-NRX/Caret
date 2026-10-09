import CaretHostCore
import CaretScreenCore
import SwiftUI

/// What a click or key in the memory window asks for. `MemoryController` turns each into a
/// `MemoryBook` or `MemoryFiles` call, or a Finder or editor action.
enum MemoryAction: Equatable {
    case tab(MemoryView.Tab)
    case control(String, MemoryPage.Control, typed: Bool)
    case confirmForget
    case keep
    case draft(String, String)
    case save
    case cancel
    case setRule(HelperMemory.ActionType, HelperMemory.Rule)
    case retry
    /// A confirmed change's wash has played.
    case washed
    /// The user's answer to the offer on a skill's row ("Let it run on its own…").
    case answer(String, accept: Bool)
    // M1, a noticed fact's "Not right": what is typed instead, then Save or Forget, or Cancel.
    case correction(String)
    case sendCorrection(forget: Bool)
    case cancelCorrection
    // M1, a section's file: Edit opens it in Caret's editor; Show in Finder; the editor's controls.
    case openFile(String)
    case showInFinder(String?)
    case fileText(String)
    case saveFile
    case closeFile
    case reloadFile
    case keepMyText
    /// The open file in the user's own editor (the app that opens .md files).
    case openInEditor
    // H5, the Sites tab: the Add a site field's text; Not on this site (an origin, or the field's
    // when nil); Turn back on.
    case siteDraft(String)
    case siteOff(String?)
    case siteOn(String)
    /// H13: Caret's inline text on or off on a page with its own suggestions (Gmail).
    case pageInline(PageField.OwnSuggestions, Bool)
    /// H14: "Suggestions in web pages" and "Suggestions in rich editors (Notion, Gmail, Docs)".
    case pageInlineText(Bool)
    case pageInlineContentEditable(Bool)
    /// H14, Memory's Files group: Forget asks first (then Forget or Keep); Show in Finder selects the file.
    case fileForget(String)
    case fileConfirmForget
    case fileKeep
    case fileShowInFinder(String)
    /// H6: "Caret decides when to help" (true) or "Always suggest as I type".
    case routing(Bool)
    /// H8: the calendar accepted events go to; nil for the default.
    case calendar(String?)
    // Brief items 4, 6 and 7, the Writing tab: How you write's text and Save; an entry opened
    // (by id), its text, Save, Cancel and Remove; the accept keys; an app turned off or back on.
    case aboutText(String)
    case saveAbout
    case editEntry(String)
    case entryText(String)
    case saveEntry
    case cancelEntry
    case removeEntry(String)
    case keys(GhostKeys)
    case appOff(String)
    case appOn(String)
    /// Brief item 8: Download Caret's model, or stop the download running.
    case model
}

/// "What Caret knows" (DIRECTION.md 5.8): what Caret remembers, in groups, and what it may do per
/// kind of action. Caret's own window: a serif title (Caret speaking), text tabs with a Carrot
/// underline, rows on hairlines with no cards, and permissions as pop-up buttons, the way Mac
/// settings pick one of four.
///
/// M1's markdown memory adds, per section, Edit (the section's file in Caret's editor) and Show in
/// Finder; the file's problems by line and field; and on a fact Caret noticed itself, where it saw
/// it and two answers, Keep and Not right.
///
/// Motion, all state indication: a confirmed change washes its row in Carrot once (400 ms), a
/// forgotten row fades out in 120 ms, a row's controls fade in over 120 ms under the pointer.
/// Keyboard focus shows them at once; tabs, rules, the editor and Not right open and close with no
/// motion, since each follows a key or a click the user is watching. Under Reduce Motion only the
/// wash (a color change) and the fades remain.
struct MemoryView: View {
    enum Tab: String, CaseIterable, Codable { case memory, permissions, sites, writing }

    /// DIRECTION.md's 620 wide. 600 tall rather than 560: with the permissions footer fixed under the
    /// list, 560 left the table scrolling after its fourth rule in the gallery's state.
    static let size = CGSize(width: 620, height: 600)
    static let title = "What Caret knows"
    /// True today: entries sit in the helper's store on this Mac, and a fill's candidate values go
    /// to the cloud model that picks them (the onboarding privacy line says the same).
    static let subtitle = "Saved on this Mac. When Caret works out what to fill, the values it might use go to its cloud model."
    static let offline = "Caret can't reach its memory right now. This is what it knew last, and nothing here can change until it's back."
    static let reading = "Reading Caret's memory"
    static let permissionsIntro = "What Caret may do on its own, by kind of action."

    /// The line under the title, for the tab shown.
    static func intro(_ tab: Tab) -> String {
        switch tab {
        case .memory: return subtitle
        case .permissions: return permissionsIntro
        case .sites: return SitesPage.intro
        case .writing: return WritingPageCopy.intro
        }
    }

    var state: MemoryBook.State
    var files = MemoryFiles.State()
    /// H14: the files the user kept for a question.
    var savedFiles = SavedFilesBook.State()
    var tab: Tab
    var character: FigureCharacter
    /// The Sites tab: where Caret stays out (H5).
    var sites = SitesPage.State()
    /// Permissions: "When Caret helps" (H6, `CaretSettings.routing`).
    var routing = false
    /// Permissions: "Calendar for new events" (H8); nil draws no row.
    var calendarRow: CalendarChoiceRow?
    /// The Writing tab (brief items 4, 6 and 7).
    var writing = WritingPage.State()
    var animated = true
    var now = Date()
    /// A row drawn as if the pointer were on it, for renders (hover does not exist off screen).
    var revealedRow: String?
    /// The app that opens a memory file, for the editor's "Open in …"; nil hides it.
    var editorApp: String?
    var send: (MemoryAction) -> Void = { _ in }

    @Environment(\.timeZone) private var timeZone
    @Environment(\.locale) private var locale

    private var calendar: Calendar {
        var c = Calendar.current
        c.timeZone = timeZone
        return c
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The header, tabs and footer keep their size; the list between them takes what is left
            // and scrolls (off screen, it is clipped there, as the window shows it).
            header
                .padding(.horizontal, 32)
                .padding(.top, 34)
                .layoutPriority(1)
            TextTabs(tabs: [(Tab.memory, "Memory"), (.permissions, "Permissions"), (.sites, "Sites"), (.writing, WritingPageCopy.tab)], current: tab) { send(.tab($0)) }
                .padding(.horizontal, 32)
                .padding(.top, 18)
                .layoutPriority(1)
            ScrollingColumn {
                VStack(alignment: .leading, spacing: 0) {
                    notices
                    switch tab {
                    case .memory: memory
                    case .permissions: permissions
                    case .sites: sitesList
                    case .writing: WritingTabView(state: writing, animated: animated, send: send)
                    }
                }
                .padding(.horizontal, 32)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .frame(maxHeight: .infinity)
            .probed("scroll")
            if tab == .permissions { permissionsFooter.layoutPriority(1) }
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(Color(token: Tokens.window))
        .clipped()
        .coordinateSpace(.named(LayoutProbe.space))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // Looking down at the list: it is what the figure knows. Alive at rest; references freeze it.
            FigureView(character: character, state: .noticed, facing: .right, size: 20, gaze: CGVector(dx: 0.2, dy: 0.8))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(Self.title)
                    .font(Tokens.Font.voiceDisplay(.newYork))
                    .tracking(-0.3)
                    .foregroundStyle(Color(token: Tokens.ink))
                    .accessibilityAddTraits(.isHeader)
                Text(Self.intro(tab))
                    .font(Tokens.Font.chrome)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var notices: some View {
        if !state.connected {
            Notice(text: Self.offline).padding(.top, 14)
        } else if let problem = state.listProblem {
            Notice(text: problem, action: ("Try again", { send(.retry) })).padding(.top, 14)
        } else if !state.loaded, state.entries.isEmpty {
            Notice(text: Self.reading).padding(.top, 14)
        } else if files.loaded, let problem = files.listProblem {
            // The files were listed on this connection and a later list failed. A helper that never
            // lists them (one from before M1) shows no notice: it simply has no Edit.
            Notice(text: problem, action: ("Try again", { send(.retry) })).padding(.top, 14)
        }
    }

    // MARK: - Memory

    private var memory: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(MemoryPage.sections(state, now: now, calendar: calendar, locale: locale)) { section in
                let doc = files.loaded ? MemoryFiles.doc(for: section.kind) : nil
                SectionHeadRow(title: section.title, doc: doc, opening: files.opening == doc && doc != nil, send: send)
                    .padding(.top, 20)
                    .padding(.bottom, 2)
                if let doc, let d = files.document(doc) {
                    ForEach(MemoryFiles.problemLines(d), id: \.self) { line in
                        ProblemLine(text: line)
                    }
                }
                if let doc, let problem = files.openProblems[doc] {
                    ProblemLine(text: "Caret couldn't open \(doc).md: \(problem)")
                }
                if let doc, let editor = files.editor, editor.doc == doc {
                    DocumentEditor(editor: editor, editorApp: editorApp, send: send)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                } else {
                    if section.rows.isEmpty {
                        Text(section.empty)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.vertical, 9)
                        Hairline()
                    }
                    ForEach(section.rows) { row in
                        MemoryRowView(
                            row: row, editor: state.editor?.entryId == row.id ? state.editor : nil,
                            correction: state.correcting?.entryId == row.id ? state.correcting : nil,
                            confirming: state.confirmingForget == row.id, washed: state.changed == row.id,
                            animated: animated, forceReveal: revealedRow == row.id, send: send
                        )
                        .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                        Hairline()
                    }
                }
            }
            if savedFiles.loaded { filesGroup }
            if state.unreadable > 0 {
                Text(state.unreadable == 1 ? "1 entry needs a newer version of Caret to show." : "\(state.unreadable) entries need a newer version of Caret to show.")
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.top, 10)
            }
        }
    }

    // MARK: - Files (H14)

    /// The files the user kept for a question, newest first: the name in Ink, then what it was kept for and when it
    /// last changed. Show in Finder and Forget show on the row under the pointer, as a memory row's controls do; a
    /// file no longer where it was kept says so and has no Show in Finder.
    private var filesGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: SavedFilesCopy.head)
                .padding(.top, 20)
                .padding(.bottom, 2)
            Text(SavedFilesCopy.intro)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 6)
            if let problem = savedFiles.problem { ProblemLine(text: problem) }
            if savedFiles.files.isEmpty {
                Text(SavedFilesCopy.empty)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 9)
                Hairline()
            }
            ForEach(savedFiles.files, id: \.id) { file in
                SavedFileRow(
                    file: file, detail: SavedFilesCopy.detail(file, now: now, calendar: calendar),
                    confirming: savedFiles.confirmingForget == file.id, forgetting: savedFiles.forgetting == file.id,
                    animated: animated, forceReveal: revealedRow == file.id, send: send
                )
                .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                Hairline()
            }
        }
    }

    // MARK: - Permissions

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoutingRowView(routing: routing) { send(.routing($0)) }
            Hairline()
            if let calendarRow {
                CalendarRowView(row: calendarRow) { send(.calendar($0)) }
                Hairline()
            }
            let rows = MemoryPage.rules(state, now: now, calendar: calendar, locale: locale)
            ForEach(rows) { row in
                RuleRowView(row: row) { send(.setRule(row.action, $0)) }
                // Under each write row: the skills on their own whose runs write under it.
                if let exceptions = MemoryPage.exceptions(state, under: row.action) {
                    ExceptionsView(exceptions: exceptions, animated: animated) { send(.control($0, .backOnTab, typed: false)) }
                        .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                }
                Hairline()
            }
        }
        .probed("table")
        .padding(.top, 6)
    }

    // MARK: - Sites (H5, "Not on this site")

    /// The page the user was on, with its switch; the sites Caret stays out of, each with Turn back
    /// on; a field to add one by address; then the switches for inline text (H14) and the pages with
    /// their own suggestions (H13). A site turned off or back on fades its row in or out
    /// over 120 ms, as a forgotten fact's row does; nothing moves under Reduce Motion.
    private var sitesList: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let here = SitesPage.here(sites.here, off: sites.off) {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SitesPage.hereLabel)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                        Text(SiteOrigin.display(here))
                            .font(Tokens.Font.row)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Button(SitesPage.turnOff) { send(.siteOff(here)) }
                        .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                        .accessibilityLabel("Not on \(SiteOrigin.display(here))")
                }
                .padding(.vertical, 12)
                .accessibilityElement(children: .contain)
                Hairline()
            }
            GroupHead(text: SitesPage.offHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            if sites.off.isEmpty {
                Text(SitesPage.empty)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.vertical, 9)
                Hairline()
            }
            ForEach(sites.off, id: \.self) { origin in
                HStack(alignment: .center, spacing: 14) {
                    Text(SiteOrigin.display(origin))
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: Tokens.ink))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(SitesPage.turnOn) { send(.siteOn(origin)) }
                        .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .accessibilityLabel("Turn Caret back on for \(SiteOrigin.display(origin))")
                }
                .padding(.vertical, 10)
                .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                Hairline()
            }
            VStack(alignment: .leading, spacing: 6) {
                // The field's name stays on screen: a placeholder alone goes as soon as one letter is typed.
                Text(SitesPage.addTitle)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .accessibilityHidden(true)
                HStack(alignment: .center, spacing: 10) {
                    EntryField(
                        title: SitesPage.addTitle, text: sites.draft, placeholder: SitesPage.placeholder,
                        onChange: { send(.siteDraft($0)) }, onSubmit: { send(.siteOff(nil)) }
                    )
                    .frame(maxWidth: 280)
                    Button(SitesPage.turnOff) { send(.siteOff(nil)) }
                        .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .disabled(sites.draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let problem = sites.problem { ProblemLine(text: problem) }
            }
            .padding(.top, 18)
            // H14: the switches for inline text, then the pages with their own suggestions: settings after the list
            // of sites and the field that adds to it.
            switchesGroup
            ownSuggestionsGroup
        }
        .padding(.top, 6)
    }

    /// H14: inline text in pages, two switches. Web pages first, on at first; rich editors under it, off at first, with
    /// the one-line reason, and off to the touch while web pages are off (they need both).
    private var switchesGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: PageInlineCopy.switchesHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            SwitchRow(title: PageInlineCopy.webPages, detail: PageInlineCopy.webPagesDetail, isOn: sites.pageInlineText) { send(.pageInlineText($0)) }
                .probed("switch.web")
            Hairline()
            SwitchRow(
                title: PageInlineCopy.richEditors,
                detail: sites.pageInlineText ? PageInlineCopy.richEditorsDetail : PageInlineCopy.richEditorsDetail + " " + PageInlineCopy.richEditorsNeedsWeb,
                isOn: sites.pageInlineContentEditable, enabled: sites.pageInlineText
            ) { send(.pageInlineContentEditable($0)) }
                .probed("switch.rich")
            Hairline()
        }
    }

    /// H13: pages that offer their own text as the user types, where Caret stays quiet unless turned on. Gmail only:
    /// Google Docs stays off until Caret can read the text being typed there, so it has no switch yet.
    private var ownSuggestionsGroup: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: PageInlineCopy.sitesHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            Text(PageInlineCopy.sitesIntro)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 6)
            let on = sites.pageInline.isOn(.gmail)
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PageInlineCopy.name(.gmail))
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: Tokens.ink))
                    Text(PageInlineCopy.sitesState(on))
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                }
                Spacer(minLength: 0)
                Button(on ? PageInlineCopy.sitesTurnOff : PageInlineCopy.sitesTurnOn) { send(.pageInline(.gmail, !on)) }
                    .buttonStyle(WindowButtonStyle(kind: on ? .ink : .key, small: true))
                    .accessibilityLabel(on ? "Turn off Caret's text in Gmail" : "Turn on Caret's text in Gmail")
            }
            .padding(.vertical, 10)
            .accessibilityElement(children: .contain)
            Hairline()
        }
    }

    /// The limit no setting moves, under the list and outside the scroll, so it is always in the
    /// window however long the list grows.
    private var permissionsFooter: some View {
        VStack(spacing: 0) {
            Hairline()
            Text(MemoryPage.ceiling)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 32)
                .padding(.vertical, 12)
                .probed("footer")
        }
        .background(Color(token: Tokens.keyFill))
    }
}

/// A line above the lists when they cannot be trusted as current: offline, unreadable, or loading.
/// The 2 pt Carrot edge says it needs reading; no wash.
private struct Notice: View {
    var text: String
    var action: (String, () -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            NeedsYouEdge().frame(height: 18)
            Text(text)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action.0, action: action.1).buttonStyle(WindowButtonStyle(kind: .key, small: true))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A section's name, and for the three files the user may edit, Edit and Show in Finder.
private struct SectionHeadRow: View {
    var title: String
    var doc: String?
    var opening: Bool
    var send: (MemoryAction) -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            GroupHead(text: title)
            Spacer(minLength: 0)
            if let doc {
                Button(opening ? "Opening" : "Edit") { send(.openFile(doc)) }
                    .buttonStyle(QuietButtonStyle())
                    .disabled(opening)
                    .accessibilityLabel("Edit \(title)")
                    .accessibilityHint("Opens the file Caret keeps for \(title) in Caret's editor")
                Button("Show in Finder") { send(.showInFinder(doc)) }
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityLabel("Show \(title) in Finder")
            }
        }
    }
}

/// A problem the helper found in a file: the file, the line, the field, and its words, in Ink.
private struct ProblemLine: View {
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            NeedsYouEdge().frame(height: 13)
            Text(text)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The file editor

/// A section's file in Caret's own editor: the markdown as it is on disk, saved over the revision it
/// was read at. If the file changed meanwhile, the save writes nothing and the editor asks: Reload
/// (the file as it is now) or Keep my text (save over it). ⌘S saves; Esc closes when nothing changed.
private struct DocumentEditor: View {
    var editor: MemoryFiles.Editor
    var editorApp: String?
    var send: (MemoryAction) -> Void

    @Environment(\.rendersOffscreen) private var offscreen
    @FocusState private var focused: Bool

    static let height: CGFloat = 230

    var body: some View {
        Block {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline) {
                    Text(editor.file)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Color(token: Tokens.ink2))
                    Spacer(minLength: 0)
                    if let editorApp {
                        Button("Open in \(editorApp)") { send(.openInEditor) }.buttonStyle(QuietButtonStyle())
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 6)
                Hairline()
                text
                    .frame(height: Self.height)
                Hairline()
                footer
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
            }
        }
        .background(Color(token: Tokens.card), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onExitCommand { if !editor.edited { send(.closeFile) } }
    }

    @ViewBuilder
    private var text: some View {
        let font = Font.system(size: 12.5, design: .monospaced)
        if offscreen {
            Text(editor.text)
                .font(font)
                .foregroundStyle(Color(token: Tokens.ink))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .clipped()
        } else {
            TextEditor(text: Binding(get: { editor.text }, set: { send(.fileText($0)) }))
                .font(font)
                .foregroundStyle(Color(token: Tokens.ink))
                .scrollContentBackground(.hidden)
                .lineSpacing(3)
                .padding(.horizontal, 7)
                .padding(.vertical, 6)
                .focused($focused)
                .disabled(editor.saving)
                .accessibilityLabel(editor.file)
                .onAppear { DispatchQueue.main.async { focused = true } }
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let conflict = editor.conflict {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(conflict.message)
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Reload shows the file as it is now. Keep my text saves yours over it.")
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .fixedSize(horizontal: false, vertical: true)
                    // A Reload or Keep my text that failed says so beside the choice it leaves open.
                    if let problem = editor.problem {
                        Text(problem)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button("Reload") { send(.reloadFile) }
                    .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    .disabled(editor.saving)
                Button("Keep my text") { send(.keepMyText) }
                    .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    .disabled(editor.saving)
            }
            .accessibilityElement(children: .contain)
        } else {
            HStack(alignment: .center, spacing: 8) {
                Text(editor.problem ?? " ")
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHidden(editor.problem == nil)
                Button("Cancel") { send(.closeFile) }
                    .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                Button(editor.saving ? "Saving" : "Save") { send(.saveFile) }
                    .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(editor.saving)
            }
        }
    }
}

// MARK: - Switches and files (H14)

/// One setting with a switch: its name in Ink, what it does in Ink 2 under it, and the switch at the trailing edge,
/// aligned to the name's line. A flip saves at once, through the settings file, with no motion of its own beyond the
/// switch's.
struct SwitchRow: View {
    var title: String
    var detail: String
    var isOn: Bool
    var enabled = true
    var change: (Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: Tokens.ink))
                Text(detail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            SettingSwitch(label: title, isOn: isOn, enabled: enabled, change: change)
                .padding(.top, 1)
        }
        .padding(.vertical, 11)
        .accessibilityElement(children: .contain)
    }
}

/// A kept file: its name, then what it was kept for and when it last changed. Show in Finder and Forget appear under
/// the pointer, with keyboard focus, or while Forget waits for its answer, as a memory row's controls do.
struct SavedFileRow: View {
    var file: SavedFilesReply.File
    var detail: String
    var confirming: Bool
    var forgetting: Bool
    var animated: Bool
    var forceReveal = false
    var send: (MemoryAction) -> Void

    @State private var hovering = false
    /// Every action on the row, so keyboard focus on any of them shows them all (prep-for-prod H14-1).
    private enum Control: Hashable { case finder, forget, keep, confirm }
    @FocusState private var focused: Control?

    private var revealed: Bool { forceReveal || hovering || focused != nil || confirming }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: file.edited == nil ? Tokens.ink2 : Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                Text(confirming ? SavedFilesCopy.forgetQuestion : detail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: confirming ? Tokens.ink : Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                if confirming {
                    Button("Keep") { send(.fileKeep) }.buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .focused($focused, equals: .keep)
                    Button(SavedFilesCopy.forget) { send(.fileConfirmForget) }.buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                        .focused($focused, equals: .confirm)
                } else {
                    if file.edited != nil {
                        Button(SavedFilesCopy.showInFinder) { send(.fileShowInFinder(file.id)) }
                            .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                            .focused($focused, equals: .finder)
                            .accessibilityLabel("Show \(file.name) in Finder")
                    }
                    Button(forgetting ? "Forgetting" : SavedFilesCopy.forget) { send(.fileForget(file.id)) }
                        .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .disabled(forgetting)
                        .focused($focused, equals: .forget)
                        .accessibilityLabel("Forget \(file.name)")
                }
            }
            .opacity(revealed ? 1 : 0)
            .animation(animated ? MemoryRowView.pointerFade : nil, value: hovering)
        }
        .padding(.vertical, 10)
        .padding(.leading, confirming ? 10 : 0)
        .background(alignment: .leading) {
            if confirming { NeedsYouEdge().padding(.vertical, 8) }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: Text(SavedFilesCopy.forget)) { send(.fileForget(file.id)) }
    }
}

// MARK: - A memory row

struct MemoryRowView: View {
    var row: MemoryPage.Row
    var editor: MemoryBook.Editor?
    var correction: MemoryBook.Correction? = nil
    var confirming: Bool
    var washed: Bool
    var animated: Bool
    var forceReveal = false
    var send: (MemoryAction) -> Void

    @State private var wash: Double = 0
    @State private var hovering = false
    @FocusState private var focused: MemoryPage.Control?

    /// Edit, Pause and Forget show on the row under the pointer or holding keyboard focus, and on a
    /// row that waits for the user (a Forget to confirm, a refusal to retry). Hidden, they keep their
    /// place in the key loop, so keyboard focus reaching one shows them; VoiceOver gets the same
    /// controls as the row's own actions, whatever is drawn. A noticed fact's Keep and Not right are
    /// always shown: they are the question the row asks.
    private var revealed: Bool { forceReveal || hovering || focused != nil || waiting || row.problem != nil || row.status == .noticed }

    /// The row waits for the user's answer: a Forget to confirm, or the helper's offer to let a
    /// skill run on its own.
    private var waiting: Bool { confirming || row.question != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: row.status == .paused ? Tokens.ink2 : Tokens.ink))
                        .fixedSize(horizontal: false, vertical: true)
                    if confirming {
                        Text(MemoryPage.forgetQuestion(row.kind))
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let question = row.question {
                        // The helper's own words for its offer (skills.ts offerPromote).
                        Text(question.says)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(question.detail)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let noticed = row.noticedLine {
                        Text(noticed)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                    } else if !row.secondary.isEmpty {
                        Text(row.secondary)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let problem = row.problem, editor == nil, correction == nil {
                        Text(problem)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if editor == nil, correction == nil { buttons }
            }
            if let editor {
                EditorView(editor: editor, send: send)
                    .padding(.top, 10)
            }
            if let correction {
                CorrectionView(correction: correction, title: row.title, send: send)
                    .padding(.top, 10)
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, waiting ? 10 : 0)
        .background(alignment: .leading) {
            ZStack(alignment: .leading) {
                // Waiting for the user: the 2 pt Carrot edge (DIRECTION.md: never a wash).
                if waiting { NeedsYouEdge().padding(.vertical, 8) }
                Rectangle().fill(Color(token: Tokens.carrotWash)).opacity(wash)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .modifier(RowActions(row: row, enabled: editor == nil && correction == nil && !waiting, send: send))
        .onChange(of: washed) { _, now in
            guard now else { return }
            // A color change, not movement: it plays under Reduce Motion too.
            if animated {
                wash = 1
                withAnimation(.linear(duration: Motion.Duration.wash)) { wash = 0 }
            }
            send(.washed)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        HStack(spacing: 6) {
            if confirming {
                Button("Keep") { send(.keep) }.buttonStyle(WindowButtonStyle(kind: .key, small: true))
                Button("Forget") { send(.confirmForget) }.buttonStyle(WindowButtonStyle(kind: .ink, small: true))
            } else if let question = row.question {
                Button(question.decline) { send(.answer(row.id, accept: false)) }
                    .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    .disabled(row.busy)
                Button(question.accept) { send(.answer(row.id, accept: true)) }
                    .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    .disabled(row.busy)
            } else {
                ForEach(row.controls, id: \.self) { control in
                    Button(Self.title(control, row)) {
                        send(.control(row.id, control, typed: row.typed))
                    }
                    .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    .disabled(row.busy)
                    .focused($focused, equals: control)
                    .accessibilityLabel("\(Self.title(control, row)): \(row.title)")
                }
            }
        }
        .opacity(revealed ? 1 : 0)
        .animation(animated ? Self.pointerFade : nil, value: hovering)
    }

    static func title(_ control: MemoryPage.Control, _ row: MemoryPage.Row) -> String {
        row.typed && control == .forget ? "Remove" : MemoryPage.controlTitle(control, kind: row.kind)
    }

    /// The controls' fade when the pointer arrives or leaves: opacity only, so it plays under Reduce
    /// Motion too, and leaving is as quick as arriving. Keyed to the pointer alone, so keyboard focus,
    /// a Forget to confirm and a refusal show them in the same frame.
    static let pointerFade = Motion.curve(Motion.easeOut, 0.12)
}

/// A row's controls as named accessibility actions, so VoiceOver offers Edit, Pause and Forget (or
/// Keep and Not right) on the row itself, never depending on whether the buttons are drawn.
private struct RowActions: ViewModifier {
    var row: MemoryPage.Row
    var enabled: Bool
    var send: (MemoryAction) -> Void

    func body(content: Content) -> some View {
        row.controls.reduce(AnyView(content)) { view, control in
            guard enabled, !row.busy else { return view }
            return AnyView(view.accessibilityAction(named: Text(MemoryRowView.title(control, row))) { send(.control(row.id, control, typed: row.typed)) })
        }
    }
}

/// An open edit: a label and a field per editable value, the problem under them, and Cancel and
/// Save. Return saves, Esc cancels.
private struct EditorView: View {
    var editor: MemoryBook.Editor
    var send: (MemoryAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(editor.fields.enumerated()), id: \.element.key) { index, field in
                HStack(spacing: 10) {
                    FieldLabel(text: field.title).frame(width: 74, alignment: .leading)
                    EntryField(
                        title: field.title, text: field.text, autofocus: index == editor.fields.count - 1,
                        showsFocus: index == editor.fields.count - 1, enabled: !editor.saving,
                        onChange: { send(.draft(field.key, $0)) }, onSubmit: { send(.save) }
                    )
                }
            }
            HStack(alignment: .center, spacing: 6) {
                Text(editor.problem ?? " ")
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 84)
                    .accessibilityHidden(editor.problem == nil)
                Button("Cancel") { send(.cancel) }.buttonStyle(WindowButtonStyle(kind: .key, small: true))
                Button(editor.saving ? "Saving" : "Save") { send(.save) }
                    .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    .disabled(editor.saving)
            }
        }
        .onExitCommand { send(.cancel) }
    }
}

/// "Not right" on a noticed fact: a field for what is right, Forget, and Save. A preference has no
/// field; it can only be forgotten. Return saves what is typed, Esc puts the row back.
private struct CorrectionView: View {
    var correction: MemoryBook.Correction
    var title: String
    var send: (MemoryAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if correction.correctable {
                EntryField(
                    title: "What's right instead", text: correction.text, placeholder: "What's right", autofocus: true, showsFocus: true,
                    enabled: !correction.sending, onChange: { send(.correction($0)) }, onSubmit: { send(.sendCorrection(forget: false)) }
                )
            } else {
                Text("Caret will forget this and stop using it.")
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink))
            }
            HStack(alignment: .center, spacing: 6) {
                Text(correction.problem ?? (correction.correctable ? "Or forget it, and Caret stops using it." : " "))
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: correction.problem == nil ? Tokens.ink2 : Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Cancel") { send(.cancelCorrection) }.buttonStyle(WindowButtonStyle(kind: .key, small: true))
                Button("Forget") { send(.sendCorrection(forget: true)) }
                    .buttonStyle(WindowButtonStyle(kind: correction.correctable ? .key : .ink, small: true))
                    .disabled(correction.sending)
                if correction.correctable {
                    Button(correction.sending ? "Saving" : "Save") { send(.sendCorrection(forget: false)) }
                        .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                        .disabled(correction.sending)
                }
            }
        }
        .onExitCommand { send(.cancelCorrection) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Not right: \(title)")
    }
}

// MARK: - A permission row

/// One action type: what it covers and its last uses on the left; on the right its rule as a pop-up
/// button, with what that rule means beneath. Rules this kind of action can never take are in the
/// menu, disabled, so the ceiling is visible where it applies.
/// "When Caret helps" (H6): the first row of Permissions. Its words at the left, with what the
/// current choice does under them, and the choice in the rule rows' column, so the row stays as
/// short as a rule's. A pick changes the setting at once; the sentence changes with it, with no
/// motion: it follows a click the user is watching.
struct RoutingRowView: View {
    var routing: Bool
    var choose: (Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text(RoutingCopy.title)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: Tokens.ink))
                Text(RoutingCopy.covers)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                Text(RoutingCopy.detail(routing))
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.top, 3)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            PopUpChoice(
                label: RoutingCopy.title,
                items: [true, false].map { .init(value: $0, title: RoutingCopy.choice($0), enabled: true) },
                current: routing, width: RuleRowView.columnWidth, choose: { if $0 != routing { choose($0) } }
            )
            .frame(width: RuleRowView.columnWidth, alignment: .leading)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .probed("routing")
    }
}

/// "Calendar for new events" (H8): the second row of Permissions, shaped as the routing row above it.
/// Its words at the left, with what happens now under them; the pop-up in the rule rows' column. Before
/// Calendar access the pop-up holds only the default and is off, and the sentence says when Caret asks.
/// A pick saves at once and the sentence changes with it, with no motion, as on the routing row.
struct CalendarRowView: View {
    var row: CalendarChoiceRow
    var choose: (String?) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text(EventCalendarCopy.title)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: Tokens.ink))
                Text(EventCalendarCopy.covers)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                Text(row.detail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.top, 3)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            PopUpChoice(
                label: EventCalendarCopy.title,
                items: row.items.map { .init(value: $0.id, title: $0.title, enabled: true) },
                // Every pick is saved, Default included: a saved calendar that is gone shows as Default, and
                // picking Default then clears it.
                current: row.current, width: RuleRowView.columnWidth, choose: choose
            )
            .disabled(!row.enabled)
            .opacity(row.enabled ? 1 : 0.6)
            .frame(width: RuleRowView.columnWidth, alignment: .leading)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .probed("calendar")
    }
}

struct RuleRowView: View {
    var row: MemoryPage.RuleRow
    var choose: (HelperMemory.Rule) -> Void

    static let order: [HelperMemory.Rule] = [.handoff, .ask, .actIfApproved, .act]
    static let columnWidth: CGFloat = 200

    var body: some View {
        HStack(alignment: .top, spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: Tokens.ink))
                Text(row.example)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                uses.padding(.top, 3)
                if let problem = row.problem {
                    Text(problem)
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink))
                        .padding(.top, 2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: 5) {
                PopUpChoice(
                    label: row.title,
                    items: Self.order.map { .init(value: $0, title: MemoryPage.ruleTitle($0), enabled: $0 == row.rule || row.choices.contains($0)) },
                    current: row.rule, width: 168, choose: { if $0 != row.rule { choose($0) } }
                )
                .disabled(row.busy)
                .opacity(row.busy ? 0.6 : 1)
                Text(row.ruleDetail)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(width: Self.columnWidth, alignment: .leading)
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var uses: some View {
        if row.uses.isEmpty {
            Text(MemoryPage.usesNone)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
        } else {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(row.uses.enumerated()), id: \.offset) { _, use in
                    Text("\(use.says) · \(use.when)")
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Last uses: " + row.uses.map(\.says).joined(separator: ". "))
        }
    }
}

/// The skills on their own under the write row above them: each by name and trigger, with one button
/// that puts it back on Tab. Set in under a 2 pt Carrot edge, so it reads as part of that rule. When
/// the setting holds them back, its sentence is in Ink: the user has to settle it. Nothing moves: a
/// skill that goes back on Tab leaves with the same 120 ms fade as a forgotten row.
struct ExceptionsView: View {
    var exceptions: MemoryPage.Exceptions
    var animated = true
    var backOnTab: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            NeedsYouEdge()
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(exceptions.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color(token: Tokens.ink))
                        .accessibilityAddTraits(.isHeader)
                    Text(exceptions.detail)
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: exceptions.runs ? Tokens.ink2 : Tokens.ink))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 6)
                ForEach(exceptions.skills) { e in
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(e.name)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color(token: Tokens.ink))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(e.when)
                                .font(Tokens.Font.chromeSmall)
                                .foregroundStyle(Color(token: Tokens.ink2))
                                .fixedSize(horizontal: false, vertical: true)
                            if let problem = e.problem {
                                Text(problem)
                                    .font(Tokens.Font.chromeSmall)
                                    .foregroundStyle(Color(token: Tokens.ink))
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.top, 2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Button(MemoryPage.controlTitle(.backOnTab)) { backOnTab(e.id) }
                            .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                            .disabled(e.busy)
                            // The visible words first, so voice control finds the button by them.
                            .accessibilityLabel("\(MemoryPage.controlTitle(.backOnTab)): \(e.name)")
                    }
                    .padding(.vertical, 5)
                    .accessibilityElement(children: .contain)
                    .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.bottom, 12)
        .probed("exceptions-\(exceptions.action.rawValue)")
    }
}
