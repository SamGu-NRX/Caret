// B23 (CodeRabbit on PR #4): before B23 the reader trusted any process listening at the socket path. Now the helper
// must prove it holds the launch secret before the reader sends it anything but a hello, or applies any line of its.
import CaretScreenAX
import CaretScreenCore
import Darwin
import Foundation
import Testing

/// Counts what the emitter hands on, from any thread.
private final class Seen: @unchecked Sendable {
    private let lock = NSLock()
    private var commands = 0
    private var connects: [Bool] = []
    func command() { lock.lock(); commands += 1; lock.unlock() }
    func connect(_ lost: Bool) { lock.lock(); connects.append(lost); lock.unlock() }
    var commandCount: Int { lock.lock(); defer { lock.unlock() }; return commands }
    var connectsSeen: [Bool] { lock.lock(); defer { lock.unlock() }; return connects }
}

@Suite(.serialized) struct AuthTests {
    private func started(_ helper: FakeHelperSocket, _ grants: GrantTable, _ seen: Seen, authTimeout: TimeInterval = 5) -> SocketEmitter {
        readerEmitter(helper, grants: grants) { e in
            e.authTimeout = authTimeout
            e.onCommand = { _ in seen.command() }
            e.onConnect = { lost in seen.connect(lost) }
        }
    }

    /// Sends a snapshot-sized stand-in: a pasteboard message the peer must never see.
    private func screen(_ e: SocketEmitter, _ n: Int) {
        for i in 0..<n { e.send(.pasteboard(Pasteboard(at: 1_790_000_000_000, changeCount: i))) }
    }

    @Test(arguments: ["no proof, a grant first", "a proof under another secret", "no answer at all"])
    func anUnauthenticatedPeerGetsOnlyTheHelloAndCannotGrantOrCommand(_ how: String) throws {
        let helper = try FakeHelperSocket()
        let grants = GrantTable()
        let seen = Seen()
        let e = started(helper, grants, seen, authTimeout: 0.5)
        screen(e, 3)
        #expect(helper.accept(timeout: 3))
        let line = try #require(helper.readLine(timeout: 3))
        guard case .hello(let h)? = try? JSONDecoder().decode(Message.self, from: Data(line.utf8)) else { Issue.record("the first line is not a hello"); return }
        #expect(h.challenge != nil && h.session == "reader-test-session")
        switch how {
        case "no proof, a grant first":
            helper.send(grantLine("t1"))
            helper.send(commandLine("c1"))
        case "a proof under another secret":
            helper.send(#"{"type":"helperAuth","v":1,"proof":"\#(HelperProof.proof(secret: Data(repeating: 7, count: 32), challenge: h.challenge!))"}"#)
            helper.send(grantLine("t1"))
            helper.send(commandLine("c1"))
        default:
            break
        }
        // The reader drops the connection; nothing more ever came on it.
        #expect(helper.readLine(timeout: 2) == nil)
        usleep(200_000)
        #expect(grants.count == 0)
        #expect(seen.commandCount == 0)
        #expect(seen.connectsSeen.isEmpty)
        #expect(!e.isAuthenticated)
    }

    @Test func aHelperThatProvesItselfGetsTheBacklogAndItsGrantsApply() throws {
        let helper = try FakeHelperSocket()
        let grants = GrantTable()
        let seen = Seen()
        let e = started(helper, grants, seen)
        screen(e, 3)
        #expect(helper.accept(timeout: 3))
        #expect(helper.authenticate() != nil)
        // The three messages waited for the proof, then came in order.
        for i in 0..<3 {
            let line = try #require(helper.readLine(timeout: 3))
            #expect(line.contains(#""changeCount":\#(i)"#))
        }
        helper.send(grantLine("t1"))
        helper.send(commandLine("c1"))
        #expect(eventually(3) { grants.count == 1 && seen.commandCount == 1 })
        #expect(seen.connectsSeen == [false])
    }

    // CodeRabbit on PR #4: before B23 the first connection never resynced, so snapshots dropped from the backlog
    // while the helper was not there were never sent.
    @Test func theFirstConnectionResyncsWhenTheBacklogDroppedMessages() throws {
        let helper = try FakeHelperSocket()
        let seen = Seen()
        let e = started(helper, GrantTable(), seen)
        #expect(helper.accept(timeout: 3))
        screen(e, 600)
        #expect(helper.authenticate() != nil)
        #expect(eventually(3) { seen.connectsSeen == [true] })
    }

    @Test func refusesASocketWhoseDirectoryOthersCanEnter() throws {
        let helper = try FakeHelperSocket(dirMode: 0o755)
        #expect(SocketPathCheck.refusal(path: helper.path)?.contains("open to other users") == true)
        let e = started(helper, GrantTable(), Seen())
        #expect(!helper.accept(timeout: 1.5))
        #expect(!e.isConnected)
    }

    @Test func checksTheProofAgainstTheGoldenLine() throws {
        // helper/fixtures/golden/protocol.ndjson lines 60 and 61: the reader's hello and the helper's answer to it.
        let challenge = Data("caret-b23-golden-challenge-32byt".utf8).base64EncodedString()
        let proof = HelperProof.proof(secret: testSecret, challenge: challenge)
        #expect(proof == "qLMQNx80wKbypKq89Bkght+jlznzuJpJcSkkQ9lbT+Q=")
        #expect(HelperProof.verify(proof, secret: testSecret, challenge: challenge))
        #expect(!HelperProof.verify(proof, secret: testSecret, challenge: HelperProof.challenge()))
        #expect(!HelperProof.verify("not base64", secret: testSecret, challenge: challenge))
    }
}
