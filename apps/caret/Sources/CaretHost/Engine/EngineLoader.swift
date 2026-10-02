import AppCompatibility
import ConstrainedGeneration
import Foundation
import LlamaModelRuntime
import ModelManagement
import ModelRuntime
import ProfileBuilderCore
import TokenProfiles

/// Builds KeyType's constrained-generation engine over a GGUF read in place.
///
/// KeyType's own loader (`CompletionController.buildEngine`) resolves the model and profile inside
/// `~/Library/Application Support/KeyType`. The host reads the model by path instead, so the
/// Cotypist file is used without copying 3.4 GB, and keeps its ACPF profile in its own directory.
public enum EngineLoader {
    enum LoadError: Error, CustomStringConvertible {
        case modelMissing(String)

        var description: String {
            switch self {
            case .modelMissing(let path): return "No GGUF at \(path)"
            }
        }
    }

    struct Loaded {
        let engine: ConstrainedGenerationEngine
        let family: String
        let profileBuiltNow: Bool
    }

    /// The dev model: Cotypist's Gemma 4 E2B base quant, read by path and never copied.
    public static var defaultModelURL: URL {
        if let override = ProcessInfo.processInfo.environment["CARET_MODEL_PATH"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/app.cotypist.Cotypist/Models/gemma-4-E2B-i1-Q4_K_M.gguf")
    }

    static var profileDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Caret/v2-host/Profiles", isDirectory: true)
    }

    /// Heavy: maps the model, creates the llama context and, the first time, classifies the whole
    /// vocabulary into an ACPF profile. Call off the main actor.
    static func load(modelURL: URL, compatibilityStore: AppCompatibilityStore) throws -> Loaded {
        guard ModelContainer.modelExists(at: modelURL) else {
            throw LoadError.modelMissing(modelURL.path)
        }
        // Same runtime defaults KeyType ships: KV snapshot reuse across keystrokes (ADR-018/081),
        // batched and incremental beam decoding (ADR-043/046).
        let runtime = try LlamaModelRuntime(modelURL: modelURL)
        let vocabSize = runtime.metadata.vocabularySize
        let family = ModelFamilyResolver.family(forFilename: modelURL.lastPathComponent, vocabSize: vocabSize)
        let profileURL = profileDirectory.appendingPathComponent(ModelContainer.profileFilename(family: family))

        let open = {
            try MmapAutocompleteProfile.open(
                at: profileURL,
                tokenizerVocabSize: vocabSize,
                tokenizerBytes: { try runtime.tokenizer.rawBytes(for: $0) },
                expectedModelFamily: family
            )
        }
        var builtNow = false
        let profile: MmapAutocompleteProfile
        if let existing = try? open() {
            profile = existing
        } else {
            try buildProfile(runtime: runtime, family: family, at: profileURL)
            builtNow = true
            profile = try open()
        }

        let engine = ConstrainedGenerationEngine(
            runtime: runtime,
            profile: profile,
            compatibilityStore: compatibilityStore,
            // KeyType's shipped configuration: decoder defaults plus native FIM for mid-line
            // requests when the model has FIM tokens (ADR-017/090). No telemetry nudges yet.
            configuration: DecodingConfiguration(enableFillInMiddle: true),
            wordRecognizer: SystemWordRecognizer()
        )
        return Loaded(engine: engine, family: family, profileBuiltNow: builtNow)
    }

    /// Writes the profile through a temporary sibling so a failed self-check never leaves a usable
    /// file behind (ADR-052, same as KeyType's `ProfileGenerator`).
    private static func buildProfile(runtime: LlamaModelRuntime, family: String, at url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temp = directory.appendingPathComponent(".\(url.lastPathComponent).building-\(UUID().uuidString)")
        do {
            try BuildProfile.run(
                introspector: runtime.makeIntrospector(),
                family: family,
                output: temp,
                reporter: ConsoleReporter(isQuiet: true)
            )
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
        }
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: temp, to: url)
    }
}
