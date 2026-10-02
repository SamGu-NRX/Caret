import AppCompatibility
import AutocompleteCore
import Foundation

/// `Caret --probe [--bos on|off] <text>...`: loads the engine and prints what it would offer at
/// the end of each text, for diagnosing suggestion quality without a GUI.
public enum DevProbe {
    @MainActor
    public static func run(modelURL: URL, texts: [String], prependBOS: Bool?) async -> String {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        await engine.load(modelURL: modelURL, prependBOS: prependBOS)
        guard engine.state == .ready else { return "engine: \(engine.state)\n" }
        var lines: [String] = []
        for text in texts {
            let context = TextFieldContext(
                beforeCursor: text,
                geometry: TextFieldGeometry(isAtEndOfLine: true),
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
}
