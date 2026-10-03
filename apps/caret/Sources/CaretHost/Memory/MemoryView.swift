import CaretHostCore
import SwiftUI

/// What a click or key in the memory window asks for. `MemoryController` turns each into a
/// `MemoryBook` call.
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
}

/// "What Caret knows": the four kinds of memory, and what Caret may do per kind of action. Caret's
/// own window, painted like onboarding (Window ground, white cards), drawn from
/// `MemoryBook.State` through `MemoryPage`.
///
/// Motion, all of it state indication: an edit opens with a 160 ms ease-out height and fade and
/// closes at once (Return and Esc close it), a confirmed change washes its row in Carrot once
/// (400 ms, the try-it field's wash), a forgotten row fades out in 120 ms. Switching tabs and
/// picking a rule do not animate: they are choices, not journeys. Reduce Motion keeps the fades
/// and the wash and drops the height change.
struct MemoryView: View {
    enum Tab: String, CaseIterable, Codable { case memory, permissions }

    static let size = CGSize(width: 600, height: 720)
    static let title = "What Caret knows"
    static let subtitle = "Everything here stays on this Mac. Caret reads it each time it offers something, so a change counts at once."
    static let offline = "Caret can't reach its memory right now. This is what it knew last, and nothing here can change until it's back."
    static let reading = "Reading Caret's memory"
    static let permissionsIntro = "What Caret may do on its own, by kind of action."

    var state: MemoryBook.State
    var tab: Tab
    var character: FigureCharacter
    var animated = true
    var now = Date()
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
            header
                .padding(.horizontal, 28)
                .padding(.top, 30)
            TabPicker(tab: tab) { send(.tab($0)) }
                .padding(.horizontal, 28)
                .padding(.top, 16)
                .padding(.bottom, 12)
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
            ScrollingColumn {
                VStack(alignment: .leading, spacing: 0) {
                    notices
                    switch tab {
                    case .memory: memory
                    case .permissions: permissions
                    }
                }
                .padding(.horizontal, 28)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(Color(token: Tokens.window))
        .clipped()
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            // Still, on the title's line, looking down at the list: it is what the figure knows.
            FigureView(character: character, state: .noticed, facing: .right, height: 16, animated: false, gaze: CGVector(dx: 0.3, dy: 0.8))
                .padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .accessibilityAddTraits(.isHeader)
                Text(tab == .memory ? Self.subtitle : Self.permissionsIntro)
                    .font(.system(size: 13))
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var notices: some View {
        if !state.connected {
            Notice(text: Self.offline)
        } else if let problem = state.listProblem {
            Notice(text: problem, action: ("Try again", { send(.retry) }))
        } else if !state.loaded, state.entries.isEmpty {
            Notice(text: Self.reading)
        }
    }

    // MARK: - Memory

    private var memory: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(MemoryPage.sections(state, now: now, calendar: calendar, locale: locale)) { section in
                SectionLabel(text: section.title).padding(.top, 10).padding(.bottom, 6)
                OnboardingCard {
                    VStack(spacing: 0) {
                        if section.rows.isEmpty {
                            Text(section.empty)
                                .font(.system(size: 12))
                                .foregroundStyle(Color(token: Tokens.secondary))
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                        }
                        ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider14() }
                            MemoryRowView(
                                row: row, editor: state.editor?.entryId == row.id ? state.editor : nil,
                                confirming: state.confirmingForget == row.id, washed: state.changed == row.id,
                                animated: animated, send: send
                            )
                            .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                        }
                    }
                    // A highlighted row's wash stays inside the card's corners.
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .padding(.bottom, 8)
            }
            if state.unreadable > 0 {
                Text(state.unreadable == 1 ? "1 entry needs a newer version of Caret to show." : "\(state.unreadable) entries need a newer version of Caret to show.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .padding(.top, 4)
            }
        }
    }

    // MARK: - Permissions

    private var permissions: some View {
        VStack(alignment: .leading, spacing: 0) {
            let rows = MemoryPage.rules(state, now: now, calendar: calendar, locale: locale)
            OnboardingCard {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider14() }
                        RuleRowView(row: row) { send(.setRule(row.action, $0)) }
                    }
                }
            }
            .padding(.top, 10)
            Text(MemoryPage.ceiling)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .padding(.top, 10)
        }
    }
}

/// A hairline between rows, inset to the rows' text.
private struct Divider14: View {
    var body: some View {
        Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.leading, 14)
    }
}

/// A line above the lists when they cannot be trusted as current: offline, unreadable, or loading.
private struct Notice: View {
    var text: String
    var action: (String, () -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action {
                Button(action.0, action: action.1).buttonStyle(RowButtonStyle(primary: true))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Color(token: Tokens.carrotWash), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }
}

/// Memory and Permissions: the onboarding level picker's look, two segments.
private struct TabPicker: View {
    var tab: MemoryView.Tab
    var choose: (MemoryView.Tab) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(MemoryView.Tab.allCases, id: \.self) { option in
                let chosen = option == tab
                Button { choose(option) } label: {
                    Text(option == .memory ? "Memory" : "Permissions")
                        .font(.system(size: 13, weight: chosen ? .semibold : .regular))
                        .foregroundStyle(Color(token: Tokens.ink))
                        .frame(maxWidth: .infinity)
                        .frame(height: 26)
                        .background {
                            if chosen {
                                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(token: Tokens.card))
                                RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(2)
        .background(Color(token: Tokens.border), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .frame(width: 260)
    }
}

// MARK: - A memory row

struct MemoryRowView: View {
    var row: MemoryPage.Row
    var editor: MemoryBook.Editor?
    var confirming: Bool
    var washed: Bool
    var animated: Bool
    var send: (MemoryAction) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var wash: Double = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.says)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(token: row.status == .paused ? Tokens.secondary : Tokens.ink))
                        .fixedSize(horizontal: false, vertical: true)
                    if confirming {
                        Text(MemoryPage.forgetQuestion(row.kind))
                            .font(.system(size: 12))
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let meta {
                        Text(meta)
                            .font(.system(size: 11))
                            .foregroundStyle(Color(token: Tokens.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let problem = row.problem, editor == nil {
                        Text(problem)
                            .font(.system(size: 11))
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if editor == nil { buttons }
            }
            if let editor {
                EditorView(editor: editor, send: send)
                    .padding(.top, 10)
                    .transition(animated && !reduceMotion ? .opacity.combined(with: .offset(y: -4)) : .opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(alignment: .leading) {
            ZStack(alignment: .leading) {
                if confirming {
                    // Waiting for the user: the Carrot wash and 2 pt edge (SURFACES.md 4).
                    Rectangle().fill(Color(token: Tokens.carrotWash))
                    Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2).padding(.vertical, 6)
                }
                Rectangle().fill(Color(token: Tokens.carrotWash)).opacity(wash)
            }
        }
        // Opening animates (a click on Edit); closing is instant, since Return and Esc close it and
        // a key's result should not wait on motion. Reduce Motion drops the height change too.
        .animation(animated && !reduceMotion && editor != nil ? Motion.curve(Motion.easeOut, 0.16) : nil, value: editor == nil)
        .accessibilityElement(children: .contain)
        .onChange(of: washed) { _, now in
            guard now else { return }
            // A color change, not movement: it plays under Reduce Motion too.
            if animated {
                wash = 1
                withAnimation(.linear(duration: 0.4)) { wash = 0 }
            }
            send(.washed)
        }
    }

    /// "Paused · Last seen today, 2:14 PM, in Mail".
    private var meta: String? {
        let parts = [MemoryPage.statusText(row.status), row.detail].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var buttons: some View {
        HStack(spacing: 6) {
            if confirming {
                Button("Keep") { send(.keep) }.buttonStyle(RowButtonStyle(primary: false))
                Button("Forget") { send(.confirmForget) }.buttonStyle(RowButtonStyle(primary: true))
            } else {
                ForEach(row.controls, id: \.self) { control in
                    Button(row.typed && control == .forget ? "Remove" : MemoryPage.controlTitle(control)) {
                        send(.control(row.id, control, typed: row.typed))
                    }
                    .buttonStyle(RowButtonStyle(primary: false))
                    .disabled(row.busy)
                }
            }
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
                    .font(.system(size: 11))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 84)
                    .accessibilityHidden(editor.problem == nil)
                Button("Cancel") { send(.cancel) }.buttonStyle(RowButtonStyle(primary: false))
                Button(editor.saving ? "Saving" : "Save") { send(.save) }
                    .buttonStyle(RowButtonStyle(primary: true))
                    .disabled(editor.saving)
            }
        }
        .onExitCommand { send(.cancel) }
    }
}

// MARK: - A permission row

/// One action type: what it covers, what its rule means, its last uses, and the rule track.
struct RuleRowView: View {
    var row: MemoryPage.RuleRow
    var choose: (HelperMemory.Rule) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                Text(row.example)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.secondary))
                uses.padding(.top, 3)
                if let problem = row.problem {
                    Text(problem)
                        .font(.system(size: 11))
                        .foregroundStyle(Color(token: Tokens.ink))
                        .padding(.top, 2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            // The rule and what it means, in one column on every row.
            VStack(alignment: .leading, spacing: 5) {
                RuleTrack(row: row, choose: choose)
                Text(row.ruleDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 4)
            }
            .frame(width: RuleTrack.width, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var uses: some View {
        if row.uses.isEmpty {
            Text(MemoryPage.usesNone)
                .font(.system(size: 11))
                .foregroundStyle(Color(token: Tokens.secondary))
        } else {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(row.uses.enumerated()), id: \.offset) { _, use in
                    Text("\(use.says) · \(use.when)")
                        .font(.system(size: 11))
                        .foregroundStyle(Color(token: Tokens.secondary))
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Last uses: " + row.uses.map(\.says).joined(separator: ". "))
        }
    }
}

/// The four rules as one track, least autonomous on the left, in the same column on every row,
/// so the list reads as a table of how far each kind of action may go. The current rule sits on
/// the card; rules this kind of action may take are plain and pressable; rules it can never take
/// stay on the track, faded, so the ceiling is visible where it applies.
struct RuleTrack: View {
    var row: MemoryPage.RuleRow
    var choose: (HelperMemory.Rule) -> Void

    static let order: [HelperMemory.Rule] = [.handoff, .ask, .actIfApproved, .act]
    /// Each segment's width, room for its label in semibold, so the chosen one never shifts the
    /// track and every row's track lines up.
    static func segmentWidth(_ rule: HelperMemory.Rule) -> CGFloat {
        switch rule {
        case .handoff: return 62
        case .ask: return 64
        case .actIfApproved: return 98
        case .act: return 38
        }
    }
    static var width: CGFloat { order.map(segmentWidth).reduce(0, +) + CGFloat(order.count - 1) * 2 + 4 }

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Self.order, id: \.self) { rule in
                segment(rule)
            }
        }
        .padding(2)
        .background(Color(token: Tokens.border), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .opacity(row.busy ? 0.6 : 1)
        .frame(width: Self.width)
    }

    @ViewBuilder
    private func segment(_ rule: HelperMemory.Rule) -> some View {
        let chosen = rule == row.rule
        let reachable = chosen || row.choices.contains(rule)
        let label = Text(MemoryPage.ruleTitle(rule))
            .font(.system(size: 11, weight: chosen ? .semibold : .regular))
            .foregroundStyle(Color(token: reachable ? Tokens.ink : Tokens.secondary))
            .opacity(reachable ? 1 : 0.55)
            .lineLimit(1)
            .frame(width: Self.segmentWidth(rule), height: 22)
            .background {
                if chosen {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(token: Tokens.card))
                    RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
                }
            }
            .contentShape(Rectangle())
        if reachable && !chosen && !row.busy {
            Button { choose(rule) } label: { label }
                .buttonStyle(PressStyle())
                .accessibilityLabel("\(row.title): \(MemoryPage.ruleTitle(rule))")
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chosen ? "\(row.title): \(MemoryPage.ruleTitle(rule)), current" : "\(MemoryPage.ruleTitle(rule)), not allowed here")
                .accessibilityAddTraits(chosen ? .isSelected : [])
        }
    }
}
