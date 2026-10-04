import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Brief A16, part 1: the permissions page lists each skill on its own under the write rule its runs
/// write under, in words true for that rule's setting, and names a skill the setting holds back.
/// Every rule setting of both write rules is pinned against every kind of skill.
final class PermissionSkillsTests: XCTestCase {
    /// Where a skill's runs wrote, as the helper may report it (`wrote`), or nil when it does not say.
    private enum Wrote: CaseIterable {
        case here, elsewhere, both, unknown

        var json: String {
            switch self {
            case .here: return #","wrote":["writeHere"]"#
            case .elsewhere: return #","wrote":["writeElsewhere"]"#
            case .both: return #","wrote":["writeHere","writeElsewhere"]"#
            case .unknown: return ""
            }
        }
    }

    private func skill(_ id: String, onItsOwn: Bool = true, status: String = "active", wrote: Wrote) -> String {
        let fields = #"{"routineId":"r-\#(id)","name":"Skill \#(id)","trigger":"a Tracker window opens with Order empty","runs":11,"cleanRuns":10,"needed":10,"onItsOwn":\#(onItsOwn),"handsOff":null\#(wrote.json)}"#
        return #"{"kind":"skill","id":"\#(id)","status":"\#(status)","says":"x","evidence":{"count":11,"lastSeen":1790000400000,"app":"Tracker"},"fields":\#(fields)}"#
    }

    private func permission(_ action: HelperMemory.ActionType, _ rule: HelperMemory.Rule) -> String {
        #"{"kind":"permission","id":"permission-\#(action.rawValue)","status":"active","says":"x","evidence":{"count":0,"lastSeen":0,"app":null},"fields":{"action":"\#(action.rawValue)","rule":"\#(rule.rawValue)","fixed":false}}"#
    }

    private func state(_ entries: [String]) throws -> MemoryBook.State {
        let reply = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[\#(entries.joined(separator: ","))]}"#.utf8))
        XCTAssertEqual(reply.unreadable, [], "every test entry decodes")
        var s = MemoryBook.State()
        s.entries = reply.entries
        s.connected = true
        s.loaded = true
        return s
    }

    // MARK: - The words, per rule setting

    /// Whether each write rule's setting lets a skill on its own start without Tab, from the helper's
    /// `mayRunUnasked` (skills.ts), written out rather than computed.
    private static let runs: [HelperMemory.ActionType: [HelperMemory.Rule: Bool]] = [
        .writeHere: [.handoff: false, .ask: true, .actIfApproved: false, .act: true],
        .writeElsewhere: [.handoff: false, .ask: false, .actIfApproved: true, .act: false],
    ]

    /// The block's title and sentence for every setting of both write rules.
    private static let words: [HelperMemory.ActionType: [HelperMemory.Rule: (String, String)]] = {
        let atCaret = "Each run shows at your caret, and ⌘Z undoes it."
        let heldTitle = "Skills this setting holds back"
        return [
            .writeHere: [
                .ask: ("Skills that skip Ask first here", "You let these run on their own, so they fill the window you're in without Tab. \(atCaret)"),
                .act: ("Skills that run on their own here", "They fill the window you're in without Tab. \(atCaret)"),
                .handoff: (heldTitle, "You let these run on their own in the window you're in. At Hand off Caret leaves them to you there. Choose Ask first or Act to let them run, or put them back on Tab."),
                .actIfApproved: (heldTitle, "You let these run on their own in the window you're in. At Act if approved they wait for Tab there. Choose Ask first or Act to let them run, or put them back on Tab."),
            ],
            .writeElsewhere: [
                .actIfApproved: ("Skills you approved for other windows", "They change windows you're not in, without Tab. Each run is in Caret's activity list, with Undo."),
                .ask: (heldTitle, "You let these run on their own in windows you're not in. At Ask first they wait for Tab there. Choose Act if approved to let them run, or put them back on Tab."),
                .handoff: (heldTitle, "You let these run on their own in windows you're not in. At Hand off Caret leaves them to you there. Choose Act if approved to let them run, or put them back on Tab."),
                .act: (heldTitle, "You let these run on their own in windows you're not in. At Act they wait for Tab there. Choose Act if approved to let them run, or put them back on Tab."),
            ],
        ]
    }()

    /// Which skills each write row lists: a skill under every rule it wrote under, whether the setting
    /// lets it run there or holds it back; a skill whose writes are unknown only where it may run now.
    private static func expectedListed(_ wrote: Wrote, under action: HelperMemory.ActionType, runs: Bool) -> Bool {
        switch (wrote, action) {
        case (.here, .writeHere), (.elsewhere, .writeElsewhere), (.both, _): return true
        case (.unknown, _): return runs
        default: return false
        }
    }

    func testEverySettingOfBothWriteRulesAgainstEveryKindOfSkill() throws {
        for action in [HelperMemory.ActionType.writeHere, .writeElsewhere] {
            for rule in HelperMemory.Rule.allCases {
                for wrote in Wrote.allCases {
                    let label = "\(action.rawValue) at \(rule.rawValue), skill wrote \(wrote)"
                    let s = try state([
                        permission(action, rule),
                        skill("own", wrote: wrote),
                        skill("tab", onItsOwn: false, status: "learning", wrote: wrote),
                        skill("paused", status: "paused", wrote: wrote),
                    ])
                    let runs = try XCTUnwrap(Self.runs[action]?[rule])
                    XCTAssertEqual(PermissionPolicy.skillRunsUnasked(action, rule), runs, label)
                    let block = MemoryPage.exceptions(s, under: action)
                    guard Self.expectedListed(wrote, under: action, runs: runs) else {
                        XCTAssertNil(block, "\(label): not listed here")
                        continue
                    }
                    let b = try XCTUnwrap(block, "\(label): listed here")
                    XCTAssertEqual(b.skills.map(\.id), ["own"], "\(label): only the skill on its own; on Tab and paused ones skip nothing")
                    XCTAssertEqual(b.runs, runs, label)
                    let (title, detail) = try XCTUnwrap(Self.words[action]?[rule])
                    XCTAssertEqual(b.title, title, label)
                    XCTAssertEqual(b.detail, detail, label)
                }
            }
        }
    }

    /// A15's render: a skill under "Undoable changes in other apps" at Ask first said "These skip Ask
    /// first", which that rule never lets it do. Now a skill whose writes are unknown is not listed
    /// there, and one that wrote there is shown as held back.
    func testTheA15ContradictionIsGone() throws {
        let unknown = try state([permission(.writeHere, .ask), permission(.writeElsewhere, .ask), skill("s", wrote: .unknown)])
        XCTAssertNil(MemoryPage.exceptions(unknown, under: .writeElsewhere))
        XCTAssertEqual(MemoryPage.exceptions(unknown, under: .writeHere)?.title, "Skills that skip Ask first here")
        let wroteElsewhere = try state([permission(.writeHere, .ask), permission(.writeElsewhere, .ask), skill("s", wrote: .elsewhere)])
        XCTAssertNil(MemoryPage.exceptions(wroteElsewhere, under: .writeHere), "it never wrote where you are")
        let held = try XCTUnwrap(MemoryPage.exceptions(wroteElsewhere, under: .writeElsewhere))
        XCTAssertFalse(held.runs)
        XCTAssertEqual(held.title, "Skills this setting holds back")
    }

    func testNoBlockWithoutTheRuleOrUnderOtherActions() throws {
        let s = try state([skill("s", wrote: .both), permission(.outbound, .ask)])
        XCTAssertNil(MemoryPage.exceptions(s, under: .writeHere), "no row, no block")
        XCTAssertNil(MemoryPage.exceptions(s, under: .outbound), "a skill's runs never write under Send")
    }

    func testTheDebugStateNamesEachBlock() throws {
        let book = MemoryBook(clock: ManualClock())
        var sent: [HelperMemory.Request] = []
        book.send = { sent.append($0); return true }
        book.linkChanged(true)
        var r = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[\#([permission(.writeHere, .ask), permission(.writeElsewhere, .ask), skill("s", wrote: .both)].joined(separator: ","))]}"#.utf8))
        r.requestId = sent.last!.requestId
        book.receive(r)
        let info = book.debugInfo()
        XCTAssertEqual(info.onTheirOwn, ["Skill s"])
        XCTAssertEqual(info.underRules, [
            .init(action: "writeHere", rule: "ask", runs: true, title: "Skills that skip Ask first here", skills: ["Skill s"]),
            .init(action: "writeElsewhere", rule: "ask", runs: false, title: "Skills this setting holds back", skills: ["Skill s"]),
        ])
    }

    // MARK: - The rule sentences

    func testRuleSentencesForTheWriteRulesAtEverySetting() {
        let tab = "Caret offers it, and Tab does it."
        let skills = "Skills you let run on their own act without Tab. Anything else, Tab still does."
        XCTAssertEqual(MemoryPage.ruleDetail(.writeHere, .ask), "Caret offers it, and Tab does it. A skill that keeps getting it right may ask to run on its own.")
        XCTAssertEqual(MemoryPage.ruleDetail(.writeHere, .act), skills)
        XCTAssertEqual(MemoryPage.ruleDetail(.writeHere, .actIfApproved), tab, "the helper lets no skill run unasked here at this setting")
        XCTAssertEqual(MemoryPage.ruleDetail(.writeHere, .handoff), "Caret leaves it to you.")
        XCTAssertEqual(MemoryPage.ruleDetail(.writeElsewhere, .ask), "Caret offers it, and Tab does it. No skill runs on its own here at this setting.")
        XCTAssertEqual(MemoryPage.ruleDetail(.writeElsewhere, .actIfApproved), skills)
        XCTAssertEqual(MemoryPage.ruleDetail(.writeElsewhere, .act), tab)
        XCTAssertEqual(MemoryPage.ruleDetail(.writeElsewhere, .handoff), "Caret leaves it to you.")
        XCTAssertEqual(MemoryPage.ruleDetail(.outbound, .act), tab, "nothing sends without Tab")
    }

    // MARK: - The helper's rule and the contract

    /// The host's mirror is the helper's `mayRunUnasked`, read from its source.
    func testTheMirrorMatchesTheHelpersMayRunUnasked() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../helper/src/patterns/skills.ts").standardized
        let text = try String(contentsOf: source, encoding: .utf8)
        let body = try XCTUnwrap(text.range(of: #"export function mayRunUnasked\([^)]*\): boolean \{\s*([^}]*)\}"#, options: .regularExpression).map { String(text[$0]) })
        XCTAssertTrue(body.contains(#"return action === "writeHere" ? rule === "ask" || rule === "act" : rule === "actIfApproved";"#),
                      "skills.ts mayRunUnasked changed; update PermissionPolicy.skillRunsUnasked and this test: \(body)")
    }

    /// The contract line (Fixtures/memory.ndjson): a skill's `wrote`, and what the host refuses.
    func testWroteIsReadFromTheContractAndAnythingElseIsRefused() throws {
        let contract = try HelperMemoryTests.reply(9)
        XCTAssertEqual(contract.entries.first?.wrote, [.writeElsewhere])
        XCTAssertNil(try state([skill("s", wrote: .unknown)]).entries.first?.wrote, "today's helper does not say")
        let bad = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[\#(skill("s", wrote: .here).replacingOccurrences(of: "writeHere", with: "outbound"))]}"#.utf8))
        XCTAssertEqual(bad.entries, [])
        XCTAssertEqual(bad.unreadable.count, 1, "a skill's runs write only here or elsewhere")
        let misplaced = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"about","id":"a","status":"active","says":"x","evidence":{"count":1,"lastSeen":0,"app":null},"fields":{"label":"Name","value":"Dana","source":"typed","wrote":["writeHere"]}}]}"#.utf8))
        XCTAssertEqual(misplaced.entries, [])
        XCTAssertEqual(misplaced.unreadable.count, 1, "only skills say where they wrote")
        let unknownKind = try HelperMemory.Reply.decode(Data(#"{"type":"memoryReply","v":1,"requestId":"r","error":null,"entries":[{"kind":"habit","id":"h","status":"active","says":"x","evidence":{"count":1,"lastSeen":0,"app":null},"fields":{"wrote":["writeHere"]}}]}"#.utf8))
        XCTAssertEqual(unknownKind.entries.map(\.id), ["h"], "a newer helper's kind is kept whatever its fields hold")
    }
}
