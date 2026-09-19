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
    private var stdoutPipe: Pipe?
    private var accumulator = LineAccumulator()
    private var terminated = false
    private var lineSink: ((String) -> Void)?
    private var stderrLineCount = 0

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

        lock.lock()
        lineSink = onLine
        lock.unlock()

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

        // A provider failure can echo upstream response text, and that text may
        // contain whatever the user was typing. stderr is therefore counted,
        // never logged and never put in a termination reason.
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let chunk = handle.availableData
            guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
            self.countStderr(text)
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
        self.stdoutPipe = stdout
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

    private func countStderr(_ text: String) {
        let count = text.split(separator: "\n").count
        lock.lock()
        stderrLineCount += count
        lock.unlock()
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
        let handle = stdoutPipe?.fileHandleForReading
        let sink = lineSink
        let suppressed = stderrLineCount
        lock.unlock()

        // Drain whatever stdout still holds before anyone is told the core is
        // gone. A reply can be sitting in the pipe when the process exits, and
        // failing its waiter first would lose an answer we already have.
        if let handle, let sink {
            let remaining = (try? handle.readToEnd()) ?? Data()
            lock.lock()
            var lines = accumulator.append(remaining)
            if let trailing = accumulator.flush() { lines.append(trailing) }
            lock.unlock()
            for line in lines { sink(line) }
        }

        if suppressed > 0 {
            // The count is safe to record; the text is not.
            log.error("core wrote \(suppressed, privacy: .public) diagnostic line(s) before exiting")
        }
        onTermination(reason)
    }
}
