import Foundation
import os

/// Where the core lives and which interpreter runs it.
///
/// Nothing here is baked in. The launch root and the Python executable are both
/// supplied by the caller, because this is a developer's local app and the
/// repository is wherever that developer put it. `--judge scripted:` is
/// deliberately absent: the core refuses to fall back to a canned response, and
/// the app must not hand it one either, so an unconfigured machine fails
/// visibly instead of producing output that looks like a model result.
public struct CoreLaunchConfiguration: Equatable, Sendable {
    /// Directory the core is run from; `-m caret.bridge` resolves against it.
    public var rootURL: URL
    /// Interpreter to run. Resolved by the caller (a settings value, a
    /// `PATH` lookup, or a virtualenv) rather than guessed here.
    public var pythonURL: URL
    public var moduleName: String
    /// Extra flags such as `--fixture`, `--db`, `--judge`, `--writer`.
    public var arguments: [String]
    /// Added to the child's environment. Provider keys (`TYPESAFE_API_KEY`,
    /// `GROQ_API_KEY`) belong here, read from the user's own environment or
    /// Keychain by the caller. They are never logged.
    public var environmentOverrides: [String: String]

    public init(
        rootURL: URL,
        pythonURL: URL,
        moduleName: String = "caret.bridge",
        arguments: [String] = [],
        environmentOverrides: [String: String] = [:]
    ) {
        self.rootURL = rootURL
        self.pythonURL = pythonURL
        self.moduleName = moduleName
        self.arguments = arguments
        self.environmentOverrides = environmentOverrides
    }
}

/// Runs the core as a long-lived child process and moves whole lines over its
/// stdin and stdout.
public final class CoreProcessTransport: CoreTransport {
    private let configuration: CoreLaunchConfiguration
    private let log = Logger(subsystem: "com.caret.app", category: "core-transport")
    private let lock = NSLock()

    private var process: Process?
    private var stdinPipe: Pipe?
    private var accumulator = LineAccumulator()
    private var terminated = false

    public init(configuration: CoreLaunchConfiguration) {
        self.configuration = configuration
    }

    public func start(
        onLine: @escaping (String) -> Void,
        onTermination: @escaping (CoreTerminationReason) -> Void
    ) throws {
        lock.lock()
        guard process == nil else {
            lock.unlock()
            throw BridgeError.alreadyRunning
        }
        lock.unlock()

        let process = Process()
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.executableURL = configuration.pythonURL
        process.currentDirectoryURL = configuration.rootURL
        process.arguments = ["-u", "-m", configuration.moduleName] + configuration.arguments
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in configuration.environmentOverrides { environment[key] = value }
        process.environment = environment
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                self.finish(reason: .exited(status: self.currentStatus()), onTermination: onTermination)
                return
            }
            self.lock.lock()
            let lines = self.accumulator.append(chunk)
            self.lock.unlock()
            for line in lines { onLine(line) }
        }

        // The core writes diagnostics here. We keep the last lines for an exit
        // message and log them; they are the core's own text, never field
        // content, because a frame's text never leaves the app in a log.
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let chunk = handle.availableData
            guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
            self.recordStderr(text)
        }

        process.terminationHandler = { [weak self] finished in
            guard let self else { return }
            self.finish(reason: .exited(status: finished.terminationStatus), onTermination: onTermination)
        }

        do {
            try process.run()
        } catch {
            throw BridgeError.launchFailed(error.localizedDescription)
        }

        lock.lock()
        self.process = process
        self.stdinPipe = stdin
        self.terminated = false
        lock.unlock()
        log.info("core process started")
    }

    public func send(line: String) throws {
        lock.lock()
        let pipe = stdinPipe
        let running = process?.isRunning ?? false
        lock.unlock()
        guard let pipe, running else { throw BridgeError.notRunning }
        guard let data = (line + "\n").data(using: .utf8) else {
            throw BridgeError.malformedReply("request was not encodable as UTF-8")
        }
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data)
        } catch {
            // The child closed its stdin: it is gone or going.
            throw BridgeError.notRunning
        }
    }

    public func stop() {
        lock.lock()
        let process = self.process
        let stdin = self.stdinPipe
        lock.unlock()
        try? stdin?.fileHandleForWriting.close()
        guard let process, process.isRunning else { return }
        process.terminate()
    }

    // MARK: - Private

    private var stderrTail: [String] = []

    private func recordStderr(_ text: String) {
        let lines = text.split(separator: "\n").map(String.init)
        lock.lock()
        stderrTail.append(contentsOf: lines)
        if stderrTail.count > 10 { stderrTail.removeFirst(stderrTail.count - 10) }
        lock.unlock()
        for line in lines { log.error("core stderr: \(line, privacy: .public)") }
    }

    private func currentStatus() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard let process else { return -1 }
        return process.isRunning ? 0 : process.terminationStatus
    }

    private func finish(reason: CoreTerminationReason, onTermination: @escaping (CoreTerminationReason) -> Void) {
        lock.lock()
        if terminated {
            lock.unlock()
            return
        }
        terminated = true
        let trailing = accumulator.flush()
        let detail = stderrTail.suffix(3).joined(separator: " / ")
        lock.unlock()
        if trailing != nil { log.error("core stdout ended mid-line") }
        let annotated: CoreTerminationReason
        if case .exited(let status) = reason, !detail.isEmpty {
            annotated = status == 0 ? .exited(status: status) : .failed("exit \(status): \(detail)")
        } else {
            annotated = reason
        }
        onTermination(annotated)
    }
}
