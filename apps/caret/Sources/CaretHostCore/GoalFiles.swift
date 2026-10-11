import CaretScreenCore
import Foundation

// Files in page goals (P3's helper half, H14's host half). A host that declares `goalFiles` gets attach steps in a
// page goal's preview, each shown as an attach row: "Choose a file…", or a file the user saved for that question
// before. The user picks a file in the row's chooser (⌘2 or a click), or confirms the saved one the same way; Tab then
// sends it as `goalAccept.confirmedFile`. Caret never looks for a file on disk: every path here is one the user chose
// in an open panel or confirmed in the row. After the attach, the helper may offer to keep the file for the same
// question (`fileSaveOffer`), and the memory window lists and forgets kept files (`savedFilesRequest`).
//
// Golden lines: helper/fixtures/golden/goal-files.ndjson (P3) and saved-files.ndjson (H14), copied byte for byte
// into the host's test fixtures.

public enum GoalFiles {
    /// The hello capability (protocol.ts GOAL_FILES_CAPABILITY).
    public static let capability = "goalFiles"

    /// protocol.ts AbsolutePath: 2 to 4096 characters, starting with "/", with no NUL.
    public static func isAbsolutePath(_ p: String) -> Bool {
        p.hasPrefix("/") && (2...4096).contains(p.count) && !p.contains("\0")
    }
}

/// A file the user confirmed for an attach row, as the row shows it: "Resume.pdf, edited Tue".
public struct AttachFile: Equatable, Sendable {
    /// Absolute.
    public var path: String
    public var name: String
    /// The file's modification time (ms since 1970), when known.
    public var edited: Int64?

    public init(path: String, name: String, edited: Int64?) {
        self.path = path
        self.name = name
        self.edited = edited
    }

    /// "Resume.pdf, edited Tue": the whole name and the whole date, never cut (brief H14).
    public func says(now: Date, calendar: Calendar = .current) -> String {
        guard let edited else { return name }
        return "\(name), \(LikelyFile.edited(Date(timeIntervalSince1970: Double(edited) / 1000), now: now, calendar: calendar))"
    }
}

/// What a file control's `accept` attribute allows, split into the two kinds of token the attribute holds. The
/// screen side turns these into the open panel's content types (`PageTaskCoordinator`).
public struct AcceptTypes: Equatable, Sendable {
    /// "pdf", "docx": extensions without the dot.
    public var extensions: [String]
    /// "application/pdf", "image/*".
    public var mimeTypes: [String]

    public init(_ tokens: [String]) {
        var ext: [String] = []
        var mime: [String] = []
        for raw in tokens {
            let t = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if t.hasPrefix("."), t.count > 1 { ext.append(String(t.dropFirst())) } else if t.contains("/") { mime.append(t) }
        }
        extensions = ext
        mimeTypes = mime
    }

    /// The control takes any file.
    public var isEmpty: Bool { extensions.isEmpty && mimeTypes.isEmpty }
}

/// Helper to host (P3): Caret attached a file the user confirmed, and may keep it for the same question next time.
/// Nothing is kept without `FileSave` naming `id` before `expires`.
public struct FileSaveOffer: Codable, Equatable, Sendable {
    public static let type = "fileSaveOffer"
    public struct File: Codable, Equatable, Sendable {
        public var name: String
        public init(name: String) { self.name = name }
    }

    public var id: String
    public var at: Int64
    public var expires: Int64
    public var goalId: String
    /// The file control's question: "Resume".
    public var question: String
    public var site: String?
    public var file: File
    /// The saved file a yes would replace.
    public var replaces: String?
    /// The helper's question: "Use Robin Vale Resume.pdf for 'Resume' next time?"
    public var says: String

    public init(id: String, at: Int64, expires: Int64, goalId: String, question: String, site: String?, file: File, replaces: String?, says: String) {
        self.id = id; self.at = at; self.expires = expires; self.goalId = goalId; self.question = question
        self.site = site; self.file = file; self.replaces = replaces; self.says = says
    }

    enum CodingKeys: String, CodingKey { case type, v, id, at, expires, goalId, question, site, file, replaces, says }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        id = try c.decode(String.self, forKey: .id)
        at = try c.decode(Int64.self, forKey: .at)
        expires = try c.decode(Int64.self, forKey: .expires)
        goalId = try c.decode(String.self, forKey: .goalId)
        question = try c.decode(String.self, forKey: .question)
        site = try GoalPlans.nullable(String.self, c, .site)
        file = try c.decode(File.self, forKey: .file)
        replaces = try GoalPlans.nullable(String.self, c, .replaces)
        says = try c.decode(String.self, forKey: .says)
        guard !id.isEmpty, !goalId.isEmpty, (1...240).contains(goalId.count), (1...300).contains(question.count),
              (1...255).contains(file.name.count), (1...300).contains(says.count) else {
            throw ProtocolError("fileSaveOffer names its offer, goal, question, file and sentence")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(expires, forKey: .expires)
        try c.encode(goalId, forKey: .goalId); try c.encode(question, forKey: .question); try c.encode(site, forKey: .site)
        try c.encode(file, forKey: .file); try c.encode(replaces, forKey: .replaces); try c.encode(says, forKey: .says)
    }
}

/// Host to helper (P3): the user's ⌘1 on a `FileSaveOffer`; answered with `FileSaveReply` under `requestId`.
public struct FileSave: Codable, Equatable, Sendable {
    public static let type = "fileSave"
    public var requestId: String
    public var offerId: String

    public init(requestId: String, offerId: String) {
        self.requestId = requestId
        self.offerId = offerId
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, offerId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        offerId = try c.decode(String.self, forKey: .offerId)
        guard !requestId.isEmpty, !offerId.isEmpty else { throw ProtocolError("fileSave names its request and offer") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(offerId, forKey: .offerId)
    }
}

/// Helper to host (P3): what became of a `FileSave`, to the asker only.
public struct FileSaveReply: Codable, Equatable, Sendable {
    public static let type = "fileSaveReply"
    public enum Outcome: String, Codable, Sendable { case saved, refused }
    public var requestId: String
    public var outcome: Outcome
    public var fileId: String?
    /// "Caret will offer Robin Vale Resume.pdf for 'Resume' next time.", or why nothing was saved.
    public var says: String

    public init(requestId: String, outcome: Outcome, fileId: String?, says: String) {
        self.requestId = requestId
        self.outcome = outcome
        self.fileId = fileId
        self.says = says
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, outcome, fileId, says }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        fileId = try GoalPlans.nullable(String.self, c, .fileId)
        says = try c.decode(String.self, forKey: .says)
        guard (outcome == .saved) == (fileId != nil) else { throw ProtocolError("a saved reply names the file; a refused one names none") }
        guard (1...300).contains(says.count) else { throw ProtocolError("fileSaveReply says 1 to 300 characters") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(outcome, forKey: .outcome)
        try c.encode(fileId, forKey: .fileId); try c.encode(says, forKey: .says)
    }
}

/// Host to helper (H14): list the files the user kept, or forget one, for the memory window's Files group.
public struct SavedFilesRequest: Codable, Equatable, Sendable {
    public static let type = "savedFilesRequest"
    public enum Op: String, Codable, Sendable { case list, forget }
    public var requestId: String
    public var op: Op
    /// The file's id; forget only.
    public var id: String?

    public init(requestId: String, op: Op, id: String? = nil) {
        self.requestId = requestId
        self.op = op
        self.id = id
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, op, id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        op = try c.decode(Op.self, forKey: .op)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        guard (op == .forget) == (id != nil) else { throw ProtocolError("forget names the file's id; list names none") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(op, forKey: .op); try c.encodeIfPresent(id, forKey: .id)
    }
}

/// Helper to host (H14): the files the user kept, newest saved first, after a list or a forget; to the asker only.
public struct SavedFilesReply: Codable, Equatable, Sendable {
    public static let type = "savedFilesReply"

    public struct File: Codable, Equatable, Sendable {
        public enum Status: String, Codable, Sendable { case active, paused }
        public var id: String
        /// The file control's question it was kept for: "Resume".
        public var question: String
        public var site: String?
        public var name: String
        /// Absolute: a path the user chose and agreed to keep.
        public var path: String
        public var savedOn: Int64
        /// Its modification time; nil when it is gone or no longer a regular file.
        public var edited: Int64?
        public var status: Status

        public init(id: String, question: String, site: String?, name: String, path: String, savedOn: Int64, edited: Int64?, status: Status) {
            self.id = id; self.question = question; self.site = site; self.name = name; self.path = path
            self.savedOn = savedOn; self.edited = edited; self.status = status
        }

        enum CodingKeys: String, CodingKey { case id, question, site, name, path, savedOn, edited, status }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            question = try c.decode(String.self, forKey: .question)
            site = try GoalPlans.nullable(String.self, c, .site)
            name = try c.decode(String.self, forKey: .name)
            path = try c.decode(String.self, forKey: .path)
            savedOn = try c.decode(Int64.self, forKey: .savedOn)
            edited = try GoalPlans.nullable(Int64.self, c, .edited)
            status = try c.decode(Status.self, forKey: .status)
            guard !id.isEmpty, id.count <= 80, (1...255).contains(name.count), GoalFiles.isAbsolutePath(path) else {
                throw ProtocolError("a saved file names its id, name and absolute path")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(question, forKey: .question); try c.encode(site, forKey: .site)
            try c.encode(name, forKey: .name); try c.encode(path, forKey: .path); try c.encode(savedOn, forKey: .savedOn)
            try c.encode(edited, forKey: .edited); try c.encode(status, forKey: .status)
        }
    }

    public var requestId: String
    /// Why the request failed; nil on success.
    public var error: String?
    public var files: [File]

    public init(requestId: String, error: String?, files: [File]) {
        self.requestId = requestId
        self.error = error
        self.files = files
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, error, files }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        error = try GoalPlans.nullable(String.self, c, .error)
        files = try c.decode([File].self, forKey: .files)
        guard files.count <= 200 else { throw ProtocolError("savedFilesReply lists up to 200 files") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(error, forKey: .error); try c.encode(files, forKey: .files)
    }
}
