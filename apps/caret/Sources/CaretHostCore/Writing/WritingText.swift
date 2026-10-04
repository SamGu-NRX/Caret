import Foundation

/// Text plumbing shared by the writing checks, word finding and the range edit: character
/// boundaries in UTF-16, the spans no writing feature may touch, and a cheap code test.
public enum WritingText {
    /// Whether `offset` (UTF-16) falls between two whole characters (extended grapheme clusters)
    /// of `text`. False inside a surrogate pair, between a letter and its combining mark, inside an
    /// emoji ZWJ sequence or a flag, and outside the text.
    public static func isCharacterBoundary(_ offset: Int, in text: String) -> Bool {
        let units = text.utf16
        guard offset >= 0, offset <= units.count else { return false }
        if offset == 0 || offset == units.count { return true }
        let index = units.index(units.startIndex, offsetBy: offset)
        return String.Index(index, within: text) != nil
    }

    /// Bidirectional overrides and isolates (U+202A to U+202E, U+2066 to U+2069), which reorder
    /// how surrounding text displays, and C0/C1 controls other than tab and newline. A writing
    /// fix never needs them, and one could make a replacement display differently from what it is.
    public static func hasControlCharacters(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            let v = scalar.value
            if v == 0x09 || v == 0x0A { return false }
            return v < 0x20 || (0x7F...0x9F).contains(v) || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
        }
    }

    // MARK: - Protected spans

    /// Spans in `text` (offsets relative to it) that no writing feature may touch: links, email
    /// addresses, @handles and #tags, inline code, Markdown links, file paths and names, and
    /// identifiers written in snake_case or camelCase.
    public static func protectedSpans(in text: String) -> [UTF16Span] {
        let ns = text as NSString
        let whole = NSRange(location: 0, length: ns.length)
        var spans: [UTF16Span] = []
        if let detector = Self.linkDetector {
            for match in detector.matches(in: text, range: whole) { spans.append(UTF16Span(match.range)) }
        }
        for pattern in Self.protectedPatterns {
            for match in pattern.matches(in: text, range: whole) { spans.append(UTF16Span(match.range)) }
        }
        return spans.sorted { $0.start < $1.start }
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    private static let protectedPatterns: [NSRegularExpression] = [
        // Inline code.
        #"`[^`\n]*`?"#,
        // Markdown links and images, inline and by reference, and reference definitions.
        #"!?\[[^\]\n]*\]\([^)\n]*\)"#,
        #"\[[^\]\n]*\]\[[^\]\n]*\]"#,
        #"^\s*\[[^\]\n]+\]:\s*\S+"#,
        // Scheme URLs the detector might stop short of.
        #"\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+"#,
        // Email addresses.
        #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#,
        // @handles and #tags.
        #"(?<![\w@#])[@#][A-Za-z0-9_]+"#,
        // Paths: a slash not preceded by a letter (so "and/or" is prose), then a run of non-space.
        #"(?<![\w/])(?:~|\.{1,2})?/[^\s/][^\s]*"#,
        // File names with a common extension.
        #"\b[\w-]+\.(?:swift|ts|tsx|js|jsx|py|rb|go|rs|java|kt|c|h|cpp|md|txt|pdf|json|yaml|yml|toml|png|jpe?g|gif|svg|html?|css|docx?|xlsx?|pptx?|csv|zip|sh)\b"#,
        // snake_case and camelCase identifiers.
        #"\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b"#,
        #"\b[a-z]+[A-Z][A-Za-z0-9]*\b"#,
    ].map { try! NSRegularExpression(pattern: $0, options: [.anchorsMatchLines]) }

    /// Symbols that rarely appear in prose and often in code. A sentence containing one is not
    /// checked at all.
    static let codeMarkers = ["{", "}", "=>", "==", "!=", "&&", "||", "();", "</", "/>", "::", "->", " = ", "`"]

    public static func looksLikeCode(_ text: String) -> Bool {
        codeMarkers.contains { text.contains($0) }
    }
}

/// The characters of a stretch of text with each one's absolute UTF-16 offset, for scanning by
/// character while reporting UTF-16 spans.
struct CharTable {
    let chars: [Character]
    /// `offsets[i]` is where `chars[i]` starts; `offsets[chars.count]` is the end.
    let offsets: [Int]

    init(_ text: String, base: Int) {
        var chars: [Character] = []
        var offsets: [Int] = []
        var at = base
        for c in text {
            chars.append(c)
            offsets.append(at)
            at += c.utf16.count
        }
        offsets.append(at)
        self.chars = chars
        self.offsets = offsets
    }

    var count: Int { chars.count }

    /// The index of the character starting at `offset`, or `count` at the end. Nil inside a
    /// character.
    func index(at offset: Int) -> Int? {
        var lo = 0, hi = offsets.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if offsets[mid] == offset { return mid }
            if offsets[mid] < offset { lo = mid + 1 } else { hi = mid - 1 }
        }
        return nil
    }

    func span(_ from: Int, _ to: Int) -> UTF16Span { UTF16Span(start: offsets[from], end: offsets[to]) }

    func string(_ from: Int, _ to: Int) -> String { String(chars[from..<to]) }

    subscript(i: Int) -> Character? { i >= 0 && i < chars.count ? chars[i] : nil }
}
