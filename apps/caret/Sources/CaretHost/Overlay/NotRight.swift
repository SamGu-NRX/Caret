import AppKit
import CaretHostCore
import SwiftUI

// "Not right" on an offer (M1, lead decision 3): when an offer was built from a fact Caret noticed
// itself, the slip says where it came from and lets the user say it's wrong without leaving the work.
//
// The gesture is a click on that row, and nothing else. Every key at the caret is already spoken
// for: Tab takes the offer, typing says no, Esc dismisses, ↓ and ⌘1 to ⌘3 browse and pick, ⌘Z
// undoes, and anything else belongs to the app being typed in. A correction is rare (a noticed fact
// that turned out wrong), so a deliberate pointer move costs less than a new chord some app needs.
// Until the user clicks, the slip is the ordinary click-through slip: Tab still takes, typing still
// says no. After the click the row becomes a field (what's right) with Forget and Save, and the slip
// takes the keyboard without bringing Caret forward; Esc gives it back. The same correction is on
// the fact's row in What Caret knows, for keyboard and VoiceOver users.

/// What the row under the slip shows.
struct NotRightRow: Equatable {
    enum Phase: Equatable {
        /// "from what Caret noticed in Mail, Tue" and "Not right".
        case shown
        /// The field and the two answers.
        case correcting
        case sending
        /// What became of it, in a sentence.
        case answered(String)
    }

    /// The helper's words: "from what Caret noticed in Mail Fixture, Tue".
    var says: String
    /// More facts behind the same offer; "Not right" is about the first.
    var more: Int
    var correctable: Bool
    var phase: Phase = .shown
    var text = ""
    var problem: String?

    static let rowHeight: CGFloat = 26
    static let fieldWidth: CGFloat = 190
    static let forgotten = "Caret forgot it and won't use it again."
    static let corrected = "Caret will use what you typed from now on."

    var sentence: String {
        more == 0 ? says : "\(says), and \(more) more"
    }
}

/// The row: a hairline over it, set in at the slip's text. Chrome small in Ink 2, since where a fact
/// came from is a label; "Not right" in Ink, the one thing to press.
struct NotRightRowView: View {
    var row: NotRightRow
    /// Where the words start, so the row lines up with the caption above it.
    var indent: CGFloat
    var onEdit: (String) -> Void = { _ in }
    var onSave: () -> Void = {}
    var onForget: () -> Void = {}
    var onCancel: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1)
            content
                .padding(.leading, indent)
                .padding(.trailing, Tokens.Shape.slipTrailing)
                .frame(minHeight: NotRightRow.rowHeight)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch row.phase {
        case .shown:
            HStack(spacing: 12) {
                Text(row.sentence)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("Not right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize()
            }
        case .correcting, .sending:
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    if row.correctable {
                        EntryField(
                            title: "What's right", text: row.text, placeholder: "What's right", autofocus: true, showsFocus: true,
                            enabled: row.phase == .correcting, onChange: onEdit, onSubmit: onSave
                        )
                        .frame(width: NotRightRow.fieldWidth)
                    } else {
                        Text("Caret will forget this and stop using it.")
                            .font(Tokens.Font.chromeSmall)
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize()
                    }
                    Spacer(minLength: 6)
                    Button("Forget", action: onForget)
                        .buttonStyle(WindowButtonStyle(kind: row.correctable ? .key : .ink, small: true))
                    if row.correctable {
                        Button(row.phase == .sending ? "Saving" : "Save", action: onSave)
                            .buttonStyle(WindowButtonStyle(kind: .ink, small: true))
                    }
                }
                .disabled(row.phase == .sending)
                Text(row.problem ?? "Esc goes back to the offer.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color(token: row.problem == nil ? Tokens.ink2 : Tokens.ink))
                    .fixedSize()
            }
            .padding(.vertical, 6)
        case .answered(let sentence):
            Text(sentence)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize()
        }
    }
}

/// The click target over the row while it shows "Not right": a transparent, non-activating panel the
/// size of the row, so the slip itself stays click-through and only the row takes a click. It never
/// becomes key; the pointer turns to a hand over it.
@MainActor
final class NotRightTarget {
    private let panel: OverlayPanel
    private let view = TargetView()
    var onClick: () -> Void = {}

    init() {
        panel = OverlayPanel.make()
        panel.ignoresMouseEvents = false
        panel.contentView = view
        view.onClick = { [weak self] in self?.onClick() }
    }

    /// Cocoa coordinates.
    func show(over rect: NSRect) {
        panel.setFrame(rect, display: true)
        view.frame = NSRect(origin: .zero, size: rect.size)
        view.window?.invalidateCursorRects(for: view)
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    var isVisible: Bool { panel.isVisible }
    var frame: NSRect { panel.frame }
    var windowNumber: Int { panel.windowNumber }

    private final class TargetView: NSView {
        var onClick: () -> Void = {}

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

        // A fill the window server can hit: a fully clear window lets clicks through to the app below.
        override func draw(_ dirtyRect: NSRect) {
            NSColor.black.withAlphaComponent(0.01).setFill()
            bounds.fill()
        }

        override func resetCursorRects() {
            addCursorRect(bounds, cursor: .pointingHand)
        }

        override func mouseDown(with event: NSEvent) {
            onClick()
        }
    }
}
