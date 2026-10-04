import Foundation
import Testing
@testable import CaretScreenCore

/// helper/fixtures/golden/protocol.ndjson, written against the zod schemas in helper/src/protocol.ts.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func goldenLines() throws -> [Data] {
    let text = try String(contentsOf: goldenURL, encoding: .utf8)
    return text.split(separator: "\n").map { Data($0.utf8) }
}

@Suite struct GoldenProtocol {
    @Test func decodesEveryLineAsTheRightMessage() throws {
        let decoded = try goldenLines().map { try JSONDecoder().decode(Message.self, from: $0) }
        let kinds = decoded.map { m -> String in
            switch m {
            case .hello: "hello"
            case .snapshot: "snapshot"
            case .focus: "focus"
            case .appSwitch: "appSwitch"
            case .windowClosed: "windowClosed"
            case .pasteboard: "pasteboard"
            case .fillRequest: "fillRequest"
            case .fillProposal: "fillProposal"
            case .error: "error"
            case .readerCommand: "readerCommand"
            case .verbResult: "verbResult"
            case .userInput: "userInput"
            case .taskProgress: "taskProgress"
            case .fillResult: "fillResult"
            case .taskControl: "taskControl"
            case .activityRequest: "activityRequest"
            case .activity: "activity"
            case .activityReply: "activityReply"
            case .alternatives: "alternatives"
            case .action: "action"
            case .popup: "popup"
            case .offerAccept: "offerAccept"
            case .offerStop: "offerStop"
            case .offerWithdrawn: "offerWithdrawn"
            case .settings: "settings"
            case .actGrant: "actGrant"
            case .actRevoke: "actRevoke"
            case .planRequest: "planRequest"
            case .planProposal: "planProposal"
            case .calendarGrant: "calendarGrant"
            case .skillOffer: "skillOffer"
            case .skillAnswer: "skillAnswer"
            case .memoryReply: "memoryReply"
            case .userPress: "userPress"
            case .helperAuth: "helperAuth"
            }
        }
        #expect(kinds == ["hello", "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard", "fillRequest", "fillProposal", "error",
                          "readerCommand", "verbResult", "userInput", "taskProgress",
                          "readerCommand", "fillResult", "taskControl", "activityRequest", "activity", "activityReply",
                          "alternatives", "action", "popup", "offerAccept", "offerStop", "offerWithdrawn", "readerCommand",
                          "offerWithdrawn", "taskControl", "taskProgress", "taskProgress", "offerWithdrawn",
                          "settings", "settings", "offerWithdrawn",
                          "actGrant", "readerCommand", "verbResult", "actRevoke",
                          "planRequest", "planProposal", "planProposal",
                          "readerCommand", "verbResult", "verbResult", "taskProgress", "calendarGrant",
                          "skillOffer", "skillAnswer", "memoryReply", "skillOffer", "skillAnswer", "taskProgress", "taskProgress",
                          "readerCommand", "userPress",
                          "planRequest", "planProposal", "userPress",
                          "skillOffer",
                          "hello", "helperAuth", "hello", "readerCommand", "verbResult", "readerCommand", "verbResult"])
    }

    @Test func readsB23sHelloFieldsProofMarksAndRefusals() throws {
        let lines = try goldenLines()
        guard case .hello(let reader) = try JSONDecoder().decode(Message.self, from: lines[59]),
              case .helperAuth(let auth) = try JSONDecoder().decode(Message.self, from: lines[60]),
              case .hello(let host) = try JSONDecoder().decode(Message.self, from: lines[61]),
              case .readerCommand(let write) = try JSONDecoder().decode(Message.self, from: lines[62]),
              case .verbResult(let moved) = try JSONDecoder().decode(Message.self, from: lines[63]),
              case .readerCommand(let restore) = try JSONDecoder().decode(Message.self, from: lines[64]),
              case .verbResult(let notSame) = try JSONDecoder().decode(Message.self, from: lines[65]) else { Issue.record("lines 60 to 66 are not B23's"); return }
        #expect(reader.session == "reader-3f9a6c21d4e8" && reader.challenge != nil && !reader.host)
        #expect(HelperProof.verify(auth.proof, secret: Data("caret-b23-golden-launch-secret!!".utf8), challenge: reader.challenge!))
        #expect(host.host && host.role == .consumer && host.session == nil)
        guard case let .write(_, _, _, _, _, _, _, _, mark) = write.verb, case let .write(_, _, _, _, _, _, _, _, same) = restore.verb else { Issue.record("not writes"); return }
        #expect(mark == .mark("8f14e45f-ceea-467f-a0e6-1c2b3d4e5f60"))
        #expect(same == .sameAs("8f14e45f-ceea-467f-a0e6-1c2b3d4e5f60"))
        #expect(moved.outcome == .focusMoved && notSame.outcome == .notSameElement)
        // Each field belongs to one role, host is never false, and a write records a mark or checks one, not both.
        let text = String(decoding: lines[62], as: UTF8.self)
        for bad in [
            String(decoding: lines[59], as: UTF8.self).replacingOccurrences(of: #""role":"reader""#, with: #""role":"consumer""#),
            String(decoding: lines[61], as: UTF8.self).replacingOccurrences(of: #""role":"consumer""#, with: #""role":"reader""#),
            String(decoding: lines[61], as: UTF8.self).replacingOccurrences(of: #""host":true"#, with: #""host":false"#),
            text.replacingOccurrences(of: #""mark":"#, with: #""sameAs":"x","mark":"#),
            text.replacingOccurrences(of: #""mark":"8f14e45f-ceea-467f-a0e6-1c2b3d4e5f60""#, with: #""mark":"""#),
        ] {
            #expect(throws: (any Error).self, "\(bad.prefix(90))") { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
        // The host's four-argument hello still encodes as before B23: no host, session or challenge.
        let old = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Message.hello(Hello(role: .consumer, mode: .live, pid: 1, version: "v")))) as! [String: Any]
        #expect(Set(old.keys) == ["type", "v", "role", "mode", "pid", "version"])
    }

    // CodeRabbit on PR #4: zod's max(80) counts UTF-16 units, as Swift must; String.count counts grapheme clusters.
    @Test func countsASkillNameInUTF16UnitsAsZodDoes() throws {
        let line = String(decoding: try goldenLines()[46], as: UTF8.self)
        guard case .skillOffer(let offer) = try JSONDecoder().decode(Message.self, from: Data(line.utf8)) else { Issue.record("line 47 is not a skillOffer"); return }
        // 17 people at laptops: 17 grapheme clusters, 85 UTF-16 units.
        let long = String(repeating: "\u{1F469}\u{200D}\u{1F4BB}", count: 17)
        #expect(long.count == 17 && long.utf16.count == 85)
        let bad = line.replacingOccurrences(of: #""name":"\#(offer.name)""#, with: #""name":"\#(long)""#)
        #expect(bad != line)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
    }

    @Test func readsThePressWatch() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let cmd) = try JSONDecoder().decode(Message.self, from: lines[53]),
              case .userPress(let press) = try JSONDecoder().decode(Message.self, from: lines[54]) else { Issue.record("lines 54 and 55 are not the press watch"); return }
        #expect(cmd.verb == .watchPresses(windows: [WatchedWindow(pid: 5150, windowId: "5150-7")]))
        #expect(cmd.verb.taskId == nil)
        #expect(press == UserPress(at: 1_790_000_601_200, pid: 5150, windowId: "5150-7", key: "dev.caret.fixture/standard/button:send~0", role: "AXButton", label: "Send", via: .click))
        let noKey = Data(#"{"type":"userPress","v":1,"at":1,"pid":1,"windowId":"1-1","key":null,"role":"AXButton","label":"Send","via":"click"}"#.utf8)
        guard case .userPress(let unkeyed) = try JSONDecoder().decode(Message.self, from: noKey) else { Issue.record("a press with a null key does not decode"); return }
        #expect(unkeyed.key == nil)
        let missing = Data(#"{"type":"userPress","v":1,"at":1,"pid":1,"windowId":"1-1","role":"AXButton","label":"Send","via":"click"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: missing) }
        // B21: a press by key, and how a press was made is required.
        guard case .userPress(let byKey) = try JSONDecoder().decode(Message.self, from: lines[57]) else { Issue.record("line 58 is not a userPress"); return }
        #expect(byKey == UserPress(at: 1_790_000_800_400, pid: 5150, windowId: "5150-7", key: "dev.caret.fixture/standard/button:send~0", role: "AXButton", label: "Send", via: .return))
        let line = String(decoding: lines[57], as: UTF8.self)
        for bad in [line.replacingOccurrences(of: #","via":"return""#, with: ""), line.replacingOccurrences(of: #""via":"return""#, with: #""via":"tab""#)] {
            #expect(bad != line)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
    }

    @Test func reencodesEveryLineToTheSameJSON() throws {
        for line in try goldenLines() {
            let m = try JSONDecoder().decode(Message.self, from: line)
            let again = try NDJSON.encoder().encode(m)
            let a = try JSONSerialization.jsonObject(with: line) as! NSDictionary
            let b = try JSONSerialization.jsonObject(with: again) as! NSDictionary
            #expect(a == b, "round trip changed: \(String(decoding: line, as: UTF8.self).prefix(80))")
        }
    }

    @Test func readsSnapshotDetails() throws {
        let lines = try goldenLines()
        guard case .snapshot(let s) = try JSONDecoder().decode(Message.self, from: lines[1]) else {
            Issue.record("line 2 is not a snapshot"); return
        }
        #expect(s.root == nil)
        #expect(s.window.frame == Frame(x: 40, y: 60, width: 520, height: 420))
        let email = try #require(s.nodes.first { $0.role == "AXTextField" && $0.subrole == nil })
        #expect(email.editable)
        #expect(email.states == [.focused])
        #expect(s.nodes.first { $0.subrole == "AXSecureTextField" }?.value == nil)
        #expect(s.values == [TypedValue(kind: .id, text: "ORD-2026-48213", nodeKey: "dev.caret.fixture/standard/statictext:order ord-#-#~0")])
    }

    @Test func readsAReaderCommand() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[9]) else {
            Issue.record("line 10 is not a readerCommand"); return
        }
        guard case let .write(pid, _, _, role, attribute, expect, value, taskId, _) = c.verb else { Issue.record("not a write"); return }
        #expect(pid == 5150 && role == "AXTextField" && attribute == "value" && expect == "" && value == "dana.whitfield@example.com")
        #expect(taskId == nil)
        let badVerb = Data(#"{"type":"readerCommand","v":1,"id":"x","verb":{"kind":"type","pid":1}}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: badVerb) }
    }

    @Test func readsTheActivityFeedAndWatchCommand() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[13]),
              case let .watchWindows(windows) = c.verb else { Issue.record("line 14 is not a watchWindows command"); return }
        #expect(windows == [WatchedWindow(pid: 5150, windowId: "5150-4")])
        guard case .activity(let a) = try JSONDecoder().decode(Message.self, from: lines[17]) else { Issue.record("line 18 is not an activity"); return }
        #expect(a.from == .running && a.task.state == .needsYou && a.task.kind == .watch && a.task.cause == .screen)
        #expect(a.task.pending?.waiting == PendingAnswer(choice: "yes", confidence: 0.97))
        guard case .activityReply(let r) = try JSONDecoder().decode(Message.self, from: lines[18]) else { Issue.record("line 19 is not an activityReply"); return }
        #expect(r.tasks.first?.step == 2 && r.tasks.first?.remaining.count == 2 && r.tasks.first?.pending == nil)
        guard case .fillProposal(let p) = try JSONDecoder().decode(Message.self, from: lines[7]) else { Issue.record("line 8 is not a fillProposal"); return }
        #expect(p.pid == 5150 && p.fields.compactMap(\.source).allSatisfy { $0.pid == 5150 })
        #expect(p.fields.last?.memory == FillMemory(id: "about-9f8e7d6c", label: "Name", says: "what you told Caret") && p.fields.last?.source == nil)
        let badState = Data(#"{"type":"taskControl","v":1,"taskId":"t","action":"cancel"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: badState) }
    }

    @Test func readsAFieldWithheldBecauseACutTookItsKind() throws {
        let unasked = Data(#"{"key":"k","frame":null,"descriptor":"Text field. Label: 'Date'.","choice":"none","confidence":0,"value":null,"source":null,"withheld":"sourceCut","asks":[]}"#.utf8)
        let f = try JSONDecoder().decode(FillField.self, from: unasked)
        #expect(f.withheld == .sourceCut && f.asks.isEmpty && f.value == nil)
        let oneAsk = Data(#"{"key":"k","frame":null,"descriptor":"d","choice":"none","confidence":0,"value":null,"source":null,"withheld":null,"asks":[{"choice":"none","confidence":0.9,"value":null}]}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(FillField.self, from: oneAsk) }
    }

    @Test func readsAValueFromMemoryAndRefusesOneWithTwoOrNoSources() throws {
        let memory = #"{"id":"about-1","label":"Email","says":"what you told Caret"}"#
        let source = #"{"pid":1,"windowId":"1-1","bundleId":"b","appName":"A","windowTitle":"T","nodeKey":"n","kind":"email"}"#
        func field(value: String, source: String, memory: String) -> Data {
            Data(#"{"key":"k","frame":null,"descriptor":"d","choice":"m1","confidence":0.9,"value":\#(value),"source":\#(source),"memory":\#(memory),"withheld":null,"asks":[]}"#.utf8)
        }
        let f = try JSONDecoder().decode(FillField.self, from: field(value: #""a@b.example""#, source: "null", memory: memory))
        #expect(f.memory?.says == "what you told Caret" && f.source == nil)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(FillField.self, from: field(value: #""a@b.example""#, source: source, memory: memory)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(FillField.self, from: field(value: #""a@b.example""#, source: "null", memory: "null")) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(FillField.self, from: field(value: "null", source: "null", memory: memory)) }
    }

    @Test func readsTheHostSettingsAndTheirWithdrawal() throws {
        let lines = try goldenLines()
        guard case .settings(let all) = try JSONDecoder().decode(Message.self, from: lines[31]),
              case .settings(let quiet) = try JSONDecoder().decode(Message.self, from: lines[32]) else { Issue.record("lines 32 and 33 are not settings"); return }
        // The host's balanced settings as v2/host sends them since A13: every role, the calendar among them.
        #expect(all == GateSettings(at: 1_790_000_130_000, roles: [.fill, .repeat, .watch, .calendar, .words], level: .balanced, paused: false))
        let calendar = Data(#"{"type":"settings","v":1,"at":1,"roles":["fill","calendar"],"level":"eager","paused":false}"#.utf8)
        guard case .settings(let withCalendar) = try JSONDecoder().decode(Message.self, from: calendar) else { Issue.record("a settings message with the calendar role does not decode"); return }
        #expect(withCalendar.roles == [.fill, .calendar])
        #expect(quiet.roles == [.watch] && quiet.level == .quiet && quiet.paused)
        guard case .offerWithdrawn(let gone) = try JSONDecoder().decode(Message.self, from: lines[33]) else { Issue.record("line 34 is not an offerWithdrawn"); return }
        #expect(gone.reason == .settings)
        let twice = Data(#"{"type":"settings","v":1,"at":1,"roles":["fill","fill"],"level":"eager","paused":false}"#.utf8)
        let ghost = Data(#"{"type":"settings","v":1,"at":1,"roles":["ghost"],"level":"eager","paused":false}"#.utf8)
        let loud = Data(#"{"type":"settings","v":1,"at":1,"roles":[],"level":"loud","paused":false}"#.utf8)
        let noPause = Data(#"{"type":"settings","v":1,"at":1,"roles":[],"level":"quiet"}"#.utf8)
        for bad in [twice, ghost, loud, noPause] {
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: bad) }
        }
    }

    @Test func readsExpiryPauseReasonAndTaskFrames() throws {
        let lines = try goldenLines()
        guard case .offerWithdrawn(let gone) = try JSONDecoder().decode(Message.self, from: lines[26]) else { Issue.record("line 27 is not an offerWithdrawn"); return }
        #expect(gone.id == "offer-4" && gone.reason == .expired)
        guard case .taskControl(let pause) = try JSONDecoder().decode(Message.self, from: lines[27]) else { Issue.record("line 28 is not a taskControl"); return }
        #expect(pause == TaskControl(taskId: "task-1", action: .pause, reason: .input))
        guard case .taskControl(let takeOver) = try JSONDecoder().decode(Message.self, from: lines[15]) else { Issue.record("line 16 is not a taskControl"); return }
        #expect(takeOver.reason == nil)
        let longId = Data(#"{"type":"activityRequest","v":1,"requestId":"\#(String(repeating: "r", count: 201))","op":"list"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: longId) }
        let nullReason = Data(#"{"type":"taskControl","v":1,"taskId":"t","action":"pause","reason":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: nullReason) }
        guard case .activity(let a) = try JSONDecoder().decode(Message.self, from: lines[17]) else { Issue.record("line 18 is not an activity"); return }
        #expect(a.task.frame == Frame(x: 640, y: 120, width: 520, height: 380))
        #expect(a.task.says == "'Upload' in Caret Fixture is waiting for you")
        guard case .activityReply(let r) = try JSONDecoder().decode(Message.self, from: lines[18]) else { Issue.record("line 19 is not an activityReply"); return }
        #expect(r.tasks.allSatisfy { $0.frame == Frame(x: 40, y: 60, width: 520, height: 420) })
        let line = String(decoding: lines[17], as: UTF8.self).replacingOccurrences(of: #""frame":[640,120,520,380],"#, with: "")
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(line.utf8)) }
    }

    @Test func readsWindowIdentitySourceAppsAndCounts() throws {
        let lines = try goldenLines()
        guard case .snapshot(let s) = try JSONDecoder().decode(Message.self, from: lines[1]) else { Issue.record("line 2 is not a snapshot"); return }
        #expect(s.window.number == 4417)
        guard case .alternatives(let alt) = try JSONDecoder().decode(Message.self, from: lines[19]) else { Issue.record("line 20 is not alternatives"); return }
        #expect(alt.field.window == OfferWindow(number: 4421, title: "Seating"))
        guard case .popup(let popup) = try JSONDecoder().decode(Message.self, from: lines[21]) else { Issue.record("line 22 is not a popup"); return }
        #expect(popup.field.window == OfferWindow(number: nil, title: "Checkout") && popup.sourceApps == ["Mail Fixture"])
        guard case .taskProgress(let done) = try JSONDecoder().decode(Message.self, from: lines[28]),
              case .taskProgress(let undone) = try JSONDecoder().decode(Message.self, from: lines[29]) else { Issue.record("lines 29 and 30 are not taskProgress"); return }
        #expect(done.phase == .done && done.written == 3 && done.restored == nil)
        #expect(undone.phase == .undone && undone.restored == 2 && undone.notRestored == 1 && undone.notUndoablePresses == 0)
        #expect(done.stopReason == nil && undone.stopReason == nil)
        let text = String(decoding: lines[21], as: UTF8.self)
        for bad in [#""sourceApps":[]"#, #""sourceApps":["Mail Fixture","Mail Fixture"]"#] {
            let line = text.replacingOccurrences(of: #""sourceApps":["Mail Fixture"]"#, with: bad)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(line.utf8)) }
        }
        let noWindow = String(decoding: lines[19], as: UTF8.self).replacingOccurrences(of: #","window":{"number":4421,"title":"Seating"}"#, with: "")
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(noWindow.utf8)) }
    }

    /// B14: a stopped taskProgress says why in stopReason, and no other phase may carry one; protocol.test.ts checks the same.
    @Test func readsTheStopReason() throws {
        let lines = try goldenLines()
        guard case .taskProgress(let stopped) = try JSONDecoder().decode(Message.self, from: lines[12]) else { Issue.record("line 13 is not taskProgress"); return }
        #expect(stopped.phase == .stopped && stopped.stopReason == .changed)
        let text = String(decoding: lines[12], as: UTF8.self)
        let done = String(decoding: lines[28], as: UTF8.self)
        for bad in [
            text.replacingOccurrences(of: #","stopReason":"changed""#, with: ""),
            text.replacingOccurrences(of: #""stopReason":"changed""#, with: #""stopReason":"timeout""#),
            text.replacingOccurrences(of: #""stopReason":"changed""#, with: #""stopReason":null"#),
            text.replacingOccurrences(of: #""phase":"stopped""#, with: #""phase":"handoff""#),
            done.replacingOccurrences(of: #","written":3"#, with: #","written":3,"stopReason":"you""#),
        ] {
            #expect(bad != text && bad != done)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
    }

    @Test func readsTheOfferMessagesAndRaise() throws {
        let lines = try goldenLines()
        guard case .alternatives(let alt) = try JSONDecoder().decode(Message.self, from: lines[19]) else { Issue.record("line 20 is not alternatives"); return }
        #expect(alt.quoted && alt.candidates.map(\.text) == ["Cara Diaz", "Cal Duarte"])
        #expect(alt.field.frame == Frame(x: 120, y: 288, width: 180, height: 22))
        #expect(alt.candidates[0].ref == .node(key: "5150-1/dev.caret.fixture/standard/statictext:cara diaz~0", quote: "Cara Diaz"))

        guard case .action(let line) = try JSONDecoder().decode(Message.self, from: lines[20]) else { Issue.record("line 21 is not an action"); return }
        #expect(line.app == "Sheet Fixture" && line.actions.map(\.key) == [.tab])
        guard case .derived(let rule, let from) = line.endState.ref else { Issue.record("endState is not derived"); return }
        #expect(rule == "loopFinish" && from.count == 2)
        let variants = try #require(line.variants)
        #expect(variants.figure == .needsYou)
        let source = try #require(variants.blocks.first { if case .choices = $0.content { true } else { false } })
        #expect(source.id == "source")
        #expect(variants.choices?.rows.map(\.label.text) == ["Caret Fixture", "Mail Fixture"])
        #expect(variants.choices?.rows.map { $0.hint?.text } == ["Dev Patel", nil])

        guard case .popup(let popup) = try JSONDecoder().decode(Message.self, from: lines[21]) else { Issue.record("line 22 is not a popup"); return }
        #expect(popup.offerKey == "fill-2" && popup.spec.id == "fill-2" && popup.spec.header?.title.text == "Fill 2 fields")
        guard case .fields(let fields)? = popup.spec.blocks.first(where: { $0.content.typeName == "fields" })?.content else {
            Issue.record("the popup has no fields block"); return
        }
        #expect(fields.rows.map(\.destination.text) == ["Email", "Phone"])
        #expect(fields.rows.map { $0.value?.text } == ["dana.whitfield@example.com", "+1 512 555 0142"])
        #expect(fields.rows.map(\.state) == [.ready, .ready] && fields.more == 0)

        guard case .offerAccept(let accept) = try JSONDecoder().decode(Message.self, from: lines[22]) else { Issue.record("line 23 is not an offerAccept"); return }
        #expect(accept == OfferAccept(offerId: "offer-5", actionId: "finish", overrides: ["variants": 1], at: 1_790_000_002_300))
        guard case .offerStop(let stop) = try JSONDecoder().decode(Message.self, from: lines[23]) else { Issue.record("line 24 is not an offerStop"); return }
        #expect(stop.offerId == "offer-5")
        guard case .offerWithdrawn(let gone) = try JSONDecoder().decode(Message.self, from: lines[24]) else { Issue.record("line 25 is not an offerWithdrawn"); return }
        #expect(gone.id == "offer-4.0" && gone.reason == .taken)
        guard case .readerCommand(let raise) = try JSONDecoder().decode(Message.self, from: lines[25]) else { Issue.record("line 26 is not a readerCommand"); return }
        #expect(raise.verb == .raise(pid: 5150, windowId: "5150-4", taskId: nil) && raise.expires == 1_790_000_007_600)
    }

    /// Optional keys stay out of the encoding when absent, and a null where zod wants the key left out is refused.
    @Test func offerOptionalsAndNullables() throws {
        let field = OfferField(pid: 1, windowId: "1-1", key: "k", frame: nil, window: OfferWindow(number: nil, title: "T"))
        let line = OfferAction(offerKey: "o", at: 1, field: field, app: "App", endState: PopupSpec.Value("x", ref: .memory(id: "m")),
                               actions: [PopupSpec.Action(id: "go", label: "Go", key: .tab)])
        let obj = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Message.action(line))) as! [String: Any]
        #expect(obj["variants"] == nil)
        #expect((obj["field"] as? [String: Any])?["frame"] is NSNull)
        let nullVariants = Data(#"{"type":"action","v":1,"offerKey":"o","at":1,"field":{"pid":1,"windowId":"w","key":"k","frame":null},"app":"A","endState":{"text":"x","ref":{"memory":"m"}},"actions":[{"id":"go","label":"Go","key":"tab"}],"variants":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: nullVariants) }
        let negativeRow = Data(#"{"type":"offerAccept","v":1,"offerId":"o","actionId":"a","overrides":{"choices":-1},"at":1}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: negativeRow) }
        let badReason = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"o","reason":"timedOut"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: badReason) }
        let reofferedBare = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"o","reason":"reoffered"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: reofferedBare) }
        let staleReplaced = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"o","reason":"stale","replacedBy":"p"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: staleReplaced) }
        let nullReplaced = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"o","reason":"reoffered","replacedBy":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: nullReplaced) }
        let lines = try goldenLines()
        guard case .offerWithdrawn(let reoffered) = try JSONDecoder().decode(Message.self, from: lines[30]) else { Issue.record("line 31 is not an offerWithdrawn"); return }
        #expect(reoffered == OfferWithdrawn(at: 1_790_000_124_000, id: "offer-5", reason: .reoffered, replacedBy: "offer-6"))
    }

    /// B15: the act grant, a write that names its task, the refusal, and the revoke; protocol.test.ts checks the same.
    @Test func readsTheActGrant() throws {
        let lines = try goldenLines()
        guard case .actGrant(let g) = try JSONDecoder().decode(Message.self, from: lines[34]) else { Issue.record("line 35 is not an actGrant"); return }
        #expect(g == ActGrant(taskId: "offer-5", pid: 5150, windowId: "5150-1", at: 1_790_000_140_000, expires: 1_790_000_260_000))
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[35]) else { Issue.record("line 36 is not a readerCommand"); return }
        #expect(c.verb.taskId == "offer-5")
        guard case .verbResult(let r) = try JSONDecoder().decode(Message.self, from: lines[36]) else { Issue.record("line 37 is not a verbResult"); return }
        #expect(r.outcome == .notAllowed)
        guard case .actRevoke(let rv) = try JSONDecoder().decode(Message.self, from: lines[37]) else { Issue.record("line 38 is not an actRevoke"); return }
        #expect(rv == ActRevoke(taskId: "offer-5", at: 1_790_000_141_000))
        let grant = String(decoding: lines[34], as: UTF8.self)
        let write = String(decoding: lines[35], as: UTF8.self)
        for bad in [
            grant.replacingOccurrences(of: #""expires":1790000260000"#, with: #""expires":1790000260001"#),
            grant.replacingOccurrences(of: #""expires":1790000260000"#, with: #""expires":1790000140000"#),
            grant.replacingOccurrences(of: #""taskId":"offer-5""#, with: #""taskId":"""#),
            grant.replacingOccurrences(of: #""windowId":"5150-1","#, with: ""),
            write.replacingOccurrences(of: #""taskId":"offer-5""#, with: #""taskId":null"#),
            write.replacingOccurrences(of: #""taskId":"offer-5""#, with: #""taskId":"""#),
        ] {
            #expect(bad != grant && bad != write)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
        let insert = write.replacingOccurrences(of: #""attribute":"value""#, with: #""attribute":"insert""#)
        guard case .readerCommand(let ins) = try JSONDecoder().decode(Message.self, from: Data(insert.utf8)),
              case let .write(_, _, _, _, attribute, _, _, _, _) = ins.verb else { Issue.record("an insert write does not decode"); return }
        #expect(attribute == "insert")
        let focusValue = write.replacingOccurrences(of: #""attribute":"value""#, with: #""attribute":"focusValue""#)
        guard case .readerCommand(let fv) = try JSONDecoder().decode(Message.self, from: Data(focusValue.utf8)),
              case let .write(_, _, _, _, fvAttribute, _, _, _, _) = fv.verb else { Issue.record("a focusValue write does not decode"); return }
        #expect(fvAttribute == "focusValue")
        let paste = write.replacingOccurrences(of: #""attribute":"value""#, with: #""attribute":"paste""#)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(paste.utf8)) }
        let bare = write.replacingOccurrences(of: #","taskId":"offer-5""#, with: "")
        guard case .readerCommand(let noTask) = try JSONDecoder().decode(Message.self, from: Data(bare.utf8)) else { Issue.record("a write without taskId does not decode"); return }
        #expect(noTask.verb.taskId == nil)
        let again = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Message.readerCommand(noTask))) as! [String: Any]
        #expect((again["verb"] as? [String: Any])?["taskId"] == nil)
    }

    /// B21: a planRequest naming its window as a host knows it, and the error for a window the reader has not read.
    @Test func readsThePlanWindow() throws {
        let lines = try goldenLines()
        guard case .planRequest(let req) = try JSONDecoder().decode(Message.self, from: lines[55]) else { Issue.record("line 56 is not a planRequest"); return }
        #expect(req == PlanRequest(requestId: "ask-3", at: 1_790_000_700_000, instruction: "Put my email in Email", window: PlanWindow(pid: 5150, number: 4821, title: "Caret Fixture — Executor")))
        guard case .planProposal(let f) = try JSONDecoder().decode(Message.self, from: lines[56]) else { Issue.record("line 57 is not a planProposal"); return }
        #expect(f.outcome == .error && f.error?.code == .unseenWindow)
        let request = String(decoding: lines[55], as: UTF8.self)
        for bad in [
            request.replacingOccurrences(of: #""instruction""#, with: #""windowId":"5150-1","instruction""#),
            request.replacingOccurrences(of: #""number":4821"#, with: #""number":0"#),
            request.replacingOccurrences(of: #""number":4821"#, with: #""number":4821.5"#),
            request.replacingOccurrences(of: #""pid":5150"#, with: #""pid":0"#),
            request.replacingOccurrences(of: #","title":"Caret Fixture — Executor""#, with: ""),
        ] {
            #expect(bad != request)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
        let untitled = request.replacingOccurrences(of: #""title":"Caret Fixture — Executor""#, with: #""title":"""#)
        #expect(throws: Never.self) { try JSONDecoder().decode(Message.self, from: Data(untitled.utf8)) }
        // The encoder refuses both names at once rather than sending a request the helper refuses.
        let both = PlanRequest(requestId: "x", at: 1, instruction: "x", windowId: "5150-1", window: PlanWindow(pid: 5150, number: 4821, title: ""))
        #expect(throws: (any Error).self) { try NDJSON.encoder().encode(Message.planRequest(both)) }
    }

    /// B16: the planner's request and proposals; protocol.test.ts checks the same lines and refusals.
    @Test func readsThePlannerPair() throws {
        let lines = try goldenLines()
        guard case .planRequest(let req) = try JSONDecoder().decode(Message.self, from: lines[38]) else { Issue.record("line 39 is not a planRequest"); return }
        #expect(req == PlanRequest(requestId: "ask-1", at: 1_790_000_150_000, instruction: "Put the order number in Reference and send it", windowId: "5150-1"))
        guard case .planProposal(let p) = try JSONDecoder().decode(Message.self, from: lines[39]) else { Issue.record("line 40 is not a planProposal"); return }
        #expect(p.outcome == .proposed && p.offerKey == "plan-1-ask-1" && p.handoff == PlanProposal.Handoff(label: "Send", why: .outbound))
        #expect(p.spec?.blocks.count == 4 && p.window?.windowId == "5150-1")
        guard case .planProposal(let f) = try JSONDecoder().decode(Message.self, from: lines[40]) else { Issue.record("line 41 is not a planProposal"); return }
        #expect(f.outcome == .error && f.error?.code == .untracedValue && f.spec == nil)
        let request = String(decoding: lines[38], as: UTF8.self)
        let proposal = String(decoding: lines[39], as: UTF8.self)
        let failed = String(decoding: lines[40], as: UTF8.self)
        for bad in [
            request.replacingOccurrences(of: #""instruction":"Put the order number in Reference and send it""#, with: #""instruction":"""#),
            request.replacingOccurrences(of: #""windowId":"5150-1""#, with: #""windowId":"""#),
            proposal.replacingOccurrences(of: #""error":null"#, with: #""error":{"code":"unsure","detail":"x"}"#),
            proposal.replacingOccurrences(of: #""offerKey":"plan-1-ask-1""#, with: #""offerKey":null"#),
            proposal.replacingOccurrences(of: #""why":"outbound""#, with: #""why":"risky""#),
            failed.replacingOccurrences(of: #""offerKey":null"#, with: #""offerKey":"plan-2""#),
            failed.replacingOccurrences(of: #""code":"untracedValue""#, with: #""code":"guess""#),
            failed.replacingOccurrences(of: #""handoff":null"#, with: #""handoff":{"label":"Send","why":"outbound"}"#),
        ] {
            #expect(bad != request && bad != proposal && bad != failed)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
        let long = request.replacingOccurrences(of: "Put the order number in Reference and send it", with: String(repeating: "x", count: 501))
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(long.utf8)) }
        // zod counts code points: 250 emoji are 500 UTF-16 units but 250 characters, and pass on both sides.
        let emoji = request.replacingOccurrences(of: "Put the order number in Reference and send it", with: String(repeating: "😀", count: 250))
        #expect(throws: Never.self) { try JSONDecoder().decode(Message.self, from: Data(emoji.utf8)) }
        let negative = failed.replacingOccurrences(of: #""at":1790000151000"#, with: #""at":-1"#)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(negative.utf8)) }
    }

    /// B16: the calendar verbs; protocol.test.ts checks the same lines.
    @Test func readsTheCalendarVerbs() throws {
        let lines = try goldenLines()
        guard case .readerCommand(let c) = try JSONDecoder().decode(Message.self, from: lines[41]),
              case let .calendarAdd(calendar, title, start, end, taskId) = c.verb else { Issue.record("line 42 is not a calendarAdd"); return }
        #expect(calendar == "Caret Test" && title == "Coffee with Dana" && start == "2026-10-08T15:00:00-05:00" && end == "2026-10-08T15:30:00-05:00")
        #expect(c.verb.isCalendar && c.verb.taskId == "event-1" && taskId == "event-1")
        guard case .calendarGrant(let g) = try JSONDecoder().decode(Message.self, from: lines[45]) else { Issue.record("line 46 is not a calendarGrant"); return }
        #expect(g == CalendarGrant(taskId: "event-1", at: 1_790_000_159_900, expires: 1_790_000_279_900))
        guard case .verbResult(let ok) = try JSONDecoder().decode(Message.self, from: lines[42]) else { Issue.record("line 43 is not a verbResult"); return }
        #expect(ok.event == CalendarEventRecord(id: "ev-1", calendar: "Caret Test", title: "Coffee with Dana", start: start, end: end) && ok.blocked == nil)
        guard case .verbResult(let refused) = try JSONDecoder().decode(Message.self, from: lines[43]) else { Issue.record("line 44 is not a verbResult"); return }
        #expect(refused.outcome == .blocked && refused.blocked == .tcc)
        guard case .taskProgress(let p) = try JSONDecoder().decode(Message.self, from: lines[44]) else { Issue.record("line 45 is not a taskProgress"); return }
        #expect(p.phase == .handoff && p.blocked == .tcc)
        let add = String(decoding: lines[41], as: UTF8.self)
        let added = String(decoding: lines[42], as: UTF8.self)
        let blocked = String(decoding: lines[43], as: UTF8.self)
        let handoff = String(decoding: lines[44], as: UTF8.self)
        let grant = String(decoding: lines[45], as: UTF8.self)
        for bad in [
            add.replacingOccurrences(of: #","taskId":"event-1""#, with: ""),
            add.replacingOccurrences(of: #""taskId":"event-1""#, with: #""taskId":"""#),
            added.replacingOccurrences(of: #""id":"ev-1""#, with: #""id":"""#),
            added.replacingOccurrences(of: #""start":"2026-10-08T15:00:00-05:00","end""#, with: #""start":"not-a-date","end""#),
            grant.replacingOccurrences(of: #""expires":1790000279900"#, with: #""expires":1790000279901"#),
            grant.replacingOccurrences(of: #""taskId":"event-1""#, with: #""taskId":"""#),
            add.replacingOccurrences(of: #""calendar":"Caret Test""#, with: #""calendar":"""#),
            add.replacingOccurrences(of: #""end":"2026-10-08T15:30:00-05:00""#, with: #""end":"2026-10-08T15:30:00""#),
            blocked.replacingOccurrences(of: #","blocked":"tcc""#, with: ""),
            blocked.replacingOccurrences(of: #""blocked":"tcc""#, with: #""blocked":"icloud""#),
            handoff.replacingOccurrences(of: #""phase":"handoff""#, with: #""phase":"done""#),
        ] {
            #expect(bad != add && bad != added && bad != blocked && bad != handoff && bad != grant)
            #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(bad.utf8)) }
        }
    }

    /// B19: a keep offer and its answer, a memory reply with two skills and a routine, a promote offer and
    /// its answer, and the progress of a run a skill started with no Tab; protocol.test.ts reads the same lines.
    @Test func carriesSkills() throws {
        let lines = try goldenLines()
        guard case .skillOffer(let keep) = try JSONDecoder().decode(Message.self, from: lines[46]),
              case .skillAnswer(let keepAnswer) = try JSONDecoder().decode(Message.self, from: lines[47]),
              case .memoryReply(let reply) = try JSONDecoder().decode(Message.self, from: lines[48]),
              case .skillOffer(let promote) = try JSONDecoder().decode(Message.self, from: lines[49]),
              case .taskProgress(let started) = try JSONDecoder().decode(Message.self, from: lines[51]),
              case .taskProgress(let done) = try JSONDecoder().decode(Message.self, from: lines[52]) else {
            Issue.record("lines 47 to 53 are not the B19 messages"); return
        }
        #expect(keep.kind == .keep && keep.skillId == nil && keep.says == "Keep this as Subject and To into Mail Fixture?")
        #expect(keep.actions.map(\.id) == ["accept", "decline"])
        #expect(keepAnswer.id == keep.id && keepAnswer.answer == .accept)
        #expect(promote.kind == .promote && promote.skillId == "skill-5e6f7a8b" && promote.says == "Do this one on your own from now on?")
        let skills = reply.skills
        #expect(skills.count == 2)
        #expect(skills[0].fields.name == "Subject and To into Mail Fixture" && skills[0].fields.cleanRuns == 10 && skills[0].fields.handsOff == nil)
        #expect(skills[1].fields.handsOff == SkillFields.HandsOff(label: "Send", why: .outbound))
        #expect(skills[0].fields.wrote == [.writeElsewhere] && skills[1].fields.wrote == [.writeHere])
        #expect(reply.entries[2].kind == .routine && reply.entries[2].skill == nil)
        #expect(started.unprompted == true && done.unprompted == true && done.written == 3)
    }

    @Test func refusesSkillShapesZodRefuses() throws {
        let lines = try goldenLines()
        func swap(_ line: Data, _ from: String, _ to: String) -> Data {
            Data(String(decoding: line, as: UTF8.self).replacingOccurrences(of: from, with: to).utf8)
        }
        // A keep offer naming a skill, a promote offer naming none, actions out of order.
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[46], #""skillId":null"#, #""skillId":"skill-1""#)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[49], #""skillId":"skill-5e6f7a8b""#, #""skillId":null"#)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[46], #""id":"accept""#, #""id":"yes""#)) }
        // An answer other than accept or decline; unprompted false; a hands-off skill running on its own.
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[47], #""accept""#, #""later""#)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[52], #""unprompted":true"#, #""unprompted":false"#)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[48], #""onItsOwn":false,"handsOff":{"#, #""onItsOwn":true,"handsOff":{"#)) }
        // B23: a skill says what it wrote, each rule once; no other kind says it.
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[48], #","wrote":["writeHere"]"#, "")) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[48], #""wrote":["writeHere"]"#, #""wrote":["writeHere","writeHere"]"#)) }
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: swap(lines[48], #""srcApps":["#, #""wrote":[],"srcApps":["#)) }
    }

    /// The host's contract line for its permissions page (v2/host memory.ndjson host-memory-7, the last line of
    /// helper/fixtures/golden/memory.ndjson): a skill's fields carry `wrote`.
    @Test func readsTheHostsSkillLineWithWrote() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("helper/fixtures/golden/memory.ndjson")
        let last = try #require(try String(contentsOf: url, encoding: .utf8).split(separator: "\n").last)
        guard case .memoryReply(let reply) = try JSONDecoder().decode(Message.self, from: Data(last.utf8)) else { Issue.record("not a memoryReply"); return }
        #expect(reply.skills.map(\.fields.wrote) == [[.writeElsewhere]])
        let again = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Message.memoryReply(reply))) as! NSDictionary
        #expect(again == (try JSONSerialization.jsonObject(with: Data(last.utf8)) as! NSDictionary))
    }

    @Test func rejectsAWrongVersionAndAnUnknownType() {
        let wrongVersion = Data(#"{"type":"pasteboard","v":2,"at":1,"changeCount":1}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: wrongVersion) }
        let unknown = Data(#"{"type":"mystery","v":1}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: unknown) }
        let falseEditable = Data(#"{"key":"k","parent":null,"role":"AXButton","editable":false}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: falseEditable) }
    }

    /// The same shapes zod rejects: a nullable field left out, and an optional field sent as null.
    @Test func rejectsWhatZodRejects() {
        let missingParent = Data(#"{"key":"k","role":"AXButton"}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: missingParent) }
        let nullEditable = Data(#"{"key":"k","parent":null,"role":"AXButton","editable":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: nullEditable) }
        let nullLabel = Data(#"{"key":"k","parent":null,"role":"AXButton","label":null}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Node.self, from: nullLabel) }
        let noFocusKey = Data(#"{"type":"focus","v":1,"at":1,"app":{"pid":1,"bundleId":"b","name":"n"},"windowId":"w","role":"AXTextField","editable":true,"empty":true,"frontmost":true}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: noFocusKey) }
    }

    @Test func encodesNullableFieldsAsNullAndOmitsAbsentOptionals() throws {
        let n = Node(key: "k", parent: nil, role: "AXButton")
        let obj = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(n)) as! [String: Any]
        #expect(Set(obj.keys) == ["key", "parent", "role"])
        #expect(obj["parent"] is NSNull)
    }
}
