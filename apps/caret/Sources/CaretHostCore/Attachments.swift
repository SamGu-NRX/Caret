import CaretScreenCore
import Foundation

// Attachments (H5, lead decision 7 in ~/.caret-run/plans/action-engine-v2.md): when a plan attaches a
// file, the desk's card proposes the likely one ("Resume.pdf, edited Tue") and Tab confirms that file
// for that run. The host finds it among the user's own recent files by name, never by content, and
// sends nothing about it until Tab: then `fileConfirm`, with its path, to the local helper, which reads
// it once and keeps it for that run alone. A path is never saved, so it never stands for consent.
//
// Golden lines in helper/fixtures/golden/host.ndjson.

/// Host to helper: the user took this file for the plan offer `taskId`.
public struct FileConfirm: Encodable, Equatable, Sendable {
    public static let type = "fileConfirm"
    public var requestId: String
    public var at: Int64
    public var taskId: String
    /// Absolute.
    public var path: String

    public init(requestId: String, at: Int64, taskId: String, path: String) {
        self.requestId = requestId; self.at = at; self.taskId = taskId; self.path = path
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, at, taskId, path }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(at, forKey: .at)
        try c.encode(taskId, forKey: .taskId); try c.encode(path, forKey: .path)
    }
}

/// Helper to host: the answer to `fileConfirm`, to this connection only.
public struct FileConfirmReply: Decodable, Equatable, Sendable {
    public static let type = "fileConfirmReply"
    public enum Outcome: String, Decodable, Sendable { case confirmed, refused }
    public struct File: Decodable, Equatable, Sendable {
        public var name: String
        public var size: Int
    }

    public var requestId: String
    public var taskId: String
    public var outcome: Outcome
    public var file: File?
    /// The user's sentence on `refused`.
    public var says: String?

    enum CodingKeys: String, CodingKey { case type, v, requestId, taskId, outcome, file, says }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let t = try c.decode(String.self, forKey: .type)
        guard t == Self.type else { throw ProtocolError("expected \(Self.type), got \(t)") }
        let v = try c.decode(Int.self, forKey: .v)
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v) for \(t)") }
        requestId = try c.decode(String.self, forKey: .requestId)
        taskId = try c.decode(String.self, forKey: .taskId)
        outcome = try c.decode(Outcome.self, forKey: .outcome)
        guard c.contains(.file), c.contains(.says) else { throw ProtocolError("fileConfirmReply needs file and says; send null instead") }
        file = try c.decodeIfPresent(File.self, forKey: .file)
        says = try c.decodeIfPresent(String.self, forKey: .says)
        guard (outcome == .confirmed) == (file != nil && says == nil) else {
            throw ProtocolError("confirmed carries the file and no sentence; refused carries a sentence and no file")
        }
    }
}

/// A file the host proposes for a plan's attach step: found by name among the user's recent files.
public struct ProposedFile: Codable, Equatable, Sendable {
    public var path: String
    public var name: String
    public var modified: Date
    public var size: Int

    public init(path: String, name: String, modified: Date, size: Int) {
        self.path = path; self.name = name; self.modified = modified; self.size = size
    }
}

/// Which of the user's files a plan most likely means, from what it `wants` ("your resume").
public enum LikelyFile {
    /// The largest file the helper attaches (protocol.ts MAX_ATTACH_BYTES).
    public static let maxBytes = 10 * 1024 * 1024
    /// Document types forms take; a file of another type is never proposed.
    public static let extensions: Set<String> = ["pdf", "doc", "docx", "rtf", "txt", "odt", "pages"]

    /// The name parts that mean what the plan wants, matched against a file's name, lowercased, with
    /// its separators read as spaces.
    public static func words(for wants: String) -> [String] {
        let w = wants.lowercased()
        if w.contains("resume") || w.contains("résumé") || w.contains("cv") { return ["resume", "résumé", "cv", "curriculum vitae"] }
        if w.contains("cover letter") { return ["cover letter", "coverletter"] }
        if w.contains("transcript") { return ["transcript"] }
        if w.contains("portfolio") { return ["portfolio"] }
        return []
    }

    /// Whether a file of this name is one the plan wants: a word on its own in the name ("Dana_Resume_2026.pdf"),
    /// a document type, not a hidden file.
    public static func matches(name: String, wants: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        guard !name.hasPrefix("."), extensions.contains(ext) else { return false }
        let base = (name as NSString).deletingPathExtension.lowercased()
        let spaced = " " + base.map { $0.isLetter || $0.isNumber || $0 == "é" ? $0 : " " }.reduce(into: "") { $0.append($1) } + " "
        return words(for: wants).contains { spaced.contains(" \($0) ") }
    }

    /// The newest of the files that match and are small enough to attach.
    public static func pick(_ files: [ProposedFile], wants: String) -> ProposedFile? {
        files.filter { $0.size <= maxBytes && matches(name: $0.name, wants: wants) }.max { $0.modified < $1.modified }
    }

    /// "edited today", "edited yesterday", "edited Tue" within the last week, else "edited Mar 3".
    public static func edited(_ date: Date, now: Date, calendar: Calendar = .current, locale: Locale = Locale(identifier: "en_US")) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return "edited today" }
        if days == 1 { return "edited yesterday" }
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = locale
        f.setLocalizedDateFormatFromTemplate(days < 7 ? "EEE" : "MMM d")
        return "edited \(f.string(from: date))"
    }
}
