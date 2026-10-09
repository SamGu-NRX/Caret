@testable import CaretHostCore
import CaretScreenCore
import XCTest

/// H13: inline text in a web page field. The page's text reaches the engine; the offer is drawn at the page's caret;
/// Tab inserts through `pageInsert` with the text before the caret as its guard; a changed field takes nothing; a
/// field whose page has its own suggestions shows no ghost and leaves Tab to the page; the quiet line's states; page
/// text kept off the debug socket. Driven by the helper's golden lines (Fixtures/page-inline.ndjson) where they apply.
final class PageInlineTests: XCTestCase {
    static let chrome: Int32 = 4100

    static func golden() throws -> [Data] { try WireH11Tests.lines("page-inline") }
    static func field(_ i: Int) throws -> PageField { try JSONDecoder().decode(PageField.self, from: try golden()[i]) }

    final class Rig {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let machine: PageInlineMachine
        var commands: [PageInlineMachine.Command] = []
        /// Every field kind on, contenteditables included, so the machine's other behaviour is tested in all of them;
        /// the defaults have their own test (testInlineTextIsOnByDefaultInInputsTextareasAndContentEditables).
        var gate = PageInlineMachine.Gate(allowed: true, contentEditable: true, settings: PageInlineSettings())

        init() {
            // 7 points a character: enough room in every golden field for the suggestions here.
            machine = PageInlineMachine(arbiter: arbiter, clock: clock) { text, _ in CGFloat(text.count) * 7 }
            machine.output = { [unowned self] c in
                self.commands.append(c)
                if case .settings(let s) = c { self.gate.settings = s }
            }
        }

        func field(_ f: PageField?) { machine.field(f, gate: gate) }
        var requests: [PageInlineMachine.Request] { commands.compactMap { if case .generate(let r) = $0 { return r } else { return nil } } }
        var inserts: [PageInsert] { commands.compactMap { if case .send(let s) = $0 { return s } else { return nil } } }
        var ghosts: [(String, CGRect)] { commands.compactMap { if case .drawGhost(let t, let c, _) = $0 { return (t, c) } else { return nil } } }
        var notices: [LineContent] { commands.compactMap { if case .drawNotice(let l, _, _) = $0 { return l } else { return nil } } }
        var errorFields: [CGRect] { commands.compactMap { if case .drawError(_, let f) = $0 { return f } else { return nil } } }
        var errors: [LineContent] { commands.compactMap { if case .drawError(let l, _) = $0 { return l } else { return nil } } }
        var errorHidden: Bool {
            for c in commands.reversed() {
                if case .hideError = c { return true }
                if case .drawError = c { return false }
            }
            return true
        }
        var ghostHidden: Bool {
            for c in commands.reversed() {
                if case .hideGhost = c { return true }
                if case .drawGhost = c { return false }
            }
            return true
        }
        var noticeHidden: Bool {
            for c in commands.reversed() {
                if case .hideNotice = c { return true }
                if case .drawNotice = c { return false }
            }
            return true
        }

        @discardableResult
        func press(_ key: KeyStroke) -> OfferArbiter.Decision {
            let d = arbiter.handleKeyDown(key, now: clock.now)
            switch d {
            case .consume(let claim): machine.claimed(claim)
            case .closeOffer: machine.offerChanged(.closed)
            case .pass(let reason): machine.offerChanged(reason)
            default: break
            }
            return d
        }

        /// The ghost for the last request.
        func suggest(_ text: String?) { machine.generated(requests.last!.id, text: text) }
    }

    // MARK: - Page text reaches the engine

    func testThePagesTextReachesTheEngine() throws {
        let r = Rig()
        r.field(try Self.field(1))
        XCTAssertEqual(r.requests.map(\.before), ["I am writing to apply for the "])
        XCTAssertEqual(r.requests.first?.after, "")
        XCTAssertEqual(r.requests.first?.bundleID, "com.google.chrome.for.testing")
    }

    func testTheGoldenPageFieldDecodesItsTextAndCaret() throws {
        let f = try Self.field(1)
        XCTAssertEqual(f.text, PageField.Text(before: "I am writing to apply for the ", after: "", selection: ""))
        XCTAssertNil(f.ownSuggestions)
        XCTAssertEqual(f.caret, Frame(x: 361.5, y: 221, width: 1, height: 18))
        XCTAssertEqual(try Self.field(7).ownSuggestions, .gmail)
        // A consumer without pageText, or a helper before H13: no text, as before.
        XCTAssertNil(try Self.field(8).text)
    }

    func testNothingIsAskedOfTheEngineMidLineWithASelectionOrWithoutACaret() throws {
        let changes: [(inout PageField) -> Void] = [{ $0.text?.after = " role." }, { $0.text?.selection = "apply" }, { $0.caret = nil }, { $0.text = nil }]
        for change in changes {
            let r = Rig()
            var f = try Self.field(1)
            change(&f)
            r.field(f)
            XCTAssertEqual(r.requests, [])
        }
        // A new line after the caret is not the caret's line.
        let r = Rig()
        var f = try Self.field(1)
        f.text?.after = "\nThanks,"
        r.field(f)
        XCTAssertEqual(r.requests.count, 1)
    }

    // MARK: - The offer, at the caret

    func testTheSuggestionIsOfferedAtThePagesCaretAndTakesTab() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        XCTAssertEqual(r.ghosts.last?.0, "Field Robotics Technician role")
        XCTAssertEqual(r.ghosts.last?.1, CGRect(x: 361.5, y: 221, width: 1, height: 18))
        let offer = try XCTUnwrap(r.arbiter.snapshot().current)
        XCTAssertEqual(offer.target.windowID, "page:eng1:7")
        XCTAssertEqual(offer.target.elementID, "f0/form[apply]/textarea:cover letter~0")
        XCTAssertEqual(offer.source, .page)
        XCTAssertFalse(Claim(claimID: 1, offer: offer, typedSinceOffer: "", claimedAt: r.clock.now).insertsText, "the page inserts it, not Accessibility")
    }

    func testNoGhostWhereItWouldRunPastTheField() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest(String(repeating: "x", count: 60))
        XCTAssertTrue(r.ghosts.isEmpty)
        XCTAssertNil(r.arbiter.snapshot().current)
        XCTAssertEqual(r.machine.lastOutcome, "noRoom")
    }

    /// Brief item 6: with Cotypist's keys, Tab takes a word; once the page reads the word in, the rest of the same
    /// suggestion is offered at once, so Tab, Tab, Tab walks it as in a native field. Nothing is generated again.
    func testAfterAWordTheRestIsOfferedWithoutGeneratingAgain() throws {
        let r = Rig()
        r.arbiter.setGhostKeys(.cotypist)
        let f = try Self.field(1)
        r.field(f)
        r.suggest("Field Robotics Technician role")
        guard case .consume = r.press(.tab(to: Self.chrome)) else { return XCTFail("Tab took nothing") }
        let sent = try XCTUnwrap(r.inserts.last)
        XCTAssertEqual(sent.text, "Field")
        r.machine.replied(PageInsertReply(requestId: sent.requestId, outcome: .inserted, says: "inserted", at: 0))
        let asked = r.requests.count
        var after = f
        after.text?.before = "I am writing to apply for the Field"
        r.field(after)
        XCTAssertEqual(r.requests.count, asked, "the rest of the suggestion, not a new one")
        XCTAssertEqual(r.ghosts.last?.0, " Robotics Technician role")
        XCTAssertEqual(r.arbiter.snapshot().current?.text, " Robotics Technician role")
    }

    func testTheRestIsDroppedWhenThePageReadsOtherwise() throws {
        let r = Rig()
        r.arbiter.setGhostKeys(.cotypist)
        let f = try Self.field(1)
        r.field(f)
        r.suggest("Field Robotics Technician role")
        _ = r.press(.tab(to: Self.chrome))
        let asked = r.requests.count
        var other = f
        other.text?.before = "I am writing to apply for the Fieldx"
        r.field(other)
        XCTAssertEqual(r.requests.count, asked + 1, "the field moved on: a fresh suggestion")
    }

    // MARK: - After a paste, drop, undo or redo in a rich editor (item 3)

    func editor(_ quiet: Int?) throws -> PageField {
        var f = try Self.field(1)
        f.fieldKind = .contenteditable
        f.text?.quietMs = quiet
        return f
    }

    func testNoOfferInARichEditorRightAfterANonTypingEdit() throws {
        let r = Rig()
        r.field(try editor(100))
        XCTAssertTrue(r.requests.isEmpty, "the editor's own undo would group our insert with the paste")
        XCTAssertEqual(r.machine.lastOutcome, "afterEdit")
        r.clock.advance(by: 0.45)
        XCTAssertTrue(r.requests.isEmpty)
        r.clock.advance(by: 0.1)
        XCTAssertEqual(r.requests.count, 1, "offered once \(PageInlineMachine.editQuietMs) ms have passed since the edit")
    }

    func testAnEditLongEnoughAgoOrInAPlainFieldDoesNotHoldTheOffer() throws {
        let r = Rig()
        r.field(try editor(PageInlineMachine.editQuietMs))
        XCTAssertEqual(r.requests.count, 1)
        let plain = Rig()
        var f = try Self.field(1)
        f.text?.quietMs = 50
        plain.field(f)
        XCTAssertEqual(plain.requests.count, 1, "a textarea's undo is the browser's, which our insert already separates")
    }

    func testAFieldThatMovedOnBeforeTheWaitEndsIsNotOfferedLate() throws {
        let r = Rig()
        r.field(try editor(100))
        r.field(nil)
        r.clock.advance(by: 1)
        XCTAssertTrue(r.requests.isEmpty)
    }

    /// Audit finding b: a password input comes without its text (extension walker.ts), so nothing is generated there.
    func testNoGenerationForAFieldReportedWithoutText() throws {
        let r = Rig()
        var f = try Self.field(1)
        f.text = nil
        r.field(f)
        XCTAssertTrue(r.requests.isEmpty)
        XCTAssertNil(r.arbiter.snapshot().current)
        XCTAssertEqual(r.machine.lastOutcome, "noText")
    }

    /// Brief item 1: a suggestion that runs to the end of the sentence is often wider than the room left. The words that
    /// fit are offered, and Tab takes exactly those.
    func testALongSuggestionOffersTheWordsThatFit() throws {
        let r = Rig()
        r.field(try Self.field(1))
        let long = "Field Robotics Technician role" + String(repeating: " and", count: 40)
        r.suggest(long)
        let shown = try XCTUnwrap(r.ghosts.last?.0)
        XCTAssertTrue(long.hasPrefix(shown) && shown.count < long.count, shown)
        XCTAssertTrue(shown.hasPrefix("Field Robotics Technician role and"), shown)
        XCTAssertTrue(shown.hasSuffix(" and"), "cut at a word end: \(shown)")
        XCTAssertEqual(r.arbiter.snapshot().current?.text, shown, "the offer is what is drawn")
        XCTAssertEqual(r.machine.lastOutcome, "shown")
    }

    // MARK: - Accept through pageInsert, guarded by the text before the caret

    func testTabInsertsThroughPageInsertGuardedByTheTextBeforeTheCaret() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        XCTAssertEqual(r.press(.tab(to: Self.chrome)).isConsume, true)
        XCTAssertTrue(r.ghostHidden)
        let sent = try XCTUnwrap(r.inserts.first)
        let golden = try JSONDecoder().decode(PageInsert.self, from: try Self.golden()[2])
        XCTAssertEqual(sent.requestId, golden.requestId)
        XCTAssertEqual(sent.windowId, golden.windowId)
        XCTAssertEqual(sent.key, golden.key)
        XCTAssertEqual(sent.expect, golden.expect)
        XCTAssertEqual(sent.text, golden.text)
        // What the host sends is the golden line's shape.
        var same = sent
        same.at = golden.at
        try WireH11Tests.assertSameJSON(same, try Self.golden()[2])
        r.machine.replied(try JSONDecoder().decode(PageInsertReply.self, from: try Self.golden()[3]))
        XCTAssertEqual(r.machine.lastOutcome, "insert.inserted")
    }

    func testTypedThroughCharactersJoinTheGuardAndLeaveTheInsert() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        XCTAssertEqual(r.press(.typing("F", to: Self.chrome)), .pass(.typedThrough))
        XCTAssertEqual(r.ghosts.last?.0, "ield Robotics Technician role")
        // The page reports the F: the rest stays on offer, at the new caret, and nothing is generated again.
        var f = try Self.field(1)
        f.text?.before += "F"
        f.caret = Frame(x: 368, y: 221, width: 1, height: 18)
        r.field(f)
        XCTAssertEqual(r.requests.count, 1)
        XCTAssertEqual(r.ghosts.last?.1.minX, 368)
        r.press(.tab(to: Self.chrome))
        XCTAssertEqual(r.inserts.first?.expect, "I am writing to apply for the F")
        XCTAssertEqual(r.inserts.first?.text, "ield Robotics Technician role")
    }

    func testOptionRightTakesOneWord() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(KeyStroke(keyCode: KeyStroke.rightKeyCode, option: true, targetPID: Self.chrome))
        XCTAssertEqual(r.inserts.first?.text, "Field")
    }

    func testTheGuardIsCutAsThePageCutsTheTextBeforeTheCaret() {
        XCTAssertEqual(PageInline.lastUnits(String(repeating: "a", count: 2001) + "b").utf16.count, 2000)
        XCTAssertTrue(PageInline.lastUnits(String(repeating: "a", count: 2001) + "b").hasSuffix("ab"))
        XCTAssertEqual(PageInline.lastUnits("short"), "short")
    }

    // MARK: - A changed field takes nothing

    func testAnotherFieldOrChangedTextTakesTheOfferDownAndTabPasses() throws {
        let changes: [(inout PageField) -> Void] = [{ $0.key = "f0/form[apply]/textbox:email~0" }, { $0.text?.before = "I am writing to ask about the " }, { $0.windowId = "page:eng1:8" }]
        for change in changes {
            let r = Rig()
            r.field(try Self.field(1))
            r.suggest("Field Robotics Technician role")
            var f = try Self.field(1)
            change(&f)
            r.field(f)
            XCTAssertTrue(r.ghostHidden)
            XCTAssertNil(r.arbiter.snapshot().current)
            XCTAssertEqual(r.press(.tab(to: Self.chrome)), .pass(.noOffer))
            XCTAssertEqual(r.inserts, [])
        }
    }

    func testLeavingThePageTakesTheOfferDown() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.field(nil)
        XCTAssertTrue(r.ghostHidden)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testAStaleSuggestionIsDropped() throws {
        let r = Rig()
        r.field(try Self.field(1))
        let first = try XCTUnwrap(r.requests.last)
        var f = try Self.field(1)
        f.text?.before += "Fi"
        r.field(f)
        r.machine.generated(first.id, text: "Field Robotics Technician role")
        XCTAssertTrue(r.ghosts.isEmpty)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testARefusedInsertIsCountedAndAnUnansweredOneStopsBeingAwaited() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(.tab(to: Self.chrome))
        let refused = PageInsertReply(requestId: r.inserts[0].requestId, outcome: .refused, says: "the page refused the insert (changed)", at: 1)
        r.machine.replied(refused)
        XCTAssertEqual(r.machine.lastOutcome, "insert.refused")
        // Another, never answered.
        r.field(try Self.field(4))
        r.suggest(".")
        r.press(.tab(to: Self.chrome))
        r.clock.advance(by: PageInlineMachine.insertWait + 0.1)
        XCTAssertEqual(r.machine.lastOutcome, "insert.unanswered")
    }

    func testNothingShowsWhileGhostTextIsNotAllowed() throws {
        let r = Rig()
        r.gate.allowed = false
        r.field(try Self.field(1))
        XCTAssertEqual(r.requests, [])
        r.gate.allowed = true
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.machine.gateClosed()
        XCTAssertTrue(r.ghostHidden)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    // MARK: - Review findings (H13 review)

    func testAClaimRacingAnUnchangedReportStillInserts() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        // The tap takes Tab; before its claim reaches the machine, the page reports the field again.
        guard case .consume(let claim) = r.arbiter.handleKeyDown(.tab(to: Self.chrome), now: r.clock.now) else { return XCTFail("Tab took nothing") }
        r.field(try Self.field(1))
        r.machine.claimed(claim)
        XCTAssertEqual(r.inserts.map(\.text), ["Field Robotics Technician role"])
        XCTAssertEqual(r.inserts.first?.token, "0:D0:e4")
    }

    func testNoOfferOverTheFieldAsItWasWhileTheInsertIsOnItsWay() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(.tab(to: Self.chrome))
        let asked = r.requests.count
        // A report from before the insert landed: nothing is generated or offered for it.
        r.field(try Self.field(1))
        XCTAssertEqual(r.requests.count, asked)
        XCTAssertEqual(r.machine.lastOutcome, "insertPending")
        // The field with the insert in it: inline text as usual.
        r.field(try Self.field(4))
        XCTAssertEqual(r.requests.count, asked + 1)
    }

    func testAHeldTabsAutorepeatTakesNothing() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        XCTAssertEqual(r.press(KeyStroke(keyCode: KeyStroke.tabKeyCode, targetPID: Self.chrome, isRepeat: true)).isConsume, false)
        XCTAssertEqual(r.inserts, [])
    }

    func testTypedThroughTextIsCountedOnceWhereverItIsReported() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(.typing("F", to: Self.chrome))
        XCTAssertEqual(r.ghosts.last?.1.minX, 361.5 + 7, "the typed F, measured")
        var f = try Self.field(1)
        f.text?.before += "F"
        f.caret = Frame(x: 368, y: 221, width: 1, height: 18)
        r.field(f)
        XCTAssertEqual(r.ghosts.last?.1.minX, 368)
        r.press(.typing("i", to: Self.chrome))
        XCTAssertEqual(r.ghosts.last?.0, "eld Robotics Technician role")
        XCTAssertEqual(r.ghosts.last?.1.minX, 368 + 7, "only the i is not in the page's report yet")
        // A report of the same text with the page scrolled: the rest, at the new caret.
        f.caret = Frame(x: 368, y: 200, width: 1, height: 18)
        r.field(f)
        XCTAssertEqual(r.ghosts.last?.0, "eld Robotics Technician role")
    }

    func testNothingIsOfferedWhenThePagesDocumentLostFocus() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        var f = try Self.field(1)
        f.pageFocused = false
        r.field(f)
        XCTAssertNil(r.arbiter.snapshot().current, "Tab goes to the address bar")
        XCTAssertTrue(r.ghostHidden)
        XCTAssertEqual(r.machine.lastOutcome, "pageUnfocused")
    }

    /// The test Mac (e94f463): a contenteditable comes as editable false (fill may not write it; the helper's
    /// page-link.ts VALUE_KINDS), with the text around its caret. Inline text goes by the text, not by that flag, and
    /// so does Gmail's line (its compose body is a contenteditable).
    func testAContentEditableGetsInlineTextAndGmailsLine() throws {
        let r = Rig()
        var f = try Self.field(1)
        f.fieldKind = .contenteditable
        f.editable = false
        f.empty = true
        r.field(f)
        XCTAssertEqual(r.requests.map(\.before), ["I am writing to apply for the "])
        let g = Rig()
        var gmail = try Self.field(7)
        gmail.editable = false
        g.field(gmail)
        XCTAssertEqual(g.notices.count, 1)
        // A control with no text of the user's (a button, a checkbox) still gets nothing.
        let b = Rig()
        var button = try Self.field(1)
        button.editable = false
        button.text = nil
        b.field(button)
        XCTAssertEqual(b.requests, [])
    }

    /// The lead's defaults (2026-10-06, after the H13 review): on by default in text inputs and textareas, where one ⌘Z
    /// after real typing and Tab removed only the insert, 4 of 4 each (runs/20261006T161320Z-68498). Off by default in
    /// contenteditables. Chrome's own undo step now takes the insert alone there too (same run), but a rich editor
    /// (ProseMirror, Lexical, Draft.js, Notion) keeps its own history groups, which closing Chrome's typing step does
    /// not close. `pageInlineContentEditable` turns them on, and Gmail's line shows only then: Turn Caret on here would
    /// otherwise show nothing.
    func testInlineTextIsOnInInputsAndTextareasAndOffInContentEditablesByDefault() throws {
        let d = CaretSettings()
        XCTAssertTrue(d.pageInlineText)
        XCTAssertFalse(d.pageInlineContentEditable)
        XCTAssertTrue(PageInline.allowed(d, wordsAllowed: true, engineReady: true, browserAllowed: true, composing: false))
        func rig(_ s: CaretSettings) -> Rig {
            let r = Rig()
            r.gate = PageInlineMachine.Gate(allowed: PageInline.allowed(s, wordsAllowed: true, engineReady: true, browserAllowed: true, composing: false),
                                            contentEditable: s.pageInlineContentEditable, settings: s.pageInline)
            return r
        }
        let textarea = rig(d)
        XCTAssertEqual(try Self.field(1).fieldKind, .textarea)
        textarea.field(try Self.field(1))
        XCTAssertEqual(textarea.requests.map(\.before), ["I am writing to apply for the "])
        let input = rig(d)
        var line = try Self.field(1)
        line.fieldKind = .input
        input.field(line)
        XCTAssertEqual(input.requests.count, 1)
        var ce = try Self.field(1)
        ce.fieldKind = .contenteditable
        let editor = rig(d)
        editor.field(ce)
        XCTAssertEqual(editor.requests, [])
        XCTAssertEqual(editor.machine.lastOutcome, "contentEditableOff")
        let gmail = rig(d)
        XCTAssertEqual(try Self.field(7).fieldKind, .contenteditable)
        gmail.field(try Self.field(7))
        XCTAssertEqual(gmail.requests, [])
        XCTAssertEqual(gmail.notices, [], "no Gmail line where Turn Caret on here would show nothing")
        // Contenteditables turned on by the user: inline text there, and Gmail's line.
        var editors = d
        editors.pageInlineContentEditable = true
        let on = rig(editors)
        on.field(ce)
        XCTAssertEqual(on.requests.count, 1)
        let lineGmail = rig(editors)
        lineGmail.field(try Self.field(7))
        XCTAssertEqual(lineGmail.notices.count, 1)
        // A field whose kind the page did not say gets nothing.
        let unknown = rig(d)
        var bare = try Self.field(1)
        bare.fieldKind = nil
        unknown.field(bare)
        XCTAssertEqual(unknown.requests, [])
        XCTAssertEqual(unknown.machine.lastOutcome, "noFieldKind")
        // The defaults write nothing, so a later default reaches a user who never chose; a choice is kept.
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(d)) as? [String: Any])
        XCTAssertNil(json["pageInlineText"])
        XCTAssertNil(json["pageInlineContentEditable"])
        var chosen = d
        chosen.pageInlineText = false
        chosen.pageInlineContentEditable = true
        let back = try JSONDecoder().decode(CaretSettings.self, from: JSONEncoder().encode(chosen))
        XCTAssertFalse(back.pageInlineText)
        XCTAssertTrue(back.pageInlineContentEditable)
    }

    /// H13 review (P1): while an input method composes (Pinyin, Kotoeri), inline text on pages is neither offered nor
    /// taken. A ghost already drawn when the input method was switched on goes at the next key, and Tab reaches the
    /// input method: the arbiter asks at the moment it would claim the key.
    func testNothingIsOfferedOrTakenWhileAnInputMethodComposes() throws {
        XCTAssertFalse(PageInline.allowed(CaretSettings(), wordsAllowed: true, engineReady: true, browserAllowed: true, composing: true))
        let r = Rig()
        let ime = Composing()
        r.arbiter.composing = { ime.on }
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        XCTAssertNotNil(r.arbiter.snapshot().current)
        ime.on = true
        XCTAssertEqual(r.press(.tab(to: Self.chrome)), .pass(.dismissed))
        XCTAssertEqual(r.inserts, [])
        XCTAssertTrue(r.ghostHidden)
        XCTAssertNil(r.arbiter.snapshot().current)
        // Off again: Tab is Caret's.
        ime.on = false
        r.field(try Self.field(4))
        r.suggest(".")
        XCTAssertTrue(r.press(.tab(to: Self.chrome)).isConsume)
        XCTAssertEqual(r.inserts.count, 1)
    }

    /// The test Mac (runs/20261006T170055Z-81931): with Chrome's web content shown to Accessibility, native ghost text
    /// offered in a page field, took Tab, and Chrome ignored its write. A web field the page engine reports is the page's.
    func testNativeGhostTextLeavesAReportedPageFieldToThePage() {
        XCTAssertTrue(PageInline.nativeYields(inWebArea: true, pageFieldReported: true))
        XCTAssertFalse(PageInline.nativeYields(inWebArea: true, pageFieldReported: false), "no page engine: Accessibility is all there is")
        XCTAssertFalse(PageInline.nativeYields(inWebArea: false, pageFieldReported: true), "the browser's own fields (the address bar) stay native")
    }

    final class Composing: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var on: Bool {
            get { lock.lock(); defer { lock.unlock() }; return value }
            set { lock.lock(); value = newValue; lock.unlock() }
        }
    }

    /// The overall switch off: nothing shows in any field, Gmail's line included.
    func testNothingOfInlineTextOnPagesShowsWhileItIsOff() throws {
        var off = CaretSettings()
        off.pageInlineText = false
        XCTAssertFalse(PageInline.allowed(off, wordsAllowed: true, engineReady: true, browserAllowed: true, composing: false))
        let r = Rig()
        r.gate.allowed = false
        r.field(try Self.field(1))
        r.field(try Self.field(7))
        XCTAssertEqual(r.requests, [])
        XCTAssertEqual(r.notices, [])
    }

    func testAReplacedElementWithTheSameKeyTakesTheOfferDown() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        var f = try Self.field(1)
        f.token = "0:D0:e9"
        r.field(f)
        XCTAssertNil(r.arbiter.snapshot().current)
        XCTAssertEqual(r.press(.tab(to: Self.chrome)), .pass(.noOffer))
    }

    func testNoOfferWithoutTheElementsToken() throws {
        let r = Rig()
        var f = try Self.field(1)
        f.token = nil
        r.field(f)
        r.suggest("Field Robotics Technician role")
        XCTAssertNil(r.arbiter.snapshot().current)
        XCTAssertEqual(r.machine.lastOutcome, "noToken")
    }

    // MARK: - Pages with their own suggestions

    func testGmailShowsNoGhostAndItsOwnSuggestionsKeepTab() throws {
        let r = Rig()
        let gmail = try Self.field(7)
        r.field(gmail)
        XCTAssertEqual(r.requests, [])
        XCTAssertTrue(r.ghosts.isEmpty)
        XCTAssertEqual(OtherTabOwners.pageOwner(gmail, settings: PageInlineSettings()), "Gmail")
        // The quiet line takes no Tab: it goes to Gmail, which accepts its own suggestion.
        r.arbiter.setPageTabOwner(pid: Self.chrome, owner: "Gmail")
        XCTAssertEqual(r.press(.tab(to: Self.chrome)), .pass(.dismissed))
        XCTAssertTrue(r.noticeHidden)
    }

    func testTheArbiterLeavesTabToAPagesOwnSuggestions() throws {
        // Any Caret offer that would write into the field (a ghost, a fill value) yields Tab while the page owns it.
        let arbiter = OfferArbiter()
        let target = TargetIdentity(pid: Self.chrome, bundleID: "com.google.Chrome", windowID: "page:eng1:9", elementID: "f0/div:message body~0", elementRevision: "r")
        XCTAssertNotNil(arbiter.publish(Offer(text: "thanks", source: .page, target: target, fieldValue: "", caretUTF16: 0)))
        arbiter.setPageTabOwner(pid: Self.chrome, owner: "Gmail")
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: Self.chrome)), .pass(.dismissed))
        XCTAssertNil(arbiter.snapshot().current)
        // Off again (the user turned Caret on there): Tab is Caret's.
        arbiter.setPageTabOwner(pid: Self.chrome, owner: nil)
        XCTAssertNotNil(arbiter.publish(Offer(text: "thanks", source: .page, target: target, fieldValue: "", caretUTF16: 0)))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: Self.chrome)).isConsume, true)
    }

    func testGoogleDocsGetsNoGhostAndNoLine() throws {
        let r = Rig()
        var docs = try Self.field(7)
        docs.ownSuggestions = .googleDocs
        r.field(docs)
        XCTAssertEqual(r.requests, [])
        XCTAssertEqual(r.notices, [])
        XCTAssertEqual(OtherTabOwners.pageOwner(docs, settings: PageInlineSettings(on: ["google-docs"])), "Google Docs", "Docs is not Caret's this batch")
    }

    // MARK: - The quiet line's states

    func testTheLineSaysWhatToDoWithItsThreeChoices() throws {
        let r = Rig()
        r.field(try Self.field(7))
        let line = try XCTUnwrap(r.notices.first)
        // The lead's sentence, word for word, split at its full stop: the line, then the row under it with the keys.
        XCTAssertEqual("\(line.text) \(line.question?.text ?? "")", "Gmail suggests its own text here, and Tab accepts it. To use Caret's instead, turn off Smart Compose in Gmail's settings, then turn Caret on here.")
        XCTAssertEqual(line.question?.hints, [Hint(key: "⌘1", label: "Turn Caret on here"), Hint(key: "⌘2", label: "Don't show again"), Hint(key: "Esc", label: "Not now")])
    }

    func testTurnCaretOnHereSavesTheChoiceAndOffersInlineTextAtOnce() throws {
        let r = Rig()
        r.field(try Self.field(7))
        r.press(KeyStroke(keyCode: 18, command: true, targetPID: Self.chrome))
        XCTAssertTrue(r.gate.settings.isOn(.gmail))
        XCTAssertTrue(r.noticeHidden)
        XCTAssertEqual(r.requests.map(\.before), ["Hi Gareth,\nThanks for the details. "])
        XCTAssertNil(OtherTabOwners.pageOwner(try Self.field(7), settings: r.gate.settings))
    }

    func testDontShowAgainIsKeptAndNotNowLastsTheRun() throws {
        let quiet = Rig()
        quiet.field(try Self.field(7))
        quiet.press(KeyStroke(keyCode: 19, command: true, targetPID: Self.chrome))
        XCTAssertEqual(quiet.gate.settings.quiet, ["gmail"])
        XCTAssertFalse(quiet.gate.settings.isOn(.gmail))
        let later = Rig()
        later.gate = quiet.gate
        later.field(try Self.field(7))
        XCTAssertEqual(later.notices, [], "never again")

        let notNow = Rig()
        notNow.field(try Self.field(7))
        notNow.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.chrome))
        XCTAssertTrue(notNow.noticeHidden)
        XCTAssertEqual(notNow.gate.settings, PageInlineSettings(), "nothing saved")
        notNow.field(nil)
        notNow.field(try Self.field(7))
        XCTAssertEqual(notNow.notices.count, 1, "once a run")
    }

    // MARK: - Follow-ups (coordinator, after H13): a line nobody answered comes back; a refused insert says so

    /// The same field in another place: a focus somewhere else and back.
    static func elsewhere() throws -> PageField {
        var f = try field(1)
        f.key = "f0/form[apply]/textbox:email~0"
        return f
    }

    func testAnUnansweredGmailLineComesBackOnTheNextFocusUntilTheUserAnswers() throws {
        let r = Rig()
        r.field(try Self.field(7))
        r.clock.advance(by: PageInlineMachine.noticeLifetime + 0.1)
        XCTAssertTrue(r.noticeHidden)
        // The same focus (another report while typing there): not again.
        r.field(try Self.field(7))
        XCTAssertEqual(r.notices.count, 1)
        // The next focus of such a field: again.
        r.field(try Self.elsewhere())
        r.field(try Self.field(7))
        XCTAssertEqual(r.notices.count, 2)
        // Typed past, it is unanswered too.
        r.press(.typing("a", to: Self.chrome))
        r.field(try Self.elsewhere())
        r.field(try Self.field(7))
        XCTAssertEqual(r.notices.count, 3)
        // Not now (Esc) answers it for this run.
        r.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.chrome))
        r.field(try Self.elsewhere())
        r.field(try Self.field(7))
        XCTAssertEqual(r.notices.count, 3)
    }

    func testAnUnansweredDocsLineComesBackOnTheNextFocus() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        r.clock.advance(by: PageInlineMachine.noticeLifetime + 0.1)
        XCTAssertTrue(r.noticeHidden)
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 1, "not twice in one focus")
        r.field(try Self.elsewhere())
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 2, "the next focus, well within two minutes")
        r.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.chrome))
        r.field(try Self.field(1))
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 2, "Esc answers it for this run")
    }

    func testARefusedInsertSaysSoAtTheField() throws {
        // Refused before any write, or tried and the field reads as before: nothing changed.
        for outcome in [PageInsertReply.Outcome.refused, .failed] {
            let r = Rig()
            r.field(try Self.field(1))
            r.suggest("Field Robotics Technician role")
            r.press(.tab(to: Self.chrome))
            r.machine.replied(PageInsertReply(requestId: r.inserts[0].requestId, outcome: outcome, says: "x", at: 1))
            XCTAssertEqual(r.errors.last, LineContent(figure: .error, text: "The page didn't take it.", emphasis: .plain), "\(outcome)")
            r.clock.advance(by: PageInlineMachine.errorLifetime + 0.1)
            XCTAssertTrue(r.errorHidden)
        }
        // Never answered: said too, as a change Caret cannot vouch for (H13 review).
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(.tab(to: Self.chrome))
        r.clock.advance(by: PageInlineMachine.insertWait + 0.1)
        XCTAssertEqual(r.errors, [PageInlineCopy.unverified(nil)])
        // An insert that went in says nothing.
        let ok = Rig()
        ok.field(try Self.field(1))
        ok.suggest("Field Robotics Technician role")
        ok.press(.tab(to: Self.chrome))
        ok.machine.replied(PageInsertReply(requestId: ok.inserts[0].requestId, outcome: .inserted, says: "inserted", at: 1))
        XCTAssertEqual(ok.errors, [])
    }

    /// H13 review (P1/P2): a field that changed, but not to the insert, is told apart from one that took nothing: the user
    /// is asked to check it, and nothing is undone.
    func testAnUnverifiedInsertAsksTheUserToCheckTheField() throws {
        let r = Rig()
        r.field(try Self.field(1))
        r.suggest("Field Robotics Technician role")
        r.press(.tab(to: Self.chrome))
        r.machine.replied(PageInsertReply(requestId: r.inserts[0].requestId, outcome: .unverified, says: "x", at: 1))
        XCTAssertEqual(r.machine.lastOutcome, "insert.unverified")
        XCTAssertEqual(r.errors.last, LineContent(figure: .error, text: "The page changed the field another way. Check it.", emphasis: .plain))
        XCTAssertNotEqual(PageInlineCopy.unverified(nil), PageInlineCopy.notTaken(nil))
    }

    /// H13 review (P2): the field the insert was for can be gone when the answer comes (the page replaced it, the user
    /// moved on). The line still shows, where that field was: its context goes with the insert.
    func testAFailedOrUnverifiedInsertStillSaysSoWhenItsFieldIsGone() throws {
        let frame = try XCTUnwrap(try Self.field(1).frame)
        let at = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        for (outcome, line) in [(PageInsertReply.Outcome.failed, PageInlineCopy.notTaken(nil)), (.unverified, PageInlineCopy.unverified(nil))] {
            let r = Rig()
            r.field(try Self.field(1))
            r.suggest("Field Robotics Technician role")
            r.press(.tab(to: Self.chrome))
            r.field(nil)
            r.machine.replied(PageInsertReply(requestId: r.inserts[0].requestId, outcome: outcome, says: "x", at: 1))
            XCTAssertEqual(r.errors, [line], "\(outcome)")
            XCTAssertEqual(r.errorFields, [at], "\(outcome)")
        }
        // Gone before Tab's claim reached the machine: nothing is sent, and it is still said, where the field was.
        let moved = Rig()
        moved.field(try Self.field(1))
        moved.suggest("Field Robotics Technician role")
        guard case .consume(let claim) = moved.arbiter.handleKeyDown(.tab(to: Self.chrome), now: moved.clock.now) else { return XCTFail("Tab did not take the offer") }
        moved.field(nil)
        moved.machine.claimed(claim)
        XCTAssertEqual(moved.inserts, [])
        XCTAssertEqual(moved.errors, [PageInlineCopy.notTaken(nil)])
        XCTAssertEqual(moved.errorFields, [at])
    }

    func testARefusedInsertInGmailNamesGmail() throws {
        let r = Rig()
        r.gate.settings.set(.gmail, on: true)
        var g = try Self.field(7)
        g.frame = Frame(x: 300, y: 400, width: 600, height: 240)
        r.field(g)
        r.suggest("thanks again")
        r.press(.tab(to: Self.chrome))
        r.machine.replied(PageInsertReply(requestId: r.inserts[0].requestId, outcome: .refused, says: "x", at: 1))
        XCTAssertEqual(r.errors.last?.text, "Gmail didn't take it.")
    }

    func testTypingInGmailPutsTheLineAwayWithoutSavingAnything() throws {
        let r = Rig()
        r.field(try Self.field(7))
        XCTAssertEqual(r.press(.typing("a", to: Self.chrome)), .pass(.dismissed))
        XCTAssertTrue(r.noticeHidden)
        XCTAssertEqual(r.gate.settings, PageInlineSettings())
    }

    func testTheLineGoesWhenItsTimeIsUp() throws {
        let r = Rig()
        r.field(try Self.field(7))
        r.clock.advance(by: PageInlineMachine.noticeLifetime + 0.1)
        XCTAssertTrue(r.noticeHidden)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testTheSettingsReadAndRefuseWhatTheyDoNotKnow() throws {
        var s = CaretSettings()
        s.pageInline.set(.gmail, on: true)
        let back = try JSONDecoder().decode(CaretSettings.self, from: JSONEncoder().encode(s))
        XCTAssertTrue(back.pageInline.isOn(.gmail))
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
        json["pageInline"] = ["on": ["hotmail"], "quiet": [String]()] as [String: Any]
        XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: JSONSerialization.data(withJSONObject: json)))
        // A file from before H13 has no key, and an untouched setting writes none.
        XCTAssertNil(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(CaretSettings())) as? [String: Any])["pageInline"])
    }

    // MARK: - A Google Doc whose text is off (brief item 3)

    static let turnOn = "Turn on screen reader and braille support in Google Docs, ⌘⌥Z then ⌘⌥H, so Caret can read it."

    func testAFillFromADocWhoseTextIsOffSaysWhatToTurnOnAtTheField() throws {
        let r = Rig()
        r.field(try Self.field(1))
        let error = try JSONDecoder().decode(HelperError.self, from: Data(#"{"type":"error","v":1,"at":1,"message":"\#(Self.turnOn)","sourceOff":"Google Docs"}"#.utf8))
        XCTAssertEqual(error.sourceOff, "Google Docs")
        r.machine.sourceOff(try XCTUnwrap(error.sourceOff), says: error.message)
        XCTAssertEqual(r.notices.last?.text, "Caret can't read the Google Doc you left.")
        XCTAssertEqual(r.notices.last?.question, LineContent.Question(text: Self.turnOn, hints: [Hint(key: "Esc")]))
        // Tab stays the page's; Esc puts the line away.
        XCTAssertEqual(r.arbiter.handleKeyDown(.tab(to: Self.chrome), now: r.clock.now), .pass(.dismissed))
        r.machine.offerChanged(.dismissed)
        XCTAssertTrue(r.noticeHidden)
        // Not twice in one focus; again on the next (testAnUnansweredDocsLineComesBackOnTheNextFocus).
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 1)
        r.field(try Self.elsewhere())
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 2)
        let id = try XCTUnwrap(r.arbiter.snapshot().current?.id)
        XCTAssertEqual(r.press(KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: Self.chrome)), .closeOffer(offerID: id))
        XCTAssertTrue(r.noticeHidden)
    }

    func testNoLineWithoutAFieldToStandUnder() {
        let r = Rig()
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices, [])
    }

    func testEveryGoldenLineDecodesOnTheHost() throws {
        for (i, line) in try Self.golden().enumerated() {
            let type = try XCTUnwrap(WireH11Tests.object(line)["type"] as? String)
            switch type {
            case "hello": continue
            case PageInsert.type: _ = try JSONDecoder().decode(PageInsert.self, from: line)
            default:
                let m = try HelperInbound.decode(line)
                if case .unknown = m { XCTFail("line \(i + 1) is unknown") }
            }
        }
        // The host's hello names pageText.
        XCTAssertTrue(HostHello.capabilities(routing: false).contains("pageText"))
    }

    // MARK: - Page text stays off the debug socket and the log

    func testPageTextNeverReachesTheDebugStateOrALogLine() throws {
        let r = Rig()
        let f = try Self.field(1)
        r.field(f)
        r.suggest("Field Robotics Technician role")
        r.press(.typing("F", to: Self.chrome))
        let snap = r.arbiter.snapshot()
        let offer = try XCTUnwrap(snap.current)
        let shown = PageInline.debugText(offer, typed: snap.typedSinceOffer)
        XCTAssertEqual(shown.text, "")
        XCTAssertEqual(shown.typed, "")
        let info = DebugState.PageInlineInfo(last: r.machine.lastOutcome, shownLength: 29, notice: false, fieldRole: f.role, beforeLength: 30, afterLength: 0,
                                             ownSuggestions: nil, tabOwner: nil, latency: LatencyRecorder().summary(), generation: LatencyRecorder().summary())
        let json = String(decoding: try JSONEncoder().encode(info), as: UTF8.self)
        let log = "\(f) \(String(describing: f)) \(String(reflecting: f))"
        for said in [json, log] {
            XCTAssertFalse(said.contains("apply for the"), said)
            XCTAssertFalse(said.contains("Robotics"), said)
        }
        // Native ghost text keeps its record.
        let native = Offer(text: "hello there", target: offer.target, fieldValue: "", caretUTF16: 0)
        XCTAssertEqual(PageInline.debugText(native, typed: "he").text, "llo there")
    }
}

private extension OfferArbiter.Decision {
    var isConsume: Bool { if case .consume = self { return true } else { return false } }
}
