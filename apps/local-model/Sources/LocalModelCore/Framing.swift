import Foundation

/// What the line reader hands on: a whole line without its newline, or a line that passed `maxBytes` and was dropped.
public enum Frame: Equatable, Sendable {
    case line(Data)
    case tooLong(bytes: Int)
}

/// Splits stdin's bytes into lines. A line longer than `maxBytes` is reported once and skipped up to its newline,
/// so one bad request never desynchronizes the ones after it.
public struct LineFramer: Sendable {
    public let maxBytes: Int
    private var buffer = Data()
    /// Bytes of an over-long line seen so far, while skipping to its newline; nil when not skipping.
    private var skipped: Int?

    public init(maxBytes: Int) {
        precondition(maxBytes > 0)
        self.maxBytes = maxBytes
    }

    public mutating func push(_ chunk: Data) -> [Frame] {
        var out: [Frame] = []
        var rest = chunk[...]
        while let nl = rest.firstIndex(of: 0x0A) {
            let piece = rest[rest.startIndex..<nl]
            rest = rest[rest.index(after: nl)...]
            if let s = skipped {
                skipped = nil
                out.append(.tooLong(bytes: s + piece.count))
                continue
            }
            if buffer.count + piece.count > maxBytes {
                out.append(.tooLong(bytes: buffer.count + piece.count))
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            buffer.append(contentsOf: piece)
            if !Self.blank(buffer) { out.append(.line(buffer)) }
            buffer = Data()
        }
        if let s = skipped {
            skipped = s + rest.count
        } else if buffer.count + rest.count > maxBytes {
            skipped = buffer.count + rest.count
            buffer.removeAll(keepingCapacity: true)
        } else {
            buffer.append(contentsOf: rest)
        }
        return out
    }

    /// At end of input: a last line without a newline still counts.
    public mutating func finish() -> [Frame] {
        defer {
            buffer = Data()
            skipped = nil
        }
        if let s = skipped { return [.tooLong(bytes: s)] }
        return Self.blank(buffer) ? [] : [.line(buffer)]
    }

    private static func blank(_ d: Data) -> Bool {
        d.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
    }
}
