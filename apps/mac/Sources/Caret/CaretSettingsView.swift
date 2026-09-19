import SwiftUI

struct CaretSettingsView: View {
    @ObservedObject var model: Model
    @State private var tab: SettingsTab = .skills
    @State private var selectedSkillActionID: String?
    @State private var selectedMemoryNoteID: String?
    @State private var sidebarCollapsed = false
    @State private var showingDiscardConfirmation = false
    @State private var deletionFailed = false

    @ObservedObject private var editor: NoteEditorSession

    init(model: Model) {
        self.model = model
        self.editor = model.noteEditor
    }

    private var appsBinding: Binding<String> {
        Binding(
            get: { editor.draft.apps.joined(separator: ", ") },
            set: { editor.draft.apps = normalizedApps(parseApps($0)) }
        )
    }
    @State private var composeShellSkillID: String?
    @State private var composeShellMemoryID: String?

    private let accentBlue = Color(red: 0.26, green: 0.52, blue: 0.98)
    private let sidebarIdealWidth: CGFloat = 268

    enum SettingsTab: String, CaseIterable, Identifiable {
        case skills = "Skills"
        case memories = "Memories"

        var id: String { rawValue }

        var icon: String {
            switch self {
            case .memories: return "tray.full"
            case .skills: return "wand.and.stars"
            }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    if !sidebarCollapsed {
                        sidebar
                            .frame(width: sidebarIdealWidth)
                        Divider()
                    }
                    detailColumn
                        .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if case .failed(let message) = editor.status {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button("Retry save") { flushAutosave() }
                            Button("Copy draft") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(
                                    editor.draft.title + "\n\n" + editor.draft.body, forType: .string
                                )
                            }
                            Spacer()
                            Button("Discard changes") { showingDiscardConfirmation = true }
                        }
                    }
                    .padding(12)
                    .background(Color.orange.opacity(0.1))
                }
                footer
            }
            .frame(minWidth: 720, minHeight: 520)
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    SidebarCollapseToggle(collapsed: $sidebarCollapsed)
                }
            }
        }
        .confirmationDialog("Discard unsaved changes?", isPresented: $showingDiscardConfirmation) {
            Button("Discard changes", role: .destructive) {
                editor.discard()
                refreshSelection()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Your unsaved edits will be lost. The saved note will not be changed.")
        }
        .alert("Couldn't delete this note", isPresented: $deletionFailed) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Check storage access and try again.")
        }
        .onAppear {
            refreshSelection()
        }
        .onChange(of: model.actionSkillItems) { _, _ in syncSkillSelection() }
        .onChange(of: model.memoryNotes) { _, _ in syncMemorySelection() }
        .onChange(of: selectedSkillActionID) { _, newID in
            guard tab == .skills, let newID else { return }
            if newID == composeShellSkillID { return }
            composeShellSkillID = nil
            guard let item = skillItem(for: newID) else { return }
            applySkillEditor(item: item)
        }
        .onChange(of: selectedMemoryNoteID) { _, newID in
            guard tab == .memories, let newID else { return }
            if newID == composeShellMemoryID { return }
            composeShellMemoryID = nil
            guard let note = model.memoryNotes.first(where: { $0.id == newID }) else { return }
            applyMemoryEditor(note: note)
        }
        .onChange(of: editor.draft) { _, _ in editor.scheduleSave(using: writeSnapshot) }
        .onDisappear { flushAutosave() }
    }

    private var detailColumn: some View {
        VStack(spacing: 0) {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            sidebarBrand
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 10)

            sidebarLibrary
                .padding(.horizontal, 10)
                .padding(.bottom, 10)

            Divider()
                .padding(.horizontal, 10)

            Group {
                switch tab {
                case .skills:
                    VStack(spacing: 0) {
                        tabCompletionsSidebarSection
                        sidebarListHeader
                            .padding(.horizontal, 14)
                            .padding(.top, 8)
                            .padding(.bottom, 4)
                        List(selection: $selectedSkillActionID) {
                            ForEach(model.regularActionSkillItems) { item in
                                SkillActionRow(
                                    item: item,
                                    isPinned: model.pinStore.isPinned(item.action.id),
                                    canPin: model.canPin(item.action),
                                    onTogglePin: { model.togglePin(item.action) }
                                )
                                    .tag(item.action.id)
                                    .sidebarListRowStyle
                                    .contextMenu {
                                        Button("Remove skill", role: .destructive) {
                                            removeSkill(item.action.id)
                                        }
                                    }
                            }
                            .onDelete(perform: deleteSkillRows)
                        }
                        .sidebarListStyle
                    }
                case .memories:
                    List(selection: $selectedMemoryNoteID) {
                        if model.memoryNotes.isEmpty {
                            Text("No memories yet")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .listRowBackground(Color.clear)
                                .listRowInsets(SidebarListMetrics.rowInsets)
                        }
                        ForEach(model.memoryNotes) { note in
                            NoteRow(note: note, showApps: false, accent: CaretNotePalette.accent(for: note.id))
                                .tag(note.id)
                                .sidebarListRowStyle
                        }
                        .onDelete(perform: deleteMemoryRows)
                    }
                    .sidebarListStyle
                }
            }
            .frame(maxHeight: .infinity)
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var sidebarLibrary: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Library")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            ForEach(SettingsTab.allCases) { section in
                Button {
                    guard flushAutosave() else { return }
                    tab = section
                    if section == .skills {
                        syncSkillSelection()
                        if let id = selectedSkillActionID,
                           let item = skillItem(for: id) {
                            applySkillEditor(item: item)
                        }
                    } else {
                        syncMemorySelection()
                        if let id = selectedMemoryNoteID,
                           let note = model.memoryNotes.first(where: { $0.id == id }) {
                            applyMemoryEditor(note: note)
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: section.icon)
                            .font(.system(size: 15, weight: .semibold))
                            .frame(width: 20)
                        Text(section.rawValue)
                            .font(.body.weight(tab == section ? .semibold : .regular))
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(tab == section ? Color.accentColor.opacity(0.14) : Color.clear)
                    }
                    .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var tabCompletionsSidebarSection: some View {
        let item = model.tabCompletionsItem
        return VStack(alignment: .leading, spacing: 4) {
            Text("Tab completions")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
                .padding(.horizontal, 14)
                .padding(.top, 8)
            List(selection: $selectedSkillActionID) {
                SkillActionRow(
                    item: item,
                    isPinned: false,
                    canPin: false,
                    onTogglePin: {}
                )
                .tag(TabCompletions.actionID)
                .sidebarListRowStyle
            }
            .sidebarListStyle
            .frame(height: SidebarListMetrics.rowMinHeight + 12)
        }
    }

    @ViewBuilder
    private var sidebarListHeader: some View {
        HStack {
            Text(tab == .skills ? "Actions" : "Notes")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer()
            Button {
                guard flushAutosave() else { return }
                if tab == .skills {
                    beginNewSkill()
                } else {
                    beginNewMemory()
                }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(tab == .skills ? "New skill" : "New memory")
        }
    }

    private var sidebarBrand: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkle")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Circle().fill(accentBlue))
            VStack(alignment: .leading, spacing: 2) {
                Text("Caret")
                    .font(.title3.weight(.semibold))
                Text("Skills & memories")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var detail: some View {
        switch tab {
        case .skills:
            if let id = selectedSkillActionID,
               let item = skillItem(for: id) {
                SkillNoteEditor(
                    model: model,
                    action: item.action,
                    note: item.note,
                    accent: CaretNotePalette.accent(for: item.action.id),
                    title: $editor.draft.title,
                    icon: $editor.draft.icon,
                    bodyText: $editor.draft.body,
                    appsText: appsBinding,
                    saveStatus: editor.status,
                    iconChoices: CaretSymbolChoices.skillIcons,
                    appsMode: TabCompletions.isTabCompletionsAction(item.action.id) ? .exclude : .include,
                    titleIsEditable: !TabCompletions.isTabCompletionsAction(item.action.id),
                    canDelete: !TabCompletions.isTabCompletionsAction(item.action.id),
                    onDelete: { removeSkill(item.action.id) }
                )
                .id(item.action.id)
            } else {
                ContentUnavailableView("Select an action", systemImage: "wand.and.stars")
            }
        case .memories:
            if model.memoryNotes.isEmpty {
                ContentUnavailableView {
                    Label("No memories yet", systemImage: "tray")
                } description: {
                    Text("Capture preferences and context Caret should remember.")
                } actions: {
                    Button("New memory") { beginNewMemory() }
                        .buttonStyle(.borderedProminent)
                }
            } else if let id = selectedMemoryNoteID,
                      let note = model.memoryNotes.first(where: { $0.id == id }) {
                MemoryNoteEditor(
                    note: note,
                    accent: CaretNotePalette.accent(for: note.id),
                    title: $editor.draft.title,
                    icon: $editor.draft.icon,
                    bodyText: $editor.draft.body,
                    saveStatus: editor.status,
                    iconChoices: CaretSymbolChoices.memoryIcons,
                    onDelete: { removeMemory(note.id) }
                )
                .id(note.id)
            } else {
                ContentUnavailableView("Select a memory", systemImage: "tray.full")
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Check Accessibility") { model.onReconnectAccessibility?() }
            Spacer()
            Text(model.accessibilityConnected ? "Accessibility connected" : "Accessibility not connected")
                .font(.caption)
                .foregroundStyle(model.accessibilityConnected ? .green : .orange)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(Color.primary.opacity(0.04))
    }

    private func refreshSelection() {
        // Reopening Settings restores the retained draft, including a failed save.
        if let target = editor.target {
            switch target {
            case .skill(let id): tab = .skills; selectedSkillActionID = id
            case .memory(let id): tab = .memories; selectedMemoryNoteID = id
            }
        }
        model.reloadNotes()
        syncSkillSelection()
        syncMemorySelection()
        if tab == .skills,
           let id = selectedSkillActionID,
           let item = skillItem(for: id) {
            applySkillEditor(item: item)
        } else if tab == .memories,
                  let id = selectedMemoryNoteID,
                  let note = model.memoryNotes.first(where: { $0.id == id }) {
            applyMemoryEditor(note: note)
        }
    }

    private func syncSkillSelection() {
        if let composeShellSkillID, composeShellSkillID == selectedSkillActionID {
            return
        }
        let previous = selectedSkillActionID
        if selectedSkillActionID == nil
            || (!model.actionSkillItems.contains(where: { $0.action.id == selectedSkillActionID })
                && selectedSkillActionID != TabCompletions.actionID) {
            selectedSkillActionID = TabCompletions.actionID
        }
        guard tab == .skills, selectedSkillActionID != previous,
              let id = selectedSkillActionID,
              let item = skillItem(for: id)
        else { return }
        applySkillEditor(item: item)
    }

    private func skillItem(for actionID: String) -> ActionSkillItem? {
        if actionID == TabCompletions.actionID {
            return model.tabCompletionsItem
        }
        return model.actionSkillItems.first(where: { $0.action.id == actionID })
    }

    private func syncMemorySelection() {
        if let composeShellMemoryID, composeShellMemoryID == selectedMemoryNoteID {
            return
        }
        let previous = selectedMemoryNoteID
        if selectedMemoryNoteID == nil || !model.memoryNotes.contains(where: { $0.id == selectedMemoryNoteID }) {
            selectedMemoryNoteID = model.memoryNotes.first?.id
        }
        guard tab == .memories, selectedMemoryNoteID != previous,
              let id = selectedMemoryNoteID,
              let note = model.memoryNotes.first(where: { $0.id == id })
        else { return }
        applyMemoryEditor(note: note)
    }

    private func applySkillEditor(item: ActionSkillItem) {
        let loaded = editor.load(.skill(item.action.id), snapshot: NoteEditorSnapshot(
            title: TabCompletions.isTabCompletionsAction(item.action.id) ? TabCompletions.defaultTitle : (item.note?.title ?? item.action.title),
            icon: item.note?.icon ?? CaretActionIcons.icon(for: item.action.id),
            body: item.note?.body ?? "",
            apps: normalizedApps(TabCompletions.isTabCompletionsAction(item.action.id) ? (item.note?.excludedApps ?? []) : (item.note?.apps ?? []))
        ), using: writeSnapshot)
        if !loaded { restoreEditorSelection() }
    }

    private func applyMemoryEditor(note: CaretNote) {
        let loaded = editor.load(.memory(note.id), snapshot: NoteEditorSnapshot(
            title: note.title, icon: note.icon, body: note.body, apps: []
        ), using: writeSnapshot)
        if !loaded { restoreEditorSelection() }
    }

    private func restoreEditorSelection() {
        switch editor.target {
        case .skill(let id): tab = .skills; selectedSkillActionID = id
        case .memory(let id): tab = .memories; selectedMemoryNoteID = id
        case nil: break
        }
    }

    @discardableResult
    private func flushAutosave() -> Bool {
        editor.save(using: writeSnapshot)
    }

    private func writeSnapshot(_ target: NoteEditorTarget, _ draft: NoteEditorSnapshot) throws {
        let saved: Bool
        switch target {
        case .skill(let id):
            guard skillItem(for: id) != nil else {
                throw NoteEditorWriteError.noteUnavailable
            }
            saved = model.saveSkillNote(actionID: id, title: draft.title, icon: draft.icon,
                                        body: draft.body,
                                        apps: TabCompletions.isTabCompletionsAction(id) ? [] : draft.apps,
                                        excludedApps: TabCompletions.isTabCompletionsAction(id) ? draft.apps : [])
        case .memory(let id):
            guard model.memoryNotes.contains(where: { $0.id == id }) else {
                throw NoteEditorWriteError.noteUnavailable
            }
            saved = model.saveMemoryNote(noteID: id, title: draft.title, icon: draft.icon,
                                         body: draft.body, apps: []) != nil
        }
        guard saved else { throw NoteEditorWriteError.saveFailed }
        switch target {
        case .skill(let id): if composeShellSkillID == id { composeShellSkillID = nil }
        case .memory(let id): if composeShellMemoryID == id { composeShellMemoryID = nil }
        }
    }

    private func parseApps(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    private func normalizedApps(_ apps: [String]) -> [String] {
        apps.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private func beginNewSkill() {
        guard flushAutosave() else { return }
        composeShellMemoryID = nil
        guard let id = model.createBlankSkill() else { return }
        tab = .skills
        composeShellSkillID = id
        selectedSkillActionID = id
        applyComposeShell(target: .skill(id), defaultIcon: "sparkle", defaultTitle: "Untitled skill")
    }

    private func beginNewMemory() {
        guard flushAutosave() else { return }
        composeShellSkillID = nil
        guard let id = model.createBlankMemory() else { return }
        tab = .memories
        composeShellMemoryID = id
        selectedMemoryNoteID = id
        applyComposeShell(target: .memory(id), defaultIcon: "tray.full", defaultTitle: "Untitled")
    }

    private func applyComposeShell(target: NoteEditorTarget, defaultIcon: String, defaultTitle: String) {
        editor.load(target, snapshot: NoteEditorSnapshot(title: "", icon: defaultIcon, body: "", apps: []),
                    defaultTitle: defaultTitle, using: writeSnapshot)
    }

    private func removeSkill(_ actionID: String) {
        guard flushAutosave() else { return }
        guard editor.delete(.skill(actionID), using: { _ in model.deleteSkill(actionID: actionID) }) else {
            deletionFailed = true
            return
        }
        if selectedSkillActionID == actionID {
            selectedSkillActionID = TabCompletions.actionID
            if let id = selectedSkillActionID,
               let item = skillItem(for: id) {
                applySkillEditor(item: item)
            }
        }
    }

    private func deleteSkillRows(at offsets: IndexSet) {
        let items = model.actionSkillItems
        for index in offsets {
            guard items.indices.contains(index) else { continue }
            removeSkill(items[index].action.id)
        }
    }

    private func removeMemory(_ id: String) {
        guard flushAutosave() else { return }
        guard editor.delete(.memory(id), using: { _ in model.deleteMemoryNote(id: id) }) else {
            deletionFailed = true
            return
        }
        syncMemorySelection()
    }

    private func deleteMemoryRows(at offsets: IndexSet) {
        let ids = offsets.compactMap { index in
            model.memoryNotes.indices.contains(index) ? model.memoryNotes[index].id : nil
        }
        for id in ids { removeMemory(id) }
    }
}

private enum SidebarListMetrics {
    static let rowInsets = EdgeInsets(top: 5, leading: 10, bottom: 5, trailing: 10)
    static let rowMinHeight: CGFloat = 44
    static let rowIconSize: CGFloat = 28
    static let rowContentSpacing: CGFloat = 12
}

private extension View {
    var sidebarListRowStyle: some View {
        self
            .listRowInsets(SidebarListMetrics.rowInsets)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    var sidebarListStyle: some View {
        self
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, SidebarListMetrics.rowMinHeight)
    }
}

private struct SkillActionRow: View {
    let item: ActionSkillItem
    let isPinned: Bool
    let canPin: Bool
    let onTogglePin: () -> Void

    @State private var isHovering = false

    private var pinHelp: String {
        if isPinned {
            return "Unpin from Caret bar"
        }
        if canPin {
            return "Pin to Caret bar (max \(PinnedActionsStore.maxPinned))"
        }
        return "Unpin another action first (max \(PinnedActionsStore.maxPinned))"
    }

    var body: some View {
        let icon = item.note?.icon ?? CaretActionIcons.icon(for: item.action.id)
        let accent = CaretNotePalette.accent(for: item.action.id)
        let subtitle = item.note?.updatedAt.formatted(date: .abbreviated, time: .shortened) ?? " "
        HStack(spacing: SidebarListMetrics.rowContentSpacing) {
            NoteIconBadge(systemName: icon, accent: accent, size: SidebarListMetrics.rowIconSize)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.note?.title ?? item.action.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .opacity(item.note == nil ? 0 : 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Group {
                if isHovering {
                    Button(action: onTogglePin) {
                        Image(systemName: isPinned ? "pin.fill" : "pin")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(isPinned ? Color.accentColor : .secondary)
                            .padding(6)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!isPinned && !canPin)
                    .help(pinHelp)
                } else if isPinned {
                    Image(systemName: "pin.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                        .accessibilityLabel("Pinned to Caret bar")
                }
            }
            .frame(width: 28, alignment: .trailing)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, minHeight: SidebarListMetrics.rowMinHeight - 10, alignment: .leading)
        .onHover { isHovering = $0 }
    }
}

private struct NoteRow: View {
    let note: CaretNote
    let showApps: Bool
    let accent: Color

    var body: some View {
        HStack(spacing: SidebarListMetrics.rowContentSpacing) {
            NoteIconBadge(systemName: note.icon, accent: accent, size: SidebarListMetrics.rowIconSize)
            VStack(alignment: .leading, spacing: 3) {
                Text(note.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(note.updatedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if showApps, !note.apps.isEmpty {
                    Text(note.apps.joined(separator: " · "))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, minHeight: SidebarListMetrics.rowMinHeight - 10, alignment: .leading)
    }
}

struct NoteIconBadge: View {
    let systemName: String
    let accent: Color
    let size: CGFloat

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(accent))
    }
}

private struct IconPickerBadge: View {
    @Binding var icon: String
    let accent: Color
    let choices: [String]
    let size: CGFloat

    @State private var showingPicker = false

    var body: some View {
        Button {
            showingPicker = true
        } label: {
            NoteIconBadge(systemName: icon, accent: accent, size: size)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(4)
                        .background(Circle().fill(Color.black.opacity(0.35)))
                        .offset(x: 4, y: 4)
                }
        }
        .buttonStyle(.plain)
        .help("Change icon")
        .popover(isPresented: $showingPicker, arrowEdge: .bottom) {
            IconPickerGrid(icon: $icon, accent: accent, choices: choices)
                .padding(12)
        }
    }
}

private struct IconPickerGrid: View {
    @Binding var icon: String
    let accent: Color
    let choices: [String]

    private let columns = [GridItem(.adaptive(minimum: 40, maximum: 44), spacing: 8)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Choose icon")
                .font(.headline)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(choices, id: \.self) { symbol in
                    Button {
                        icon = symbol
                    } label: {
                        NoteIconBadge(
                            systemName: symbol,
                            accent: icon == symbol ? accent : Color.primary.opacity(0.22),
                            size: 36
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(width: 280)
    }
}

/// Reserves space so the header does not jump when autosave status changes.
private struct SidebarCollapseToggle: View {
    @Binding var collapsed: Bool

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                collapsed.toggle()
            }
        } label: {
            Image(systemName: "sidebar.leading")
                .font(.system(size: 15, weight: .medium))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(collapsed ? "Show sidebar" : "Hide sidebar")
    }
}

private struct NoteDetailUpdatedLine: View {
    let updatedAt: Date?
    let status: NoteSaveStatus

    var body: some View {
        HStack(spacing: 6) {
            if status == .saving {
                Text("Saving…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Saving")
            } else if case .failed = status {
                Text("Not saved")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
            } else if let updatedAt {
                Text("Updated \(updatedAt.formatted(date: .complete, time: .shortened))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if status == .saved {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Saved")
                }
            }
        }
    }
}

private struct InlineTitleField: View {
    @Binding var text: String
    let placeholder: String

    var body: some View {
        TextField(placeholder, text: $text)
            .font(.title2.weight(.semibold))
            .textFieldStyle(.plain)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private enum SkillDetailActionButtonMetrics {
    static let width: CGFloat = 104
    static let height: CGFloat = 28
}

private struct SkillDetailPinButton: View {
    let isPinned: Bool
    let canPin: Bool
    let shortcutLabel: String?
    let onToggle: () -> Void

    private var helpText: String {
        if isPinned {
            return "Unpin from Caret bar (\(shortcutLabel ?? ""))"
        }
        if canPin {
            return "Pin next to Caret bar (max \(PinnedActionsStore.maxPinned))"
        }
        return "Unpin another action first (max \(PinnedActionsStore.maxPinned))"
    }

    var body: some View {
        Button(action: onToggle) {
            Group {
                if isPinned {
                    HStack(spacing: 4) {
                        Text("Pinned")
                        if let shortcutLabel {
                            Text(shortcutLabel)
                                .monospacedDigit()
                        }
                    }
                } else {
                    Text("Pin to bar")
                }
            }
            .font(.subheadline.weight(isPinned ? .semibold : .medium))
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(isPinned ? Color.accentColor : (canPin ? Color.secondary : Color.secondary.opacity(0.45)))
            .frame(width: SkillDetailActionButtonMetrics.width, height: SkillDetailActionButtonMetrics.height)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(isPinned ? 0.1 : 0.05))
            }
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isPinned && !canPin)
        .help(helpText)
        .accessibilityLabel(isPinned ? "Pinned" : "Pin to bar")
    }
}

private struct SkillDetailDeleteButton: View {
    let action: () -> Void

    var body: some View {
        Button("Delete", role: .destructive, action: action)
            .buttonStyle(.plain)
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
            .frame(width: SkillDetailActionButtonMetrics.width, height: SkillDetailActionButtonMetrics.height)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            }
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private enum NoteDetailMetrics {
    static let horizontalPadding: CGFloat = 20
    static let headerBottomSpacing: CGFloat = 14
    static let bodyTopPadding: CGFloat = 14
    static let bodyBottomPadding: CGFloat = 16
}

private struct ExpandingInstructionsEditor: View {
    let label: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)
            TextEditor(text: $text)
                .font(.body)
                .lineSpacing(3)
                .scrollContentBackground(.hidden)
                .padding(12)
                .frame(minHeight: 120)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(nsColor: .textBackgroundColor).opacity(0.45))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
                }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .layoutPriority(1)
    }
}

private enum SkillAppsFieldMode {
    case include
    case exclude
}

private struct SkillNoteEditor: View {
    @ObservedObject var model: Model
    let action: CaretAction
    let note: CaretNote?
    let accent: Color
    @Binding var title: String
    @Binding var icon: String
    @Binding var bodyText: String
    @Binding var appsText: String
    let saveStatus: NoteSaveStatus
    let iconChoices: [String]
    var appsMode: SkillAppsFieldMode = .include
    var titleIsEditable: Bool = true
    var canDelete: Bool = false
    var onDelete: (() -> Void)?

    private var isPinned: Bool { model.pinStore.isPinned(action.id) }
    private var canPin: Bool { model.canPin(action) }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 14) {
                    IconPickerBadge(icon: $icon, accent: accent, choices: iconChoices, size: 52)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .center, spacing: 8) {
                            if titleIsEditable {
                                InlineTitleField(text: $title, placeholder: "Skill name")
                            } else {
                                Text(title)
                                    .font(.title2.weight(.semibold))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            if canPin {
                                SkillDetailPinButton(
                                    isPinned: isPinned,
                                    canPin: canPin,
                                    shortcutLabel: model.shortcutLabel(for: action),
                                    onToggle: { model.togglePin(action) }
                                )
                            }
                            if canDelete, let onDelete {
                                SkillDetailDeleteButton(action: onDelete)
                            }
                        }
                        NoteDetailUpdatedLine(updatedAt: note?.updatedAt, status: saveStatus)
                    }
                }
                SkillAppsField(appsText: $appsText, mode: appsMode)
            }
            .padding(.horizontal, NoteDetailMetrics.horizontalPadding)
            .padding(.top, 16)
            .padding(.bottom, NoteDetailMetrics.headerBottomSpacing)

            Divider()
                .padding(.horizontal, NoteDetailMetrics.horizontalPadding)

            ExpandingInstructionsEditor(label: "Instructions", text: $bodyText)
                .padding(.horizontal, NoteDetailMetrics.horizontalPadding)
                .padding(.top, NoteDetailMetrics.bodyTopPadding)
                .padding(.bottom, NoteDetailMetrics.bodyBottomPadding)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SkillAppsField: View {
    @Binding var appsText: String
    var mode: SkillAppsFieldMode = .include
    @State private var showingPicker = false
    @State private var searchText = ""
    @State private var installedApps: [InstalledAppReference] = []
    @State private var appsLoadAttempted = false

    private var selectedApps: [String] {
        appsText
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private var filteredApps: [InstalledAppReference] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return installedApps }
        return installedApps.filter { $0.name.localizedCaseInsensitiveContains(needle) }
    }

    private var sectionTitle: String {
        mode == .exclude ? "Does not work in" : "Apps"
    }

    private var emptyHelp: String {
        mode == .exclude
            ? "Tab completions stay off in these apps. Everywhere else, ghost text appears when your typing matches the instructions."
            : "Apps Caret can open or focus when running this skill."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(sectionTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .textCase(.uppercase)

            VStack(alignment: .leading, spacing: 10) {
                if selectedApps.isEmpty {
                    Text(emptyHelp)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    MemoryAppChipLayout(spacing: 8) {
                        ForEach(selectedApps, id: \.self) { app in
                            MemoryAppChip(
                                title: app,
                                bundleURL: InstalledApps.reference(named: app, in: installedApps)?.bundleURL
                            ) {
                                removeApp(app)
                            }
                        }
                    }
                }

                Button {
                    searchText = ""
                    reloadInstalledApps()
                    showingPicker = true
                } label: {
                    Label("Add app reference…", systemImage: "plus.app")
                        .font(.subheadline.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .popover(isPresented: $showingPicker, arrowEdge: .bottom) {
                    AppReferencePickerPopover(
                        searchText: $searchText,
                        apps: filteredApps,
                        isLoading: !appsLoadAttempted,
                        selectedAppNames: selectedApps,
                        onToggle: toggleApp
                    )
                    .onAppear { reloadInstalledApps() }
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor).opacity(0.35))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
            }
        }
        .onAppear {
            if !appsLoadAttempted {
                reloadInstalledApps()
            }
        }
        .onChange(of: showingPicker) { _, isShowing in
            if isShowing { reloadInstalledApps() }
        }
    }

    private func reloadInstalledApps() {
        installedApps = InstalledApps.installedReferences()
        appsLoadAttempted = true
    }

    private func toggleApp(_ app: String) {
        var apps = selectedApps
        if let index = apps.firstIndex(of: app) {
            apps.remove(at: index)
        } else {
            apps.append(app)
            apps.sort { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        }
        appsText = apps.joined(separator: ", ")
    }

    private func removeApp(_ app: String) {
        var apps = selectedApps
        apps.removeAll { $0 == app }
        appsText = apps.joined(separator: ", ")
    }
}

private struct AppReferencePickerPopover: View {
    @Binding var searchText: String
    let apps: [InstalledAppReference]
    let isLoading: Bool
    let selectedAppNames: [String]
    let onToggle: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Search apps", text: $searchText)
                .textFieldStyle(.roundedBorder)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if apps.isEmpty {
                        Text(isLoading ? "Loading applications…" : "No applications found.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 12)
                    } else {
                        ForEach(apps) { app in
                            Button {
                                onToggle(app.name)
                            } label: {
                                HStack(spacing: 10) {
                                    AppReferenceIcon(bundleURL: app.bundleURL, size: 22)
                                    Text(app.name)
                                        .lineLimit(1)
                                    Spacer(minLength: 8)
                                    if selectedAppNames.contains(app.name) {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(Color.accentColor)
                                    }
                                }
                                .padding(.horizontal, 6)
                                .padding(.vertical, 7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(height: 260)
        }
        .padding(12)
        .frame(width: 320)
    }
}

private struct MemoryAppChip: View {
    let title: String
    let bundleURL: URL?
    let onRemove: () -> Void

    var body: some View {
        Button(action: onRemove) {
            HStack(spacing: 6) {
                AppReferenceIcon(bundleURL: bundleURL, size: 16)
                Text(title)
                    .font(.caption.weight(.medium))
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.primary.opacity(0.08)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help("Remove \(title)")
    }
}

private struct MemoryAppChipLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return CGSize(width: width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}

private struct MemoryNoteEditor: View {
    let note: CaretNote
    let accent: Color
    @Binding var title: String
    @Binding var icon: String
    @Binding var bodyText: String
    let saveStatus: NoteSaveStatus
    let iconChoices: [String]
    let onDelete: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 14) {
                    IconPickerBadge(icon: $icon, accent: accent, choices: iconChoices, size: 52)
                    VStack(alignment: .leading, spacing: 4) {
                        InlineTitleField(text: $title, placeholder: "Memory")
                        NoteDetailUpdatedLine(updatedAt: note.updatedAt, status: saveStatus)
                    }
                    Spacer(minLength: 8)
                    Button("Delete", role: .destructive, action: onDelete)
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, NoteDetailMetrics.horizontalPadding)
            .padding(.top, 16)
            .padding(.bottom, NoteDetailMetrics.headerBottomSpacing)

            Divider()
                .padding(.horizontal, NoteDetailMetrics.horizontalPadding)

            ExpandingInstructionsEditor(label: "About you", text: $bodyText)
                .padding(.horizontal, NoteDetailMetrics.horizontalPadding)
                .padding(.top, NoteDetailMetrics.bodyTopPadding)
                .padding(.bottom, NoteDetailMetrics.bodyBottomPadding)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
