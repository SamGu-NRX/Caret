import Foundation

/// A half-open range in UTF-16 code units, the unit Accessibility and `NSString` use.
public struct UTF16Span: Codable, Hashable, Sendable, CustomStringConvertible {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    public init(_ range: NSRange) {
        self.init(start: range.location, end: range.location + range.length)
    }

    public var length: Int { end - start }
    public var isEmpty: Bool { end <= start }
    public var nsRange: NSRange { NSRange(location: start, length: length) }

    public func overlaps(_ other: UTF16Span) -> Bool { start < other.end && other.start < end }
    public func contains(_ other: UTF16Span) -> Bool { start <= other.start && other.end <= end }
    public func shifted(by delta: Int) -> UTF16Span { UTF16Span(start: start + delta, end: end + delta) }

    public var description: String { "\(start)..<\(end)" }
}

/// One proposed fix in a field's text: what to replace, with what, and why.
///
/// Producers are `WritingCheck` (static rules, here) and CaretHost's `NativeChecker`
/// (`NSSpellChecker`). Both emit this type, so the offer and the range edit do not care which one
/// found the error.
public struct WritingCorrection: Hashable, Sendable {
    public enum Kind: String, Codable, CaseIterable, Sendable {
        /// A word the dictionary does not know.
        case spelling
        /// Word choice that breaks grammar: agreement, "a" or "an", a repeated word.
        case grammar
        /// Spaces, punctuation and capitals.
        case punctuation
    }

    public enum Source: Hashable, Sendable {
        case rule(WritingRule)
        case spellChecker
    }

    /// The text replaced, in the full field value.
    public var span: UTF16Span
    public var original: String
    /// The fix Tab applies.
    public var replacement: String
    /// Further guesses, best first. Shown as alternatives after `replacement`.
    public var otherReplacements: [String]
    public var kind: Kind
    /// Why, in plain words, for the expanded offer and VoiceOver.
    public var reason: String
    public var source: Source
    /// The checker's two answers disagree (its first guess and its autocorrection), so neither is
    /// the fix: both show as alternatives, and Tab applies nothing until the user opens the list
    /// and picks one (lead decision 2 of 2026-10-04, after T1's "adress" to "dress").
    public var needsChoice: Bool

    public init(
        span: UTF16Span, original: String, replacement: String, otherReplacements: [String] = [],
        kind: Kind, reason: String, source: Source, needsChoice: Bool = false
    ) {
        self.span = span
        self.original = original
        self.replacement = replacement
        self.otherReplacements = otherReplacements
        self.kind = kind
        self.reason = reason
        self.source = source
        self.needsChoice = needsChoice
    }

    /// Distance in UTF-16 units from the caret to this correction; 0 when the caret touches or is
    /// inside it.
    public func distance(toCaret caret: Int) -> Int {
        if caret < span.start { return span.start - caret }
        if caret > span.end { return caret - span.end }
        return 0
    }
}

/// The static rules. Each is a clear case with one right answer; none is a matter of style.
public enum WritingRule: String, Codable, CaseIterable, Sendable {
    case doubledWord
    case doubledSpace
    case spaceBeforePunctuation
    case sentenceCapital
    case article

    public var kind: WritingCorrection.Kind {
        switch self {
        case .doubledWord, .article: return .grammar
        case .doubledSpace, .spaceBeforePunctuation, .sentenceCapital: return .punctuation
        }
    }
}
