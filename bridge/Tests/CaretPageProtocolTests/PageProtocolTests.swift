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
            case .pageFocus: "pageFocus"
            case .pageSitesOff: "pageSitesOff"
            case .pageInput: "pageInput"
            case .pageReadText: "pageReadText"
            }
        }
        #expect(kinds == ["engineChallenge", "engineHello", "engineWelcome", "engineReady", "pageHello",
                          "pageCommand", "pageSnapshot", "pageResult", "scopedActGrant", "pageCommand", "pageResult", "pageCommand", "pageResult",
                          "pageCommand", "pageCommand", "pageResult", "actRevoke", "pageResult", "pageResult", "pageCommand", "pageCommand", "pageResult",
                          "pagePing", "pagePong", "pageChunk", "scopedActGrant",
                          "pageResult", "pageResult", "pageFocus", "pageSitesOff", "pageResult",
                          "pageCommand", "pageResult", "pageInput",
                          "pageSnapshot", "pageCommand", "pageResult",
                          "pageResult",
                          "pageReadText", "pageResult", "pageReadText", "pageResult", "pageCommand", "pageResult", "pageSnapshot"])
    }

    /// P4: a read of the tab the user just left and its text; a refused read; an insert at the caret.
    @Test func readsTheP4Messages() throws {
        let lines = try goldenLines()
        guard case let .pageReadText(read) = try JSONDecoder().decode(PageMessage.self, from: lines[38]),
              case let .pageResult(res) = try JSONDecoder().decode(PageMessage.self, from: lines[39]),
              case let .pageResult(refused) = try JSONDecoder().decode(PageMessage.self, from: lines[41]),
              case let .pageCommand(ins) = try JSONDecoder().decode(PageMessage.self, from: lines[42]),
              case let .insertText(t, expect, text) = ins.verb else { Issue.record("lines 39 to 43"); return }
        #expect(read == PageReadText(v: 1, id: "r1", expires: 1_790_000_016_000, tabId: 3))
        #expect(res.id == read.id && res.outcome == .ok && res.text?.tabId == 3 && res.text?.selection == ["Cell: 555-0147"])
        #expect(res.text?.frames.map(\.frameId) == [0, 4] && res.text?.docsText == nil)
        #expect(refused.outcome == .notAllowed && refused.text == nil)
        #expect(t.control == .textarea && expect == "I am writing to apply for the " && text == "Field Robotics Technician role")
        #expect(Direction.toExtension.allowed.contains("pageReadText") && !Direction.toHelper.allowed.contains("pageReadText"))
        let again = try JSONDecoder().decode(PageVerb.self, from: JSONEncoder().encode(ins.verb))
        #expect(again == ins.verb)
    }

    /// B28: a Yes/No press after which the page left: failed, no readings, and what showed the change.
    @Test func readsTheB28Message() throws {
        let lines = try goldenLines()
        guard case let .pageResult(res) = try JSONDecoder().decode(PageMessage.self, from: lines[37]) else { Issue.record("line 38 is not a pageResult"); return }
        #expect(res.outcome == .failed && res.readings == nil && res.choice?.flavor == .pressGroup)
        #expect(res.pageChanged == ["navigationStarted", "beforeunload"])
        let again = try JSONDecoder().decode(PageResult.self, from: JSONEncoder().encode(res))
        #expect(again == res)
    }

    /// W4: a radio group's question, a press group's options, and the press that names its question.
    @Test func readsTheW4Messages() throws {
        let lines = try goldenLines()
        guard case let .pageSnapshot(snap) = try JSONDecoder().decode(PageMessage.self, from: lines[34]),
              case let .pageCommand(cmd) = try JSONDecoder().decode(PageMessage.self, from: lines[35]),
              case let .chooseOption(t, expect, value, question) = cmd.verb,
              case let .pageResult(res) = try JSONDecoder().decode(PageMessage.self, from: lines[36]) else { Issue.record("lines 35 to 37"); return }
        let controls = snap.frames[0].controls
        #expect(controls[0].group == PageGroup(id: "e20", name: "Are you authorized to work here?"))
        #expect(controls[2].pressed == false && controls[3].pressed == true)
        #expect(t.control == .button && expect == "No" && value == "Yes" && question == "Do you have seven years of experience?")
        #expect(res.choice?.flavor == .pressGroup)
        let again = try JSONDecoder().decode(PageVerb.self, from: JSONEncoder().encode(cmd.verb))
        #expect(again == cmd.verb)
    }

    /// W3: an undo's verb carries rebind false and is refused as notSameElement; the user's input; the focused-window flag.
    @Test func readsTheW3Messages() throws {
        let lines = try goldenLines()
        guard case let .pageCommand(undo) = try JSONDecoder().decode(PageMessage.self, from: lines[31]),
              case let .write(t, expect, value) = undo.verb else { Issue.record("line 32 is not an undo write"); return }
        #expect(t.rebind == false && t.sameAs == "m1" && t.mark == nil && expect == "Ada" && value == "")
        guard case let .pageResult(refused) = try JSONDecoder().decode(PageMessage.self, from: lines[32]),
              case let .pageInput(input) = try JSONDecoder().decode(PageMessage.self, from: lines[33]),
              case let .pageSnapshot(snap) = try JSONDecoder().decode(PageMessage.self, from: lines[6]) else { Issue.record("lines 33, 34 and 7"); return }
        #expect(refused.outcome == .notSameElement)
        #expect(input == PageInput(v: 1, at: 1_790_000_004_500, tabId: 7, frameId: 0, kind: .mouse))
        #expect(snap.inFocusedWindow)
        #expect(Direction.toHelper.allowed.contains("pageInput") && !Direction.toExtension.allowed.contains("pageInput"))
        // Only false travels; a verb that says rebind true is not a page verb.
        let bad = String(decoding: lines[31], as: UTF8.self).replacingOccurrences(of: "\"rebind\":false", with: "\"rebind\":true")
        #expect(throws: (any Error).self) { try JSONDecoder().decode(PageMessage.self, from: Data(bad.utf8)) }
        // Encoding keeps rebind, so a round trip is lossless.
        let again = try JSONDecoder().decode(PageVerb.self, from: JSONEncoder().encode(undo.verb))
        #expect(again == undo.verb)
    }

    /// W2: the combobox pick and its ambiguous stop, the attach with its bytes, focus, Not on this site.
    @Test func readsTheW2Messages() throws {
        let lines = try goldenLines()
        guard case let .pageCommand(attach) = try JSONDecoder().decode(PageMessage.self, from: lines[20]),
              case let .attachFile(_, file) = attach.verb else { Issue.record("line 21 is not the attach"); return }
        #expect(file.size == 9 && Data(base64Encoded: file.data) == Data("%PDF-1.4\n".utf8))
        guard case let .pageResult(attached) = try JSONDecoder().decode(PageMessage.self, from: lines[21]) else { Issue.record("line 22 is not a result"); return }
        #expect(attached.attached == PageAttached(via: .input, file: .init(name: "resume.pdf", size: 9), shown: true))
        guard case let .pageResult(both) = try JSONDecoder().decode(PageMessage.self, from: lines[27]) else { Issue.record("line 28 is not a result"); return }
        #expect(both.outcome == .failed && both.choice?.matches == ["United States", "United States Minor Outlying Islands"] && both.choice?.hiddenInput == .unchanged)
        guard case let .pageFocus(f) = try JSONDecoder().decode(PageMessage.self, from: lines[28]),
              case let .pageSitesOff(off) = try JSONDecoder().decode(PageMessage.self, from: lines[29]),
              case let .pageResult(siteOff) = try JSONDecoder().decode(PageMessage.self, from: lines[30]) else { Issue.record("lines 29 to 31 are not focus, sites off and siteOff"); return }
        #expect(f.tabId == 7 && f.frameId == 0)
        #expect(off.origins == ["http://127.0.0.1:4310", "https://jobs.example.test"])
        #expect(siteOff.outcome == .siteOff)
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
        // W2: the page's own autocomplete field name rides on the control; a control with none has no key.
        #expect(s.frames[0].controls.map(\.autocomplete) == ["given-name", nil, nil, nil, nil])
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
        #expect(Handshake.bridgeProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!, helperPid: Int(v["helperPid"]!)!) == v["bridgeProof"])
        #expect(Handshake.bridgeProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!, helperPid: Int(v["helperPid"]!)! + 1) != v["bridgeProof"])
        let pid = try #require(Int(v["helperPid"]!))
        #expect(Handshake.helperProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!, pid: pid) == v["helperProof"])
        // Another pid gives another proof: a relay's peer pid cannot reuse the helper's answer.
        #expect(Handshake.helperProof(secret: secret, challenge: v["challenge"]!, nonce: v["bridgeNonce"]!, pid: pid + 1) != v["helperProof"])
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
        #expect(ok(#"{"type":"pageFocus"}"#, .toHelper) && !ok(#"{"type":"pageFocus"}"#, .toExtension))
        #expect(ok(#"{"type":"pageSitesOff"}"#, .toExtension) && !ok(#"{"type":"pageSitesOff"}"#, .toHelper))
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

@Suite struct Peers {
    @Test func readsThePeersUidOnALocalSocket() throws {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        defer { close(fds[0]); close(fds[1]) }
        #expect(try Peer.uid(of: fds[0]) == getuid())
        #expect(try Peer.pid(of: fds[0]) == getpid())
    }

    /// W3: the page key both the helper and the host derive from the launch secret, never a file (auth.ts pageKey).
    @Test func derivesThePageKeyAsTheHelperDoes() throws {
        let v = try JSONSerialization.jsonObject(with: Data(contentsOf: authVector)) as? [String: Any]
        guard let launch = (v?["launchSecret"] as? String).flatMap({ Data(hex: $0) }), let key = v?["secret"] as? String else {
            Issue.record("page-auth.json has no launchSecret and secret"); return
        }
        #expect(Handshake.pageKey(launchSecret: launch).hex == key)
    }
}
