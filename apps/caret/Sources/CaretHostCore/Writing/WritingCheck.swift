import Foundation

/// The static writing rules: clear errors with one right answer, checked over the last sentence.
///
/// Covered: a repeated word, two spaces between words, a space before punctuation, a lowercase
/// first word after a finished sentence, and "a" or "an" against the next word's sound. Never
/// style: no wordiness, tone, passive voice, or comma preferences. When a rule cannot tell
/// (an abbreviation, an acronym, "herb", a letter used as a label), it says nothing.
///
/// Only English gets the language rules. Doubled words are legal in French ("nous nous") and
/// German ("die die"), and French puts a space before "?" and ":". Other languages get the
/// doubled-space rule only.
public enum WritingCheck {
    /// Characters searched back from the sentence for the previous sentence, which the capital
    /// rule reads. A paragraph break ends the search sooner.
    static let contextLimit = 600

    /// Corrections inside `sentence` (UTF-16, in `text`), sorted by position, never overlapping.
    public static func check(_ text: String, sentence: UTF16Span, language: String = "en") -> [WritingCorrection] {
        let total = UTF16Text.length(text)
        guard sentence.start >= 0, sentence.end <= total, !sentence.isEmpty,
              WritingText.isCharacterBoundary(sentence.start, in: text),
              WritingText.isCharacterBoundary(sentence.end, in: text)
        else { return [] }

        // Read from the start of the paragraph (or `contextLimit` back), so the capital rule can
        // see the sentence before this one.
        let windowStart = paragraphStart(in: text, before: sentence.start)
        guard let window = UTF16Text.slice(text, start: windowStart, end: sentence.end) else { return [] }
        let table = CharTable(window, base: windowStart)
        guard let first = table.index(at: sentence.start) else { return [] }
        let sentenceText = table.string(first, table.count)
        guard !WritingText.looksLikeCode(sentenceText) else { return [] }

        let protected = WritingText.protectedSpans(in: window).map { $0.shifted(by: windowStart) }
        let scan = Scan(table: table, first: first)

        var found = scan.doubledSpaces()
        if isEnglish(language) {
            found += scan.doubledWords() + scan.spacesBeforePunctuation() + scan.articles()
            if let capital = scan.sentenceCapital() { found.append(capital) }
        }
        return resolveOverlaps(found.filter { c in !protected.contains { $0.overlaps(c.span) } })
    }

    /// The sentence that ends at the caret, without a word still being typed: what a check after
    /// a boundary reads. Nil when nothing finished sits before the caret.
    ///
    /// The sentence starts after the last ".", "!" or "?" that ends a sentence (not "e.g." or a
    /// decimal), or at a line break, or at the start of the text.
    public static func lastSentence(in text: String, caret: Int) -> UTF16Span? {
        guard caret > 0, caret <= UTF16Text.length(text), WritingText.isCharacterBoundary(caret, in: text) else { return nil }
        let windowStart = paragraphStart(in: text, before: caret)
        guard let window = UTF16Text.slice(text, start: windowStart, end: caret) else { return nil }
        let table = CharTable(window, base: windowStart)
        var end = table.count
        // A word touching the caret is still being typed.
        while end > 0, let c = table[end - 1], isWordCharacter(c) { end -= 1 }
        while end > 0, let c = table[end - 1], c.isWhitespace { end -= 1 }
        guard end > 0 else { return nil }
        var start = 0
        var i = end - 1
        while i > 0 {
            // A terminator before position i ends the previous sentence when whitespace follows it.
            if let c = table[i], c.isWhitespace, Scan.endsSentence(table, before: i) {
                start = i
                break
            }
            i -= 1
        }
        while start < end, let c = table[start], c.isWhitespace { start += 1 }
        guard start < end else { return nil }
        return table.span(start, end)
    }

    /// Two lists of corrections from different producers, as one: where two overlap, the earlier
    /// list's wins.
    public static func merged(_ preferred: [WritingCorrection], _ others: [WritingCorrection]) -> [WritingCorrection] {
        let kept = others.filter { o in !preferred.contains { $0.span.overlaps(o.span) || $0.span == o.span } }
        return (preferred + kept).sorted { $0.span.start < $1.span.start }
    }

    /// Whether a word the spell checker flagged is probably a name, an acronym, a command or an
    /// identifier, which Caret leaves alone: capitalized away from a sentence start, all capitals,
    /// mixed case inside the word, containing a digit, or with no vowel at all ("npm", "ssh").
    public static func looksLikeName(_ word: String, atSentenceStart: Bool) -> Bool {
        guard let first = word.first else { return true }
        if word.contains(where: \.isNumber) { return true }
        if !word.lowercased().contains(where: { "aeiouy".contains($0) }) { return true }
        let letters = word.filter(\.isLetter)
        if letters.count >= 2, letters.allSatisfy(\.isUppercase) { return true }
        if letters.dropFirst().contains(where: \.isUppercase) { return true }
        return first.isUppercase && !atSentenceStart
    }

    /// Whether `text` is one word said twice in a way people often mean ("had had", "is is"),
    /// which no producer may call an error.
    public static func isMeantRepeat(_ text: String) -> Bool {
        let parts = text.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 2, parts[0].lowercased() == parts[1].lowercased() else { return false }
        return Scan.meantRepeats.contains(parts[0].lowercased())
    }

    // MARK: - Helpers

    static func isEnglish(_ language: String) -> Bool {
        let l = language.lowercased()
        return l == "en" || l.hasPrefix("en-") || l.hasPrefix("en_")
    }

    static func isWordCharacter(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "'" || c == "’" }

    /// Start of the paragraph holding `offset`, at most `contextLimit` units back.
    static func paragraphStart(in text: String, before offset: Int) -> Int {
        let units = Array(text.utf16.prefix(offset))
        var i = units.count
        let floor = max(0, units.count - contextLimit)
        while i > floor {
            if units[i - 1] == 0x0A { return i }
            i -= 1
        }
        // Never start inside a surrogate pair or a cluster.
        var start = floor
        while start > 0, !WritingText.isCharacterBoundary(start, in: text) { start -= 1 }
        return start
    }

    /// Keeps the first of any overlapping corrections, in position order.
    static func resolveOverlaps(_ corrections: [WritingCorrection]) -> [WritingCorrection] {
        var out: [WritingCorrection] = []
        for c in corrections.sorted(by: { ($0.span.start, $0.span.end) < ($1.span.start, $1.span.end) }) {
            if let last = out.last, last.span.overlaps(c.span) || last.span == c.span { continue }
            out.append(c)
        }
        return out
    }
}

// MARK: - The scan

/// One pass over a sentence's characters (`first..<table.count`), with the paragraph before it
/// for context.
private struct Scan {
    let table: CharTable
    let first: Int

    var chars: [Character] { table.chars }

    struct Word {
        let from: Int
        let to: Int
        let text: String
    }

    /// Words in the sentence: runs of letters and digits, with apostrophes and hyphens inside.
    var words: [Word] {
        var out: [Word] = []
        var i = first
        while i < table.count {
            guard Self.isWordStart(chars[i]) else { i += 1; continue }
            var j = i + 1
            while j < table.count {
                let c = chars[j]
                if c.isLetter || c.isNumber { j += 1; continue }
                if Self.joiners.contains(c), j + 1 < table.count, chars[j + 1].isLetter { j += 1; continue }
                break
            }
            out.append(Word(from: i, to: j, text: table.string(i, j)))
            i = j
        }
        return out
    }

    static let joiners: Set<Character> = ["'", "’", "-"]

    static func isWordStart(_ c: Character) -> Bool { c.isLetter || c.isNumber }

    static func isHorizontalSpace(_ c: Character) -> Bool { c == " " || c == "\t" }

    // MARK: Repeated words

    /// Repeats that are often meant: "had had", "that that", "bye bye", "very very".
    static let meantRepeats: Set<String> = [
        "had", "that", "is", "do", "bye", "no", "yes", "ha", "haha", "hey", "yeah", "very", "so", "now",
        "well", "there", "knock", "tut", "boo", "never", "really", "more", "many", "far", "again", "ok",
        "okay", "go", "blah", "la", "na", "chop", "tick", "tock", "wait", "out", "too", "much", "hip",
        "night", "yum", "oh", "ah", "aw", "bang", "pop", "beep", "ding", "hush", "please", "come", "hurry",
        "quick", "run", "stop", "help", "over", "round", "around", "on", "off", "goody", "tsk", "uh", "um",
        "mm", "hmm", "ho", "hee", "woo", "wow", "yay", "yo", "choo", "ta", "bla", "cha", "rah",
        // A noun then the same word as a verb: "The police police this area."
        "police", "buffalo", "fish",
    ]

    func doubledWords() -> [WritingCorrection] {
        let ws = words
        var out: [WritingCorrection] = []
        for k in ws.indices.dropFirst() {
            let a = ws[k - 1], b = ws[k]
            // Only plain spaces between them: not a comma ("well, well"), not a line break.
            guard b.from > a.to, (a.to..<b.from).allSatisfy({ Self.isHorizontalSpace(chars[$0]) }) else { continue }
            let la = a.text.lowercased(), lb = b.text.lowercased()
            guard la == lb, la.allSatisfy({ $0.isLetter || $0 == "'" || $0 == "’" }) else { continue }
            guard !Self.meantRepeats.contains(la) else { continue }
            // "Walla Walla", "Bora Bora": a capitalized repeat is a name.
            guard let bFirst = b.text.first, !bFirst.isUppercase else { continue }
            out.append(WritingCorrection(
                span: table.span(a.from, b.to), original: table.string(a.from, b.to), replacement: a.text,
                kind: WritingRule.doubledWord.kind, reason: WritingCopy.repeatedWord, source: .rule(.doubledWord)
            ))
        }
        return out
    }

    // MARK: Two spaces

    /// Two or three spaces between two non-space characters on one line. After a sentence's end
    /// two spaces are a typing convention, not an error; four or more is deliberate alignment.
    func doubledSpaces() -> [WritingCorrection] {
        var out: [WritingCorrection] = []
        var i = first
        while i < table.count {
            guard chars[i] == " " else { i += 1; continue }
            var j = i
            while j < table.count, chars[j] == " " { j += 1 }
            defer { i = j }
            let run = j - i
            guard run == 2 || run == 3, i > 0, j < table.count else { continue }
            let before = chars[i - 1], after = chars[j]
            guard !before.isWhitespace, !after.isWhitespace else { continue }
            guard !followsTerminator(i), before != ":" else { continue }
            guard after.isLetter || after.isNumber || Self.openers.contains(after) else { continue }
            out.append(WritingCorrection(
                span: table.span(i, j), original: table.string(i, j), replacement: " ",
                kind: WritingRule.doubledSpace.kind, reason: WritingCopy.twoSpaces, source: .rule(.doubledSpace)
            ))
        }
        return out
    }

    /// Whether a ".", "!" or "?", possibly followed by closing quotes or brackets, sits just
    /// before `i`.
    func followsTerminator(_ i: Int) -> Bool {
        var k = i - 1
        while k >= 0, Self.closers.contains(chars[k]) { k -= 1 }
        return k >= 0 && Self.terminators.contains(chars[k])
    }

    // MARK: Space before punctuation

    static let spacedMarks: Set<Character> = [",", ".", ";", ":", "?", "!"]
    static let closers: Set<Character> = ["\"", "'", ")", "]", "”", "’", "»"]
    static let openers: Set<Character> = ["\"", "'", "(", "[", "“", "‘", "«"]
    static let terminators: Set<Character> = [".", "!", "?"]
    static let quoteCloses: Set<Character> = ["\"", "'", "”", "’", "»"]

    /// "word ," and "done ." The mark must end something: whitespace, the end, or a closing quote
    /// follows. That leaves alone ".5", ".NET", " ..." and emoticons such as " :)".
    func spacesBeforePunctuation() -> [WritingCorrection] {
        var out: [WritingCorrection] = []
        var i = first
        while i < table.count {
            guard chars[i] == " " else { i += 1; continue }
            var j = i
            while j < table.count, chars[j] == " " { j += 1 }
            defer { i = j }
            guard i > 0, j < table.count else { continue }
            let before = chars[i - 1], mark = chars[j]
            guard Self.spacedMarks.contains(mark) else { continue }
            guard before.isLetter || before.isNumber || (Self.closers.contains(before) && before != "'") else { continue }
            // Repeated marks ("??", "!!") move together; "..." is an ellipsis and stays.
            var k = j
            while k < table.count, chars[k] == mark { k += 1 }
            if mark == "." && k - j > 1 { continue }
            if k < table.count {
                let next = chars[k]
                let ends = next.isWhitespace || (Self.closers.contains(next) && next != ")" && next != "]" && next != "'")
                guard ends else { continue }
            }
            out.append(WritingCorrection(
                span: table.span(i, k), original: table.string(i, k), replacement: table.string(j, k),
                kind: WritingRule.spaceBeforePunctuation.kind, reason: WritingCopy.spaceBefore(mark),
                source: .rule(.spaceBeforePunctuation)
            ))
        }
        return out
    }

    // MARK: Capital after a finished sentence

    /// Abbreviations whose period does not end a sentence, lowercased without the final period.
    static let abbreviations: Set<String> = [
        "e.g", "i.e", "etc", "vs", "approx", "cf", "mr", "mrs", "ms", "dr", "st", "no", "jr", "sr", "prof",
        "fig", "al", "inc", "ltd", "co", "corp", "dept", "est", "min", "max", "misc", "a.m", "p.m", "u.s",
        "ph.d", "a.k.a", "vol", "ch", "sec", "p", "pp", "ed", "eds", "rev", "gen", "gov", "sgt", "capt",
        "lt", "col", "mt", "ft", "ave", "blvd", "rd", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
        "sep", "sept", "oct", "nov", "dec", "mon", "tue", "tues", "wed", "thu", "thurs", "fri", "sat",
        "sun", "approx", "dept", "univ", "assn", "bros", "op", "viz", "ca", "c", "v",
    ]

    /// Whether characters just before `i` close a sentence: ".", "!" or "?" (possibly followed by
    /// closing quotes or brackets), not an ellipsis, an abbreviation, an initial or a number.
    static func endsSentence(_ table: CharTable, before i: Int) -> Bool {
        var k = i - 1
        while k >= 0, let c = table[k], closers.contains(c) { k -= 1 }
        guard k >= 0, let mark = table[k], terminators.contains(mark) else { return false }
        if mark == "." {
            // An ellipsis continues the sentence.
            if k > 0, table[k - 1] == "." { return false }
            // The word before the period: an abbreviation, an initial ("J."), or a number.
            var s = k
            while s > 0, let c = table[s - 1], c.isLetter || c.isNumber || c == "." { s -= 1 }
            let word = table.string(s, k)
            if word.isEmpty { return true }
            if abbreviations.contains(word.lowercased()) { return false }
            if word.count == 1, let c = word.first, c.isUppercase { return false }
            if word.contains(".") { return false }
            if word.allSatisfy(\.isNumber) { return false }
        }
        return true
    }

    /// The sentence's first word, when it is plain lowercase and follows a finished sentence in
    /// the same paragraph that itself started with a capital. A field that starts in lowercase,
    /// or a writer who never capitalizes, is writing in a style; Caret leaves both alone.
    func sentenceCapital() -> WritingCorrection? {
        guard let word = words.first else { return nil }
        // Only spaces between the sentence's start and its first word.
        guard (first..<word.from).allSatisfy({ chars[$0].isWhitespace || Self.openers.contains(chars[$0]) }) else { return nil }
        guard let initial = word.text.first, initial.isLowercase,
              word.text.allSatisfy({ $0.isLowercase || $0 == "'" || $0 == "’" || $0 == "-" })
        else { return nil }
        // "e.g. this" or "the .com era": a dot touching the word means it is not a plain word.
        if word.to < table.count, chars[word.to] == "." , word.to + 1 < table.count, chars[word.to + 1].isLetter { return nil }
        // The previous sentence ended with a terminator, and whitespace separates the two. Quotes
        // touching the word open it; a quote before the whitespace closed the sentence before.
        var k = word.from
        while k > 0, Self.openers.contains(chars[k - 1]) { k -= 1 }
        let afterSpace = k
        while k > 0, chars[k - 1].isWhitespace { k -= 1 }
        guard k > 0, k < afterSpace, Self.endsSentence(table, before: k) else { return nil }
        // "Are you ready?" she asked: after a closing quote, a lowercase word is the attribution
        // of the quoted sentence, not a new one.
        if Self.quoteCloses.contains(chars[k - 1]) { return nil }
        guard previousSentenceStartsWithCapital(endingAt: k) else { return nil }
        let replacement = initial.uppercased() + word.text.dropFirst()
        return WritingCorrection(
            span: table.span(word.from, word.to), original: word.text, replacement: replacement,
            kind: WritingRule.sentenceCapital.kind, reason: WritingCopy.sentenceStart, source: .rule(.sentenceCapital)
        )
    }

    /// Whether the sentence ending just before `end` starts with an uppercase letter.
    private func previousSentenceStartsWithCapital(endingAt end: Int) -> Bool {
        var k = end - 1
        // Step over the terminator itself.
        while k >= 0, Self.terminators.contains(chars[k]) || Self.closers.contains(chars[k]) { k -= 1 }
        var start = 0
        while k > 0 {
            if chars[k].isWhitespace, Self.endsSentence(table, before: k) { start = k; break }
            k -= 1
        }
        guard let letter = chars[start..<end].first(where: \.isLetter) else { return false }
        return letter.isUppercase
    }

    // MARK: "a" and "an"

    /// Words that, after an article-like "a", show the "a" is a label or a letter: "part a is".
    static let notAfterArticle: Set<String> = [
        "is", "are", "was", "were", "be", "been", "or", "and", "of", "in", "on", "at", "as", "if", "it",
        "its", "to", "by", "so", "up", "but", "for", "the", "an", "a", "i", "into", "onto", "upon", "unless",
        "until", "or", "nor", "versus", "vs", "with", "without", "has", "have", "had", "will", "would",
        "should", "can", "could", "may", "might", "must", "shall", "does", "did", "do", "am",
    ]

    /// Words before "a" that make it a label: "plan a", "vitamin a", "option a".
    static let labelWords: Set<String> = [
        "plan", "part", "option", "type", "vitamin", "grade", "section", "item", "step", "point", "class",
        "model", "exhibit", "appendix", "list", "group", "team", "side", "row", "column", "size",
        "category", "level", "phase", "version", "letter", "figure", "table", "chapter", "tier", "track",
        "variant", "case", "box", "line", "block", "zone", "lot", "unit", "building", "gate", "terminal",
        "hall", "room", "suite", "floor", "wing", "lane", "platform", "route", "series", "squad", "league",
    ]

    func articles() -> [WritingCorrection] {
        let ws = words
        var out: [WritingCorrection] = []
        for k in 0..<ws.count where k + 1 < ws.count {
            let article = ws[k], next = ws[k + 1]
            let a = article.text
            guard a == "a" || a == "A" || a == "an" || a == "An" else { continue }
            // Exactly one plain space between, and the article is a word on its own.
            guard next.from == article.to + 1, chars[article.to] == " " else { continue }
            if article.from > 0 {
                let before = chars[article.from - 1]
                guard before.isWhitespace || before == "(" || before == "“" || before == "\"" else { continue }
            }
            if k > 0, ws[k - 1].to + 1 == article.from, Self.labelWords.contains(ws[k - 1].text.lowercased()) { continue }
            // A word that follows on directly with a mark ("a." or "a)") is a label.
            let lower = next.text.lowercased()
            guard !Self.notAfterArticle.contains(lower) else { continue }
            guard let sound = Self.sound(of: next.text) else { continue }
            let isAn = a.lowercased() == "an"
            let wantsAn = sound == .vowel
            guard isAn != wantsAn else { continue }
            let replacement: String
            switch (a, wantsAn) {
            case ("a", true): replacement = "an"
            case ("A", true): replacement = "An"
            case ("an", false): replacement = "a"
            default: replacement = "A"
            }
            let headword = next.text.split(separator: "-").first.map(String.init) ?? next.text
            out.append(WritingCorrection(
                span: table.span(article.from, article.to), original: a, replacement: replacement,
                kind: WritingRule.article.kind,
                reason: wantsAn ? WritingCopy.vowelSound(headword) : WritingCopy.consonantSound(headword),
                source: .rule(.article)
            ))
        }
        return out
    }

    enum Sound { case vowel, consonant }

    /// Two capitals that are also words, said as words ("a NO vote"), not letter by letter.
    static let capsWords: Set<String> = [
        "NO", "SO", "GO", "DO", "TO", "ME", "MY", "BE", "WE", "HE", "OF", "ON", "OR", "IN", "IS", "IT", "AT",
        "AS", "AN", "UP", "US", "OK", "OH", "HI", "BY", "IF", "AM", "OX", "AX", "EX", "LO", "YO", "MA", "PA",
    ]

    /// The sound a capital letter's name starts with: "ef", "em", "ess" with a vowel; "you",
    /// "double-u", "why" with a consonant. "H" is "aitch" or "haitch", so it says nothing.
    static func letterSound(_ letter: Character) -> Sound? {
        if letter == "H" { return nil }
        return "AEFILMNORSX".contains(letter) ? .vowel : .consonant
    }

    /// The sound a number starts with when read aloud: "an 8", "an 11", "an 18", "an 80";
    /// "a 1", "a 7", "a 100". Longer numbers and those starting with 0 can be read more than one
    /// way ("1100" as "eleven hundred" or "one thousand"), so Caret cannot tell.
    static func numberSound(_ word: String) -> Sound? {
        let digits = String(word.prefix(while: \.isNumber))
        guard let first = digits.first, first != "0" else { return nil }
        if first == "8" || digits == "11" || digits == "18" { return .vowel }
        return digits.count <= 3 ? .consonant : nil
    }

    /// Stems of words spelled with "u" that start with a "you" sound: "unit" covers "units",
    /// "united", "unity". Every other "u" word starts with a vowel sound ("umbrella", "unusual",
    /// "uninformed").
    static let youStems = [
        "unicorn", "unicycl", "unidirectional", "unific", "unified", "unifies", "unify", "uniform",
        "unilateral", "union", "uniq", "unisex", "unison", "unit", "univers", "unix", "unanimous",
        "uranium", "urea", "ureter", "urethr", "urin", "usab", "usag", "use", "using", "usual", "usurp",
        "usury", "utensil", "uter", "util", "utopi", "uvul", "ubiquit", "ukulele", "ukrain", "uganda",
        "uruguay", "utah", "uzbek",
    ]

    /// Lowercase initialisms spelled with "u" and said letter by letter: "a url".
    static let youLetters: Set<String> = ["url", "urls", "usb", "ufo", "ufos", "uti"]

    /// Words with a silent "h": "an hour", "an honest".
    static let silentH = ["hour", "honest", "honor", "honour", "heir"]

    /// Either article is in use: "a historic" and "an historic", "a herb" and "an herb".
    static let eitherArticle = [
        "herb", "historic", "historical", "hotel", "heroic", "homage", "hypothes", "habitual", "humble",
        "hospitable",
    ]

    /// The sound a word starts with, or nil when Caret cannot tell: a digit, an acronym, a single
    /// letter, a word without vowels ("sql"), or a word that takes either article.
    static func sound(of word: String) -> Sound? {
        guard let firstChar = word.first else { return nil }
        if firstChar.isNumber { return numberSound(word) }
        guard firstChar.isLetter else { return nil }
        let letters = word.filter(\.isLetter)
        // Two capitals are said letter by letter: "a UX review", "an MA". Longer ones may be
        // said as a word ("a NASA probe", "a SQL" or "an SQL"), so Caret cannot tell.
        if letters.count == 2, letters.allSatisfy(\.isUppercase), word.count == 2 {
            return capsWords.contains(word) ? nil : letterSound(firstChar)
        }
        if letters.count >= 2, letters.allSatisfy(\.isUppercase) { return nil }
        let lower = word.lowercased()
        let head = lower.split(separator: "-").first.map(String.init) ?? lower
        guard head.count >= 2, let initial = head.first else { return nil }
        if youLetters.contains(head) { return .consonant }
        if !head.contains(where: { "aeiouy".contains($0) }) { return nil }
        if eitherArticle.contains(where: { head.hasPrefix($0) }) { return nil }
        if silentH.contains(where: { head.hasPrefix($0) }) { return .vowel }
        // "one" and "once" start with a "w" sound; "onerous" and "onion" do not.
        if ["one", "ones", "once", "oneself"].contains(head) { return .consonant }
        // Lowercase "eu" words start with "you" (eulogy, euphoria). A capitalized one may be a
        // name said otherwise ("an Euler diagram"), so only the known "you" names count.
        if head.hasPrefix("eu") {
            guard firstChar.isUppercase else { return .consonant }
            return ["europ", "euro", "eura", "eucli", "eugen", "eucha"].contains(where: { head.hasPrefix($0) }) ? .consonant : nil
        }
        if head.hasPrefix("ewe") || head.hasPrefix("ouija") { return .consonant }
        if initial == "u", youStems.contains(where: { head.hasPrefix($0) }) { return .consonant }
        return "aeiou".contains(initial) ? .vowel : .consonant
    }
}
