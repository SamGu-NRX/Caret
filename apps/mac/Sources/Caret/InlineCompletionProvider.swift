import Foundation

/// The app's whole dependency on the completion backend.
///
/// This exists as a protocol so the keyboard, preview and insertion behavior
/// could be built and tested while the native bridge (`CaretCore`) was still
/// unlanded. `CoreBridgeInlineProvider` below is the only place that will name
/// a bridge type; nothing else in the app changes when the bridge lands.
///
/// Required bridge signatures, matching CaretCore as read on 2026-09-19:
///   CoreBridgeClient(configuration: CoreLaunchConfiguration)
///   func onEvent(_ handler: @escaping (CoreEvent) -> Void)
///   func start() throws
///   func hello() async throws -> HelloResult
///   func updateContext(_ frame: ContextFrame) async throws -> ContextUpdateResult
///   func accept(proposalID: String, revision: Int, target: TargetIdentity) async throws -> AcceptResult
///   func dismiss(proposalID: String) async throws -> Bool
/// The adapter maps InlineTarget <-> TargetIdentity and CoreEvent.offer(.inline)
/// -> InlineOffer. Those are the only conversions needed.
/// Main-actor isolated because every implementation touches UI-adjacent state
/// and the coordinator that drives it is main-actor too. Isolating the
/// protocol is the correct fix for the conformance warning; marking the
/// conformance @unchecked would silence it while leaving the data race real.
@MainActor
protocol InlineCompletionProviding: AnyObject {
    /// An offer arrived, tagged with the generation of the request that asked
    /// for it so the store can drop a late answer.
    var onOffer: ((InlineOffer, Int) -> Void)? { get set }
    /// The backend says a proposal stopped being valid.
    var onInvalidated: ((String, InlineCancelReason) -> Void)? { get set }
    /// The backend failed or is unconfigured. Criterion 6: this is surfaced,
    /// never replaced with a canned completion.
    var onUnavailable: ((InlineDisabledReason) -> Void)? { get set }

    func start() throws
    /// Ask for a completion for one reading of the field.
    func requestCompletion(_ request: InlineCompletionRequest) async throws
    /// Confirm acceptance. The returned edit is applied only after the app
    /// revalidates the live field again.
    func accept(proposalID: String, revision: Int, target: InlineTarget) async throws -> InlineAcceptedEdit
    func dismiss(proposalID: String) async
}

/// One bounded reading of the current target, ready to send.
struct InlineCompletionRequest: Equatable {
    var generation: Int
    var revision: Int
    var target: InlineTarget
    var role: String
    /// Bounded window around the caret. The core rejects an oversized frame
    /// rather than truncating it, because truncation would shift the offsets
    /// an edit is applied at.
    var nearbyText: String
    var textOffset: Int
    var caret: Int
    var selection: NSRange
    var secure: Bool
    var imeComposing: Bool
    var appExcluded: Bool
    var valueLength: Int

    /// Matches CoreLimits.nearbyTextUnits in the bridge.
    static let maxNearbyUnits = 4000
}

struct InlineAcceptedEdit: Equatable {
    var proposalID: String
    var target: InlineTarget
    var replaceStart: Int
    var replaceEnd: Int
    var replacement: String
    var originalDigest: String
}

/// Builds the bounded window the core requires, centered on the caret.
///
/// Split out and pure because getting this wrong corrupts every offset that
/// follows: the window must contain the caret and its `textOffset` must be the
/// absolute position the window starts at.
enum InlineWindowBuilder {
    static func window(
        text: String,
        caret: Int,
        limit: Int = InlineCompletionRequest.maxNearbyUnits
    ) -> (text: String, offset: Int) {
        let units = Array(text.utf16)
        guard units.count > limit else { return (text, 0) }

        // Weight the window behind the caret: a completion is predicted from
        // what came before it, and the tail rarely earns the units.
        let behind = min(caret, limit * 3 / 4)
        let start = max(0, min(caret - behind, units.count - limit))
        let end = min(units.count, start + limit)
        let slice = Array(units[start..<end])
        return (String(utf16CodeUnits: slice, count: slice.count), start)
    }
}
