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

    private func skillFields(name: String = "Order to Tracker", onItsOwn: Bool, cleanRuns: Int = 10, handsOff: String = "null") -> String {
        #"{"routineId":"routine-1","name":"\#(name)","trigger":"a Tracker window opens with Order and Carrier empty","runs":11,"cleanRuns":\#(cleanRuns),"needed":10,"onItsOwn":\#(onItsOwn),"handsOff":\#(handsOff)}"#
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
        r.requestId = sent.last!.requestId
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
            entry("noticed", id: "h-2", says: "A kind named like the host's own label", fields: #"{"x":1}"#),
            entry("preference", id: "p-1", fields: #"{"rule":"shout"}"#),
        ])
        XCTAssertEqual(r.entries.map(\.id), ["h-1", "h-2"])
        XCTAssertEqual(r.entries.first?.fields, .noticed(kind: "habit"))
        XCTAssertEqual(r.unreadable.count, 1, "a known kind with fields this host cannot read is still counted, not guessed")
        var state = MemoryBook.State()
        state.entries = r.entries
        state.connected = true
        state.loaded = true
        let section = try XCTUnwrap(MemoryPage.sections(state, now: Date()).first { $0.kind == .noticed })
        XCTAssertEqual(section.title, "Something Caret noticed")
        XCTAssertEqual(section.rows.map(\.title), ["You archive receipts on Fridays", "A kind named like the host's own label"])
        XCTAssertEqual(section.rows.first?.controls, [.forget], "it can be forgotten; nothing else is guessed at")
        XCTAssertNil(MemoryPage.sections(MemoryBook.State(), now: Date()).first { $0.kind == .noticed }, "no section while there is nothing")
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

    /// The host's contract line for "Put back on Tab" (Fixtures/memory.ndjson, last line), and what
    /// the row says when today's helper refuses it.
    func testPutBackOnTabIsTheContractEditAndARefusalSaysWhatStillWorks() throws {
        let (b, sent) = try book([entry("skill", id: "skill-5e6f7a8b", status: "active", fields: skillFields(onItsOwn: true))])
        XCTAssertTrue(b.backOnTab("skill-5e6f7a8b"))
        var request = try XCTUnwrap(sent().last)
        XCTAssertEqual(b.state.busy["skill-5e6f7a8b"], .backOnTab)
        let contract = try XCTUnwrap(HelperMemoryTests.lines().last)
        let id = request.requestId
        request.requestId = "host-memory-6"
        XCTAssertEqual(try JSONSerialization.jsonObject(with: request.line()) as? NSDictionary, try JSONSerialization.jsonObject(with: contract) as? NSDictionary)
        b.receive(HelperMemory.Reply(requestId: id, error: "invalid edit: unrecognized key onItsOwn", entries: []))
        XCTAssertEqual(b.state.problems["skill-5e6f7a8b"], "This version of Caret can't put a skill back on Tab yet. Pause it to stop it running, or Forget it.")
        XCTAssertEqual(b.debugInfo().problems["skill-5e6f7a8b"], "This version of Caret can't put a skill back on Tab yet. Pause it to stop it running, or Forget it. [helper: invalid edit: unrecognized key onItsOwn]")
        XCTAssertEqual(MemoryPage.onTheirOwn(b.state).first?.problem, b.state.problems["skill-5e6f7a8b"], "the permissions page shows the same refusal")
        XCTAssertNil(b.state.busy["skill-5e6f7a8b"])
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
