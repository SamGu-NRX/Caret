import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// H5's lines between the helper and the host (helper/fixtures/golden/host.ndjson, read by path, as
/// the helper's test/host-golden.test.ts reads it).
final class HostGoldenTests: XCTestCase {
    private static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("helper/fixtures/golden/host.ndjson")

    private static func lines() throws -> [Data] {
        try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map { Data($0.utf8) }
    }

    private static func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    private func proposal(_ i: Int) throws -> PlanProposal {
        guard case .planProposal(let p) = try HelperInbound.decode(try Self.lines()[i]) else { throw Unexpected("line \(i + 1) is not a planProposal") }
        return p
    }

    /// B26: the desk shows the helper's refusal and question as it sends them.
    func testTheDeskShowsTheHelpersSentencesAsTheyAreSent() throws {
        XCTAssertEqual(AskCopy.planError(try proposal(0).error), "Submitting is yours to do.")
        XCTAssertEqual(AskCopy.planError(try proposal(1).error), "Is \"8:15\" in the morning or the evening? Say it with am or pm.")
        let ask = AskCaret(clock: ManualClock())
        ask.send = { _ in true }
        ask.linkChanged(true)
        ask.edit("hit submit")
        ask.submit()
        var refusal = try proposal(0)
        refusal.requestId = "ask-1"
        ask.receive(refusal)
        XCTAssertEqual(ask.phase, .failed("Submitting is yours to do."))
    }

    /// A sentence that could carry an id is never shown; the code's own sentence stands in. So is a
    /// line from a helper before H5, which sends none.
    func testASentenceWithAnIdOrNoSentenceFallsBackToTheCodesSentence() {
        let plain = AskCopy.planError(PlanProposal.Failure(code: .unsupportedStep, detail: "d"))
        XCTAssertEqual(plain, "That needs a step I don't take: I fill fields and leave buttons to you.")
        for says in ["No candidates in 92930-4.", "Caret can't reach page:e1:7.", "Field textfield:email~0 is gone.", "", "Two\nlines."] {
            XCTAssertEqual(AskCopy.planError(PlanProposal.Failure(code: .unsupportedStep, detail: "d", says: says)), plain, says)
        }
        XCTAssertEqual(AskCopy.planError(PlanProposal.Failure(code: .unsure, detail: "d", says: "Which person do you mean? Say their name.")),
                       "Which person do you mean? Say their name.")
    }

    /// An Ask whose results are only controls is one hand-off: the card lists what to set, each
    /// marked as the user's, and names no press.
    func testAnAskOfOnlyControlsIsOneHandOffThatSaysWhatToSet() throws {
        let p = try proposal(2)
        XCTAssertNil(p.handoff)
        let card = try XCTUnwrap(AskCaret.card(p))
        XCTAssertEqual(card.title, "You set Pizza size and Crust in Google Chrome")
        XCTAssertEqual(card.steps, [
            AskCaret.Step(text: "Pizza size: Large", yours: true, field: "Pizza size"),
            AskCaret.Step(text: "Crust: Thin", yours: true, field: "Crust"),
        ])
        XCTAssertEqual(card.writes, 0)
        XCTAssertNil(card.press)
        XCTAssertEqual(card.action, "Got it")
    }

    /// The fill preview's control rows: listed after the writes, spoken with "you set this", and not
    /// counted among the fields Tab fills.
    func testTheFillPreviewListsAControlTheUserSets() throws {
        guard case .popup(let popup) = try HelperInbound.decode(try Self.lines()[3]) else { return XCTFail("line 4 is not a popup") }
        let offer = try XCTUnwrap(HelperOffer(.popup(popup)))
        XCTAssertEqual(offer.offerKey, "fill-9")
        XCTAssertEqual(popup.spec.fillRows, 2, "Tab fills the two written fields")
        let speech = SlipSpeech.popup(popup.spec, highlight: nil)
        XCTAssertTrue(speech.contains("Name: Dana Whitfield. Phone: +1 512 555 0142. Pizza size: Large, you set this."), speech)
    }

    /// The host's settings line, with the sites turned off: the same JSON object as the golden line.
    func testTheHostsSettingsCarryTheSitesTurnedOff() throws {
        var settings = CaretSettings()
        settings.setSite("https://jobs.example.com", off: true)
        settings.setSite("http://127.0.0.1:4310", off: true)
        settings.setSite("https://jobs.example.com/apply", off: true)
        XCTAssertEqual(settings.sitesOff, ["http://127.0.0.1:4310", "https://jobs.example.com"], "an origin only, sorted, each once")
        let line = try Self.lines()[4]
        let golden = try Self.object(line)
        let sent = HostSettings(settings, at: (golden["at"] as! NSNumber).int64Value)
        XCTAssertEqual(try Self.object(NDJSON.line(sent).dropLast()), golden)
    }

    func testTheHostsSessionLockedIsTheGoldenLine() throws {
        let sent = SessionLocked(at: 1_790_001_010_000, why: .lock)
        XCTAssertEqual(try Self.object(NDJSON.line(sent).dropLast()), try Self.object(try Self.lines()[9]))
    }
}

final class SiteOriginTests: XCTestCase {
    func testOriginsAreSchemeAndHostWithAPortOnlyWhenItIsNotTheDefault() {
        let cases: [(String, String?)] = [
            ("https://Jobs.Example.com/apply?id=4#top", "https://jobs.example.com"),
            ("http://127.0.0.1:4310/form", "http://127.0.0.1:4310"),
            ("https://example.com:443/x", "https://example.com"),
            ("http://example.com:80", "http://example.com"),
            ("https://example.com:8443", "https://example.com:8443"),
            ("file:///Users/dana/a.html", nil),
            ("chrome://settings", nil),
            ("about:blank", nil),
        ]
        for (url, origin) in cases { XCTAssertEqual(SiteOrigin.of(URL(string: url)!), origin, url) }
        XCTAssertTrue(SiteOrigin.isOrigin("https://jobs.example.com"))
        XCTAssertFalse(SiteOrigin.isOrigin("https://jobs.example.com/"))
        XCTAssertEqual(SiteOrigin.display("http://127.0.0.1:4310"), "127.0.0.1:4310")
        XCTAssertEqual(SiteOrigin.display("https://jobs.example.com"), "jobs.example.com")
    }

    /// The settings file is the user's: a site list in another form is refused with the file, and a
    /// file from before H5 reads with no site off.
    func testTheSettingsFileReadsTheSiteListStrictly() throws {
        var settings = CaretSettings()
        settings.setSite("https://jobs.example.com", off: true)
        let data = try JSONEncoder().encode(settings)
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: data), settings)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        object["sitesOff"] = nil
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: JSONSerialization.data(withJSONObject: object)).sitesOff, [])
        object["sitesOff"] = ["jobs.example.com"]
        XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: JSONSerialization.data(withJSONObject: object)))
        settings.setSite("https://jobs.example.com", off: false)
        XCTAssertEqual(settings.sitesOff, [])
    }
}

final class PageSightTests: XCTestCase {
    private let chrome = AppRef(pid: 6100, bundleId: "com.google.Chrome", name: "Google Chrome")

    private func rig() -> (PageSight, ManualClock, () -> [PageSight.Line?]) {
        let clock = ManualClock()
        let sight = PageSight(clock: clock)
        var seen: [PageSight.Line?] = []
        sight.onChange = { seen.append($0) }
        return (sight, clock, { defer { seen = [] }; return seen })
    }

    private func state(_ s: PageEngineState.State, _ app: AppRef? = nil) -> PageEngineState {
        PageEngineState(at: 1, browser: app ?? chrome, state: s)
    }

    /// The golden lines (protocol.ndjson 67 and 68): missing, then connected.
    func testMissingShowsTheLineOnceAndConnectedTakesItDown() throws {
        let (sight, _, take) = rig()
        let line = PageSight.Line(browserPID: 6100, browserName: "Google Chrome")
        sight.receive(state(.missing), frontmostPID: 6100, paused: false)
        XCTAssertEqual(take(), [line])
        sight.receive(state(.connected), frontmostPID: 6100, paused: false)
        XCTAssertEqual(take(), [nil])
        sight.receive(state(.missing), frontmostPID: 6100, paused: false)
        XCTAssertEqual(take(), [], "at most once per browser per session")
        XCTAssertEqual(sight.debugInfo, PageSight.DebugInfo(shown: nil, asked: [6100], missing: [6100]))
    }

    /// PR #16 review: turning Caret off in the browser takes its line down at once, and only its own.
    func testTurningCaretOffInTheBrowserTakesItsLineDown() {
        let (sight, _, take) = rig()
        sight.receive(state(.missing), frontmostPID: 6100, paused: false)
        _ = take()
        sight.turnedOff(7000)
        XCTAssertEqual(take(), [], "another app's switch leaves it")
        sight.turnedOff(6100)
        XCTAssertEqual(take(), [nil])
        XCTAssertNil(sight.shown)
    }

    func testTheLineLeavesWithItsBrowserAndAfterItsLifetime() {
        let (sight, clock, take) = rig()
        sight.receive(state(.missing), frontmostPID: 6100, paused: false)
        _ = take()
        sight.frontmostChanged(7000, paused: false)
        XCTAssertEqual(take(), [nil])
        let (other, otherClock, otherTake) = rig()
        other.receive(state(.missing), frontmostPID: 6100, paused: false)
        _ = otherTake()
        otherClock.advance(by: PageSight.lifetime - 0.1)
        XCTAssertEqual(otherTake(), [])
        otherClock.advance(by: 0.2)
        XCTAssertEqual(otherTake(), [nil])
        _ = clock
    }

    /// Said while another app was in front: shown when the browser comes forward, if still missing.
    func testABrowserBehindIsAskedAboutWhenItComesForward() {
        let (sight, _, take) = rig()
        sight.receive(state(.missing), frontmostPID: 7000, paused: false)
        XCTAssertEqual(take(), [])
        sight.frontmostChanged(6100, paused: false)
        XCTAssertEqual(take().count, 1)
    }

    /// Every Chromium browser hears it; Add to Chrome is offered where the installer can add it
    /// (Chrome, Helium); paused, Caret says nothing; a helper that goes away takes what it said with it.
    func testEveryBrowserHearsItAddOnlyWhereItCanNotWhilePausedOrAfterTheHelperGoes() {
        let (sight, _, take) = rig()
        sight.receive(state(.missing, AppRef(pid: 6200, bundleId: "com.brave.Browser", name: "Brave")), frontmostPID: 6200, paused: false)
        XCTAssertEqual(take(), [PageSight.Line(browserPID: 6200, browserName: "Brave", canAdd: false)])
        sight.receive(state(.missing, AppRef(pid: 6300, bundleId: "net.imput.helium", name: "Helium")), frontmostPID: 6300, paused: false)
        XCTAssertEqual(take().last??.canAdd, true)
        sight.frontmostChanged(6100, paused: false)
        XCTAssertEqual(take(), [nil], "Helium's line goes with Helium")
        sight.receive(state(.missing), frontmostPID: 6100, paused: true)
        XCTAssertEqual(take(), [])
        sight.helperGone()
        sight.frontmostChanged(6100, paused: false)
        XCTAssertEqual(take(), [], "nothing is missing once the helper is gone")
        XCTAssertTrue(PageSight.isChrome(bundleID: "com.google.chrome.for.testing"))
        XCTAssertTrue(PageSight.isChrome(bundleID: "com.google.Chrome.canary"))
        XCTAssertFalse(PageSight.isChrome(bundleID: "com.google.chromex"))
    }

    func testAddToChromeTakesTheLineDown() {
        let (sight, _, take) = rig()
        sight.receive(state(.missing), frontmostPID: 6100, paused: false)
        _ = take()
        sight.addToChromeChosen()
        XCTAssertEqual(take(), [nil])
        XCTAssertNil(sight.shown)
    }
}

/// H5's attachments (lead decision 7): the card proposes the likely file, Tab confirms it for that
/// run, and the run starts only on the helper's yes.
final class AttachmentTests: XCTestCase {
    private static let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("helper/fixtures/golden/host.ndjson")

    private static func line(_ i: Int) throws -> Data {
        Data(try String(contentsOf: url, encoding: .utf8).split(separator: "\n")[i].utf8)
    }

    private func proposal() throws -> PlanProposal {
        guard case .planProposal(let p) = try HelperInbound.decode(try Self.line(5)) else { throw Unexpected("line 6 is not a planProposal") }
        return p
    }

    private let chicago: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }()
    /// Thursday 2026-10-01, 18:00 in Chicago.
    private let now = Date(timeIntervalSince1970: 1_790_895_600)
    private var resume: ProposedFile { ProposedFile(path: "/tmp/caret-fixture/Resume.pdf", name: "Resume.pdf", modified: now.addingTimeInterval(-2 * 86_400), size: 48_213) }

    func testTheGoldenLinesDecodeAndEncode() throws {
        let p = try proposal()
        XCTAssertEqual(p.attach, PlanProposal.Attach(step: 0, field: "Resume/CV", wants: "your resume"))
        XCTAssertNil(p.handoff)
        let confirm = FileConfirm(requestId: "file-1", at: 1_790_001_006_000, taskId: "plan-8-ask-8", path: "/tmp/caret-fixture/Resume.pdf")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: JSONEncoder().encode(confirm)) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: Self.line(6)) as? NSDictionary)
        guard case .notForConsumer("fileConfirm") = try HelperInbound.decode(try Self.line(6)) else { return XCTFail("the host's own line") }
        guard case .fileConfirmReply(let yes) = try HelperInbound.decode(try Self.line(7)),
              case .fileConfirmReply(let no) = try HelperInbound.decode(try Self.line(8)) else { return XCTFail("lines 8 and 9 are replies") }
        XCTAssertEqual(yes.outcome, .confirmed)
        XCTAssertEqual(yes.file, FileConfirmReply.File(name: "Resume.pdf", size: 48213))
        XCTAssertEqual(no.says, "Caret couldn't read that file, so it attached nothing. Choose another one.")
        // What protocol.ts refuses is refused here too (review #4).
        for bad in [
            #"{"type":"fileConfirmReply","v":1,"requestId":"f","taskId":"t","outcome":"confirmed","file":null,"says":null}"#,
            #"{"type":"fileConfirmReply","v":1,"requestId":"f","taskId":"t","outcome":"refused","file":null,"says":null}"#,
            #"{"type":"fileConfirmReply","v":1,"requestId":"f","taskId":"t","outcome":"confirmed","file":{"name":"a.pdf","size":-1},"says":null}"#,
            #"{"type":"fileConfirmReply","v":1,"requestId":"f","taskId":"t","outcome":"refused","file":null,"says":""}"#,
        ] { XCTAssertThrowsError(try HelperInbound.decode(Data(bad.utf8)), bad) }
        var proposal = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.line(5)) as? [String: Any])
        for bad: [String: Any] in [["step": -1, "field": "F", "wants": "w"], ["step": 0, "field": "", "wants": "w"], ["step": 0, "field": "F", "wants": ""]] {
            proposal["attach"] = bad
            XCTAssertThrowsError(try HelperInbound.decode(JSONSerialization.data(withJSONObject: proposal)), "\(bad)")
        }
        let refusal = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try String(contentsOf: Self.url, encoding: .utf8).split(separator: "\n")[0].utf8)) as? [String: Any])
        var nullSays = refusal
        nullSays["error"] = ["code": "unsupportedStep", "detail": "d", "says": NSNull()]
        XCTAssertThrowsError(try HelperInbound.decode(JSONSerialization.data(withJSONObject: nullSays)), "says is optional, never null")
    }

    /// The card proposes the file it found, with when it was edited; with none, attaching is the user's.
    func testTheCardProposesTheLikelyFile() throws {
        let card = try XCTUnwrap(AskCaret.card(try proposal(), file: resume, now: now, calendar: chicago))
        XCTAssertEqual(card.title, "Attach Resume.pdf in Google Chrome")
        XCTAssertEqual(card.steps, [AskCaret.Step(text: "Resume/CV: Resume.pdf, edited Tue", field: "Resume/CV")])
        XCTAssertEqual(card.writes, 0)
        XCTAssertEqual(card.action, "Attach it")
        let none = try XCTUnwrap(AskCaret.card(try proposal(), file: nil, now: now, calendar: chicago))
        XCTAssertEqual(none.title, "Attach your resume in Google Chrome")
        XCTAssertEqual(none.steps, [AskCaret.Step(text: "Resume/CV: your resume", yours: true, field: "Resume/CV")])
    }

    private func asked(file: ProposedFile?) throws -> (AskCaret, ManualClock, () -> [AskCaret.Send]) {
        let clock = ManualClock()
        let ask = AskCaret(clock: clock)
        var sent: [AskCaret.Send] = []
        ask.send = { sent.append($0); return true }
        ask.likelyFile = { _ in file }
        ask.linkChanged(true)
        ask.edit("attach my resume")
        ask.submit()
        var p = try proposal()
        p.requestId = "ask-1"
        ask.receive(p)
        return (ask, clock, { defer { sent = [] }; return sent })
    }

    func testTabConfirmsTheFileAndTheRunStartsOnTheHelpersYes() throws {
        let (ask, _, take) = try asked(file: resume)
        _ = take()
        XCTAssertTrue(ask.tab())
        guard case .confirmFile(let confirm)? = take().first else { return XCTFail("Tab sends the file first") }
        XCTAssertEqual(confirm.requestId, "file-2")
        XCTAssertEqual(confirm.taskId, "plan-8-ask-8")
        XCTAssertEqual(confirm.path, resume.path)
        XCTAssertTrue(ask.tab(), "Tab while the answer is on its way takes the key")
        XCTAssertEqual(take().count, 0, "and sends nothing more")
        guard case .proposed = ask.phase else { return XCTFail("still the card until the helper answers") }
        var yes = try FileConfirmReply.decode(Self.line(7))
        yes.requestId = "file-2"
        ask.receive(yes)
        guard case .running = ask.phase else { return XCTFail("the run starts: \(ask.phase)") }
        guard case .accept(let accept)? = take().first else { return XCTFail("offerAccept follows the confirmation") }
        XCTAssertEqual(accept.offerId, "plan-8-ask-8")
    }

    func testARefusedOrUnansweredFileRunsNothing() throws {
        let (ask, clock, take) = try asked(file: resume)
        ask.tab()
        var no = try FileConfirmReply.decode(Self.line(8))
        no.requestId = "file-2"
        ask.receive(no)
        XCTAssertEqual(ask.phase, .failed("Caret couldn't read that file, so it attached nothing. Choose another one."))
        XCTAssertFalse(take().contains { if case .accept = $0 { return true } else { return false } })
        let (late, lateClock, lateTake) = try asked(file: resume)
        late.tab()
        lateClock.advance(by: AskCaret.confirmWait + 0.1)
        XCTAssertEqual(late.phase, .failed(AskCopy.fileUnanswered))
        XCTAssertFalse(lateTake().contains { if case .accept = $0 { return true } else { return false } })
        _ = clock
    }

    private func progress(_ phase: String, step: Int, detail: String) throws -> TaskProgress {
        let json = #"{"type":"taskProgress","v":1,"at":1,"taskId":"plan-8-ask-8","planId":"plan-8-ask-8","step":\#(step),"steps":1,"says":"Resume/CV holds your resume","detail":"\#(detail)","phase":"\#(phase)"}"#
        guard case .taskProgress(let p) = try HelperInbound.decode(Data(json.utf8)) else { throw Unexpected("not progress") }
        return p
    }

    /// Review #2: the run hands the attach back (the file changed after Tab). The card leaves the
    /// attach to do, says so, and counts no field filled.
    func testAnAttachHandedBackStaysToDoAndSaysSo() throws {
        let (ask, _, _) = try asked(file: resume)
        ask.tab()
        var yes = try FileConfirmReply.decode(Self.line(7))
        yes.requestId = "file-2"
        ask.receive(yes)
        ask.receive(try progress("handoff", step: 0, detail: "Caret did not attach your resume: the file changed after you confirmed it; attaching it is yours"))
        guard case .ended(let card, let line) = ask.phase else { return XCTFail("\(ask.phase)") }
        XCTAssertEqual(card.steps.map(\.state), [.pending])
        XCTAssertEqual(line.text, "Your turn: attach Resume.pdf to Resume/CV in Google Chrome. Caret didn't attach it.")
        XCTAssertEqual(AskCaret.filled(card), 0)
    }

    /// Review #3: six writes, the card lists five and "1 more", then the attach. The hidden sixth write
    /// maps to no row, and the attach step to its own.
    func testAHiddenWriteMapsToNoRowAndTheAttachToItsOwn() {
        let writes = (0..<5).map { AskCaret.Step(text: "w\($0)", field: "F\($0)") }
        let card = AskCaret.Card(
            title: "t", app: "Google Chrome", steps: writes + [AskCaret.Step(text: "Resume/CV: Resume.pdf", field: "Resume/CV")], more: 1, action: "Fill 6 fields and attach",
            offerKey: "k", actionId: "run", writes: 6, press: nil, attach: .init(field: "Resume/CV", wants: "your resume", file: resume, step: 6)
        )
        XCTAssertEqual(AskCaret.cardIndex(ofPlanStep: 4, in: card), 4)
        XCTAssertNil(AskCaret.cardIndex(ofPlanStep: 5, in: card), "the write the card does not list")
        XCTAssertEqual(AskCaret.cardIndex(ofPlanStep: 6, in: card), 5, "the attach")
        // An attach the plan puts first: the writes after it count from 0.
        var first = card
        first.attach?.step = 0
        XCTAssertEqual(AskCaret.cardIndex(ofPlanStep: 0, in: first), 5)
        XCTAssertEqual(AskCaret.cardIndex(ofPlanStep: 1, in: first), 0)
    }

    /// With no likely file, Tab runs the plan as it is, and the run hands the attach to the user.
    func testWithNoFileTabRunsWithoutAConfirmation() throws {
        let (ask, _, take) = try asked(file: nil)
        _ = take()
        ask.tab()
        let sent = take()
        XCTAssertFalse(sent.contains { if case .confirmFile = $0 { return true } else { return false } })
        XCTAssertTrue(sent.contains { if case .accept = $0 { return true } else { return false } })
    }

    func testAPickedFileIsNamedWithWhenItWasEdited() {
        XCTAssertEqual(LikelyFile.edited(now.addingTimeInterval(-3600), now: now, calendar: chicago), "edited today")
        XCTAssertEqual(LikelyFile.edited(now.addingTimeInterval(-86_400), now: now, calendar: chicago), "edited yesterday")
        XCTAssertEqual(LikelyFile.edited(now.addingTimeInterval(-40 * 86_400), now: now, calendar: chicago), "edited Aug 22")
    }
}

extension FileConfirmReply {
    static func decode(_ data: Data) throws -> FileConfirmReply { try JSONDecoder().decode(FileConfirmReply.self, from: data) }
}
