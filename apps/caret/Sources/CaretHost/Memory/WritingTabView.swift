import CaretHostCore
import SwiftUI

/// What Caret knows' Writing tab (brief items 4, 6 and 7), in the window's own parts: groups under small heads, rows on
/// hairlines, no cards, choices in pop-ups, buttons in the window's two kinds.
///
/// About you first, since it shapes every suggestion; then instructions for one app or site; then the accept keys;
/// then the apps Caret is off in, shaped as the Sites tab's list. Saving is explicit (Save, ⌘S) because the settings
/// file is written and every observer told on each change. Motion: an entry or an app added or removed fades over
/// 120 ms, as a site's row does; editors open and close with no motion, since each follows a click the user is
/// watching. Under Reduce Motion nothing moves (`animated` is false).
struct WritingTabView: View {
    var state: WritingPage.State
    var animated = true
    var send: (MemoryAction) -> Void

    private var fade: Animation? { animated ? Motion.curve(Motion.easeOut, 0.12) : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            about
            entries
            keys
            appsOff
        }
        .padding(.top, 6)
        .probed("writing")
    }

    // MARK: - About you

    private var about: some View {
        VStack(alignment: .leading, spacing: 8) {
            GroupHead(text: WritingPageCopy.aboutHead)
                .padding(.top, 14)
            Text(WritingPageCopy.aboutIntro)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
            InstructionEditor(
                label: WritingPageCopy.aboutHead, text: state.aboutDraft, placeholder: WritingPageCopy.aboutPlaceholder, height: 132,
                onChange: { send(.aboutText($0)) }
            )
            HStack(alignment: .center, spacing: 8) {
                Text(state.problem ?? WritingPage.count(state.aboutDraft))
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: state.problem == nil ? Tokens.ink2 : Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(WritingPageCopy.importCotypist) { send(.importCotypist) }
                    .buttonStyle(QuietButtonStyle())
                Button(WritingPageCopy.save) { send(.saveAbout) }
                    .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    .keyboardShortcut("s", modifiers: .command)
                    .disabled(!state.aboutChanged)
            }
            .padding(.bottom, 10)
            Hairline()
        }
        .probed("writing.about")
    }

    // MARK: - One app or site

    private var entries: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: WritingPageCopy.entriesHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            Text(state.entries.isEmpty && state.editing == nil ? WritingPageCopy.entriesEmpty : WritingPageCopy.entriesIntro)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 6)
            Hairline()
            ForEach(state.entries + state.addable.filter { $0.id == state.editing?.id }) { entry in
                entryRow(entry)
                    .transition(.opacity.animation(fade))
                Hairline()
            }
            let adds = state.addable.filter { $0.id != state.editing?.id }
            if !adds.isEmpty {
                HStack(spacing: 8) {
                    ForEach(adds) { entry in
                        Button(WritingPageCopy.add(entry.name)) { send(.editEntry(entry.id)) }
                            .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    }
                }
                .padding(.top, 10)
            }
        }
        .probed("writing.entries")
    }

    @ViewBuilder
    private func entryRow(_ entry: WritingPage.Entry) -> some View {
        if let editing = state.editing, editing.id == entry.id {
            VStack(alignment: .leading, spacing: 8) {
                Text(entry.name)
                    .font(Tokens.Font.row)
                    .foregroundStyle(Color(token: Tokens.ink))
                InstructionEditor(label: "Instructions for \(entry.name)", text: editing.draft, placeholder: "", height: 84, autofocus: true,
                                  onChange: { send(.entryText($0)) })
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    Button(WritingPageCopy.cancel) { send(.cancelEntry) }
                        .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .keyboardShortcut(.cancelAction)
                    Button(WritingPageCopy.save) { send(.saveEntry) }
                        .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                        .keyboardShortcut("s", modifiers: .command)
                }
            }
            .padding(.vertical, 10)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name)
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: Tokens.ink))
                    Text(entry.text)
                        .font(Tokens.Font.chromeSmall)
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button(WritingPageCopy.edit) { send(.editEntry(entry.id)) }
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityLabel("Edit instructions for \(entry.name)")
                Button(WritingPageCopy.remove) { send(.removeEntry(entry.id)) }
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityLabel("Remove instructions for \(entry.name)")
            }
            .padding(.vertical, 10)
            .accessibilityElement(children: .contain)
        }
    }

    // MARK: - Accept keys

    private var keys: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: WritingPageCopy.keysHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            HStack(alignment: .top, spacing: 18) {
                Text(GhostKeysCopy.detail(state.keys))
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                PopUpChoice(
                    label: WritingPageCopy.keysHead,
                    items: GhostKeys.allCases.map { .init(value: $0, title: GhostKeysCopy.choice($0), enabled: true) },
                    current: state.keys, width: RuleRowView.columnWidth, choose: { if $0 != state.keys { send(.keys($0)) } }
                )
                .frame(width: RuleRowView.columnWidth, alignment: .leading)
            }
            .padding(.vertical, 12)
            .accessibilityElement(children: .contain)
            Hairline()
        }
        .probed("writing.keys")
    }

    // MARK: - Apps Caret is off in

    private var appsOff: some View {
        VStack(alignment: .leading, spacing: 0) {
            GroupHead(text: WritingPageCopy.offHead)
                .padding(.top, 20)
                .padding(.bottom, 2)
            if let here = state.hereApp, !state.appsOff.contains(where: { $0.bundleID == here.bundleID }) {
                HStack(alignment: .center, spacing: 14) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(WritingPageCopy.hereApp)
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink2))
                        Text(here.name)
                            .font(Tokens.Font.row)
                            .foregroundStyle(Color(token: Tokens.ink))
                    }
                    Spacer(minLength: 0)
                    Button(WritingPageCopy.turnOff) { send(.appOff(here.bundleID)) }
                        .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                        .accessibilityLabel("Turn Caret off in \(here.name)")
                }
                .padding(.vertical, 12)
                .accessibilityElement(children: .contain)
                Hairline()
            }
            if state.appsOff.isEmpty {
                Text(WritingPageCopy.offEmpty)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.vertical, 9)
                Hairline()
            }
            ForEach(state.appsOff) { app in
                HStack(alignment: .center, spacing: 14) {
                    Text(app.name)
                        .font(Tokens.Font.row)
                        .foregroundStyle(Color(token: Tokens.ink))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(WritingPageCopy.turnOn) { send(.appOn(app.bundleID)) }
                        .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                        .accessibilityLabel("Turn Caret back on in \(app.name)")
                }
                .padding(.vertical, 10)
                .transition(.opacity.animation(fade))
                Hairline()
            }
        }
        .probed("writing.off")
    }
}

/// A few lines of the user's own words: the window's field look (text background, keycap border), a placeholder
/// while empty, and plain text off screen, where a TextEditor cannot draw.
private struct InstructionEditor: View {
    var label: String
    var text: String
    var placeholder: String
    var height: CGFloat
    var autofocus = false
    var onChange: (String) -> Void

    @Environment(\.rendersOffscreen) private var offscreen
    @FocusState private var focused: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        ZStack(alignment: .topLeading) {
            if offscreen {
                Text(text)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                TextEditor(text: Binding(get: { text }, set: onChange))
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 3)
                    .padding(.vertical, 5)
                    .focused($focused)
                    .accessibilityLabel(label)
                    .onAppear { if autofocus { DispatchQueue.main.async { focused = true } } }
            }
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 7)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .font(.system(size: 13))
        .lineSpacing(2)
        .foregroundStyle(Color(token: Tokens.ink))
        .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor), in: shape)
        .overlay { shape.strokeBorder(Color(token: focused ? Tokens.carrot : Tokens.keycapBorder), lineWidth: 1) }
        .clipShape(shape)
    }
}
