import CaretScreenCore
import Foundation

/// The host's side of memory and permissions: the helper's entries as last listed, the requests in
/// flight, the one edit open at a time, a forget waiting for its confirmation, and values the user
/// typed for the helper to keep. The memory window (`MemoryWindow`) draws `state` through
/// `MemoryPage` and turns clicks and keys into these calls; the debug socket makes the same calls.
///
/// Every read and write goes through `memoryRequest`; the helper stays the authority. A change is
/// shown once the helper's reply carries the entry, never before, and the list is read again after
/// every change, because one entry's sentence can name another's value (a use-instead preference
/// quotes its About-you entry).
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class MemoryBook {
    /// A request the helper never answers stops holding its row after this long. Assumed, as the
    /// activity list's control timeout.
    public static let answerTimeout: TimeInterval = 3

    public enum Op: String, Codable, Sendable {
        case list, edit, rule, pause, resume, forget, add, backOnTab, onItsOwn
        /// M1: "Not right" about a noticed fact (`memoryNotRight`), from its row or from an offer.
        case notRight
        /// M1: "Keep" on a noticed fact: an edit that sends its values unchanged, which the helper
        /// takes as the user's own word (memory.ts `edit`: "no longer something Caret only noticed").
        case keep
    }

    /// "Not right" open on a noticed row: what the user is typing instead, or nothing to type when the
    /// fact is a preference, which can only be forgotten.
    public struct Correction: Equatable, Sendable {
        public var entryId: String
        public var text = ""
        public var correctable: Bool
        public var sending = false
        public var problem: String?
    }

    /// The helper's offer to let a skill run on its own, asked for from the skill's row ("Let it run
    /// on its own…", B22): shown on that row until the user answers it or the helper takes it back.
    public struct OnItsOwnQuestion: Equatable, Sendable {
        /// The helper's `skillOffer` id, named by the answer.
        public var offerId: String
        public var says: String
        public var detail: String
        public var accept: String
        public var decline: String
        /// The user said yes and the helper has not confirmed it yet.
        public var answering = false
    }

    /// A value the user typed for the helper to keep (onboarding's name and email). Held here, in
    /// memory only, until the helper confirms it; sent again on each connect until then.
    public struct Typed: Equatable, Sendable, Identifiable {
        public enum Phase: Equatable, Sendable {
            /// Not sent on this connection yet, or sent and not answered in time.
            case waiting
            case sending(requestId: String)
            /// The helper refused it, in its words. Not sent again; the user can remove it.
            case refused(String)
        }

        public var id: String
        public var label: String
        public var value: String
        public var phase: Phase
    }

    /// One field of an open edit.
    public struct Draft: Equatable, Sendable {
        /// The helper's field name.
        public var key: String
        public var title: String
        public var text: String
        public var original: String
    }

    public struct Editor: Equatable, Sendable {
        public var entryId: String
        public var fields: [Draft]
        /// Why Save did not go through: the host's check, or the helper's refusal.
        public var problem: String?
        public var saving = false
    }

    public struct State: Equatable, Sendable {
        public var connected = false
        /// A list reply has arrived since the last connect.
        public var loaded = false
        public var entries: [HelperMemory.Entry] = []
        /// Entries in the last list this host could not read.
        public var unreadable = 0
        /// Entries with a request in flight, and which.
        public var busy: [String: Op] = [:]
        /// The last refusal per entry, shown on its row until the next change to it.
        public var problems: [String: String] = [:]
        /// The helper's own words for a refusal the row rewords, for the debug state.
        public var refusals: [String: String] = [:]
        /// Why the list could not be read.
        public var listProblem: String?
        public var editor: Editor?
        /// The entry whose Forget is waiting for the user to confirm.
        public var confirmingForget: String?
        public var typed: [Typed] = []
        /// The entry the helper just confirmed a change to: its row flashes once.
        public var changed: String?
        /// The last list reply said the helper keeps typed values (`HelperMemory.Reply.acceptsAdd`).
        /// Kept across a dropped connection: the helper that comes back is the same build.
        public var acceptsAdd = false
        /// The last list reply said the helper offers running on its own when a skill's row asks
        /// (`HelperMemory.Reply.offersOnItsOwn`). Kept across a dropped connection, as `acceptsAdd`.
        public var offersOnItsOwn = false
        /// Open offers to let a skill run on its own, by the skill's entry id.
        public var questions: [String: OnItsOwnQuestion] = [:]
        /// The noticed row whose "Not right" is open.
        public var correcting: Correction?

        public init() {}
    }

    private struct Pending {
        var op: Op
        var entryId: String?
        var typedId: String?
        var timer: SurfaceTimer
        /// An offer's "Not right" is told how it went: nil when the helper made the change, else why not.
        var answered: ((String?) -> Void)? = nil
    }

    public private(set) var state = State()
    /// Writes one request to the helper; false when it is not connected.
    public var send: (HelperMemory.Request) -> Bool = { _ in false }
    /// After every change to `state`.
    public var onChange: () -> Void = {}
    /// An entry's value changed or stopped being usable: the helper accepted an edit, pause, forget
    /// or an add that replaced a value, or a list shows such a change the book had not heard of. A
    /// fill held from before then must not offer the old value (`FillMachine.memoryChanged`).
    public var onEntryChanged: (String) -> Void = { _ in }

    let clock: SurfaceClock
    private let prefix: String
    private var pending: [String: Pending] = [:]
    /// The skill each "Let it run on its own…" request was for, by request id: the helper's offer
    /// names the request as its `taskId`, and may arrive before or after the reply.
    private var asked: [String: String] = [:]
    /// Writes the user's answer to an offer; false when it is not connected.
    public var sendAnswer: (SkillAnswer) -> Bool = { _ in false }
    /// Writes a "Not right"; false when it is not connected.
    public var sendNotRight: (MemoryNotRight) -> Bool = { _ in false }
    private var requests = 0
    private var typedCount = 0
    /// Adds whose typed value the user dropped (Skip) while they were on their way. Whatever the
    /// helper kept from one is forgotten when its reply comes (CodeRabbit on PR #8).
    private var droppedAdds: Set<String> = []
    /// The last requests sent, "op:id", for the debug state.
    public private(set) var sentLog: [String] = []

    public init(clock: SurfaceClock, prefix: String = "host-memory") {
        self.clock = clock
        self.prefix = prefix
    }

    // MARK: - The link

    public func linkChanged(_ up: Bool) {
        state.connected = up
        if up {
            requestList()
            flushTyped()
        } else {
            // The helper's answers to anything in flight are gone with the connection. What it
            // listed stays on screen, read only, until the next list.
            for p in pending.values {
                p.timer.cancel()
                p.answered?(MemoryCheck.offline)
            }
            state.correcting?.sending = false
            pending.removeAll()
            state.busy.removeAll()
            state.loaded = false
            state.editor?.saving = false
            // The helper's open offers end with the connection; an answer could reach no one.
            asked.removeAll()
            state.questions.removeAll()
            for i in state.typed.indices where state.typed[i].phase.isSending { state.typed[i].phase = .waiting }
        }
        changed()
    }

    // MARK: - Replies

    /// A `memoryReply`. Replies to requests this book did not send are ignored.
    public func receive(_ reply: HelperMemory.Reply) {
        guard let p = pending.removeValue(forKey: reply.requestId) else { return }
        p.timer.cancel()
        if let id = p.entryId { state.busy[id] = nil }
        let dropped = droppedAdds.remove(reply.requestId) != nil
        if let error = reply.error {
            refused(p, error)
            return changed()
        }
        switch p.op {
        case .list:
            // A change whose own reply came too late (`timedOut` ignores it) shows up here: an entry
            // gone, paused, or holding other values than the book last had.
            let listed = Dictionary(reply.entries.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for old in state.entries {
                guard let now = listed[old.id] else { onEntryChanged(old.id); continue }
                if now.fields != old.fields || (old.status == .active && now.status != .active) { onEntryChanged(old.id) }
            }
            state.entries = reply.entries
            state.unreadable = reply.unreadable.count
            state.acceptsAdd = reply.acceptsAdd
            state.offersOnItsOwn = reply.offersOnItsOwn
            state.loaded = true
            state.listProblem = nil
            let ids = Set(reply.entries.map(\.id))
            state.problems = state.problems.filter { ids.contains($0.key) }
            state.questions = state.questions.filter { ids.contains($0.key) }
            if let e = state.editor, !ids.contains(e.entryId) { state.editor = nil }
            if let f = state.confirmingForget, !ids.contains(f) { state.confirmingForget = nil }
            // A noticed fact confirmed or forgotten elsewhere (an offer taken, the file edited) has nothing left to correct.
            if let c = state.correcting, !c.sending, reply.entries.first(where: { $0.id == c.entryId })?.status != .noticed { state.correcting = nil }
        case .notRight:
            guard let id = p.entryId else { break }
            // Every offer that used the fact is stale now; the helper withdraws them, and a fill held
            // here must not offer the old value either.
            onEntryChanged(id)
            if let entry = reply.entries.first(where: { $0.id == id }), let i = state.entries.firstIndex(where: { $0.id == id }) {
                state.entries[i] = entry
                state.changed = id
            } else if reply.entries.isEmpty {
                state.entries.removeAll { $0.id == id }
            }
            state.problems[id] = nil
            if state.correcting?.entryId == id { state.correcting = nil }
            p.answered?(nil)
            requestList()
        case .edit, .rule, .pause, .resume, .backOnTab, .keep:
            guard let id = p.entryId else { break }
            if p.op == .edit || p.op == .pause { onEntryChanged(id) }
            if let entry = reply.entries.first(where: { $0.id == id }), let i = state.entries.firstIndex(where: { $0.id == id }) {
                state.entries[i] = entry
            }
            state.problems[id] = nil
            if state.editor?.entryId == id { state.editor = nil }
            state.changed = id
            requestList()
        case .forget:
            guard let id = p.entryId else { break }
            onEntryChanged(id)
            state.entries.removeAll { $0.id == id }
            state.problems[id] = nil
            if state.editor?.entryId == id { state.editor = nil }
            requestList()
        case .add:
            // A second add with the same label replaces that entry's value (protocol.ts MemoryRequest).
            for entry in reply.entries { onEntryChanged(entry.id) }
            // Dropped while it was sent: the user kept none of it, so what the helper stored goes.
            if dropped {
                for entry in reply.entries { _ = post(HelperMemory.Request(requestId: nextId(), op: .forget, id: entry.id), op: .forget, entryId: entry.id) }
            }
            state.typed.removeAll { $0.id == p.typedId }
            requestList()
        case .onItsOwn:
            // The skill comes back unchanged; the offer is the helper's `skillOffer` (`claim`).
            break
        }
        changed()
    }

    private func refused(_ p: Pending, _ error: String) {
        switch p.op {
        case .list:
            state.listProblem = error
        case .add:
            if let i = state.typed.firstIndex(where: { $0.id == p.typedId }) { state.typed[i].phase = .refused(error) }
        case .backOnTab:
            guard let id = p.entryId else { return }
            // The helper's words name a schema key, not something the user can act on; they stay in
            // the debug state.
            state.problems[id] = MemoryCheck.backOnTabRefused
            state.refusals[id] = error
        case .onItsOwn:
            // skills.ts requestPromote's reasons are sentences for people ("Order to Tracker is
            // paused; resume it first"), so the row shows them as they are.
            asked = asked.filter { $0.value != p.entryId }
            guard let id = p.entryId else { return }
            state.problems[id] = MemoryCheck.sentence(error)
        case .notRight:
            p.answered?(MemoryCheck.sentence(error))
            guard let id = p.entryId else { return }
            state.problems[id] = MemoryCheck.sentence(error)
            if state.correcting?.entryId == id {
                state.correcting?.problem = MemoryCheck.sentence(error)
                state.correcting?.sending = false
            }
        case .edit, .rule, .pause, .resume, .forget, .keep:
            guard let id = p.entryId else { return }
            state.problems[id] = error
            if state.editor?.entryId == id {
                state.editor?.problem = error
                state.editor?.saving = false
            }
        }
    }

    private func timedOut(_ requestId: String) {
        guard let p = pending.removeValue(forKey: requestId) else { return }
        droppedAdds.remove(requestId)
        let message = "Caret didn't answer. Try again."
        switch p.op {
        case .list:
            state.listProblem = message
        case .add:
            // Today's helper refuses `add` without naming the request, so silence is the usual
            // answer: the value waits for the next connection.
            if let i = state.typed.firstIndex(where: { $0.id == p.typedId }) { state.typed[i].phase = .waiting }
        case .edit, .rule, .pause, .resume, .forget, .backOnTab, .onItsOwn, .notRight, .keep:
            p.answered?(message)
            guard let id = p.entryId else { break }
            state.busy[id] = nil
            if state.correcting?.entryId == id {
                state.correcting?.problem = message
                state.correcting?.sending = false
            }
            // An offer that came without its reply still stands; one that never came is not waited for.
            if p.op == .onItsOwn, state.questions[id] != nil { break }
            if p.op == .onItsOwn { asked = asked.filter { $0.value != id } }
            state.problems[id] = message
            if state.editor?.entryId == id {
                state.editor?.problem = message
                state.editor?.saving = false
            }
            // The change may still have been made: a late reply is ignored, so the list says
            // what the helper holds.
            requestList()
        }
        changed()
    }

    // MARK: - Asking

    /// Reads every entry again. One list at a time; a second call while one is out does nothing.
    public func requestList() {
        guard !pending.values.contains(where: { $0.op == .list }) else { return }
        if !post(HelperMemory.Request(requestId: nextId(), op: .list), op: .list) {
            state.listProblem = state.connected ? "Caret couldn't ask for its memory." : nil
        }
    }

    /// False when the request could not be written.
    @discardableResult
    private func post(_ request: HelperMemory.Request, op: Op, entryId: String? = nil, typedId: String? = nil) -> Bool {
        track(request.requestId, op: op, entryId: entryId, typedId: typedId) { send(request) }
    }

    /// Writes one request with `write` and waits for its reply under `requestId`.
    private func track(_ requestId: String, op: Op, entryId: String? = nil, typedId: String? = nil, answered: ((String?) -> Void)? = nil, write: () -> Bool) -> Bool {
        guard state.connected, write() else { return false }
        sentLog.append([op.rawValue, entryId ?? typedId].compactMap { $0 }.joined(separator: ":"))
        if sentLog.count > 30 { sentLog.removeFirst(sentLog.count - 30) }
        let timer = clock.schedule(after: Self.answerTimeout, repeats: false) { [weak self] in self?.timedOut(requestId) }
        pending[requestId] = Pending(op: op, entryId: entryId, typedId: typedId, timer: timer, answered: answered)
        if let entryId { state.busy[entryId] = op }
        return true
    }

    private func nextId() -> String {
        requests += 1
        return "\(prefix)-\(requests)"
    }

    private func entry(_ id: String) -> HelperMemory.Entry? { state.entries.first { $0.id == id } }

    /// An entry that can take a request now: connected, listed on this connection (what is shown
    /// after a reconnect may be out of date until then), nothing in flight for it.
    private func ready(_ id: String) -> HelperMemory.Entry? {
        guard state.connected, state.loaded, state.busy[id] == nil, let e = entry(id) else { return nil }
        return e
    }

    // MARK: - Pause, resume, forget

    /// False when nothing was sent: not connected, busy, unknown, or a permission (which has a
    /// rule instead).
    @discardableResult
    public func pause(_ id: String) -> Bool { setPaused(id, true) }

    @discardableResult
    public func resume(_ id: String) -> Bool { setPaused(id, false) }

    private func setPaused(_ id: String, _ paused: Bool) -> Bool {
        guard let e = ready(id), e.kind != .permission, e.kind != .unrecognized, (e.status == .paused) != paused else { return false }
        let op: Op = paused ? .pause : .resume
        state.problems[id] = nil
        let sent = post(HelperMemory.Request(requestId: nextId(), op: paused ? .pause : .resume, id: id), op: op, entryId: id)
        changed()
        return sent
    }

    /// Forget asks first, on the row itself: the helper cannot bring an entry back, and a
    /// forgotten routine is not relearned for 30 days.
    public func askToForget(_ id: String) {
        guard let e = ready(id), e.kind != .permission else { return }
        state.confirmingForget = id
        if state.editor?.entryId == id { state.editor = nil }
        changed()
    }

    public func keep() {
        state.confirmingForget = nil
        changed()
    }

    @discardableResult
    public func confirmForget() -> Bool {
        guard let id = state.confirmingForget else { return false }
        state.confirmingForget = nil
        defer { changed() }
        guard ready(id) != nil else { return false }
        state.problems[id] = nil
        return post(HelperMemory.Request(requestId: nextId(), op: .forget, id: id), op: .forget, entryId: id)
    }

    // MARK: - Edit

    /// The fields the user may change in an entry, as the helper's edit accepts them. Empty when
    /// the entry has nothing to edit (permissions take a rule; use-instead and don't-offer
    /// preferences can only be forgotten).
    public static func editable(_ e: HelperMemory.Entry) -> [Draft] {
        func d(_ key: String, _ title: String, _ text: String) -> Draft { Draft(key: key, title: title, text: text, original: text) }
        switch e.fields {
        case .about(let f): return [d("label", "Label", f.label), d("value", "Value", f.value)]
        case .people(let f): return [d("alias", "Written as", f.alias), d("name", "Means", f.name)]
        case .preference(.format(let template)): return [d("template", "Format", template)]
        case .preference: return []
        case .routine(let f): return [d("name", "Name", f.name ?? "")]
        case .skill(let f): return [d("name", "Name", f.name)]
        case .permission, .unrecognized: return []
        }
    }

    public func beginEdit(_ id: String) {
        guard let e = ready(id) else { return }
        let fields = Self.editable(e)
        guard !fields.isEmpty else { return }
        state.editor = Editor(entryId: id, fields: fields)
        state.confirmingForget = nil
        changed()
    }

    /// Refused while the edit is being saved: the reply closes the edit, and later typing would be lost.
    public func updateDraft(_ key: String, _ text: String) {
        guard state.editor?.saving == false, let i = state.editor?.fields.firstIndex(where: { $0.key == key }) else { return }
        state.editor?.fields[i].text = text
        state.editor?.problem = nil
        changed()
    }

    public func cancelEdit() {
        guard state.editor != nil else { return }
        state.editor = nil
        changed()
    }

    /// Checks the draft the way the helper's schema will, and sends only what changed. Nothing
    /// changed closes the edit. False when nothing was sent.
    @discardableResult
    public func saveEdit() -> Bool {
        guard var editor = state.editor, !editor.saving, let e = entry(editor.entryId) else { return false }
        defer { changed() }
        if let problem = MemoryCheck.problem(kind: e.kind, editor.fields) {
            state.editor?.problem = problem
            return false
        }
        var fields: [String: HelperMemory.FieldValue] = [:]
        for f in editor.fields where f.text.trimmed != f.original {
            let text = f.text.trimmed
            // A routine's name cleared goes back to the sentence the helper writes for it.
            fields[f.key] = text.isEmpty && e.kind == .routine ? .null : .text(text)
        }
        guard !fields.isEmpty else {
            state.editor = nil
            return false
        }
        guard state.connected, state.loaded, state.busy[e.id] == nil else {
            state.editor?.problem = state.connected && state.loaded ? nil : MemoryCheck.offline
            return false
        }
        editor.saving = true
        editor.problem = nil
        state.editor = editor
        state.problems[e.id] = nil
        let sent = post(HelperMemory.Request(requestId: nextId(), op: .edit, id: e.id, fields: fields), op: .edit, entryId: e.id)
        if !sent {
            state.editor?.saving = false
            state.editor?.problem = MemoryCheck.offline
        }
        return sent
    }

    // MARK: - Noticed facts (M1)

    /// "Not right" on a noticed row: opens a field for what is right (an About value or a person's
    /// name), or just Forget for a preference, which the helper can only forget.
    public func beginNotRight(_ id: String) {
        guard let e = ready(id), e.status == .noticed else { return }
        state.editor = nil
        state.confirmingForget = nil
        state.correcting = Correction(entryId: id, correctable: e.kind != .preference)
        changed()
    }

    public func updateCorrection(_ text: String) {
        guard state.correcting?.sending == false else { return }
        state.correcting?.text = text
        state.correcting?.problem = nil
        changed()
    }

    public func cancelNotRight() {
        guard state.correcting != nil else { return }
        state.correcting = nil
        changed()
    }

    /// Sends the open "Not right": `forget`, or the typed correction. False when nothing was sent;
    /// the row says why.
    @discardableResult
    public func sendCorrection(forget: Bool) -> Bool {
        guard var c = state.correcting, !c.sending else { return false }
        defer { changed() }
        var correction: String?
        if !forget {
            let text = c.text.trimmed
            if let problem = MemoryCheck.correctionProblem(text, correctable: c.correctable) {
                state.correcting?.problem = problem
                return false
            }
            correction = text
        }
        guard ready(c.entryId) != nil else {
            state.correcting?.problem = MemoryCheck.offline
            return false
        }
        let message = MemoryNotRight(requestId: nextId(), memoryId: c.entryId, offerKey: nil, correction: correction)
        guard track(message.requestId, op: .notRight, entryId: c.entryId, write: { sendNotRight(message) }) else {
            state.correcting?.problem = MemoryCheck.offline
            return false
        }
        c.sending = true
        c.problem = nil
        state.correcting = c
        state.problems[c.entryId] = nil
        return true
    }

    /// "Not right" on an offer, about one fact its provenance named. The fact need not be listed here
    /// yet: Caret may have noticed it since the last list. `answered` hears nil when the helper made
    /// the change, else the reason in a sentence. False when nothing was sent.
    @discardableResult
    public func notRight(memoryId: String, offerKey: String, correction: String?, answered: @escaping (String?) -> Void) -> Bool {
        guard state.busy[memoryId] == nil else { return false }
        if let correction, MemoryCheck.correctionProblem(correction, correctable: true) != nil { return false }
        let message = MemoryNotRight(requestId: nextId(), memoryId: memoryId, offerKey: offerKey, correction: correction)
        let sent = track(message.requestId, op: .notRight, entryId: memoryId, answered: answered) { sendNotRight(message) }
        changed()
        return sent
    }

    /// "Keep" on a noticed row: the fact's own values, sent back as the user's edit, make it active.
    /// Only where there is something an edit accepts (not a use-instead or don't-offer preference).
    @discardableResult
    public func keepNoticed(_ id: String) -> Bool {
        guard let e = ready(id), e.status == .noticed else { return false }
        let values = Self.editable(e)
        guard !values.isEmpty else { return false }
        state.problems[id] = nil
        defer { changed() }
        let fields = Dictionary(values.map { ($0.key, HelperMemory.FieldValue.text($0.original)) }, uniquingKeysWith: { a, _ in a })
        return post(HelperMemory.Request(requestId: nextId(), op: .edit, id: id, fields: fields), op: .keep, entryId: id)
    }

    // MARK: - Skills

    /// "Put back on Tab": a skill that runs on its own asks first again, from its next run. Sent as an
    /// edit of `onItsOwn` (the host's contract; B19's helper refuses it, see `HelperMemory`). False when
    /// nothing was sent: not connected, busy, not a skill, or already on Tab.
    @discardableResult
    public func backOnTab(_ id: String) -> Bool {
        guard let e = ready(id), e.skill?.onItsOwn == true else { return false }
        state.problems[id] = nil
        defer { changed() }
        return post(HelperMemory.Request(requestId: nextId(), op: .edit, id: id, fields: ["onItsOwn": .bool(false)]), op: .backOnTab, entryId: id)
    }

    /// "Let it run on its own…" on a skill on Tab: asks the helper for its offer to let the skill run
    /// without Tab (memoryRequest `offerOnItsOwn`, B22). The offer shows on the row (`claim`), and only
    /// the user's yes to it changes the skill. False when nothing was sent: not connected, busy, the
    /// helper does not offer this, or the skill is paused, on its own, hands a press to the user or
    /// already has the question open.
    @discardableResult
    public func letRunOnItsOwn(_ id: String) -> Bool {
        guard let e = ready(id), MemoryPage.mayAskOnItsOwn(e, state) else { return false }
        state.problems[id] = nil
        defer { changed() }
        let request = HelperMemory.Request(requestId: nextId(), op: .offerOnItsOwn, id: id)
        guard post(request, op: .onItsOwn, entryId: id) else { return false }
        asked[request.requestId] = id
        return true
    }

    /// A `skillOffer`. True when it answers this book's "Let it run on its own…" request, which the
    /// row then shows; false leaves it to the line under a run (`SurfaceMachine.skillOffer`).
    public func claim(_ offer: SkillOffer) -> Bool {
        guard offer.kind == .promote, let id = asked.removeValue(forKey: offer.taskId), offer.skillId == id else { return false }
        let accept = offer.actions.first { $0.id == "accept" }?.label ?? "Yes"
        let decline = offer.actions.first { $0.id == "decline" }?.label ?? "No"
        state.questions[id] = OnItsOwnQuestion(offerId: offer.id, says: offer.says, detail: offer.detail, accept: accept, decline: decline)
        state.problems[id] = nil
        changed()
        return true
    }

    /// The user's answer on the row. A no closes the question at once; a yes waits for the helper
    /// to take the offer (`withdrawn`), and the list read after it shows the skill on its own.
    @discardableResult
    public func answerOnItsOwn(_ id: String, accept: Bool) -> Bool {
        guard var q = state.questions[id], !q.answering else { return false }
        defer { changed() }
        guard sendAnswer(SkillAnswer(id: q.offerId, answer: accept ? .accept : .decline, at: Int64(clock.now.timeIntervalSince1970 * 1000))) else {
            state.problems[id] = MemoryCheck.offline
            return false
        }
        guard accept else {
            state.questions[id] = nil
            return true
        }
        q.answering = true
        state.questions[id] = q
        state.busy[id] = .onItsOwn
        let offerId = q.offerId
        // The helper's `taken` normally comes at once; if it never does, the list says what it holds.
        _ = clock.schedule(after: Self.answerTimeout, repeats: false) { [weak self] in
            guard let self, self.state.questions[id]?.offerId == offerId else { return }
            self.state.questions[id] = nil
            self.state.busy[id] = nil
            self.requestList()
            self.changed()
        }
        return true
    }

    /// An `offerWithdrawn`. True when it ends a row's question: taken after a yes reads the list
    /// again; any other ending before an answer closes the question and says so.
    @discardableResult
    public func withdrawn(_ w: OfferWithdrawn) -> Bool {
        guard let open = state.questions.first(where: { $0.value.offerId == w.id }) else { return false }
        let (id, q) = (open.key, open.value)
        state.questions[id] = nil
        state.busy[id] = nil
        if q.answering || w.reason == .taken {
            state.changed = id
            requestList()
        } else if w.reason != .dismissed {
            state.problems[id] = MemoryCheck.onItsOwnEnded
        }
        changed()
        return true
    }

    // MARK: - Permissions

    /// Changes an action type's rule. A rule the table does not allow is refused here and never
    /// sent; the helper checks again. False when nothing was sent.
    @discardableResult
    public func setRule(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule) -> Bool {
        guard let e = state.entries.first(where: { $0.permission?.action == action }), let current = e.permission else { return false }
        defer { changed() }
        guard PermissionPolicy.permits(action, rule), !current.fixed || rule == current.rule else {
            state.problems[e.id] = MemoryCheck.ruleRefused(action, rule)
            return false
        }
        guard rule != current.rule, ready(e.id) != nil else { return false }
        state.problems[e.id] = nil
        return post(HelperMemory.Request(requestId: nextId(), op: .edit, id: e.id, fields: ["rule": .text(rule.rawValue)]), op: .rule, entryId: e.id)
    }

    // MARK: - Typed values

    /// Values the user typed for the helper to keep. A value for a label not kept yet is replaced:
    /// one value per label waits. If the old one is being sent, its reply no longer touches the new.
    public func remember(_ items: [TypedAbout]) {
        for item in items {
            let value = item.value.trimmed
            guard !value.isEmpty else { continue }
            if let i = state.typed.firstIndex(where: { $0.label == item.label }) {
                if case .sending(let requestId) = state.typed[i].phase { pending[requestId]?.typedId = nil }
                state.typed[i].value = value
                state.typed[i].phase = .waiting
            } else {
                typedCount += 1
                state.typed.append(Typed(id: "typed-\(typedCount)", label: item.label, value: value, phase: .waiting))
            }
        }
        flushTyped()
        changed()
    }

    /// Removes a typed value that has not been kept yet.
    public func dropTyped(_ id: String) {
        for t in state.typed where t.id == id {
            guard case .sending(let r) = t.phase else { continue }
            pending[r]?.typedId = nil
            droppedAdds.insert(r)
        }
        state.typed.removeAll { $0.id == id }
        changed()
    }

    /// Removes the values for these labels that have not been kept yet (Skip in onboarding).
    public func dropTyped(labels: [String]) {
        for t in state.typed where labels.contains(t.label) { dropTyped(t.id) }
    }

    private func flushTyped() {
        for i in state.typed.indices where state.typed[i].phase == .waiting {
            let t = state.typed[i]
            let request = HelperMemory.Request(
                requestId: nextId(), op: .add, kind: .about,
                fields: ["label": .text(t.label), "value": .text(t.value), "source": .text("typed")]
            )
            if post(request, op: .add, typedId: t.id) { state.typed[i].phase = .sending(requestId: request.requestId) }
        }
    }

    // MARK: - Debug state

    /// What the debug socket's `memory` reads. Entries carry the helper's sentences, which quote
    /// remembered values: the socket is the user's own and local. Typed values are given by length.
    public struct DebugInfo: Codable, Equatable, Sendable {
        public struct EntryInfo: Codable, Equatable, Sendable {
            public var id: String
            public var kind: String
            public var status: String
            public var says: String
            /// A permission's rule.
            public var rule: String?
            /// A permission's uses as reported, nil when the helper sends none.
            public var uses: Int?
        }

        public struct TypedInfo: Codable, Equatable, Sendable {
            public var id: String
            public var label: String
            public var valueLength: Int
            /// `waiting`, `sending` or `refused`.
            public var phase: String
            public var reason: String?
        }

        public var connected: Bool
        public var loaded: Bool
        /// The helper keeps typed values, so onboarding shows its "What I know so far" step.
        public var acceptsAdd: Bool
        public var entries: [EntryInfo]
        public var unreadable: Int
        public var busy: [String: String]
        public var problems: [String: String]
        public var listProblem: String?
        public var editing: String?
        public var draft: [String: String]?
        public var editProblem: String?
        public var confirmingForget: String?
        public var typed: [TypedInfo]
        public var sent: [String]
        /// The skills that run on their own, by name.
        public var onTheirOwn: [String]
        /// What the permissions page shows under each write rule that lists a skill.
        public var underRules: [RuleSkills]
        /// The helper offers "Let it run on its own…" (B22).
        public var offersOnItsOwn: Bool
        /// Open offers to let a skill run on its own, by entry id: `asked`, or `answering` after a yes.
        public var questions: [String: String]
        /// The noticed row whose "Not right" is open, and its typed text's length.
        public var correcting: String?
        public var correctionLength: Int?

        public struct RuleSkills: Codable, Equatable, Sendable {
            public var action: String
            public var rule: String
            /// False when the setting holds these skills back (the page asks the user to settle it).
            public var runs: Bool
            public var title: String
            public var skills: [String]
        }
    }

    public func debugInfo() -> DebugInfo {
        DebugInfo(
            connected: state.connected, loaded: state.loaded, acceptsAdd: state.acceptsAdd,
            entries: state.entries.map { e in
                DebugInfo.EntryInfo(id: e.id, kind: e.kind.rawValue, status: e.status.rawValue, says: e.says,
                                    rule: e.permission?.rule.rawValue, uses: e.uses?.count)
            },
            unreadable: state.unreadable,
            busy: state.busy.mapValues(\.rawValue),
            // A reworded refusal carries the helper's words while its row shows it.
            problems: state.problems.reduce(into: [:]) { out, p in out[p.key] = state.refusals[p.key].map { "\(p.value) [helper: \($0)]" } ?? p.value },
            listProblem: state.listProblem,
            editing: state.editor?.entryId,
            draft: state.editor.map { Dictionary($0.fields.map { ($0.key, $0.text) }, uniquingKeysWith: { a, _ in a }) },
            editProblem: state.editor?.problem,
            confirmingForget: state.confirmingForget,
            typed: state.typed.map { t in
                let (phase, reason): (String, String?) = {
                    switch t.phase {
                    case .waiting: return ("waiting", nil)
                    case .sending: return ("sending", nil)
                    case .refused(let r): return ("refused", r)
                    }
                }()
                return DebugInfo.TypedInfo(id: t.id, label: t.label, valueLength: t.value.utf16.count, phase: phase, reason: reason)
            },
            sent: sentLog,
            onTheirOwn: MemoryPage.onTheirOwn(state).map(\.name),
            underRules: [HelperMemory.ActionType.writeHere, .writeElsewhere].compactMap { action in
                MemoryPage.exceptions(state, under: action).map { x in
                    DebugInfo.RuleSkills(action: action.rawValue, rule: x.rule.rawValue, runs: x.runs, title: x.title, skills: x.skills.map(\.name))
                }
            },
            offersOnItsOwn: state.offersOnItsOwn,
            questions: state.questions.mapValues { $0.answering ? "answering" : "asked" },
            correcting: state.correcting?.entryId,
            correctionLength: state.correcting.map { $0.text.utf16.count }
        )
    }

    // MARK: -

    /// The row's wash has played.
    public func clearChanged() {
        guard state.changed != nil else { return }
        state.changed = nil
        changed()
    }

    private func changed() { onChange() }
}

/// A value typed by hand for About you.
public struct TypedAbout: Equatable, Sendable, Codable {
    public var label: String
    public var value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

extension MemoryBook.Typed.Phase {
    var isSending: Bool { if case .sending = self { return true } else { return false } }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// The helper's limits on an edit (helper/src/protocol.ts AboutFields, PeopleFields and the routine
/// name; memory.ts `checkTemplate`), checked before sending so the problem shows under the field
/// at once. Lengths are UTF-16 units, as JavaScript counts them.
public enum MemoryCheck {
    public static let offline = "Caret can't reach its memory right now. Try again in a moment."

    public static func problem(kind: HelperMemory.Kind, _ fields: [MemoryBook.Draft]) -> String? {
        for f in fields {
            let text = f.text.trimmed
            let length = text.utf16.count
            switch (kind, f.key) {
            case (.about, "label"), (.people, "alias"):
                if length == 0 { return "\(f.title) can't be empty." }
                if length > 80 { return "\(f.title) is too long. Keep it under 80 characters." }
            case (.about, "value"):
                if length == 0 { return "\(f.title) can't be empty. To remove it, use Forget." }
                if length > 500 { return "\(f.title) is too long. Keep it under 500 characters." }
            case (.people, "name"):
                if length == 0 { return "\(f.title) can't be empty." }
                if length > 200 { return "\(f.title) is too long. Keep it under 200 characters." }
            case (.routine, "name"):
                if length > 80 { return "Name is too long. Keep it under 80 characters." }
            case (.skill, "name"):
                // memory.ts: trimmed, 1 to 80 characters, one line.
                if length == 0 { return "Name can't be empty. To remove the skill, use Forget." }
                if length > 80 { return "Name is too long. Keep it under 80 characters." }
                if text.contains(where: \.isNewline) { return "Name has to fit on one line." }
            case (.preference, "template"):
                let slots = text.filter { $0 == "#" }.count
                if text.contains(where: \.isNumber) || slots < 7 || slots > 15 {
                    return "Use one # for each digit, 7 to 15 of them, like ###-###-####."
                }
            default:
                break
            }
        }
        return nil
    }

    /// What "Not right" can send instead of a noticed fact (protocol.ts MemoryNotRight `correction`:
    /// 1 to 500 characters). A preference can only be forgotten.
    public static func correctionProblem(_ text: String, correctable: Bool) -> String? {
        guard correctable else { return "Caret can only forget this one." }
        if text.trimmed.isEmpty { return "Type what's right, or choose Forget." }
        if text.trimmed.utf16.count > MemoryNotRight.maxCorrection { return "That's too long. Keep it under 500 characters." }
        return nil
    }

    /// The helper would not put a skill back on Tab. B19's helper refuses every skill edit but its
    /// name, so this is today's answer: the user is told what still works, never left guessing.
    public static let backOnTabRefused = "This version of Caret can't put a skill back on Tab yet. Pause it to stop it running, or Forget it."

    /// The helper took back its offer to let a skill run on its own before the user answered:
    /// it expired, or Caret was paused.
    public static let onItsOwnEnded = "The offer to let it run on its own ended before you answered. Ask again from here."

    /// The helper's refusal as a sentence: capitalized, with a final period. A sentence that starts
    /// with a file's name ("about-me.md changed…") keeps the name as it is.
    static func sentence(_ text: String) -> String {
        let t = text.trimmed
        guard let first = t.first else { return t }
        let startsWithFile = t.split(separator: " ").first.map { $0.contains(".") } ?? false
        let capped = startsWithFile ? t : first.uppercased() + t.dropFirst()
        return capped.hasSuffix(".") ? capped : capped + "."
    }

    public static func ruleRefused(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule) -> String {
        "\(MemoryPage.actionTitle(action)) can't be set to \(MemoryPage.ruleTitle(rule))."
    }
}
