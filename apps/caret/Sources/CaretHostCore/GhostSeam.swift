import Foundation

/// Text rules a ghost completion must pass where it meets the user's text: it must not repeat the
/// words after the caret, end the sentence when the sentence goes on, or copy a phrase from the
/// line above. Q1 (A18, bugs 6 and 7) showed all three in TextEdit: "examples | feel a bit thin"
/// was offered "could be a bit", and a line under one ending "3pm PT … budget." was offered
/// " 3pm PT". Silence is the fallback: a wrong completion costs more than none.
///
/// Whether the words fit the text after them is the model's call (`SuffixFit`); these are the
/// cases text alone can settle.
public enum GhostSeam {
    public enum Refusal: String, Codable, Sendable, Equatable {
        /// The completion ends with the word after the caret, or shares a two-word phrase with the
        /// next few words.
        case repeatsFollowing
        /// A sentence end inside or at the end of the completion while the sentence goes on after
        /// the caret.
        case endsSentenceEarly
        /// A phrase of two or more words, one of them carrying content, found word for word in the
        /// line above or earlier on the caret's line.
        case copiesEarlierText
    }

    /// Words after the caret that a completion is compared with.
    public static let followingWords = 6

    /// Why `completion` must not be offered between `before` and `after`, or nil.
    public static func refusal(completion: String, before: String, after: String) -> Refusal? {
        let next = Array(words(in: followingLine(after)).prefix(followingWords))
        let own = words(in: completion)
        if !next.isEmpty, repeats(own, next) { return .repeatsFollowing }
        if continuesSentence(after: after), completion.contains(where: { ".!?".contains($0) }) { return .endsSentenceEarly }
        if copies(completion, from: earlierText(before)) { return .copiesEarlierText }
        return nil
    }

    /// The text after the caret on its own line.
    public static func followingLine(_ after: String) -> String {
        String(after.prefix { !$0.isNewline })
    }

    /// True when the text after the caret, on the same line, starts with a lowercase word or a
    /// number: the sentence goes on past the insertion point. A capital may start a new sentence,
    /// so it does not count.
    public static func continuesSentence(after: String) -> Bool {
        guard let first = followingLine(after).first(where: { !$0.isWhitespace }) else { return false }
        return first.isLowercase || first.isNumber
    }

    /// True when visible words follow the caret on its line: the completion goes between them.
    public static func isMidLine(after: String) -> Bool {
        followingLine(after).contains { $0.isLetter || $0.isNumber }
    }

    // MARK: - Rules

    static func repeats(_ own: [String], _ next: [String]) -> Bool {
        guard let last = own.last, let first = next.first else { return false }
        if last == first { return true }
        let nextPairs = Set(zip(next, next.dropFirst()).map { "\($0) \($1)" })
        return zip(own, own.dropFirst()).contains { nextPairs.contains("\($0) \($1)") }
    }

    /// The line above the caret's line (the nearest one with words) and the caret's line up to
    /// the caret.
    static func earlierText(_ before: String) -> String {
        var lines = before.components(separatedBy: .newlines)
        let current = lines.popLast() ?? ""
        let above = lines.last { line in line.contains { $0.isLetter || $0.isNumber } } ?? ""
        return above + "\n" + current
    }

    static func copies(_ completion: String, from earlier: String) -> Bool {
        let own = words(in: completion)
        guard own.count >= 2 || own.contains(where: hasDigit) else { return false }
        guard own.contains(where: carriesContent) else { return false }
        let pattern = " " + own.joined(separator: " ") + " "
        return earlier.components(separatedBy: .newlines).contains { line in
            (" " + words(in: line).joined(separator: " ") + " ").contains(pattern)
        }
    }

    /// Lowercased words: runs of letters, digits and apostrophes.
    public static func words(in text: String) -> [String] {
        text.lowercased()
            .split { !($0.isLetter || $0.isNumber || $0 == "'" || $0 == "\u{2019}") }
            .map(String.init)
    }

    static func hasDigit(_ word: String) -> Bool { word.contains { $0.isNumber } }

    /// A number, or a word of three letters or more that is not a function word.
    static func carriesContent(_ word: String) -> Bool {
        hasDigit(word) || (word.count >= 3 && !functionWords.contains(word))
    }

    /// English function words long enough to pass the three-letter test. Assumed list, not
    /// measured: a phrase made only of these ("and the", "you can") is common enough that the
    /// line above repeating it says nothing.
    static let functionWords: Set<String> = [
        "the", "and", "but", "for", "nor", "yet", "you", "your", "our", "his", "her", "its", "their", "them", "they",
        "she", "him", "who", "whom", "what", "which", "that", "this", "these", "those", "with", "from", "into", "onto",
        "about", "over", "under", "after", "before", "then", "than", "also", "just", "not", "can", "could", "would",
        "should", "will", "shall", "may", "might", "must", "have", "has", "had", "are", "was", "were", "been", "being",
        "does", "did", "all", "any", "some", "each", "there", "here", "when", "where", "how", "why", "out", "off",
        "very", "too", "let", "get", "got", "one", "via", "per",
    ]
}

/// Whether a completion lets the word after the caret follow it.
///
/// The model scores the first token after the caret once the completion is inserted. A completion
/// that leads into the next word leaves it likely; one that collides with it ("are a bit" before
/// "feel a bit thin", "budget on the" before "talking") makes it unlikely. Scores are log
/// probabilities in nats.
///
/// Measured with `Caret --probe-replay` on 14 dev contexts, 38 candidates
/// (`~/.caret-run/evidence/host/a18/ghost/dev-run-3.txt`, 2026-10-04): the first token carried the
/// signal and the next two were near 0 for every candidate, so only the first is scored (one
/// batched decode, not three). Candidates that read well scored -0.79 to -6.39 there; candidates
/// that collide scored -7.42 to -15.29, except two that read badly at -3.46 ("could have a meeting
/// the deadline") and -5.96. The text's own score without the completion did not separate them,
/// because the text with a gap at the caret is itself often broken. The floor sits in the gap.
/// Held-out results are in A18's report.
public enum SuffixFit {
    /// Tokens after the caret that are scored.
    public static let tokens = 1

    /// The lowest score the first word after the caret may have once the completion is in.
    public static let floor: Double = -7.0

    /// `joined`: the scored tokens after the completion, first token first.
    public static func fits(withCompletion joined: [Double], floor: Double = floor) -> Bool {
        guard let first = joined.first else { return false }
        return first >= floor
    }
}
