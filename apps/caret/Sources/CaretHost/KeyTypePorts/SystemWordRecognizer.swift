//  Adapted from KeyType's app target, `KeyType/Logic/Completion/SystemWordRecognizer.swift` and
//  `SpellingLanguage.swift` (MIT, see packages/keytype/LICENSE). Both live in KeyType's app rather
//  than a package. Behaviour is unchanged: the typo guard (ADR-015), the output filter's re-check
//  (ADR-024) and the regional dictionary choice (ADR-122).

import AppKit
import AutocompleteCore
import ConstrainedGeneration
import Foundation

/// Recognises words against the system dictionary via `NSSpellChecker`.
///
/// Conservative so the typo guard never produces a false positive: any word the checker cannot
/// evaluate is reported as recognised. `NSSpellChecker` is main-thread affine, so the async seam
/// hops to the main actor and the synchronous seam answers "recognised" off the main thread.
struct SystemWordRecognizer: WordRecognizing, SynchronousWordRecognizing {
    func recognizes(_ word: String, language: String?) async -> Bool {
        guard !word.isEmpty else { return true }
        return await MainActor.run { Self.isRecognized(word, language: language) }
    }

    func recognizes(_ word: String, language: String?) -> Bool {
        guard !word.isEmpty, Thread.isMainThread else { return true }
        return Self.isRecognized(word, language: language)
    }

    /// False only when the dictionary has no completion at all for `prefix` (ADR-052).
    func canCompleteWord(prefix: String, language: String?) -> Bool {
        guard !prefix.isEmpty, Thread.isMainThread else { return true }
        let checker = NSSpellChecker.shared
        let resolved = Self.resolveLanguage(language, checker: checker)
        checker.automaticallyIdentifiesLanguages = (resolved == nil)
        let range = NSRange(location: 0, length: (prefix as NSString).length)
        guard let completions = checker.completions(
            forPartialWordRange: range,
            in: prefix,
            language: resolved,
            inSpellDocumentWithTag: 0
        ) else { return true }
        return !completions.isEmpty
    }

    private static func isRecognized(_ word: String, language: String?) -> Bool {
        let checker = NSSpellChecker.shared
        let resolved = resolveLanguage(language, checker: checker)
        checker.automaticallyIdentifiesLanguages = (resolved == nil)
        let misspelled = checker.checkSpelling(
            of: word,
            startingAt: 0,
            language: resolved,
            wrap: false,
            inSpellDocumentWithTag: 0,
            wordCount: nil
        )
        return misspelled.location == NSNotFound
    }

    private static func resolveLanguage(_ requested: String?, checker: NSSpellChecker) -> String? {
        SpellingLanguage.resolve(requested, availableLanguages: checker.availableLanguages)
    }
}

/// Maps a detected base-language tag onto an installed dictionary, preferring the user's own
/// regional variant ("en" on an en-GB system resolves to "en_GB"). See ADR-122.
enum SpellingLanguage {
    static func resolve(
        _ requested: String?,
        availableLanguages: [String],
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> String? {
        guard let requested, !requested.isEmpty else { return nil }
        let normalized = requested.replacingOccurrences(of: "-", with: "_")
        let base = String(normalized.prefix { $0 != "_" })
        if normalized == base {
            let preferred = preferredLanguages
                .map { $0.replacingOccurrences(of: "-", with: "_") }
                .first { String($0.prefix { $0 != "_" }) == base }
            if let preferred, preferred != base, availableLanguages.contains(preferred) {
                return preferred
            }
        }
        if availableLanguages.contains(normalized) { return normalized }
        if availableLanguages.contains(base) { return base }
        return nil
    }
}
