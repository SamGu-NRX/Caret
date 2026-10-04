import Foundation

/// A spelling, grammar or punctuation offer at the caret (`action-engine-v2.md` decision 4 and
/// section 7).
///
/// Every error found in the sentence is a quiet mark. The one nearest the caret is the active
/// correction. Its line ("We were · Tab fix · ↓ more") is what owns Tab: a mark alone owns no
/// keys. ↓ opens the alternatives: the fix and any other guesses, Original (always present, and
/// it changes nothing), and, when the paragraph has more than one error, "Fix all in this
/// paragraph", which shows its diff while highlighted and applies as one range edit, so one undo
/// takes it back. Nothing is applied without Tab or a Command digit.
public struct WritingOffer: Equatable, Sendable {
    /// Who may hold the offer slot. Higher wins: explicit request, then an active correction,
    /// then bracketed word finding, then a passive rewrite invitation, then ordinary completion.
    public enum Producer: Int, Comparable, Sendable {
        case completion, passiveRewrite, wordFinding, correction, explicitRequest

        public static func < (a: Producer, b: Producer) -> Bool { a.rawValue < b.rawValue }
    }

    public enum Presentation: Equatable, Sendable {
        /// The underline alone. Owns no keys.
        case mark
        /// The correction line under the error. Owns Tab, ↓ and Esc.
        case line
        /// The alternatives, open. Also owns ↑ and Command-1 to 3 for the numbered rows.
        case expanded
    }

    /// The words around a change, for the line and the diff: "We " + "were" for "was".
    public struct Preview: Equatable, Sendable {
        public var before: String
        public var original: String
        public var replacement: String
        public var after: String

        public var text: String { before + replacement + after }
    }

    public struct Alternative: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case fix, original, fixAll }
        public var kind: Kind
        /// The row's words: the replacement, "Original", or "Fix all in this paragraph".
        public var label: String
        /// Secondary words after the label: the original text, or "3 fixes".
        public var detail: String?
        /// What Tab applies. Nil for Original.
        public var edit: RangeEdit?
        /// The changes this row makes, in order. Empty for Original.
        public var diff: [Preview]
    }

    public var producer: Producer
    /// Every error underlined in the sentence or paragraph.
    public private(set) var marks: [WritingCorrection]
    /// The mark nearest the caret: the one Tab fixes.
    public private(set) var active: WritingCorrection
    public private(set) var alternatives: [Alternative]
    /// The highlighted alternative.
    public private(set) var current = 0
    public private(set) var presentation: Presentation

    /// Rows that Command-1, 2 and 3 choose.
    public static let numberedRows = 3

    /// Builds the offer for `marks` in the field as read, or nil when the active correction's own
    /// fix cannot be made into a valid range edit.
    ///
    /// `checkedRevision` is `UTF16Text.digest` of the text the marks were found in. Marks from any
    /// other revision make no offer: "a apple" edited to "a pear" keeps a mark on "a" whose text
    /// still matches, and its fix would now be wrong. Each mark's original must also be the live
    /// text at its span, unit for unit.
    ///
    /// `paragraph` bounds "Fix all"; by default it is the line holding the active correction.
    public static func correction(
        marks: [WritingCorrection], checkedRevision: String, live: RangeEdit.Live, paragraph: UTF16Span? = nil,
        language: String = "en", presentation: Presentation = .line, now: Date = Date()
    ) -> WritingOffer? {
        guard let selection = live.selection, checkedRevision == UTF16Text.digest(live.value) else { return nil }
        let sorted = marks
            .filter { mark in
                UTF16Text.slice(live.value, start: mark.span.start, end: mark.span.end)?.utf16.elementsEqual(mark.original.utf16) == true
            }
            .sorted { $0.span.start < $1.span.start }
        let caret = selection.end
        // Nearest the caret; on a tie, the one before it, which the user has just written.
        guard let active = sorted.min(by: { a, b in
            let da = a.distance(toCaret: caret), db = b.distance(toCaret: caret)
            return da != db ? da < db : a.span.start > b.span.start
        }) else { return nil }

        func edit(_ span: UTF16Span, _ replacement: String) -> RangeEdit? {
            try? RangeEdit.make(live: live, replace: span, replacement: replacement, language: language, now: now).get()
        }

        var alternatives: [Alternative] = []
        var seen: Set<String> = [active.original]
        for replacement in [active.replacement] + active.otherReplacements.prefix(2) where seen.insert(replacement).inserted {
            guard let e = edit(active.span, replacement) else { continue }
            alternatives.append(Alternative(
                kind: .fix, label: replacement, detail: nil, edit: e,
                diff: [preview(active.span, original: active.original, replacement: replacement, in: live.value)]
            ))
        }
        // The fix Tab applies must exist; a guess further down cannot stand in for it.
        guard alternatives.first?.label == active.replacement else { return nil }
        alternatives.append(Alternative(kind: .original, label: WritingCopy.original, detail: active.original, edit: nil, diff: []))

        let bounds = paragraph ?? paragraphSpan(around: active.span, in: live.value)
        // A mark that needs a choice has no fix to apply unseen, so Fix all leaves it alone.
        let inParagraph = sorted.filter { bounds.contains($0.span) && !$0.needsChoice }
        if inParagraph.count >= 2, let fixAll = fixAll(inParagraph, live: live, language: language, now: now) {
            alternatives.append(fixAll)
        }
        return WritingOffer(
            producer: .correction, marks: sorted, active: active, alternatives: alternatives, current: 0,
            presentation: presentation
        )
    }

    // MARK: - Keys

    public enum Event: Equatable, Sendable {
        case tab, down, up, escape
        case commandDigit(Int)
        /// Typing, a selection change, a scroll that moves the text, focus loss, IME composition,
        /// or a newer field revision.
        case contextChanged
    }

    public enum Effect: Equatable, Sendable {
        /// The key is not Caret's here; the host app gets it.
        case passThrough
        /// Handled: the presentation or highlight changed.
        case handled
        /// Apply this edit through the range guard.
        case apply(RangeEdit)
        /// Original chosen: no edit and no undo record.
        case keepOriginal
        case dismiss
    }

    /// Whether Tab applies something now: the line's fix, or the highlighted row of the open list.
    /// A mark alone does not, and neither does the line of a correction that needs a choice.
    public var ownsTab: Bool {
        switch presentation {
        case .mark: return false
        case .line: return !active.needsChoice
        case .expanded: return true
        }
    }

    /// Whether the offer holds keys at all (↓ and Esc on a line), and so holds its slot.
    public var holdsKeys: Bool { presentation != .mark }

    public mutating func send(_ event: Event) -> Effect {
        switch (presentation, event) {
        case (_, .contextChanged):
            return .dismiss
        case (.mark, _):
            return .passThrough
        case (_, .escape):
            return .dismiss
        case (.line, .tab) where active.needsChoice:
            return .passThrough
        case (_, .tab):
            return choose(current)
        case (.line, .down):
            presentation = .expanded
            return .handled
        case (.line, _):
            return .passThrough
        case (.expanded, .down):
            current = min(current + 1, alternatives.count - 1)
            return .handled
        case (.expanded, .up):
            current = max(current - 1, 0)
            return .handled
        case (.expanded, .commandDigit(let n)):
            guard n >= 1, n <= min(Self.numberedRows, alternatives.count) else { return .passThrough }
            current = n - 1
            return choose(current)
        }
    }

    private func choose(_ index: Int) -> Effect {
        let alternative = alternatives[index]
        guard let edit = alternative.edit else { return .keepOriginal }
        return .apply(edit)
    }

    // MARK: - What it shows

    /// The highlighted row's changes: the active fix on the line; Fix all's whole diff when it is
    /// highlighted in the open list.
    public var shownDiff: [Preview] { alternatives[current].diff }

    /// The line's words: the fix with the word before it, "We were". For a correction that needs a
    /// choice, both answers and no context: "address or dress".
    public var linePreview: Preview {
        guard active.needsChoice else { return alternatives[0].diff[0] }
        let fixes = alternatives.filter { $0.kind == .fix }.map(\.label)
        return Preview(before: "", original: active.original, replacement: WritingCopy.either(fixes), after: "")
    }

    /// The answers a line that needs a choice shows as equals; nil for a line with one fix.
    public var lineChoices: [String]? {
        active.needsChoice ? alternatives.filter { $0.kind == .fix }.map(\.label) : nil
    }

    public var lineHints: [Hint] {
        if active.needsChoice { return [Hint(key: "↓", label: WritingCopy.chooseHint)] }
        return [Hint(key: "Tab", label: WritingCopy.fixHint), Hint(key: "↓", label: WritingCopy.moreHint)]
    }

    /// What VoiceOver reads for the line.
    public var spokenLine: String {
        if active.needsChoice {
            let fixes = alternatives.filter { $0.kind == .fix }.map(\.label)
            return WritingCopy.spokenChoice(reason: active.reason, original: active.original, choices: fixes)
        }
        return WritingCopy.spokenLine(reason: active.reason, original: active.original, replacement: active.replacement)
    }

    /// The toast after `alternative` is applied: "Fixed “was” to “were”", ⌘Z Undo.
    public static func toast(after alternative: Alternative) -> LineContent? {
        let text: String
        switch alternative.kind {
        case .original: return nil
        case .fix:
            guard let change = alternative.diff.first else { return nil }
            text = WritingCopy.fixed(original: change.original, replacement: change.replacement)
        case .fixAll:
            text = WritingCopy.fixedAll(alternative.diff.count)
        }
        return LineContent(
            figure: .done, lead: WritingCopy.fixedLead, text: text, emphasis: .plain,
            hints: [Hint(key: "⌘Z", label: WritingCopy.undoHint)]
        )
    }

    // MARK: - Building

    /// One range edit over every mark in the paragraph, so a single undo restores all of them.
    private static func fixAll(_ marks: [WritingCorrection], live: RangeEdit.Live, language: String, now: Date) -> Alternative? {
        guard let first = marks.first, let last = marks.last else { return nil }
        let span = UTF16Span(start: first.span.start, end: last.span.end)
        var replacement = ""
        var at = span.start
        for mark in marks {
            guard mark.span.start >= at, let gap = UTF16Text.slice(live.value, start: at, end: mark.span.start) else { return nil }
            replacement += gap + mark.replacement
            at = mark.span.end
        }
        guard let edit = try? RangeEdit.make(live: live, replace: span, replacement: replacement, language: language, now: now).get() else {
            return nil
        }
        return Alternative(
            kind: .fixAll, label: WritingCopy.fixAll, detail: WritingCopy.fixCount(marks.count), edit: edit,
            diff: marks.map { preview($0.span, original: $0.original, replacement: $0.replacement, in: live.value) }
        )
    }

    /// The line holding `span`: from the line break before it to the one after.
    static func paragraphSpan(around span: UTF16Span, in text: String) -> UTF16Span {
        let ns = text as NSString
        let range = ns.paragraphRange(for: span.nsRange)
        var end = range.location + range.length
        while end > range.location, [0x0A, 0x0D, 0x2028, 0x2029].contains(ns.character(at: end - 1)) { end -= 1 }
        return UTF16Span(start: range.location, end: end)
    }

    /// The word before a change, and for a change of spaces alone the word after, so the line
    /// reads as words: "We were", "Thanks,", "went to".
    public static func preview(_ span: UTF16Span, original: String, replacement: String, in text: String) -> Preview {
        let ns = text as NSString
        var start = span.start
        // At most one space, then one word, on the same line.
        if start > 0, ns.character(at: start - 1) == 0x20 { start -= 1 }
        while start > 0, start > span.start - 24, isWordUnit(ns.character(at: start - 1)) { start -= 1 }
        var end = span.end
        let onlySpaces = replacement.allSatisfy { $0 == " " }
        if onlySpaces {
            while end < ns.length, end < span.end + 24, isWordUnit(ns.character(at: end)) { end += 1 }
        }
        // Never cut a character in half at either end.
        while start < span.start, !WritingText.isCharacterBoundary(start, in: text) { start += 1 }
        while end > span.end, !WritingText.isCharacterBoundary(end, in: text) { end -= 1 }
        return Preview(
            before: UTF16Text.slice(text, start: start, end: span.start) ?? "",
            original: original, replacement: replacement,
            after: UTF16Text.slice(text, start: span.end, end: end) ?? ""
        )
    }

    private static func isWordUnit(_ unit: unichar) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return true }  // half of a surrogate pair
        return CharacterSet.alphanumerics.contains(scalar) || unit == 0x27 || unit == 0x2019
    }

    // MARK: - Arbitration

    /// The offer holding the slot, as arbitration sees it.
    public struct Slot: Equatable, Sendable {
        public var producer: Producer
        /// It takes some key now (Tab, or ↓ and Esc on a line that needs a choice). A quiet mark
        /// takes none and holds nothing.
        public var holdsKeys: Bool
        /// The user has moved through its alternatives.
        public var navigating: Bool

        public init(producer: Producer, holdsKeys: Bool, navigating: Bool) {
            self.producer = producer
            self.holdsKeys = holdsKeys
            self.navigating = navigating
        }
    }

    /// Whether an offer from `incoming` may take the slot from `current`.
    ///
    /// An explicit request always may. Nothing else replaces an offer the user is navigating.
    /// Otherwise the higher producer wins, and a newer offer from the same producer replaces the
    /// older one. A quiet mark holds nothing, so ordinary completion can appear beside it.
    public static func incomingWins(_ incoming: Producer, over current: Slot?) -> Bool {
        guard let current, current.holdsKeys else { return true }
        if incoming == .explicitRequest { return true }
        if current.navigating { return false }
        return incoming >= current.producer
    }

    public var slot: Slot { Slot(producer: producer, holdsKeys: holdsKeys, navigating: presentation == .expanded) }
}
