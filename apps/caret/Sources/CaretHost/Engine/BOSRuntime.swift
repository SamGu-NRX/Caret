import AutocompleteCore
import ModelRuntime

/// Forwards to a runtime and starts every decoded sequence with the model's BOS token.
///
/// KeyType tokenizes with `add_special = false`, which suits its default Qwen models (no BOS).
/// Gemma is trained with `<bos>` first. Without it the Cotypist Gemma file repeats or derails:
/// in `Caret --probe --bos off`, "…let me know if " gave "you please let me" and "See you tomor"
/// gave "row <h2>See"; with BOS they gave "you have any questions" and "row."
/// (~/.caret-run/evidence/host/bos-probe.txt, 2026-10-02). Wrapping the runtime adds the token
/// without editing KeyType: the engine passes the whole prompt as the anchor, so prefixing the
/// anchor keeps every anchor a pure append of the last and KV reuse (ADR-018/081) still applies.
final class BOSRuntime: LocalModelRuntime {
    private let base: LocalModelRuntime
    private let bos: TokenID

    init(base: LocalModelRuntime, bos: TokenID) {
        self.base = base
        self.bos = bos
    }

    var metadata: ModelMetadata { base.metadata }
    var tokenizer: ModelTokenizing { base.tokenizer }

    private func prefixed(_ tokens: [TokenID]) -> [TokenID] {
        tokens.first == bos ? tokens : [bos] + tokens
    }

    func prepare(promptTokens: [TokenID]) async throws {
        try await base.prepare(promptTokens: prefixed(promptTokens))
    }

    func logitsForNextToken() async throws -> [TokenLogit] {
        try await base.logitsForNextToken()
    }

    func decodeNext(tokenID: TokenID) async throws {
        try await base.decodeNext(tokenID: tokenID)
    }

    func resetKVCache() async {
        await base.resetKVCache()
    }

    func shutdown() async {
        await base.shutdown()
    }

    func anchoredLogits(anchor: [TokenID], suffix: [TokenID]) async throws -> [TokenLogit] {
        try await base.anchoredLogits(anchor: prefixed(anchor), suffix: suffix)
    }

    func anchoredLogitsBatch(anchor: [TokenID], suffixes: [[TokenID]]) async throws -> [[TokenLogit]] {
        try await base.anchoredLogitsBatch(anchor: prefixed(anchor), suffixes: suffixes)
    }
}
