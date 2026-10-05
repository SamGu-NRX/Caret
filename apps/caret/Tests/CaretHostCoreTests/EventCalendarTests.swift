import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The user's calendars as EventKit shows them to the host, set by each test.
final class FakeCalendars: CalendarDirectory {
    var access: CalendarAccess = .notDetermined
    var calendars = [
        WritableCalendar(id: "home-1", title: "Home", account: "iCloud"),
        WritableCalendar(id: "work-1", title: "Work", account: "Exchange"),
    ]
    var defaultID: String? = "home-1"
    func writableCalendars() -> [WritableCalendar] { access.granted ? calendars : [] }
    func defaultCalendar() -> WritableCalendar? { access.granted ? calendars.first { $0.id == defaultID } : nil }
}

/// H8 decision 1: Caret asks macOS for Calendar access the first time the user accepts an event card,
/// never at launch, and sends the accept only once macOS has answered.
final class CalendarPermissionFlowTests: XCTestCase {
    private func eventOffer() throws -> HelperOffer { HelperOffer.action(try EventCardCopyTests.offer()) }

    /// A rig whose Calendar access reads from `calendars`, as `HostRuntime` wires the app's.
    private func rig(_ calendars: FakeCalendars) -> SurfaceRig {
        let rig = SurfaceRig()
        rig.machine.calendarAccessUndetermined = { calendars.access == .notDetermined }
        return rig
    }

    func testTheFirstEventCardAcceptedAsksForCalendarAccessThenSendsTheAccept() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("first event card, access never asked", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .expect(.shown("event-1")),
            .forgetLog,
            .press(Fx.tab()),
            .sent([]),
            .expect(.workingOn("event-1")),
            .expect(.custom("macOS is asked once", { $0.takeLog().filter { $0 == "ask calendar access" }.count == 1 })),
            .wait(1),
            .sent([]),
            .calendarAnswered,
            .sent(["accept event-1 add"]),
            .expect(.workingOn("event-1")),
            .taskLine(Fx.progress("event-1", .done, steps: 1)),
            .expect(.workingOn(nil)),
        ]))
    }

    /// Denied at the prompt: the accept still goes, and the reader's `blocked: tcc` ends it on the
    /// line that says where to turn access on. The next card does not ask again.
    func testADeniedPromptEndsOnTheBlockedLineAndIsNotAskedAgain() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("denied", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .sent([]),
            .screen { _ in calendars.access = .denied },
            .calendarAnswered,
            .sent(["accept event-1 add"]),
            .taskLine(Self.blockedTCC),
            .expect(.line(Captions.blocked(.tcc))),
        ]))
    }

    /// B16's blocked hand-off: the reader has no Calendar access.
    static let blockedTCC = try! JSONDecoder().decode(TaskProgress.self, from: Data(
        #"{"type":"taskProgress","v":1,"at":1,"taskId":"event-1","planId":"p","phase":"handoff","step":0,"steps":1,"says":null,"detail":null,"blocked":"tcc"}"#.utf8))

    func testOnceMacOSHasAnsweredAnEventCardIsSentAtOnce() throws {
        for access in [CalendarAccess.fullAccess, .denied, .restricted, .writeOnly] {
            let calendars = FakeCalendars()
            calendars.access = access
            play(rig(calendars), Transition("access \(access.rawValue)", [
                .screen { $0.front() },
                .offer(try eventOffer()),
                .forgetLog,
                .press(Fx.tab()),
                .sent(["accept event-1 add"]),
                .expect(.custom("nothing is asked", { !$0.takeLog().contains("ask calendar access") })),
            ]))
        }
    }

    func testOtherActionsNeverAsk() {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("another action line, access never asked", [
            .screen { $0.front() },
            .offer(Fx.action()),
            .forgetLog,
            .press(Fx.tab()),
            .sent(["accept offer-5 finish"]),
            .expect(.custom("nothing is asked", { !$0.takeLog().contains("ask calendar access") })),
        ]))
    }

    /// Esc on the working line while the prompt is up: the accept never reaches the helper, and a
    /// late answer sends nothing.
    func testAStopWhileThePromptIsUpSendsNothing() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("Esc while macOS asks", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .wait(3),
            .press(Fx.esc()),
            .expect(.workingOn(nil)),
            .sent([]),
            .calendarAnswered,
            .sent([]),
        ]))
    }

    /// The accept cannot be written when macOS answers: the helper-down line, at once.
    func testAnAcceptThatCannotBeSentWhenMacOSAnswersEndsOnTheHelperDownLine() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("send fails at the answer", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .helperDown,
            .calendarAnswered,
            .expect(.workingOn(nil)),
            .expect(.counted("surface.accept.unsent")),
        ]))
    }

    /// Review finding 4: the connection closes while macOS asks. The work ends with it, and the
    /// answer sends nothing.
    func testTheHelperGoingWhileMacOSAsksDropsTheHeldAccept() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("connection lost while macOS asks", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .linkLost,
            .expect(.workingOn(nil)),
            .calendarAnswered,
            .sent([]),
        ]))
    }

    /// The helper restarts while macOS asks, and its new card reuses the key ("event-1"): the late
    /// answer must not send the old accept for the new work.
    func testALateAnswerAfterTheHelperRestartedSendsNothing() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("helper restarted while macOS asks", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .linkLost,
            .screen { _ in calendars.access = .fullAccess },
            .wait(7),
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .sent(["accept event-1 add"]),
            .calendarAnswered,
            .sent(["accept event-1 add"]),
        ]))
    }

    /// VM run 6: the prompt takes the front. The working line stays while macOS asks, and once it has
    /// answered and the app is in front, the done line holds ⌘Z.
    func testThePromptTakingTheFrontDoesNotTakeTheLineDownForGood() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("the prompt in front while macOS asks", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.tab()),
            .screen { $0.behind() }, .activated, .wait(1),
            .expect(.custom("the line is not taken down while macOS asks", { !$0.counts.contains { $0.hasPrefix("surface.lineHidden") } })),
            // VM run 7: the answer comes before the app is back in front.
            .calendarAnswered,
            .sent(["accept event-1 add"]),
            .taskLine(Fx.progress("event-1", .done, steps: 1)),
            .wait(0.6),
            .screen { $0.front() }, .activated,
            .wait(2),
            .expect(.custom("still not taken down", { !$0.counts.contains { $0.hasPrefix("surface.lineHidden") } })),
            .expect(.undoOwned(true)),
        ]))
    }

    /// The debug state names the shown card's destination, as the card does.
    func testTheShownCardsDestinationIsInTheDebugState() throws {
        let offer = HelperOffer.action(EventCardCopy.destined(try EventCardCopyTests.offer(), line: "Adding to Work"))
        play(rig(FakeCalendars()), Transition("a destined card shown", [
            .screen { $0.front() },
            .offer(offer),
            .expect(.shown("event-1")),
            .expect(.custom("eventDestination", { $0.machine.debugInfo().eventDestination == "Adding to Work" })),
        ]))
    }

    /// An offer shown, read or let go never asks: only a Tab on the card does.
    func testShowingAnEventCardNeverAsks() throws {
        let calendars = FakeCalendars()
        play(rig(calendars), Transition("shown, opened, dismissed", [
            .screen { $0.front() },
            .offer(try eventOffer()),
            .press(Fx.down()),
            .press(Fx.esc()),
            .sent([]),
            .expect(.custom("nothing is asked", { !$0.takeLog().contains("ask calendar access") })),
        ]))
    }
}

/// Where the event goes, and how the card and What Caret knows say it.
final class EventDestinationTests: XCTestCase {
    func testTheChoiceWinsWhileItTakesEventsElseTheDefault() {
        let c = FakeCalendars()
        XCTAssertEqual(EventDestination.resolve(choice: nil, in: c), .notAsked, "nothing is read before access")
        c.access = .fullAccess
        XCTAssertEqual(EventDestination.resolve(choice: nil, in: c), .calendar(c.calendars[0], chosen: false))
        XCTAssertEqual(EventDestination.resolve(choice: "work-1", in: c), .calendar(c.calendars[1], chosen: true))
        XCTAssertEqual(EventDestination.resolve(choice: "gone-9", in: c), .calendar(c.calendars[0], chosen: false, missing: "gone-9"))
        c.defaultID = nil
        XCTAssertEqual(EventDestination.resolve(choice: nil, in: c), .noCalendar)
        for access in [CalendarAccess.denied, .restricted, .writeOnly] {
            c.access = access
            XCTAssertEqual(EventDestination.resolve(choice: "work-1", in: c), .noAccess(access))
        }
    }

    /// VM run 4: EventKit's status lagged at notDetermined after the grant. The request's own answer
    /// stands while the status lags; any other status wins.
    func testTheRequestsAnswerStandsWhileTheStatusLags() {
        XCTAssertEqual(CalendarAccess.effective(status: .notDetermined, answered: .fullAccess), .fullAccess)
        XCTAssertEqual(CalendarAccess.effective(status: .notDetermined, answered: nil), .notDetermined)
        XCTAssertEqual(CalendarAccess.effective(status: .denied, answered: .fullAccess), .denied, "a later refusal in System Settings wins")
        XCTAssertEqual(CalendarAccess.effective(status: .fullAccess, answered: .denied), .fullAccess)
    }

    func testTheCardLineNamesTheCalendar() {
        let c = FakeCalendars()
        XCTAssertEqual(EventCalendarCopy.cardLine(.notAsked), "Adding to your default calendar")
        c.access = .fullAccess
        XCTAssertEqual(EventCalendarCopy.cardLine(EventDestination.resolve(choice: "work-1", in: c)), "Adding to Work")
        XCTAssertEqual(EventCalendarCopy.cardLine(EventDestination.resolve(choice: nil, in: c)), "Adding to Home")
        XCTAssertEqual(EventCalendarCopy.cardLine(.noAccess(.denied)), "Caret can't use Calendar")
    }

    func testTwoCalendarsOfOneNameAreToldApartByAccount() {
        let all = [WritableCalendar(id: "a", title: "Home", account: "iCloud"), WritableCalendar(id: "b", title: "Home", account: "Google"),
                   WritableCalendar(id: "c", title: "Work", account: "Exchange")]
        XCTAssertEqual(all.map { EventCalendarCopy.item($0, among: all) }, ["Home (iCloud)", "Home (Google)", "Work"])
    }

    /// The card that arrives names where the event goes, under the time, and Tab says Add.
    func testTheCardCarriesTheDestinationLineUnderTheTime() throws {
        let m = EventCardCopy.destined(try EventCardCopyTests.offer(), line: "Adding to Work")
        let card = try XCTUnwrap(ActionLine(m).variants)
        var rows: [(String?, String, Bool)] = []
        for block in card.blocks { if case .facts(let f) = block.content { rows += f.rows.map { ($0.label, $0.value.text, $0.secondary) } } }
        XCTAssertEqual(rows.map(\.0), ["When", nil, nil])
        XCTAssertEqual(rows.map(\.1), ["Thu 3:00 to 3:30 PM", "Adding to Work", "\u{201C}I'll grab coffee with Dana on Thursday at 3.\u{201D}"])
        XCTAssertEqual(rows.map(\.2), [false, true, true])
        XCTAssertEqual(card.actions.map(\.label), ["Add"])
        XCTAssertEqual(card.actions.map(\.id), ["add"])
        XCTAssertEqual(EventCardCopy.destinationLine(card), "Adding to Work")
        XCTAssertTrue(ActionLine(m).eventCard)
        // Taking the card again leaves it as it is.
        XCTAssertEqual(EventCardCopy.card(card), card)
    }

    func testOtherOffersAreNotRewritten() throws {
        var other = try EventCardCopyTests.offer()
        other.endState = PopupSpec.Value("Finish the rest", ref: .derived(rule: "loopFinish", from: [.node(key: "n", quote: nil)]))
        XCTAssertEqual(EventCardCopy.destined(other, line: "Adding to Work"), other)
        XCTAssertFalse(ActionLine(other).eventCard)
    }
}

/// The calendar choice, saved with the user's other settings.
final class CalendarChoiceSettingsTests: XCTestCase {
    func testTheChoiceIsSavedAndReadBack() throws {
        var s = CaretSettings()
        s.eventCalendar = "work-1"
        let data = try JSONEncoder().encode(s)
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: data).eventCalendar, "work-1")
        // The reader reads this key from the same file (caret-screen --calendar-user, CalendarChoiceFile).
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["eventCalendar"] as? String, "work-1")
        XCTAssertEqual(try CalendarChoiceFile.read(Self.write(data)), "work-1")
    }

    func testNoChoiceIsTheDefaultAndAFileFromBeforeH8ReadsAsNoChoice() throws {
        let data = try JSONEncoder().encode(CaretSettings())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(object["eventCalendar"], "no choice writes no key")
        XCTAssertNil(try CalendarChoiceFile.read(Self.write(data)))
        let before = #"{"version":2,"roles":["fill"],"level":"balanced","character":"pebble","paused":false,"onboarded":true,"memory":[],"sitesOff":[],"routing":false}"#
        XCTAssertNil(try JSONDecoder().decode(CaretSettings.self, from: Data(before.utf8)).eventCalendar)
    }

    func testAnEmptyChoiceIsRefused() {
        let bad = #"{"version":2,"roles":[],"level":"balanced","character":"pebble","paused":false,"onboarded":true,"memory":[],"eventCalendar":""}"#
        XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: Data(bad.utf8)))
    }

    private static func write(_ data: Data) throws -> String {
        let path = NSTemporaryDirectory() + "caret-h8-settings-\(UUID().uuidString).json"
        try data.write(to: URL(fileURLWithPath: path))
        return path
    }
}

/// The What Caret knows row: what the pop-up offers in each state.
final class CalendarChoiceRowTests: XCTestCase {
    func testBeforeAccessOnlyTheDefaultShowsAndThePopUpIsOff() {
        let row = CalendarChoiceRow.make(choice: nil, directory: FakeCalendars())
        XCTAssertEqual(row.items.map(\.title), ["Default calendar"])
        XCTAssertFalse(row.enabled)
        XCTAssertEqual(row.detail, "Caret asks to use Calendar the first time you add an event, then adds it to your default calendar.")
    }

    func testWithAccessEveryWritableCalendarIsOfferedAndTheChoiceIsCurrent() {
        let c = FakeCalendars()
        c.access = .fullAccess
        let row = CalendarChoiceRow.make(choice: "work-1", directory: c)
        XCTAssertEqual(row.items.map(\.title), ["Default (Home)", "Home", "Work"])
        XCTAssertEqual(row.items.map(\.id), [nil, "home-1", "work-1"])
        XCTAssertEqual(row.current, "work-1")
        XCTAssertTrue(row.enabled)
        XCTAssertEqual(row.detail, "Events you add go to Work in Exchange.")
    }

    /// A choice that no longer takes events shows Default as current, and the sentence says why.
    func testAGoneChoiceShowsTheDefaultAndSaysSo() {
        let c = FakeCalendars()
        c.access = .fullAccess
        let row = CalendarChoiceRow.make(choice: "gone-9", directory: c)
        XCTAssertNil(row.current)
        XCTAssertEqual(row.detail, "The calendar you picked is gone or read-only, so events go to Home, your default.")
    }

    func testDeniedSaysWhereToTurnItOn() {
        let c = FakeCalendars()
        c.access = .denied
        let row = CalendarChoiceRow.make(choice: nil, directory: c)
        XCTAssertFalse(row.enabled)
        XCTAssertEqual(row.detail, "Caret can't use Calendar. Turn it on in System Settings, Privacy & Security, Calendars.")
    }
}
