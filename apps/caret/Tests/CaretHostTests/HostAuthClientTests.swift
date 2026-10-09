import CaretHostCore
import CaretScreenCore
import Darwin
import os
import XCTest
@testable import CaretHost

/// The host's side of the helper's host authentication over a real socket: the client proves it is the host before it
/// writes anything else, and counts itself linked only after the helper accepts; a Caret with no key says nothing of a
/// host. A fake helper in a /tmp directory of the test's own plays the helper's lines (helper/src/server.ts).
final class HostAuthClientTests: XCTestCase {
    private var dir = ""

    override func setUpWithError() throws {
        // /tmp, not NSTemporaryDirectory: a socket path must fit in 103 bytes.
        var template = Array("/tmp/caret-ha-XXXXXX".utf8CString)
        guard let made = mkdtemp(&template) else { throw XCTSkip("mkdtemp failed") }
        dir = String(cString: made)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private struct Failure: Error, CustomStringConvertible { let description: String }

    /// One listening socket and the one connection it accepts, read a line at a time.
    private final class FakeHelper {
        let path: String
        private let listener: Int32
        private var conn: Int32 = -1
        private var buffer = Data()

        init(path: String) throws {
            self.path = path
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            withUnsafeMutableBytes(of: &address.sun_path) { raw in
                let bytes = Array(path.utf8)
                raw.copyBytes(from: bytes)
                raw[bytes.count] = 0
            }
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0, Darwin.listen(listener, 4) == 0 else { throw Failure(description: "could not listen on \(path)") }
        }

        deinit {
            if conn >= 0 { close(conn) }
            close(listener)
        }

        private func ready(_ fd: Int32, within seconds: Double) -> Bool {
            var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            return poll(&p, 1, Int32(seconds * 1000)) > 0
        }

        /// Takes the client's next connection, closing the one before.
        func accept(within seconds: Double = 5) throws {
            guard ready(listener, within: seconds) else { throw Failure(description: "the client did not connect") }
            if conn >= 0 { close(conn) }
            buffer = Data()
            conn = Darwin.accept(listener, nil, nil)
        }

        /// The next line as JSON, or a failure after `seconds`.
        func line(within seconds: Double = 5) throws -> [String: Any] {
            let deadline = Date().addingTimeInterval(seconds)
            while true {
                if let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<nl]
                    buffer.removeSubrange(buffer.startIndex...nl)
                    guard let o = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw Failure(description: "not an object") }
                    return o
                }
                let left = deadline.timeIntervalSinceNow
                guard left > 0, ready(conn, within: left) else { throw Failure(description: "no line within \(seconds) s") }
                var chunk = [UInt8](repeating: 0, count: 4096)
                let n = read(conn, &chunk, chunk.count)
                guard n > 0 else { throw Failure(description: "the client closed the connection") }
                buffer.append(contentsOf: chunk[0..<n])
            }
        }

        /// True when the client writes nothing for `seconds` and keeps the connection open.
        func quiet(for seconds: Double) -> Bool {
            buffer.isEmpty && !ready(conn, within: seconds)
        }

        /// True when the client closes the connection within `seconds`, whatever it wrote first.
        func closed(within seconds: Double = 5) -> Bool {
            let deadline = Date().addingTimeInterval(seconds)
            var chunk = [UInt8](repeating: 0, count: 4096)
            while deadline.timeIntervalSinceNow > 0, ready(conn, within: deadline.timeIntervalSinceNow) {
                if read(conn, &chunk, chunk.count) <= 0 { return true }
            }
            return false
        }

        /// Closes the current connection without a word.
        func drop() {
            if conn >= 0 { close(conn) }
            conn = -1
            buffer = Data()
        }

        func send(_ line: String) {
            let data = Data((line + "\n").utf8)
            _ = data.withUnsafeBytes { write(conn, $0.baseAddress, $0.count) }
        }
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            usleep(10_000)
        }
        return condition()
    }

    private let key = HostAuth.hostKey(launchSecret: Data(repeating: 7, count: 32))
    private let nonce = Data((0..<32).map { UInt8($0) }).base64EncodedString()

    func testTheClientProvesItIsTheHostBeforeItWritesAnythingElse() throws {
        let helper = try FakeHelper(path: "\(dir)/s.sock")
        let links = OSAllocatedUnfairLock(initialState: [Bool]())
        let client = HelperClient(path: helper.path, onMessage: { _ in }, onLink: { up in links.withLock { $0.append(up) } }, hostKey: key)
        client.update(HostSettings(CaretSettings(), at: 1))
        client.start()
        defer { client.stop() }
        try helper.accept()
        let hello = try helper.line()
        XCTAssertEqual(hello["type"] as? String, "hello")
        XCTAssertEqual(hello["host"] as? Bool, true)

        // Before the challenge is answered: no settings, no request, not linked.
        XCTAssertTrue(helper.quiet(for: 0.3))
        XCTAssertFalse(client.send(ActivityRequest(requestId: "early", op: .list)))
        XCTAssertEqual(links.withLock { $0 }, [])
        XCTAssertEqual(client.snapshot().hostAuthenticated, false)
        XCTAssertFalse(client.declaresGoalFiles)

        helper.send(#"{"type":"hostChallenge","v":1,"nonce":"\#(nonce)"}"#)
        let proof = try helper.line()
        XCTAssertEqual(proof as NSDictionary, ["type": "hostProof", "v": 1, "proof": HostAuth.proof(hostKey: key, nonce: nonce)] as NSDictionary)
        XCTAssertTrue(helper.quiet(for: 0.3), "the settings wait for the helper's acceptance")
        XCTAssertEqual(links.withLock { $0 }, [])

        helper.send(#"{"type":"hostAuthenticated","v":1}"#)
        XCTAssertEqual(try helper.line()["type"] as? String, "settings", "settings first, once the connection is the host's")
        XCTAssertTrue(until { links.withLock { $0 } == [true] })
        XCTAssertEqual(client.snapshot().hostAuthenticated, true)
        XCTAssertTrue(client.send(ActivityRequest(requestId: "after", op: .list)))
        XCTAssertEqual(try helper.line()["requestId"] as? String, "after")
    }

    func testTheClientClosesWhenTheHelperRefusesItsProof() throws {
        let helper = try FakeHelper(path: "\(dir)/s.sock")
        let links = OSAllocatedUnfairLock(initialState: [Bool]())
        let client = HelperClient(path: helper.path, onMessage: { _ in }, onLink: { up in links.withLock { $0.append(up) } }, hostKey: key)
        client.start()
        defer { client.stop() }
        try helper.accept()
        _ = try helper.line()
        helper.send(#"{"type":"hostChallenge","v":1,"nonce":"\#(nonce)"}"#)
        _ = try helper.line()
        helper.send(#"{"type":"error","v":1,"at":1,"message":"the host's proof does not match this connection's challenge under the launch secret's host key; closing"}"#)
        XCTAssertTrue(helper.closed())
        XCTAssertEqual(client.snapshot().lastError, "the helper refused this host: the host's proof does not match this connection's challenge under the launch secret's host key; closing".prefix(200).description)
        XCTAssertEqual(links.withLock { $0 }, [], "never linked, so never unlinked")
        XCTAssertEqual(client.snapshot().hostAuthenticated, false)
        XCTAssertTrue(until { client.snapshot().hostRefused == "Caret can't reach its helper: the helper refused Caret's key" }, "the menu's line names the refusal")
        XCTAssertEqual(client.snapshot().hostRetrySeconds, 2)
    }

    func testAfterARefusalTheClientWaitsTwoSecondsAndTheLineClearsOnceAccepted() throws {
        let helper = try FakeHelper(path: "\(dir)/s.sock")
        let links = OSAllocatedUnfairLock(initialState: [Bool]())
        let client = HelperClient(path: helper.path, onMessage: { _ in }, onLink: { up in links.withLock { $0.append(up) } }, hostKey: key)
        client.start()
        defer { client.stop() }
        try helper.accept()
        _ = try helper.line()
        // The helper closes during the handshake without a word: a refusal too.
        helper.send(#"{"type":"hostChallenge","v":1,"nonce":"\#(nonce)"}"#)
        _ = try helper.line()
        let refusedAt = Date()
        helper.drop()
        XCTAssertTrue(until { client.snapshot().hostRefused == "Caret can't reach its helper: the helper closed the connection before accepting Caret's key" })

        try helper.accept(within: 5)
        XCTAssertGreaterThan(Date().timeIntervalSince(refusedAt), 1.5, "the first retry after a refusal waits 2 s, not the 0.25 s of an ordinary drop")
        XCTAssertEqual(try helper.line()["host"] as? Bool, true)
        helper.send(#"{"type":"hostChallenge","v":1,"nonce":"\#(nonce)"}"#)
        _ = try helper.line()
        helper.send(#"{"type":"hostAuthenticated","v":1}"#)
        XCTAssertTrue(until { links.withLock { $0 } == [true] })
        XCTAssertNil(client.snapshot().hostRefused, "the line clears once the helper accepts this host")
        XCTAssertNil(client.snapshot().hostRetrySeconds)
    }

    func testACaretWithNoKeySaysNothingOfAHostAndIsLinkedAtOnce() throws {
        let helper = try FakeHelper(path: "\(dir)/s.sock")
        let links = OSAllocatedUnfairLock(initialState: [Bool]())
        let client = HelperClient(path: helper.path, onMessage: { _ in }, onLink: { up in links.withLock { $0.append(up) } }, wantsRouting: { true }, goalFiles: { true }, hostKey: nil)
        client.update(HostSettings(CaretSettings(), at: 1))
        client.start()
        defer { client.stop() }
        try helper.accept()
        let hello = try helper.line()
        XCTAssertNil(hello["host"], "no host: true without a key")
        let claimed = Set(hello["capabilities"] as? [String] ?? [])
        XCTAssertEqual(claimed.intersection(HostHello.hostOnlyCapabilities), [], "no host-only capability is claimed, though routing and goal files are wanted")
        XCTAssertTrue(claimed.contains(MemoryDocs.capability), "what any consumer may have is still claimed")
        XCTAssertEqual(try helper.line()["type"] as? String, "settings")
        XCTAssertTrue(until { links.withLock { $0 } == [true] })
        XCTAssertNil(client.snapshot().hostAuthenticated)
        XCTAssertFalse(client.declaresRouting)
    }

    @MainActor
    func testAnAttachedCaretTakesItsKeyFromTheDescriptorAndOtherwiseHasNone() throws {
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { throw XCTSkip("pipe failed") }
        defer { close(fds[1]) }
        XCTAssertEqual(key.withUnsafeBytes { write(fds[1], $0.baseAddress, $0.count) }, 32)
        let attached = CaretServices.Mode.attached(socket: "\(dir)/s.sock", why: "a helper socket was named")
        let services = try CaretServices(mode: attached, environment: [HostAuth.keyDescriptorVariable: "\(fds[0])"])
        XCTAssertEqual(services.hostKey, key)
        XCTAssertEqual(fcntl(fds[0], F_GETFD), -1, "the descriptor is closed once read")
        XCTAssertTrue(services.report().contains(#""hostKey":true"#))

        let none = try CaretServices(mode: attached, environment: [:])
        XCTAssertNil(none.hostKey)
        XCTAssertTrue(none.report().contains(#""hostKey":false"#))
        XCTAssertThrowsError(try CaretServices(mode: attached, environment: [HostAuth.keyDescriptorVariable: "1"]))
    }
}
