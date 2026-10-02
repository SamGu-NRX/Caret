import CaretScreenCore
import Foundation

/// Where a fill offer's value came from, carried with the offer so Tab's result can be reported
/// back to the helper and the source can be named on screen and rechecked before the write.
public struct FillOrigin: Equatable, Sendable {
    public var proposalID: String
    /// The form's window, as the reader names it (`<pid>-<n>`).
    public var windowID: String
    /// The reader's element key for the field.
    public var fieldKey: String
    public var sourceAppName: String
    public var sourceWindowTitle: String
    public var sourceBundleID: String
    /// Parsed from the source's reader window id. Nil when the id is not `<pid>-<n>`.
    public var sourcePID: Int32?
    /// When the helper stamped the proposal, in milliseconds since the epoch.
    public var proposedAtMs: Int64

    public init(
        proposalID: String, windowID: String, fieldKey: String, sourceAppName: String,
        sourceWindowTitle: String, sourceBundleID: String, sourcePID: Int32?, proposedAtMs: Int64
    ) {
        self.proposalID = proposalID
        self.windowID = windowID
        self.fieldKey = fieldKey
        self.sourceAppName = sourceAppName
        self.sourceWindowTitle = sourceWindowTitle
        self.sourceBundleID = sourceBundleID
        self.sourcePID = sourcePID
        self.proposedAtMs = proposedAtMs
    }

    /// The source named once, as `SURFACES.md` section 5 writes it: "from Mail, Invoice 2041".
    public var sourceCaption: String {
        let title = sourceWindowTitle.trimmingCharacters(in: .whitespaces)
        let app = sourceAppName.trimmingCharacters(in: .whitespaces)
        if title.isEmpty || title == app { return "from \(app)" }
        // Fixture and document windows often repeat the app name in the title ("App — Reference").
        if let range = title.range(of: app + " — "), range.lowerBound == title.startIndex {
            return "from \(app), \(title[range.upperBound...])"
        }
        return "from \(app), \(title)"
    }
}

public enum OfferKind: Equatable, Sendable {
    /// Model-written continuation at the caret.
    case ghost
    /// A value copied from another window into an empty field.
    case fill(FillOrigin)

    public var name: String {
        switch self {
        case .ghost: return "ghost"
        case .fill: return "fill"
        }
    }

    public var fillOrigin: FillOrigin? {
        if case .fill(let origin) = self { return origin }
        return nil
    }
}

/// Picks the field of a fill proposal that the user is in, or says why there is none.
///
/// The reader names fields by its own element keys, which the host cannot recompute. Both sides do
/// read the same Accessibility frame, so the match is the focused element's frame against each
/// proposed field's frame. A window that moved since the proposal matches nothing, which is the
/// safe outcome: the proposal was made for a layout that is gone.
public enum FillSelection {
    public enum Result: Equatable, Sendable {
        case offer(field: FillField, origin: FillOrigin)
        case skip(Skip)
    }

    public enum Skip: String, Equatable, Sendable {
        /// No proposed field sits where the focused element is.
        case noFieldAtFocus
        /// The field matched, and the agreed answer is "none" or was withheld.
        case answerNone
        /// The focused field already holds text; a fill never writes over a value.
        case fieldNotEmpty
        /// The focused element is secure, or its frame is unknown.
        case unsuitableField
    }

    /// Frames are compared to within this many points, which absorbs rounding between readers.
    public static let frameTolerance = 1.0

    public static func select(
        _ proposal: FillProposal,
        focusedFrame: Frame?,
        focusedValue: String,
        secure: Bool
    ) -> Result {
        guard !secure, let focusedFrame else { return .skip(.unsuitableField) }
        guard let field = proposal.fields.first(where: { $0.frame.map { matches($0, focusedFrame) } ?? false }) else {
            return .skip(.noFieldAtFocus)
        }
        guard focusedValue.isEmpty else { return .skip(.fieldNotEmpty) }
        guard field.choice != "none", field.value?.isEmpty == false, let source = field.source else {
            return .skip(.answerNone)
        }
        let origin = FillOrigin(
            proposalID: proposal.id,
            windowID: proposal.windowId,
            fieldKey: field.key,
            sourceAppName: source.appName,
            sourceWindowTitle: source.windowTitle,
            sourceBundleID: source.bundleId,
            sourcePID: pid(fromWindowID: source.windowId),
            proposedAtMs: proposal.at
        )
        return .offer(field: field, origin: origin)
    }

    public static func matches(_ a: Frame, _ b: Frame) -> Bool {
        abs(a.x - b.x) <= frameTolerance && abs(a.y - b.y) <= frameTolerance
            && abs(a.width - b.width) <= frameTolerance && abs(a.height - b.height) <= frameTolerance
    }

    /// The reader's window ids are `<pid>-<n>`.
    public static func pid(fromWindowID id: String) -> Int32? {
        guard let dash = id.firstIndex(of: "-") else { return nil }
        return Int32(id[id.startIndex..<dash])
    }
}
