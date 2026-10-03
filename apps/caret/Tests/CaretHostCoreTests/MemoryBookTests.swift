import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The memory window's logic against a manual clock and a recorded socket: what is sent for each
/// control, what each reply does, and what is refused before anything is sent.
final class MemoryBookTests: XCTestCase {
    final class Rig {
        let clock = ManualClock()
        let book: MemoryBook
        var sent: [HelperMemory.Request] = []
        /// Whether the socket takes a write.
        var accepts = true

        init(connected: Bool = true, listed: Bool = true) throws {
            book = MemoryBook(clock: clock)
            book.send = { [unowned self] r in
                guard self.accepts else { return false }
                self.sent.append(r)
                return true
            }
            if connected { book.linkChanged(true) }
            if connected, listed { answer(try HelperMemoryTests.reply(1)) }
        }

        var state: MemoryBook.State { book.state }
        var last: HelperMemory.Request? { sent.last }

        /// Answers the last request with `reply`, renamed to its id.
        func answer(_ reply: HelperMemory.Reply) {
            var r = reply
            r.requestId = sent.last!.requestId
            book.receive(r)
        }

        func refuse(_ error: String) { answer(HelperMemory.Reply(requestId: "", error: error, entries: [])) }

        func entry(_ id: String) -> HelperMemory.Entry? { state.entries.first { $0.id == id } }
    }

    static let about = "about-1a2b3c4d"
    static let routine = "routine-2c3d4e5f"

    // MARK: - Listing

    func testConnectingListsAndTheReplyFillsTheBook() throws {
        let rig = try Rig(listed: false)
        XCTAssertEqual(rig.sent.map(\.op), [.list])
        XCTAssertFalse(rig.state.loaded)
        rig.answer(try HelperMemoryTests.reply(1))
        XCTAssertTrue(rig.state.loaded)
        XCTAssertEqual(rig.state.entries.count, 13)
    }

    func testOneListAtATime() throws {
        let rig = try Rig(listed: false)
        rig.book.requestList()
        rig.book.requestList()
        XCTAssertEqual(rig.sent.count, 1)
    }

    func testAReplyToSomeoneElsesRequestIsIgnored() throws {
        let rig = try Rig()
        var other = try HelperMemoryTests.reply(1)
        other.requestId = "not-ours"
        other.entries = []
        rig.book.receive(other)
        XCTAssertEqual(rig.state.entries.count, 13)
    }

    func testAListThatIsNeverAnsweredSaysSo() throws {
        let rig = try Rig(listed: false)
        rig.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertEqual(rig.state.listProblem, "Caret didn't answer. Try again.")
        XCTAssertEqual(rig.clock.live, 0)
    }

    func testLosingTheHelperKeepsTheEntriesButStopsEveryRequest() throws {
        let rig = try Rig()
        XCTAssertTrue(rig.book.pause(Self.about))
        rig.book.linkChanged(false)
        XCTAssertEqual(rig.state.entries.count, 13, "the last list stays on screen")
        XCTAssertEqual(rig.state.busy, [:])
        XCTAssertEqual(rig.clock.live, 0, "no timeout left for a request whose answer cannot come")
        let before = rig.sent.count
        XCTAssertFalse(rig.book.pause(Self.about))
        XCTAssertEqual(rig.sent.count, before)
        let rows = MemoryPage.sections(rig.state, now: Date())
        XCTAssertTrue(rows[0].rows[0].busy, "controls are off while disconnected")
        rig.book.linkChanged(true)
        XCTAssertEqual(rig.last?.op, .list)
    }

    // MARK: - Pause, resume, forget

    func testPauseSendsAndTheRowChangesOnlyWhenTheHelperSaysSo() throws {
        let rig = try Rig()
        XCTAssertTrue(rig.book.pause(Self.about))
        XCTAssertEqual(rig.last, HelperMemory.Request(requestId: rig.last!.requestId, op: .pause, id: Self.about))
        XCTAssertEqual(rig.state.busy[Self.about], .pause)
        XCTAssertEqual(rig.entry(Self.about)?.status, .active, "not before the reply")
        XCTAssertFalse(rig.book.pause(Self.about), "one request per row at a time")
        var paused = try XCTUnwrap(rig.entry(Self.about))
        paused.status = .paused
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: [paused]))
        XCTAssertEqual(rig.entry(Self.about)?.status, .paused)
        XCTAssertNil(rig.state.busy[Self.about])
        XCTAssertEqual(rig.state.changed, Self.about)
        XCTAssertEqual(rig.last?.op, .list, "listed again: other sentences may quote this entry")
    }

    func testResumeOnlyWhatIsPausedAndPauseOnlyWhatIsNot() throws {
        let rig = try Rig()
        XCTAssertFalse(rig.book.resume(Self.about))
        XCTAssertFalse(rig.book.pause("people-5e6f7a8b"), "already paused")
        XCTAssertTrue(rig.book.resume("people-5e6f7a8b"))
        XCTAssertFalse(rig.book.pause("permission-writeHere"), "a permission takes a rule instead")
    }

    func testForgetAsksFirstThenSendsAndRemovesTheRow() throws {
        let rig = try Rig()
        let before = rig.sent.count
        rig.book.askToForget(Self.routine)
        XCTAssertEqual(rig.state.confirmingForget, Self.routine)
        XCTAssertEqual(rig.sent.count, before, "nothing sent before the confirmation")
        rig.book.keep()
        XCTAssertNil(rig.state.confirmingForget)
        rig.book.askToForget(Self.routine)
        XCTAssertTrue(rig.book.confirmForget())
        XCTAssertEqual(rig.last?.op, .forget)
        XCTAssertEqual(rig.last?.id, Self.routine)
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: []))
        XCTAssertNil(rig.entry(Self.routine))
        XCTAssertEqual(rig.last?.op, .list)
    }

    /// A fill held from before an edit, pause, forget or replacing add must not offer the old value
    /// (`FillMachine.memoryChanged`); a resume or a refusal changes no value.
    func testEveryAcceptedChangeToAnEntryIsReported() throws {
        let rig = try Rig()
        var changed: [String] = []
        rig.book.onEntryChanged = { changed.append($0) }
        XCTAssertTrue(rig.book.pause(Self.about))
        var paused = try XCTUnwrap(rig.entry(Self.about))
        paused.status = .paused
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: [paused]))
        XCTAssertEqual(changed, [Self.about])
        rig.answer(try HelperMemoryTests.reply(1))
        XCTAssertTrue(rig.book.resume("people-5e6f7a8b"))
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: []))
        XCTAssertEqual(changed, [Self.about], "a resume changes no value")
        rig.answer(try HelperMemoryTests.reply(1))
        rig.book.askToForget(Self.routine)
        rig.book.confirmForget()
        rig.refuse("no")
        XCTAssertEqual(changed, [Self.about], "a refused forget changes nothing")
        rig.book.askToForget(Self.routine)
        rig.book.confirmForget()
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: []))
        XCTAssertEqual(changed, [Self.about, Self.routine])
    }

    func testAnAcceptedEditAndAReplacingAddAreReported() throws {
        let rig = try Rig()
        var changed: [String] = []
        rig.book.onEntryChanged = { changed.append($0) }
        rig.book.beginEdit(Self.about)
        rig.book.updateDraft("value", "Marcus Lowe")
        XCTAssertTrue(rig.book.saveEdit())
        var edited = try XCTUnwrap(rig.entry(Self.about))
        edited.says = "Name: Marcus Lowe"
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: [edited]))
        XCTAssertEqual(changed, [Self.about])
        rig.answer(try HelperMemoryTests.reply(1))
        changed = []
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        let kept = try HelperMemoryTests.reply(5)
        rig.answer(kept)
        XCTAssertEqual(changed, kept.entries.map(\.id), "the add's entry, which may have replaced a value under its label")
    }

    /// A Forget whose reply came after the book stopped waiting: the next list shows the entry gone,
    /// and that is reported, so a held fill does not offer it.
    func testAListReportsAChangeWhoseReplyCameTooLate() throws {
        let rig = try Rig()
        var changed: [String] = []
        rig.book.onEntryChanged = { changed.append($0) }
        rig.book.askToForget(Self.about)
        XCTAssertTrue(rig.book.confirmForget())
        rig.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertEqual(changed, [], "no answer is no change")
        XCTAssertEqual(rig.last?.op, .list, "the book reads the list again")
        var listed = try HelperMemoryTests.reply(1)
        listed.entries.removeAll { $0.id == Self.about }
        rig.answer(listed)
        XCTAssertEqual(changed, [Self.about])
        rig.book.requestList()
        rig.answer(listed)
        XCTAssertEqual(changed, [Self.about], "an unchanged list reports nothing")
    }

    func testARefusalShowsOnTheRowAndTheEntryStays() throws {
        let rig = try Rig()
        rig.book.askToForget(Self.about)
        rig.book.confirmForget()
        rig.refuse("no memory entry about-1a2b3c4d")
        XCTAssertEqual(rig.state.problems[Self.about], "no memory entry about-1a2b3c4d")
        XCTAssertNotNil(rig.entry(Self.about))
        let row = MemoryPage.sections(rig.state, now: Date())[0].rows[0]
        XCTAssertEqual(row.problem, "no memory entry about-1a2b3c4d")
    }

    func testARequestNeverAnsweredFreesItsRow() throws {
        let rig = try Rig()
        rig.book.pause(Self.about)
        rig.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertNil(rig.state.busy[Self.about])
        XCTAssertEqual(rig.state.problems[Self.about], "Caret didn't answer. Try again.")
        XCTAssertTrue(rig.book.pause(Self.about), "it can be tried again")
    }

    // MARK: - Edit

    func testEditingAnAboutValueSendsOnlyWhatChanged() throws {
        let rig = try Rig()
        rig.book.beginEdit(Self.about)
        XCTAssertEqual(rig.state.editor?.fields.map(\.key), ["label", "value"])
        rig.book.updateDraft("value", "  Marcus Lowe, Operations ")
        XCTAssertTrue(rig.book.saveEdit())
        XCTAssertEqual(rig.last?.fields, ["value": .text("Marcus Lowe, Operations")])
        XCTAssertEqual(rig.state.editor?.saving, true)
        rig.answer(try HelperMemoryTests.reply(3))
        XCTAssertNil(rig.state.editor)
        XCTAssertEqual(rig.entry(Self.about)?.about?.value, "Marcus Lowe, Operations")
        XCTAssertEqual(rig.last?.op, .list)
    }

    func testAnEditWithNoChangeClosesWithoutSending() throws {
        let rig = try Rig()
        let before = rig.sent.count
        rig.book.beginEdit(Self.about)
        XCTAssertFalse(rig.book.saveEdit())
        XCTAssertNil(rig.state.editor)
        XCTAssertEqual(rig.sent.count, before)
    }

    func testTheHostChecksAnEditBeforeSending() throws {
        let rig = try Rig()
        let before = rig.sent.count
        let cases: [(String, String, String, String)] = [
            (Self.about, "value", "   ", "Value can't be empty. To remove it, use Forget."),
            (Self.about, "value", String(repeating: "x", count: 501), "Value is too long. Keep it under 500 characters."),
            (Self.about, "label", String(repeating: "x", count: 81), "Label is too long. Keep it under 80 characters."),
            ("people-5e6f7a8b", "name", "", "Means can't be empty."),
            ("preference-0c1d2e3f", "template", "512-###-####", "Use one # for each digit, 7 to 15 of them, like ###-###-####."),
            ("preference-0c1d2e3f", "template", "###-###", "Use one # for each digit, 7 to 15 of them, like ###-###-####."),
            (Self.routine, "name", String(repeating: "r", count: 81), "Name is too long. Keep it under 80 characters."),
        ]
        for (id, key, text, problem) in cases {
            rig.book.beginEdit(id)
            rig.book.updateDraft(key, text)
            XCTAssertFalse(rig.book.saveEdit(), "\(id) \(key)")
            XCTAssertEqual(rig.state.editor?.problem, problem, "\(id) \(key)")
            rig.book.updateDraft(key, rig.state.editor!.fields.first { $0.key == key }!.original)
            XCTAssertNil(rig.state.editor?.problem, "typing clears the problem")
            rig.book.cancelEdit()
        }
        XCTAssertEqual(rig.sent.count, before)
    }

    func testAnEmojiCountsAsJavaScriptCountsIt() {
        // 40 emoji are 80 UTF-16 units: at the label limit, not over it.
        XCTAssertNil(MemoryCheck.problem(kind: .about, [MemoryBook.Draft(key: "label", title: "Label", text: String(repeating: "🙂", count: 40), original: "")]))
        XCTAssertNotNil(MemoryCheck.problem(kind: .about, [MemoryBook.Draft(key: "label", title: "Label", text: String(repeating: "🙂", count: 41), original: "")]))
    }

    func testClearingARoutinesNameSendsNull() throws {
        var reply = try HelperMemoryTests.reply(1)
        guard case .routine(var f) = reply.entries[5].fields else { return XCTFail("not a routine") }
        f.name = "Order to tracker"
        reply.entries[5].fields = .routine(f)
        let rig = try Rig(listed: false)
        rig.answer(reply)
        rig.book.beginEdit(Self.routine)
        rig.book.updateDraft("name", "")
        XCTAssertTrue(rig.book.saveEdit())
        XCTAssertEqual(rig.last?.fields, ["name": .null])
    }

    func testTheHelpersRefusalStaysInTheEditor() throws {
        let rig = try Rig()
        rig.book.beginEdit(Self.about)
        rig.book.updateDraft("value", "x@y.example")
        rig.book.saveEdit()
        rig.refuse("invalid edit: value: Too big")
        XCTAssertEqual(rig.state.editor?.problem, "invalid edit: value: Too big")
        XCTAssertEqual(rig.state.editor?.saving, false)
        XCTAssertEqual(rig.state.editor?.fields.first { $0.key == "value" }?.text, "x@y.example", "the draft is kept")
    }

    func testNothingToEditMeansNoEditor() throws {
        let rig = try Rig()
        for id in ["preference-4a5b6c7d", "preference-8e9f0a1b", "permission-writeHere"] {
            rig.book.beginEdit(id)
            XCTAssertNil(rig.state.editor, id)
        }
        let rows = MemoryPage.sections(rig.state, now: Date())[2].rows
        XCTAssertEqual(rows.map(\.controls), [[.edit, .pause, .forget], [.pause, .forget], [.pause, .forget]])
    }

    func testAListWithoutTheEditedEntryClosesTheEditor() throws {
        let rig = try Rig()
        rig.book.beginEdit(Self.about)
        rig.book.requestList()
        var reply = try HelperMemoryTests.reply(1)
        reply.entries.removeFirst()
        rig.answer(reply)
        XCTAssertNil(rig.state.editor)
    }

    func testTypingWhileSavingIsRefusedSoNothingIsLost() throws {
        let rig = try Rig()
        rig.book.beginEdit(Self.about)
        rig.book.updateDraft("value", "Marcus Lowe, Operations")
        rig.book.saveEdit()
        rig.book.updateDraft("value", "Marcus Lowe, Ops team")
        XCTAssertEqual(rig.state.editor?.fields.last?.text, "Marcus Lowe, Operations")
    }

    func testAChangeNeverAnsweredListsAgainSoALateSuccessShows() throws {
        let rig = try Rig()
        rig.book.askToForget(Self.routine)
        rig.book.confirmForget()
        rig.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertEqual(rig.last?.op, .list, "the helper may have forgotten it: read again")
        var reply = try HelperMemoryTests.reply(1)
        reply.entries.removeAll { $0.id == Self.routine }
        rig.answer(reply)
        XCTAssertNil(rig.entry(Self.routine))
        XCTAssertNil(rig.state.problems[Self.routine], "the list settles it")
    }

    func testAfterAReconnectNothingChangesUntilTheListArrives() throws {
        let rig = try Rig()
        rig.book.linkChanged(false)
        rig.book.linkChanged(true)
        XCTAssertFalse(rig.book.pause(Self.about), "what is shown may be out of date")
        rig.book.beginEdit(Self.about)
        XCTAssertNil(rig.state.editor)
        XCTAssertTrue(MemoryPage.sections(rig.state, now: Date())[0].rows[0].busy)
        rig.answer(try HelperMemoryTests.reply(1))
        XCTAssertTrue(rig.book.pause(Self.about))
    }

    // MARK: - Permissions

    func testARuleChangeIsSentAndReadBack() throws {
        let rig = try Rig()
        XCTAssertTrue(rig.book.setRule(.writeHere, .act))
        XCTAssertEqual(rig.last?.fields, ["rule": .text("act")])
        XCTAssertEqual(rig.last?.id, "permission-writeHere")
        rig.answer(try HelperMemoryTests.reply(7))
        XCTAssertEqual(rig.entry("permission-writeHere")?.permission?.rule, .act)
        let row = try XCTUnwrap(MemoryPage.rules(rig.state, now: Date()).first { $0.action == .writeHere })
        XCTAssertEqual(row.rule, .act)
        XCTAssertEqual(row.ruleDetail, "Meant to happen without asking. For now, Tab still does it.", "nothing acts without Tab yet")
    }

    func testSendingDeletingAndMoneyCannotGoPastAskAndNothingIsSent() throws {
        let rig = try Rig()
        let before = rig.sent.count
        let refused: [(HelperMemory.ActionType, HelperMemory.Rule)] = [
            (.outbound, .act), (.outbound, .actIfApproved), (.destructive, .act), (.sensitive, .ask), (.sensitive, .act), (.read, .ask), (.writeElsewhere, .act),
        ]
        for (action, rule) in refused {
            XCTAssertFalse(rig.book.setRule(action, rule), "\(action) \(rule)")
            XCTAssertNotNil(rig.state.problems["permission-\(action.rawValue)"], "\(action) \(rule)")
        }
        XCTAssertEqual(rig.sent.count, before)
        XCTAssertEqual(rig.state.problems["permission-outbound"], "Send, submit, post can't be set to Act if approved.", "the last refusal")
        rig.book.setRule(.outbound, .act)
        XCTAssertEqual(rig.state.problems["permission-outbound"], "Send, submit, post can't be set to Act.")
        XCTAssertTrue(rig.book.setRule(.outbound, .ask), "Ask first is as far as it goes")
    }

    func testTheSameRuleSendsNothing() throws {
        let rig = try Rig()
        let before = rig.sent.count
        XCTAssertFalse(rig.book.setRule(.writeHere, .ask))
        XCTAssertEqual(rig.sent.count, before)
    }

    func testRuleRowsOfferOnlyWhatTheTableAllowsAndReportUses() throws {
        let rig = try Rig()
        let rows = MemoryPage.rules(rig.state, now: Date(timeIntervalSince1970: 1_790_000_200))
        XCTAssertEqual(rows.map(\.action), HelperMemory.ActionType.allCases)
        let choices = Dictionary(uniqueKeysWithValues: rows.map { ($0.action, $0.choices) })
        XCTAssertEqual(choices[.read], [])
        XCTAssertEqual(choices[.sensitive], [])
        XCTAssertEqual(choices[.outbound], [.handoff, .ask])
        XCTAssertEqual(choices[.writeElsewhere], [.ask, .actIfApproved])
        let writeHere = try XCTUnwrap(rows.first { $0.action == .writeHere })
        XCTAssertTrue(writeHere.usesReported)
        XCTAssertEqual(writeHere.uses.map(\.says), ["Filled Guest in Mail Fixture", "Filled Email in Caret Fixture"])
        XCTAssertFalse(try XCTUnwrap(rows.first { $0.action == .outbound }).usesReported)
    }

    // MARK: - Typed values

    func testTypedValuesAreSentAsAddsAndLeaveTheQueueWhenKept() throws {
        let rig = try Rig()
        rig.book.remember([TypedAbout(label: "Name", value: " Dana Whitfield "), TypedAbout(label: "Email", value: "")])
        XCTAssertEqual(rig.state.typed.count, 1)
        let add = try XCTUnwrap(rig.last)
        XCTAssertEqual(add.op, .add)
        XCTAssertEqual(add.kind, .about)
        XCTAssertEqual(add.fields, ["label": .text("Name"), "value": .text("Dana Whitfield"), "source": .text("typed")])
        rig.answer(try HelperMemoryTests.reply(5))
        XCTAssertEqual(rig.state.typed, [])
        XCTAssertEqual(rig.last?.op, .list)
    }

    func testTypedValuesWaitForTheHelperAndAreSentOnConnect() throws {
        let rig = try Rig(connected: false)
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        XCTAssertEqual(rig.sent, [])
        let section = MemoryPage.sections(rig.state, now: Date())[0]
        XCTAssertEqual(section.rows.map(\.title), ["Your name is Dana Whitfield"])
        XCTAssertEqual(section.rows.map(\.secondary), ["You typed this during setup · not saved yet"])
        XCTAssertEqual(section.rows[0].status, .notSaved)
        XCTAssertEqual(section.rows[0].controls, [.forget])
        rig.book.linkChanged(true)
        XCTAssertEqual(rig.sent.map(\.op), [.list, .add])
    }

    func testTodaysHelperIgnoresAddSoTheValueWaitsForTheNextConnection() throws {
        let rig = try Rig()
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        rig.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertEqual(rig.state.typed.first?.phase, .waiting)
        rig.book.linkChanged(false)
        rig.book.linkChanged(true)
        XCTAssertEqual(rig.sent.filter { $0.op == .add }.count, 2)
    }

    func testARefusedValueIsNotSentAgainAndCanBeRemoved() throws {
        let rig = try Rig()
        rig.book.remember([TypedAbout(label: "Email", value: "dana@example.com")])
        rig.refuse("not storing a about entry: value: Too big")
        XCTAssertEqual(rig.state.typed.first?.phase, .refused("not storing a about entry: value: Too big"))
        let row = try XCTUnwrap(MemoryPage.sections(rig.state, now: Date())[0].rows.last)
        XCTAssertEqual(row.status, .refused)
        XCTAssertEqual(row.problem, "Caret couldn't keep this: not storing a about entry: value: Too big")
        rig.book.linkChanged(false)
        rig.book.linkChanged(true)
        XCTAssertEqual(rig.sent.filter { $0.op == .add }.count, 1)
        rig.book.dropTyped(rig.state.typed[0].id)
        XCTAssertEqual(rig.state.typed, [])
    }

    func testANewValueSupersedesOneBeingSent() throws {
        let rig = try Rig()
        rig.book.remember([TypedAbout(label: "Name", value: "Dana")])
        let first = try XCTUnwrap(rig.last)
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        XCTAssertEqual(rig.state.typed.map(\.value), ["Dana Whitfield"], "one value per label")
        XCTAssertEqual(rig.last?.fields?["value"], .text("Dana Whitfield"))
        // The first add's reply arrives: it does not remove the new value.
        var kept = try HelperMemoryTests.reply(5)
        kept.requestId = first.requestId
        rig.book.receive(kept)
        XCTAssertEqual(rig.state.typed.map(\.value), ["Dana Whitfield"])
    }

    func testDroppingByLabelRemovesOnlyThoseLabels() throws {
        let rig = try Rig(connected: false)
        rig.book.remember([TypedAbout(label: "Name", value: "Dana"), TypedAbout(label: "Email", value: "d@example.com")])
        rig.book.dropTyped(labels: ["Name"])
        XCTAssertEqual(rig.state.typed.map(\.label), ["Email"])
    }

    func testANewValueForAWaitingLabelReplacesIt() throws {
        let rig = try Rig(connected: false)
        rig.book.remember([TypedAbout(label: "Name", value: "Dana")])
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        XCTAssertEqual(rig.state.typed.map(\.value), ["Dana Whitfield"])
    }

    // MARK: - The page

    func testSectionsComeInPlanOrderWithTheirEmptyLines() throws {
        let rig = try Rig(listed: false)
        rig.answer(HelperMemory.Reply(requestId: "", error: nil, entries: []))
        let sections = MemoryPage.sections(rig.state, now: Date())
        XCTAssertEqual(sections.map(\.title), ["About you", "People", "Preferences", "Routines"])
        XCTAssertTrue(sections.allSatisfy { $0.rows.isEmpty && !$0.empty.isEmpty })
    }

    func testStatusAndWhenLines() throws {
        let rig = try Rig()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let locale = Locale(identifier: "en_US")
        let seen = Date(timeIntervalSince1970: 1_790_000_060)
        let time = DateFormatter()
        time.locale = locale
        time.timeZone = calendar.timeZone
        time.dateStyle = .none
        time.timeStyle = .short
        let clock = time.string(from: seen)
        let sameDay = seen.addingTimeInterval(60)
        let sections = MemoryPage.sections(rig.state, now: sameDay, calendar: calendar, locale: locale)
        let about = sections[0].rows[0]
        XCTAssertEqual(about.secondary, "You set this · today \(clock) · Mail Fixture")
        XCTAssertEqual(about.status, .active)
        XCTAssertTrue(sections[1].rows[0].secondary.hasPrefix("Paused · "))
        XCTAssertEqual(sections[1].rows[0].controls, [.edit, .resume, .forget])
        XCTAssertTrue(sections[3].rows[0].secondary.hasPrefix("Still learning · "))
        let ms = Int64(seen.timeIntervalSince1970 * 1000)
        XCTAssertEqual(MemoryPage.when(ms, now: seen.addingTimeInterval(86_400), calendar: calendar, locale: locale), "yesterday \(clock)")
        let day = DateFormatter()
        day.locale = locale
        day.timeZone = calendar.timeZone
        day.setLocalizedDateFormatFromTemplate("MMMd")
        XCTAssertEqual(MemoryPage.when(ms, now: seen.addingTimeInterval(3 * 86_400), calendar: calendar, locale: locale), day.string(from: seen))
    }

    func testTheDebugStateNamesWhatIsInFlightAndTypedValuesByLength() throws {
        let rig = try Rig()
        rig.book.pause(Self.about)
        rig.book.remember([TypedAbout(label: "Name", value: "Dana Whitfield")])
        let info = rig.book.debugInfo()
        XCTAssertEqual(info.busy, [Self.about: "pause"])
        XCTAssertEqual(info.typed.map(\.valueLength), [14])
        XCTAssertEqual(info.sent, ["list", "pause:\(Self.about)", "add:typed-1"])
        let json = String(decoding: try JSONEncoder().encode(info), as: UTF8.self)
        XCTAssertFalse(json.contains("Dana Whitfield"))
    }
}
