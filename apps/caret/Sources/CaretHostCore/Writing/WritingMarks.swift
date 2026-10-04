import Foundation

/// The writing marks of the focused field, kept in step with its text as the user types.
///
/// A check runs only at a sentence boundary, so between checks the marks it found must follow the
/// text: an edit before a mark shifts it, an edit inside it drops it, and a field change clears
/// them all. `WritingCoordinator` feeds every read of the field through `observe` and asks
/// `boundary` whether to check; everything here is pure so it tests without Accessibility.
public struct WritingMarks: Equatable, Sendable {
    public struct Mark: Equatable, Sendable {
        public var correction: WritingCorrection
        /// Esc closed its line: it stays underlined in Graphite and is never the active mark again.
        public var declined: Bool
        /// The sentence the check read. A correction can depend on any of it ("a" before "apple"),
        /// so an edit anywhere inside it drops the mark until the sentence is checked again.
        public var sentence: UTF16Span
    }

    /// The field, without its content revision.
    public private(set) var field: TargetIdentity?
    public private(set) var value = ""
    public private(set) var marks: [Mark] = []

    public init() {}

    /// Takes a read of the focused field. True when the field is a different one, which drops
    /// every mark.
    @discardableResult
    public mutating func observe(field: TargetIdentity, value newValue: String) -> Bool {
        var key = field
        key.elementRevision = ""
        guard key == self.field else {
            self.field = key
            value = newValue
            marks = []
            return true
        }
        guard !newValue.utf16.elementsEqual(value.utf16) else { return false }
        marks = Self.rebase(marks, from: value, to: newValue)
        value = newValue
        return false
    }

    public mutating func clear() {
        field = nil
        value = ""
        marks = []
    }

    /// A check's findings in `sentence` of `checkedValue`: they replace the marks inside that
    /// sentence. Ignored when the field moved on since the check read it (the next boundary checks
    /// again). A mark the user declined stays declined when the check finds it again.
    @discardableResult
    public mutating func record(_ found: [WritingCorrection], sentence: UTF16Span, checkedValue: String) -> Bool {
        guard checkedValue.utf16.elementsEqual(value.utf16) else { return false }
        let declined = marks.filter { $0.declined && sentence.contains($0.correction.span) }.map { Self.key($0.correction) }
        marks.removeAll { mark in sentence.contains(mark.correction.span) || found.contains { $0.span.overlaps(mark.correction.span) } }
        marks += found.map { Mark(correction: $0, declined: declined.contains(Self.key($0)), sentence: sentence) }
        marks.sort { $0.correction.span.start < $1.correction.span.start }
        return true
    }

    /// Esc on the line: the mark stays, but quiet.
    public mutating func decline(_ correction: WritingCorrection) {
        for i in marks.indices where marks[i].correction == correction { marks[i].declined = true }
    }

    /// Original chosen: the text is as the user wants it, so the mark goes.
    public mutating func remove(_ correction: WritingCorrection) {
        marks.removeAll { $0.correction == correction }
    }

    /// The marks that may lead an offer: not declined, in the paragraph holding the caret.
    public func offerable(caret: Int) -> [WritingCorrection] {
        let paragraph = Self.paragraph(around: caret, in: value)
        return marks.filter { !$0.declined && paragraph.contains($0.correction.span) }.map(\.correction)
    }

    // MARK: - Rules

    /// The sentence to check after a read, or nil. A boundary is the user having just finished a
    /// sentence: the field grew since the last read, the caret is a plain caret, and right before
    /// it sit a ".", "!" or "?" (maybe closing quotes or brackets) and then a space or a line
    /// break. `WritingCheck.lastSentence` then names the sentence that ended there.
    public static func boundary(previous: String?, value: String, selection: UTF16Selection) -> UTF16Span? {
        guard let previous, selection.isEmpty, UTF16Text.length(value) > UTF16Text.length(previous) else { return nil }
        let caret = selection.start
        let ns = value as NSString
        guard caret > 1, caret <= ns.length else { return nil }
        let last = ns.character(at: caret - 1)
        guard last == 0x20 || last == 0x0A || last == 0x0D || last == 0x2029 || last == 0x2028 else { return nil }
        var i = caret - 2
        let closers: Set<unichar> = [0x22, 0x27, 0x29, 0x5D, 0x201D, 0x2019]
        while i >= 0, closers.contains(ns.character(at: i)) { i -= 1 }
        guard i >= 0, [0x2E, 0x21, 0x3F].contains(ns.character(at: i)) else { return nil }
        // After a line break the caret starts a new paragraph, which `lastSentence` would read;
        // the sentence ended before the break.
        return WritingCheck.lastSentence(in: value, caret: last == 0x20 ? caret : caret - 1)
    }

    /// Marks carried from `old` to `new`: the text both share at the start and at the end is
    /// unchanged, so a mark whose checked sentence lies wholly inside either keeps its text (shifted
    /// by the length change when it comes after the edit). A mark whose sentence the edit touched is
    /// dropped: "a apple" edited to "a pear" leaves "a" reading the same, and its fix would now be
    /// wrong. A mark whose text no longer reads the same is dropped too.
    public static func rebase(_ marks: [Mark], from old: String, to new: String) -> [Mark] {
        let a = Array(old.utf16), b = Array(new.utf16)
        var prefix = 0
        while prefix < a.count, prefix < b.count, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < a.count - prefix, suffix < b.count - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let oldEnd = a.count - suffix, newEnd = b.count - suffix
        let delta = b.count - a.count
        return marks.compactMap { mark in
            var moved = mark
            let span = mark.correction.span
            let s = mark.sentence
            // A replacement touches the sentence where the two overlap; a pure insertion only
            // strictly inside it, so text typed after its end (the next sentence) leaves it be.
            let touches = oldEnd > prefix ? prefix < s.end && oldEnd > s.start : prefix > s.start && prefix < s.end
            if touches { return nil }
            // Untouched, the sentence lies wholly before the edit or wholly after it.
            if s.start >= oldEnd, s.end > prefix { moved.sentence = s.shifted(by: delta) }
            // Text inserted right against a mark touches it when it continues the word: "teh"
            // typed on to "tehx", or "x" typed in front of "teh".
            if span.end <= prefix {
                if span.end == prefix, newEnd > prefix, isWordUnit(b[prefix]) { return nil }
            } else if span.start >= oldEnd {
                if span.start == oldEnd, newEnd > prefix, isWordUnit(b[newEnd - 1]) { return nil }
                moved.correction.span = span.shifted(by: delta)
            } else {
                return nil
            }
            guard let text = UTF16Text.slice(new, start: moved.correction.span.start, end: moved.correction.span.end),
                  text.utf16.elementsEqual(mark.correction.original.utf16)
            else { return nil }
            return moved
        }
    }

    /// The paragraph holding `offset`, without its line break.
    public static func paragraph(around offset: Int, in text: String) -> UTF16Span {
        let ns = text as NSString
        let at = min(max(offset, 0), ns.length)
        let range = ns.paragraphRange(for: NSRange(location: at, length: 0))
        var end = range.location + range.length
        while end > range.location, [0x0A, 0x0D, 0x2028, 0x2029].contains(ns.character(at: end - 1)) { end -= 1 }
        return UTF16Span(start: range.location, end: end)
    }

    private static func key(_ c: WritingCorrection) -> String { "\(c.span.start):\(c.original)" }

    private static func isWordUnit(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return true }
        return CharacterSet.alphanumerics.contains(scalar) || unit == 0x27 || unit == 0x2019
    }
}
