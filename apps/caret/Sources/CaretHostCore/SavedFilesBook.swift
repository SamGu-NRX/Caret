import Foundation

/// The memory window's Files group (brief H14): the files the user kept for a question ("Use this file for résumés
/// next time?"), each with Forget and Show in Finder. The helper owns files.md; every read and forget goes through
/// `savedFilesRequest`, which only a host that declared goalFiles may send. A helper that never answers, or refuses
/// the request, leaves the group out of the window rather than showing an empty list that may be wrong.
///
/// Forget asks first, as a memory row's does (`MemoryBook`): Forget, then Forget or Keep.
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class SavedFilesBook {
    /// A request the helper never answers stops waiting after this long, as `MemoryBook`'s.
    public static let answerTimeout: TimeInterval = 3

    public struct State: Equatable, Sendable {
        public var connected = false
        /// A list came back on this connection: until then the window shows no Files group.
        public var loaded = false
        public var files: [SavedFilesReply.File] = []
        /// Why the last request failed, in the helper's words or ours.
        public var problem: String?
        /// The file whose Forget waits for a second Forget or Keep.
        public var confirmingForget: String?
        /// The file whose forget was sent and not yet answered.
        public var forgetting: String?

        public init() {}
    }

    public private(set) var state = State()
    /// Writes one request; false when the helper is not connected.
    public var send: (SavedFilesRequest) -> Bool = { _ in false }
    public var onChange: () -> Void = {}
    /// Whether this host may ask: its hello named goalFiles.
    public var enabled: () -> Bool = { false }

    private let clock: SurfaceClock
    private var pending: [String: SurfaceTimer] = [:]
    private var requests = 0

    public init(clock: SurfaceClock) {
        self.clock = clock
    }

    public func linkChanged(_ up: Bool) {
        state.connected = up
        for t in pending.values { t.cancel() }
        pending.removeAll()
        state.forgetting = nil
        state.confirmingForget = nil
        if up { refresh() } else { state.loaded = false }
        onChange()
    }

    /// Asks for the list again: the window opened, or the helper kept a file.
    public func refresh() {
        guard enabled(), state.connected else { return }
        _ = post(SavedFilesRequest(requestId: nextId(), op: .list))
    }

    /// Forget on a row: asks first.
    public func askForget(_ id: String) {
        guard state.files.contains(where: { $0.id == id }), state.forgetting == nil else { return }
        state.confirmingForget = id
        onChange()
    }

    public func keep() {
        guard state.confirmingForget != nil else { return }
        state.confirmingForget = nil
        onChange()
    }

    /// The second Forget: the helper removes the file's record from files.md. The file itself stays where it is.
    @discardableResult
    public func confirmForget() -> Bool {
        guard let id = state.confirmingForget else { return false }
        state.confirmingForget = nil
        let sent = post(SavedFilesRequest(requestId: nextId(), op: .forget, id: id))
        if sent { state.forgetting = id } else { state.problem = SavedFilesCopy.offline }
        onChange()
        return sent
    }

    public func receive(_ reply: SavedFilesReply) {
        guard let timer = pending.removeValue(forKey: reply.requestId) else { return }
        timer.cancel()
        state.forgetting = nil
        if let error = reply.error {
            state.problem = error
        } else {
            state.loaded = true
            state.problem = nil
            state.files = reply.files
            if let c = state.confirmingForget, !reply.files.contains(where: { $0.id == c }) { state.confirmingForget = nil }
        }
        onChange()
    }

    private func nextId() -> String {
        requests += 1
        return "host-files-\(requests)"
    }

    private func post(_ r: SavedFilesRequest) -> Bool {
        guard send(r) else { return false }
        let id = r.requestId
        pending[id] = clock.schedule(after: Self.answerTimeout, repeats: false) { [weak self] in
            guard let self, self.pending.removeValue(forKey: id) != nil else { return }
            self.state.forgetting = nil
            self.state.problem = SavedFilesCopy.unanswered
            self.onChange()
        }
        return true
    }
}

/// What the Files group says (`unslop`: plain words, no em dashes).
public enum SavedFilesCopy {
    public static let head = "Files"
    public static let intro = "Files you told Caret to offer again. Caret attaches one only when you confirm it in a preview, and the file stays where it is."
    public static let empty = "No files yet. After Caret attaches a file you chose, it asks whether to offer it again."
    public static let forgetQuestion = "Forget this file? Caret stops offering it. The file itself stays where it is."
    public static let offline = "Caret couldn't reach its helper, so nothing changed."
    public static let unanswered = "Caret's helper didn't answer, so the list may be out of date."
    public static let missing = "Not where it was kept"
    public static let showInFinder = "Show in Finder"
    public static let forget = "Forget"

    /// "for 'Resume' on jobs.example.com · edited Tue", or "Not where it was kept" for a file that moved.
    public static func detail(_ f: SavedFilesReply.File, now: Date, calendar: Calendar = .current) -> String {
        var parts = ["for '\(f.question)'" + (host(f.site).map { " on \($0)" } ?? "")]
        if let edited = f.edited {
            parts.append(LikelyFile.edited(Date(timeIntervalSince1970: Double(edited) / 1000), now: now, calendar: calendar))
        } else {
            parts.append(missing)
        }
        return parts.joined(separator: " · ")
    }

    static func host(_ site: String?) -> String? {
        guard let site, let h = URLComponents(string: site)?.host, !h.isEmpty else { return nil }
        return h.hasPrefix("www.") ? String(h.dropFirst(4)) : h
    }
}
