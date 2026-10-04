import AppKit
import SwiftUI

// The parts Caret's own windows (What Caret knows, onboarding) and the desk share, v3 part 2
// (DIRECTION.md 5.6, 5.8, 5.9): text tabs with a Carrot underline, the ink button, quiet text
// buttons, a pop-up button, group heads and hairlines. No washes, no cards: Carrot is the figure's,
// plus the one mark that says "this one" (the current tab, the current dot, a row that needs you).

/// A hairline in the window's rule color.
struct Hairline: View {
    var body: some View {
        Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1)
    }
}

/// A group's name over its rows: Chrome 12 semibold, Ink 2.
struct GroupHead: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Color(token: Tokens.ink2))
            .accessibilityAddTraits(.isHeader)
    }
}

/// Tabs as words: the current one in Ink with a 2 pt Carrot underline, the others in Ink 2, all on
/// one hairline. A tab change is a choice, not a journey: the underline jumps (no slide).
struct TextTabs<Tab: Hashable>: View {
    var tabs: [(Tab, String)]
    var current: Tab
    var choose: (Tab) -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 22) {
            ForEach(tabs, id: \.0) { tab, title in
                let chosen = tab == current
                Button { choose(tab) } label: {
                    VStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 13, weight: chosen ? .medium : .regular))
                            .foregroundStyle(Color(token: chosen ? Tokens.ink : Tokens.ink2))
                        Rectangle().fill(Color(token: chosen ? Tokens.carrot : .clear)).frame(height: 2)
                    }
                    .fixedSize()
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
            }
            Spacer(minLength: 0)
        }
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// Buttons in Caret's windows and on the desk. `ink`: the one primary action (Continue, Save,
/// Keep my text), Ink fill. `key`: secondary, key-styled (Undo, Show, Take over, Reload). Both 28
/// tall, or 22 `small` in a row. A press scales to 0.97 at once and springs back in 120 ms; under
/// Reduce Motion it does not move (the press still shows in the fill).
struct WindowButtonStyle: ButtonStyle {
    enum Kind { case ink, key }
    var kind: Kind
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        WindowButtonBody(label: configuration.label, pressed: configuration.isPressed, kind: kind, small: small)
    }
}

/// The button's drawing, as a view so it reads the button's environment (enabled, Reduce Motion)
/// wherever the style is used, including from another style (`OnboardingButtonStyle`).
struct WindowButtonBody<Label: View>: View {
    var label: Label
    var pressed: Bool
    var kind: WindowButtonStyle.Kind
    var small: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: small ? 6 : 7, style: .continuous)
        label
            .font(.system(size: small ? 12 : 13, weight: .medium))
            .foregroundStyle(Color(token: kind == .ink ? Tokens.onInk : Tokens.ink))
            .padding(.horizontal, small ? 9 : 14)
            .frame(height: small ? 22 : 28)
            .background {
                switch kind {
                case .ink: shape.fill(Color(token: Tokens.inkFill)).opacity(pressed ? 0.85 : 1)
                case .key: shape.fill(Color(token: pressed ? Tokens.rule : Tokens.keyFill))
                }
            }
            .overlay { if kind == .key { shape.strokeBorder(Color(token: Tokens.keyEdge), lineWidth: 1) } }
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.4)
            .scaleEffect(pressed && !reduceMotion ? 0.97 : 1)
            .animation(Motion.curve(Motion.easeOut, 0.12), value: pressed)
            .fixedSize()
    }
}

/// A quiet text button: Ink 2, Ink while pressed. Back, Show in Finder, "What Caret knows".
struct QuietButtonStyle: ButtonStyle {
    var size: CGFloat = 12
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size))
            .foregroundStyle(Color(token: configuration.isPressed ? Tokens.ink : Tokens.ink2))
            .frame(minHeight: 22)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.4)
            .fixedSize()
    }
}

/// A pop-up button: the current choice and a chevron in a key-styled box, 24 tall. Pressing it
/// (click, Space, or VoiceOver's press) opens a real menu under it, with the current item checked
/// and choices that can't be made shown disabled. Drawn in SwiftUI so off-screen renders show it;
/// the menu itself is AppKit's, so its keys and VoiceOver are the system's.
struct PopUpChoice<Value: Hashable>: View {
    struct Item {
        var value: Value
        var title: String
        var enabled: Bool
    }

    /// Read by VoiceOver before the value: "Write where you are".
    var label: String
    var items: [Item]
    var current: Value
    var width: CGFloat = 168
    var choose: (Value) -> Void

    @State private var frame: CGRect = .zero

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        Button {
            open()
        } label: {
            HStack(spacing: 6) {
                Text(items.first { $0.value == current }?.title ?? "")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink2))
            }
            .padding(.horizontal, 9)
            .frame(width: width, height: 24)
            .background(shape.fill(Color(token: Tokens.keyFill)))
            .overlay(shape.strokeBorder(Color(token: Tokens.keyEdge), lineWidth: 1))
            .contentShape(shape)
        }
        .buttonStyle(PressStyle())
        .background(GeometryReader { g in Color.clear.onAppear { frame = g.frame(in: .global) }.onChange(of: g.frame(in: .global)) { _, f in frame = f } })
        .accessibilityLabel(label)
        .accessibilityValue(items.first { $0.value == current }?.title ?? "")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens a menu of choices")
    }

    /// The menu, its current item over the button as macOS pop-up buttons place it.
    private func open() {
        guard let view = NSApp.keyWindow?.contentView ?? NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil })?.contentView else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        var currentItem: NSMenuItem?
        for item in items {
            let m = PopUpMenuItem(title: item.title, action: #selector(PopUpMenuItem.picked), keyEquivalent: "")
            m.target = m
            m.isEnabled = item.enabled
            m.state = item.value == current ? .on : .off
            let value = item.value
            m.onPick = { choose(value) }
            if item.value == current { currentItem = m }
            menu.addItem(m)
        }
        // SwiftUI's global space is the window's content, top-left origin. The current item's
        // top-left goes at the button's, its title over the button's (the menu's checkmark column
        // is about 10 pt), as an AppKit pop-up button opens.
        let x = frame.minX - 10
        let origin = view.isFlipped ? NSPoint(x: x, y: frame.minY) : NSPoint(x: x, y: view.bounds.height - frame.minY)
        menu.popUp(positioning: currentItem, at: origin, in: view)
    }
}

/// A menu item that calls back with its own closure, so a pop-up needs no responder chain.
final class PopUpMenuItem: NSMenuItem {
    var onPick: (() -> Void)?
    @objc func picked() { onPick?() }
}

/// A bordered block on the window or the desk: hairline, radius 10, no fill of its own.
struct Block<Content: View>: View {
    var radius: CGFloat = 10
    @ViewBuilder var content: Content

    var body: some View {
        content
            .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
    }
}

/// The 2 pt Carrot edge at a row's left: the row needs the user. Never a wash.
struct NeedsYouEdge: View {
    var body: some View {
        Rectangle().fill(Color(token: Tokens.carrot)).frame(width: 2)
    }
}
