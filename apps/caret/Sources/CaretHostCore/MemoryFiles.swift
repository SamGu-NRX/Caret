import Foundation

/// The memory window's markdown files (M1): which exist, their problems, and the one open in Caret's
/// editor. Every read and write goes through `memoryDocumentRequest`; the helper owns the files.
///
/// A save names the revision the editor read. If the file changed since (another editor saved it),
/// the helper writes nothing and says so; the editor keeps the user's text and offers Reload (take the
/// file as it is now, dropping the typing) or Keep my text (save over it, now that the user has seen
/// there is a newer version). Nothing is ever overwritten without that choice.
///
/// Not thread-safe: the app calls it on the main thread only, and its clock fires there.
public final class MemoryFiles {
    /// A request the helper never answers stops waiting after this long, as `MemoryBook`'s.
    public static let answerTimeout: TimeInterval = 3

    /// The three files the window edits, by the section they belong to. Skills have a file each and
    /// are changed from their rows, not here.
    public static func doc(for kind: HelperMemory.Kind) -> String? {
        switch kind {
        case .about: return "about-me"
        case .people: return "people"
        case .preference: return "preferences"
        case .routine, .permission, .skill, .unrecognized: return nil
        }
    }

    public struct Editor: Equatable, Sendable {
        public var doc: String
        public var file: String
        /// The revision the text was read at; nil when the file did not exist yet.
        public var base: String?
        public var text: String
        /// What the file held when read, so Save with nothing changed just closes.
        public var original: String
        public var saving = false
        public var problem: String?
        /// Set when a save found the file changed: the revision it has now (nil: it was removed).
        public var conflict: Conflict?

        public var edited: Bool { text != original }
    }

    public struct Conflict: Equatable, Sendable {
        public var revision: String?
        /// The helper's sentence: "about-me.md changed outside Caret while it saved; keeping that version".
        public var message: String
    }

    public struct State: Equatable, Sendable {
        public var connected = false
        /// A list reply has arrived since the last connect. Until then the window offers no Edit: a
        /// helper from before M1 never answers, so its window simply has none.
        public var loaded = false
        public var folder: String?
        public var documents: [MemoryDocument] = []
        public var listProblem: String?
        /// The document being read for the editor.
        public var opening: String?
        public var editor: Editor?
        /// Why a file could not be opened, by document, until it is opened again.
        public var openProblems: [String: String] = [:]

        public init() {}

        public func document(_ doc: String) -> MemoryDocument? { documents.first { $0.doc == doc } }
    }

    private enum Op {
        case list, read(String), save(String), reload(String)
    }

    private struct Pending {
        var op: Op
        var timer: SurfaceTimer
        /// The editor session the request belongs to: a reply for an editor since closed or replaced
        /// changes nothing it did not ask about (review finding 1).
        var session: Int
    }

    public private(set) var state = State()
    /// Writes one request; false when the helper is not connected.
    public var send: (MemoryDocumentRequest) -> Bool = { _ in false }
    public var onChange: () -> Void = {}
    /// A save went through: the facts in the file may have changed, so memory is read again.
    public var onSaved: () -> Void = {}

    private let clock: SurfaceClock
    /// Bumped whenever the editor opens, closes or gives way to another file.
    private var session = 0
    private let prefix: String
    private var pending: [String: Pending] = [:]
    private var requests = 0
    public private(set) var sentLog: [String] = []

    public init(clock: SurfaceClock, prefix: String = "host-docs") {
        self.clock = clock
        self.prefix = prefix
    }

    // MARK: - The link

    public func linkChanged(_ up: Bool) {
        state.connected = up
        if up {
            requestList()
        } else {
            for p in pending.values { p.timer.cancel() }
            pending.removeAll()
            state.loaded = false
            state.opening = nil
            state.editor?.saving = false
        }
        onChange()
    }

    // MARK: - Asking

    public func requestList() {
        guard !pending.values.contains(where: { if case .list = $0.op { return true } else { return false } }) else { return }
        if !post(.list, op: .list) { state.listProblem = state.connected ? "Caret couldn't ask for its memory files." : nil }
        onChange()
    }

    /// Edit on a section: reads the file and opens it in Caret's editor. One file at a time; an open
    /// editor with changes stays until it is saved or closed.
    @discardableResult
    public func open(_ doc: String) -> Bool {
        guard MemoryDocs.isDocId(doc), state.opening == nil else { return false }
        if let e = state.editor {
            if e.doc == doc { return true }
            guard !e.edited else {
                state.editor?.problem = "Save or close \(e.file) first."
                onChange()
                return false
            }
        }
        // The open file had nothing typed in it: it closes now, so nothing can be typed into it
        // while the other file is read.
        state.editor = nil
        session += 1
        state.openProblems[doc] = nil
        let sent = post(.read(doc: doc), op: .read(doc))
        if sent { state.opening = doc }
        onChange()
        return sent
    }

    public func updateText(_ text: String) {
        guard state.editor?.saving == false else { return }
        state.editor?.text = text
        state.editor?.problem = nil
        onChange()
    }

    /// Close the editor, dropping what was typed: Cancel, or Save with nothing changed. Closing the
    /// window keeps a draft instead (`MemoryController`).
    public func close() {
        guard state.editor != nil || state.opening != nil else { return }
        state.editor = nil
        state.opening = nil
        session += 1
        onChange()
    }

    /// Saves over the revision the editor read. Nothing changed just closes. False when nothing was sent.
    @discardableResult
    public func save() -> Bool {
        guard let e = state.editor, !e.saving, e.conflict == nil else { return false }
        guard e.edited else {
            close()
            return false
        }
        return write(e, base: e.base)
    }

    /// On a conflict: read the file as it is now, dropping the typing.
    @discardableResult
    public func reload() -> Bool {
        guard let e = state.editor, e.conflict != nil, !e.saving else { return false }
        let sent = post(.read(doc: e.doc), op: .reload(e.doc))
        if sent { state.editor?.saving = true }
        else { state.editor?.problem = MemoryCheck.offline }
        onChange()
        return sent
    }

    /// On a conflict: save the typing over the file as it is now. The user saw that it changed.
    @discardableResult
    public func keepMine() -> Bool {
        guard let e = state.editor, let conflict = e.conflict, !e.saving else { return false }
        return write(e, base: conflict.revision)
    }

    private func write(_ e: Editor, base: String?) -> Bool {
        let sent = post(.save(doc: e.doc, base: base, text: e.text), op: .save(e.doc))
        if sent {
            state.editor?.saving = true
            state.editor?.problem = nil
        } else {
            state.editor?.problem = MemoryCheck.offline
        }
        onChange()
        return sent
    }

    // MARK: - Replies

    /// A `memoryDocumentReply`. Replies to requests this did not send are ignored.
    public func receive(_ reply: MemoryDocumentReply) {
        guard let p = pending.removeValue(forKey: reply.requestId) else { return }
        p.timer.cancel()
        defer { onChange() }
        state.folder = reply.folder
        // Each reply carries the documents it is about, with their revision and problems now.
        for d in reply.documents {
            if let i = state.documents.firstIndex(where: { $0.doc == d.doc }) { state.documents[i] = d } else { state.documents.append(d) }
        }
        let current = p.session == session
        switch p.op {
        case .list:
            if let error = reply.error {
                state.listProblem = MemoryCheck.sentence(error)
                return
            }
            state.documents = reply.documents
            state.loaded = true
            state.listProblem = nil
        case .read(let doc), .reload(let doc):
            guard current else { return }
            if case .read = p.op { state.opening = nil }
            if let error = reply.error {
                if case .read = p.op { state.openProblems[doc] = MemoryCheck.sentence(error) } else {
                    state.editor?.saving = false
                    state.editor?.problem = MemoryCheck.sentence(error)
                }
                return
            }
            let d = reply.documents.first { $0.doc == doc }
            let text = reply.text ?? ""
            state.editor = Editor(doc: doc, file: d?.file ?? "\(doc).md", base: d?.revision, text: text, original: text)
        case .save(let doc):
            if reply.error == nil { onSaved() }
            guard current, state.editor?.doc == doc else { return }
            state.editor?.saving = false
            if let conflict = reply.conflict, let error = reply.error {
                state.editor?.conflict = Conflict(revision: conflict, message: MemoryCheck.sentence(error))
                state.editor?.problem = nil
            } else if let error = reply.error {
                // A refusal names the line: Caret never keeps a password or a card number, say.
                state.editor?.problem = MemoryCheck.sentence(error)
            } else {
                state.editor = nil
                session += 1
            }
        }
    }

    private func timedOut(_ requestId: String) {
        guard let p = pending.removeValue(forKey: requestId) else { return }
        let message = "Caret didn't answer. Try again."
        // A list belongs to no editor; anything else only to the editor that asked.
        if case .list = p.op {
            state.listProblem = message
            return onChange()
        }
        guard p.session == session else { return onChange() }
        switch p.op {
        case .list: break
        case .read(let doc):
            state.opening = nil
            state.openProblems[doc] = message
        case .save, .reload:
            state.editor?.saving = false
            state.editor?.problem = message
        }
        onChange()
    }

    @discardableResult
    private func post(_ op: MemoryDocumentRequest.Op, op kind: Op) -> Bool {
        guard state.connected else { return false }
        requests += 1
        let request = MemoryDocumentRequest(requestId: "\(prefix)-\(requests)", op: op)
        guard send(request) else { return false }
        let label: String
        switch op {
        case .list: label = "list"
        case .read(let d): label = "read:\(d)"
        case .save(let d, let base, _): label = "save:\(d):\(base ?? "new")"
        }
        sentLog.append(label)
        if sentLog.count > 30 { sentLog.removeFirst(sentLog.count - 30) }
        let id = request.requestId
        pending[id] = Pending(op: kind, timer: clock.schedule(after: Self.answerTimeout, repeats: false) { [weak self] in self?.timedOut(id) }, session: session)
        return true
    }

    // MARK: - What a section shows

    /// A document's problems as the window prints them: the file, the line and the field the helper
    /// names, then its words. An error also says the entry is off until it is fixed.
    public static func problemLines(_ d: MemoryDocument) -> [String] {
        d.diagnostics.map { p in
            let field = p.field.map { ", \u{201C}\($0)\u{201D}" } ?? ""
            let words = MemoryCheck.sentence(p.message)
            let off = p.severity == .error ? " Caret skips this entry until it's fixed." : ""
            return "\(d.file), line \(p.line)\(field): \(words)\(off)"
        }
    }

    // MARK: - Debug state

    public struct DebugInfo: Codable, Equatable, Sendable {
        public var connected: Bool
        public var loaded: Bool
        public var folder: String?
        public var documents: [String: String]
        public var problems: [String]
        public var listProblem: String?
        public var opening: String?
        public var editing: String?
        public var base: String?
        public var textLength: Int?
        public var edited: Bool?
        public var saving: Bool?
        public var editProblem: String?
        public var conflict: String?
        public var openProblems: [String: String]
        public var sent: [String]
    }

    public func debugInfo() -> DebugInfo {
        DebugInfo(
            connected: state.connected, loaded: state.loaded, folder: state.folder,
            documents: Dictionary(state.documents.map { ($0.doc, $0.revision ?? "none") }, uniquingKeysWith: { a, _ in a }),
            problems: state.documents.flatMap(Self.problemLines), listProblem: state.listProblem, opening: state.opening,
            editing: state.editor?.doc, base: state.editor?.base, textLength: state.editor.map { $0.text.utf16.count },
            edited: state.editor?.edited, saving: state.editor?.saving, editProblem: state.editor?.problem,
            conflict: state.editor?.conflict.map { $0.revision ?? "removed" }, openProblems: state.openProblems, sent: sentLog
        )
    }
}
