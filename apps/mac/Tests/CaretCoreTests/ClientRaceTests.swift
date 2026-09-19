import XCTest
@testable import CaretCore

/// The id is reserved and its waiter installed under one lock, so a
/// cancellation or an exit that lands before the continuation exists still
/// settles the request. Each case is asserted with a deadline: a regression
/// here hangs rather than fails, and a hang must be reported as a failure.
final class ClientRaceTests: XCTestCase {
    private func withDeadline<T: Sendable>(
        _ seconds: TimeInterval = 3,
        _ body: @escaping @Sendable () async -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { await body() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = try await group.next()
            group.cancelAll()
            guard let value = first ?? nil else {
                XCTFail("the request never settled within \(seconds)s")
                throw BridgeError.cancelled
            }
            return value
        }
    }

    func testCancellingImmediatelyAfterTheCallStartsAlwaysSettles() async throws {
        for _ in 0..<40 {
            let transport = FakeTransport()
            let client = CoreBridgeClient(transport: transport)
            try client.start()

            let task = Task { () -> Error? in
                do {
                    _ = try await client.hello()
                    return nil
                } catch {
                    return error
                }
            }
            task.cancel()

            let error = try await withDeadline { await task.value }
            XCTAssertNotNil(error, "a cancelled request must not succeed silently")
        }
    }

    func testTerminationDuringTheWriteSettlesTheWaiter() async throws {
        let transport = FakeTransport()
        transport.terminatesDuringSend = true
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        let error = try await withDeadline { () -> Error? in
            do {
                _ = try await client.hello()
                return nil
            } catch {
                return error
            }
        }
        guard case .processExited(let status, _)? = error as? BridgeError else {
            return XCTFail("expected processExited, got \(String(describing: error))")
        }
        XCTAssertEqual(status, 9)
    }

    func testManyConcurrentRequestsAllSettleWhenTheCoreExits() async throws {
        let transport = FakeTransport()
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        let outcomes = try await withDeadline(5) { () -> Int in
            await withTaskGroup(of: Bool.self) { group in
                for _ in 0..<25 {
                    group.addTask {
                        do {
                            _ = try await client.hello()
                            return false
                        } catch {
                            return true
                        }
                    }
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    transport.terminate(status: 4)
                    return true
                }
                var failures = 0
                for await failed in group where failed { failures += 1 }
                return failures
            }
        }
        // Every request plus the terminator accounted for; none left pending.
        XCTAssertEqual(outcomes, 26)
    }

    func testShutdownDoesNotHangWhenTheChildNeverAnswers() async throws {
        let transport = FakeTransport()
        transport.dropsRequests = true
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        let started = Date()
        try await withDeadline(4) { await client.shutdown(timeout: 0.3) }
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertEqual(transport.stopCount, 1)
        XCTAssertEqual(client.currentState, .stopped(.stoppedByClient))
    }

    func testAReplyAlreadyInThePipeIsDeliveredBeforeTheExitFailsWaiters() async throws {
        // The transport drains stdout before reporting termination, so a reply
        // written just before the exit still resolves its request.
        let transport = FakeTransport()
        let client = CoreBridgeClient(transport: transport)
        try client.start()

        async let reply = client.updateContext(Fixtures.frame())
        guard let id = transport.awaitRequest() else { return XCTFail("no request was written") }
        transport.emit(line: #"{"id":\#(id),"ok":true,"result":{"status":"admitted","reason":"","revision":7}}"#)
        transport.terminate(status: 0)

        let result = try await reply
        XCTAssertEqual(result.status, .admitted)
    }
}
