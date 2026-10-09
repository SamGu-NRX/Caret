@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// What the host takes from v2/next (H1): it names valueChecks and askScope in its hello, as the helper spells them; it
/// offers nothing for a value whose identity entry changed; its Ask card lists the fields a plan leaves to the user
/// (ask-left.ndjson); and the page panel shows the helper's new withheld and left-to-you sentences as withheld rows.
final class WireH1Tests: XCTestCase {
    static let names = ["value-checks", "ask-left", "ask-task"]

    /// The repository root, five levels above Fixtures.
    static var repo: URL {
        WireH11Tests.fixtures.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    /// The text of a helper source file, for the constants the host repeats.
    static func helperSource(_ path: String) throws -> String {
        try String(contentsOf: repo.appendingPathComponent("helper/src/\(path)"), encoding: .utf8)
    }

    /// The string a helper source file assigns to `export const <name> = "…";`.
    static func helperConstant(_ name: String, in path: String) throws -> String {
        let text = try helperSource(path)
        let prefix = "export const \(name) = \""
        let start = try XCTUnwrap(text.range(of: prefix), "\(path) has no \(name)")
        let rest = text[start.upperBound...]
        let end = try XCTUnwrap(rest.firstIndex(of: "\""))
        return String(rest[..<end])
    }

    func testTheFixtureCopiesAreTheHelpersGoldenFiles() throws {
        for name in Self.names {
            let copy = try Data(contentsOf: WireH11Tests.fixtures.appendingPathComponent("\(name).ndjson"))
            let golden = try Data(contentsOf: Self.repo.appendingPathComponent("helper/fixtures/golden/\(name).ndjson"))
            XCTAssertEqual(copy, golden, "Fixtures/\(name).ndjson differs from helper/fixtures/golden/\(name).ndjson")
        }
    }

    // MARK: - Hello

    func testTheHelloNamesValueChecksAndAskScopeAsTheHelperSpellsThem() throws {
        XCTAssertEqual(HostHello.valueChecksCapability, try Self.helperConstant("VALUE_CHECKS_CAPABILITY", in: "protocol.ts"))
        XCTAssertEqual(HostHello.askScopeCapability, try Self.helperConstant("ASK_SCOPE_CAPABILITY", in: "protocol.ts"))
        for routing in [false, true] {
            for goalFiles in [false, true] {
                let caps = HostHello.capabilities(routing: routing, goalFiles: goalFiles)
                XCTAssertTrue(caps.contains(HostHello.valueChecksCapability))
                XCTAssertTrue(caps.contains(HostHello.askScopeCapability))
            }
        }
        // The golden hello of a host that reads the new reasons names the capability the same way.
        let hello = try WireH11Tests.object(try XCTUnwrap(try WireH11Tests.lines("value-checks").first))
        XCTAssertTrue((hello["capabilities"] as? [String])?.contains(HostHello.valueChecksCapability) == true)
    }

    // MARK: - Fill

    /// value-checks.ndjson's proposal with the full name resting on the user's identity in memory entry mem-name-1.
    func identityProposal() throws -> FillProposal {
        let line = String(decoding: try WireH11Tests.lines("value-checks")[2], as: UTF8.self)
        let asks = #""asks":[{"choice":"c1","confidence":0.9,"value":"Robin Vale"},{"choice":"v1","confidence":0.91,"value":"Robin Vale"}]"#
        XCTAssertTrue(line.contains(asks))
        let basis = #","basis":{"identity":{"memoryId":"mem-name-1","kind":"name","key":"robin vale"}}"#
        return try JSONDecoder().decode(FillProposal.self, from: Data(line.replacingOccurrences(of: asks, with: asks + basis).utf8))
    }

    func testAValueRestingOnAnIdentityThatChangedIsNotOffered() throws {
        let p = try identityProposal()
        let key = p.fields[0].key
        let frame = Frame(x: 10, y: 10, width: 200, height: 24)
        func select(changed: Set<String>) -> FillSelection.Result {
            FillSelection.select(p, focusedFrame: frame, focusedValue: "", secure: false, changedMemory: changed, focusedElementID: "e1", bound: [key: "e1"])
        }
        guard case .offer(let field, _) = select(changed: []) else { return XCTFail("the unchanged identity's value is offered") }
        XCTAssertEqual(field.value, "Robin Vale")
        XCTAssertEqual(select(changed: ["mem-name-1"]), .skip(.memoryChanged))
        guard case .offer = select(changed: ["mem-other"]) else { return XCTFail("another entry's change leaves it offered") }
    }

    /// Review H1-1: the offer is already up when the user edits the identity entry the window's value rests on.
    func testAShownValueRestingOnAnIdentityGoesDownWhenItsEntryChanges() {
        let entry = "about-own-email"
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose(FillFx.proposal(identity: [.email: entry]))
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(FillFx.caption) showLine"])
        XCTAssertEqual(rig.arbiter.snapshot().current?.kind.fillOrigin?.identityMemoryID, entry)
        let shownID = rig.machine.shownOfferID
        rig.clock.advance(by: 1)
        rig.machine.memoryChanged(id: "about-name")
        XCTAssertEqual(rig.takeLog(), [], "another entry's change leaves it up")
        XCTAssertEqual(rig.arbiter.snapshot().current?.id, shownID)
        rig.machine.memoryChanged(id: entry)
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
        XCTAssertNil(rig.arbiter.snapshot().current, "Tab passes through once the value is gone")
        XCTAssertEqual(rig.machine.status.lastSkip, "memoryChanged")
        rig.machine.fieldChanged(pid: Fx.app, at: 3)
        XCTAssertNil(rig.arbiter.snapshot().current, "the held proposal is not offered from the changed identity again")
    }

    func testTheNewWithheldReasonsOfferNothing() throws {
        let p = try identityProposal()
        let frame = Frame(x: 10, y: 10, width: 200, height: 24)
        for field in p.fields.dropFirst() {
            XCTAssertNotNil(field.withheld)
            XCTAssertEqual(FillSelection.select(p, focusedFrame: frame, focusedValue: "", secure: false, focusedElementID: "e1", bound: [field.key: "e1"]), .skip(.withheld))
        }
    }

    // MARK: - The Ask card

    func testTheAskCardsLeftLabelsAreTheHelpers() throws {
        let helper = [try Self.helperConstant("YOU_TYPE_LABEL", in: "planner/proposal.ts"), try Self.helperConstant("LEFT_TO_YOU_LABEL", in: "planner/proposal.ts")]
        XCTAssertEqual(AskCopy.leftLabels, Set(helper))
    }

    func testTheAskCardListsTheFieldsLeftToTheUserBeforeThePress() throws {
        let p = try JSONDecoder().decode(PlanProposal.self, from: try XCTUnwrap(try WireH11Tests.lines("ask-left").first))
        let card = try XCTUnwrap(AskCaret.card(p))
        XCTAssertEqual(card.title, "Fill Customer name in Pizza Shop")
        XCTAssertEqual(card.steps.map(\.text), [
            "Put \u{201C}Jordan Reyes\u{201D} in Customer name",
            "Social Security number is yours to type. Caret doesn't type Social Security numbers",
            "Telephone: Caret wasn't sure your request asks for it",
            "E-mail address: Caret wasn't sure your request asks for it",
            "Pizza Size: Caret wasn't sure your request asks for it",
            "Bacon: Caret wasn't sure your request asks for it",
            "Extra Cheese: Caret wasn't sure your request asks for it",
            "and 2 more Caret wasn't sure about",
            "Press Place order",
        ])
        XCTAssertEqual(card.steps.map(\.yours), [false] + Array(repeating: true, count: 8))
        XCTAssertEqual(card.writes, 1)
        // The plan's hand-off step (after its one write) is still the press, the card's last row.
        XCTAssertEqual(AskCaret.cardIndex(ofPlanStep: 1, in: card), card.steps.count - 1)
        // Left rows are the user's: a finished run counts one field filled, not the rows it leaves.
        var done = card
        for i in done.steps.indices where !done.steps[i].yours { done.steps[i].state = .done }
        XCTAssertEqual(AskCaret.filled(done), 1)
    }

    /// Only the left-to-you blocks: a facts block under another label (the press, a calendar) adds no step.
    func testAFactsBlockUnderAnotherLabelAddsNoStep() throws {
        let line = String(decoding: try XCTUnwrap(try WireH11Tests.lines("ask-left").first), as: UTF8.self)
        let other = line.replacingOccurrences(of: #""label":"Left to you""#, with: #""label":"Calendar""#)
            .replacingOccurrences(of: #""label":"You type""#, with: #""label":"Noticed""#)
        XCTAssertNotEqual(other, line)
        let card = try XCTUnwrap(AskCaret.card(try JSONDecoder().decode(PlanProposal.self, from: Data(other.utf8))))
        XCTAssertEqual(card.steps.map(\.text), ["Put \u{201C}Jordan Reyes\u{201D} in Customer name", "Press Place order"])
    }

    // MARK: - The page panel

    /// The helper's own sentences for the new reasons and I3's unsure fields (goals/page-planner.ts WITHHELD_SAYS and
    /// planner/says.ts UNSURE_FIELD, as lower.ts closes each), shown whole as withheld rows after the fields, in order.
    func testThePagePanelShowsTheNewReasonsAsWithheldRows() throws {
        let sentences = [
            "'Job title' is yours: the value Caret found isn't exactly what the field asks for.",
            "'Company' is yours: Caret couldn't check this value just now.",
            "'Q41' is yours: your request didn't ask Caret to fill it.",
            "'Pizza Size' is yours: Caret wasn't sure your request asks for it.",
        ]
        let says = try Self.helperSource("goals/page-planner.ts") + (try Self.helperSource("planner/says.ts"))
        for s in sentences {
            let reason = String(try XCTUnwrap(s.split(separator: ":", maxSplits: 1).last).dropFirst().dropLast())
            XCTAssertTrue(says.contains("\"\(reason)\""), "the helper says \(reason)")
        }
        let lines = try WireH11Tests.lines("goal-handoff")
        let m = try JSONDecoder().decode(GoalProgress.self, from: lines[2])
        guard case .segment(var p) = m.event else { return XCTFail("line 3 is a segment") }
        p.page = .init(windowId: "page:eng1:7", app: AppRef(pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome"),
                       anchor: nil, viewport: nil, from: "Notes", rows: [.init(step: 0, label: "Full name", value: "Robin Vale", picked: false)], attach: [])
        p.warnings = sentences
        let task = try XCTUnwrap(PageTask(preview: p, goalId: m.goalId))
        let panel = PageTaskPanel(task: task, stoppable: false)
        let rows = panel.sections[0].lines
        XCTAssertEqual(rows.filter { $0.kind == .withheld }.map(\.text), sentences)
        let field = try XCTUnwrap(rows.firstIndex { $0.kind == .field && $0.label == "Full name" && $0.text == "Robin Vale" }, "the write's field row")
        let firstWithheld = try XCTUnwrap(rows.firstIndex { $0.kind == .withheld })
        XCTAssertLessThan(field, firstWithheld, "withheld rows come after the fields")
        XCTAssertEqual(rows.count - firstWithheld, sentences.count, "and are the panel's last rows")
        XCTAssertTrue(rows[firstWithheld...].allSatisfy { $0.kind == .withheld && $0.state == nil && $0.label == nil })
        for s in sentences { XCTAssertTrue(panel.spoken.contains(s), "VoiceOver reads \(s)") }
    }
}
