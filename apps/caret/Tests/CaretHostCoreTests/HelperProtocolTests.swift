import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// helper/fixtures/golden/protocol.ndjson, written against the zod schemas in helper/src/protocol.ts.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func goldenLines() throws -> [Data] {
    try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
}

private func goldenProposal() throws -> FillProposal {
    for line in try goldenLines() {
        if case .fillProposal(let p) = try HelperInbound.decode(line) { return p }
    }
    throw XCTSkip("golden file has no fillProposal")
}

final class HelperProtocolGoldenTests: XCTestCase {
    func testEveryGoldenLineDecodesToWhatAConsumerDoesWithIt() throws {
        let kinds = try goldenLines().map { line -> String in
            switch try HelperInbound.decode(line) {
            case .fillProposal: return "fillProposal"
            case .error: return "error"
            case .activity: return "activity"
            case .activityReply: return "activityReply"
            case .alternatives: return "alternatives"
            case .action: return "action"
            case .popup: return "popup"
            case .offerWithdrawn: return "offerWithdrawn"
            case .taskProgress: return "taskProgress"
            case .firstLookReply: return "firstLookReply"
            case .memoryReply: return "memoryReply"
            case .planProposal: return "planProposal"
            case .skillOffer: return "skillOffer"
            case .notForConsumer(let type): return "skip:\(type)"
            case .unknown(let type): return "unknown:\(type)"
            }
        }
        let expected = [
            "skip:hello", "skip:snapshot", "skip:focus", "skip:appSwitch", "skip:windowClosed",
            "skip:pasteboard", "skip:fillRequest", "fillProposal", "error",
            "skip:readerCommand", "skip:verbResult", "skip:userInput", "taskProgress", "skip:readerCommand",
            "skip:fillResult", "skip:taskControl", "skip:activityRequest", "activity", "activityReply",
            // B7: the offers, the host's own answers to them, their withdrawal, and the reader's raise.
            "alternatives", "action", "popup", "skip:offerAccept", "skip:offerStop", "offerWithdrawn", "skip:readerCommand",
            // B8: expiry, the input pause, and the counts a run reports when done and undone.
            "offerWithdrawn", "skip:taskControl", "taskProgress", "taskProgress",
            // B9: a reoffered withdrawal. B10: the host's settings, and the withdrawal they cause.
            "offerWithdrawn", "skip:settings", "skip:settings", "offerWithdrawn",
            // B15: an act grant, a write it refuses, and the revoke, all between helper and reader.
            "skip:actGrant", "skip:readerCommand", "skip:verbResult", "skip:actRevoke",
            // B16: a plan asked for, proposed and refused; the calendar adapter's add, refusal and grant.
            "skip:planRequest", "planProposal", "planProposal",
            "skip:readerCommand", "skip:verbResult", "skip:verbResult", "taskProgress", "skip:calendarGrant",
            // B19: the keep question and its answer, skills in memory, the promote question and its
            // answer, and a skill's run with no Tab.
            "skillOffer", "skip:skillAnswer", "memoryReply", "skillOffer", "skip:skillAnswer", "taskProgress", "taskProgress",
            // B20 to B22: the reader's watch on presses and a press it saw, a plan request naming its
            // window and the unseenWindow refusal, a press made with Return, and the promote offer a
            // skill row's "Let it run on its own…" asked for (taskId host-memory-7).
            "skip:readerCommand", "skip:userPress", "skip:planRequest", "planProposal", "skip:userPress", "skillOffer",
        ]
        XCTAssertEqual(kinds, expected)
    }

    /// B8 to B10 lines, field by field: expiry, the pause's reason, the run's counts, the reoffered
    /// withdrawal with its replacement and the withdrawal settings cause.
    func testTheB8LinesDecodeExactly() throws {
        let lines = try goldenLines()
        XCTAssertEqual(lines.count, 59)
        XCTAssertEqual(try HelperInbound.decode(lines[26]), .offerWithdrawn(OfferWithdrawn(at: 1_790_000_122_500, id: "offer-4", reason: .expired)))
        guard case .taskControl(let pause) = try JSONDecoder().decode(Message.self, from: lines[27]) else { return XCTFail("line 28") }
        XCTAssertEqual(pause, TaskControl(taskId: "task-1", action: .pause, reason: .input))
        XCTAssertEqual(InputPause.controls(for: ["task-1"]), [pause], "the host's pause is the golden line")
        guard case .taskProgress(let done) = try HelperInbound.decode(lines[28]) else { return XCTFail("line 29") }
        XCTAssertEqual(done.phase, .done)
        XCTAssertEqual(done.written, 3)
        XCTAssertNil(done.restored)
        guard case .taskProgress(let undone) = try HelperInbound.decode(lines[29]) else { return XCTFail("line 30") }
        XCTAssertEqual(undone.phase, .undone)
        XCTAssertEqual([undone.restored, undone.notRestored, undone.notUndoablePresses], [2, 1, 0])
        XCTAssertNil(undone.written)
        let reoffered = OfferWithdrawn(at: 1_790_000_124_000, id: "offer-5", reason: .reoffered, replacedBy: "offer-6")
        XCTAssertEqual(try HelperInbound.decode(lines[30]), .offerWithdrawn(reoffered), "line 31")
        XCTAssertEqual(try HelperInbound.decode(lines[33]), .offerWithdrawn(OfferWithdrawn(at: 1_790_000_131_000, id: "fill-2", reason: .settings)), "line 34")
    }

    /// B21's unseenWindow refusal has its own sentence, and B22's requested promote offer is the
    /// memory row's, not a line under a run.
    func testTheB21AndB22LinesReachTheirPlaces() throws {
        let lines = try goldenLines()
        guard case .planProposal(let refused) = try HelperInbound.decode(lines[56]) else { return XCTFail("line 57") }
        XCTAssertEqual(refused.error?.code, .unseenWindow)
        XCTAssertEqual(AskCopy.planError(refused.error), "I haven't read that window, so I can't plan in it. Click into it and ask again.")
        guard case .skillOffer(let offer) = try HelperInbound.decode(lines[58]) else { return XCTFail("line 59") }
        let book = MemoryBook(clock: ManualClock(), prefix: "host-memory")
        var sent: [HelperMemory.Request] = []
        book.send = { sent.append($0); return true }
        book.linkChanged(true)
        var list = try HelperMemoryTests.reply(1)
        list.requestId = sent.last!.requestId
        let skill = try HelperMemory.Reply.decode(HelperMemoryTests.line("host-memory-6", "memoryReply")).entries[0]
        list.entries.append(skill)
        book.receive(list)
        XCTAssertTrue(book.state.offersOnItsOwn)
        XCTAssertTrue(book.letRunOnItsOwn(skill.id))
        var asked = try XCTUnwrap(sent.last)
        XCTAssertEqual(asked.op, .offerOnItsOwn)
        asked.requestId = offer.taskId
        XCTAssertEqual(try object(asked.line()), try object(HelperMemoryTests.line("host-memory-7", "memoryRequest")))
        var claimed = offer
        claimed.taskId = try XCTUnwrap(sent.last).requestId
        XCTAssertTrue(book.claim(claimed))
        XCTAssertEqual(book.state.questions[skill.id]?.offerId, "skill-offer-3")
    }

    private func object(_ data: Data) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary) }

    /// B10's settings message, from the host's own settings: golden lines 32 and 33.
    func testTheHostsSettingsEncodeToTheGoldenLines() throws {
        let lines = try goldenLines()
        func object(_ data: Data) throws -> NSDictionary { try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary) }
        // Line 32 is the host's defaults, calendar role included (rewritten on v2/screen in b610800).
        XCTAssertEqual(try object(NDJSON.line(GateSettings(CaretSettings(), at: 1_790_000_130_000))), try object(lines[31]), "line 32")
        XCTAssertEqual(GateSettings(CaretSettings(), at: 1).roles, [.fill, .repeat, .watch, .calendar, .words], "every role starts on, calendar included")
        var quiet = CaretSettings()
        quiet.roles = [.watch]
        quiet.level = .quiet
        quiet.paused = true
        quiet.character = .wren
        quiet.onboarded = true
        let paused = GateSettings(quiet, at: 1_790_000_131_000)
        XCTAssertEqual(try object(NDJSON.line(paused)), try object(lines[32]), "line 33: the character and onboarding stay on the host")
        guard case .settings(let decoded) = try JSONDecoder().decode(Message.self, from: lines[32]) else { return XCTFail("line 33") }
        XCTAssertEqual(decoded, paused)
        XCTAssertEqual(try HelperInbound.decode(lines[31]), .notForConsumer(type: "settings"), "the host's own message echoed is not for it")
    }

    func testOnlyTheRolesLevelAndPauseMakeASettingsChange() {
        var s = CaretSettings()
        let base = GateSettings(s, at: 1)
        XCTAssertTrue(base.sameGate(as: GateSettings(s, at: 2)), "a new stamp alone")
        s.character = .seed
        s.onboarded = true
        XCTAssertTrue(base.sameGate(as: GateSettings(s, at: 3)), "the character and onboarding are the host's")
        for change in [{ (x: inout CaretSettings) in x.roles.remove(.fill) }, { $0.level = .eager }, { $0.paused = true }] {
            var t = CaretSettings()
            change(&t)
            XCTAssertFalse(base.sameGate(as: GateSettings(t, at: 4)))
        }
        var roles = CaretSettings()
        roles.roles = [.words, .fill]
        XCTAssertEqual(GateSettings(roles, at: 1).roles, [.fill, .words], "roles go in CaretRole order")
    }

    func testTheHostsPauseEncodesItsReason() throws {
        let data = try NDJSON.encoder().encode(InputPause.controls(for: ["run-7"])[0])
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["action"] as? String, "pause")
        XCTAssertEqual(object["reason"] as? String, "input")
    }

    func testTaskRecordsCarryTheirWindowsFrame() throws {
        let lines = try goldenLines()
        guard case .activity(let activity) = try HelperInbound.decode(lines[17]) else { return XCTFail("line 18") }
        XCTAssertEqual(activity.task.frame, Frame(x: 640, y: 120, width: 520, height: 380))
        guard case .activityReply(let reply) = try HelperInbound.decode(lines[18]) else { return XCTFail("line 19") }
        XCTAssertEqual(reply.tasks.map(\.frame), [Frame(x: 40, y: 60, width: 520, height: 420), Frame(x: 40, y: 60, width: 520, height: 420)])
        XCTAssertFalse(reply.truncated)
    }

    func testTheSevenOfferLinesDecodeExactly() throws {
        let lines = try goldenLines()
        XCTAssertGreaterThanOrEqual(lines.count, 26)
        guard case .alternatives(let alternatives) = try HelperInbound.decode(lines[19]) else { return XCTFail("line 20") }
        XCTAssertEqual(alternatives.offerKey, "offer-4.0")
        XCTAssertEqual(alternatives.at, 1_790_000_002_000)
        XCTAssertEqual(alternatives.field, OfferField(
            pid: 7170, windowId: "7170-1", key: "dev.caret.sheet/standard/table:guests/textfield:guest~2",
            frame: Frame(x: 120, y: 288, width: 180, height: 22), window: OfferWindow(number: 4421, title: "Seating")
        ))
        XCTAssertEqual(alternatives.candidates.map(\.text), ["Cara Diaz", "Cal Duarte"])
        XCTAssertEqual(alternatives.candidates[0].ref, .node(key: "5150-1/dev.caret.fixture/standard/statictext:cara diaz~0", quote: "Cara Diaz"))
        XCTAssertTrue(alternatives.quoted)

        guard case .action(let action) = try HelperInbound.decode(lines[20]) else { return XCTFail("line 21") }
        XCTAssertEqual(action.offerKey, "offer-5")
        XCTAssertEqual(action.app, "Sheet Fixture")
        XCTAssertEqual(action.endState.text, "Finish the rest: 2 more values from Caret Fixture")
        guard case .derived(let rule, let refs) = action.endState.ref else { return XCTFail("endState is not derived") }
        XCTAssertEqual(rule, "loopFinish")
        XCTAssertEqual(refs.count, 2)
        XCTAssertEqual(action.actions, [PopupSpec.Action(id: "finish", label: "Finish", key: .tab)])
        XCTAssertEqual(action.variants?.id, "variants-5")
        XCTAssertEqual(action.variants?.figure, .needsYou)
        XCTAssertEqual(action.variants?.choices?.rows.map(\.label.text), ["Caret Fixture", "Mail Fixture"])

        guard case .popup(let popup) = try HelperInbound.decode(lines[21]) else { return XCTFail("line 22") }
        XCTAssertEqual(popup.offerKey, "fill-2")
        XCTAssertEqual(popup.field.frame, Frame(x: 200, y: 140, width: 260, height: 22))
        XCTAssertEqual(popup.field.window, OfferWindow(number: nil, title: "Checkout"))
        XCTAssertEqual(popup.sourceApps, ["Mail Fixture"])
        XCTAssertEqual(action.field.window, OfferWindow(number: 4421, title: "Seating"))
        XCTAssertEqual(popup.spec.id, "fill-2")
        XCTAssertEqual(popup.spec.blocks.count, 4)
        guard case .fields(let fields) = popup.spec.blocks[2].content else { return XCTFail("third block is not fields") }
        XCTAssertEqual(fields.rows.map { $0.value?.text }, ["dana.whitfield@example.com", "+1 512 555 0142"])

        XCTAssertEqual(try JSONDecoder().decode(OfferAccept.self, from: lines[22]),
                       OfferAccept(offerId: "offer-5", actionId: "finish", overrides: ["variants": 1], at: 1_790_000_002_300))
        XCTAssertEqual(try JSONDecoder().decode(OfferStop.self, from: lines[23]), OfferStop(offerId: "offer-5", at: 1_790_000_002_400))
        XCTAssertEqual(try HelperInbound.decode(lines[24]), .offerWithdrawn(OfferWithdrawn(at: 1_790_000_002_500, id: "offer-4.0", reason: .taken)))
        guard case .readerCommand(let raise) = try JSONDecoder().decode(Message.self, from: lines[25]) else { return XCTFail("line 26") }
        XCTAssertEqual(raise.verb, .raise(pid: 5150, windowId: "5150-4", taskId: nil), "no grant named: the reader acts only in --act-pids processes")
    }

    func testAnOfferWithAValueWithoutARefIsRejected() {
        // The helper never sends one (B7 acceptance 3); the host refuses it all the same.
        let line = Data(#"{"type":"alternatives","v":1,"offerKey":"k","at":1,"field":{"pid":1,"windowId":"1-1","key":"k","frame":null,"window":{"number":null,"title":""}},"candidates":[{"text":"x"}],"quoted":false}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }

    func testAnOfferWithoutItsWindowIsRejected() {
        // B8 made OfferField.window required; a field without it cannot be told from its twin.
        let line = Data(#"{"type":"alternatives","v":1,"offerKey":"k","at":1,"field":{"pid":1,"windowId":"1-1","key":"k","frame":null},"candidates":[{"text":"x","ref":{"node":"n","quote":"x"}}],"quoted":true}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }

    func testGoldenActivityLinesBuildTheFeed() throws {
        var feed = ActivityFeed()
        for line in try goldenLines() {
            switch try HelperInbound.decode(line) {
            case .activityReply(let reply): XCTAssertTrue(feed.applyList(reply))
            case .activity(let a): _ = feed.apply(a)
            default: continue
            }
        }
        // The broadcast (seq 12) came before the list (seq 13), which replaces it.
        XCTAssertTrue(feed.listed)
        XCTAssertEqual(feed.seq, 13)
        let paused = try XCTUnwrap(feed.tasks["task-1"])
        XCTAssertEqual(paused.state, .paused)
        let row = try XCTUnwrap(ActivityList.row(for: paused))
        XCTAssertEqual(row.section, .needsYou)
        XCTAssertEqual(row.actions.first, .resume)
    }

    func testGoldenFillProposalFieldsDecodeExactly() throws {
        let p = try goldenProposal()
        XCTAssertEqual(p.id, "fill-1")
        XCTAssertEqual(p.at, 1_790_000_000_500)
        XCTAssertEqual(p.windowId, "5150-1")
        XCTAssertEqual(p.bundleId, "dev.caret.fixture")
        XCTAssertEqual(p.triggerKey, "dev.caret.fixture/standard/group:contact details/textfield:email~0")
        XCTAssertEqual(p.candidates, 24)
        XCTAssertEqual(p.cutoff, 0.75)
        XCTAssertEqual(p.jev.model, "jev-1.13.0")
        XCTAssertEqual(p.jev.latencyMs, 201.5)
        XCTAssertEqual(p.fields.count, 3)

        let email = p.fields[0]
        XCTAssertEqual(email.frame, Frame(x: 150, y: 120, width: 300, height: 24))
        XCTAssertEqual(email.choice, "c3")
        XCTAssertEqual(email.confidence, 0.97)
        XCTAssertEqual(email.value, "dana.whitfield@example.com")
        XCTAssertNil(email.withheld)
        XCTAssertEqual(email.source?.windowId, "5150-2")
        XCTAssertEqual(email.source?.appName, "Caret Fixture")
        XCTAssertEqual(email.source?.windowTitle, "Reference")
        XCTAssertEqual(email.source?.kind, .email)
        XCTAssertEqual(email.asks.map(\.choice), ["c3", "c3"])

        let promo = p.fields[1]
        XCTAssertNil(promo.frame)
        XCTAssertEqual(promo.choice, "none")
        XCTAssertNil(promo.value)
        XCTAssertNil(promo.source)
        XCTAssertEqual(promo.withheld, .disagree)
        XCTAssertEqual(promo.asks[1].value, "SAVE-10")
        XCTAssertNil(promo.memory)

        // B17: a value from what the user told Caret carries its entry and no window.
        let name = p.fields[2]
        XCTAssertEqual(name.value, "Dana Whitfield")
        XCTAssertNil(name.source)
        XCTAssertEqual(name.memory, FillMemory(id: "about-9f8e7d6c", label: "Name", says: "what you told Caret"))
        XCTAssertNil(email.memory)
    }

    func testGoldenErrorDecodes() throws {
        let line = try XCTUnwrap(try goldenLines().first { String(decoding: $0, as: UTF8.self).contains(#""type":"error""#) })
        XCTAssertEqual(try HelperInbound.decode(line), .error(try JSONDecoder().decode(HelperError.self, from: line)))
        guard case .error(let e) = try HelperInbound.decode(line) else { return XCTFail("not an error") }
        XCTAssertEqual(e.message, "unknown window 5150-9")
    }

    func testAnUnknownTypeIsNamedNotFatal() throws {
        let line = Data(#"{"type":"patternOffer","v":1,"at":1}"#.utf8)
        XCTAssertEqual(try HelperInbound.decode(line), .unknown(type: "patternOffer"))
    }

    func testAWrongVersionIsRejected() {
        let line = Data(#"{"type":"error","v":2,"at":1,"message":"x"}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }

    func testAMalformedProposalIsRejectedNotSkipped() {
        // asks must hold exactly two entries.
        let line = Data(#"{"type":"fillProposal","v":1,"id":"f","at":1,"windowId":"1-1","bundleId":"b","triggerKey":"k","fields":[{"key":"k","frame":null,"descriptor":"d","choice":"none","confidence":0,"value":null,"source":null,"withheld":null,"asks":[]}],"candidates":0,"jev":{"model":"m","latencyMs":1,"inputTokens":1,"costUsd":0},"cutoff":0.75}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(line))
    }
}

final class FillResultTests: XCTestCase {
    func testEncodesEveryKeyWithNullsPresent() throws {
        let result = FillResult(
            at: 1_790_000_001_000, proposalId: "fill-1", windowId: "5150-1",
            fieldKey: "dev.caret.fixture/standard/group:contact details/textfield:email~0",
            outcome: .rejected, reason: "sourceChanged", method: nil, valueLength: 0
        )
        let data = try NDJSON.encoder().encode(result)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "v", "at", "proposalId", "windowId", "fieldKey", "outcome", "reason", "method", "valueLength"])
        XCTAssertEqual(object["type"] as? String, "fillResult")
        XCTAssertEqual(object["v"] as? Int, 1)
        XCTAssertTrue(object["method"] is NSNull, "nullable keys are sent as null, not omitted")
        XCTAssertEqual(try JSONDecoder().decode(FillResult.self, from: data), result)
    }

    func testRoundTripsEveryOutcomeAndMethod() throws {
        for outcome in [FillResult.Outcome.inserted, .rejected, .failed, .undone, .undoFailed] {
            for method in [FillResult.Method?.none, .pastePid, .axSelectedText, .axValue] {
                let r = FillResult(at: 1, proposalId: "p", windowId: "1-1", fieldKey: "k", outcome: outcome, reason: nil, method: method, valueLength: 3)
                XCTAssertEqual(try JSONDecoder().decode(FillResult.self, from: try JSONEncoder().encode(r)), r)
            }
        }
    }

    func testRejectsAMissingNullableKey() {
        let line = Data(#"{"type":"fillResult","v":1,"at":1,"proposalId":"p","windowId":"1-1","fieldKey":"k","outcome":"inserted","method":"pastePid","valueLength":3}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(FillResult.self, from: line))
    }

    func testTheHostRecognisesItsOwnMessageIfEchoed() throws {
        let r = FillResult(at: 1, proposalId: "p", windowId: "1-1", fieldKey: "k", outcome: .inserted, reason: nil, method: .pastePid, valueLength: 3)
        XCTAssertEqual(try HelperInbound.decode(try JSONEncoder().encode(r)), .notForConsumer(type: "fillResult"))
    }
}

final class LineFramerTests: XCTestCase {
    private func lines(_ items: [LineFramer.Item]) -> [String] {
        items.map { item in
            switch item {
            case .line(let d): return String(decoding: d, as: UTF8.self)
            case .oversized: return "<oversized>"
            }
        }
    }

    func testJoinsAPartialLineAcrossChunks() {
        var f = LineFramer()
        XCTAssertEqual(lines(f.append(Data(#"{"a":"#.utf8))), [])
        XCTAssertEqual(lines(f.append(Data("1}\n{\"b\":2}\n{\"c\"".utf8))), [#"{"a":1}"#, #"{"b":2}"#])
        XCTAssertEqual(lines(f.append(Data(":3}\n".utf8))), [#"{"c":3}"#])
    }

    func testSkipsBlankLines() {
        var f = LineFramer()
        XCTAssertEqual(lines(f.append(Data("\n  \n{}\n".utf8))), ["{}"])
    }

    func testDropsAnOversizedLineWholeAndResynchronizes() {
        var f = LineFramer(maxLineBytes: 8)
        XCTAssertEqual(lines(f.append(Data("0123456789".utf8))), ["<oversized>"])
        XCTAssertEqual(lines(f.append(Data("abc\n{}\n".utf8))), ["{}"], "the tail of the long line is not a message")
    }
}

final class FillSelectionTests: XCTestCase {
    private let emailFrame = Frame(x: 150, y: 120, width: 300, height: 24)

    func testTheFocusedFieldGetsItsProposedValue() throws {
        let result = FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "", secure: false)
        guard case .offer(let field, let origin) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(field.value, "dana.whitfield@example.com")
        XCTAssertEqual(origin.proposalID, "fill-1")
        XCTAssertEqual(origin.windowID, "5150-1")
        XCTAssertEqual(origin.fieldKey, field.key)
        XCTAssertEqual(origin.source, .window(.init(appName: "Caret Fixture", title: "Reference", bundleID: "dev.caret.fixture", pid: 5150)))
        XCTAssertEqual(origin.sourceCaption, "from Caret Fixture, Reference")
    }

    /// The golden Full name comes from what the user told Caret: offered with its entry, named so,
    /// and with no window to recheck (brief A14, part 2).
    func testAMemoryValueIsOfferedFromItsEntry() throws {
        let nameFrame = Frame(x: 150, y: 80, width: 300, height: 24)
        let p = try goldenProposal()
        let result = FillSelection.select(p, focusedFrame: nameFrame, focusedValue: "", secure: false)
        guard case .offer(let field, let origin) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(field.value, "Dana Whitfield")
        XCTAssertEqual(origin.source, .memory(id: "about-9f8e7d6c"))
        XCTAssertEqual(origin.memoryID, "about-9f8e7d6c")
        XCTAssertEqual(origin.sourceCaption, "from what you told Caret")
        XCTAssertEqual(origin.toastSource, "from what you told Caret")
        XCTAssertEqual(FillSelection.select(p, focusedFrame: nameFrame, focusedValue: "", secure: false, changedMemory: ["about-9f8e7d6c"]), .skip(.memoryChanged))
        XCTAssertEqual(FillSelection.select(p, focusedFrame: nameFrame, focusedValue: "", secure: false, changedMemory: ["about-other"]), result)
        // The window values of the same proposal ignore memory changes.
        guard case .offer = FillSelection.select(p, focusedFrame: emailFrame, focusedValue: "", secure: false, changedMemory: ["about-9f8e7d6c"]) else {
            return XCTFail("a window's value is not an entry's")
        }
    }

    func testAFrameWithinAPointStillMatches() throws {
        let nudged = Frame(x: 150.6, y: 119.4, width: 300, height: 24)
        guard case .offer = FillSelection.select(try goldenProposal(), focusedFrame: nudged, focusedValue: "", secure: false) else {
            return XCTFail("rounding between readers must not lose the match")
        }
    }

    func testAMovedWindowMatchesNothing() throws {
        let moved = Frame(x: 152, y: 120, width: 300, height: 24)
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: moved, focusedValue: "", secure: false), .skip(.noFieldAtFocus))
    }

    func testANoneAnswerShowsNoOffer() throws {
        var p = try goldenProposal()
        p.fields[1].frame = Frame(x: 150, y: 160, width: 300, height: 24)
        let focused = Frame(x: 150, y: 160, width: 300, height: 24)
        // The golden Promo code is "none" because its asks disagreed: the withholding names the skip.
        XCTAssertEqual(FillSelection.select(p, focusedFrame: focused, focusedValue: "", secure: false), .skip(.withheld))
        p.fields[1].withheld = nil
        XCTAssertEqual(FillSelection.select(p, focusedFrame: focused, focusedValue: "", secure: false), .skip(.answerNone))
    }

    /// B12: a field withheld as sourceCut comes with no asks, and may still carry the pick a
    /// partial set produced. Neither is ghosted; nor is any other withheld field.
    func testAWithheldFieldShowsNoGhostValue() throws {
        let frame = #"[150,120,300,24]"#
        func line(_ withheld: String, value: String, asks: String) -> Data {
            // A value comes with its source, and no value with none (protocol.ts FillField, B17).
            let source = value == "null" ? "null" : #"{"pid":5150,"windowId":"5150-2","bundleId":"dev.caret.fixture","appName":"Caret Fixture","windowTitle":"Reference","nodeKey":"n","kind":"email"}"#
            return Data(#"{"type":"fillProposal","v":1,"id":"fill-9","at":1790000000500,"pid":5150,"windowId":"5150-1","bundleId":"dev.caret.fixture","triggerKey":"k:email","candidates":2,"cutoff":0.75,"jev":{"model":"m","latencyMs":1,"inputTokens":1,"costUsd":0},"fields":[{"key":"k:email","frame":\#(frame),"descriptor":"Email","choice":"c1","confidence":0.9,"value":\#(value),"source":\#(source),"withheld":\#(withheld),"asks":\#(asks)}]}"#.utf8)
        }
        let ask = #"{"choice":"c1","confidence":0.9,"value":"dana@example.com"}"#
        let cases: [(String, Data)] = [
            ("sourceCut, no asks, a value left in", line(#""sourceCut""#, value: #""dana@example.com""#, asks: "[]")),
            ("sourceCut, no asks, no value", line(#""sourceCut""#, value: "null", asks: "[]")),
            ("disagree", line(#""disagree""#, value: #""dana@example.com""#, asks: "[\(ask),\(ask)]")),
            ("lowConfidence", line(#""lowConfidence""#, value: #""dana@example.com""#, asks: "[\(ask),\(ask)]")),
        ]
        for (name, data) in cases {
            guard case .fillProposal(let p) = try HelperInbound.decode(data) else { return XCTFail(name) }
            XCTAssertNotNil(p.fields[0].withheld, name)
            XCTAssertEqual(FillSelection.select(p, focusedFrame: emailFrame, focusedValue: "", secure: false), .skip(.withheld), name)
        }
        guard case .fillProposal(let cut) = try HelperInbound.decode(cases[0].1) else { return XCTFail() }
        XCTAssertEqual(cut.fields[0].withheld, .sourceCut)
        XCTAssertEqual(cut.fields[0].asks, [], "a field that was not asked has no asks")
        var asked = cut
        asked.fields[0].withheld = nil
        guard case .offer = FillSelection.select(asked, focusedFrame: emailFrame, focusedValue: "", secure: false) else {
            return XCTFail("the same field, not withheld, is offered: the skip is the withholding's")
        }
    }

    func testAFieldThatAlreadyHasTextIsNeverFilled() throws {
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "d", secure: false), .skip(.fieldNotEmpty))
    }

    func testASecureFieldIsNeverFilled() throws {
        XCTAssertEqual(FillSelection.select(try goldenProposal(), focusedFrame: emailFrame, focusedValue: "", secure: true), .skip(.unsuitableField))
    }

    func testSourceCaptionDropsARepeatedAppName() {
        let origin = FillOrigin(
            proposalID: "p", windowID: "1-1", fieldKey: "k", sourceAppName: "Caret Fixture",
            sourceWindowTitle: "Caret Fixture — Reference", sourceBundleID: "", sourcePID: 1, proposedAtMs: 0
        )
        XCTAssertEqual(origin.sourceCaption, "from Caret Fixture, Reference")
        let bare = FillOrigin(
            proposalID: "p", windowID: "1-1", fieldKey: "k", sourceAppName: "Caret Fixture",
            sourceWindowTitle: "", sourceBundleID: "", sourcePID: 1, proposedAtMs: 0
        )
        XCTAssertEqual(bare.sourceCaption, "from Caret Fixture")
        XCTAssertEqual(bare.toastSource, "from Caret Fixture")
    }

    func testARefusedOrUndoneValueIsNotOfferedInThatFieldAgain() throws {
        let p = try goldenProposal()
        let key = FillSelection.suppressionKey(windowID: p.windowId, fieldKey: p.fields[0].key, value: "dana.whitfield@example.com")
        XCTAssertEqual(FillSelection.select(p, focusedFrame: emailFrame, focusedValue: "", secure: false, suppressed: [key]), .skip(.suppressed))
        let otherValue = FillSelection.suppressionKey(windowID: p.windowId, fieldKey: p.fields[0].key, value: "someone@else.example")
        guard case .offer = FillSelection.select(p, focusedFrame: emailFrame, focusedValue: "", secure: false, suppressed: [otherValue]) else {
            return XCTFail("a different value for the field is still offerable")
        }
    }

    func testWindowIDsParseToPIDs() {
        XCTAssertEqual(FillSelection.pid(fromWindowID: "5150-2"), 5150)
        XCTAssertNil(FillSelection.pid(fromWindowID: "nodash"))
    }
}
