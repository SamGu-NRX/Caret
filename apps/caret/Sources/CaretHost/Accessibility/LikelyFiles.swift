import CaretHostCore
import Foundation

/// Finds the file a plan's attach step most likely means among the user's own recent files (H5):
/// by name only, in the folders given and one level under them. Nothing is opened or read, and
/// nothing leaves this Mac; the helper reads the one file the user confirms, once.
enum LikelyFiles {
    /// Entries looked at per folder, so a Downloads folder of thousands costs a bounded scan on the
    /// main thread. Assumed, not measured: a few thousand directory entries list in milliseconds.
    static let maxEntries = 3000

    static func find(wants: String, roots: [String], fileManager: FileManager = .default) -> ProposedFile? {
        guard !LikelyFile.words(for: wants).isEmpty else { return nil }
        var found: [ProposedFile] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]
        for root in roots {
            guard let walk = fileManager.enumerator(
                at: URL(fileURLWithPath: root, isDirectory: true), includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]
            ) else { continue }
            var seen = 0
            for case let url as URL in walk {
                seen += 1
                if seen > maxEntries { break }
                if walk.level > 2 { walk.skipDescendants(); continue }
                guard LikelyFile.matches(name: url.lastPathComponent, wants: wants),
                      let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
                      let modified = values.contentModificationDate, let size = values.fileSize else { continue }
                found.append(ProposedFile(path: url.path, name: url.lastPathComponent, modified: modified, size: size))
            }
        }
        return LikelyFile.pick(found, wants: wants)
    }
}
