import AutocompleteCore
import CaretHostCore
import Foundation
import ModelRuntime

/// Scores how likely the words after the caret are once a completion is inserted (`SuffixFit`).
///
/// Every arm decodes on the generation's own prompt as its anchor, which the runtime keeps
/// resident, so the next keystroke's generation still starts from the cached prompt. One batched
/// decode per scored token (one, `SuffixFit.tokens`), all arms together.
struct SuffixScorer {
    let runtime: LocalModelRuntime

    /// Each insert's log probability for each of the first `SuffixFit.tokens` tokens of the text
    /// after the caret, after `prompt` (which ends at the text before the caret with its trailing
    /// whitespace trimmed, as KeyType builds it), the trimmed whitespace and then the insert. An
    /// empty insert scores the text as it is. Nil when there is nothing after the caret to score.
    func tokenScores(prompt: String, beforeCursor: String, afterCursor: String, inserts: [String]) async throws -> [[Double]]? {
        let gap = String(beforeCursor.reversed().prefix { $0.isWhitespace }.reversed())
        let line = GhostSeam.followingLine(afterCursor)
        let words = line.drop { $0.isWhitespace }
        guard !words.isEmpty else { return nil }
        let tokenizer = runtime.tokenizer
        let anchor = try tokenizer.tokenize(prompt)
        var arms: [[TokenID]] = []
        var spaced: [Bool] = []
        for insert in inserts {
            let joined = gap + insert
            let trimmed = String(joined.reversed().drop { $0.isWhitespace }.reversed())
            arms.append(trimmed.isEmpty ? [] : try tokenizer.tokenize(trimmed))
            // A space between the insert and the next word when either side has one.
            spaced.append(joined.last?.isWhitespace == true || line.first?.isWhitespace == true || (trimmed.isEmpty && !gap.isEmpty))
        }
        // The scored tokens can differ per arm only in the space before the next word.
        let withSpace = Array(try tokenizer.tokenize(" " + String(words.prefix(48))).prefix(SuffixFit.tokens))
        let without = Array(try tokenizer.tokenize(String(words.prefix(48))).prefix(SuffixFit.tokens))
        var perToken = [[Double]](repeating: [], count: arms.count)
        for index in 0..<SuffixFit.tokens {
            try Task.checkCancellation()
            let suffixes = arms.indices.map { arm -> [TokenID] in
                let scored = spaced[arm] ? withSpace : without
                return arms[arm] + scored.prefix(index)
            }
            let logits = try await runtime.anchoredLogitsBatch(anchor: anchor, suffixes: suffixes)
            guard logits.count == arms.count else { return nil }
            for arm in arms.indices {
                let scored = spaced[arm] ? withSpace : without
                guard index < scored.count, let lp = Self.logProbability(of: scored[index], in: logits[arm]) else { continue }
                perToken[arm].append(lp)
            }
        }
        guard perToken.allSatisfy({ !$0.isEmpty }) else { return nil }
        return perToken
    }

    /// Log-softmax of `token` over the full logits vector, in nats.
    static func logProbability(of token: TokenID, in logits: [TokenLogit]) -> Double? {
        guard !logits.isEmpty else { return nil }
        var maxLogit = -Float.greatestFiniteMagnitude
        var target: Float?
        for entry in logits {
            if entry.logit > maxLogit { maxLogit = entry.logit }
            if entry.tokenID == token { target = entry.logit }
        }
        guard let target else { return nil }
        var sum: Double = 0
        for entry in logits { sum += exp(Double(entry.logit - maxLogit)) }
        return Double(target - maxLogit) - log(sum)
    }
}
