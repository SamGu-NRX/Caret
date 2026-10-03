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
                          "readerCommand", "verbResult", "verbResult", "taskProgress", "calendarGrant"])
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
        guard case let .write(pid, _, _, role, attribute, expect, value, taskId) = c.verb else { Issue.record("not a write"); return }
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

    @Test func readsTheHostSettingsAndTheirWithdrawal() throws {
        let lines = try goldenLines()
        guard case .settings(let all) = try JSONDecoder().decode(Message.self, from: lines[31]),
              case .settings(let quiet) = try JSONDecoder().decode(Message.self, from: lines[32]) else { Issue.record("lines 32 and 33 are not settings"); return }
        // The host's own message, which does not yet name the calendar role B16 added.
        #expect(all == GateSettings(at: 1_790_000_130_000, roles: [.fill, .repeat, .watch, .words], level: .balanced, paused: false))
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
              case let .write(_, _, _, _, attribute, _, _, _) = ins.verb else { Issue.record("an insert write does not decode"); return }
        #expect(attribute == "insert")
        let paste = write.replacingOccurrences(of: #""attribute":"value""#, with: #""attribute":"paste""#)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(Message.self, from: Data(paste.utf8)) }
        let bare = write.replacingOccurrences(of: #","taskId":"offer-5""#, with: "")
        guard case .readerCommand(let noTask) = try JSONDecoder().decode(Message.self, from: Data(bare.utf8)) else { Issue.record("a write without taskId does not decode"); return }
        #expect(noTask.verb.taskId == nil)
        let again = try JSONSerialization.jsonObject(with: try NDJSON.encoder().encode(Message.readerCommand(noTask))) as! [String: Any]
        #expect((again["verb"] as? [String: Any])?["taskId"] == nil)
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
