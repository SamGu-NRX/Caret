import CaretScreenCore
import Foundation

// M1's markdown memory as the host reads and writes it (helper/src/protocol.ts on v2/screen, "markdown
// memory"; golden lines in Tests/CaretHostCoreTests/Fixtures/memory-documents.ndjson, copied byte for
// byte from helper/fixtures/golden/memory-documents.ndjson). Every message here is gated by the
// `memoryDocuments` capability the host names in its hello: a helper sends provenance only to a
// consumer that asked, and refuses the requests by name from one that did not.
//
// The CaretScreenCore mirror has no memory types, so these live with the host's other memory types
// (`HelperMemory`).

public enum MemoryDocs {
    /// The hello capability that turns on noticed facts, provenance, "Not right" and the documents.
    public static let capability = "memoryDocuments"

    /// A memory document, named by the helper: one of three fixed files or a skill's. Never a path.
    public static func isDocId(_ s: String) -> Bool {
        if ["about-me", "people", "preferences"].contains(s) { return true }
        guard s.hasPrefix("skills/") else { return false }
        let id = s.dropFirst("skills/".count)
        guard (3...80).contains(id.count), let first = id.unicodeScalars.first, alnum(first) else { return false }
        return id.unicodeScalars.allSatisfy { alnum($0) || $0 == "_" || $0 == "-" }
    }

    private static func alnum(_ c: Unicode.Scalar) -> Bool {
        (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
    }
}

/// The noticed facts an offer was built from, sent right after the offer (or with a plan proposal to
/// its asker). The slip shows `says` with "Not right". Taking the offer confirms each fact.
public struct MemoryProvenance: Equatable, Sendable {
    public static let type = "memoryProvenance"

    public struct Fact: Equatable, Sendable {
        public var memoryId: String
        /// About, people or preference: the kinds Caret notices.
        public var kind: HelperMemory.Kind
        /// An About label, a person's alias, the field a rule fills.
        public var label: String
        /// "from what Caret noticed in Mail Fixture, Tue", rendered by the helper.
        public var says: String
        public var noticed: HelperMemory.Noticed

        public init(memoryId: String, kind: HelperMemory.Kind, label: String, says: String, noticed: HelperMemory.Noticed) {
            self.memoryId = memoryId
            self.kind = kind
            self.label = label
            self.says = says
            self.noticed = noticed
        }

        /// What "Not right" can do with it: an About value or a person's name can be corrected; a
        /// preference can only be forgotten (protocol.ts MemoryNotRight).
        public var correctable: Bool { kind != .preference }
    }

    public var at: Int64
    /// The offer's key, or a patternOffer's id, or a plan proposal's offer key.
    public var offerKey: String
    public var facts: [Fact]

    public init(at: Int64, offerKey: String, facts: [Fact]) {
        self.at = at
        self.offerKey = offerKey
        self.facts = facts
    }

    public static func decode(_ line: Data) throws -> MemoryProvenance {
        try JSONDecoder().decode(Wire.self, from: line).value
    }

    private struct Wire: Decodable {
        let value: MemoryProvenance

        enum CodingKeys: String, CodingKey { case type, v, at, offerKey, facts }
        enum FactKeys: String, CodingKey { case memoryId, kind, label, says, noticed }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            try FirstLookWire.checkEnvelope(c, MemoryProvenance.type)
            var list = try c.nestedUnkeyedContainer(forKey: .facts)
            var facts: [Fact] = []
            while !list.isAtEnd {
                let f = try list.nestedContainer(keyedBy: FactKeys.self)
                let kindName = try f.decode(String.self, forKey: .kind)
                guard let kind = HelperMemory.Kind(rawValue: kindName), [.about, .people, .preference].contains(kind) else {
                    throw ProtocolError("provenance names a \(kindName) fact; only about, people and preference facts are noticed")
                }
                let memoryId = try f.decode(String.self, forKey: .memoryId)
                let says = try f.decode(String.self, forKey: .says)
                guard !memoryId.isEmpty, !says.isEmpty else { throw ProtocolError("a provenance fact needs its memoryId and says") }
                facts.append(Fact(
                    memoryId: memoryId, kind: kind, label: try f.decode(String.self, forKey: .label), says: says,
                    noticed: try f.decode(HelperMemory.Noticed.self, forKey: .noticed)
                ))
            }
            let offerKey = try c.decode(String.self, forKey: .offerKey)
            guard !offerKey.isEmpty else { throw ProtocolError("provenance without an offerKey") }
            guard !facts.isEmpty else { throw ProtocolError("provenance with no facts") }
            let at = try c.decode(Int64.self, forKey: .at)
            guard at >= 0 else { throw ProtocolError("provenance with a negative time") }
            value = MemoryProvenance(at: at, offerKey: offerKey, facts: facts)
        }
    }
}

/// "Not right" about one noticed fact. `correction` nil forgets it; a string replaces an About value or
/// a person's name, active from then on. Answered with `memoryReply` under `requestId`: the entry after
/// the change, or none after a forget. Every offer that used the fact is withdrawn as stale.
public struct MemoryNotRight: Encodable, Equatable, Sendable {
    public static let type = "memoryNotRight"
    /// protocol.ts: `correction` is 1 to 500 characters.
    public static let maxCorrection = 500

    public var requestId: String
    public var memoryId: String
    /// The offer the user said it on; nil from the memory window.
    public var offerKey: String?
    public var correction: String?

    public init(requestId: String, memoryId: String, offerKey: String?, correction: String?) {
        self.requestId = requestId
        self.memoryId = memoryId
        self.offerKey = offerKey
        self.correction = correction
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, memoryId, offerKey, correction }

    /// Every key, nulls present: the helper's schema has `offerKey` and `correction` nullable, not optional.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        try c.encode(memoryId, forKey: .memoryId)
        try c.encode(offerKey, forKey: .offerKey)
        try c.encode(correction, forKey: .correction)
    }
}

/// The memory window's documents: list them, read one, or save one over the revision it was read at.
public struct MemoryDocumentRequest: Encodable, Equatable, Sendable {
    public static let type = "memoryDocumentRequest"

    public enum Op: Equatable, Sendable {
        case list
        case read(doc: String)
        /// `base` nil: the file did not exist when the editor opened it.
        case save(doc: String, base: String?, text: String)
    }

    public var requestId: String
    public var op: Op

    public init(requestId: String, op: Op) {
        self.requestId = requestId
        self.op = op
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, op, doc, baseRevision, text }

    /// Only the keys the op takes (protocol.ts refuses any other): list none, read `doc`, save all three.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId)
        switch op {
        case .list:
            try c.encode("list", forKey: .op)
        case .read(let doc):
            try c.encode("read", forKey: .op)
            try c.encode(doc, forKey: .doc)
        case .save(let doc, let base, let text):
            try c.encode("save", forKey: .op)
            try c.encode(doc, forKey: .doc)
            try c.encode(base, forKey: .baseRevision)
            try c.encode(text, forKey: .text)
        }
    }
}

/// A problem in a memory document, by 1-based line and the field the helper names. An error turns the
/// record off until it is fixed; a warning changes nothing.
public struct MemoryDiagnostic: Codable, Equatable, Sendable {
    public enum Severity: String, Codable, Sendable { case error, warning }

    public var line: Int
    public var field: String?
    public var severity: Severity
    public var message: String

    public init(line: Int, field: String?, severity: Severity, message: String) {
        self.line = line
        self.field = field
        self.severity = severity
        self.message = message
    }

    enum CodingKeys: String, CodingKey { case line, field, severity, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        line = try c.decode(Int.self, forKey: .line)
        guard line > 0 else { throw ProtocolError("a diagnostic's line starts at 1") }
        field = try FirstLookWire.nullable(c, String.self, .field)
        severity = try c.decode(Severity.self, forKey: .severity)
        message = try c.decode(String.self, forKey: .message)
        guard !message.isEmpty else { throw ProtocolError("a diagnostic says what is wrong") }
    }
}

public struct MemoryDocument: Codable, Equatable, Sendable {
    public var doc: String
    /// The file's name inside the folder: "people.md", "skills/skill-1a2b3c4d.md".
    public var file: String
    /// Its absolute path, for Edit's "Open in" and Show in Finder.
    public var path: String
    /// Nil when the file does not exist yet.
    public var revision: String?
    public var bytes: Int
    public var diagnostics: [MemoryDiagnostic]

    public init(doc: String, file: String, path: String, revision: String?, bytes: Int, diagnostics: [MemoryDiagnostic]) {
        self.doc = doc
        self.file = file
        self.path = path
        self.revision = revision
        self.bytes = bytes
        self.diagnostics = diagnostics
    }

    enum CodingKeys: String, CodingKey { case doc, file, path, revision, bytes, diagnostics }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        doc = try c.decode(String.self, forKey: .doc)
        guard MemoryDocs.isDocId(doc) else { throw ProtocolError("'\(doc)' is not a memory document") }
        file = try c.decode(String.self, forKey: .file)
        path = try c.decode(String.self, forKey: .path)
        guard !file.isEmpty, !path.isEmpty else { throw ProtocolError("a memory document needs its file and path") }
        revision = try FirstLookWire.nullable(c, String.self, .revision)
        bytes = try c.decode(Int.self, forKey: .bytes)
        guard bytes >= 0 else { throw ProtocolError("negative byte count for \(doc)") }
        diagnostics = try c.decode([MemoryDiagnostic].self, forKey: .diagnostics)
    }
}

/// The answer to `memoryDocumentRequest`, to the asker only. `documents`: every one for list; the one
/// asked about for read and save. `text`: the document for read. `conflict`: a save refused because the
/// file changed since its base revision, with the revision now (nil: removed); nothing was written.
public struct MemoryDocumentReply: Equatable, Sendable {
    public static let type = "memoryDocumentReply"

    public var requestId: String
    public var error: String?
    /// The file's revision now, when a save was refused because it changed; `.some(nil)` when it was removed.
    public var conflict: String??
    public var folder: String
    public var documents: [MemoryDocument]
    public var text: String?

    public init(requestId: String, error: String?, conflict: String??, folder: String, documents: [MemoryDocument], text: String?) {
        self.requestId = requestId
        self.error = error
        self.conflict = conflict
        self.folder = folder
        self.documents = documents
        self.text = text
    }

    public static func decode(_ line: Data) throws -> MemoryDocumentReply {
        try JSONDecoder().decode(Wire.self, from: line).value
    }

    private struct Wire: Decodable {
        let value: MemoryDocumentReply

        enum CodingKeys: String, CodingKey { case type, v, requestId, error, conflict, folder, documents, text }
        enum ConflictKeys: String, CodingKey { case revision }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            try FirstLookWire.checkEnvelope(c, MemoryDocumentReply.type)
            let error = try FirstLookWire.nullable(c, String.self, .error)
            guard c.contains(.conflict) else { throw ProtocolError("missing conflict; send null instead") }
            var conflict: String?? = nil
            if try !c.decodeNil(forKey: .conflict) {
                let k = try c.nestedContainer(keyedBy: ConflictKeys.self, forKey: .conflict)
                conflict = .some(try FirstLookWire.nullable(k, String.self, .revision))
            }
            if conflict != nil, error == nil { throw ProtocolError("a conflict comes with an error saying so") }
            let folder = try c.decode(String.self, forKey: .folder)
            guard !folder.isEmpty else { throw ProtocolError("a document reply names its folder") }
            value = MemoryDocumentReply(
                requestId: try c.decode(String.self, forKey: .requestId), error: error, conflict: conflict, folder: folder,
                documents: try c.decode([MemoryDocument].self, forKey: .documents),
                text: try FirstLookWire.nullable(c, String.self, .text)
            )
        }
    }
}
