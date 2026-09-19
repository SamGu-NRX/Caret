import Foundation
import CoreGraphics

/// Value types shared by the inline-completion pieces: the offer store, the
/// key tap, the preview window and the inserter.
///
/// These mirror the bridge wire types in `CaretCore.CoreProtocol` field for
/// field but are declared here so the app target builds and is testable while
/// the native bridge is still uncommitted. `InlineProviderAdapter` is the one
/// seam that converts between the two; nothing else in the app knows the
/// bridge exists.
///
/// Every offset is a UTF-16 code-unit index, matching `kAXSelectedTextRange`.

// MARK: - Target identity

/// Which field an offer belongs to. Equality is the staleness test: an edit is
/// applied only when a freshly read target still equals the one that produced
/// the offer.
struct InlineTarget: Equatable, Hashable {
    var pid: pid_t
    var bundleID: String
    var windowID: String
    var elementID: String
    /// Change token for the element's value. Two reads sharing this token
    /// describe the same underlying text.
    var elementRevision: String

    /// Identity without the value token: the same field, possibly edited.
    /// Used to tell "user typed in this field" from "focus moved elsewhere",
    /// which are different cancellations with different logging.
    var fieldKey: String { "\(pid)|\(bundleID)|\(windowID)|\(elementID)" }

    func isSameField(as other: InlineTarget) -> Bool { fieldKey == other.fieldKey }
}

// MARK: - Offers

/// A completion the core proposed for one revision of one field.
struct InlineOffer: Equatable {
    var proposalID: String
    var revision: Int
    var target: InlineTarget
    /// Range in the field's full value this replaces. For a pure completion
    /// both ends sit at the caret.
    var replaceStart: Int
    var replaceEnd: Int
    var replacement: String
    /// Digest of the text the core saw. Rechecked before the edit is applied.
    var originalDigest: String
    var createdAt: Date

    var isPureInsertion: Bool { replaceEnd == replaceStart }
}

/// What the user sees. `.nearby` is the documented degraded mode for a field
/// whose caret geometry the app cannot read; it is labeled as such in the UI
/// rather than being passed off as inline text.
struct InlinePreviewPresentation: Equatable {
    enum Placement: Equatable {
        /// Ghost text drawn at the caret, continuing the user's line.
        case atCaret
        /// Caret geometry unsupported: a labeled card near the field.
        case nearbyFallback
    }

    var text: String
    /// Screen rect of the caret in Cocoa coordinates (bottom-left origin).
    var caretRect: CGRect
    /// Screen rect of the whole field, the anchor for `.nearbyFallback`.
    var fieldRect: CGRect
    var placement: Placement
    /// The chord that accepts, rendered in the hint. Sourced from the key tap
    /// so the hint cannot drift from the key that actually works.
    var acceptHint: String
    /// Point size of the host field's text, when readable, so ghost text can
    /// match it instead of guessing.
    var fontPointSize: CGFloat?
}

// MARK: - Reasons

/// Why a visible offer came down. Carried into logs and the status item; never
/// carries field content.
enum InlineCancelReason: String, Equatable {
    case userTyped = "user_typed"
    case caretMoved = "caret_moved"
    case focusChanged = "focus_changed"
    case escape = "escape"
    case accepted = "accepted"
    case invalidatedByCore = "invalidated_by_core"
    case expired = "expired"
    case staleTarget = "stale_target"
    case providerFailed = "provider_failed"
    case permissionLost = "permission_lost"
    case excludedField = "excluded_field"
}

/// Why the app will not intercept or edit at all. Criterion 5: each of these
/// means no key consumption and no edit, and each is shown as actionable
/// status without raw content or keys.
enum InlineDisabledReason: String, Equatable {
    case accessibilityDenied = "accessibility_denied"
    case inputMonitoringDenied = "input_monitoring_denied"
    case noProvider = "no_provider"
    case providerError = "provider_error"
    case secureField = "secure_field"
    case excludedApp = "excluded_app"
    case composing = "composing"

    var statusText: String {
        switch self {
        case .accessibilityDenied: return "Accessibility access is off. Caret cannot read or complete text."
        case .inputMonitoringDenied: return "Input Monitoring is off. Tab completion is disabled."
        case .noProvider: return "No completion backend is configured."
        case .providerError: return "The completion backend is not responding."
        case .secureField: return "Caret stays off in password fields."
        case .excludedApp: return "Caret is turned off for this app."
        case .composing: return "Paused while an input method is composing."
        }
    }
}
