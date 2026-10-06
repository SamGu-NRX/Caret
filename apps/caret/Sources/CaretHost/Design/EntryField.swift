import AppKit
import SwiftUI

/// True in off-screen renders (`Gallery.png`). SwiftUI's ImageRenderer draws AppKit-backed views,
/// a text field or a scroll view, as placeholders, so views that hold them draw a still stand-in
/// instead: the same chrome with the text as `Text`, and the content unscrolled and clipped.
private struct OffscreenKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var rendersOffscreen: Bool {
        get { self[OffscreenKey.self] }
        set { self[OffscreenKey.self] = newValue }
    }
}

/// A text field in Caret's own windows: 26 tall, radius 5, the text background, a hairline border,
/// and a 2 pt Carrot ring while it has focus (the same field the try-it screen draws). On screen it
/// is a real `TextField`, so paste, input methods and VoiceOver editing work as everywhere on the
/// Mac; off screen it is drawn.
struct EntryField: View {
    /// The visible label's words, read by VoiceOver as the field's name.
    var title: String
    var text: String
    var placeholder = ""
    /// Takes focus when it appears.
    var autofocus = false
    /// Off screen only: draw the focus ring (a render has no focus to read).
    var showsFocus = false
    /// Becoming true moves focus here: the field a problem is about.
    var focusNow = false
    /// Each change moves focus here (the menu's Ask Caret opens the list with the field focused).
    var focusToken = 0
    /// False while what it holds is being saved: later typing would be lost.
    var enabled = true
    /// A secret (onboarding's Jev key): dots on screen and off, and no copy or cut.
    var secure = false
    var onChange: (String) -> Void
    var onSubmit: () -> Void = {}

    @Environment(\.rendersOffscreen) private var offscreen
    @FocusState private var focused: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        content
            .font(.system(size: 13))
            .padding(.horizontal, 7)
            .frame(maxWidth: .infinity, minHeight: 26, maxHeight: 26, alignment: .leading)
            .background(Color(nsColor: .textBackgroundColor), in: shape)
            .overlay { shape.strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1) }
            .overlay {
                if offscreen ? showsFocus : focused {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        // Full Carrot: at 0.7 the light ring read 2.4:1 against the field (A13
                        // prep-for-prod); full, it is 3.6:1 on white.
                        .strokeBorder(Color(token: Tokens.carrot), lineWidth: 2)
                        .padding(-2)
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        if offscreen {
            HStack(spacing: 0) {
                if text.isEmpty {
                    if showsFocus { caret }
                    Text(placeholder).foregroundStyle(Color(token: Tokens.secondary))
                } else {
                    Text(secure ? String(repeating: "\u{2022}", count: min(text.count, 40)) : text)
                        .foregroundStyle(Color(token: Tokens.ink)).lineLimit(1)
                    if showsFocus { caret }
                }
            }
            .accessibilityHidden(true)
        } else if secure {
            SecureField(title, text: Binding(get: { text }, set: onChange), prompt: Text(placeholder).foregroundStyle(Color(token: Tokens.secondary)))
                .textFieldStyle(.plain)
                .labelsHidden()
                .foregroundStyle(Color(token: Tokens.ink))
                .focused($focused)
                .disabled(!enabled)
                .onSubmit(onSubmit)
                .accessibilityLabel(title)
                .onChange(of: focusNow) { _, now in if now { focused = true } }
                .onChange(of: focusToken) { _, _ in focused = true }
                .onAppear {
                    guard autofocus else { return }
                    DispatchQueue.main.async { focused = true }
                }
        } else {
            TextField(title, text: Binding(get: { text }, set: onChange), prompt: Text(placeholder).foregroundStyle(Color(token: Tokens.secondary)))
                .textFieldStyle(.plain)
                .labelsHidden()
                .foregroundStyle(Color(token: Tokens.ink))
                .focused($focused)
                .disabled(!enabled)
                .onSubmit(onSubmit)
                .accessibilityLabel(title)
                .onChange(of: focusNow) { _, now in if now { focused = true } }
                .onChange(of: focusToken) { _, _ in focused = true }
                .onAppear {
                    guard autofocus else { return }
                    // After the window has made the hosting view first responder.
                    DispatchQueue.main.async { focused = true }
                }
        }
    }

    private var caret: some View {
        Rectangle().fill(Color(token: Tokens.ink)).frame(width: 1, height: 15)
    }
}

/// A scroll view on screen; off screen, the same content laid out from the top and clipped to the
/// space the column is given, since ImageRenderer cannot draw a scroll view. Like the scroll view,
/// the stand-in takes the height offered and never asks for more: a `GeometryReader` does that, where
/// a fixed-size stack inside a flexible frame still pushed what came after it out of the window.
struct ScrollingColumn<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.rendersOffscreen) private var offscreen

    var body: some View {
        if offscreen {
            GeometryReader { _ in
                VStack(spacing: 0) { content }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .top)
            }
            .clipped()
        } else {
            ScrollView(.vertical) { content }
                .scrollIndicators(.automatic)
        }
    }
}
