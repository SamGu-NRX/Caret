import Foundation

/// The host's side of D2-02's router (brief H6): it tells the helper what only the host sees in the
/// field the user is in, and turns the helper's `routeDecision` into one answer for the host's own
/// ambient help, ghost text and the writing line: show it, wait for the decision, or stay quiet.
///
/// The decision is the helper's. This only follows it, and only for ambient help: the user's Ask,
/// Tab on a visible offer and the menu work as before, and no decision lets anything run without Tab.
///
/// How the two sides name the field. The helper names it by the reader's window id and element key,
/// which the host cannot compute (a key's ordinal comes from a walk of the whole window). So the host
/// learns them from the decisions themselves. Until the host has sent a context for the field, a
/// decision carries the helper's digest of the field's text (`helperDigest`), which the host computes
/// from its own read: a decision whose digest matches a text this field held since focus came to it
/// names this field. From then on the host sends contexts under those ids with its own revision, and a
/// decision for the field must echo the last one sent.
///
/// A binding is tentative when two fields could share the evidence: the field was empty (every empty
/// field has one digest), or the decision was made before the host saw focus arrive (it may be about
/// the field the user just left). A newer decision that names this field's text may replace a
/// tentative binding; a firm one stays, and a decision naming other ids then waits for the field it
/// names to be focused. Ids bound for a field the user left stay that field's, so returning to it
/// binds at once and its ids never bind another field.
///
/// When routing is unavailable the host behaves as before the router: the setting is off, the helper
/// is not connected or its hello did not take routing, or no decision arrives within
/// `decisionBudgetMs` (a helper without Jev, or one from before D2-02, never sends one). A decision
/// whose outcome is `error` (R2: the router failed for that context) counts as that context's missed
/// budget, so it shows help at once and three in a row make routing unavailable, as misses do.
///
/// Pure: times are milliseconds since the epoch passed in, so every transition is tested without a
/// clock. Main thread only in the app.
public final class RouteFollower {
    /// What the host read of the focused field.
    public struct Read: Equatable, Sendable {
        /// The field, its content revision ignored.
        public var target: TargetIdentity
        public var value: String
        /// Nil when the field reports no selection.
        public var selection: UTF16Selection?
        /// An input method that composes text is selected (`InputMethodState`). Accessibility does
        /// not show marked text itself, so this is the host's only reading of composition.
        public var composing: Bool

        public init(target: TargetIdentity, value: String, selection: UTF16Selection?, composing: Bool) {
            self.target = target
            self.value = value
            self.selection = selection
            self.composing = composing
        }
    }

    /// What ambient help may do now.
    public enum Gate: Equatable, Sendable {
        /// Show it. `why` names the rule, for the debug state and counters.
        case allow(Allow)
        /// Hold it until a decision arrives or `untilMs` passes, whichever is first.
        case wait(untilMs: Int64)
        /// Stay quiet in this field until the next decision.
        case quiet(Quiet)

        public var allows: Bool { if case .allow = self { return true } else { return false } }
    }

    public enum Allow: String, Equatable, Sendable {
        /// "Always suggest as I type": the user turned routing off.
        case off
        /// The helper is not connected, or its connection did not declare routing.
        case noHelper
        /// No decision came within the budget on this connection, and none since.
        case unavailable
        /// This context's decision did not come within the budget.
        case budget
        /// A write decision holds for this field.
        case write
        /// The decision for this field expired with no newer one.
        case expired
        /// No field is focused (ghost text needs one anyway).
        case noField
        /// The router failed for this context (R2's `error` decision): as when its decision misses the budget.
        case error
    }

    public enum Quiet: String, Equatable, Sendable {
        case abstain, ask, act
    }

    /// Why a decision was not applied.
    public enum Drop: String, Equatable, Sendable {
        case off, noField, expired, older, otherField, revision
    }

    public enum Receipt: Equatable, Sendable {
        case applied
        case dropped(Drop)
    }

    /// The longest ambient help waits for a decision after a breakpoint before it shows as if the
    /// router were not there. Started from D2-02's route entry in the helper, p50 169 ms and p95 494 ms
    /// (evidence/screen/d2-02, corpus-on-clock.md), plus the socket hop. Measured through the host in
    /// a scripted TextEdit session (evidence/host/h6, ghost-on-1, live Jev, n=4): decisions reached the
    /// host 1978 to 6905 ms after the breakpoint, bound by Router 1's 2 s cooldown, so 3 of 4 sentence
    /// ends fell back here; ghost text after a sentence end then took p50 693 ms against 232 ms with
    /// routing off (ghost-off-6). A budget long enough to catch those decisions would hold ghost text
    /// for seconds at every sentence, so this stays a cap on the wait, not a fit to the measurement.
    public static let decisionBudgetMs: Int64 = 600
    /// Contexts in a row whose decision missed the budget before the helper counts as not routing.
    /// A helper that never sent one misses once. Assumed, not measured: Router 1's two-second
    /// cooldown makes a single late decision normal.
    public static let missesBeforeUnavailable = 3
    /// How long before the host saw focus come to a field a decision about it may have been made:
    /// the reader can see the focus change before the host's own read does. Assumed, not measured.
    public static let focusLeadMs: Int64 = 500
    /// Decisions in a row naming a firmly bound field's text under other ids before the host takes the
    /// new ids. Two, so one decision about another empty field never moves a firm binding. Assumed.
    static let contradictionsToRebind = 2
    /// How long a field may read as gone and still come back as the same focus. One TextEdit document
    /// kept focus for a whole run and the follower still counted 15 focus changes (evidence/host/h6,
    /// ghost-off-6): reads that found no field between keystrokes. The bound is assumed, not measured.
    public static let blinkMs: Int64 = 1000
    /// Decisions kept to match a field the host focuses after they arrived. A bound, not measured.
    static let keptDecisions = 8
    /// Texts kept per field to match a decision's digest against, the newest last. A bound, not measured.
    static let keptDigests = 32

    /// The helper's digest of a field it has no host revision for (helper/src/routing/context.ts,
    /// `contextNow`): sha256 of the text, a NUL and "unknown", first 16 hex digits.
    public static func helperDigest(_ value: String) -> String {
        UTF16Text.digest(value + "\u{0}unknown")
    }

    /// Where the user is now, for the debug state.
    public enum Phase: Equatable, Sendable {
        case deciding(sinceMs: Int64)
        case decided(outcome: RouteDecision.Outcome, route: String?, expiresMs: Int64)
    }

    private struct Field {
        var target: TargetIdentity
        var focusedAtMs: Int64
        var value: String
        var selection: RoutingContext.Selection
        var composing: Bool
        var digests: [String]
        var windowId: String?
        var key: String?
        /// The last revision sent under `windowId`/`key`; nil until one is sent.
        var sentRevision: String?
        /// The binding could be another field's (see the type's comment); a newer decision may replace it.
        var tentative = false
        /// The decision number the binding came from.
        var boundContext = 0
        /// Newer decisions in a row that named this field's text under one other pair of ids
        /// (`contender`). A reader that restarted numbers windows anew, so a firm binding gives way
        /// after `contradictionsToRebind` of them; any other evidence starts the count again.
        var contradictions = 0
        var contender: Ids?
        var contenderContext = 0
        var phase: Phase
        /// This deciding phase's miss was counted.
        var missed = false
        /// Why the router failed, while an `error` decision holds.
        var failure: RouteDecision.Failure?

        var bound: Bool { windowId != nil && key != nil }
    }

    public struct Stats: Codable, Equatable, Sendable {
        public var contextsSent: UInt64 = 0
        public var breakpoints: [String: UInt64] = [:]
        public var applied: [String: UInt64] = [:]
        public var dropped: [String: UInt64] = [:]
        public var bound: UInt64 = 0
        public var misses: UInt64 = 0
        public init() {}
    }

    /// The user's setting: "Caret decides when to help".
    public private(set) var enabled: Bool
    /// The helper is connected and this connection's hello declared routing.
    public private(set) var linked = false
    public private(set) var stats = Stats()
    /// From a breakpoint (or focus) to the decision that settled it, in ms.
    public let entryLatency = LatencyRecorder(capacity: 200)

    private var field: Field?
    /// The field the last read found gone, when, and how many decisions had arrived then, in case it
    /// comes straight back (`blinkMs`).
    private var blinked: (Field, Int64, Int)?
    /// Decisions received on this connection, counted so a blink knows whether any came during it.
    private var received = 0
    private struct Ids: Equatable { var windowId: String; var key: String }
    /// The helper's ids for fields the user left, newest last, and whether the binding was firm. A firm
    /// one binds its field again on return and never binds another; a tentative one keeps only a
    /// decision made before the host saw the next focus from binding the next field. Cleared with the
    /// connection: a new reader numbers windows anew.
    private var known: [(target: TargetIdentity, ids: Ids, firm: Bool)] = []
    static let keptFields = 16
    private var recent: [RouteDecision] = []
    /// The highest decision number applied on this connection; numbers restart with the helper.
    private var lastContext = 0
    /// A decision has arrived on this connection: the helper routes.
    private var proven = false
    private var misses = 0
    private var unavailable = false
    private var revision: UInt64 = 0

    public init(enabled: Bool) {
        self.enabled = enabled
    }

    // MARK: - Inputs

    public func setEnabled(_ on: Bool, nowMs: Int64) {
        guard on != enabled else { return }
        enabled = on
        resetConnection(nowMs: nowMs)
    }

    /// The helper connection came up (with `routing` true when its hello declared routing) or went.
    public func linkChanged(up: Bool, routing: Bool, nowMs: Int64) {
        linked = up && routing
        resetConnection(nowMs: nowMs)
    }

    /// A read of the focused field, or nil when focus is on no field. Returns the context to send,
    /// at most one per breakpoint: a new field, a changed selection mode or composition, or a
    /// sentence or paragraph the user just finished. Ordinary typing returns nil.
    public func observe(_ read: Read?, nowMs: Int64) -> RoutingContext? {
        guard let read else {
            if let f = field { blinked = (f, nowMs, received) }
            leave()
            return nil
        }
        var target = read.target
        target.elementRevision = ""
        let selection = Self.selectionMode(read.selection)
        // A read that found no field between two reads of the same one (an app busy for a moment) is
        // no focus change: the field comes back as it was, decision and all.
        var reconcile = false
        if field == nil, let (left, at, seen) = blinked, left.target == target, nowMs - at <= Self.blinkMs {
            field = left
            // Decisions that came while the read found no field were kept but not applied.
            reconcile = received > seen
        }
        blinked = nil
        guard var f = field, f.target == target else {
            leave()
            var fresh = Field(
                target: target, focusedAtMs: nowMs, value: read.value, selection: selection, composing: read.composing,
                digests: [Self.helperDigest(read.value)], phase: .deciding(sinceMs: nowMs)
            )
            // A field the user comes back to keeps the ids the helper gave it. No revision of the
            // host's is assumed to hold: the helper may have heard about another field since.
            if let ids = known.last(where: { $0.target == target && $0.firm })?.ids {
                fresh.windowId = ids.windowId
                fresh.key = ids.key
            }
            field = fresh
            count(\.breakpoints, "focus")
            return matchKept(nowMs: nowMs)
        }
        let breakpoint: String?
        if f.selection != selection {
            breakpoint = "selection"
        } else if f.composing != read.composing {
            breakpoint = "composing"
        } else {
            breakpoint = Self.textBreakpoint(previous: f.value, value: read.value, selection: read.selection)?.rawValue
        }
        let previous = f.value
        f.value = read.value
        f.selection = selection
        f.composing = read.composing
        if !previous.utf16.elementsEqual(read.value.utf16) { remember(digest: Self.helperDigest(read.value), in: &f) }
        field = f
        if reconcile, let follow = matchKept(nowMs: nowMs), breakpoint == nil { return follow }
        guard let breakpoint else { return nil }
        count(\.breakpoints, breakpoint)
        field?.phase = .deciding(sinceMs: nowMs)
        field?.missed = false
        return context(breakpoint: RoutingContext.Breakpoint(rawValue: breakpoint), nowMs: nowMs)
    }

    /// A decision from the helper. Returns whether it applied, and a context to send when binding
    /// the field showed the helper something it assumed wrongly (a range selection, a composition).
    public func receive(_ d: RouteDecision, nowMs: Int64) -> (Receipt, RoutingContext?) {
        guard enabled, linked else { return (drop(.off), nil) }
        // Any decision says the helper routes, whichever field it is about.
        proven = true
        received += 1
        keep(d)
        return take(d, nowMs: nowMs)
    }

    private func take(_ d: RouteDecision, nowMs: Int64) -> (Receipt, RoutingContext?) {
        guard d.expires > nowMs else { return (drop(.expired), nil) }
        guard d.context >= lastContext else { return (drop(.older), nil) }
        guard var f = field else { return (drop(.noField), nil) }
        if let windowId = f.windowId, let key = f.key, d.windowId == windowId, d.key == key {
            if let sent = f.sentRevision {
                guard d.textRevision == sent else { return (drop(.revision), nil) }
                // The helper took the host's context under these ids: they are this field's.
                f.tentative = false
            }
            f.contradictions = 0
            f.contender = nil
            apply(d, to: &f, nowMs: nowMs)
            field = f
            return (.applied, nil)
        }
        // Another field's ids. A firm binding stays; the decision waits in `recent` for its field.
        // Only decisions that keep naming this field's text under the same new ids move it.
        if f.bound, d.context <= f.boundContext { return (drop(.otherField), nil) }
        guard let tentative = binds(d, f) else {
            if f.contender != nil {
                f.contender = nil
                f.contradictions = 0
                field = f
            }
            return (drop(.otherField), nil)
        }
        if f.bound, !f.tentative {
            let ids = Ids(windowId: d.windowId, key: d.key ?? "")
            if f.contender == ids, d.context > f.contenderContext {
                f.contradictions += 1
            } else {
                f.contender = ids
                f.contradictions = 1
            }
            f.contenderContext = d.context
            field = f
            if f.contradictions < Self.contradictionsToRebind { return (drop(.otherField), nil) }
        }
        f.contradictions = 0
        f.contender = nil
        f.windowId = d.windowId
        f.key = d.key
        f.sentRevision = nil
        f.tentative = tentative
        f.boundContext = d.context
        stats.bound &+= 1
        apply(d, to: &f, nowMs: nowMs)
        field = f
        // The helper took the selection as unknown and the text as not composing.
        guard f.selection != .caret || f.composing else { return (.applied, nil) }
        let follow = context(breakpoint: nil, nowMs: nowMs)
        if follow != nil { field?.phase = .deciding(sinceMs: nowMs) }
        return (.applied, follow)
    }

    // MARK: - The answer

    /// What ambient help may do now. Counts a missed budget once per context.
    public func gate(nowMs: Int64) -> Gate {
        guard enabled else { return .allow(.off) }
        guard linked else { return .allow(.noHelper) }
        if unavailable { return .allow(.unavailable) }
        guard let f = field else { return .allow(.noField) }
        switch f.phase {
        case .deciding(let since):
            let until = since + Self.decisionBudgetMs
            if nowMs < until { return .wait(untilMs: until) }
            if var missed = field {
                countMiss(&missed)
                field = missed
            }
            return unavailable ? .allow(.unavailable) : .allow(.budget)
        case .decided(let outcome, _, let expires):
            if nowMs >= expires { return .allow(.expired) }
            switch outcome {
            case .write: return .allow(.write)
            case .abstain: return .quiet(.abstain)
            case .ask: return .quiet(.ask)
            case .act: return .quiet(.act)
            case .error: return .allow(.error)
            }
        }
    }

    /// The ids the helper uses for the focused field, once a decision named them.
    public var boundField: (windowId: String, key: String)? {
        guard let f = field, let w = f.windowId, let k = f.key else { return nil }
        return (w, k)
    }

    public var phase: Phase? { field?.phase }
    public var isUnavailable: Bool { unavailable }

    /// For the debug state: ids and counts, never text.
    public func debugInfo(nowMs: Int64) -> DebugState.RoutingInfo {
        let gate: String
        switch self.gate(nowMs: nowMs) {
        case .allow(let why): gate = "allow:\(why.rawValue)"
        case .wait: gate = "wait"
        case .quiet(let why): gate = "quiet:\(why.rawValue)"
        }
        var phase: String?
        var route: String?
        switch field?.phase {
        case .deciding?: phase = "deciding"
        case .decided(let outcome, let r, _)?: phase = outcome.rawValue; route = r
        case nil: break
        }
        return DebugState.RoutingInfo(
            enabled: enabled, linked: linked, unavailable: unavailable, gate: gate, phase: phase, route: route,
            failure: field?.failure?.rawValue, windowId: field?.windowId, key: field?.key, budgetMs: Self.decisionBudgetMs, stats: stats,
            entry: entryLatency.summary()
        )
    }

    // MARK: - Rules

    public enum TextBreakpoint: String, Sendable { case sentence, paragraph }

    /// A sentence or paragraph the user just finished, between two reads of one field: the field
    /// grew, the caret is a plain caret, and right before it sit ".", "!" or "?" (maybe closing
    /// quotes or brackets) and a space (sentence) or a line break (paragraph) — `WritingMarks`'s rule,
    /// so the writing checks and the router see the same boundary.
    public static func textBreakpoint(previous: String, value: String, selection: UTF16Selection?) -> TextBreakpoint? {
        guard let selection, WritingMarks.boundary(previous: previous, value: value, selection: selection) != nil else { return nil }
        let ns = value as NSString
        let last = ns.character(at: selection.start - 1)
        return last == 0x20 ? .sentence : .paragraph
    }

    public static func selectionMode(_ s: UTF16Selection?) -> RoutingContext.Selection {
        guard let s else { return .none }
        return s.isEmpty ? .caret : .range
    }

    // MARK: - Private

    private func resetConnection(nowMs: Int64) {
        lastContext = 0
        proven = false
        misses = 0
        unavailable = false
        recent = []
        known = []
        blinked = nil
        if var f = field {
            f.windowId = nil
            f.key = nil
            f.sentRevision = nil
            f.tentative = false
            f.boundContext = 0
            f.phase = .deciding(sinceMs: nowMs)
            f.missed = false
            field = f
        }
    }

    private func leave() {
        if let f = field, let w = f.windowId, let k = f.key {
            known.removeAll { $0.target == f.target || $0.ids == Ids(windowId: w, key: k) }
            if known.count >= Self.keptFields { known.removeFirst() }
            known.append((f.target, Ids(windowId: w, key: k), !f.tentative))
        }
        field = nil
    }

    private func context(breakpoint: RoutingContext.Breakpoint?, nowMs: Int64) -> RoutingContext? {
        guard enabled, linked, var f = field, let windowId = f.windowId, let key = f.key else { return nil }
        revision &+= 1
        let rev = "h\(revision)"
        f.sentRevision = rev
        field = f
        stats.contextsSent &+= 1
        return RoutingContext(at: nowMs, windowId: windowId, key: key, selection: f.selection, composing: f.composing, textRevision: rev, breakpoint: breakpoint)
    }

    /// Whether a decision names this field, and if so whether the binding is tentative; nil when it
    /// does not. It does when its digest is one of the field's texts since focus came to it, it was
    /// made no earlier than `focusLeadMs` before that, and its ids are not another field's.
    private func binds(_ d: RouteDecision, _ f: Field) -> Bool? {
        guard let key = d.key, d.at >= f.focusedAtMs - Self.focusLeadMs, f.digests.contains(d.textRevision) else { return nil }
        let ids = Ids(windowId: d.windowId, key: key)
        if known.contains(where: { $0.ids == ids && $0.target != f.target && ($0.firm || d.at < f.focusedAtMs) }) { return nil }
        return d.textRevision == Self.emptyDigest || d.at < f.focusedAtMs
    }

    private static let emptyDigest = helperDigest("")

    private func apply(_ d: RouteDecision, to f: inout Field, nowMs: Int64) {
        lastContext = d.context
        f.failure = d.failure
        count(\.applied, d.outcome?.rawValue ?? "deciding")
        if d.outcome == .error {
            // The router failed for this context: its miss, counted once whether the budget ran out
            // first or not. Only a decision the router made says routing works again.
            countMiss(&f)
            f.phase = .decided(outcome: .error, route: nil, expiresMs: d.expires)
            return
        }
        // A decision that applies says routing works for the field the user is in.
        misses = 0
        unavailable = false
        if case .deciding(let since) = f.phase, d.outcome != nil { entryLatency.record(Double(nowMs - since)) }
        if let outcome = d.outcome {
            f.phase = .decided(outcome: outcome, route: d.route, expiresMs: d.expires)
        } else {
            // A breakpoint the helper saw ended the last decision; the next one follows.
            f.phase = .deciding(sinceMs: nowMs)
        }
        f.missed = false
    }

    /// The field's context missed its decision: counted once per context.
    private func countMiss(_ f: inout Field) {
        guard !f.missed else { return }
        f.missed = true
        stats.misses &+= 1
        misses += 1
        if !proven || misses >= Self.missesBeforeUnavailable { unavailable = true }
    }

    /// A field the user just focused: the newest kept decision that names it applies now.
    private func matchKept(nowMs: Int64) -> RoutingContext? {
        guard enabled, linked, let f = field else { return nil }
        for d in recent.reversed() where d.expires > nowMs && d.context >= lastContext {
            let mine = f.bound ? (d.windowId == f.windowId && d.key == f.key) : binds(d, f) != nil
            if mine { return take(d, nowMs: nowMs).1 }
        }
        return nil
    }

    private func keep(_ d: RouteDecision) {
        if recent.count >= Self.keptDecisions { recent.removeFirst() }
        recent.append(d)
    }

    private func remember(digest: String, in f: inout Field) {
        if f.digests.count >= Self.keptDigests { f.digests.removeFirst() }
        f.digests.append(digest)
    }

    private func drop(_ why: Drop) -> Receipt {
        count(\.dropped, why.rawValue)
        return .dropped(why)
    }

    private func count(_ path: WritableKeyPath<Stats, [String: UInt64]>, _ key: String) {
        stats[keyPath: path][key, default: 0] &+= 1
    }
}
