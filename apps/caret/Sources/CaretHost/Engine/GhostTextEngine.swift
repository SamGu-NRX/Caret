import AppCompatibility
import AutocompleteCore
import ConstrainedGeneration
import Foundation
import Prompting

/// One shown-able suggestion: the text KeyType would anchor at `context`'s caret.
struct GhostSuggestion: Equatable {
    /// Caret-reconciled completion for `context` (KeyType's "anchor text").
    let text: String
    /// The context it was generated for. `SuggestionAnchor.remaining` re-derives what is still
    /// ahead of a later caret from these two.
    let context: TextFieldContext
    let generationMs: Double
}

/// Adapter over KeyType's capture-to-candidate pipeline: policy gates, token healing, the sectioned
/// prompt, constrained generation, the output filter and caret reconciliation.
///
/// The request-shaping rules are KeyType's `CompletionController` rules, kept in the same order:
/// empty-prefix gate, numeric-stem gate (ADR-085), healing (ADR-019/083), mid-line token cap
/// (ADR-116), four-token default (ADR-117), 60-character width.
@MainActor
final class GhostTextEngine {
    enum State: Equatable {
        case loading
        case ready
        case unavailable(String)
    }

    enum Outcome: Equatable {
        case suggestion(GhostSuggestion)
        /// Nothing to show, with KeyType's reason (a `SuppressionReason` name or a gate name).
        case suppressed(String)
    }

    static let maxCompletionTokens = 4
    static let maxDisplayWidth = 60

    private(set) var state: State = .loading
    private(set) var lastGenerationMs: Double?
    private var engine: ConstrainedGenerationEngine?
    private let compatibilityStore: AppCompatibilityStore
    private let filter: DefaultCandidateFilter
    private let promptBuilder = PromptBuilder()

    init(compatibilityStore: AppCompatibilityStore) {
        self.compatibilityStore = compatibilityStore
        self.filter = DefaultCandidateFilter(compatibilityStore: compatibilityStore, wordRecognizer: SystemWordRecognizer())
    }

    func load(modelURL: URL, prependBOS: Bool? = nil) async {
        state = .loading
        let store = compatibilityStore
        let result = await Task.detached(priority: .userInitiated) {
            Result { try EngineLoader.load(modelURL: modelURL, compatibilityStore: store, prependBOS: prependBOS) }
        }.value
        switch result {
        case .success(let loaded):
            engine = loaded.engine
            state = .ready
            await warmUp(loaded.engine)
        case .failure(let error):
            state = .unavailable(String(describing: error))
        }
    }

    /// Ghost text turned off for this run (`--no-ghost`): the model is never loaded.
    func disable() {
        state = .unavailable("disabled")
    }

    func shutdown() async {
        let engine = self.engine
        self.engine = nil
        state = .unavailable("shut down")
        await engine?.shutdown()
    }

    /// Generates for `context`. Throws `CancellationError` when superseded.
    func suggest(for context: TextFieldContext) async throws -> Outcome {
        guard let engine else { return .suppressed("engineNotReady") }
        let policy = compatibilityStore.policy(for: context)
        guard policy.isCompletionEnabled else { return .suppressed("completionsDisabled") }
        guard policy.allowsMidLineCompletion || context.afterCursor.isEmpty else { return .suppressed("midLineDisabled") }
        guard policy.allowsTabAcceptance else { return .suppressed("tabShortcutsDisabled") }
        guard !context.beforeCursor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .suppressed("emptyPrompt")
        }
        guard !MidWordHealing.shouldSuppressNumericMidWordStem(for: context) else {
            return .suppressed("numericMidWordStem")
        }

        let request = makeRequest(for: context, policy: policy)
        let started = DispatchTime.now().uptimeNanoseconds
        let candidates = try await engine.completions(for: request)
        try Task.checkCancellation()
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        lastGenerationMs = elapsed

        guard let best = candidates.first else { return .suppressed("noCandidate") }
        if let reason = filter.suppressionReason(for: best, request: request) {
            return .suppressed(String(describing: reason))
        }
        guard let text = Self.anchorText(for: best, request: request) else { return .suppressed("emptyAfterBoundary") }
        return .suggestion(GhostSuggestion(text: text, context: context, generationMs: elapsed))
    }

    private func makeRequest(for context: TextFieldContext, policy: CompletionPolicy) -> CompletionRequest {
        // Token healing: prompt from the last clean token boundary and force the typed stem back
        // out, so the model can reach the whole-word token (ADR-019).
        let heal = MidWordHealing.plan(for: context)
        let promptContext = heal.map { context.replacingBeforeCursor($0.head) } ?? context
        let prompt = promptBuilder.buildPrompt(
            context: promptContext,
            customInstructions: policy.customInstructions,
            includeEnvironmentContext: policy.includesEnvironmentContext
        ).prompt
        let healSlack = heal?.heal.count ?? 0
        let healTokens = healSlack > 0 ? 1 : 0
        let tokens = Self.shouldUseCapsule(for: context)
            ? min(Self.maxCompletionTokens, 3) + healTokens
            : Self.maxCompletionTokens + healTokens
        return CompletionRequest(
            context: context,
            prompt: prompt,
            requiredPrefixBytes: heal.map { Array($0.heal.utf8) } ?? [],
            mode: policy.completionMode,
            maxCompletionTokens: tokens,
            maxDisplayWidth: Self.maxDisplayWidth + healSlack
        )
    }

    /// Strips the re-emitted healed stem, re-aligns leading whitespace to the caret
    /// (`CaretBoundary`, ADR-017), and drops trailing whitespace at end of line (ADR-024).
    nonisolated static func anchorText(for candidate: CompletionCandidate, request: CompletionRequest) -> String? {
        let completion = request.requiredPrefixBytes.isEmpty
            ? candidate.text
            : MidWordHealing.strip(candidate.text, heal: String(decoding: request.requiredPrefixBytes, as: UTF8.self))
        var anchored = CaretBoundary.reconcile(completion, beforeCursor: request.context.beforeCursor)
        if request.context.afterCursor.isEmpty {
            while let last = anchored.last, last.isWhitespace { anchored.removeLast() }
        } else if sentenceContinues(after: request.context.afterCursor) {
            // Without FIM tokens (the Gemma file has none) KeyType falls back to plain
            // continuation, which ends the sentence: "call for next| to go over it." gave
            // " week." in `Caret --probe`. Text after the caret continues the sentence, so a
            // closing terminator would be wrong there.
            while let last = anchored.last, ".!?".contains(last) { anchored.removeLast() }
        }
        return anchored.isEmpty ? nil : anchored
    }

    /// True when the text after the caret, on the same line, starts with a lowercase word or a
    /// number: the sentence goes on past the insertion point. A capital may start a new sentence,
    /// so it does not count.
    nonisolated static func sentenceContinues(after afterCursor: String) -> Bool {
        let line = afterCursor.prefix { !$0.isNewline }
        guard let first = line.first(where: { !$0.isWhitespace }) else { return false }
        return first.isLowercase || first.isNumber
    }

    /// True when visible text follows the caret on the same line, where inline ghost text would
    /// overlap it (ADR-048). Same rule as KeyType's `CompletionController.shouldUseCapsule`.
    nonisolated static func shouldUseCapsule(for context: TextFieldContext) -> Bool {
        guard !context.geometry.isAtEndOfLine else { return false }
        return context.afterCursor.prefix { !$0.isNewline }.contains { !$0.isWhitespace }
    }

    /// Decodes a one-token request so the first real keystroke does not pay Metal pipeline setup.
    private func warmUp(_ engine: ConstrainedGenerationEngine) async {
        let context = TextFieldContext(
            beforeCursor: "The",
            target: AppTarget(bundleIdentifier: "dev.caret.host", appName: "Caret"),
            detectedLanguage: "en"
        )
        let request = CompletionRequest(
            context: context,
            prompt: promptBuilder.buildPrompt(context: context).prompt,
            mode: .prose,
            maxCompletionTokens: 1,
            maxDisplayWidth: 8
        )
        try? await engine.warmUp(for: request)
    }
}
