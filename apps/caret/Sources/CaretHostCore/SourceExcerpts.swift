import CaretScreenCore
import Foundation

// L1 (helper/src/protocol.ts SourceExcerpt, GoalPageView.rows[].source/.excerpt, GoalPageView.left): where each row of a
// page task's preview came from, so the panel can name its source and, under the pointer or VoiceOver, show a crop of
// it with the value's span marked. The golden lines are helper/fixtures/golden/source-excerpts.ndjson, copied byte for
// byte into the host's test fixtures.
//
// Privacy (binding, brief L1): an excerpt is the user's own text, read from their screen or their memory. The helper
// sends it only to a host whose hello names `sourceExcerpts`, on the local socket. This host keeps it in memory while
// the panel holds the preview and draws it only in the crop: it is never logged, never in the debug state (the
// panel's spoken text and every debug field leave it out, as page field text is left out, `PageInline`), never sent
// anywhere, and never written to disk. Its `description` says nothing of its text, so string interpolation in a log
// line cannot leak it either.

public enum SourceExcerpts {
    /// The hello capability (protocol.ts SOURCE_EXCERPTS_CAPABILITY). Named only by a host that draws the crop.
    public static let capability = "sourceExcerpts"
}

/// The source's lines around a value, with the value's span in them.
public struct SourceExcerpt: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    /// A PDF the value came from: its path and the 0-based page. No helper produces one yet (the reader reports no
    /// document path), but the wire carries it.
    public struct PDF: Codable, Equatable, Sendable {
        public var path: String
        public var page: Int
        public init(path: String, page: Int) { self.path = path; self.page = page }
    }

    /// A browser tab the value came from: its title and its site's host.
    public struct Tab: Codable, Equatable, Sendable {
        public var title: String
        public var host: String
        public init(title: String, host: String) { self.title = title; self.host = host }
    }

    /// At most 6 lines and 600 UTF-16 units.
    public var text: String
    /// The span, in UTF-16 units of `text` (the helper's JS string indices).
    public var start: Int
    public var end: Int
    /// The source as the user knows it: a window's title, a memory entry's label, a tab's title.
    public var name: String
    /// When the source was last edited (ms since 1970), when the helper knows it.
    public var edited: Int64?
    public var pdf: PDF?
    public var tab: Tab?

    public static let maxText = 600
    public static let maxLines = 6

    public init(text: String, start: Int, end: Int, name: String, edited: Int64? = nil, pdf: PDF? = nil, tab: Tab? = nil) {
        self.text = text
        self.start = start
        self.end = end
        self.name = name
        self.edited = edited
        self.pdf = pdf
        self.tab = tab
    }

    enum CodingKeys: String, CodingKey { case text, start, end, name, edited, pdf, tab }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        start = try c.decode(Int.self, forKey: .start)
        end = try c.decode(Int.self, forKey: .end)
        name = try c.decode(String.self, forKey: .name)
        edited = try GoalPlans.nullable(Int64.self, c, .edited)
        pdf = try c.decodeIfPresent(PDF.self, forKey: .pdf)
        tab = try c.decodeIfPresent(Tab.self, forKey: .tab)
        try validate()
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(text, forKey: .text); try c.encode(start, forKey: .start); try c.encode(end, forKey: .end)
        try c.encode(name, forKey: .name); try c.encode(edited, forKey: .edited)
        try c.encodeIfPresent(pdf, forKey: .pdf); try c.encodeIfPresent(tab, forKey: .tab)
    }

    /// As strict as the helper's schema: a crop that cannot point at its span is never drawn.
    public func validate() throws {
        let units = text.utf16.count
        guard units >= 1, units <= Self.maxText else { throw ProtocolError("an excerpt is 1 to \(Self.maxText) characters") }
        guard text.split(separator: "\n", omittingEmptySubsequences: false).count <= Self.maxLines else { throw ProtocolError("an excerpt is at most \(Self.maxLines) lines") }
        guard start >= 0, start < end, end <= units else { throw ProtocolError("an excerpt's span lies inside its text") }
        guard span != nil else { throw ProtocolError("an excerpt's span splits a character") }
        guard !name.isEmpty, name.count <= 200 else { throw ProtocolError("an excerpt names its source") }
        guard pdf == nil || tab == nil else { throw ProtocolError("an excerpt is from a PDF or a tab, not both") }
        if let pdf { guard !pdf.path.isEmpty, pdf.page >= 0 else { throw ProtocolError("an excerpt's PDF has a path and a page") } }
        if let tab { guard !tab.host.isEmpty else { throw ProtocolError("an excerpt's tab names its host") } }
    }

    /// The span as a range of `text`; nil when an offset falls inside a surrogate pair.
    public var span: Range<String.Index>? {
        let u = text.utf16
        guard let a = u.index(u.startIndex, offsetBy: start, limitedBy: u.endIndex),
              let b = u.index(u.startIndex, offsetBy: end, limitedBy: u.endIndex),
              let lo = a.samePosition(in: text), let hi = b.samePosition(in: text) else { return nil }
        return lo..<hi
    }

    /// The marked words themselves.
    public var spanText: String { span.map { String(text[$0]) } ?? "" }

    // Never the text: a stray interpolation in a log line names only its size.
    public var description: String { "SourceExcerpt(\(text.utf16.count) units, span \(end - start))" }
    public var debugDescription: String { description }
}

/// Where a row's value came from (protocol.ts GoalPageView.rows[].source): sent to every goal-planning host, since it
/// names only an app, as the panel's `from` line already does.
public struct RowSource: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        /// A native window (Notes, TextEdit, Mail).
        case window
        /// A browser tab.
        case tab
        /// What the user told Caret.
        case memory
        /// The user's own request.
        case request
    }

    public var kind: Kind
    /// The app's name for a window or a tab; empty otherwise.
    public var name: String

    public init(kind: Kind, name: String) {
        self.kind = kind
        self.name = name
    }
}

/// A field the plan leaves to the user, with why (protocol.ts GoalPageView.left): its sentence is also one of the
/// preview's warnings.
public struct LeftField: Codable, Equatable, Sendable {
    public enum Why: String, Codable, Sendable {
        /// An answer in the user's own words.
        case answer
        /// A question about who the user is (gender, veteran status, disability) or their consent.
        case identity
        /// A value Caret never types (a password, a card number).
        case sensitive
        /// Caret looked in the sources and found nothing for it.
        case notFound
    }

    public var label: String
    public var why: Why
    public var says: String

    public init(label: String, why: Why, says: String) {
        self.label = label
        self.why = why
        self.says = says
    }
}
