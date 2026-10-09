import AppKit
import CaretHostCore
import SwiftUI

/// The one-time coach slip at the first ghost text in another app after onboarding (HANDOFF §3, After): "First time:"
/// then Tab "takes it", "Typing says no". Under the line being typed (`CoachSlipPlacement`), click-through, never key.
/// Shown once per install (`OnboardingProgress.coachShown`); the next key, typed or Tab, takes it away. No motion: it
/// comes and goes with the ghost text, which is keyboard-paced.
@MainActor
final class CoachSlip {
    private let panel = OverlayPanel.make()
    /// Whether the slip may show: onboarding finished and the slip never shown. Read when a ghost appears.
    var eligible: () -> Bool = { false }
    /// Called once, when the slip has been shown.
    var onShown: () -> Void = {}
    private(set) var visible = false

    /// A ghost appeared at `caret` (AppKit coordinates, the caret's line box).
    func ghostShown(caret: CGRect?) {
        guard !visible, let caret, eligible() else { return }
        let view = NSHostingView(rootView: CoachSlipView())
        let size = view.fittingSize
        let screen = NSScreen.screens.first { $0.frame.contains(CGPoint(x: caret.midX, y: caret.midY)) } ?? NSScreen.main
        let frame = CoachSlipPlacement.frame(line: caret, slip: size, visible: screen?.visibleFrame ?? .zero)
        panel.contentView = view
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
        visible = true
        onShown()
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                             userInfo: [.announcement: "\(OnboardingCopy.Coach.lead) Tab \(OnboardingCopy.Coach.takes). \(OnboardingCopy.Coach.no)."])
    }

    /// The ghost went (taken, typed over, or withdrawn): the slip goes with it.
    func dismiss() {
        guard visible else { return }
        panel.orderOut(nil)
        visible = false
    }
}

struct CoachSlipView: View {
    var body: some View {
        HStack(spacing: 6) {
            Text(OnboardingCopy.Coach.lead).foregroundStyle(Color(token: Tokens.ink2))
            Keycap(text: "Tab")
            Text(OnboardingCopy.Coach.takes).foregroundStyle(Color(token: Tokens.ink))
            Text(OnboardingCopy.Coach.no).foregroundStyle(Color(token: Tokens.ink)).padding(.leading, 6)
        }
        .font(.system(size: 12))
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Color(token: Tokens.card), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
        .padding(1)
        .fixedSize()
    }
}
