import XCTest
@testable import CaretCore

/// Drives a real child process rather than FakeTransport, because the ordering
/// under test is between a pipe reaching EOF and a process exiting — neither of
/// which a fake reproduces.
final class RealSubprocessTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        try XCTSkipIf(Self.python == nil, "no python3 on PATH")
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("caret-transport-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private static let python: URL? = {
        for path in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }()

    /// Writes `source` as an importable module and returns a configuration
    /// that runs it with `-m`.
    private func configuration(module: String, source: String) throws -> CoreLaunchConfiguration {
        try source.write(
            to: root.appendingPathComponent("\(module).py"),
            atomically: true,
            encoding: .utf8
        )
        return CoreLaunchConfiguration(
            rootURL: root,
            pythonURL: Self.python!,
            moduleName: module,
            environmentOverrides: ["PYTHONDONTWRITEBYTECODE": "1"]
        )
    }

    /// The child answers and exits in the same breath, so the reply and the EOF
    /// land together. Repeated, because the losing interleaving is rare.
    func testAReplyWrittenImmediatelyBeforeExitIsNeverLost() async throws {
        let configuration = try configuration(module: "reply_then_exit", source: """
        import sys
        sys.stdout.write('{"id":1,"ok":true,"result":{"protocol":1,"interval_seconds":2.0,'
                         '"max_offer_age_seconds":30.0,"max_inline_units":120,"workflows":[]}}\\n')
        sys.stdout.flush()
        """)

        for attempt in 1...25 {
            let client = CoreBridgeClient(configuration: configuration)
            try client.start()
            do {
                let hello = try await client.hello()
                XCTAssertEqual(hello.protocolVersion, 1, "attempt \\(attempt)")
            } catch {
                XCTFail("attempt \\(attempt) lost the reply: \\(error)")
            }
            await client.shutdown(timeout: 1)
        }
    }

    /// A child that exits without answering must fail the waiter, not hang it.
    func testAChildThatExitsSilentlyFailsThePendingRequest() async throws {
        let configuration = try configuration(module: "silent_exit", source: "import sys\nsys.exit(3)\n")

        for _ in 1...10 {
            let client = CoreBridgeClient(configuration: configuration)
            try client.start()
            do {
                _ = try await client.hello()
                XCTFail("expected the exit to fail the request")
            } catch let error as BridgeError {
                guard case .processExited = error else {
                    return XCTFail("expected processExited, got \\(error)")
                }
            }
            await client.shutdown(timeout: 1)
        }
    }

    /// stdout split across writes with no trailing newline on the last one.
    func testPartialFinalLineIsDeliveredAtEOF() async throws {
        let configuration = try configuration(module: "split_then_exit", source: """
        import sys, time
        sys.stdout.write('{"event":"abstain","revision":8,')
        sys.stdout.flush()
        time.sleep(0.05)
        sys.stdout.write('"reason":"judge-abstained"}')
        sys.stdout.flush()
        """)

        let client = CoreBridgeClient(configuration: configuration)
        let received = Received()
        client.onEvent { received.append($0) }
        try client.start()

        let deadline = Date().addingTimeInterval(5)
        while received.all().isEmpty, Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        await client.shutdown(timeout: 1)

        XCTAssertEqual(received.all(), [.abstain(revision: 8, reason: "judge-abstained")])
    }

    /// stderr must not reach the log or the termination reason.
    func testStderrContentIsNotSurfaced() async throws {
        let configuration = try configuration(module: "noisy_exit", source: """
        import sys
        sys.stderr.write("provider echoed: SECRET-CANARY-TEXT\\n")
        sys.stderr.flush()
        sys.exit(1)
        """)

        let client = CoreBridgeClient(configuration: configuration)
        try client.start()
        do {
            _ = try await client.hello()
            XCTFail("expected the exit to fail the request")
        } catch let error as BridgeError {
            XCTAssertFalse("\\(error)".contains("SECRET-CANARY-TEXT"), "stderr text leaked into the error")
            guard case .processExited = error else { return XCTFail("expected processExited, got \\(error)") }
        }
        await client.shutdown(timeout: 1)
    }
}
