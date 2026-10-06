import CaretScreenCore
import CoreGraphics
import Foundation

// H13: inline text in a web page field, from the local ghost engine (Gemma), the way it works in a native field.
//
// The host cannot read a web field: Chrome shows Accessibility no web content (H10). The helper's page engine says
// which field has focus, the text around its caret and where the caret is (`PageField.text`, `.caret`), after every
// focus change and burst of typing. This machine decides from that alone. The coordinator generates
// (`GhostTextEngine`), measures and draws; every decision is here and tested in `PageInlineTests`.
//
// Accepting goes back through the page: Tab claims the offer, and the host asks the helper to insert the text at the
// caret (`PageInsert`), which the page does with its own editing, so the page's ⌘Z removes it. Caret claims no ⌘Z
// for it. The insert is refused unless the field still reads exactly the text before the caret the offer was made for
// (with what the user typed through since), still has focus, and is in the tab the user is in.
//
// Pages with their own Tab suggestions (Gmail's compose body; Google Docs) get no inline text from Caret by default,
// and Tab stays theirs (`OtherTabOwners.pages`). In Gmail, a quiet line says so, again on each new focus of such a field until
// the user answers it, and lets the user turn Caret on there after turning Smart Compose off. Caret never changes Gmail's or Docs' settings. Docs stays off in this batch:
// its typing target is an off-screen text box whose text Caret cannot read yet.

/// Host to helper: insert accepted inline text at a page field's caret (helper/src/protocol.ts PageInsert).
public struct PageInsert: Codable, Equatable, Sendable {
    public static let type = "pageInsert"
    public var requestId: String
    public var windowId: String
    public var key: String
    /// The text before the caret the page must read: the offer's, plus what the user typed through since.
    public var expect: String
    public var text: String
    /// The element the offer was made for (`PageField.token`); the page refuses an insert into any other.
    public var token: String
    public var at: Int64

    public init(requestId: String, windowId: String, key: String, expect: String, text: String, token: String, at: Int64) {
        self.requestId = requestId; self.windowId = windowId; self.key = key; self.expect = expect; self.text = text; self.token = token; self.at = at
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, windowId, key, expect, text, token, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId); windowId = try c.decode(String.self, forKey: .windowId)
        key = try c.decode(String.self, forKey: .key); expect = try c.decode(String.self, forKey: .expect)
        text = try c.decode(String.self, forKey: .text); token = try c.decode(String.self, forKey: .token); at = try c.decode(Int64.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(windowId, forKey: .windowId); try c.encode(key, forKey: .key)
        try c.encode(expect, forKey: .expect); try c.encode(text, forKey: .text); try c.encode(token, forKey: .token); try c.encode(at, forKey: .at)
    }
}

/// Helper to host: what became of a `PageInsert`. `says` is for the log and quotes nothing from the page.
public struct PageInsertReply: Codable, Equatable, Sendable {
    public static let type = "pageInsertReply"
    public enum Outcome: String, Codable, Sendable { case inserted, refused, failed }
    public var requestId: String
    public var outcome: Outcome
    public var says: String
    public var at: Int64

    public init(requestId: String, outcome: Outcome, says: String, at: Int64) {
        self.requestId = requestId; self.outcome = outcome; self.says = says; self.at = at
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, outcome, says, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId); outcome = try c.decode(Outcome.self, forKey: .outcome)
        says = try c.decode(String.self, forKey: .says); at = try c.decode(Int64.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(outcome, forKey: .outcome); try c.encode(says, forKey: .says); try c.encode(at, forKey: .at)
    }
}

public enum PageInline {
    /// The hello capability (protocol.ts PAGE_TEXT_CAPABILITY). Declaring it promises the helper that page text is
    /// never logged, stored, or shown on the debug socket: `DebugState.PageInlineInfo` holds lengths and outcomes only.
    public static let capability = "pageText"
    /// protocol.ts FIELD_BEFORE_MAX: the text before the caret a walk reports, in UTF-16 code units.
    public static let beforeMax = 2000

    /// The last `beforeMax` UTF-16 code units of `s`, as the page's walk cuts the text before the caret (JavaScript
    /// `slice` counts code units), so `expect` matches what the page reads.
    public static func lastUnits(_ s: String) -> String {
        let units = Array(s.utf16)
        guard units.count > beforeMax else { return s }
        return String(decoding: units.suffix(beforeMax), as: UTF16.self)
    }

    /// A page field's identity for the arbiter: its key as the element, the digest of the text around its caret as the
    /// revision. `nil` without a key, a browser pid, or text.
    public static func target(_ f: PageField) -> TargetIdentity? {
        guard let key = f.key, let pid = Int32(exactly: f.app.pid), pid > 0, let text = f.text else { return nil }
        return TargetIdentity(pid: pid, bundleID: f.app.bundleId, windowID: f.windowId, elementID: key, elementRevision: UTF16Text.digest(text.before + text.after))
    }

    /// What the debug socket's offer record may show of an offer's text and of what the user typed through: nothing for
    /// inline text in a page field, whose typed characters are the page's own text and whose suggestion is made from it
    /// (brief item 4). Every other offer as before.
    public static func debugText(_ offer: Offer, typed: String) -> (text: String, typed: String, revision: String) {
        // H13 review: the revision too, an unsalted digest of the field's text, which a guess could be checked against.
        offer.source == .page ? ("", "", "") : (String(offer.text.dropFirst(typed.count)), typed, offer.target.elementRevision)
    }

    /// Text that follows the caret on its own line, where inline text would cover it.
    public static func midLine(_ after: String) -> Bool {
        after.prefix { !$0.isNewline }.contains { !$0.isWhitespace }
    }
}

/// The choices the user made about pages with their own suggestions (`CaretSettings.pageInline`).
public struct PageInlineSettings: Codable, Equatable, Sendable {
    /// Pages (`PageField.OwnSuggestions` raw values) where the user turned Caret's inline text on.
    public var on: [String] = []
    /// Pages whose line about their own suggestions the user asked never to see again.
    public var quiet: [String] = []

    public init(on: [String] = [], quiet: [String] = []) {
        self.on = on
        self.quiet = quiet
    }

    public func isOn(_ page: PageField.OwnSuggestions) -> Bool { on.contains(page.rawValue) }
    public func isQuiet(_ page: PageField.OwnSuggestions) -> Bool { quiet.contains(page.rawValue) }

    public mutating func set(_ page: PageField.OwnSuggestions, on value: Bool) {
        var s = Set(on)
        if value { s.insert(page.rawValue) } else { s.remove(page.rawValue) }
        on = s.sorted()
    }

    public mutating func silence(_ page: PageField.OwnSuggestions) {
        quiet = Array(Set(quiet + [page.rawValue])).sorted()
    }
}

/// Every sentence about inline text on pages (`unslop`: plain words, no em dashes).
public enum PageInlineCopy {
    public static let turnOn = "Turn Caret on here"
    public static let quiet = "Don't show again"
    public static let notNow = "Not now"

    /// The page's name, as the line and the Sites tab say it.
    public static func name(_ page: PageField.OwnSuggestions) -> String {
        switch page {
        case .gmail: return "Gmail"
        case .googleDocs: return "Google Docs"
        }
    }

    /// The one quiet line at a Gmail compose body (lead decision, brief item 2), in its two sentences: the first is the
    /// line, the second wraps under it with the keys, as a result line's question does (`LineView`).
    public static let gmailSays = "Gmail suggests its own text here, and Tab accepts it."
    public static let gmailDo = "To use Caret's instead, turn off Smart Compose in Gmail's settings, then turn Caret on here."
    public static var gmail: String { "\(gmailSays) \(gmailDo)" }

    /// An insert Tab asked for did not go in: Tab is already taken, so this is never silent. The page's name only for a
    /// page Caret knows by name; the host has no other name for a page.
    public static func notTaken(_ page: PageField.OwnSuggestions?) -> LineContent {
        LineContent(figure: .error, text: "\(page.map(name) ?? "The page") didn't take it.", emphasis: .plain)
    }

    /// A Google editor whose text is off: what happened on the line, the helper's sentence (what to turn on) under it,
    /// with Esc to put it away.
    public static func sourceOff(_ app: String, says: String) -> LineContent {
        LineContent(figure: .still, text: "Caret can't read the \(app == "Google Sheets" ? "Google Sheet" : "Google Doc") you left.", emphasis: .plain,
                    question: .init(text: says, hints: [Hint(key: "Esc")]))
    }

    public static func notice(_ page: PageField.OwnSuggestions) -> LineContent {
        LineContent(figure: .still, text: gmailSays, emphasis: .plain,
                    question: .init(text: gmailDo, hints: [Hint(key: "⌘1", label: turnOn), Hint(key: "⌘2", label: quiet), Hint(key: "Esc", label: notNow)]))
    }

    // The Sites tab's group (`MemoryView.sitesList`).
    public static let sitesHead = "Pages with their own suggestions"
    public static let sitesIntro = "These pages offer their own text as you type, and Tab takes it. Caret stays quiet there unless you turn it on."
    public static func sitesState(_ on: Bool) -> String { on ? "Caret's text is on" : "Caret stays quiet" }
    public static let sitesTurnOn = "Turn on"
    public static let sitesTurnOff = "Turn off"

    /// What VoiceOver hears when a fresh suggestion appears: the ghost is drawn in a panel that takes no focus.
    public static func spoken(_ suggestion: String) -> String {
        "Suggestion: \(suggestion.trimmingCharacters(in: .whitespaces)). Tab accepts it."
    }
}

/// Decides inline text in page fields. Main thread only.
public final class PageInlineMachine {
    public enum Command: Equatable, Sendable {
        /// Generate for this context; a later request replaces it.
        case generate(Request)
        /// Drop any generation under way.
        case cancel
        /// The ghost text at `caret` (global, top-left points), in the field's size and ink (`look`).
        case drawGhost(String, caret: CGRect, look: PageField.Look?)
        case hideGhost
        /// The quiet line under `field`. `enters` on its first draw.
        case drawNotice(LineContent, field: CGRect, enters: Bool)
        case hideNotice
        /// An error line under `field`, in the slip's error style: an insert Tab asked for did not go in.
        case drawError(LineContent, field: CGRect)
        case hideError
        case send(PageInsert)
        case settings(PageInlineSettings)
        case count(String)
    }

    public struct Request: Equatable, Sendable {
        public var id: UInt64
        public var before: String
        public var after: String
        public var bundleID: String
        public var appName: String
    }

    /// Whether inline text may show at all now: ghost text allowed by the settings (not paused, the words role on),
    /// the engine ready, the browser allowed. The coordinator says.
    public struct Gate: Equatable, Sendable {
        public var allowed: Bool
        public var settings: PageInlineSettings
        public init(allowed: Bool, settings: PageInlineSettings) {
            self.allowed = allowed
            self.settings = settings
        }
    }

    /// How long an offer waits for Tab. Native ghost text uses the arbiter's default (30 s); a page's is the same.
    public static let offerAge: Double = 30
    /// How long the quiet line stays if nobody answers it. A guess, not measured: long enough to read two sentences.
    public static let noticeLifetime: Double = 20
    /// An insert the helper never answers stops being awaited.
    public static let insertWait: Double = 2
    /// An error line stays this long (DIRECTION.md 5.3, "Error": 6 s), as the save line's refusal does.
    public static let errorLifetime: Double = 6

    private let arbiter: OfferArbiter
    private let clock: SurfaceClock
    /// The width of `text` drawn at `fontSize` points, for the fit check.
    private let measure: (String, CGFloat) -> CGFloat
    public var output: (Command) -> Void = { _ in }

    /// The field the user is in, as last said.
    private var current: PageField?
    private var gate = Gate(allowed: false, settings: PageInlineSettings())
    private var requests: UInt64 = 0
    private var pending: Request?
    private struct Shown {
        var offerID: UInt64
        var text: String
        var before: String
        var after: String
        var target: TargetIdentity
        /// The walked element (`PageField.token`) the offer was made for.
        var token: String
        /// The caret as the page last reported it, and the characters typed through that report already shows.
        var caret: CGRect
        var reflected: String
        var look: PageField.Look?
    }
    private var shown: Shown?
    private var inserts = 0
    /// An insert on its way: until the page answers, a report of the field as it was before the insert offers nothing,
    /// so a stale offer is never drawn over text that is going in (H13 review).
    private var awaiting: (requestId: String, before: String, after: String, timer: SurfaceTimer)?
    /// The quiet line on screen: about a page's own suggestions (`page`), or a source Caret cannot read (nil).
    private var notice: (offerID: UInt64, page: PageField.OwnSuggestions?, key: String, timer: SurfaceTimer)?
    /// Quiet lines the user answered in this run (Not now, Turn Caret on here, Don't show again): never shown again in
    /// it. A line that timed out or was typed past is unanswered: it shows again on the next focus of such a field,
    /// never twice in one focus (`shownIn`). Keys: a page's raw value, or "sourceOff:<app>".
    private var answered: Set<String> = []
    private var shownIn: [String: String] = [:]
    private var errorTimer: SurfaceTimer?

    /// The focus a quiet line is tied to: the field and its window.
    private static func focusKey(_ f: PageField) -> String { "\(f.windowId)|\(f.key ?? "")" }

    private static func lineKey(_ page: PageField.OwnSuggestions?, app: String?) -> String {
        page.map(\.rawValue) ?? "sourceOff:\(app ?? "")"
    }

    public init(arbiter: OfferArbiter, clock: SurfaceClock, measure: @escaping (String, CGFloat) -> CGFloat) {
        self.arbiter = arbiter
        self.clock = clock
        self.measure = measure
    }

    // MARK: - Debug (lengths and states, never text)

    public private(set) var lastOutcome: String?
    public var showing: Bool { shown != nil }
    public var noticeShowing: Bool { notice != nil }

    // MARK: - Inputs

    /// The page field the user is in, after every walk of the front tab; nil when they left the page or the browser.
    public func field(_ f: PageField?, gate g: Gate) {
        let previous = current
        current = f
        gate = g
        // A new focus: every unanswered line may show again (once in it).
        if previous.map(Self.focusKey) != f.map(Self.focusKey) { shownIn.removeAll() }
        guard let f, let key = f.key, f.editable, let pid = Int32(exactly: f.app.pid), pid > 0 else {
            hideNotice()
            return clear("noField")
        }
        if let n = notice, previous?.key != key || previous?.windowId != f.windowId || f.ownSuggestions != n.page { hideNotice() }
        if let own = f.ownSuggestions, !(own == .gmail && g.settings.isOn(own)) {
            clear(own == .googleDocs ? "docs" : "ownSuggestions")
            if own == .gmail { offerNotice(own, field: f, pid: pid) }
            return
        }
        guard g.allowed else { return clear("notAllowed") }
        // H13 review: the page's document lost focus (the address bar): Tab goes to the browser, so nothing is on offer.
        if f.pageFocused == false { return clear("pageUnfocused") }
        guard let text = f.text, text.selection.isEmpty, let caretFrame = f.caret, f.frame != nil else { return clear("noText") }
        if PageInline.midLine(text.after) { return clear("midLine") }
        let caret = Self.rect(caretFrame)
        if let a = awaiting, text.before == a.before, text.after == a.after { return clear("insertPending") }
        if let s = shown {
            let snap = arbiter.snapshot()
            guard snap.current?.id == s.offerID else {
                // Tab took it a moment ago: its claim, on its way to `claimed`, sends the insert (H13 review).
                if snap.lastClaim?.offerID == s.offerID { return }
                return clear("offerGone")
            }
            if s.target.elementID == key, s.target.windowID == f.windowId, f.token == s.token, text.after == s.after, text.before.hasPrefix(s.before) {
                let reported = String(text.before.dropFirst(s.before.count))
                if s.text.hasPrefix(reported), reported.count < s.text.count, snap.typedSinceOffer.hasPrefix(reported) {
                    // The same text (a scroll, a caret report) or typed through: the rest stays on offer at the page's caret.
                    shown?.caret = caret
                    shown?.reflected = reported
                    return redraw()
                }
            }
            clear("textChanged")
        }
        if let p = pending, p.before == text.before, p.after == text.after { return }
        requests &+= 1
        let r = Request(id: requests, before: text.before, after: text.after, bundleID: f.app.bundleId, appName: f.app.name)
        pending = r
        output(.generate(r))
    }

    /// The engine's answer for request `id`: its text, or nil when it had nothing to offer (`why`).
    public func generated(_ id: UInt64, text: String?, why: String? = nil) {
        guard let r = pending, r.id == id else { return output(.count("pageInline.stale")) }
        pending = nil
        guard let text, !text.isEmpty else { return note(why.map { "suppressed.\($0)" } ?? "nothing") }
        guard let f = current, let t = PageInline.target(f), let fieldText = f.text, fieldText.before == r.before, fieldText.after == r.after,
              let caretFrame = f.caret, let frame = f.frame else { return note("stale") }
        guard let token = f.token else { return note("noToken") }
        let caret = Self.rect(caretFrame)
        let box = Self.rect(frame)
        // The ghost stays inside the field, short of its right padding (the left inset stands in for it).
        let width = measure(text, CGFloat(f.look?.fontSize ?? 13))
        guard caret.maxX + width <= box.maxX - CGFloat(f.look?.inset ?? 4) else { return note("noRoom") }
        let offer = Offer(text: text, source: .page, kind: .ghost, target: t, fieldValue: r.before + r.after,
                          caretUTF16: UTF16Text.length(r.before), createdAt: clock.now, maxAgeSeconds: Self.offerAge)
        // Published unshown, drawn, then revealed: Tab takes only text that is on screen.
        guard let id = arbiter.publish(offer, shown: false) else { return note("refused") }
        shown = Shown(offerID: id, text: text, before: r.before, after: r.after, target: t, token: token, caret: caret, reflected: "", look: f.look)
        output(.drawGhost(text, caret: caret, look: f.look))
        guard arbiter.reveal(offerID: id) else {
            shown = nil
            output(.hideGhost)
            return note("keyBeforeDrawn")
        }
        note("shown")
    }

    /// The arbiter passed a key: typing through redraws the rest at once; anything that removed the offer hides it.
    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        let snap = arbiter.snapshot()
        if let n = notice, snap.current?.id != n.offerID {
            if reason == .closed { answered.insert(n.key) }
            hideNotice()
        }
        guard let s = shown else { return }
        guard snap.current?.id == s.offerID else {
            shown = nil
            output(.hideGhost)
            return
        }
        if reason == .typedThrough { redraw() }
    }

    /// The rest of the offer after what was typed through, at the page's last caret moved by what it does not show yet
    /// (measured in the field's size until the page's next report places it exactly).
    private func redraw() {
        guard let s = shown else { return }
        let typed = arbiter.snapshot().typedSinceOffer
        let unreported = typed.hasPrefix(s.reflected) ? String(typed.dropFirst(s.reflected.count)) : ""
        let shift = unreported.isEmpty ? 0 : measure(unreported, CGFloat(s.look?.fontSize ?? 13))
        output(.drawGhost(String(s.text.dropFirst(typed.count)), caret: s.caret.offsetBy(dx: shift, dy: 0), look: s.look))
    }

    /// Tab (or ⌥→) took the offer, or a key took the quiet line's action.
    public func claimed(_ claim: Claim) {
        if let n = notice, claim.offer.id == n.offerID, let page = n.page {
            var settings = gate.settings
            switch claim.choice.actionID {
            case "turnOn":
                settings.set(page, on: true)
                note("notice.turnOn")
            case "quiet":
                settings.silence(page)
                note("notice.quiet")
            default: return
            }
            answered.insert(n.key)
            hideNotice()
            gate.settings = settings
            output(.settings(settings))
            // Turned on: the field the user is in gets inline text now, as if it had just been reported.
            field(current, gate: gate)
            return
        }
        guard let s = shown, claim.offer.id == s.offerID, case .ghost = claim.offer.kind else { return }
        shown = nil
        output(.hideGhost)
        // The field the page last reported must still be the one the offer was made for; the page checks its text.
        guard let f = current, f.windowId == s.target.windowID, f.key == s.target.elementID, f.token == s.token, Int32(exactly: f.app.pid) == s.target.pid else {
            note("insert.fieldMoved")
            return sayNotTaken()
        }
        inserts += 1
        let requestId = "inline-\(inserts)"
        let expect = PageInline.lastUnits(s.before + claim.typedSinceOffer)
        output(.send(PageInsert(requestId: requestId, windowId: s.target.windowID, key: s.target.elementID,
                                expect: expect, text: claim.insertionText, token: s.token,
                                at: Int64(clock.now.timeIntervalSince1970 * 1000))))
        note("insert.sent")
        awaiting?.timer.cancel()
        let timer = clock.schedule(after: Self.insertWait, repeats: false) { [weak self] in
            guard let self, self.awaiting?.requestId == requestId else { return }
            self.awaiting = nil
            self.note("insert.unanswered")
            self.sayNotTaken()
        }
        awaiting = (requestId, expect, s.after, timer)
    }

    public func replied(_ r: PageInsertReply) {
        guard let a = awaiting, a.requestId == r.requestId else { return }
        a.timer.cancel()
        awaiting = nil
        note("insert.\(r.outcome.rawValue)")
        if r.outcome != .inserted { sayNotTaken() }
    }

    /// One error line at the field the user is in, for the error's time (Tab was taken and nothing went in).
    private func sayNotTaken() {
        guard let f = current, let frame = f.frame else { return }
        errorTimer?.cancel()
        output(.drawError(PageInlineCopy.notTaken(f.ownSuggestions), field: Self.rect(frame)))
        errorTimer = clock.schedule(after: Self.errorLifetime, repeats: false) { [weak self] in
            self?.errorTimer = nil
            self?.output(.hideError)
        }
    }

    /// Another offer took the browser's keys.
    public func displaced(_ offer: Offer) {
        if let n = notice, n.offerID == offer.id { hideNotice() }
        if let s = shown, s.offerID == offer.id {
            shown = nil
            output(.hideGhost)
        }
    }

    /// Ghost text was turned off (pause, the words role): what is shown goes now.
    public func gateClosed() {
        gate.allowed = false
        clear("notAllowed")
    }

    // MARK: - A source Caret cannot read (brief item 3)


    /// A fill found nothing because the tab the user left is `app` with its text for assistive technology off. The
    /// helper's sentence says what to turn on; it shows as a quiet line at the page field the user is in (Esc puts it
    /// away, Tab stays the page's), where the fill would have appeared, rather than nothing at all.
    public func sourceOff(_ app: String, says: String) {
        guard notice == nil, let f = current, f.key != nil, let frame = f.frame, let pid = Int32(exactly: f.app.pid), pid > 0 else { return note("sourceOff.noField") }
        let key = Self.lineKey(nil, app: app)
        if answered.contains(key) || shownIn[key] == Self.focusKey(f) { return note("sourceOff.quiet") }
        if let other = arbiter.snapshot().current, other.target.pid == pid { return note("sourceOff.yielded") }
        let line = ActionLine(offerKey: "pageInline.sourceOff", app: "", endState: PopupSpec.Value(says, ref: .derived(rule: "pageInline", from: [])), actions: [])
        let target = TargetIdentity(pid: pid, bundleID: f.app.bundleId, windowID: f.windowId, elementID: "pageInline.sourceOff", elementRevision: "")
        guard let id = arbiter.publish(Offer(text: "", source: .page, kind: .action(line), target: target, fieldValue: "", caretUTF16: 0,
                                             createdAt: clock.now, maxAgeSeconds: Self.noticeLifetime), shown: false) else { return note("sourceOff.refused") }
        shownIn[key] = Self.focusKey(f)
        output(.drawNotice(PageInlineCopy.sourceOff(app, says: says), field: Self.rect(frame), enters: true))
        guard arbiter.reveal(offerID: id) else {
            output(.hideNotice)
            return note("sourceOff.keyBeforeDrawn")
        }
        let timer = clock.schedule(after: Self.noticeLifetime, repeats: false) { [weak self] in
            guard let self, self.notice?.offerID == id else { return }
            self.arbiter.invalidate(offerID: id)
            self.hideNotice()
        }
        notice = (id, nil, key, timer)
        note("sourceOff.shown")
    }

    // MARK: - The quiet line

    private func offerNotice(_ page: PageField.OwnSuggestions, field f: PageField, pid: Int32) {
        let key = Self.lineKey(page, app: nil)
        guard notice == nil, !answered.contains(key), shownIn[key] != Self.focusKey(f), !gate.settings.isQuiet(page), let frame = f.frame else { return }
        // Never over another offer in the browser.
        if let current = arbiter.snapshot().current, current.target.pid == pid { return }
        let line = ActionLine(offerKey: "pageInline.\(page.rawValue)", app: "", endState: PopupSpec.Value(PageInlineCopy.gmail, ref: .derived(rule: "pageInline", from: [])),
                              actions: [PopupSpec.Action(id: "turnOn", label: PageInlineCopy.turnOn, key: .cmd1),
                                        PopupSpec.Action(id: "quiet", label: PageInlineCopy.quiet, key: .cmd2)])
        let target = TargetIdentity(pid: pid, bundleID: f.app.bundleId, windowID: f.windowId, elementID: "pageInline.notice", elementRevision: "")
        guard let id = arbiter.publish(Offer(text: "", source: .page, kind: .action(line), target: target, fieldValue: "", caretUTF16: 0,
                                             createdAt: clock.now, maxAgeSeconds: Self.noticeLifetime), shown: false) else { return note("notice.refused") }
        shownIn[key] = Self.focusKey(f)
        output(.drawNotice(PageInlineCopy.notice(page), field: Self.rect(frame), enters: true))
        guard arbiter.reveal(offerID: id) else {
            output(.hideNotice)
            return note("notice.keyBeforeDrawn")
        }
        let timer = clock.schedule(after: Self.noticeLifetime, repeats: false) { [weak self] in
            guard let self, self.notice?.offerID == id else { return }
            self.arbiter.invalidate(offerID: id)
            self.hideNotice()
        }
        notice = (id, page, key, timer)
        note("notice.shown")
    }

    private func hideNotice() {
        guard let n = notice else { return }
        notice = nil
        n.timer.cancel()
        if arbiter.snapshot().current?.id == n.offerID { arbiter.invalidate(offerID: n.offerID) }
        output(.hideNotice)
    }

    // MARK: - Helpers

    private func clear(_ why: String) {
        if pending != nil {
            pending = nil
            output(.cancel)
        }
        if let s = shown {
            shown = nil
            if arbiter.snapshot().current?.id == s.offerID { arbiter.invalidate(offerID: s.offerID) }
            output(.hideGhost)
        }
        lastOutcome = why
    }

    private func note(_ outcome: String) {
        lastOutcome = outcome
        output(.count("pageInline.\(outcome)"))
    }

    static func rect(_ f: Frame) -> CGRect { CGRect(x: f.x, y: f.y, width: f.width, height: f.height) }
}
