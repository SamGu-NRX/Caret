// S1 audit #9: before B22 one serial queue wrote with blocking writes and read the helper's lines, so a helper
// that stopped reading left a revoke unread while commands still acted under the old grant. This test uses only
// what the emitter offered before B22, so it can be run against that code to see it fail.
import CaretScreenAX
import CaretScreenCore
import Darwin
import Foundation
import Testing

@Suite(.serialized) struct BackpressureTests {
    @Test func appliesARevokeWhileItsOwnOutputIsBlocked() throws {
        let helper = try FakeHelperSocket()
        let grants = GrantTable()
        let emitter = SocketEmitter(path: helper.path, hello: Hello(role: .reader, mode: .live, pid: Int(getpid()), version: "b22-test"))
        emitter.log = { _ in }
        emitter.grants = grants
        emitter.start()
        #expect(helper.accept(timeout: 3))
        helper.send(grantLine("t1"))
        #expect(eventually(3) { grants.count == 1 }, "the grant arrived")
        // The helper reads nothing while the reader writes about 2 MB of small messages, far past what the socket holds.
        for i in 0..<25_000 { emitter.send(.pasteboard(Pasteboard(at: 1_790_000_000_000, changeCount: i))) }
        usleep(300_000)
        helper.send(revokeLine("t1"))
        #expect(eventually(2) { grants.count == 0 }, "the revoke was applied while output was blocked")
    }
}
