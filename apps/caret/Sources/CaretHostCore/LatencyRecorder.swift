import Foundation
import os

/// A bounded, thread-safe reservoir of millisecond samples with nearest-rank percentiles.
public final class LatencyRecorder: @unchecked Sendable {
    public struct Summary: Codable, Equatable, Sendable {
        public var count: Int
        public var p50Ms: Double?
        public var p95Ms: Double?
        public var maxMs: Double?
        /// The newest samples, oldest first.
        public var samplesMs: [Double]
    }

    private let capacity: Int
    private let samples: OSAllocatedUnfairLock<[Double]>

    public init(capacity: Int = 500) {
        self.capacity = max(1, capacity)
        self.samples = OSAllocatedUnfairLock(initialState: [])
    }

    public func record(_ milliseconds: Double) {
        guard milliseconds.isFinite, milliseconds >= 0 else { return }
        samples.withLock { values in
            values.append(milliseconds)
            if values.count > capacity { values.removeFirst(values.count - capacity) }
        }
    }

    public func reset() {
        samples.withLock { $0.removeAll() }
    }

    public func summary() -> Summary {
        let values = samples.withLock { $0 }
        let sorted = values.sorted()
        return Summary(
            count: values.count,
            p50Ms: Self.percentile(sorted, 0.50),
            p95Ms: Self.percentile(sorted, 0.95),
            maxMs: sorted.last,
            samplesMs: values
        )
    }

    /// Nearest-rank percentile over an ascending array.
    public static func percentile(_ sorted: [Double], _ p: Double) -> Double? {
        guard !sorted.isEmpty else { return nil }
        let rank = Int((p * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank, 1), sorted.count) - 1]
    }
}
