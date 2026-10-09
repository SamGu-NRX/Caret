import AppCompatibility
import AutocompleteCore
import CaretHostCore
import ConstrainedGeneration
import Foundation
import ModelRuntime
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
    /// Candidates looked at, best first, when the better ones are refused at the seam or do not
    /// fit the text after the caret. KeyType's own filter still decides about the first.
    static let candidatesTried = 3

    /// What became of one candidate, for `Caret --probe` and the debug state.
    struct Note: Equatable {
        let text: String
        var refusal: String?
        /// The refusal is KeyType's filter's.
        var byKeyType = false
        /// `SuffixFit` scores: the text after the caret as it is, and after this candidate, per
        /// scored token (log probabilities, nats).
        var baseline: [Double]?
        var joined: [Double]?
    }

    private(set) var state: State = .loading
    private(set) var lastGenerationMs: Double?
    /// The candidates of the last `suggest`, in order, and how long the fit check took.
    private(set) var lastNotes: [Note] = []
    private(set) var lastFitMs: Double?
    private var engine: ConstrainedGenerationEngine?
    private var scorer: SuffixScorer?
    /// `Caret --probe-replay`: every candidate is scored, refused or not, for calibration. The
    /// outcome is decided as in a normal run.
    var diagnostic = false
    /// Test hook (`--ghost-replay`): outcomes recorded with the model on another Mac, by context,
    /// for a VM run that has no model. Never set in a normal run.
    var replay: GhostReplay?
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
            scorer = SuffixScorer(runtime: loaded.runtime)
            state = .ready
            await warmUp(loaded.engine)
        case .failure(let error):
            state = .unavailable(String(describing: error))
        }
    }

    /// Ghost text from recorded outcomes (`--ghost-replay`): ready at once, the model never loaded.
    func useReplay(_ replay: GhostReplay) {
        self.replay = replay
        state = .ready
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
        if let replay {
            switch replay.outcome(before: context.beforeCursor, after: context.afterCursor) {
            case .text(let text)?: return .suggestion(GhostSuggestion(text: text, context: context, generationMs: 0))
            case .silent(let reason)?: return .suppressed(reason)
            case nil: return .suppressed("replayMissing")
            }
        }
        lastNotes = []
        lastFitMs = nil
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

        guard !candidates.isEmpty else { return .suppressed("noCandidate") }
        // A18, bugs 6 and 7: a completion must not repeat the words after the caret, end a sentence
        // that goes on, or copy a phrase from the line above; and between words it must fit before
        // the ones after it (`SuffixFit`). KeyType's own filter still decides about the best
        // candidate as before; after that the first candidate that passes is offered, or nothing.
        var notes: [Note] = []
        for (index, candidate) in candidates.prefix(Self.candidatesTried).enumerated() {
            let text = Self.anchorText(for: candidate, request: request)
            if let reason = filter.suppressionReason(for: candidate, request: request) {
                notes.append(Note(text: text ?? candidate.text, refusal: String(describing: reason), byKeyType: true))
                if index == 0, !diagnostic { break }
                continue
            }
            guard let text else {
                notes.append(Note(text: candidate.text, refusal: "emptyAfterBoundary"))
                continue
            }
            let refusal = GhostSeam.refusal(completion: text, before: context.beforeCursor, after: context.afterCursor)
            notes.append(Note(text: text, refusal: refusal?.rawValue))
        }
        let keyTypeRefusedBest = notes.first?.byKeyType == true
        let open = keyTypeRefusedBest ? [] : notes.indices.filter { notes[$0].refusal == nil }
        let midLine = GhostSeam.isMidLine(after: context.afterCursor)
        // Scored: the open candidates between words, and in `diagnostic` every one with text.
        let scored = diagnostic ? notes.indices.filter { notes[$0].refusal != "emptyAfterBoundary" } : (midLine ? open : [])
        var wasScored = false
        if midLine, !scored.isEmpty {
            let fitStarted = DispatchTime.now().uptimeNanoseconds
            let tokens = try await scorer?.tokenScores(
                prompt: request.prompt, beforeCursor: context.beforeCursor, afterCursor: context.afterCursor,
                inserts: [""] + scored.map { notes[$0].text }
            )
            try Task.checkCancellation()
            lastFitMs = Double(DispatchTime.now().uptimeNanoseconds - fitStarted) / 1_000_000
            if let tokens, tokens.count == scored.count + 1 {
                wasScored = true
                for (slot, index) in scored.enumerated() {
                    notes[index].baseline = tokens[0]
                    notes[index].joined = tokens[slot + 1]
                    if notes[index].refusal == nil, !SuffixFit.fits(withCompletion: tokens[slot + 1]) {
                        notes[index].refusal = "doesNotFit"
                    }
                }
            }
        }
        lastNotes = notes
        if keyTypeRefusedBest { return .suppressed(notes[0].refusal ?? "noCandidate") }
        guard !open.isEmpty else { return .suppressed(notes.first?.refusal ?? "noCandidate") }
        // Between words, a completion nobody could check against the words after it is not offered.
        if midLine, !wasScored { return .suppressed("fitUnscored") }
        guard let chosen = open.first(where: { notes[$0].refusal == nil }) else { return .suppressed("doesNotFit") }
        return .suggestion(GhostSuggestion(text: notes[chosen].text, context: context, generationMs: elapsed))
    }

    /// The request `suggest` sends for `context`, under the app's policy.
    func request(for context: TextFieldContext) -> CompletionRequest {
        makeRequest(for: context, policy: compatibilityStore.policy(for: context))
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

    nonisolated static func sentenceContinues(after afterCursor: String) -> Bool {
        GhostSeam.continuesSentence(after: afterCursor)
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
