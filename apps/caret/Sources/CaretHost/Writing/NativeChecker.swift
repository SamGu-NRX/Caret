import AppKit
import CaretHostCore

/// Spelling and grammar from the system checker (`NSSpellChecker`), as `WritingCorrection`s.
///
/// Each field gets its own spell document tag, so words the user tells the checker to ignore in
/// one field stay ignored there and nowhere else; close the field's tag when it goes away. Checks
/// are asynchronous (`requestChecking`) and pass the language as an orthography rather than
/// setting the shared checker's language, which other apps' text views in this process would see.
///
/// A newer check of the same field makes an older one's answer stale; stale answers come back as
/// `.stale`, never as corrections. `WritingCoordinator` runs it at sentence boundaries.
@MainActor
public final class NativeChecker {
    /// The field a document tag belongs to: the element, without its content revision.
    public struct FieldKey: Hashable, Sendable {
        public var pid: Int32
        public var windowID: String
        public var elementID: String

        public init(pid: Int32, windowID: String, elementID: String) {
            self.pid = pid
            self.windowID = windowID
            self.elementID = elementID
        }

        public init(_ target: TargetIdentity) {
            self.init(pid: target.pid, windowID: target.windowID, elementID: target.elementID)
        }
    }

    public enum Outcome: Equatable, Sendable {
        case corrections([WritingCorrection])
        /// A newer check of the same field started before this one answered.
        case stale
    }

    /// One asynchronous check: the text, the range, the language, the document tag, and where
    /// to send the results. The default calls `requestChecking`; tests answer it themselves to
    /// control the order of replies.
    typealias Request = @MainActor (String, NSRange, String, Int, @escaping ([NSTextCheckingResult]) -> Void) -> Void

    /// What the checker is asked about one flagged word, per language. A port, so tests answer
    /// with fixed lists: the system checker's ranking moves between runs (T1's "adress" came back
    /// with "address" first in T2's runs and "a-dress" first in the lead's rerun, same commit), and
    /// no gating test may rest on it.
    struct Answers {
        var guesses: @MainActor (_ range: NSRange, _ text: String, _ language: String, _ tag: Int) -> [String]
        var autocorrection: @MainActor (_ range: NSRange, _ text: String, _ language: String, _ tag: Int) -> String?
        var accepts: @MainActor (_ word: String, _ language: String, _ tag: Int) -> Bool

        static func system(_ checker: NSSpellChecker) -> Answers {
            Answers(
                guesses: { range, text, language, tag in
                    checker.guesses(forWordRange: range, in: text, language: language, inSpellDocumentWithTag: tag) ?? []
                },
                autocorrection: { range, text, language, tag in
                    checker.correction(forWordRange: range, in: text, language: language, inSpellDocumentWithTag: tag)
                },
                accepts: { word, language, tag in
                    checker.checkSpelling(of: word, startingAt: 0, language: language, wrap: false, inSpellDocumentWithTag: tag, wordCount: nil)
                        .location == NSNotFound
                }
            )
        }
    }

    private let checker: NSSpellChecker
    private let request: Request
    private let answers: Answers
    private var tags: [FieldKey: Int] = [:]
    /// The latest check of each field, by a token never reused, so an answer from before a field
    /// was closed and reopened cannot pass for the newer check's.
    private var latest: [FieldKey: Int] = [:]
    private var nextToken = 0

    public convenience init(checker: NSSpellChecker = .shared) {
        self.init(checker: checker, request: nil)
    }

    init(checker: NSSpellChecker, request: Request?, answers: Answers? = nil, variants: [String]? = nil) {
        self.checker = checker
        self.answers = answers ?? .system(checker)
        self.regionalVariants = variants ?? NativeChecker.englishVariants(
            preferred: Locale.preferredLanguages, available: NSSpellChecker.shared.availableLanguages
        )
        self.request = request ?? { text, range, language, tag, done in
            let options: [NSSpellChecker.OptionKey: Any] = [.orthography: NSOrthography.defaultOrthography(forLanguage: language)]
            let types = NSTextCheckingResult.CheckingType.spelling.rawValue | NSTextCheckingResult.CheckingType.grammar.rawValue
            _ = checker.requestChecking(of: text, range: range, types: types, options: options, inSpellDocumentWithTag: tag) { _, results, _, _ in
                done(results)
            }
        }
    }

    /// Whether the system checker can check `language` ("en", "en_US", "fr") on this Mac.
    public static func supports(_ language: String) -> Bool {
        let wanted = language.replacingOccurrences(of: "-", with: "_").lowercased()
        return NSSpellChecker.shared.availableLanguages.contains { available in
            let a = available.lowercased()
            return a == wanted || a.hasPrefix(wanted + "_") || wanted.hasPrefix(a + "_")
        }
    }

    /// The document tag for `field`, made on first use.
    public func tag(for field: FieldKey) -> Int {
        if let tag = tags[field] { return tag }
        let tag = NSSpellChecker.uniqueSpellDocumentTag()
        tags[field] = tag
        return tag
    }

    /// Forgets the field's tag and what was ignored in it.
    public func closeField(_ field: FieldKey) {
        latest[field] = nil
        guard let tag = tags.removeValue(forKey: field) else { return }
        checker.closeSpellDocument(withTag: tag)
    }

    public func closeAll() {
        for field in Array(tags.keys) { closeField(field) }
    }

    /// Checks `sentence` (UTF-16, in `text`) for spelling and grammar. The whole text goes to the
    /// checker as context; only errors inside `sentence` come back.
    public func check(_ text: String, sentence: UTF16Span, language: String, field: FieldKey) async -> Outcome {
        let tag = tag(for: field)
        nextToken += 1
        let token = nextToken
        latest[field] = token
        let request = self.request
        let results: [NSTextCheckingResult] = await withCheckedContinuation { continuation in
            request(text, sentence.nsRange, language, tag) { continuation.resume(returning: $0) }
        }
        // A newer check, or a close, since this one started.
        guard latest[field] == token, tags[field] == tag else { return .stale }
        let answers = self.answers
        let variants = regionalVariants
        // The checking language first, then the other accepted Englishes in their fixed order.
        // Asked in this order every time: the system checker carries state between calls.
        let dictionaries = [language] + variants.filter { $0 != language }
        let corrections = Self.corrections(
            from: results, text: text, sentence: sentence,
            guesses: { range in
                let lists = dictionaries.map { answers.guesses(range, text, $0, tag) }
                return (answers.autocorrection(range, text, language, tag), lists)
            },
            spelledRightElsewhere: { word in variants.contains { answers.accepts(word, $0, tag) } },
            primaryAccepts: { word in answers.accepts(word, language, tag) }
        )
        return .corrections(corrections)
    }

    // MARK: - Languages

    /// The English spellings this user writes in, as checker language names (lead decision 1 of
    /// 2026-10-04). A word one of them accepts is never a spelling error, so "colour" and
    /// "finalised" stand on a Mac set to en-US. Read once per checker; a language change in System
    /// Settings applies from the next field.
    let regionalVariants: [String]

    /// Always accepted once the user writes English at all.
    nonisolated static let baseEnglishRegions = ["US", "GB", "CA"]

    /// When any language in the user's macOS list is English: US, GB and CA English, plus any other
    /// English region the list names itself (en-AU, en-NZ, en-IN), each where the checker has it.
    /// None when the list has no English.
    ///
    /// en-AU is not in the base set, against the decision's list of four, because its dictionary
    /// on macOS 26.6 accepts "seperate" and "truely" (every other English rejects both; measured
    /// 2026-10-04 with `checkSpelling`). As a witness for every English writer it hid two of the
    /// corpus's spelling errors. A user who lists en-AU gets it, quirks included.
    ///
    /// The checker lists American English as plain "en" on macOS 26, and the others as "en_GB".
    nonisolated static func englishVariants(preferred: [String], available: [String]) -> [String] {
        let english = preferred.map(Locale.init(identifier:)).filter { $0.language.languageCode == .english }
        guard !english.isEmpty else { return [] }
        var regions = baseEnglishRegions
        for region in english.compactMap({ $0.region?.identifier }) where !regions.contains(region) { regions.append(region) }
        let names = Set(available)
        return regions.compactMap { region in
            let name = "en_\(region)"
            if names.contains(name) { return name }
            return region == "US" && names.contains("en") ? "en" : nil
        }
    }

    /// The language to check in: the first of the user's macOS languages the checker has, as the
    /// checker names it ("en-GB" is "en_GB", "en-US" is "en"). Nil when it has none of them; then
    /// only the static rules run.
    nonisolated static func checkingLanguage(preferred: [String], available: [String]) -> String? {
        let names = Set(available)
        for identifier in preferred {
            let locale = Locale(identifier: identifier)
            guard let code = locale.language.languageCode?.identifier else { continue }
            if let region = locale.region?.identifier, names.contains("\(code)_\(region)") { return "\(code)_\(region)" }
            if names.contains(code) { return code }
        }
        return nil
    }

    /// The checker's results as corrections inside `sentence`.
    ///
    /// - Spelling: the merged first guess of the accepted dictionaries, with up to two more
    ///   (`rankGuesses`). A word another
    ///   English the user writes in accepts (`spelledRightElsewhere`) is not an error. A flagged
    ///   word with no guess has no fix to offer and is dropped, as is a word that looks like a name,
    ///   an acronym or an identifier (`WritingCheck.looksLikeName`), one quoted on its own, or one
    ///   inside a link, an address or code.
    /// - Grammar: each detail with at least one correction. Its range is relative to the result's
    ///   sentence range (`NSSpellServer.h`, `NSGrammarRange`). The reason is the checker's own
    ///   description when it gives one.
    nonisolated static func corrections(
        from results: [NSTextCheckingResult], text: String, sentence: UTF16Span,
        guesses: (NSRange) -> (correction: String?, lists: [[String]]),
        spelledRightElsewhere: (String) -> Bool = { _ in false },
        primaryAccepts: (String) -> Bool = { _ in true }
    ) -> [WritingCorrection] {
        let ns = text as NSString
        let protected = WritingText.protectedSpans(in: text)
        var out: [WritingCorrection] = []
        for result in results {
            switch result.resultType {
            case .spelling:
                let span = UTF16Span(result.range)
                guard sentence.contains(span), !span.isEmpty, !protected.contains(where: { $0.overlaps(span) }) else { continue }
                let word = ns.substring(with: result.range)
                guard !WritingCheck.looksLikeName(word, atSentenceStart: startsSentence(span, sentence: sentence, in: ns)),
                      !isQuotedMention(span, in: ns), !spelledRightElsewhere(word)
                else { continue }
                let (correction, lists) = guesses(result.range)
                guard let ranked = rankGuesses(word: word, autocorrection: correction, lists: lists, primaryAccepts: primaryAccepts) else { continue }
                out.append(WritingCorrection(
                    span: span, original: word, replacement: ranked.fix, otherReplacements: ranked.others,
                    kind: .spelling, reason: WritingCopy.notInDictionary, source: .spellChecker, needsChoice: ranked.needsChoice
                ))
            case .grammar:
                for detail in result.grammarDetails ?? [] {
                    let relative = (detail[NSGrammarRange] as? NSValue)?.rangeValue ?? NSRange(location: 0, length: result.range.length)
                    let range = NSRange(location: result.range.location + relative.location, length: relative.length)
                    let span = UTF16Span(range)
                    guard range.location + range.length <= ns.length, sentence.contains(span), !span.isEmpty,
                          !protected.contains(where: { $0.overlaps(span) })
                    else { continue }
                    let original = ns.substring(with: range)
                    // "What it is is", "had had": the static rules' list of meant repeats holds
                    // for the system checker too.
                    guard !WritingCheck.isMeantRepeat(original) else { continue }
                    let fixes = ((detail[NSGrammarCorrections] as? [String]) ?? []).filter { $0 != original }
                    // A top answer that cannot be English means the checker misread the sentence;
                    // its other answers come from the same reading, so the detail goes whole.
                    guard let best = fixes.first, agreesWithSubject(best, before: ns.substring(to: range.location)) else { continue }
                    let description = (detail[NSGrammarUserDescription] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    let reason = description.flatMap { $0.isEmpty || $0.count > 90 ? nil : $0 } ?? WritingCopy.grammar
                    out.append(WritingCorrection(
                        span: span, original: original, replacement: best, otherReplacements: Array(fixes.dropFirst().prefix(2)),
                        kind: .grammar, reason: reason, source: .spellChecker
                    ))
                }
            default:
                continue
            }
        }
        return out.sorted { $0.span.start < $1.span.start }
    }

    /// The fix for a misspelled word and the guesses after it (lead decision 2 of 2026-10-04), from
    /// each accepted dictionary's guesses, the checking language's list first.
    ///
    /// Merged deterministically: a guess ranks by its best position in any list, ties going to the
    /// earlier list, then to the order within it. The top of that order is the fix. It stands alone
    /// only when no other answer in reach disagrees; otherwise the mark needs a choice, and the
    /// answers that disagree lead the alternatives (at most two, in merged order):
    /// - the autocorrection, when it is in some list's top three and differs from the fix (T1's
    ///   "adress": guesses "address" first, autocorrects to "dress");
    /// - another dictionary's first guess, when it differs from the fix and the checking language
    ///   accepts it too, so it is a different word and not that word's regional spelling
    ///   ("organisation" under en-GB for "organization" is the same word, and no choice);
    /// - every one-word guess in some top three, when the fix splits the word in two ("a-dress",
    ///   "a dress"): the lead's rerun of T2 had macOS rank "a-dress" first for "adress".
    /// An autocorrection outside every top three is ignored. Nil when there is no guess.
    nonisolated static func rankGuesses(
        word: String, autocorrection: String?, lists: [[String]], primaryAccepts: (String) -> Bool = { _ in true }
    ) -> (fix: String, others: [String], needsChoice: Bool)? {
        let cleaned: [[String]] = lists.map { list in
            var unique: [String] = []
            for g in list where g != word && !g.isEmpty && !unique.contains(g) { unique.append(g) }
            return unique
        }
        var best: [String: (position: Int, list: Int)] = [:]
        for (i, list) in cleaned.enumerated() {
            for (p, g) in list.enumerated() where best[g].map({ (p, i) < ($0.position, $0.list) }) ?? true {
                best[g] = (p, i)
            }
        }
        let merged = best.keys.sorted { a, b in
            let x = best[a]!, y = best[b]!
            return (x.position, x.list) < (y.position, y.list)
        }
        guard let fix = merged.first else { return nil }
        let topThree = Set(cleaned.flatMap { $0.prefix(3) })

        var disagree: Set<String> = []
        if let auto = autocorrection, auto != fix, topThree.contains(auto) { disagree.insert(auto) }
        for first in cleaned.dropFirst().compactMap(\.first) where first != fix && primaryAccepts(first) { disagree.insert(first) }
        let splits = { (s: String) in s.contains(where: { $0 == " " || $0 == "-" }) }
        if splits(fix), !splits(word) { disagree.formUnion(topThree.filter { !splits($0) }) }
        let rest = merged.dropFirst()
        let others = Array((rest.filter(disagree.contains) + rest.filter { !disagree.contains($0) }).prefix(2))
        return (fix, others, !disagree.isEmpty)
    }

    /// Whether a grammar fix's verb can agree with the text before it. "am" takes only "I", so a fix
    /// to "am" anywhere else is wrong whatever the checker meant: macOS 26.6 offered "am", then
    /// "are", for "is" in "Neither of the reports is ready", T1's one false grammar correction on
    /// a clean sentence. Found on the corpus, so not a blind result.
    nonisolated static func agreesWithSubject(_ fix: String, before: String) -> Bool {
        let words = fix.split(separator: " ")
        guard let at = words.firstIndex(where: { $0.lowercased() == "am" }) else { return true }
        let previous = at > 0 ? String(words[at - 1]) : before.split(whereSeparator: { $0.isWhitespace }).last.map(String.init)
        return previous?.trimmingCharacters(in: CharacterSet(charactersIn: "\"'“‘(")) == "I"
    }

    /// A word quoted on its own is being mentioned, not used: The word "recieve" is misspelled.
    nonisolated private static func isQuotedMention(_ span: UTF16Span, in ns: NSString) -> Bool {
        guard span.start > 0, span.end < ns.length else { return false }
        let quotes: Set<unichar> = [0x22, 0x27, 0x201C, 0x201D, 0x2018, 0x2019]
        return quotes.contains(ns.character(at: span.start - 1)) && quotes.contains(ns.character(at: span.end))
    }

    /// Whether only spaces and opening quotes lie between the sentence's start and `span`.
    nonisolated private static func startsSentence(_ span: UTF16Span, sentence: UTF16Span, in ns: NSString) -> Bool {
        guard span.start >= sentence.start else { return false }
        let lead = ns.substring(with: NSRange(location: sentence.start, length: span.start - sentence.start))
        return lead.allSatisfy { $0.isWhitespace || "\"'“‘(".contains($0) }
    }
}
