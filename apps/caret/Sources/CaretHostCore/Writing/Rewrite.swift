import Foundation

/// Rewrites of a sentence the user wrote, from the local base model (Gemma), for the rewrite
/// alternatives: the prompt it continues, and the rules a line it writes must pass.
///
/// The model is a base model, not an instruction model, so the prompt is a pattern it continues:
/// three worked sentences, each followed by three rewrites, then the user's sentence and
/// "Rewrite 1:". The examples are synthetic.
public enum RewritePrompt {
    public static let header = """
    Each sentence below is followed by three rewrites. A rewrite keeps the meaning, the names and the numbers, and changes the wording. Each rewrite is one line.

    Sentence: Can we push the meeting to Friday?
    Rewrite 1: Could we move the meeting to Friday?
    Rewrite 2: Would Friday work for the meeting instead?
    Rewrite 3: Is it possible to reschedule the meeting for Friday?

    Sentence: I wanted to check if you had a chance to look at the draft.
    Rewrite 1: Have you had a chance to look at the draft yet?
    Rewrite 2: Just checking whether you've reviewed the draft.
    Rewrite 3: I'm following up to see if you've read the draft.

    Sentence: The report is late because the data came in on Tuesday.
    Rewrite 1: The data arrived on Tuesday, so the report is running late.
    Rewrite 2: Because the data only came in on Tuesday, the report is delayed.
    Rewrite 3: The report slipped since we didn't get the data until Tuesday.

    """

    /// The prompt for `sentence`, ending where the first rewrite starts.
    public static func prompt(for sentence: String) -> String {
        header + "Sentence: " + oneLine(sentence) + "\nRewrite 1:"
    }

    static func oneLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// The rewrites in a continuation of `prompt(for:)`, which starts just after "Rewrite 1:" and
    /// numbers the next ones. Stops at the next "Sentence:" or a blank line.
    public static func parse(continuation: String) -> [String] {
        var out: [String] = []
        for (index, raw) in ("Rewrite 1:" + continuation).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("Sentence:") { break }
            guard line.hasPrefix("Rewrite \(index + 1):") else { break }
            out.append(String(line.dropFirst("Rewrite \(index + 1):".count)).trimmingCharacters(in: .whitespaces))
        }
        return out
    }

    /// Whether the continuation holds a complete answer: three finished rewrite lines, or the
    /// start of the next example.
    public static func isComplete(continuation: String) -> Bool {
        let lines = ("Rewrite 1:" + continuation).split(separator: "\n", omittingEmptySubsequences: false)
        if lines.dropFirst().contains(where: { $0.trimmingCharacters(in: .whitespaces).isEmpty || $0.hasPrefix("Sentence:") }) { return true }
        return lines.count > 3
    }
}

/// Which rewrites are offered, in order: one that is empty, the original again, a repeat, a line
/// with names or numbers the original doesn't have, or one far longer or shorter is dropped.
public enum RewriteFilter {
    /// A rewrite between a third and three times the original's length, in characters. Chosen, not measured.
    public static let lengthRatio: ClosedRange<Double> = (1.0 / 3.0)...3.0

    public static func offered(_ rewrites: [String], original: String) -> [String] {
        var seen: Set<String> = [key(original)]
        var out: [String] = []
        for rewrite in rewrites {
            let text = rewrite.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, seen.insert(key(text)).inserted else { continue }
            let ratio = Double(text.count) / Double(max(1, original.count))
            guard lengthRatio.contains(ratio), keepsFacts(text, original: original) else { continue }
            out.append(text)
        }
        return out
    }

    /// Every number and every capitalized word after the first in `rewrite` is in `original`:
    /// a rewrite never brings a name or a figure the user didn't write.
    public static func keepsFacts(_ rewrite: String, original: String) -> Bool {
        let known = Set(words(original).map { $0.word.lowercased() })
        for (word, startsSentence) in words(rewrite) {
            let isNumber = word.contains(where: \.isNumber)
            let isName = !startsSentence && word.first?.isUppercase == true && word != "I" && !word.hasPrefix("I'") && !word.hasPrefix("I\u{2019}")
            if (isNumber || isName), !known.contains(word.lowercased()) { return false }
        }
        return true
    }

    /// The words of `text`, each with whether it starts a sentence (first, or after . ! ? or :).
    static func words(_ text: String) -> [(word: String, startsSentence: Bool)] {
        var out: [(String, Bool)] = []
        var startsSentence = true
        for chunk in text.split(whereSeparator: \.isWhitespace) {
            let word = chunk.filter { $0.isLetter || $0.isNumber || $0 == "'" || $0 == "\u{2019}" }
            if !word.isEmpty { out.append((String(word), startsSentence)) }
            if let last = chunk.last(where: { !($0 == "\"" || $0 == "\u{201D}" || $0 == ")") }) {
                startsSentence = ".!?:".contains(last)
            }
        }
        return out
    }

    static func key(_ text: String) -> String {
        text.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
