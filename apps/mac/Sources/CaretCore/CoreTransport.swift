import Foundation

/// Why the core stopped producing lines.
public enum CoreTerminationReason: Equatable, Sendable {
    /// stdout reached EOF, or the process exited.
    case exited(status: Int32)
    /// We asked it to stop.
    case stoppedByClient
    /// The transport itself failed before or during the run.
    case failed(String)
}

/// The byte pipe under the protocol. Splitting this out is what lets the
/// request/event logic be tested without spawning Python.
public protocol CoreTransport: AnyObject {
    /// Begin delivering whole lines. Both callbacks may arrive on any thread.
    func start(onLine: @escaping (String) -> Void, onTermination: @escaping (CoreTerminationReason) -> Void) throws
    func send(line: String) throws
    func stop()
}

/// Reassembles newline-delimited text from arbitrary chunk boundaries.
///
/// A pipe splits wherever it likes: one read can carry half a line, three
/// lines, or a multi-byte character cut in two. Bytes are held until a newline
/// arrives, and decoding happens per complete line so a split UTF-8 sequence
/// never becomes a replacement character.
public struct LineAccumulator {
    private var buffer = Data()
    private let maxLineBytes: Int

    /// The core's own bound on a frame is 4,000 UTF-16 units, so a line far past
    /// that is a stuck stream rather than a large reply. We stop buffering
    /// instead of growing without limit.
    public init(maxLineBytes: Int = 8 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public var isOverflowing: Bool { buffer.count > maxLineBytes }

    /// Appends a chunk and returns every complete line it finished.
    public mutating func append(_ chunk: Data) -> [String] {
        buffer.append(chunk)
        var lines: [String] = []
        while let index = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let raw = buffer[buffer.startIndex..<index]
            buffer.removeSubrange(buffer.startIndex...index)
            guard !raw.isEmpty else { continue }
            if let line = String(data: Data(raw), encoding: .utf8) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { lines.append(trimmed) }
            }
        }
        if buffer.count > maxLineBytes { buffer.removeAll(keepingCapacity: false) }
        return lines
    }

    /// Whatever is left when the stream ends, if it is a usable line.
    public mutating func flush() -> String? {
        defer { buffer.removeAll(keepingCapacity: false) }
        guard !buffer.isEmpty, let line = String(data: buffer, encoding: .utf8) else { return nil }
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
