import Foundation
@testable import CaretCore

/// Stands in for the child process. Tests drive the exact bytes the core would
/// write, including chunk boundaries that fall in the middle of a line.
final class FakeTransport: CoreTransport {
    private let lock = NSLock()
    private var onLine: ((String) -> Void)?
    private var onTermination: ((CoreTerminationReason) -> Void)?
    private var accumulator = LineAccumulator()

    private(set) var sentLines: [String] = []
    private(set) var stopCount = 0
    var sendError: Error?
    /// Fires the termination callback from inside `send`, so the core is gone
    /// before the caller's continuation can be resumed normally.
    var terminatesDuringSend = false
    /// Swallows the request instead of recording it, standing in for a child
    /// that accepts the write and never answers.
    var dropsRequests = false

    func start(onLine: @escaping (String) -> Void, onTermination: @escaping (CoreTerminationReason) -> Void) throws {
        lock.lock()
        self.onLine = onLine
        self.onTermination = onTermination
        lock.unlock()
    }

    func send(line: String) throws {
        if let sendError { throw sendError }
        lock.lock()
        if !dropsRequests { sentLines.append(line) }
        let terminates = terminatesDuringSend
        lock.unlock()
        if terminates { terminate(status: 9) }
    }

    func stop() {
        lock.lock()
        stopCount += 1
        lock.unlock()
    }

    // MARK: - Driving the fake

    /// Feeds raw bytes exactly as a pipe would, honoring partial lines.
    func emit(chunk: String) {
        lock.lock()
        let lines = accumulator.append(Data(chunk.utf8))
        let handler = onLine
        lock.unlock()
        for line in lines { handler?(line) }
    }

    func emit(line: String) { emit(chunk: line + "\n") }

    func terminate(status: Int32 = 1) {
        lock.lock()
        let handler = onTermination
        lock.unlock()
        handler?(.exited(status: status))
    }

    func lastSentMethod() -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let line = sentLines.last,
              let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        else { return nil }
        return object["method"] as? String
    }

    func lastSentID() -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard let line = sentLines.last,
              let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        else { return nil }
        return object["id"] as? Int
    }

    func sentObject(at index: Int) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard index < sentLines.count else { return nil }
        return try? JSONSerialization.jsonObject(with: Data(sentLines[index].utf8)) as? [String: Any]
    }

    /// Waits for the client to write a request, then replies to it.
    func awaitRequest(timeout: TimeInterval = 2) -> Int? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let id = lastSentID() { return id }
            usleep(2000)
        }
        return nil
    }
}

enum Fixtures {
    static let target = TargetIdentity(
        pid: 4242,
        bundleID: "com.example.Editor",
        windowID: "w1",
        elementID: "compose",
        elementRevision: "v7"
    )

    static func frame(revision: Int = 7, nearbyText: String = "I will send the ") -> ContextFrame {
        ContextFrame(
            snapshot: InputSnapshot(
                revision: revision,
                capturedAt: Date(timeIntervalSince1970: 1_790_000_000),
                target: target,
                role: "AXTextArea",
                nearbyText: nearbyText,
                textOffset: 0,
                caret: UTF16Text.length(nearbyText),
                selection: TextSelection(start: UTF16Text.length(nearbyText), end: UTF16Text.length(nearbyText)),
                valueLength: UTF16Text.length(nearbyText)
            ),
            permissions: Permissions(accessibility: true)
        )
    }
}
