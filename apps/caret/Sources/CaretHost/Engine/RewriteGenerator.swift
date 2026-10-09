import AutocompleteCore
import CaretHostCore
import Foundation
import ModelRuntime

/// Writes rewrites of a sentence with the local model (`RewritePrompt`), decoding on KeyType's
/// runtime from the prompt as its anchor, one token per batched decode.
///
/// Two ways, both measured by `Caret --probe-rewrite`:
/// - `list`: one greedy continuation that numbers its own rewrites, so each sees the ones before.
/// - `sampled`: `count` continuations of "Rewrite 1:" at once, each drawing from the top logits
///   at `temperature`, each ending at its line's end.
struct RewriteGenerator {
    let runtime: LocalModelRuntime

    enum Mode: Equatable {
        case list
        case sampled(count: Int, temperature: Double, seed: UInt64)
    }

    struct Output {
        var rewrites: [String]
        /// When the first rewrite was complete, and when all were, from the start.
        var firstMs: Double
        var totalMs: Double
        var tokens: Int
    }

    func rewrites(of sentence: String, mode: Mode, maxTokens: Int = 96) async throws -> Output {
        let started = DispatchTime.now().uptimeNanoseconds
        func ms() -> Double { Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 }
        let anchor = try runtime.tokenizer.tokenize(RewritePrompt.prompt(for: sentence))
        let stops = Set([runtime.metadata.eosTokenID, runtime.metadata.eotTokenID].compactMap { $0 })
        switch mode {
        case .list:
            var suffix: [TokenID] = []
            var firstMs: Double?
            while suffix.count < maxTokens {
                try Task.checkCancellation()
                guard let logits = try await runtime.anchoredLogitsBatch(anchor: anchor, suffixes: [suffix]).first,
                      let best = logits.max(by: { $0.logit < $1.logit }), !stops.contains(best.tokenID) else { break }
                suffix.append(best.tokenID)
                let text = try runtime.tokenizer.detokenize(suffix)
                if firstMs == nil, text.contains("\n") { firstMs = ms() }
                if RewritePrompt.isComplete(continuation: text) { break }
            }
            let text = try runtime.tokenizer.detokenize(suffix)
            let total = ms()
            return Output(rewrites: RewritePrompt.parse(continuation: text), firstMs: firstMs ?? total, totalMs: total, tokens: suffix.count)
        case .sampled(let count, let temperature, let seed):
            var rng = SplitMix(seed: seed)
            var branches = [[TokenID]](repeating: [], count: count)
            var done = [Bool](repeating: false, count: count)
            var firstMs: Double?
            var steps = 0
            while done.contains(false), steps < maxTokens / 2 {
                try Task.checkCancellation()
                steps += 1
                // Branches that drew the same tokens so far share one decode.
                let open = branches.indices.filter { !done[$0] }
                var unique: [[TokenID]] = []
                for i in open where !unique.contains(branches[i]) { unique.append(branches[i]) }
                let logits = try await runtime.anchoredLogitsBatch(anchor: anchor, suffixes: unique)
                for i in open {
                    guard let slot = unique.firstIndex(of: branches[i]), slot < logits.count else { done[i] = true; continue }
                    guard let token = Self.sample(logits[slot], temperature: temperature, rng: &rng), !stops.contains(token) else {
                        done[i] = true
                        continue
                    }
                    branches[i].append(token)
                    if try runtime.tokenizer.detokenize(branches[i]).contains("\n") {
                        done[i] = true
                        if firstMs == nil { firstMs = ms() }
                    }
                }
            }
            let lines = try branches.map { try runtime.tokenizer.detokenize($0) }
                .map { String($0.prefix { $0 != "\n" }).trimmingCharacters(in: .whitespaces) }
            let total = ms()
            return Output(rewrites: lines, firstMs: firstMs ?? total, totalMs: total, tokens: branches.map(\.count).reduce(0, +))
        }
    }

    /// A draw from the top 40 logits at `temperature`.
    static func sample(_ logits: [TokenLogit], temperature: Double, rng: inout SplitMix) -> TokenID? {
        let top = Self.top(40, of: logits)
        guard let best = top.first else { return nil }
        let weights = top.map { exp(Double($0.logit - best.logit) / max(temperature, 0.01)) }
        let total = weights.reduce(0, +)
        var draw = Double(rng.next() >> 11) / Double(1 << 53) * total
        for (entry, weight) in zip(top, weights) {
            draw -= weight
            if draw <= 0 { return entry.tokenID }
        }
        return top.last?.tokenID
    }
}

extension RewriteGenerator {
    /// The `k` highest logits, highest first, in one pass: the runtime returns the whole
    /// vocabulary (262,144 entries for Gemma), too many to sort at every step.
    static func top(_ k: Int, of logits: [TokenLogit]) -> [TokenLogit] {
        var top: [TokenLogit] = []
        top.reserveCapacity(k + 1)
        for entry in logits {
            if top.count == k, let last = top.last, entry.logit <= last.logit { continue }
            let at = top.firstIndex { $0.logit < entry.logit } ?? top.count
            top.insert(entry, at: at)
            if top.count > k { top.removeLast() }
        }
        return top
    }
}

/// A seeded generator, so a probe run can be repeated draw for draw.
struct SplitMix {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
