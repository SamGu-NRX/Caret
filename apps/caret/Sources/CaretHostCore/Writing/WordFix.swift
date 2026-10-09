import Foundation

/// The word being typed, checked as soon as it is closed (brief item 5: Cotypist fixes the word the user
/// just typed; Caret checked only finished sentences). `WritingCoordinator` asks `closedWord` on every
/// read and checks that one word's spelling; `offersLive` says which findings get their line at once.
/// A finding it refuses waits for the sentence check, which sees the whole sentence.
public enum WordFix {
    /// The word the user just closed, or nil. The field grew since the last read, the caret is a plain
    /// caret, and right before it sit a space, a line break or closing punctuation (`,;:)]}"` and the
    /// curly closing double quote), then one or more word characters. Single quotes at the word's edges
    /// are left out of it; one inside is an apostrophe. A ".", "!" or "?" among them is a sentence end,
    /// which `WritingMarks.boundary` checks whole, so it gives nil here.
    public static func closedWord(previous: String?, value: String, selection: UTF16Selection) -> UTF16Span? {
        guard let previous, selection.isEmpty, UTF16Text.length(value) > UTF16Text.length(previous) else { return nil }
        let units = Array(value.utf16)
        let caret = selection.start
        guard caret > 1, caret <= units.count else { return nil }
        var i = caret - 1
        guard isCloser(units[i]) else { return nil }
        while i >= 0, isCloser(units[i]) {
            if [0x2E, 0x21, 0x3F].contains(units[i]) { return nil }
            i -= 1
        }
        var end = i + 1
        while i >= 0, isWordUnit(units[i]) { i -= 1 }
        var start = i + 1
        // A quote at either edge closes or opens a quotation ('teh', ‘teh’); only one inside the word
        // is an apostrophe ("dosen't").
        while end > start, isQuote(units[end - 1]) { end -= 1 }
        while start < end, isQuote(units[start]) { start += 1 }
        return end > start ? UTF16Span(start: start, end: end) : nil
    }

    private static func isQuote(_ unit: UInt16) -> Bool { unit == 0x27 || unit == 0x2018 || unit == 0x2019 }

    /// Whether a word check's finding gets its line as the user types: a spelling fix the checker is
    /// sure of (`needsChoice` false), within KeyType's edit cap (ADR-108: two edits up to eight letters,
    /// three beyond), so a far guess never interrupts typing.
    public static func offersLive(_ correction: WritingCorrection) -> Bool {
        guard correction.kind == .spelling, !correction.needsChoice else { return false }
        let cap = correction.original.count <= 8 ? 2 : 3
        return editDistance(correction.original, correction.replacement) <= cap
    }

    /// Levenshtein distance between the lowercased texts, by character.
    public static func editDistance(_ a: String, _ b: String) -> Int {
        let x = Array(a.lowercased()), y = Array(b.lowercased())
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var previous = Array(0...y.count)
        var current = previous
        for i in 1...x.count {
            current[0] = i
            for j in 1...y.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            swap(&previous, &current)
        }
        return previous[y.count]
    }

    // Space, tab, line breaks, the sentence ends (refused by the caller), and closing punctuation.
    private static let closers: Set<UInt16> = [0x20, 0x09, 0x0A, 0x0D, 0x2028, 0x2029, 0x2E, 0x21, 0x3F,
                                               0x2C, 0x3B, 0x3A, 0x29, 0x5D, 0x7D, 0x22, 0x201D]

    private static func isCloser(_ unit: UInt16) -> Bool { closers.contains(unit) }

    /// Letters, digits and apostrophes ("dosen't"); `eligible` then refuses digits and a stray quote.
    private static func isWordUnit(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return true }
        return CharacterSet.alphanumerics.contains(scalar) || unit == 0x27 || unit == 0x2019
    }

    /// Whether the closed word at `span` of `value` is one a live fix may touch, after KeyType's
    /// targeting rules (`CorrectionTargeting.eligibilityFailure`), with one change: an apostrophe
    /// inside the word is allowed, so contractions are checked. Refused: shorter than 3 or longer than
    /// 24 characters, a digit, any character but letters and inner apostrophes, all capitals (an
    /// acronym), a capital after the first letter (camelCase), and a word inside an address or a
    /// path (the run of non-space text around it holds "@", "://", "/", "_", "\\" or a "." between letters).
    public static func eligible(_ span: UTF16Span, in value: String) -> Bool {
        guard let word = UTF16Text.slice(value, start: span.start, end: span.end) else { return false }
        let letters = word.filter(\.isLetter)
        guard (3...24).contains(word.count), let first = word.first, let last = word.last,
              first.isLetter, last.isLetter,
              word.allSatisfy({ $0.isLetter || $0 == "'" || $0 == "\u{2019}" }) else { return false }
        if letters.count > 1, letters.allSatisfy(\.isUppercase) { return false }
        if word.dropFirst().contains(where: \.isUppercase) { return false }
        // The run of non-space text holding the word.
        let units = Array(value.utf16)
        var a = span.start, b = span.end
        while a > 0, !isSpace(units[a - 1]) { a -= 1 }
        while b < units.count, !isSpace(units[b]) { b += 1 }
        let token = UTF16Text.slice(value, start: a, end: b) ?? word
        if token.contains("@") || token.contains("://") || token.contains("/") || token.contains("_") || token.contains("\\") { return false }
        if token.range(of: "[A-Za-z]\\.[A-Za-z]", options: .regularExpression) != nil { return false }
        return true
    }

    private static func isSpace(_ unit: UInt16) -> Bool { [0x20, 0x09, 0x0A, 0x0D, 0x2028, 0x2029].contains(unit) }
}
