import Foundation

/// Finds a bracketed description of a word in prose, such as "[word for delaying a task]", for the
/// local model to answer with short terms. Generation is not here: `LocalWritingPort` is the seam
/// the Gemma engine implements.
///
/// A bracket counts only when its inside asks for a word in so many words ("word for", "term
/// for", "synonym for", "opposite of", "way to say"). Brackets are common in writing for other
/// reasons, and guessing wrong would replace text the user meant, so everything else is left
/// alone: citations ("[1]", "[Smith 2020]"), Markdown links and footnotes, wiki links, checkboxes,
/// index access in code ("items[i]"), template placeholders ("[Your Name]", "[INSERT DATE]"),
/// editorial marks ("[sic]", "[laughs]"), brackets inside code or a link, nested or unclosed
/// brackets, and any line that looks like code. Explicitly selecting text can still ask for a
/// word; that request does not come through this parser.
public enum WordFinding {
    public struct Bracket: Equatable, Sendable {
        /// The whole bracket, "[" through "]", which Tab replaces.
        public var span: UTF16Span
        /// The words inside, trimmed.
        public var description: String
    }

    /// Longest description read, in characters.
    public static let maxDescription = 120

    /// Every bracketed request in `text`, in order.
    public static func brackets(in text: String) -> [Bracket] {
        let ns = text as NSString
        let protected = WritingText.protectedSpans(in: text)
        var out: [Bracket] = []
        var lineStart = 0
        while lineStart <= ns.length {
            let lineRange = ns.lineRange(for: NSRange(location: lineStart, length: 0))
            let line = ns.substring(with: lineRange)
            if !WritingText.looksLikeCode(line) {
                out += bracketsInLine(line, base: lineRange.location, protected: protected)
            }
            let next = lineRange.location + lineRange.length
            if next <= lineStart { break }
            lineStart = next
            if lineStart == ns.length { break }
        }
        return out
    }

    /// The request the user just finished: its "]" sits at the caret, or with only spaces or
    /// punctuation typed after it.
    public static func request(in text: String, caret: Int) -> Bracket? {
        brackets(in: text).last { bracket in
            guard bracket.span.end <= caret,
                  let between = UTF16Text.slice(text, start: bracket.span.end, end: caret)
            else { return false }
            return between.count <= 2 && between.allSatisfy { $0 == " " || ".,;:!?".contains($0) }
        }
    }

    // MARK: -

    private static func bracketsInLine(_ line: String, base: Int, protected: [UTF16Span]) -> [Bracket] {
        let units = Array(line.utf16)
        let open: UInt16 = 0x5B, close: UInt16 = 0x5D
        var out: [Bracket] = []
        var i = 0
        while i < units.count {
            guard units[i] == open else { i += 1; continue }
            // The matching "]" with no "[" in between; a nested or unclosed bracket is ambiguous.
            var j = i + 1
            while j < units.count, units[j] != close, units[j] != open { j += 1 }
            guard j < units.count, units[j] == close else { i = j; continue }
            defer { i = j + 1 }
            let span = UTF16Span(start: base + i, end: base + j + 1)
            guard !protected.contains(where: { $0.overlaps(span) }) else { continue }
            // Wiki links "[[x]]", images "![x]", links "[x](", "[x][", definitions "[x]:", and
            // index access "items[i]" or "f()[0]".
            if i > 0 {
                let before = units[i - 1]
                if before == open || before == 0x21 /* ! */ { continue }
                if let scalar = Unicode.Scalar(before), CharacterSet.alphanumerics.contains(scalar) || before == 0x29 || before == 0x5F { continue }
            }
            if j + 1 < units.count, [close, 0x28, open, 0x3A].contains(units[j + 1]) { continue }
            guard let description = describes(String(decoding: units[(i + 1)..<j], as: UTF16.self)) else { continue }
            out.append(Bracket(span: span, description: description))
        }
        return out
    }

    /// Phrases that ask for a word: "word for", "a term meaning", "synonym for", "opposite of".
    private static let asks = try! NSRegularExpression(pattern: #"""
        (?xi)
        \b(?:word|words|term|phrase|expression|verb|noun|adjective|adverb|idiom|synonym|antonym)\b
          \s+(?:for|meaning|that|which|describing|to\s+describe|like|than|of|when|used)\b
        | ^(?:a\s+|the\s+)?(?:synonym|antonym|opposite)\s+(?:of|for|to)\b
        | \bway\s+(?:to|of)\s+say(?:ing)?\b
        | \b(?:another|better|fancier|fancy|simpler|formal|informal|nicer|stronger|softer)\s+(?:word|term|phrase|way)\b
        """#)

    /// The description when `inside` reads as a request for a word, else nil.
    static func describes(_ inside: String) -> String? {
        let text = inside.trimmingCharacters(in: .whitespaces)
        guard text.count >= 3, text.count <= maxDescription else { return nil }
        guard !WritingText.hasControlCharacters(text), !text.contains("\n") else { return nil }
        // Footnotes "[^1]", citation keys "[@smith]", checkboxes "[x]".
        guard let first = text.first, first.isLetter else { return nil }
        // Code-ish insides.
        guard !text.contains(where: { "=(){}<>;`/\\|_\"*#$%^&+[]@".contains($0) }) else { return nil }
        // Citations name a year or page: "Smith 2020", "Lee et al., p. 4".
        guard !text.contains(where: \.isNumber) else { return nil }
        let words = text.split(whereSeparator: { $0 == " " })
        guard words.count >= 3, words.count <= 20 else { return nil }
        // Placeholders: "INSERT DATE", "Your Full Name".
        let letters = text.filter(\.isLetter)
        if letters.allSatisfy(\.isUppercase) { return nil }
        if words.allSatisfy({ $0.first?.isUppercase == true }) { return nil }
        let ns = text as NSString
        guard asks.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) != nil else { return nil }
        return text
    }

    // MARK: - Answers

    /// At most this many terms are offered.
    public static let maxTerms = 3

    /// The model's answers made safe to offer: trimmed of quotes and a final period, short terms
    /// only (up to four words and 40 characters, no line breaks, brackets or control characters),
    /// duplicates dropped regardless of case, at most `maxTerms`.
    public static func usableTerms(_ raw: [String]) -> [String] {
        var seen: Set<String> = []
        var out: [String] = []
        for term in raw {
            var t = term.trimmingCharacters(in: .whitespacesAndNewlines)
            t = t.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”‘’`"))
            if t.hasSuffix(".") && !t.hasSuffix("..") { t.removeLast() }
            t = t.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, t.count <= 40, !t.contains("\n"), !t.contains("["), !t.contains("]"),
                  !WritingText.hasControlCharacters(t),
                  t.split(separator: " ").count <= 4
            else { continue }
            guard seen.insert(t.lowercased()).inserted else { continue }
            out.append(t)
            if out.count == maxTerms { break }
        }
        return out
    }
}

// MARK: - The local model seam

/// What the local writing model (Gemma, in process) offers the writing features. CaretHost's
/// engine adapter implements it over the already loaded model; tests use a fake. Phrase rewrite
/// joins this protocol when it is built (`action-engine-v2.md` batch D2-10).
public protocol LocalWritingPort: Sendable {
    var availability: LocalWritingAvailability { get async }
    /// Up to three short terms for the description. Throws `CancellationError` when cancelled.
    func findWords(_ request: WordFindingRequest) async throws -> [String]
}

public enum LocalWritingAvailability: Equatable, Sendable {
    case ready
    /// Why not, in words the offer can show.
    case unavailable(reason: String)
}

public struct WordFindingRequest: Equatable, Sendable {
    public var description: String
    /// The sentence around the bracket, with the bracket replaced by "___", so the model can fit
    /// the word's form ("delaying" against "delay"). Capped at 240 characters.
    public var context: String
    public var language: String
    /// The field's revision when asked. An answer for an older revision is dropped.
    public var revision: String

    public static let maxContext = 240

    public init(description: String, context: String, language: String, revision: String) {
        self.description = description
        self.context = String(context.prefix(Self.maxContext))
        self.language = language
        self.revision = revision
    }

    /// The request for `bracket` in `text`.
    public static func make(_ bracket: WordFinding.Bracket, in text: String, language: String = "en") -> WordFindingRequest {
        let total = UTF16Text.length(text)
        let ns = text as NSString
        let line = ns.lineRange(for: bracket.span.nsRange)
        let before = UTF16Text.slice(text, start: line.location, end: bracket.span.start) ?? ""
        let after = UTF16Text.slice(text, start: bracket.span.end, end: min(total, line.location + line.length)) ?? ""
        let context = (before.suffix(160) + "___" + after.prefix(77)).trimmingCharacters(in: .whitespacesAndNewlines)
        return WordFindingRequest(description: bracket.description, context: context, language: language, revision: UTF16Text.digest(text))
    }
}

/// The outcome of asking for words.
public enum WordFindingResult: Equatable, Sendable {
    case terms([String])
    /// The local model is not available; the reason is shown, and nothing falls back to a cloud
    /// model.
    case unavailable(reason: String)
    /// The model answered, but nothing it said was a usable term.
    case nothingUsable
    /// The field changed while the model worked.
    case stale
    case cancelled
}

public enum WordFinder {
    /// Asks `port` for words and checks the answer: unavailable models say why, answers for an
    /// older revision of the field are dropped, and only usable terms come back.
    public static func suggest(
        _ request: WordFindingRequest, using port: LocalWritingPort, currentRevision: @Sendable () async -> String
    ) async -> WordFindingResult {
        if case .unavailable(let reason) = await port.availability { return .unavailable(reason: reason) }
        let raw: [String]
        do {
            raw = try await port.findWords(request)
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .nothingUsable
        }
        if Task.isCancelled { return .cancelled }
        guard await currentRevision() == request.revision else { return .stale }
        let terms = WordFinding.usableTerms(raw)
        return terms.isEmpty ? .nothingUsable : .terms(terms)
    }
}
