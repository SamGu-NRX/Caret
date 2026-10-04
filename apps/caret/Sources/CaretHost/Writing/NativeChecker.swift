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
/// `.stale`, never as corrections. Not wired into the live app yet.
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

    private let checker: NSSpellChecker
    private var tags: [FieldKey: Int] = [:]
    private var generations: [FieldKey: Int] = [:]

    public init(checker: NSSpellChecker = .shared) {
        self.checker = checker
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
        guard let tag = tags.removeValue(forKey: field) else { return }
        generations[field] = nil
        checker.closeSpellDocument(withTag: tag)
    }

    public func closeAll() {
        for field in Array(tags.keys) { closeField(field) }
    }

    /// Checks `sentence` (UTF-16, in `text`) for spelling and grammar. The whole text goes to the
    /// checker as context; only errors inside `sentence` come back.
    public func check(_ text: String, sentence: UTF16Span, language: String, field: FieldKey) async -> Outcome {
        let tag = tag(for: field)
        let generation = (generations[field] ?? 0) + 1
        generations[field] = generation
        let options: [NSSpellChecker.OptionKey: Any] = [.orthography: NSOrthography.defaultOrthography(forLanguage: language)]
        let types = NSTextCheckingResult.CheckingType.spelling.rawValue | NSTextCheckingResult.CheckingType.grammar.rawValue
        let checker = self.checker
        let results: [NSTextCheckingResult] = await withCheckedContinuation { continuation in
            _ = checker.requestChecking(
                of: text, range: sentence.nsRange, types: types, options: options, inSpellDocumentWithTag: tag
            ) { _, results, _, _ in
                continuation.resume(returning: results)
            }
        }
        guard generations[field] == generation else { return .stale }
        let corrections = Self.corrections(from: results, text: text, sentence: sentence) { range in
            let correction = checker.correction(forWordRange: range, in: text, language: language, inSpellDocumentWithTag: tag)
            let guesses = checker.guesses(forWordRange: range, in: text, language: language, inSpellDocumentWithTag: tag) ?? []
            return (correction, guesses)
        }
        return .corrections(corrections)
    }

    /// The checker's results as corrections inside `sentence`.
    ///
    /// - Spelling: the checker's autocorrection if it has one, else its first guess, with up to two
    ///   more guesses. A flagged word with no guess has no fix to offer and is dropped, as is a
    ///   word that looks like a name, an acronym or an identifier (`WritingCheck.looksLikeName`),
    ///   or one inside a link, an address or code.
    /// - Grammar: each detail with at least one correction. Its range is relative to the result's
    ///   sentence range (`NSSpellServer.h`, `NSGrammarRange`). The reason is the checker's own
    ///   description when it gives one.
    nonisolated static func corrections(
        from results: [NSTextCheckingResult], text: String, sentence: UTF16Span,
        guesses: (NSRange) -> (correction: String?, guesses: [String])
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
                guard !WritingCheck.looksLikeName(word, atSentenceStart: startsSentence(span, sentence: sentence, in: ns)) else { continue }
                let (correction, all) = guesses(result.range)
                let ranked = ([correction].compactMap { $0 } + all).filter { $0 != word }
                var unique: [String] = []
                for g in ranked where !unique.contains(g) { unique.append(g) }
                guard let best = unique.first else { continue }
                out.append(WritingCorrection(
                    span: span, original: word, replacement: best, otherReplacements: Array(unique.dropFirst().prefix(2)),
                    kind: .spelling, reason: WritingCopy.notInDictionary, source: .spellChecker
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
                    let fixes = ((detail[NSGrammarCorrections] as? [String]) ?? []).filter { $0 != original }
                    guard let best = fixes.first else { continue }
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

    /// Whether only spaces and opening quotes lie between the sentence's start and `span`.
    nonisolated private static func startsSentence(_ span: UTF16Span, sentence: UTF16Span, in ns: NSString) -> Bool {
        guard span.start >= sentence.start else { return false }
        let lead = ns.substring(with: NSRange(location: sentence.start, length: span.start - sentence.start))
        return lead.allSatisfy { $0.isWhitespace || "\"'“‘(".contains($0) }
    }
}
