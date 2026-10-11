import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Skills in "What Caret knows" and on the permissions page (brief A15, part 2), and the decoder's
/// rule for kinds this host does not know: kept and shown, never dropped and never a crash.
final class MemorySkillTests: XCTestCase {
    /// The helper's golden memory reply with two skills (helper/fixtures/golden/protocol.ndjson).
    private func goldenSkills() throws -> HelperMemory.Reply {
        try HelperMemory.Reply.decode(SkillSurfaceTests.goldenLine("memoryReply", containing: "\"kind\":\"skill\""))
    }

    private func entry(_ kind: String, id: String, status: String = "active", says: String = "x", fields: String) -> String {
        #"{"kind":"\#(kind)","id":"\#(id)","status":"\#(status)","says":"\#(says)","evidence":{"count":11,"lastSeen":1790000400000,"app":"Mail Fixture"},"fields":\#(fields)}"#
    }

    private func skillFields(name: String = "Order to Tracker", onItsOwn: Bool, cleanRuns: Int = 10, handsOff: String = "null", wrote: String = "[]") -> String {
        #"{"routineId":"routine-1","name":"\#(name)","trigger":"a Tracker window opens with Order and Carrier empty","runs":11,"cleanRuns":\#(cleanRuns),"needed":10,"onItsOwn":\#(onItsOwn),"handsOff":\#(handsOff),"wrote":\#(wrote)}"#
    }

    private func reply(_ entries: [String]) throws -> HelperMemory.Reply {
        try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[\#(entries.joined(separator: ","))]}"#.utf8))
    }

    /// A book holding `entries`, as after a list.
    private func book(_ entries: [String]) throws -> (MemoryBook, () -> [HelperMemory.Request]) {
        let book = MemoryBook(clock: ManualClock())
        var sent: [HelperMemory.Request] = []
        book.send = { sent.append($0); return true }
        book.linkChanged(true)
        var r = try reply(entries)
        r.requestId = try XCTUnwrap(sent.last, "no request was sent").requestId
        book.receive(r)
        return (book, { sent })
    }

    // MARK: - Decoding

    func testTheHelpersSkillsDecode() throws {
        let r = try goldenSkills()
        XCTAssertEqual(r.unreadable, [])
        let skills = r.entries.compactMap(\.skill)
        XCTAssertEqual(r.entries.map(\.kind), [.skill, .skill, .routine], "with the routine a skill was kept from")
        XCTAssertEqual(skills.map(\.handsOff?.label), [nil, "Send"])
        XCTAssertEqual(skills.first?.name, "Subject and To into Mail Fixture")
        XCTAssertEqual(r.entries.first?.kind, .skill)
    }

    func testAKindThisHostDoesNotKnowIsKeptAndShownAsSomethingCaretNoticed() throws {
        let r = try reply([
            entry("habit", id: "h-1", says: "You archive receipts on Fridays", fields: "{}"),
            entry("unrecognized", id: "h-2", says: "A kind named like the host's own label", fields: #"{"x":1}"#),
            entry("preference", id: "p-1", fields: #"{"rule":"shout"}"#),
        ])
        XCTAssertEqual(r.entries.map(\.id), ["h-1", "h-2"])
        XCTAssertEqual(r.entries.first?.fields, .unrecognized(kind: "habit"))
        XCTAssertEqual(r.unreadable.count, 1, "a known kind with fields this host cannot read is still counted, not guessed")
        var state = MemoryBook.State()
        state.entries = r.entries
        state.connected = true
        state.loaded = true
        let section = try XCTUnwrap(MemoryPage.sections(state, now: Date()).first { $0.kind == .unrecognized })
        XCTAssertEqual(section.title, "Kept by a newer Caret")
        XCTAssertEqual(section.rows.map(\.title), ["You archive receipts on Fridays", "A kind named like the host's own label"])
        XCTAssertEqual(section.rows.first?.controls, [.forget], "it can be forgotten; nothing else is guessed at")
        XCTAssertNil(MemoryPage.sections(MemoryBook.State(), now: Date()).first { $0.kind == .unrecognized }, "no section while there is nothing")
    }

    func testASkillWhoseStatusContradictsItsFieldsIsUnreadable() throws {
        let r = try reply([entry("skill", id: "s-1", status: "learning", fields: skillFields(onItsOwn: true))])
        XCTAssertEqual(r.entries, [])
        XCTAssertEqual(r.unreadable.count, 1)
    }

    // MARK: - The list

    func testSkillRowsSayNameTriggerRunsAndState() throws {
        let (b, _) = try book([
            entry("skill", id: "s-own", status: "active", fields: skillFields(onItsOwn: true)),
            entry("skill", id: "s-learn", status: "learning", fields: skillFields(name: "Reply to Mail", onItsOwn: false, cleanRuns: 3)),
            entry("skill", id: "s-tab", status: "learning", fields: skillFields(name: "Invoice to Ledger", onItsOwn: false)),
            entry("skill", id: "s-send", status: "learning", fields: skillFields(name: "Send the reply", onItsOwn: false, cleanRuns: 2, handsOff: #"{"label":"Send","why":"outbound"}"#)),
            entry("skill", id: "s-paused", status: "paused", fields: skillFields(name: "Paused one", onItsOwn: true)),
        ])
        let rows = try XCTUnwrap(MemoryPage.sections(b.state, now: Date()).first { $0.kind == .skill }).rows
        let when = "when a Tracker window opens with Order and Carrier empty"
        XCTAssertEqual(rows.map(\.title), ["Order to Tracker", "Reply to Mail", "Invoice to Ledger", "Send the reply", "Paused one"])
        XCTAssertEqual(rows.map(\.secondary), [
            "On its own · \(when) · ran 11 times",
            "Learning, 3 of 10 clean runs · \(when) · ran 11 times",
            "On Tab · \(when) · ran 11 times",
            "On Tab, you press Send yourself · \(when) · ran 11 times",
            "Paused · \(when) · ran 11 times",
        ])
        XCTAssertEqual(rows[0].controls, [.edit, .backOnTab, .pause, .forget])
        XCTAssertEqual(rows[1].controls, [.edit, .pause, .forget])
        XCTAssertEqual(rows[4].controls, [.edit, .resume, .forget], "a paused skill runs nowhere, so it has nothing to put back")
        XCTAssertEqual(MemoryPage.controlTitle(.edit, kind: .skill), "Rename")
        XCTAssertEqual(MemoryPage.controlTitle(.edit, kind: .about), "Edit")
        XCTAssertEqual(MemoryPage.forgetQuestion(.skill), "Forget this skill? Caret won't ask to keep it again.")
    }

    func testRenameIsSentAsAnEditOfTheName() throws {
        let (b, sent) = try book([entry("skill", id: "s-1", status: "active", fields: skillFields(onItsOwn: true))])
        b.beginEdit("s-1")
        XCTAssertEqual(b.state.editor?.fields.map(\.key), ["name"])
        b.updateDraft("name", "  ")
        XCTAssertFalse(b.saveEdit())
        XCTAssertEqual(b.state.editor?.problem, "Name can't be empty. To remove the skill, use Forget.")
        b.updateDraft("name", "Orders into Tracker")
        XCTAssertTrue(b.saveEdit())
        XCTAssertEqual(sent().last, HelperMemory.Request(requestId: sent().last!.requestId, op: .edit, id: "s-1", fields: ["name": .text("Orders into Tracker")]))
    }

    /// The host's contract line for "Put back on Tab" (Fixtures/memory.ndjson, host-memory-6), and
    /// what the row says when a helper refuses it.
    func testPutBackOnTabIsTheContractEditAndARefusalSaysWhatStillWorks() throws {
        let (b, sent) = try book([entry("skill", id: "skill-5e6f7a8b", status: "active", fields: skillFields(onItsOwn: true))])
        XCTAssertTrue(b.backOnTab("skill-5e6f7a8b"))
        var request = try XCTUnwrap(sent().last)
        XCTAssertEqual(b.state.busy["skill-5e6f7a8b"], .backOnTab)
        let contract = try HelperMemoryTests.line("host-memory-6", "memoryRequest")
        let id = request.requestId
        request.requestId = "host-memory-6"
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.line()) as? NSDictionary, try JSONSerialization.jsonObject(with: contract) as? NSDictionary)
        b.receive(HelperMemory.Reply(requestId: id, error: "invalid edit: unrecognized key onItsOwn", entries: []))
        XCTAssertEqual(b.state.problems["skill-5e6f7a8b"], "This version of Caret can't put a skill back on Tab yet. Pause it to stop it running, or Forget it.")
        XCTAssertEqual(b.debugInfo().problems["skill-5e6f7a8b"], "This version of Caret can't put a skill back on Tab yet. Pause it to stop it running, or Forget it. [helper: invalid edit: unrecognized key onItsOwn]")
        XCTAssertEqual(MemoryPage.onTheirOwn(b.state).first?.problem, b.state.problems["skill-5e6f7a8b"], "the permissions page shows the same refusal")
        XCTAssertNil(b.state.busy["skill-5e6f7a8b"])
    }

    // MARK: - Let it run on its own… (B22)

    /// A book holding `entries` from a helper whose list names `offerOnItsOwn` among its ops, and
    /// what it sent: requests and answers.
    private func offeringBook(_ entries: [String]) throws -> (MemoryBook, () -> [HelperMemory.Request], () -> [SkillAnswer]) {
        let book = MemoryBook(clock: ManualClock())
        var sent: [HelperMemory.Request] = []
        var answers: [SkillAnswer] = []
        book.send = { sent.append($0); return true }
        book.sendAnswer = { answers.append($0); return true }
        book.linkChanged(true)
        var r = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[\#(entries.joined(separator: ","))],"ops":["list","edit","pause","resume","forget","add","offerOnItsOwn"]}"#.utf8))
        r.requestId = try XCTUnwrap(sent.last, "no request was sent").requestId
        book.receive(r)
        return (book, { sent }, { answers })
    }

    /// The helper's promote offer for a request (skills.ts offerPromote's words).
    private func promoteOffer(id: String = "skill-offer-1", taskId: String, skillId: String) throws -> SkillOffer {
        try JSONDecoder().decode(SkillOffer.self, from: Data(#"{"type":"skillOffer","v":1,"id":"\#(id)","at":1790000500000,"kind":"promote","taskId":"\#(taskId)","routineId":"routine-1","skillId":"\#(skillId)","name":"Order to Tracker","says":"Do this one on your own from now on?","detail":"You'll see it happen and can undo it.","actions":[{"id":"accept","label":"Do it on its own"},{"id":"decline","label":"Keep asking"}]}"#.utf8))
    }

    private func row(_ b: MemoryBook, _ id: String) throws -> MemoryPage.Row {
        try XCTUnwrap(MemoryPage.sections(b.state, now: Date()).flatMap(\.rows).first { $0.id == id })
    }

    func testOnlyASkillOnTabThatCouldRunOnItsOwnOffersToLetItRunOnItsOwn() throws {
        let (b, _, _) = try offeringBook([
            entry("skill", id: "s-tab", status: "learning", fields: skillFields(onItsOwn: false, cleanRuns: 2)),
            entry("skill", id: "s-own", status: "active", fields: skillFields(onItsOwn: true)),
            entry("skill", id: "s-send", status: "learning", fields: skillFields(onItsOwn: false, handsOff: #"{"label":"Send","why":"outbound"}"#)),
            entry("skill", id: "s-allow", status: "learning", fields: skillFields(onItsOwn: false, handsOff: #"{"label":"Allow","why":"system"}"#)),
            entry("skill", id: "s-paused", status: "paused", fields: skillFields(onItsOwn: false)),
        ])
        XCTAssertEqual(try row(b, "s-tab").controls, [.edit, .onItsOwn, .pause, .forget], "asked for at any clean count: the user is asking now")
        XCTAssertEqual(try row(b, "s-own").controls, [.edit, .backOnTab, .pause, .forget])
        XCTAssertEqual(try row(b, "s-send").controls, [.edit, .pause, .forget], "a press left to the user never runs on its own")
        XCTAssertEqual(try row(b, "s-paused").controls, [.edit, .resume, .forget])
        XCTAssertEqual(try row(b, "s-allow").secondary, "On Tab, you press Allow in the system prompt yourself · when a Tracker window opens with Order and Carrier empty · ran 11 times")
        XCTAssertEqual(MemoryPage.controlTitle(.onItsOwn, kind: .skill), "Let it run on its own\u{2026}")
        XCTAssertFalse(b.letRunOnItsOwn("s-own"))
        XCTAssertFalse(b.letRunOnItsOwn("s-send"))
        XCTAssertFalse(b.letRunOnItsOwn("s-paused"))

        // A helper that does not name the op: no control, and nothing is sent.
        let (older, sent) = try book([entry("skill", id: "s-tab", status: "learning", fields: skillFields(onItsOwn: false))])
        let before = sent().count
        XCTAssertFalse(older.letRunOnItsOwn("s-tab"))
        XCTAssertEqual(sent().count, before)
        XCTAssertEqual(MemoryPage.sections(older.state, now: Date()).flatMap(\.rows).first?.controls, [.edit, .pause, .forget])
    }

    /// The host's request is the golden host-memory-7 line; the offer, which the helper publishes
    /// before its reply, shows on the row; a yes is the offer's answer, and the helper's `taken`
    /// reads the list again.
    func testLetItRunOnItsOwnSendsTheContractRequestShowsTheOfferAndAnswersIt() throws {
        let id = "skill-5e6f7a8b"
        let (b, sent, answers) = try offeringBook([entry("skill", id: id, status: "learning", fields: skillFields(onItsOwn: false, cleanRuns: 0))])
        XCTAssertTrue(b.letRunOnItsOwn(id))
        var request = try XCTUnwrap(sent().last)
        let requestId = request.requestId
        request.requestId = "host-memory-7"
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: request.line()) as? NSDictionary,
            try JSONSerialization.jsonObject(with: HelperMemoryTests.line("host-memory-7", "memoryRequest")) as? NSDictionary
        )
        XCTAssertEqual(b.state.busy[id], .onItsOwn)
        XCTAssertFalse(b.letRunOnItsOwn(id), "one request at a time")

        XCTAssertFalse(b.claim(try promoteOffer(taskId: "task-9", skillId: id)), "an offer after a run is the caret's")
        XCTAssertTrue(b.claim(try promoteOffer(taskId: requestId, skillId: id)))
        var reply = try HelperMemory.Reply.decode(HelperMemoryTests.line("host-memory-7", "memoryReply"))
        reply.requestId = requestId
        b.receive(reply)
        let shown = try row(b, id)
        XCTAssertEqual(shown.question, MemoryBook.OnItsOwnQuestion(offerId: "skill-offer-1", says: "Do this one on your own from now on?", detail: "You'll see it happen and can undo it.", accept: "Do it on its own", decline: "Keep asking"))
        XCTAssertFalse(shown.busy)
        XCTAssertFalse(shown.controls.contains(.onItsOwn), "no second ask while the offer shows")
        XCTAssertEqual(b.debugInfo().questions, [id: "asked"])

        XCTAssertTrue(b.answerOnItsOwn(id, accept: true))
        XCTAssertEqual(answers().map(\.id), ["skill-offer-1"])
        XCTAssertEqual(answers().map(\.answer), [.accept])
        XCTAssertTrue(try row(b, id).busy, "waits for the helper to take it")
        XCTAssertFalse(b.answerOnItsOwn(id, accept: true), "answered once")
        let lists = sent().filter { $0.op == .list }.count
        XCTAssertTrue(b.withdrawn(OfferWithdrawn(at: 1, id: "skill-offer-1", reason: .taken)))
        XCTAssertNil(b.state.questions[id])
        XCTAssertEqual(sent().filter { $0.op == .list }.count, lists + 1, "the list says it now runs on its own")
        XCTAssertEqual(b.state.changed, id)
        XCTAssertNil(b.state.problems[id])
    }

    func testNoClosesTheOfferAndAnOfferThatEndsUnansweredSaysSo() throws {
        let (b, sent, answers) = try offeringBook([
            entry("skill", id: "s-1", status: "learning", fields: skillFields(onItsOwn: false)),
            entry("skill", id: "s-2", status: "learning", fields: skillFields(name: "Reply to Mail", onItsOwn: false)),
        ])
        for id in ["s-1", "s-2"] {
            XCTAssertTrue(b.letRunOnItsOwn(id))
            XCTAssertTrue(b.claim(try promoteOffer(id: "o-\(id)", taskId: sent().last!.requestId, skillId: id)))
        }
        XCTAssertTrue(b.answerOnItsOwn("s-1", accept: false))
        XCTAssertNil(b.state.questions["s-1"])
        XCTAssertEqual(answers().map(\.answer), [.decline])
        XCTAssertFalse(b.withdrawn(OfferWithdrawn(at: 1, id: "o-s-1", reason: .dismissed)), "already closed")
        XCTAssertNil(b.state.problems["s-1"])

        XCTAssertTrue(b.withdrawn(OfferWithdrawn(at: 1, id: "o-s-2", reason: .expired)))
        XCTAssertNil(b.state.questions["s-2"])
        XCTAssertEqual(b.state.problems["s-2"], MemoryCheck.onItsOwnEnded)
        XCTAssertTrue(try row(b, "s-2").controls.contains(.onItsOwn), "it can be asked for again")
    }

    func testTheHelpersRefusalShowsOnTheRowAndALateOfferForItIsNotTaken() throws {
        let (b, sent, _) = try offeringBook([entry("skill", id: "s-1", status: "learning", fields: skillFields(onItsOwn: false))])
        XCTAssertTrue(b.letRunOnItsOwn("s-1"))
        let requestId = sent().last!.requestId
        b.receive(HelperMemory.Reply(requestId: requestId, error: "Caret is paused or your settings turn routines off", entries: []))
        XCTAssertEqual(b.state.problems["s-1"], "Caret is paused or your settings turn routines off.")
        XCTAssertNil(b.state.busy["s-1"])
        XCTAssertFalse(b.claim(try promoteOffer(taskId: requestId, skillId: "s-1")))
    }

    func testTheOfferEndsWithTheConnectionAndAnUnsentAnswerSaysSo() throws {
        let (b, sent, _) = try offeringBook([entry("skill", id: "s-1", status: "learning", fields: skillFields(onItsOwn: false))])
        XCTAssertTrue(b.letRunOnItsOwn("s-1"))
        XCTAssertTrue(b.claim(try promoteOffer(taskId: sent().last!.requestId, skillId: "s-1")))
        b.sendAnswer = { _ in false }
        XCTAssertFalse(b.answerOnItsOwn("s-1", accept: true))
        XCTAssertEqual(b.state.problems["s-1"], MemoryCheck.offline)
        XCTAssertNotNil(b.state.questions["s-1"], "still answerable once the link is back")
        b.linkChanged(false)
        XCTAssertEqual(b.state.questions, [:])
    }

    func testOnlyASkillOnItsOwnCanBePutBackOnTab() throws {
        let (b, sent) = try book([
            entry("skill", id: "s-tab", status: "learning", fields: skillFields(onItsOwn: false)),
            entry("about", id: "a-1", fields: #"{"label":"Name","value":"Dana","source":"typed"}"#),
        ])
        let before = sent().count
        XCTAssertFalse(b.backOnTab("s-tab"))
        XCTAssertFalse(b.backOnTab("a-1"))
        XCTAssertEqual(sent().count, before)
    }

    // MARK: - The permissions page

    func testOnlySkillsOnTheirOwnAreNamedOnThePermissionsPage() throws {
        let (b, _) = try book([
            entry("skill", id: "s-own", status: "active", fields: skillFields(onItsOwn: true)),
            entry("skill", id: "s-tab", status: "learning", fields: skillFields(name: "On Tab one", onItsOwn: false)),
            entry("skill", id: "s-paused", status: "paused", fields: skillFields(name: "Paused one", onItsOwn: true)),
        ])
        XCTAssertEqual(MemoryPage.onTheirOwn(b.state), [
            MemoryPage.Exception(id: "s-own", name: "Order to Tracker", when: "When a Tracker window opens with Order and Carrier empty", busy: false, problem: nil),
        ])
    }

    /// The rule sentences no longer say nothing acts without Tab: a promoted skill does (B19).
    func testRuleSentencesTellTheTruthAboutSkills() {
        XCTAssertEqual(MemoryPage.ruleDetail(.writeElsewhere, .actIfApproved), "Skills you let run on their own act without Tab. Anything else, Tab still does.")
        XCTAssertEqual(MemoryPage.ruleDetail(.writeHere, .act), "Skills you let run on their own act without Tab. Anything else, Tab still does.")
        XCTAssertEqual(MemoryPage.ruleDetail(.read, .act), "Caret does it without asking.")
    }
}
