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
            lines.append(contentsOf: notes(engine))
        }
        await engine.shutdown()
        return lines.joined(separator: "\n") + "\n"
    }

    /// Each candidate the engine looked at, with its refusal and fit scores.
    @MainActor
    static func notes(_ engine: GhostTextEngine) -> [String] {
        let fit = engine.lastFitMs.map { String(format: " fit %.1f ms", $0) } ?? ""
        return engine.lastNotes.enumerated().map { i, n in
            func list(_ xs: [Double]?) -> String { (xs ?? []).map { String(format: "%.2f", $0) }.joined(separator: ",") }
            let scores = n.baseline.map { b in " baseline [\(list(b))] joined [\(list(n.joined))]" } ?? ""
            return "    #\(i + 1) \u{201C}\(n.text)\u{201D} \(n.refusal ?? "ok")\(scores)\(i == 0 ? fit : "")"
        }
    }

    /// `Caret --probe-replay <cases.json> <out.json>`: runs the engine on each `{"before","after"}`
    /// case, prints what it did with every candidate, and writes the outcomes as a `GhostReplay`
    /// file for a run with no model (`--ghost-replay`).
    @MainActor
    public static func replay(modelURL: URL, cases: URL, out: URL) async -> String {
        struct Case: Decodable { let before: String; let after: String }
        guard let data = try? Data(contentsOf: cases), let list = try? JSONDecoder().decode([Case].self, from: data) else {
            return "cannot read \(cases.path)\n"
        }
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        engine.diagnostic = true
        var lines: [String] = []
        var entries: [GhostReplay.Entry] = []
        for c in list {
            let context = TextFieldContext(
                beforeCursor: c.before, afterCursor: c.after,
                geometry: TextFieldGeometry(isAtEndOfLine: !GhostSeam.isMidLine(after: c.after)),
                target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"),
                detectedLanguage: "en"
            )
            let outcome = (try? await engine.suggest(for: context)) ?? .suppressed("cancelled")
            let ms = engine.lastGenerationMs.map { String(format: "%.1f", $0) } ?? "-"
            switch outcome {
            case .suggestion(let s):
                entries.append(.init(before: c.before, after: c.after, text: s.text))
                lines.append("\(c.before)|\(c.after)  ⟦\(s.text)⟧  (\(ms) ms)")
            case .suppressed(let reason):
                entries.append(.init(before: c.before, after: c.after, text: nil, reason: reason))
                lines.append("\(c.before)|\(c.after)  ⟦SILENT \(reason)⟧  (\(ms) ms)")
            }
            lines.append(contentsOf: notes(engine))
        }
        await engine.shutdown()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try encoder.encode(GhostReplay(entries: entries)).write(to: out)
        } catch {
            return lines.joined(separator: "\n") + "\nFAILED to write \(out.path): \(error)\n"
        }
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
