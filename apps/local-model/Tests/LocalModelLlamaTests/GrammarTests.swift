// Grammar refusal: whatever the logits say, the picked text stays in the grammar's language. These tests load only
// the model's vocabulary (vocab_only), never its weights, and feed the picker logits that favor text outside the
// grammar, so the model's own preferences cannot be what keeps the output inside.
import Foundation
import LocalModelLlama
import Testing
import llama

private let modelPath: String = {
    if let p = ProcessInfo.processInfo.environment["CARET_MODEL_PATH"], !p.isEmpty { return p }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/app.cotypist.Cotypist/Models/gemma-4-E2B-i1-Q4_K_M.gguf").path
}()
private let haveModel = FileManager.default.fileExists(atPath: modelPath)

/// One vocabulary for the whole suite: loading it reads the GGUF's metadata, not its weights.
private let vocab: LlamaModel? = haveModel ? try? LlamaModel(path: modelPath, vocabOnly: true) : nil

/// SplitMix64, so each run sees the same logits.
private struct Rng {
    var s: UInt64
    mutating func next() -> UInt64 {
        s &+= 0x9E37_79B9_7F4A_7C15
        var z = s
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func unit() -> Float { Float(next() >> 40) / Float(1 << 24) }
}

/// Text the logits push for at every step: other routes, JSON, prose, and the end of generation.
private func adversaries(_ m: LlamaModel) throws -> [llama_token] {
    var out: [llama_token] = []
    for s in ["plan", "route: plan", "{", " hello", "```", "\n", "ask", "noSuchField", " 8", "pm"] { out += try m.tokenize(s, addSpecial: false) }
    return out
}

/// Picks until the grammar ends generation, with random logits and the adversaries on top. Returns the text, and
/// whether the fast path (the unconstrained argmax) and the filtered path each ran.
private func run(_ m: LlamaModel, grammar: String, seed: UInt64, check: Bool) throws -> (text: String, ended: Bool, fast: Int, filtered: Int) {
    let picker = try GrammarPicker(model: m, grammar: grammar)
    let bad = try adversaries(m)
    var rng = Rng(s: seed)
    var logits = [Float](repeating: 0, count: m.vocabSize)
    var bytes: [UInt8] = []
    var fast = 0, filtered = 0
    for step in 0..<400 {
        for i in logits.indices { logits[i] = rng.unit() * 10 }
        // Every other step, the adversaries win the unconstrained argmax; otherwise chance decides.
        if step % 2 == 0 { for (k, t) in bad.enumerated() { logits[Int(t)] = 50 + Float(k) } }
        if m.eos >= 0 { logits[Int(m.eos)] = 100 }
        let t = try logits.withUnsafeBufferPointer { try picker.pick($0.baseAddress!) }
        if check {
            let ref = try logits.withUnsafeBufferPointer { try picker.pickFiltered($0.baseAddress!) }
            #expect(t == ref, "the fast pick \(t) differs from filtering the whole vocabulary (\(ref)) at step \(step)")
            let argmax = logits.indices.max { logits[$0] < logits[$1] }!
            if Int(t) == argmax { fast += 1 } else { filtered += 1 }
        }
        if m.isEndOfGeneration(t) { return (String(decoding: bytes, as: UTF8.self), true, fast, filtered) }
        picker.accept(t)
        bytes += m.piece(t)
    }
    return (String(decoding: bytes, as: UTF8.self), false, fast, filtered)
}

/// A small intent-shaped grammar whose language is finite, so the test can list it: two refusals, or a fill with a
/// literal that is any run of whole units of "at 8:15 pm". Its many overlapping alternatives make the filter work.
private let units = ["at", "8", ":", "15", "pm"]
private let seps = [" ", "", "", " "]
private let spanGrammar: String = {
    var rules = ["root ::= \"route: \" ( \"refuse\\nwhy: \" ( \"payment\" | \"neverTyped\" ) | \"fill\\nliteral: \" span ) \"\\nend\\n\""]
    rules.append("span ::= " + units.indices.map { "s\($0)" }.joined(separator: " | "))
    for i in units.indices {
        let sep = i + 1 < units.count && !seps[i].isEmpty ? "\"\(seps[i])\" " : ""
        let next = i + 1 < units.count ? " ( \(sep)s\(i + 1) )?" : ""
        rules.append("s\(i) ::= \"\(units[i])\"\(next)")
    }
    return rules.joined(separator: "\n")
}()
private let spanLanguage: Set<String> = {
    var spans: [String] = []
    for i in units.indices {
        var s = units[i]
        spans.append(s)
        for j in (i + 1)..<units.count {
            s += seps[j - 1] + units[j]
            spans.append(s)
        }
    }
    return Set(["route: refuse\nwhy: payment\nend\n", "route: refuse\nwhy: neverTyped\nend\n"] + spans.map { "route: fill\nliteral: \($0)\nend\n" })
}()

@Suite(.serialized, .enabled(if: haveModel, "needs the GGUF at CARET_MODEL_PATH or Cotypist's path"))
struct GrammarRefusalTests {
    @Test func theListedLanguageIsWhatTheTestThinks() {
        #expect(spanLanguage.contains("route: fill\nliteral: 8:15 pm\nend\n"))
        #expect(spanLanguage.contains("route: fill\nliteral: at 8\nend\n"))
        #expect(!spanLanguage.contains("route: fill\nliteral: 8:1\nend\n"))
        #expect(spanLanguage.count == 2 + 15)
    }

    @Test func aGrammarThatDoesNotParseIsRefusedLoudly() throws {
        let m = try #require(vocab)
        #expect(throws: LocalModelError.grammarInvalid) { try GrammarPicker(model: m, grammar: "root ::= (\"unclosed\"") }
        #expect(throws: LocalModelError.grammarInvalid) { try GrammarPicker(model: m, grammar: "start ::= \"no root rule\"") }
    }

    @Test(arguments: 0..<24)
    func adversarialLogitsNeverLeaveTheLanguage(seed: UInt64) throws {
        let m = try #require(vocab)
        let r = try run(m, grammar: spanGrammar, seed: seed, check: false)
        #expect(r.ended, "generation did not end within 400 steps: \(r.text.debugDescription)")
        #expect(spanLanguage.contains(r.text), "\(r.text.debugDescription) is outside the grammar")
    }

    @Test func theFastPickEqualsFilteringTheWholeVocabulary() throws {
        let m = try #require(vocab)
        var fast = 0, filtered = 0
        for seed in UInt64(100)..<104 {
            let r = try run(m, grammar: spanGrammar, seed: seed, check: true)
            #expect(spanLanguage.contains(r.text))
            fast += r.fast
            filtered += r.filtered
        }
        // Both paths ran, or the comparison proved nothing.
        #expect(fast > 0 && filtered > 0, "fast \(fast), filtered \(filtered)")
    }

    /// The helper's intent grammar for a synthetic snapshot (helper/test/intent-local.test.ts writes and checks the
    /// same file): it parses here, and adversarial picking ends at a complete intent.
    @Test(arguments: 0..<6)
    func theHelpersIntentGrammarParsesAndEndsComplete(seed: UInt64) throws {
        let m = try #require(vocab)
        let url = try #require(Bundle.module.url(forResource: "intent-sample", withExtension: "gbnf", subdirectory: "Fixtures"))
        let g = try String(contentsOf: url, encoding: .utf8)
        let r = try run(m, grammar: g, seed: seed, check: false)
        #expect(r.ended, "generation did not end within 400 steps: \(r.text.debugDescription)")
        #expect(r.text.hasPrefix("route: "), "\(r.text.debugDescription)")
        #expect(r.text.hasSuffix("end\n"), "\(r.text.debugDescription)")
    }
}
