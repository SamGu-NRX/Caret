import CaretScreenCore
import Darwin
import XCTest
@testable import CaretHostCore

/// helper/fixtures/golden/host-auth.json, which helper/test/host-auth.test.ts checks against the helper's derivation:
/// the same launch secret gives the same host key and proof on both sides.
private let vectorURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/host-auth.json")

private struct Vector {
    let launchSecret: Data
    let hostKey: Data
    let nonce: String
    let proof: String
    /// hostChallenge, hostProof, hostAuthenticated, each as one NDJSON line.
    let lines: [Data]

    static func load() throws -> Vector {
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: vectorURL)) as? [String: Any])
        func hex(_ key: String) throws -> Data {
            let s = try XCTUnwrap(o[key] as? String)
            return Data(stride(from: 0, to: s.count, by: 2).map { i -> UInt8 in
                let a = s.index(s.startIndex, offsetBy: i)
                return UInt8(s[a...s.index(after: a)], radix: 16)!
            })
        }
        let lines = try XCTUnwrap(o["lines"] as? [[String: Any]]).map { try JSONSerialization.data(withJSONObject: $0) }
        return Vector(launchSecret: try hex("launchSecret"), hostKey: try hex("hostKey"), nonce: try XCTUnwrap(o["nonce"] as? String),
                      proof: try XCTUnwrap(o["proof"] as? String), lines: lines)
    }
}

final class HostAuthTests: XCTestCase {
    private func object(_ data: Data) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary) }

    func testTheHostKeyAndProofAreTheHelpersGoldenVector() throws {
        let v = try Vector.load()
        XCTAssertEqual(v.launchSecret, Data("caret-b23-golden-launch-secret!!".utf8))
        let key = HostAuth.hostKey(launchSecret: v.launchSecret)
        XCTAssertEqual(key, v.hostKey)
        XCTAssertNotEqual(key, v.launchSecret, "the key is derived, never the secret itself")
        XCTAssertEqual(HostAuth.proof(hostKey: key, nonce: v.nonce), v.proof)
        XCTAssertNotEqual(HostAuth.proof(hostKey: key, nonce: v.nonce + "x"), v.proof)
    }

    func testTheHandshakeLinesDecodeAndTheProofEncodesToItsGoldenLine() throws {
        let v = try Vector.load()
        XCTAssertEqual(try HelperInbound.decode(v.lines[0]), .hostChallenge(HostChallenge(nonce: v.nonce)))
        XCTAssertEqual(try HelperInbound.decode(v.lines[1]), .notForConsumer(type: "hostProof"), "the host's own line, echoed")
        XCTAssertEqual(try HelperInbound.decode(v.lines[2]), .hostAuthenticated)
        XCTAssertEqual(try object(NDJSON.line(HostProof(proof: v.proof))), try object(v.lines[1]))
        XCTAssertThrowsError(try HelperInbound.decode(Data(#"{"type":"hostChallenge","v":1,"nonce":"short"}"#.utf8)))
    }

    func testTheClientAnswersTheChallengeWithTheProofThenTakesTheAcceptance() throws {
        let v = try Vector.load()
        var handshake = HostHandshake(hostKey: v.hostKey)
        XCTAssertFalse(handshake.isDone)
        guard case .send(let line) = handshake.receive(.hostChallenge(HostChallenge(nonce: v.nonce))) else { return XCTFail("no proof sent") }
        XCTAssertEqual(try object(line), try object(v.lines[1]), "the golden proof line")
        XCTAssertEqual(line.last, 0x0A, "one NDJSON line")
        XCTAssertFalse(handshake.isDone)
        XCTAssertEqual(handshake.receive(.hostAuthenticated), .authenticated)
        XCTAssertTrue(handshake.isDone)
        XCTAssertEqual(handshake.receive(.unknown(type: "later")), .deliver)
        guard case .fail = handshake.receive(.hostChallenge(HostChallenge(nonce: v.nonce))) else { return XCTFail("a second challenge is not answered") }
    }

    func testTheClientClosesOnAnythingOutOfTurn() throws {
        let v = try Vector.load()
        var early = HostHandshake(hostKey: v.hostKey)
        XCTAssertEqual(early.receive(.unknown(type: "spend")), .fail(HostRefusal(.notChallenged, "the helper sent spend before its hostChallenge; it does not authenticate hosts")))
        var refused = HostHandshake(hostKey: v.hostKey)
        _ = refused.receive(.hostChallenge(HostChallenge(nonce: v.nonce)))
        XCTAssertEqual(refused.receive(.error(HelperError(at: 1, message: "the host's proof does not match"))), .fail(HostRefusal(.keyRefused, "the helper refused this host: the host's proof does not match")))
        var skipped = HostHandshake(hostKey: v.hostKey)
        XCTAssertEqual(skipped.receive(.hostAuthenticated), .fail(HostRefusal(.notChallenged, "the helper sent hostAuthenticated before its hostChallenge; it does not authenticate hosts")))
        var noSecret = HostHandshake(hostKey: v.hostKey)
        XCTAssertEqual(noSecret.receive(.error(HelperError(at: 1, message: "this helper has no launch secret"))), .fail(HostRefusal(.helloRefused, "the helper refused this host: this helper has no launch secret")))
    }

    func testAFailedHandshakeKeepsItsRefusalAndDiscardsWhatFollows() throws {
        let v = try Vector.load()
        var h = HostHandshake(hostKey: v.hostKey)
        _ = h.receive(.hostChallenge(HostChallenge(nonce: v.nonce)))
        _ = h.receive(.error(HelperError(at: 1, message: "no")))
        XCTAssertEqual(h.receive(.unknown(type: "spend")), .discard, "lines behind the refusal in the same read are dropped")
        XCTAssertEqual(h.receive(.hostAuthenticated), .discard)
        XCTAssertEqual(h.refusal?.reason, .keyRefused)
        XCTAssertFalse(h.isDone)
    }

    func testAConnectionThatClosesBeforeAcceptanceIsARefusal() throws {
        let v = try Vector.load()
        XCTAssertEqual(HostHandshake(hostKey: v.hostKey).refusal?.reason, .closed, "closed before the challenge")
        var proved = HostHandshake(hostKey: v.hostKey)
        _ = proved.receive(.hostChallenge(HostChallenge(nonce: v.nonce)))
        XCTAssertEqual(proved.refusal?.reason, .closed, "closed after the proof, before the acceptance")
        _ = proved.receive(.hostAuthenticated)
        XCTAssertNil(proved.refusal, "a drop after the acceptance is not a refusal")
        XCTAssertNil(HostHandshake(hostKey: nil).refusal, "a Caret with no key has no handshake to refuse")
    }

    func testNoKeyMeansNoHostAndNoHandshake() throws {
        var plain = HostHandshake(hostKey: nil)
        XCTAssertTrue(plain.isDone, "a Caret with no key is served as soon as it says hello")
        XCTAssertEqual(plain.receive(.unknown(type: "spend")), .deliver)
        guard case .fail = plain.receive(.hostChallenge(HostChallenge(nonce: String(repeating: "A", count: 44)))) else { return XCTFail("a challenge to a non-host is refused") }
        let hello = try object(NDJSON.line(HostHello.make(pid: 1, routing: false, host: false)))
        XCTAssertNil(hello["host"], "no host: true without a key")
        XCTAssertEqual(try object(NDJSON.line(HostHello.make(pid: 1, routing: false, host: true)))["host"] as? Bool, true)
    }

    /// helper/src/server.ts admitConsumer grants these only when the hello's host: true was proved.
    func testTheHostOnlyCapabilitiesAreTheOnesTheHelperGrantsOnlyToTheHost() {
        XCTAssertEqual(HostHello.hostOnlyCapabilities, ["routing", "fillAll", "goalPlans", "goalFiles", "localModel", "pageText", "savedAnswers"])
    }

    func testAHelloWithoutAKeyClaimsNoHostOnlyCapability() throws {
        let plain = try object(NDJSON.line(HostHello.make(pid: 1, routing: true, goalFiles: true, host: false)))
        let caps = try XCTUnwrap(plain["capabilities"] as? [String])
        XCTAssertEqual(Set(caps).intersection(HostHello.hostOnlyCapabilities), [], "none of what only the host is granted")
        XCTAssertEqual(Set(caps), [MemoryDocs.capability, HostHello.askChoicesCapability, HelperSpend.capability, HostHello.valueChecksCapability, HostHello.askScopeCapability],
                       "what any consumer may have stays")
        let host = try XCTUnwrap(try object(NDJSON.line(HostHello.make(pid: 1, routing: true, goalFiles: true, host: true)))["capabilities"] as? [String])
        XCTAssertEqual(Set(host).intersection(HostHello.hostOnlyCapabilities), HostHello.hostOnlyCapabilities.subtracting([LocalText.capability]),
                       "a host with the key claims every host-only capability it serves")
    }

    // MARK: - Refusals: retry schedule and the menu's status line

    func testRefusalsBackOffFromTwoSecondsDoublingToSixtyAndStartOverAfterAcceptance() {
        var retry = HostRetry()
        let refusal = HostRefusal(.keyRefused, "the helper refused this host: no")
        XCTAssertEqual((0..<7).map { _ in retry.refused(refusal) }, [2, 4, 8, 16, 32, 60, 60])
        retry.authenticated()
        XCTAssertEqual(retry.refused(refusal), 2, "the schedule starts over once the helper accepts this host")
        XCTAssertEqual(retry.refused(refusal), 4)
    }

    func testTheStatusLineNamesTheRefusalInPlainWordsAndClearsAfterAcceptance() {
        var retry = HostRetry()
        XCTAssertNil(retry.statusLine, "nothing to say before any refusal")
        _ = retry.refused(HostRefusal(.keyRefused, "the helper refused this host: the host's proof does not match this connection's challenge"))
        XCTAssertEqual(retry.statusLine, "Caret can't reach its helper: the helper refused Caret's key")
        _ = retry.refused(HostRefusal(.closed, "the helper closed the connection before it accepted this host"))
        XCTAssertEqual(retry.statusLine, "Caret can't reach its helper: the helper closed the connection before accepting Caret's key", "the latest refusal")
        retry.authenticated()
        XCTAssertNil(retry.statusLine)
    }

    // MARK: - CARET_HOST_KEY_FD

    private func pipePair() throws -> (read: Int32, write: Int32) {
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else { throw XCTSkip("pipe failed") }
        return (fds[0], fds[1])
    }

    private func isOpen(_ fd: Int32) -> Bool { fcntl(fd, F_GETFD) != -1 }

    func testAnAttachedCaretReadsTheKeyFromTheDescriptorOnceAndClosesIt() throws {
        let v = try Vector.load()
        let (r, w) = try pipePair()
        defer { close(w) }
        XCTAssertEqual(v.hostKey.withUnsafeBytes { write(w, $0.baseAddress, $0.count) }, 32)
        // The writer's end stays open: reading exactly 32 bytes must not wait for its end of file.
        let key = try HostAuth.readInheritedKey(environment: [HostAuth.keyDescriptorVariable: "\(r)"])
        XCTAssertEqual(key, v.hostKey)
        XCTAssertFalse(isOpen(r), "the descriptor is closed once read")
    }

    func testNoVariableMeansNoKey() throws {
        XCTAssertNil(try HostAuth.readInheritedKey(environment: [:]))
        XCTAssertNil(try HostAuth.readInheritedKey(environment: [HostAuth.keyDescriptorVariable: ""]))
    }

    func testABadDescriptorIsRefusedByName() throws {
        func refusal(_ value: String) -> String? {
            do {
                _ = try HostAuth.readInheritedKey(environment: [HostAuth.keyDescriptorVariable: value])
                return nil
            } catch {
                return "\(error)"
            }
        }
        XCTAssertEqual(refusal("2"), "CARET_HOST_KEY_FD is \"2\", not an inherited descriptor (3 and above)")
        XCTAssertEqual(refusal("three"), "CARET_HOST_KEY_FD is \"three\", not an inherited descriptor (3 and above)")
        let (r, w) = try pipePair()
        close(r)
        close(w)
        XCTAssertEqual(refusal("\(r)"), "CARET_HOST_KEY_FD names descriptor \(r), which is not open")
        let (short, end) = try pipePair()
        XCTAssertEqual(Data("12345".utf8).withUnsafeBytes { write(end, $0.baseAddress, $0.count) }, 5)
        close(end)
        XCTAssertEqual(refusal("\(short)"), "CARET_HOST_KEY_FD descriptor \(short) ended after 5 bytes; a host key is 32")
        XCTAssertFalse(isOpen(short), "closed even when refused")
    }
}
