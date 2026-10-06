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
        var gate = PageInlineMachine.Gate(allowed: true, settings: PageInlineSettings())

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

    func testTypingInGmailPutsTheLineAwayAsNotNow() throws {
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
        // Said once in a while, not on every field the fill asks again for.
        r.machine.sourceOff("Google Docs", says: Self.turnOn)
        XCTAssertEqual(r.notices.count, 1)
        r.clock.advance(by: PageInlineMachine.sourceOffQuiet + 1)
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
