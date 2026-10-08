import AppKit
import CaretHostCore
import CaretScreenCore
import XCTest
@testable import CaretHost

/// Onboarding's screens rendered off screen and compared with the committed references, the copy
/// rules checked against the source, the window's key mapping, and the hidden flow driven through
/// the debug socket's commands with a settings file of the test's own.
@MainActor
final class OnboardingHostTests: XCTestCase {
    func testEveryOnboardingScreenMatchesItsReference() throws {
        try SnapshotTests.check(Gallery.onboarding())
    }

    func testTheOtherCharactersRenderForReview() throws {
        guard let outDir = SnapshotTests.outDir else { return }
        for character in [FigureCharacter.seed, .wren] {
            for item in Gallery.onboarding(character) where ["onboarding-welcome", "onboarding-try-it"].contains(item.name) {
                for dark in [false, true] {
                    let data = try XCTUnwrap(Gallery.png(item.view, dark: dark))
                    try SnapshotTests.write(data, to: outDir.appendingPathComponent("\(character.rawValue)/\(item.name)-\(dark ? "dark" : "light").png"))
                }
            }
        }
    }

    /// The lead reads the copy line by line; this catches the rules a machine can: no em or en
    /// dashes, no exclamation marks in what is shown, no all-caps labels, and the privacy line says
    /// what is sent instead of claiming nothing leaves (Fable plan, section 5, change 4).
    func testOnboardingCopyFollowsTheRules() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/CaretHost/Onboarding/OnboardingView.swift").standardized
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("\u{2014}"), "em dash")
        XCTAssertFalse(text.contains("\u{2013}"), "en dash")
        XCTAssertFalse(text.contains("Text stays on this Mac"))
        XCTAssertFalse(text.contains("Never whole windows."))
        let literals = try NSRegularExpression(pattern: #"(?:Text|Button|ScreenTitle\(title:|detail:|SectionLabel\(text:)\(?"([^"\\]*)""#)
        let shown = literals.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
        XCTAssertGreaterThan(shown.count, 12, "the pattern must find the copy")
        for line in shown {
            XCTAssertFalse(line.contains("!"), line)
            let letters = line.filter(\.isLetter)
            XCTAssertFalse(letters.count >= 2 && letters == letters.uppercased(), "all caps: \(line)")
        }
    }

    /// The permissions step shows the promise it is given, all of it: the text below is this test's own, so the check
    /// holds whatever the approved words become. Rendering it differs from rendering no promise, so the text reaches
    /// the step rather than stopping at the window.
    func testThePermissionsStepShowsTheInjectedPromise() throws {
        let text = "What a test sends\n\nA first paragraph, long enough to wrap onto a second line in the permissions step of onboarding.\n\nWho a test tells\n\nA second paragraph.\n\nA third paragraph."
        let promise = try XCTUnwrap(PrivacyPromise(text))
        XCTAssertEqual(promise.blocks.map(\.text).joined(separator: PrivacyPromise.separator), text)
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: false, inputMonitoring: true), clock: Gallery.StillClock())
        flow.send(.next)
        flow.send(.next)
        XCTAssertEqual(flow.state.step, .permissions)
        let shown = try XCTUnwrap(Gallery.png(OnboardingView(state: flow.state, character: .pebble, animated: false, promise: promise), dark: false))
        let missing = try XCTUnwrap(Gallery.png(OnboardingView(state: flow.state, character: .pebble, animated: false, promise: nil), dark: false))
        XCTAssertGreaterThan(try SnapshotTests.difference(shown, missing), 0)
        // Other words in the same shape draw differently: the step draws the text it was given, not a fixed one.
        let other = try XCTUnwrap(PrivacyPromise(text.replacingOccurrences(of: "A first paragraph", with: "Another opening")))
        let otherShown = try XCTUnwrap(Gallery.png(OnboardingView(state: flow.state, character: .pebble, animated: false, promise: other), dark: false))
        XCTAssertGreaterThan(try SnapshotTests.difference(shown, otherShown), 0)
    }

    /// A test process has no app bundle, as `swift run` has none: no promise is read, the window's default shows the
    /// missing state (the same pixels as passing no promise), and that state names the file. Nothing stands in for it.
    func testWithoutTheResourceTheStepNamesItAndShowsNoPromise() throws {
        XCTAssertNil(Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt"), "the test runner must have no resource")
        XCTAssertNil(PermissionsScreen.privacyLine)
        XCTAssertTrue(PermissionsScreen.missingPromiseLine.contains("PrivacyPromise.txt"))
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: false, inputMonitoring: true), clock: Gallery.StillClock())
        flow.send(.next)
        flow.send(.next)
        let byDefault = try XCTUnwrap(Gallery.png(OnboardingView(state: flow.state, character: .pebble, animated: false), dark: false))
        let missing = try XCTUnwrap(Gallery.png(OnboardingView(state: flow.state, character: .pebble, animated: false, promise: nil), dark: false))
        XCTAssertEqual(try SnapshotTests.difference(byDefault, missing), 0)
    }

    /// The know screen's words (A11 brief): what it asks for, why, and where it can be changed.
    func testTheKnowScreensWordingIsPinned() {
        XCTAssertEqual(KnowScreen.title, "What Caret knows so far.")
        XCTAssertEqual(KnowScreen.detail, "Type your name and email, and Caret can fill them in for you.")
        XCTAssertEqual(KnowScreen.footnote, "Continue saves these on this Mac. When Caret works out what to fill, they may go to its cloud model. Change or remove them any time in What Caret Knows, in the menu bar.")
        XCTAssertFalse(KnowScreen.footnote.contains("keeps these"), "nothing keeps them until the helper accepts add")
        XCTAssertEqual(AboutField.allCases.map(\.label), ["Name", "Email"])
        var draft = AboutDraft()
        draft.email = "dana@"
        XCTAssertEqual(draft.problem, "That email looks incomplete.")
        for line in [KnowScreen.title, KnowScreen.detail, KnowScreen.footnote, draft.problem!] {
            XCTAssertFalse(line.contains("\u{2014}") || line.contains("\u{2013}") || line.contains("!"), line)
        }
    }

    func testReturnThatEndsAnInputMethodsCompositionStaysInTheField() {
        XCTAssertNil(OnboardingController.event(for: key(36, "\r"), step: .know, offerVisible: false, composing: true))
        XCTAssertNil(OnboardingController.event(for: key(53, "\u{1b}"), step: .know, offerVisible: false, composing: true))
        XCTAssertEqual(OnboardingController.event(for: key(36, "\r"), step: .know, offerVisible: false), .next)
        XCTAssertNil(OnboardingController.event(for: key(0, "a"), step: .know, offerVisible: false), "typing goes to the field")
        XCTAssertNil(OnboardingController.event(for: key(48, "\t"), step: .know, offerVisible: false), "Tab moves between the fields")
    }

    // MARK: - Keys

    private func key(_ code: UInt16, _ chars: String = "", mods: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }

    func testTheWindowsKeysMapToTheFlowsEvents() {
        func map(_ e: NSEvent, _ step: OnboardingStep, offer: Bool = true) -> OnboardingFlow.Event? {
            OnboardingController.event(for: e, step: step, offerVisible: offer)
        }
        XCTAssertEqual(map(key(36, "\r"), .work), .next)
        XCTAssertEqual(map(key(53, "\u{1b}"), .permissions), .back)
        XCTAssertEqual(map(key(48, "\t"), .tryIt), .key(.tab))
        XCTAssertNil(map(key(48, "\t"), .tryIt, offer: false), "with no offer showing, Tab moves focus as usual")
        XCTAssertNil(map(key(48, "\t"), .work), "Tab moves focus on the other screens")
        XCTAssertNil(map(key(48, "\t", mods: .shift), .tryIt), "Shift-Tab is not the offer's key")
        XCTAssertNil(map(key(48, "\t", mods: .command), .tryIt))
        XCTAssertEqual(map(key(51, "\u{7f}"), .tryIt), .key(.delete))
        XCTAssertEqual(map(key(18, "1"), .tryIt), .key(.character("1")))
        XCTAssertNil(map(key(18, "1"), .work))
        XCTAssertEqual(map(key(123, "\u{F702}"), .tryIt), .key(.other), "an arrow is not typing")
    }

    func testTheFirstLooksKeysGoToItsOfferOnlyWhileItTakesThem() {
        func map(_ e: NSEvent, _ keys: FirstLookKeys) -> OnboardingFlow.Event? {
            OnboardingController.event(for: e, step: .firstLook, offerVisible: false, firstLook: keys)
        }
        let offered = FirstLookKeys(tab: true, digits: [2])
        XCTAssertEqual(map(key(48, "\t"), offered), .key(.tab))
        XCTAssertNil(map(key(48, "\t"), .none), "nothing to take: Tab moves focus between the buttons")
        XCTAssertNil(map(key(48, "\t", mods: .shift), offered), "Shift-Tab moves focus back")
        XCTAssertEqual(map(key(19, "2", mods: .command), offered), .key(.commandDigit(2)))
        XCTAssertNil(map(key(20, "3", mods: .command), offered), "nothing on ⌘3")
        XCTAssertEqual(map(key(6, "z", mods: .command), FirstLookKeys(undo: true)), .key(.undo))
        XCTAssertNil(map(key(6, "z", mods: .command), offered), "⌘Z only on a fill's result")
        XCTAssertEqual(map(key(53, "\u{1b}"), FirstLookKeys(stop: true)), .key(.escape))
        XCTAssertEqual(map(key(53, "\u{1b}"), offered), .back, "Esc is Back unless there is work to stop")
        XCTAssertEqual(map(key(36, "\r"), offered), .next)
    }

    func testClosingAnUnfinishedFlowLetsTheNextOpenStartAgain() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: SettingsStore(path: dir.appendingPathComponent("s.json").path))
        _ = controller.command(["onboarding", "open"])
        _ = controller.command(["onboarding", "next"])
        XCTAssertEqual(controller.debugInfo()?.step, "work")
        _ = controller.command(["onboarding", "close"])
        XCTAssertNil(controller.debugInfo())
        _ = controller.command(["onboarding", "open"])
        XCTAssertEqual(controller.debugInfo()?.step, "welcome")
        XCTAssertEqual(controller.debugInfo()?.windowShown, false)
    }

    /// Today's helper keeps no typed values, so the flow skips the know step; once the helper's
    /// memory list says it does, the step joins a flow already open.
    func testTheKnowStepFollowsWhatTheHelperSays() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: SettingsStore(path: dir.appendingPathComponent("s.json").path))
        _ = controller.command(["onboarding", "open"])
        _ = controller.command(["onboarding", "next"])
        XCTAssertEqual(controller.debugInfo()?.showsKnow, false)
        _ = controller.command(["onboarding", "next"])
        XCTAssertEqual(controller.debugInfo()?.step, "permissions", "nothing would keep what is typed, so the step is skipped")
        controller.knowAvailableChanged(true)
        _ = controller.command(["onboarding", "back"])
        XCTAssertEqual(controller.debugInfo()?.step, "know")
        XCTAssertEqual(controller.debugInfo()?.stepCount, 6)
    }

    // MARK: - The hidden flow over the socket's commands

    func testAHiddenFlowWalksOverTheSocketAndWritesTheChoices() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = SettingsStore(path: dir.appendingPathComponent("settings.json").path)
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: store)
        var asked: [FirstLookRequest] = []
        controller.sendFirstLook = { asked.append($0); return true }
        var kept: [[TypedAbout]] = []
        controller.onRemember = { kept.append($0) }
        // A helper that keeps typed values: the know step is in the flow.
        controller.knowAvailable = { true }
        XCTAssertEqual(controller.command(["onboarding"]), #"{"open":false}"#)
        func run(_ line: String) throws -> DebugState.OnboardingInfo {
            let words = line.split(separator: " ", maxSplits: line.hasPrefix("onboarding reply") ? 2 : Int.max).map(String.init)
            let reply = controller.command(words)
            XCTAssertFalse(reply.contains("\"error\""), "\(line): \(reply)")
            return try JSONDecoder().decode(DebugState.OnboardingInfo.self, from: Data(reply.utf8))
        }
        XCTAssertEqual(try run("onboarding open").step, "welcome")
        _ = try run("onboarding permissions on off")
        _ = try run("onboarding next")
        _ = try run("onboarding role repeat off")
        XCTAssertEqual(try run("onboarding level quiet").level, "quiet")
        XCTAssertEqual(try run("onboarding next").step, "know")
        XCTAssertEqual(store.settings.roles, [.fill, .watch, .calendar, .words], "the choices are saved on leaving the screen")
        XCTAssertEqual(store.settings.level, .quiet)
        XCTAssertEqual(try run("onboarding about name Dana Whitfield").about?["name"], 14)
        XCTAssertEqual(try run("onboarding next").step, "permissions")
        XCTAssertEqual(kept, [[TypedAbout(label: "Name", value: "Dana Whitfield")]], "Continue hands the typed name to memory")
        XCTAssertEqual(try run("onboarding next").step, "tryIt")
        XCTAssertEqual(try run("onboarding tab-owners Cotypist").otherTabOwners, ["Cotypist"], "the poll passes the running Tab owners on")
        XCTAssertNil(try run("onboarding tab-owners none").otherTabOwners)
        XCTAssertFalse(try run("onboarding key return").tryIt!.completed)
        XCTAssertTrue(try run("onboarding key tab").tryIt!.completed)
        let looking = try run("onboarding next")
        XCTAssertEqual(looking.firstLook, "asking")
        XCTAssertEqual(asked.map(\.families), [["fill", "pending"]])
        let reply = #"{"type":"firstLookReply","v":1,"requestId":"\#(asked[0].requestId)","at":1,"outcome":"nothing","found":null,"scanned":null,"error":null}"#
        XCTAssertEqual(try run("onboarding reply \(reply)").firstLook, "nothing")
        let done = try run("onboarding next")
        XCTAssertTrue(done.finished)
        XCTAssertEqual(done.windowShown, false)
        XCTAssertTrue(store.settings.onboarded)
        XCTAssertEqual(store.settings.memory.first { $0.key == "role.repeat" }?.value, "off")
        XCTAssertEqual(store.settings.memory.first?.source, .onboarding)
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

    /// A hidden flow at the first look with an event card found, its accept and stop recorded.
    private func atFoundEvent(_ calendars: FakeAsker, accepts: @escaping (OfferAccept) -> Void, stops: @escaping (OfferStop) -> Void) throws -> (OnboardingController, String, () -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        let store = SettingsStore(path: dir.appendingPathComponent("settings.json").path)
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: store)
        controller.calendars = calendars
        var asked: [FirstLookRequest] = []
        controller.sendFirstLook = { asked.append($0); return true }
        controller.sendAccept = { accepts($0); return true }
        controller.sendStop = { stops($0); return true }
        controller.knowAvailable = { false }
        for line in ["onboarding open", "onboarding permissions on on", "onboarding next", "onboarding next", "onboarding next", "onboarding key tab", "onboarding next"] {
            let words = line.split(separator: " ").map(String.init)
            XCTAssertFalse(controller.command(words).contains("\"error\""), line)
        }
        let request = try XCTUnwrap(asked.last, "the first look asked")
        XCTAssertTrue(request.families.contains("event"))
        let key = FirstLookReply.offerKey(requestId: request.requestId)
        let found = #"{"kind":"action","family":"event","offerKey":"\#(key)","window":{"pid":5151,"windowId":"5151-2","appName":"Messages","title":"Dana"},"spec":{"v":1,"id":"\#(key)","figure":"offering","blocks":[{"type":"header","title":{"text":"Coffee with Dana","ref":{"rule":"eventTitle","derived":[{"node":"5151-2/k"}]}}},{"type":"facts","rows":[{"label":"When","value":{"text":"Thu 3:00 to 3:30 PM","ref":{"rule":"eventTime","derived":[{"node":"5151-2/k"}]}}}]},{"type":"actions","items":[{"id":"add","label":"Add","key":"tab"}]}]}}"#
        let reply = #"{"type":"firstLookReply","v":1,"requestId":"\#(request.requestId)","at":1,"outcome":"found","found":\#(found),"scanned":null,"error":null}"#
        let answered = controller.command(["onboarding", "reply", reply])
        XCTAssertFalse(answered.contains("\"error\""), answered)
        XCTAssertTrue(answered.contains("\"firstLook\":\"found\""), answered)
        return (controller, key, { try? FileManager.default.removeItem(at: dir) })
    }

    func testAFoundEventCardAsksForCalendarAccessBeforeItsAcceptGoes() throws {
        let calendars = FakeAsker()
        var accepts: [OfferAccept] = []
        let (controller, key, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { _ in })
        defer { cleanup() }
        XCTAssertTrue(calendars.asked.isEmpty, "showing the card asks nothing")
        _ = controller.command(["onboarding", "key", "tab"])
        XCTAssertEqual(calendars.asked.count, 1, "Tab asks macOS once")
        XCTAssertTrue(accepts.isEmpty, "nothing goes before macOS answers")
        calendars.access = .fullAccess
        try XCTUnwrap(calendars.asked.first)(.fullAccess)
        XCTAssertEqual(accepts.map(\.offerId), [key])
        XCTAssertEqual(accepts.map(\.actionId), ["add"])
    }

    func testEscWhileMacOSAsksSendsNeitherTheAcceptNorAStop() throws {
        let calendars = FakeAsker()
        var accepts: [OfferAccept] = []
        var stops: [OfferStop] = []
        let (controller, _, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { stops.append($0) })
        defer { cleanup() }
        _ = controller.command(["onboarding", "key", "tab"])
        _ = controller.command(["onboarding", "key", "esc"])
        calendars.asked.first?(.denied)
        XCTAssertTrue(accepts.isEmpty)
        XCTAssertTrue(stops.isEmpty, "the helper never heard of the accept")
    }

    func testOnceMacOSHasAnsweredAFoundEventCardGoesAtOnce() throws {
        let calendars = FakeAsker()
        calendars.access = .denied
        var accepts: [OfferAccept] = []
        let (controller, key, cleanup) = try atFoundEvent(calendars, accepts: { accepts.append($0) }, stops: { _ in })
        defer { cleanup() }
        _ = controller.command(["onboarding", "key", "tab"])
        XCTAssertTrue(calendars.asked.isEmpty)
        XCTAssertEqual(accepts.map(\.offerId), [key])
    }
}
