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
/// (400 ms, the try-it field's wash), a forgotten row fades out in 120 ms, and a row's controls
/// fade in over 120 ms when the pointer or keyboard focus reaches it. Switching tabs and picking a
/// rule do not animate: they are choices, not journeys. Reduce Motion keeps the fades and the
/// wash and drops the height change.
struct MemoryView: View {
    enum Tab: String, CaseIterable, Codable { case memory, permissions }

    /// Tall enough for the permissions table and its footer without scrolling, as the gallery's
    /// entries have them (`MemoryHostTests` checks the footer and the table against this size).
    static let size = CGSize(width: 600, height: 780)
    static let title = "What Caret knows"
    /// True today: entries sit in the helper's store on this Mac, and a fill's candidate values go
    /// to the cloud model that picks them (the onboarding privacy line says the same).
    static let subtitle = "Saved on this Mac. When Caret works out what to fill, the values it might use go to its cloud model."
    static let offline = "Caret can't reach its memory right now. This is what it knew last, and nothing here can change until it's back."
    static let reading = "Reading Caret's memory"
    static let permissionsIntro = "What Caret may do on its own, by kind of action."

    var state: MemoryBook.State
    var tab: Tab
    var character: FigureCharacter
    var animated = true
    var now = Date()
    /// A row drawn as if the pointer were on it, for renders (hover does not exist off screen).
    var revealedRow: String?
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
            .probed("scroll")
            if tab == .permissions { permissionsFooter }
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .background(Color(token: Tokens.window))
        .clipped()
        .coordinateSpace(.named(LayoutProbe.space))
    }

    /// The limit no setting moves, under the table and outside the scroll, so it is always in the
    /// window however long the table grows.
    private var permissionsFooter: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
            Text(MemoryPage.ceiling)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 12)
                .probed("footer")
        }
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
                                animated: animated, forceReveal: revealedRow == row.id, send: send
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
            let exceptions = MemoryPage.exceptions(state)
            OnboardingCard {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 { Divider14() }
                        RuleRowView(row: row) { send(.setRule(row.action, $0)) }
                        // Under the two write rows: the skills that skip their Ask first, by name.
                        if row.action == .writeElsewhere, !exceptions.isEmpty {
                            ExceptionsView(exceptions: exceptions, animated: animated) { send(.control($0, .backOnTab, typed: false)) }
                                .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
                        }
                    }
                }
            }
            .probed("table")
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
    var forceReveal = false
    var send: (MemoryAction) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var wash: Double = 0
    @State private var hovering = false
    @FocusState private var focused: MemoryPage.Control?

    /// Edit, Pause and Forget show on the row under the pointer or holding keyboard focus, and on a
    /// row that waits for the user (a Forget to confirm, a refusal to retry). Hidden, they keep their
    /// place in the key loop, so keyboard focus reaching one shows them; VoiceOver gets the same
    /// controls as the row's own actions, whatever is drawn. A trailing menu was the other choice;
    /// it puts every action two clicks away, and Pause is the one people use most.
    private var revealed: Bool { forceReveal || hovering || focused != nil || confirming || row.problem != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(token: row.status == .paused ? Tokens.secondary : Tokens.ink))
                        .fixedSize(horizontal: false, vertical: true)
                    if confirming {
                        Text(MemoryPage.forgetQuestion(row.kind))
                            .font(.system(size: 12))
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    } else if !row.secondary.isEmpty {
                        Text(row.secondary)
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
                // The row the controls belong to: a faint fill (the hairline's own tone), so the
                // buttons never seem to float free of their row.
                Rectangle().fill(Color(token: Tokens.border)).opacity(revealed && !confirming ? 0.6 : 0)
                    .animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil, value: revealed)
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
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .modifier(RowActions(row: row, enabled: editor == nil && !confirming, send: send))
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

    @ViewBuilder
    private var buttons: some View {
        HStack(spacing: 6) {
            if confirming {
                Button("Keep") { send(.keep) }.buttonStyle(RowButtonStyle(primary: false))
                Button("Forget") { send(.confirmForget) }.buttonStyle(RowButtonStyle(primary: true))
            } else {
                ForEach(row.controls, id: \.self) { control in
                    Button(row.typed && control == .forget ? "Remove" : MemoryPage.controlTitle(control, kind: row.kind)) {
                        send(.control(row.id, control, typed: row.typed))
                    }
                    .buttonStyle(RowButtonStyle(primary: false))
                    .disabled(row.busy)
                    .focused($focused, equals: control)
                }
            }
        }
        // Opacity only, so it plays under Reduce Motion too; leaving is as quick as arriving.
        .opacity(revealed ? 1 : 0)
        .animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil, value: revealed)
    }
}

/// A row's controls as named accessibility actions, so VoiceOver offers Edit, Pause and Forget on
/// the row itself, never depending on whether the buttons are drawn.
private struct RowActions: ViewModifier {
    var row: MemoryPage.Row
    var enabled: Bool
    var send: (MemoryAction) -> Void

    func body(content: Content) -> some View {
        row.controls.reduce(AnyView(content)) { view, control in
            guard enabled, !row.busy else { return view }
            let title = row.typed && control == .forget ? "Remove" : MemoryPage.controlTitle(control, kind: row.kind)
            return AnyView(view.accessibilityAction(named: Text(title)) { send(.control(row.id, control, typed: row.typed)) })
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

/// The skills that run on their own, as exceptions to the write rows above: each by name and
/// trigger, with one button that puts it back on Tab. Set in from the rows' text, on the hover row's
/// tone with a Carrot edge, so it reads as part of those rules and not a rule of its own. Nothing moves: a skill
/// that goes back on Tab leaves the list with the same 120 ms fade as a forgotten memory row.
struct ExceptionsView: View {
    var exceptions: [MemoryPage.Exception]
    var animated = true
    var backOnTab: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(MemoryPage.exceptionsTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .accessibilityAddTraits(.isHeader)
                Text(MemoryPage.exceptionsDetail)
                    .font(.system(size: 11))
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, 6)
            ForEach(exceptions) { e in
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(e.name)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                        Text(e.when)
                            .font(.system(size: 11))
                            .foregroundStyle(Color(token: Tokens.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                        if let problem = e.problem {
                            Text(problem)
                                .font(.system(size: 11))
                                .foregroundStyle(Color(token: Tokens.ink))
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.top, 2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(MemoryPage.controlTitle(.backOnTab)) { backOnTab(e.id) }
                        .buttonStyle(RowButtonStyle(primary: false))
                        .disabled(e.busy)
                        // The visible words first, so voice control finds the button by them.
                        .accessibilityLabel("\(MemoryPage.controlTitle(.backOnTab)): \(e.name)")
                }
                .padding(.vertical, 5)
                .accessibilityElement(children: .contain)
                .transition(.opacity.animation(animated ? Motion.curve(Motion.easeOut, 0.12) : nil))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(alignment: .leading) {
            // The hover row's neutral tone, with the Carrot edge the list uses for what needs the
            // user's eye: noted, not alarming.
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(token: Tokens.border)).opacity(0.6)
                Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2).padding(.vertical, 8)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 14)
        .padding(.bottom, 12)
        .probed("exceptions")
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
