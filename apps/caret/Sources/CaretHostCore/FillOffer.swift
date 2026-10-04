import CaretScreenCore
import Foundation

/// Where a fill offer's value came from, carried with the offer so Tab's result can be reported
/// back to the helper and the source can be named on screen and, for a window, rechecked before
/// the write.
public struct FillOrigin: Equatable, Sendable {
    /// A window on screen, or something the user told Caret. The helper sends exactly one of
    /// `FillField.source` and `FillField.memory` with a value (protocol.ts FillField), so the host
    /// keeps them apart rather than reading a memory value as a window with empty names.
    public enum Source: Equatable, Sendable {
        /// Copied from another window: `SourceCheck` looks for the value there again before the write.
        case window(Window)
        /// An About entry the user typed into Caret (B17, `FillMemory`). There is no window to
        /// recheck; the target is still reread before the write, as for every fill. A held proposal
        /// whose entry was edited, paused or forgotten afterwards is not offered (`FillMachine`).
        case memory(id: String)
    }

    public struct Window: Equatable, Sendable {
        public var appName: String
        public var title: String
        public var bundleID: String
        /// Parsed from the source's reader window id. Nil when the id is not `<pid>-<n>`.
        public var pid: Int32?

        public init(appName: String, title: String, bundleID: String, pid: Int32?) {
            self.appName = appName
            self.title = title
            self.bundleID = bundleID
            self.pid = pid
        }
    }

    public var proposalID: String
    /// The form's window, as the reader names it (`<pid>-<n>`).
    public var windowID: String
    /// The reader's element key for the field.
    public var fieldKey: String
    public var source: Source
    /// When the helper stamped the proposal, in milliseconds since the epoch.
    public var proposedAtMs: Int64
    /// Command-1 fills every empty field of the form. False until the host can write fields other
    /// than the focused one; while false, Command-1 keeps the app's meaning.
    public var fillAll = false

    public init(proposalID: String, windowID: String, fieldKey: String, source: Source, proposedAtMs: Int64) {
        self.proposalID = proposalID
        self.windowID = windowID
        self.fieldKey = fieldKey
        self.source = source
        self.proposedAtMs = proposedAtMs
    }

    /// A value copied from a window.
    public init(
        proposalID: String, windowID: String, fieldKey: String, sourceAppName: String,
        sourceWindowTitle: String, sourceBundleID: String, sourcePID: Int32?, proposedAtMs: Int64
    ) {
        self.init(
            proposalID: proposalID, windowID: windowID, fieldKey: fieldKey,
            source: .window(Window(appName: sourceAppName, title: sourceWindowTitle, bundleID: sourceBundleID, pid: sourcePID)),
            proposedAtMs: proposedAtMs
        )
    }

    /// The line by a value that came from memory. The host owns this wording rather than showing
    /// the helper's `FillMemory.says`, so a copy test pins what people read.
    public static let memoryCaption = "from what you told Caret"

    /// The source named once, as `SURFACES.md` section 5 writes it: "from Mail, Invoice 2041", or
    /// "from what you told Caret".
    public var sourceCaption: String {
        guard case .window(let w) = source else { return Self.memoryCaption }
        let title = w.title.trimmingCharacters(in: .whitespaces)
        let app = w.appName.trimmingCharacters(in: .whitespaces)
        if title.isEmpty || title == app { return "from \(app)" }
        // Fixture and document windows often repeat the app name in the title ("App — Reference").
        if let range = title.range(of: app + " — "), range.lowerBound == title.startIndex {
            return "from \(app), \(title[range.upperBound...])"
        }
        return "from \(app), \(title)"
    }

    /// The source as the done toast names it, without the window: "from Mail", or "from what you
    /// told Caret" (`SURFACES.md` section 6: the offer line already named the window).
    public var toastSource: String {
        guard case .window(let w) = source else { return Self.memoryCaption }
        return "from \(w.appName)"
    }

    /// The entry a memory value came from; nil for a window's value.
    public var memoryID: String? {
        if case .memory(let id) = source { return id }
        return nil
    }
}

public enum OfferKind: Equatable, Sendable {
    /// Model-written continuation at the caret.
    case ghost
    /// A value copied from another window into an empty field.
    case fill(FillOrigin)
    /// One action in another app, shown as an offer line (`SURFACES.md` section 3).
    case action(ActionLine)
    /// Help bigger than a sentence (`SURFACES.md` section 4).
    case popup(PopupOffer)

    public var name: String {
        switch self {
        case .ghost: return "ghost"
        case .fill: return "fill"
        case .action: return "action"
        case .popup: return "popup"
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
        /// The field matched, and the agreed answer is "none".
        case answerNone
        /// The field matched, and the helper withheld it (`FillField.withheld`): the asks disagreed,
        /// agreed below the cutoff, or a privacy cut took a value of its kind (`sourceCut`, which
        /// may come with no asks at all). A withheld field shows no ghost value, whatever `value`
        /// holds, because a cut source can leave a plausible decoy (B12).
        case withheld
        /// The focused field already holds text; a fill never writes over a value.
        case fieldNotEmpty
        /// The focused element is secure, or its frame is unknown.
        case unsuitableField
        /// This value was refused or undone in this field already; it is not offered there again
        /// (IDENTITY.md: the same offer never comes back for the same phrase in the same field).
        case suppressed
        /// The value came from a memory entry that was edited, paused or forgotten after the
        /// proposal arrived: what the user told Caret is no longer that value.
        case memoryChanged
    }

    /// Identifies one value in one field of one window, for `suppressed`.
    public static func suppressionKey(windowID: String, fieldKey: String, value: String) -> String {
        [windowID, fieldKey, value].joined(separator: "\u{1}")
    }

    /// Frames are compared to within this many points, which absorbs rounding between readers.
    public static let frameTolerance = 1.0

    /// `changedMemory`: memory entries edited, paused or forgotten since this proposal arrived.
    /// `bound`: each proposed field's element, by field key (`FillMachine.bind`); the focused
    /// element is matched there first, and by frame only when no bound field is it.
    public static func select(
        _ proposal: FillProposal,
        focusedFrame: Frame?,
        focusedValue: String,
        secure: Bool,
        suppressed: Set<String> = [],
        changedMemory: Set<String> = [],
        focusedElementID: String? = nil,
        bound: [String: String] = [:]
    ) -> Result {
        guard !secure, let focusedFrame else { return .skip(.unsuitableField) }
        guard let field = field(in: proposal, focusedFrame: focusedFrame, focusedElementID: focusedElementID, bound: bound) else {
            return .skip(.noFieldAtFocus)
        }
        guard focusedValue.isEmpty else { return .skip(.fieldNotEmpty) }
        guard field.withheld == nil else { return .skip(.withheld) }
        guard field.choice != "none", let value = field.value, !value.isEmpty else { return .skip(.answerNone) }
        let from: FillOrigin.Source
        if let source = field.source {
            from = .window(.init(appName: source.appName, title: source.windowTitle, bundleID: source.bundleId, pid: pid(fromWindowID: source.windowId)))
        } else if let memory = field.memory {
            guard !changedMemory.contains(memory.id) else { return .skip(.memoryChanged) }
            from = .memory(id: memory.id)
        } else {
            // The decoder refuses a value with neither; kept as a skip so a change there cannot
            // turn into an offer with no source.
            return .skip(.answerNone)
        }
        guard !suppressed.contains(suppressionKey(windowID: proposal.windowId, fieldKey: field.key, value: value)) else {
            return .skip(.suppressed)
        }
        let origin = FillOrigin(proposalID: proposal.id, windowID: proposal.windowId, fieldKey: field.key, source: from, proposedAtMs: proposal.at)
        return .offer(field: field, origin: origin)
    }

    /// The proposed field the focused element is: by the element bound to it, else by frame, as
    /// before binding existed. The frame stays a fallback because a page that re-renders a field
    /// gives it a new element at the same place.
    static func field(in proposal: FillProposal, focusedFrame: Frame, focusedElementID: String?, bound: [String: String]) -> FillField? {
        if let focusedElementID, let byElement = proposal.fields.first(where: { bound[$0.key] == focusedElementID }) {
            return byElement
        }
        return proposal.fields.first { $0.frame.map { matches($0, focusedFrame) } ?? false }
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
