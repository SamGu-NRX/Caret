import Darwin
import Foundation
import Testing
@testable import CaretPageProtocol

private let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
private let golden = root.appendingPathComponent("helper/fixtures/golden/page.ndjson")
private let authVector = root.appendingPathComponent("helper/fixtures/golden/page-auth.json")

private func goldenLines() throws -> [Data] {
    try String(contentsOf: golden, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
}

@Suite struct GoldenPage {
    @Test func decodesEveryLineAsTheRightMessage() throws {
        let kinds = try goldenLines().map { line -> String in
            switch try JSONDecoder().decode(PageMessage.self, from: line) {
            case .engineChallenge: "engineChallenge"
            case .engineHello: "engineHello"
            case .engineWelcome: "engineWelcome"
            case .engineReady: "engineReady"
            case .pageHello: "pageHello"
            case .pageCommand: "pageCommand"
            case .pageSnapshot: "pageSnapshot"
            case .pageResult: "pageResult"
            case .scopedActGrant: "scopedActGrant"
            case .actRevoke: "actRevoke"
            case .pagePing: "pagePing"
            case .pagePong: "pagePong"
            case .pageChunk: "pageChunk"
            }
        }
        #expect(kinds == ["engineChallenge", "engineHello", "engineWelcome", "engineReady", "pageHello",
                          "pageCommand", "pageSnapshot", "pageResult", "scopedActGrant", "pageCommand", "pageResult", "pageCommand", "pageResult",
                          "pageCommand", "pageCommand", "pageResult", "actRevoke", "pageResult", "pageResult", "pageCommand", "pageCommand", "pageResult",
                          "pagePing", "pagePong", "pageChunk", "scopedActGrant"])
    }

    @Test func readsTheScopedGrantAndTheWrite() throws {
        let lines = try goldenLines()
        guard case let .scopedActGrant(g) = try JSONDecoder().decode(PageMessage.self, from: lines[8]),
              case let .pageCommand(w) = try JSONDecoder().decode(PageMessage.self, from: lines[9]),
              case let .scopedActGrant(n) = try JSONDecoder().decode(PageMessage.self, from: lines[25]) else {
            Issue.record("lines 9, 10 and 26 are not the grants and the write"); return
        }
        #expect(g.scope == .page(engine: "e7c1a2b3c4d5", tabId: 7, frameId: 0, origin: "http://127.0.0.1:4310", navGen: 1))
        #expect(g.expires - g.at == 120_000)
        #expect(n.scope == .native(pid: 5150, windowId: "5150-7"))
        #expect(w.verb == .write(PageTarget(tabId: 7, frameId: 0, documentId: "DOC0", id: "e1", control: .text, name: "First name", taskId: "t1"), expect: "", value: "Ada"))
    }

    @Test func readsTheSnapshotAcrossFramesAndTheClosedShadowRoot() throws {
        guard case let .pageSnapshot(s) = try JSONDecoder().decode(PageMessage.self, from: try goldenLines()[6]) else { Issue.record("line 7 is not a snapshot"); return }
        #expect(s.frames.map(\.frameId) == [0, 3])
        #expect(s.frames[0].controls.first { $0.shadow == "closed" }?.name == "Badge code")
        #expect(s.frames[0].excluded == ["password": 1, "hidden": 2])
        #expect(s.focused == PageFocus(frameId: 0, id: "e1", selection: [0, 0]))
    }

    @Test func encodesVerbsBackToTheSameJSON() throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        for line in try goldenLines() {
            guard case let .pageCommand(c) = try JSONDecoder().decode(PageMessage.self, from: line) else { continue }
            let again = try JSONSerialization.jsonObject(with: enc.encode(c.verb)) as? NSDictionary
            let orig = (try JSONSerialization.jsonObject(with: line) as? [String: Any])?["verb"] as? NSDictionary
            #expect(again == orig)
        }
    }
}

@Suite struct HandshakeVector {
    @Test func agreesWithTheHelpersProofs() throws {
        let v = try JSONSerialization.jsonObject(with: Data(contentsOf: authVector)) as! [String: String]
        let secret = try #require(Data(hex: v["secret"]!))
        #expect(Handshake.bridgeProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!) == v["bridgeProof"])
        #expect(Handshake.helperProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!) == v["helperProof"])
        #expect(Handshake.matches(v["bridgeProof"]!, v["bridgeProof"]!))
        #expect(!Handshake.matches(v["bridgeProof"]!, v["helperProof"]!))
        #expect(!Handshake.matches(v["bridgeProof"]!, "zz"))
    }

    @Test func noncesAreFreshHex() {
        let a = Handshake.nonce(), b = Handshake.nonce()
        #expect(a.count == 64 && b.count == 64 && a != b)
    }
}

@Suite struct Framing {
    @Test func roundTripsThroughPartialReads() throws {
        let msgs = [Data(#"{"type":"pageHello"}"#.utf8), Data(#"{"type":"pagePong","x":"é"}"#.utf8)]
        let stream = msgs.map(NativeFrame.encode).reduce(Data(), +)
        var r = FrameReader()
        var got: [Data] = []
        for b in stream { got += try r.feed(Data([b])) }
        #expect(got == msgs)
    }

    @Test func refusesALengthPastTheCap() {
        var r = FrameReader(maxLength: 10)
        #expect(throws: FrameError.tooLong(11)) { try r.feed(NativeFrame.encode(Data(repeating: 65, count: 11))) }
    }

    @Test func chunksALongLineIntoFramesUnderOneMegabyteThatJoinBack() throws {
        let text = String(repeating: "é\"ab\u{1}", count: 300_000)
        let line = try JSONSerialization.data(withJSONObject: ["type": "pageCommand", "pad": text])
        #expect(line.count > NativeFrame.maxToExtension)
        let parts = try Chunker.payloads(for: line, id: "k1")
        #expect(parts.count > 1)
        var joined = ""
        for (i, p) in parts.enumerated() {
            #expect(p.count <= NativeFrame.maxToExtension)
            guard case let .pageChunk(c) = try JSONDecoder().decode(PageMessage.self, from: p) else { Issue.record("not a chunk"); return }
            #expect(c.index == i && c.count == parts.count && c.id == "k1")
            joined += c.data
        }
        #expect(Data(joined.utf8) == line)
    }

    @Test func passesAShortLineUnchanged() throws {
        let line = Data(#"{"type":"pagePing","v":1,"id":"p"}"#.utf8)
        #expect(try Chunker.payloads(for: line, id: "k") == [line])
    }
}

@Suite struct RelayRules {
    @Test func letsEachDirectionCarryOnlyItsOwnTypes() {
        let ok = { (s: String, d: Direction) -> Bool in if case .success = Relay.admit(Data(s.utf8), d) { true } else { false } }
        #expect(ok(#"{"type":"pageSnapshot"}"#, .toHelper))
        #expect(!ok(#"{"type":"scopedActGrant"}"#, .toHelper))
        #expect(!ok(#"{"type":"engineHello"}"#, .toHelper))
        #expect(ok(#"{"type":"scopedActGrant"}"#, .toExtension))
        #expect(!ok(#"{"type":"pageResult"}"#, .toExtension))
        #expect(!ok(#"{"type":"engineWelcome"}"#, .toExtension))
        #expect(!ok("[1]", .toHelper))
        #expect(!ok("{\"type\":\"pageHello\",\n\"x\":1}", .toHelper))
    }

    @Test func readsTheExtensionIdFromChromesOrigin() {
        #expect(Relay.extensionId(fromOrigin: "chrome-extension://kcmlnoabcdefghijklmnopabcdefghij/") == "kcmlnoabcdefghijklmnopabcdefghij")
        #expect(Relay.extensionId(fromOrigin: "chrome-extension://KCMLNOABCDEFGHIJKLMNOPABCDEFGHIJ/") == nil)
        #expect(Relay.extensionId(fromOrigin: "https://example.com/") == nil)
        #expect(Relay.extensionId(fromOrigin: "chrome-extension://zzz/") == nil)
    }
}

@Suite struct SecretAndPeer {
    private func tempDir() throws -> String {
        let d = NSTemporaryDirectory() + "caret-bridge-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return d
    }

    private func write(_ path: String, _ text: String, mode: Int) throws {
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8), attributes: [.posixPermissions: mode])
    }

    @Test func readsAPrivateSecret() throws {
        let d = try tempDir(); defer { try? FileManager.default.removeItem(atPath: d) }
        let hex = String(repeating: "ab", count: 32)
        try write(d + "/page.sock.key", hex, mode: 0o600)
        #expect(try SecretFile.read(path: d + "/page.sock.key").hex == hex)
    }

    @Test func refusesASecretOthersCouldRead() throws {
        let d = try tempDir(); defer { try? FileManager.default.removeItem(atPath: d) }
        try write(d + "/page.sock.key", String(repeating: "ab", count: 32), mode: 0o644)
        #expect(throws: PeerError.self) { try SecretFile.read(path: d + "/page.sock.key") }
    }

    @Test func refusesASymlinkedSecret() throws {
        let d = try tempDir(); defer { try? FileManager.default.removeItem(atPath: d) }
        try write(d + "/real", String(repeating: "ab", count: 32), mode: 0o600)
        try FileManager.default.createSymbolicLink(atPath: d + "/page.sock.key", withDestinationPath: d + "/real")
        #expect(throws: PeerError.self) { try SecretFile.read(path: d + "/page.sock.key") }
    }

    @Test func refusesADirectoryOthersCanWrite() throws {
        let d = try tempDir(); defer { try? FileManager.default.removeItem(atPath: d) }
        try write(d + "/page.sock.key", String(repeating: "ab", count: 32), mode: 0o600)
        chmod(d, 0o777)
        #expect(throws: PeerError.self) { try SecretFile.read(path: d + "/page.sock.key") }
    }

    @Test func refusesATruncatedSecret() throws {
        let d = try tempDir(); defer { try? FileManager.default.removeItem(atPath: d) }
        try write(d + "/page.sock.key", "abcd", mode: 0o600)
        #expect(throws: PeerError.self) { try SecretFile.read(path: d + "/page.sock.key") }
    }

    @Test func readsThePeersUidOnALocalSocket() throws {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        defer { close(fds[0]); close(fds[1]) }
        #expect(try Peer.uid(of: fds[0]) == getuid())
    }
}
