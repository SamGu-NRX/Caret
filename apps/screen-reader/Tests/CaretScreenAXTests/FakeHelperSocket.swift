// A listening Unix socket a test plays the helper on: it accepts the reader's connection, writes the helper's
// lines to it, and reads only the reader's hello (to answer its challenge), as a helper whose event loop has
// stalled reads nothing more. The socket lives in a directory of its own, mode 0700, as the reader requires (B23).
import CaretScreenAX
import CaretScreenCore
import Darwin
import Foundation

/// The launch secret the tests' reader and helper share.
let testSecret = Data("caret-b23-golden-launch-secret!!".utf8)

final class FakeHelperSocket {
    let dir: String
    let path: String
    private let listener: Int32
    private(set) var conn: Int32 = -1

    /// `dirMode` is the socket directory's mode; anything but 0700 is for tests of the reader refusing it.
    init(dirMode: mode_t = 0o700) throws {
        // Short, so it fits sun_path; private to this test process.
        var template = Array("/tmp/caret-b23-XXXXXX".utf8CString)
        guard mkdtemp(&template) != nil else { throw POSIXError(.EIO) }
        dir = String(cString: template)
        chmod(dir, dirMode)
        path = dir + "/s.sock"
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw POSIXError(.EIO) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(listener, 4) == 0 else { throw POSIXError(.EADDRINUSE) }
    }

    /// Waits up to `timeout` for the reader to connect; true when it did. A later call takes the next connection.
    func accept(timeout: TimeInterval) -> Bool {
        var p = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
        guard poll(&p, 1, Int32(timeout * 1000)) == 1 else { return false }
        if conn >= 0 { close(conn) }
        conn = Darwin.accept(listener, nil, nil)
        var on: Int32 = 1
        setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        return conn >= 0
    }

    /// Reads one line from the reader, waiting up to `timeout`; nil when none came. Reads a byte at a time, so nothing
    /// after the line is taken off the socket.
    func readLine(timeout: TimeInterval) -> String? {
        var line = [UInt8]()
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            var p = pollfd(fd: conn, events: Int16(POLLIN), revents: 0)
            guard poll(&p, 1, 50) == 1 else { continue }
            var b: UInt8 = 0
            guard Darwin.read(conn, &b, 1) == 1 else { return nil }
            if b == 0x0A { return String(decoding: line, as: UTF8.self) }
            line.append(b)
        }
        return nil
    }

    /// Reads the reader's hello and answers its challenge with the proof under `secret`. Returns the hello.
    @discardableResult
    func authenticate(_ secret: Data = testSecret) -> Hello? {
        guard let line = readLine(timeout: 3), case .hello(let h)? = try? JSONDecoder().decode(Message.self, from: Data(line.utf8)), let challenge = h.challenge else { return nil }
        send(#"{"type":"helperAuth","v":1,"proof":"\#(HelperProof.proof(secret: secret, challenge: challenge))"}"#)
        return h
    }

    /// Writes one line to the reader. Blocks only if the reader stopped reading, which is what the tests check it never does.
    func send(_ line: String) {
        let d = Array((line + "\n").utf8)
        var off = 0
        while off < d.count {
            let n = d[off...].withUnsafeBytes { Darwin.write(conn, $0.baseAddress!, $0.count) }
            if n <= 0 { return }
            off += n
        }
    }

    deinit {
        if conn >= 0 { close(conn) }
        close(listener)
        unlink(path)
        rmdir(dir)
    }
}

/// Polls `cond` every 10 ms for up to `seconds`; true once it holds.
func eventually(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if cond() { return true }
        usleep(10_000)
    }
    return cond()
}

func grantLine(_ task: String) -> String {
    #"{"type":"actGrant","v":1,"taskId":"\#(task)","pid":500,"windowId":"500-1","at":1790000000000,"expires":1790000060000}"#
}

func revokeLine(_ task: String) -> String {
    #"{"type":"actRevoke","v":1,"taskId":"\#(task)","at":1790000001000}"#
}

func commandLine(_ id: String) -> String {
    #"{"type":"readerCommand","v":1,"id":"\#(id)","expires":1790000060000,"verb":{"kind":"walk","pid":500,"windowId":"500-1"}}"#
}

/// A reader's emitter on `helper`'s socket with the tests' secret, started.
func readerEmitter(_ helper: FakeHelperSocket, grants: GrantTable, configure: (SocketEmitter) -> Void = { _ in }) -> SocketEmitter {
    let emitter = SocketEmitter(path: helper.path, hello: Hello(role: .reader, mode: .live, pid: Int(getpid()), version: "b23-test", session: "reader-test-session"), secret: testSecret)
    emitter.log = { _ in }
    emitter.grants = grants
    configure(emitter)
    emitter.start()
    return emitter
}
