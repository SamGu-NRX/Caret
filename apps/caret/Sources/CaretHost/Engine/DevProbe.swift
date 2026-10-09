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

    /// One way of producing a suggestion, for `length`.
    enum LengthMode: Equatable, CustomStringConvertible {
        /// One request with this token cap: nothing shows until it finishes.
        case single(Int)
        /// A short request shown at once, then a second request from the end of the shown text that
        /// extends it. The first visible word is the first request's.
        case extend(first: Int, then: Int)
        /// One request with this cap, candidates ordered by mean log probability per token (`normalizesLength`).
        case normalized(Int)

        var description: String {
            switch self {
            case .single(let n): return "single-\(n)"
            case .extend(let a, let b): return "extend-\(a)+\(b)"
            case .normalized(let n): return "norm-\(n)"
            }
        }
    }

    /// `Caret --probe-length <cases.txt> <out.ndjson> [--caps 4,8,...] [--extend N]`: types each line
    /// of `cases.txt` key by key under each mode (so KV reuse applies as in typing), and times every
    /// keystroke's suggestion: wall time to the first visible word and to the full suggestion. Writes
    /// one JSON row per keystroke and mode, and prints p50/p95 by suggestion length in words.
    /// Model time only: no AX read, presentation gate or paint, and no keystroke cancels a request.
    @MainActor
    public static func length(modelURL: URL, cases: URL, out: URL, caps: [Int], extend: Int, normalized: [Int] = []) async -> String {
        guard let corpus = try? String(contentsOf: cases, encoding: .utf8) else { return "cannot read \(cases.path)\n" }
        let lines = corpus.split(whereSeparator: \.isNewline).map(String.init).filter { !$0.isEmpty }
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        // The width cap must not be what stops a long suggestion; the token cap under test does.
        engine.displayWidth = 400
        let modes = caps.map(LengthMode.single) + (extend > 0 ? [.extend(first: GhostTextEngine.maxCompletionTokens, then: extend)] : [])
            + normalized.map(LengthMode.normalized)
        var rows: [LengthRow] = []
        for mode in modes {
            for (index, line) in lines.enumerated() {
                var prefix = ""
                for character in line {
                    prefix.append(character)
                    rows.append(await lengthRow(engine: engine, mode: mode, line: index, before: prefix))
                }
            }
        }
        await engine.shutdown()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = rows.compactMap { try? encoder.encode($0) }.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n") + "\n"
        do { try Data(data.utf8).write(to: out) } catch { return "FAILED to write \(out.path): \(error)\n" }
        return LengthRow.summary(rows, modes: modes.map(\.description))
    }

    struct LengthRow: Codable {
        var mode: String
        var line: Int
        var chars: Int
        var text: String?
        var reason: String?
        var firstMs: Double
        var fullMs: Double
        var words: Int
        var sentenceEnd: Bool

        /// Length buckets in words, as a person reads the suggestion.
        static let buckets: [(String, ClosedRange<Int>)] = [("1", 1...1), ("2", 2...2), ("3-4", 3...4), ("5-7", 5...7), ("8-11", 8...11), ("12+", 12...999)]

        static func summary(_ rows: [LengthRow], modes: [String]) -> String {
            func pct(_ xs: [Double], _ p: Double) -> String {
                LatencyRecorder.percentile(xs.sorted(), p).map { String(format: "%.0f", $0) } ?? "-"
            }
            var out = "mode | words | n | first p50 | first p95 | full p50 | full p95\n"
            for mode in modes {
                let all = rows.filter { $0.mode == mode }
                let shown = all.filter { $0.text != nil }
                let ends = shown.filter(\.sentenceEnd).count
                let meanWords = shown.isEmpty ? 0 : Double(shown.map(\.words).reduce(0, +)) / Double(shown.count)
                out += "\(mode) | all | \(shown.count)/\(all.count) | \(pct(shown.map(\.firstMs), 0.5)) | \(pct(shown.map(\.firstMs), 0.95)) | \(pct(shown.map(\.fullMs), 0.5)) | \(pct(shown.map(\.fullMs), 0.95))"
                out += String(format: "  (mean %.1f words, %d end a sentence; every keystroke p95 %@)\n", meanWords, ends, pct(all.map(\.fullMs), 0.95))
                for (name, range) in buckets {
                    let b = shown.filter { range.contains($0.words) }
                    guard !b.isEmpty else { continue }
                    out += "\(mode) | \(name) | \(b.count) | \(pct(b.map(\.firstMs), 0.5)) | \(pct(b.map(\.firstMs), 0.95)) | \(pct(b.map(\.fullMs), 0.5)) | \(pct(b.map(\.fullMs), 0.95))\n"
                }
            }
            return out
        }
    }

    @MainActor
    private static func lengthRow(engine: GhostTextEngine, mode: LengthMode, line: Int, before: String) async -> LengthRow {
        func context(_ text: String) -> TextFieldContext {
            TextFieldContext(
                beforeCursor: text,
                geometry: TextFieldGeometry(isAtEndOfLine: true),
                target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"),
                detectedLanguage: "en"
            )
        }
        func timed(_ tokens: Int, _ text: String, normalize: Bool = false) async -> (GhostTextEngine.Outcome, Double) {
            engine.completionTokens = tokens
            engine.normalizesLength = normalize
            defer { engine.normalizesLength = false }
            let started = DispatchTime.now().uptimeNanoseconds
            let outcome = (try? await engine.suggest(for: context(text))) ?? .suppressed("cancelled")
            return (outcome, Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
        }
        func row(_ text: String?, reason: String?, first: Double, full: Double) -> LengthRow {
            let words = text.map { $0.split(whereSeparator: \.isWhitespace).count } ?? 0
            let ends = text.map { t in t.trimmingCharacters(in: .whitespaces).last.map { ".!?".contains($0) } ?? false } ?? false
            return LengthRow(mode: mode.description, line: line, chars: before.count, text: text, reason: reason,
                             firstMs: first, fullMs: full, words: words, sentenceEnd: ends)
        }
        switch mode {
        case .single(let cap), .normalized(let cap):
            let (outcome, ms) = await timed(cap, before, normalize: mode == .normalized(cap))
            switch outcome {
            case .suggestion(let s): return row(s.text, reason: nil, first: ms, full: ms)
            case .suppressed(let why): return row(nil, reason: why, first: ms, full: ms)
            }
        case .extend(let firstCap, let thenCap):
            let (outcome, firstMs) = await timed(firstCap, before)
            guard case .suggestion(let head) = outcome else {
                if case .suppressed(let why) = outcome { return row(nil, reason: why, first: firstMs, full: firstMs) }
                return row(nil, reason: "none", first: firstMs, full: firstMs)
            }
            if let last = head.text.last, ".!?".contains(last) { return row(head.text, reason: nil, first: firstMs, full: firstMs) }
            let (more, thenMs) = await timed(thenCap, before + head.text)
            guard case .suggestion(let tail) = more else { return row(head.text, reason: nil, first: firstMs, full: firstMs + thenMs) }
            return row(head.text + tail.text, reason: nil, first: firstMs, full: firstMs + thenMs)
        }
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

    /// `Caret --probe-rewrite <sentences.txt> <out.ndjson>`: each sentence's rewrites in each mode
    /// (`RewriteGenerator`), timed, with what `RewriteFilter` would offer. One untimed warm-up first.
    @MainActor
    public static func rewrite(modelURL: URL, sentences: URL, out: URL) async -> String {
        guard let corpus = try? String(contentsOf: sentences, encoding: .utf8) else { return "cannot read \(sentences.path)\n" }
        let lines = corpus.split(whereSeparator: \.isNewline).map(String.init).filter { !$0.isEmpty }
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        let modes: [(String, RewriteGenerator.Mode)] = [("list", .list), ("sampled", .sampled(count: 3, temperature: 0.8, seed: 7))]
        _ = try? await engine.rewrites(of: "Thanks for the quick reply.", mode: .list)
        var rows: [String] = []
        var summary: [String] = []
        for (name, mode) in modes {
            var first: [Double] = [], total: [Double] = []
            for line in lines {
                guard let o = try? await engine.rewrites(of: line, mode: mode) else { continue }
                first.append(o.firstMs)
                total.append(o.totalMs)
                let row: [String: Any] = ["mode": name, "sentence": line, "rewrites": o.rewrites,
                                          "offered": RewriteFilter.offered(o.rewrites, original: line),
                                          "firstMs": o.firstMs, "totalMs": o.totalMs, "tokens": o.tokens]
                if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) { rows.append(String(decoding: data, as: UTF8.self)) }
            }
            func p(_ xs: [Double], _ q: Double) -> String { String(format: "%.0f", LatencyRecorder.percentile(xs.sorted(), q) ?? -1) }
            summary.append("\(name): first rewrite p50 \(p(first, 0.5)) / p95 \(p(first, 0.95)) ms; all p50 \(p(total, 0.5)) / p95 \(p(total, 0.95)) ms; n \(total.count)")
        }
        try? (rows.joined(separator: "\n") + "\n").write(to: out, atomically: true, encoding: .utf8)
        await engine.shutdown()
        return summary.joined(separator: "\n") + "\n"
    }
}
