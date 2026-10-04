import AppCompatibility
import AutocompleteCore
import CaretHostCore
import Foundation

/// `Caret --probe [--bos on|off] <text>...`: loads the engine and prints what it would offer for
/// each text, for diagnosing suggestion quality without a GUI. A `|` in a text marks the caret;
/// without one the caret is at the end.
public enum DevProbe {
    @MainActor
    public static func run(modelURL: URL, texts: [String], prependBOS: Bool?) async -> String {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL, prependBOS: prependBOS)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        var lines: [String] = []
        for text in texts {
            let parts = text.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
            let before = parts[0]
            let after = parts.count > 1 ? parts[1] : ""
            let context = TextFieldContext(
                beforeCursor: before,
                afterCursor: after,
                geometry: TextFieldGeometry(isAtEndOfLine: after.prefix { !$0.isNewline }.allSatisfy(\.isWhitespace)),
                target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"),
                detectedLanguage: "en"
            )
            let outcome = (try? await engine.suggest(for: context)) ?? .suppressed("cancelled")
            let ms = engine.lastGenerationMs.map { String(format: "%.1f", $0) } ?? "-"
            switch outcome {
            case .suggestion(let s): lines.append("\(text)⟦\(s.text)⟧  (\(ms) ms)")
            case .suppressed(let reason): lines.append("\(text)⟦SUPPRESS \(reason)⟧  (\(ms) ms)")
            }
        }
        await engine.shutdown()
        return lines.joined(separator: "\n") + "\n"
    }

    /// `Caret --probe-typing <text>`: generates once per prefix of `text`, in order, the way
    /// typing it character by character would (so KV reuse applies), and prints each generation
    /// time. This is model time only: no AX read, presentation gate or paint.
    @MainActor
    public static func typing(modelURL: URL, text: String) async -> String {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        var times: [Double] = []
        var shown = 0
        var prefix = ""
        for character in text {
            prefix.append(character)
            let context = TextFieldContext(
                beforeCursor: prefix,
                geometry: TextFieldGeometry(isAtEndOfLine: true),
                target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"),
                detectedLanguage: "en"
            )
            let started = DispatchTime.now().uptimeNanoseconds
            if case .suggestion = (try? await engine.suggest(for: context)) ?? .suppressed("") { shown += 1 }
            times.append(Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
        }
        await engine.shutdown()
        let sorted = times.sorted()
        func pct(_ p: Double) -> String {
            String(format: "%.1f", LatencyRecorder.percentile(sorted, p) ?? .nan)
        }
        return "keystrokes=\(times.count) shown=\(shown) p50=\(pct(0.5))ms p95=\(pct(0.95))ms max=\(pct(1.0))ms\n"
            + "samples_ms=" + times.map { String(format: "%.1f", $0) }.joined(separator: ",") + "\n"
    }
}
