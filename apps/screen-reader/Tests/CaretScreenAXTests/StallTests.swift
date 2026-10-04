// S1 audit #9: a helper that stops reading fails closed. Every grant ends and the reader connects again, by
// bytes waiting or by time without progress, whichever comes first.
import CaretScreenAX
import CaretScreenCore
import Darwin
import Foundation
import Testing

@Suite(.serialized) struct StallTests {
    private func connected(_ configure: (SocketEmitter) -> Void) throws -> (FakeHelperSocket, SocketEmitter, GrantTable) {
        let helper = try FakeHelperSocket()
        let grants = GrantTable()
        let emitter = SocketEmitter(path: helper.path, hello: Hello(role: .reader, mode: .live, pid: Int(getpid()), version: "b22-test"))
        emitter.log = { _ in }
        emitter.grants = grants
        configure(emitter)
        emitter.start()
        #expect(helper.accept(timeout: 3))
        helper.send(grantLine("t1"))
        #expect(eventually(3) { grants.count == 1 })
        return (helper, emitter, grants)
    }

    private func flood(_ emitter: SocketEmitter) {
        for i in 0..<25_000 { emitter.send(.pasteboard(Pasteboard(at: 1_790_000_000_000, changeCount: i))) }
    }

    @Test func endsEveryGrantAndReconnectsWhenTheHelperTakesNothingForTooLong() throws {
        let (helper, emitter, grants) = try connected { $0.stallAfter = 0.5 }
        flood(emitter)
        #expect(eventually(4) { grants.count == 0 }, "grants ended")
        #expect(emitter.dropped > 0, "what was waiting was dropped")
        // The reader comes back with a new connection, which begins with hello.
        #expect(helper.accept(timeout: 3))
    }

    @Test func endsEveryGrantAtOnceWhenTooMuchIsWaiting() throws {
        let (_, emitter, grants) = try connected { $0.stallBytes = 200_000; $0.stallAfter = 600 }
        flood(emitter)
        #expect(eventually(2) { grants.count == 0 }, "grants ended")
    }

    @Test func keepsTheConnectionWhileTheHelperReads() throws {
        let (helper, emitter, grants) = try connected { $0.stallAfter = 0.5 }
        // The helper drains the socket as the reader writes: no stall, the grant stays. The thread ends when the
        // socket closes with the test.
        let fd = helper.conn
        let reading = Thread {
            var buf = [UInt8](repeating: 0, count: 65_536)
            while read(fd, &buf, buf.count) > 0 {}
        }
        reading.start()
        flood(emitter)
        usleep(1_500_000)
        #expect(grants.count == 1)
        #expect(emitter.isConnected)
    }
}
