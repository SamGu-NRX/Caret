import Foundation

/// Where Caret's writing model comes from (brief item 8). Caret keeps its own copy in its support folder; until the user
/// downloads one it reads Cotypist's copy in place, so deleting Cotypist no longer deletes Caret's model once Caret has
/// its own. The download is always user-started (the menu or the Writing tab); nothing here fetches anything.
public enum ModelFiles {
    /// The public quant (mradermacher/gemma-4-E2B-i1-GGUF, Apache-2.0), pinned by repository commit and checked by its
    /// sha256 and size, which Hugging Face reported for that commit (X-Linked-ETag, X-Linked-Size, 2026-10-09).
    public static let fileName = "gemma-4-E2B.i1-Q4_K_M.gguf"
    public static let revision = "a9bf638e53783fc93778f357cc5c672eab5393b1"
    public static let sha256 = "3cc0e9c2b4bbffea7f3f6cfe1ffd1591f4dafe02c43f78952f1142a24172df65"
    public static let bytes: Int64 = 3_427_862_240
    public static let url = URL(string: "https://huggingface.co/mradermacher/gemma-4-E2B-i1-GGUF/resolve/\(revision)/\(fileName)")!
    /// Written next to the model.
    public static let licenseFileName = "\(fileName).LICENSE.txt"

    /// Caret's folder, beside the engine's token profiles (`EngineLoader.profileDirectory`).
    public static let caretFolder = "Library/Application Support/Caret/v2-host/Models"
    /// Cotypist's copy, read in place: its own name for the same model (a custom imatrix quant, not the public file).
    public static let cotypistFile = "Library/Application Support/app.cotypist.Cotypist/Models/gemma-4-E2B-i1-Q4_K_M.gguf"

    /// Free space the download leaves on the disk beyond what it still has to write. Chosen, not measured: enough that
    /// a Mac is not left with almost nothing free once 3.4 GB has gone in.
    public static let diskMargin: Int64 = 2 * 1024 * 1024 * 1024

    public enum Source: String, Codable, Sendable {
        /// `CARET_MODEL_PATH` or `--model`.
        case named
        /// Caret's own copy.
        case caret
        /// Cotypist's copy, read in place.
        case cotypist
    }

    public struct Found: Equatable, Sendable {
        public var url: URL
        public var source: Source
        public init(url: URL, source: Source) { self.url = url; self.source = source }
    }

    public static func caretFile(home: URL) -> URL { home.appendingPathComponent(caretFolder).appendingPathComponent(fileName) }

    /// The model to load: a named path when one is given (used whether or not it exists, so a mistyped path says so),
    /// else Caret's copy, else Cotypist's. Nil when neither copy is there.
    public static func find(home: URL, named: String?, exists: (URL) -> Bool) -> Found? {
        if let named, !named.isEmpty { return Found(url: URL(fileURLWithPath: named), source: .named) }
        let caret = caretFile(home: home)
        if exists(caret) { return Found(url: caret, source: .caret) }
        let cotypist = home.appendingPathComponent(cotypistFile)
        if exists(cotypist) { return Found(url: cotypist, source: .cotypist) }
        return nil
    }

    /// Why a download may not start now, or nil: free space must cover what is left to write plus `diskMargin`.
    /// Unknown free space refuses too, rather than guessing.
    public static func diskRefusal(freeBytes: Int64?, alreadyHave: Int64, total: Int64 = bytes) -> String? {
        guard let freeBytes else { return "Caret can't tell how much space is free on this Mac." }
        let need = max(0, total - alreadyHave) + diskMargin
        guard freeBytes < need else { return nil }
        return "The model needs \(gigabytes(need)) free, and this Mac has \(gigabytes(freeBytes))."
    }

    static func gigabytes(_ n: Int64) -> String {
        String(format: "%.1f GB", Double(n) / 1_000_000_000)
    }
}

/// What a model download is doing, for the menu and the Writing tab.
public enum ModelDownloadState: Equatable, Sendable {
    case idle
    case downloading(received: Int64, total: Int64)
    case verifying
    /// The verified copy is in place; it is loaded the next time Caret starts.
    case ready
    case failed(String)

    public var isRunning: Bool {
        switch self {
        case .downloading, .verifying: return true
        default: return false
        }
    }
}

/// The words for the model, in the menu and the Writing tab.
public enum ModelCopy {
    public static let head = "Model"

    /// The line naming the file in use.
    public static func inUse(_ found: ModelFiles.Found?) -> String {
        guard let found else { return "No model yet. Download Caret's copy to get suggestions." }
        switch found.source {
        case .caret: return "Using Caret's copy of Gemma 4 E2B."
        case .cotypist: return "Using Cotypist's copy of Gemma 4 E2B, read in place."
        case .named: return "Using \(found.url.lastPathComponent), named at launch."
        }
    }

    /// The menu item (`menu`, title case) or the Writing tab's button (sentence case). Nil when there is nothing to offer:
    /// Caret's copy is in use, a path was named, or a finished download waits for the next launch.
    public static func action(_ found: ModelFiles.Found?, _ state: ModelDownloadState, menu: Bool) -> String? {
        switch state {
        case .downloading(let received, let total):
            let pct = total > 0 ? Int((Double(received) / Double(total) * 100).rounded(.down)) : 0
            return menu ? "Stop Downloading the Model (\(pct)%)" : "Stop downloading (\(pct)%)"
        case .verifying: return menu ? "Checking the Model…" : "Checking…"
        case .ready: return nil
        case .idle, .failed:
            if found?.source == .caret || found?.source == .named { return nil }
            return menu ? "Download Caret's Model (3.4 GB)…" : "Download Caret's model (3.4 GB)"
        }
    }

    /// A line under the action, when there is something to say.
    public static func status(_ state: ModelDownloadState) -> String? {
        switch state {
        case .idle: return nil
        case .downloading(let received, let total):
            return "\(ModelFiles.gigabytes(received)) of \(ModelFiles.gigabytes(total)). Stopping keeps what came in; downloading again continues from there."
        case .verifying: return "Checking the file against its published fingerprint."
        case .ready: return "Caret's copy is ready. Caret uses it the next time it starts."
        case .failed(let why): return why
        }
    }
}
