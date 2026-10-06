import Foundation
import llama

public enum LocalModelError: Error, Equatable, CustomStringConvertible {
    case modelMissing(String)
    case modelLoadFailed(String)
    case contextFailed
    case grammarInvalid
    case tokenizeFailed
    case decodeFailed(Int32)
    case contextFull(needed: Int, nCtx: Int)
    case stateSaveFailed
    case stateRestoreFailed
    /// The grammar allowed no token at all, which a well-formed grammar never does before it completes.
    case grammarDeadEnd

    public var description: String {
        switch self {
        case .modelMissing(let p): return "no model file at \(p)"
        case .modelLoadFailed(let p): return "llama could not load \(p)"
        case .contextFailed: return "llama could not create a context"
        case .grammarInvalid: return "the grammar does not parse as GBNF with a root rule (llama's log on stderr says where)"
        case .tokenizeFailed: return "the text could not be tokenized"
        case .decodeFailed(let rc): return "llama_decode returned \(rc)"
        case .contextFull(let needed, let nCtx): return "the request needs \(needed) tokens of context and the context holds \(nCtx)"
        case .stateSaveFailed: return "the prefix's state could not be saved"
        case .stateRestoreFailed: return "the prefix's saved state could not be restored"
        case .grammarDeadEnd: return "the grammar allowed no next token"
        }
    }
}

/// llama.cpp's process-wide setup, once. Its log goes to stderr at warning level and above, so a grammar that
/// fails to parse says why there; the rest is dropped.
enum Backend {
    static let ready: Void = {
        llama_log_set({ level, text, _ in
            guard let text, level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN else { return }
            fputs(String(cString: text), stderr)
        }, nil)
        llama_backend_init()
    }()
}

/// A GGUF read in place by path (llama maps it; nothing is copied). `vocabOnly` reads the vocabulary alone,
/// which is all the grammar needs. Unchecked Sendable: nothing changes after init, and every call here only reads
/// the model and its vocabulary.
public final class LlamaModel: @unchecked Sendable {
    let model: OpaquePointer
    let vocab: OpaquePointer
    public let path: String

    public init(path: String, vocabOnly: Bool) throws {
        guard FileManager.default.fileExists(atPath: path) else { throw LocalModelError.modelMissing(path) }
        _ = Backend.ready
        var p = llama_model_default_params()
        p.use_mmap = true
        p.use_mlock = false
        p.vocab_only = vocabOnly
        guard let m = llama_model_load_from_file(path, p) else { throw LocalModelError.modelLoadFailed(path) }
        guard let v = llama_model_get_vocab(m) else {
            llama_model_free(m)
            throw LocalModelError.modelLoadFailed(path)
        }
        model = m
        vocab = v
        self.path = path
    }

    deinit { llama_model_free(model) }

    public var vocabSize: Int { Int(llama_vocab_n_tokens(vocab)) }

    public func isEndOfGeneration(_ t: llama_token) -> Bool { llama_vocab_is_eog(vocab, t) }

    /// The end-of-sequence token, or a negative value when the vocabulary has none.
    public var eos: llama_token { llama_vocab_eos(vocab) }

    /// Tokens for `text`. `addSpecial` adds the model's BOS (Gemma is trained with it first). Control-token text
    /// in the input ("<start_of_turn>" in a window title) stays plain text: parse_special is off.
    public func tokenize(_ text: String, addSpecial: Bool) throws -> [llama_token] {
        let bytes = Array(text.utf8)
        var cap = bytes.count + 8
        for _ in 0..<2 {
            var out = [llama_token](repeating: 0, count: cap)
            let n = bytes.withUnsafeBufferPointer { b in
                b.withMemoryRebound(to: CChar.self) { c in
                    llama_tokenize(vocab, c.baseAddress, Int32(bytes.count), &out, Int32(cap), addSpecial, false)
                }
            }
            if n >= 0 { return Array(out.prefix(Int(n))) }
            if n == Int32.min { break }
            cap = Int(-n)
        }
        throw LocalModelError.tokenizeFailed
    }

    /// The bytes a token stands for; control tokens render as nothing.
    public func piece(_ t: llama_token) -> [UInt8] {
        var buf = [CChar](repeating: 0, count: 64)
        var n = llama_token_to_piece(vocab, t, &buf, Int32(buf.count), 0, false)
        if n < 0 {
            buf = [CChar](repeating: 0, count: Int(-n))
            n = llama_token_to_piece(vocab, t, &buf, Int32(buf.count), 0, false)
        }
        return buf.prefix(max(0, Int(n))).map { UInt8(bitPattern: $0) }
    }
}

/// Greedy decoding restricted to a GBNF grammar. Each step takes the most likely token when the grammar accepts
/// it, and otherwise the most likely of the tokens the grammar accepts. Both give the argmax over the allowed set,
/// so the result equals filtering the whole vocabulary every step, which costs far more on a 262k vocabulary.
public final class GrammarPicker {
    private let sampler: UnsafeMutablePointer<llama_sampler>
    private let model: LlamaModel
    private var all: [llama_token_data]

    public init(model: LlamaModel, grammar: String) throws {
        guard let s = llama_sampler_init_grammar(model.vocab, grammar, "root") else { throw LocalModelError.grammarInvalid }
        sampler = s
        self.model = model
        all = [llama_token_data](repeating: llama_token_data(id: 0, logit: 0, p: 0), count: model.vocabSize)
    }

    deinit { llama_sampler_free(sampler) }

    /// The next token for these logits (one per vocabulary entry). Does not advance the grammar: call `accept`.
    public func pick(_ logits: UnsafePointer<Float>) throws -> llama_token {
        let n = all.count
        var best = 0
        for i in 1..<n where logits[i] > logits[best] { best = i }
        if allows(llama_token(best), logit: logits[best]) { return llama_token(best) }
        return try pickFiltered(logits)
    }

    /// The reference path: filter the whole vocabulary through the grammar, then take the argmax. Tests compare
    /// `pick` against it.
    public func pickFiltered(_ logits: UnsafePointer<Float>) throws -> llama_token {
        let n = all.count
        for i in 0..<n { all[i] = llama_token_data(id: llama_token(i), logit: logits[i], p: 0) }
        var chosen: llama_token?
        var top = -Float.infinity
        all.withUnsafeMutableBufferPointer { b in
            var arr = llama_token_data_array(data: b.baseAddress, size: n, selected: -1, sorted: false)
            llama_sampler_apply(sampler, &arr)
            // The sampler may reorder or shrink the array it was given; read what it left.
            for i in 0..<arr.size where arr.data[i].logit > top {
                top = arr.data[i].logit
                chosen = arr.data[i].id
            }
        }
        guard let chosen, top > -Float.infinity else { throw LocalModelError.grammarDeadEnd }
        return chosen
    }

    public func accept(_ t: llama_token) { llama_sampler_accept(sampler, t) }

    private func allows(_ t: llama_token, logit: Float) -> Bool {
        var one = llama_token_data(id: t, logit: logit, p: 0)
        return withUnsafeMutablePointer(to: &one) { p in
            var arr = llama_token_data_array(data: p, size: 1, selected: -1, sorted: false)
            llama_sampler_apply(sampler, &arr)
            return arr.size == 1 && arr.data[0].logit > -Float.infinity
        }
    }
}
