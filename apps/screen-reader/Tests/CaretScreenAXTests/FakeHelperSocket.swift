// A listening Unix socket a test plays the helper on: it accepts the reader's connection, writes the helper's
// lines to it, and reads nothing, as a helper whose event loop has stalled reads nothing.
import Darwin
import Foundation

final class FakeHelperSocket {
    let path: String
    private let listener: Int32
    private(set) var conn: Int32 = -1

    init() throws {
        // Short, so it fits sun_path; private to this test process.
        path = "/tmp/caret-b22-\(getpid())-\(UInt32.random(in: 0...UInt32.max)).sock"
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
