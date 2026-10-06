import Foundation

/// Chrome's Native Messaging framing: each message is a 32-bit length in native byte order (little-endian on every
/// Mac Caret runs on), then that many bytes of UTF-8 JSON.
public enum NativeFrame {
    /// Chrome refuses a message from the host larger than this (1 MB).
    public static let maxToExtension = 1024 * 1024
    /// Chrome sends the host messages up to 64 MiB; a longer length is corrupt input.
    public static let maxFromExtension = 64 * 1024 * 1024

    public static func encode(_ payload: Data) -> Data {
        var n = UInt32(payload.count).littleEndian
        var out = Data(bytes: &n, count: 4)
        out.append(payload)
        return out
    }
}

public enum FrameError: Error, Equatable {
    case tooLong(Int)
}

/// Splits a byte stream from Chrome into message payloads. Feed it bytes as they arrive.
public struct FrameReader {
    private var buffer = Data()
    public let maxLength: Int
    public init(maxLength: Int = NativeFrame.maxFromExtension) { self.maxLength = maxLength }

    /// Appends bytes and returns every complete payload they finish, in order.
    public mutating func feed(_ bytes: Data) throws -> [Data] {
        buffer.append(bytes)
        var out: [Data] = []
        while buffer.count >= 4 {
            let start = buffer.startIndex
            let n = Int(UInt32(buffer[start]) | UInt32(buffer[start + 1]) << 8 | UInt32(buffer[start + 2]) << 16 | UInt32(buffer[start + 3]) << 24)
            if n > maxLength { throw FrameError.tooLong(n) }
            guard buffer.count >= 4 + n else { break }
            out.append(Data(buffer[(start + 4)..<(start + 4 + n)]))
            buffer = Data(buffer[(start + 4 + n)...])
        }
        return out
    }
}

/// Splits one helper line too long for a Native Messaging frame into pageChunk messages the worker joins by `id`.
public enum Chunker {
    /// UTF-8 bytes of the line per chunk. JSON escaping at most sextuples a byte (a control character becomes
    /// \u00XX), so 160 KiB stays under Chrome's 1 MB per frame with the envelope.
    public static let chunkBytes = 160 * 1024

    /// The frames' payloads for `line` (no trailing newline): the line itself when it fits, otherwise chunks.
    public static func payloads(for line: Data, id: @autoclosure () -> String, maxFrame: Int = NativeFrame.maxToExtension) throws -> [Data] {
        if line.count <= maxFrame { return [line] }
        guard let text = String(data: line, encoding: .utf8) else { throw ChunkError.notUTF8 }
        var parts: [String] = []
        var current = String.UnicodeScalarView()
        var bytes = 0
        for s in text.unicodeScalars {
            let n = String(s).utf8.count
            if bytes + n > chunkBytes {
                parts.append(String(current))
                current = String.UnicodeScalarView()
                bytes = 0
            }
            current.append(s)
            bytes += n
        }
        if !current.isEmpty { parts.append(String(current)) }
        let chunkId = id()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try parts.enumerated().map { i, p in
            let d = try encoder.encode(PageChunk(id: chunkId, index: i, count: parts.count, data: p))
            if d.count > maxFrame { throw ChunkError.chunkTooLong(d.count) }
            return d
        }
    }
}

public enum ChunkError: Error, Equatable {
    case notUTF8
    case chunkTooLong(Int)
}
