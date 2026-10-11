import Foundation
import LocalModelCore
import llama

/// One loaded model and one context, answering requests one at a time.
///
/// The prefix (the few-shot block every intent request shares) is decoded once; its sequence state is saved and
/// restored for each later request with the same prefix, so only the request's own prompt is decoded. KeyType
/// keeps its anchor the same way (LlamaModelRuntime anchorSnapshot), because a partial `llama_memory_seq_rm` is
/// not available on every model's memory.
public final class LlamaSession {
    public let model: LlamaModel
    private let ctx: OpaquePointer
    private let mem: llama_memory_t
    public let nCtx: Int
    private let nBatch: Int
    private var cached: (text: String, tokens: Int, state: [UInt8])?

    public init(modelPath: String, contextLength: Int) throws {
        model = try LlamaModel(path: modelPath, vocabOnly: false)
        var p = llama_context_default_params()
        p.n_ctx = UInt32(contextLength)
        p.n_batch = UInt32(contextLength)
        p.n_ubatch = min(p.n_batch, 512)
        p.n_seq_max = 1
        p.no_perf = true
        guard let c = llama_init_from_model(model.model, p), let m = llama_get_memory(c) else { throw LocalModelError.contextFailed }
        ctx = c
        mem = m
        nCtx = Int(llama_n_ctx(c))
        nBatch = Int(llama_n_batch(c))
    }

    /// Frees the context before the model; the Metal backend asserts at exit when buffers are still held
    /// (KeyType's LlamaModelRuntime.shutdown says the same).
    deinit { llama_free(ctx) }

    public func complete(_ r: Request) throws -> Completion {
        let clock = ContinuousClock()
        let t0 = clock.now
        let picker = try GrammarPicker(model: model, grammar: r.grammar)

        var prefixTokens = 0
        var prefixCached = false
        llama_memory_clear(mem, true)
        if !r.prefix.isEmpty {
            if let c = cached, c.text == r.prefix {
                let n = c.state.withUnsafeBufferPointer { llama_state_seq_set_data(ctx, $0.baseAddress, $0.count, 0) }
                guard n > 0 else {
                    cached = nil
                    throw LocalModelError.stateRestoreFailed
                }
                prefixTokens = c.tokens
                prefixCached = true
            } else {
                cached = nil
                let toks = try model.tokenize(r.prefix, addSpecial: true)
                guard toks.count < nCtx else { throw LocalModelError.contextFull(needed: toks.count, nCtx: nCtx) }
                try decode(toks)
                llama_synchronize(ctx)
                let size = llama_state_seq_get_size(ctx, 0)
                var state = [UInt8](repeating: 0, count: size)
                let got = state.withUnsafeMutableBufferPointer { llama_state_seq_get_data(ctx, $0.baseAddress, size, 0) }
                guard got == size else { throw LocalModelError.stateSaveFailed }
                cached = (r.prefix, toks.count, state)
                prefixTokens = toks.count
            }
        }
        let t1 = clock.now

        let prompt = try model.tokenize(r.prompt, addSpecial: r.prefix.isEmpty)
        let needed = prefixTokens + prompt.count + r.maxTokens
        guard needed <= nCtx else { throw LocalModelError.contextFull(needed: needed, nCtx: nCtx) }
        try decode(prompt)
        // Metal decodes asynchronously; without this the prompt's time would land in the first output token's.
        llama_synchronize(ctx)
        let t2 = clock.now

        var bytes: [UInt8] = []
        var out = 0
        var stop = Stop.maxTokens
        while out < r.maxTokens {
            guard let logits = llama_get_logits_ith(ctx, -1) else { throw LocalModelError.decodeFailed(-1) }
            let t = try picker.pick(logits)
            if model.isEndOfGeneration(t) {
                stop = .eog
                break
            }
            picker.accept(t)
            bytes += model.piece(t)
            out += 1
            try decode([t])
        }
        let t3 = clock.now
        let ms = { (d: Duration) in (Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15).rounded() }
        return Completion(
            id: r.id,
            text: String(decoding: bytes, as: UTF8.self),
            stop: stop,
            prefixTokens: prefixTokens,
            prefixCached: prefixCached,
            promptTokens: prompt.count,
            outputTokens: out,
            ms: Timing(prefix: ms(t1 - t0), prompt: ms(t2 - t1), decode: ms(t3 - t2), total: ms(t3 - t0)),
            memory: MemoryUse.now()
        )
    }

    /// Decodes tokens after what the sequence holds, in batches; positions follow on automatically.
    private func decode(_ tokens: [llama_token]) throws {
        var toks = tokens
        var i = 0
        while i < toks.count {
            let n = min(nBatch, toks.count - i)
            let rc = toks.withUnsafeMutableBufferPointer { b in
                llama_decode(ctx, llama_batch_get_one(b.baseAddress! + i, Int32(n)))
            }
            guard rc == 0 else { throw LocalModelError.decodeFailed(rc) }
            i += n
        }
    }
}
