import AppKit
import CaretHostCore
import CaretScreenCore
import XCTest
@testable import CaretHost

/// Onboarding's panes rendered off screen and compared with the committed references, the copy rules checked against
/// the copy file, the window's key mapping, and the hidden flow driven through the debug socket's commands with a
/// settings file and progress file of the test's own.
@MainActor
final class OnboardingHostTests: XCTestCase {
    func testEveryOnboardingPaneMatchesItsReference() throws {
        try SnapshotTests.check(Gallery.onboarding())
    }

    /// The lead reads the copy line by line; this catches the rules a machine can: no em or en dashes, no exclamation
    /// marks, no all-caps labels.
    func testOnboardingCopyFollowsTheRules() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/CaretHost/Onboarding/OnboardingCopy.swift").standardized
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("\u{2014}"), "em dash")
        XCTAssertFalse(text.contains("\u{2013}"), "en dash")
        let literals = try NSRegularExpression(pattern: #""([^"\\]{2,})""#)
        let shown = literals.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
        XCTAssertGreaterThan(shown.count, 40, "the pattern must find the copy")
        for line in shown {
            XCTAssertFalse(line.contains("!"), line)
            let letters = line.filter(\.isLetter)
            XCTAssertFalse(letters.count >= 3 && letters == letters.uppercased(), "all caps: \(line)")
        }
    }

    /// The promise the build bundles is PRIVACY_PROMISE byte for byte (scripts/privacy_gate.sh); parsed for the `on`
    /// pane, it splits into exactly its blank-line-separated blocks, none changed, whatever its words.
    func testTheBundledPromiseParsesIntoItsOwnBlocks() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../helper/src/privacy.ts").standardized
        let typescript = try String(contentsOf: source, encoding: .utf8)
        let start = try XCTUnwrap(typescript.range(of: "export const PRIVACY_PROMISE = `"), "privacy.ts has no PRIVACY_PROMISE")
        let end = try XCTUnwrap(typescript.range(of: "`;", range: start.upperBound..<typescript.endIndex))
        let text = String(typescript[start.upperBound..<end.lowerBound])
        XCTAssertFalse(text.contains("${") || text.contains("\\"), "the template literal must be plain text for this read to equal the bundled bytes")
        let promise = try XCTUnwrap(PrivacyPromise(text))
        XCTAssertEqual(promise.blocks.map(\.text), text.components(separatedBy: PrivacyPromise.separator))
        XCTAssertTrue(promise.blocks.contains { if case .heading = $0 { true } else { false } }, "the promise's section headings must parse as headings")
    }

    // MARK: - Keys

    private func key(_ code: UInt16, _ chars: String = "", mods: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }

    private func state(_ step: OnboardingStep, ghost: String? = nil) -> OnboardingFlow.State {
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: .init(accessibility: step != .hello, inputMonitoring: false),
                                  clock: Gallery.StillClock(), opening: .init(step: step))
        var s = flow.state
        s.hello.ghost = ghost
        return s
    }

    func testReturnIsThePrimaryEverywhereExceptWhileAnInputMethodComposes() {
        for step in OnboardingStep.allCases {
            XCTAssertEqual(OnboardingController.event(for: key(36, "\r"), state: state(step)), .next, "\(step)")
        }
        XCTAssertNil(OnboardingController.event(for: key(36, "\r"), state: state(.hello), composing: true))
        XCTAssertNil(OnboardingController.event(for: key(0, "a"), state: state(.hello)), "typing goes to the field")
    }

    func testTabIsTheHelloFieldsOnlyWhileAGhostShows() {
        XCTAssertEqual(OnboardingController.event(for: key(48, "\t"), state: state(.hello, ghost: " for that.")), .key(.tab))
        XCTAssertNil(OnboardingController.event(for: key(48, "\t"), state: state(.hello)), "no ghost: Tab moves focus")
        XCTAssertNil(OnboardingController.event(for: key(48, "\t", mods: .shift), state: state(.hello, ghost: " x")))
        XCTAssertNil(OnboardingController.event(for: key(48, "\t"), state: state(.on)))
    }

    func testEscIsNotNowOnTheFirstStepAndNothingElsewhere() {
        XCTAssertEqual(OnboardingController.event(for: key(53, "\u{1b}"), state: state(.first)), .key(.escape))
        for step in [OnboardingStep.hello, .access, .on] {
            XCTAssertNil(OnboardingController.event(for: key(53, "\u{1b}"), state: state(step)), "\(step): there is no Back")
        }
    }

    // MARK: - The hidden flow over the socket's commands

    private func temp() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
    }

    private func controller(_ dir: URL, mode: OnboardingController.Mode = .hidden) -> OnboardingController {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return OnboardingController(mode: mode, testHooks: true, store: SettingsStore(path: dir.appendingPathComponent("settings.json").path),
                                    progressPath: dir.appendingPathComponent("onboarding-progress.json").path)
    }

    private func run(_ controller: OnboardingController, _ line: String) throws -> DebugState.OnboardingInfo {
        let words = line.split(separator: " ", maxSplits: line.hasPrefix("onboarding reply") ? 2 : Int.max).map(String.init)
        let reply = controller.command(words)
        XCTAssertFalse(reply.contains("\"error\""), "\(line): \(reply)")
        return try JSONDecoder().decode(DebugState.OnboardingInfo.self, from: Data(reply.utf8))
    }

    /// Lets the flow's real-time timers fire (the grant's 900 ms landing).
    private func wait(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    func testAHiddenFlowWalksToTheEndAndRemembersWhereItWas() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = controller(dir)
        var asked: [FirstLookRequest] = []
        var previews: [[String]] = []
        c.sendFirstLook = { asked.append($0); return true }
        c.sendPreview = { _, families, _ in previews.append(families); return true }
        XCTAssertEqual(c.command(["onboarding"]), #"{"open":false}"#)
        // The test runner itself may hold Accessibility: the run says what Caret has.
        c.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        XCTAssertEqual(try run(c, "onboarding open").step, "hello")
        XCTAssertEqual(try run(c, "onboarding type Hi Dana, thanks").hello?.textLength, 15)
        let access = try run(c, "onboarding next")
        XCTAssertEqual(access.step, "access")
        XCTAssertEqual(access.frame, "guide")
        XCTAssertEqual(access.suppressed, ["openSystemSettings"], "a hidden flow never opens System Settings")
        XCTAssertEqual(c.progress?.step, .access, "a relaunch would reopen at the switch")
        _ = try run(c, "onboarding permissions on off")
        wait(OnboardingFlow.grantLanding + 0.4)
        XCTAssertEqual(try run(c, "onboarding").step, "browser", "the switch moved the flow by itself")
        _ = try run(c, "onboarding browsers Helium")
        let adding = try run(c, "onboarding next")
        XCTAssertEqual(adding.browserOpened, true)
        XCTAssertEqual(adding.suppressed, ["openSystemSettings", "addToBrowser"], "a hidden flow writes no browser host")
        _ = try run(c, "onboarding browser-connected")
        wait(OnboardingFlow.grantLanding + 0.4)
        let on = try run(c, "onboarding")
        XCTAssertEqual(on.step, "on", "the extension's connection moved the flow by itself")
        XCTAssertEqual(on.preview, "building")
        XCTAssertEqual(previews.count, 1)
        XCTAssertEqual(try run(c, "onboarding preview 2").preview, "ready")
        let looking = try run(c, "onboarding next")
        XCTAssertEqual(looking.decision, "sent")
        XCTAssertEqual(asked.map(\.previewId), ["test-2"], "the look is limited to the preview the person saw")
        let reply = #"{"type":"firstLookReply","v":1,"requestId":"\#(asked[0].requestId)","at":1,"outcome":"nothing","found":null,"scanned":null,"error":null}"#
        XCTAssertEqual(try run(c, "onboarding reply \(reply)").step, "first")
        let done = try run(c, "onboarding next")
        XCTAssertTrue(done.finished)
        XCTAssertEqual(done.windowShown, false)
        XCTAssertTrue(c.debugInfo()?.finished == true)
    }

    /// Codex on #30: Complete words switched off while the hello field's completion is inside the model. The answer
    /// arrives before the 0.5 s readiness poll, and is dropped rather than shown for Tab to take.
    func testACompletionThatOutlivesTheModelIsNotShown() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = controller(dir)
        var readiness = ModelReadiness.ready
        var answered = false
        c.modelReadiness = { readiness }
        c.complete = { _ in
            readiness = .off
            answered = true
            return " for that."
        }
        c.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        XCTAssertEqual(try run(c, "onboarding open").step, "hello")
        _ = try run(c, "onboarding type Hi Dana, thanks")
        let deadline = Date().addingTimeInterval(3)
        while !answered, Date() < deadline { wait(0.01) }
        XCTAssertTrue(answered, "the field asked the model")
        wait(0.05)
        let hello = try XCTUnwrap(try run(c, "onboarding").hello)
        XCTAssertNil(hello.ghostLength)
        XCTAssertEqual(hello.model, "off")
    }

    func testARelaunchResumesAtTheSwitchOrPastIt() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let first = controller(dir)
        first.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        _ = try run(first, "onboarding open")
        _ = try run(first, "onboarding next")
        first.close()
        let off = controller(dir, mode: .auto)
        off.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        XCTAssertEqual(off.launchOpening(), .init(step: .access, reopened: true), "no welcome again; the switch says it is still off")
        let granted = controller(dir, mode: .auto)
        granted.permissionsOverride = .init(accessibility: true, inputMonitoring: false)
        XCTAssertEqual(granted.launchOpening(), .init(step: .on, reopened: true), "relaunched after the grant: straight on")
    }

    func testSetUpLaterClosesAndTheNextLaunchOpensAtTheSwitch() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = controller(dir)
        c.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        _ = try run(c, "onboarding open")
        _ = c.command(["onboarding", "later"])
        XCTAssertNil(c.debugInfo(), "closed, unfinished")
        let next = controller(dir, mode: .auto)
        next.permissionsOverride = .init(accessibility: false, inputMonitoring: false)
        XCTAssertEqual(next.launchOpening()?.step, .access)
    }

    func testTheCoachSlipIsShownOncePerInstall() throws {
        let dir = temp()
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertFalse(controller(dir).coachShown)
        controller(dir).markCoachShown()
        XCTAssertTrue(controller(dir).coachShown, "read back by the next launch")
    }

    /// A line that stays is drawn as a hatch bar: even if the wire carried words for it, the screen gets none.
    func testThePreviewKeepsNoTextForALineThatStays() {
        let wire = FirstLookPreview(requestId: "r", at: 1, previewId: "p", windows: [
            .init(bundleId: "com.apple.mail", appName: "Mail", title: "Thursday?", lines: [.init(text: "Thursday at 3", sent: true), .init(text: "secret words", sent: false)], charsSent: 13),
        ], totalChars: 13)
        let screen = OnboardingController.screenPreview(wire)
        XCTAssertEqual(screen.windows.first?.lines.map(\.text), ["Thursday at 3", nil])
        XCTAssertEqual(screen.previewId, "p")
        XCTAssertEqual(screen.chars, 13)
    }

    func testWithoutTestHooksTheSocketOnlyReads() {
        let controller = OnboardingController(mode: .hidden, testHooks: false, store: SettingsStore(path: "/nonexistent/caret-settings.json"))
        XCTAssertTrue(controller.command(["onboarding", "open"]).contains("test hooks"))
    }

    // MARK: - H8: a found event card asks for Calendar access first

    final class FakeAsker: CalendarAccessAsking {
        var access: CalendarAccess = .notDetermined
        var asked: [(CalendarAccess) -> Void] = []
        func requestAccess(_ done: @escaping (CalendarAccess) -> Void) { asked.append(done) }
    }

    /// A hidden flow at the first step with an event card found, its accept and stop recorded.
    private func atFoundEvent(_ calendars: FakeAsker, accepts: @escaping (OfferAccept) -> Void, stops: @escaping (OfferStop) -> Void) throws -> (OnboardingController, String, () -> Void) {
        let dir = temp()
        let c = controller(dir)
        c.calendars = calendars
        var asked: [FirstLookRequest] = []
        c.sendFirstLook = { asked.append($0); return true }
        c.sendPreview = { _, _, _ in true }
        c.sendAccept = { accepts($0); return true }
        c.sendStop = { stops($0); return true }
        for line in ["onboarding open on", "onboarding permissions on on", "onboarding preview 1", "onboarding next"] {
            XCTAssertFalse(c.command(line.split(separator: " ").map(String.init)).contains("\"error\""), line)
        }
        let request = try XCTUnwrap(asked.last, "the first look asked")
        XCTAssertTrue(request.families.contains("event"))
        let key = FirstLookReply.offerKey(requestId: request.requestId)
        let found = #"{"kind":"action","family":"event","offerKey":"\#(key)","window":{"pid":5151,"windowId":"5151-2","appName":"Messages","title":"Dana"},"spec":{"v":1,"id":"\#(key)","figure":"offering","blocks":[{"type":"header","title":{"text":"Coffee with Dana","ref":{"rule":"eventTitle","derived":[{"node":"5151-2/k"}]}}},{"type":"facts","rows":[{"label":"When","value":{"text":"Thu 3:00 to 3:30 PM","ref":{"rule":"eventTime","derived":[{"node":"5151-2/k"}]}}}]},{"type":"actions","items":[{"id":"add","label":"Add","key":"tab"}]}]}}"#
        let reply = #"{"type":"firstLookReply","v":1,"requestId":"\#(request.requestId)","at":1,"outcome":"found","found":\#(found),"scanned":null,"error":null}"#
        let answered = c.command(["onboarding", "reply", reply])
        XCTAssertFalse(answered.contains("\"error\""), answered)
        XCTAssertTrue(answered.contains("\"firstLook\":\"found\""), answered)
        return (c, key, { try? FileManager.default.removeItem(at: dir) })
    }

    func testAFoundEventCardAsksForCalendarAccessBeforeItsAcceptGoes() throws {
        let calendars = FakeAsker()
        var accepts: [OfferAccept] = []
        let (c, key, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { _ in })
        defer { cleanup() }
        XCTAssertTrue(calendars.asked.isEmpty, "showing the card asks nothing")
        XCTAssertEqual(c.command(["onboarding", "key", "tab"]).contains("\"calendar\":\"asking\""), true)
        XCTAssertEqual(calendars.asked.count, 1, "Tab asks macOS once")
        XCTAssertTrue(accepts.isEmpty, "nothing goes before macOS answers")
        calendars.access = .fullAccess
        try XCTUnwrap(calendars.asked.first)(.fullAccess)
        XCTAssertEqual(accepts.map(\.offerId), [key])
        XCTAssertEqual(accepts.map(\.actionId), ["add"])
    }

    func testADeniedCalendarSendsNeitherTheAcceptNorAStop() throws {
        let calendars = FakeAsker()
        var accepts: [OfferAccept] = []
        var stops: [OfferStop] = []
        let (c, _, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { stops.append($0) })
        defer { cleanup() }
        _ = c.command(["onboarding", "key", "tab"])
        _ = c.command(["onboarding", "key", "esc"])
        calendars.asked.first?(.denied)
        XCTAssertTrue(accepts.isEmpty)
        XCTAssertTrue(stops.isEmpty, "the helper never heard of the accept")
        XCTAssertEqual(c.debugInfo()?.calendar, "denied")
    }

    func testOnceMacOSHasAnsweredAFoundEventCardGoesAtOnce() throws {
        let calendars = FakeAsker()
        calendars.access = .denied
        var accepts: [OfferAccept] = []
        let (c, key, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { _ in })
        defer { cleanup() }
        _ = c.command(["onboarding", "key", "tab"])
        XCTAssertTrue(calendars.asked.isEmpty)
        XCTAssertEqual(accepts.map(\.offerId), [key])
    }
}
