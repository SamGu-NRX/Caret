import Foundation
import Testing
@testable import CaretScreenCore

/// The user's calendars as EventKit would show them to the shipped app (H8): a synced default calendar,
/// a second writable one, a read-only subscription, and, in the second, an event of the user's own that
/// is identical to the one Caret will add. Every call is logged, so a test can show what was never touched.
private final class UserCalendars: CalendarBackend, @unchecked Sendable {
    var access = true
    var calls: [String] = []
    /// Calendar id to whether it accepts new events.
    var calendars: [String: Bool] = ["home": true, "work": true, "holidays": false]
    var defaultID: String? = "home"
    var events: [String: BackendEvent] = [:]
    var readFails = false
    private var n = 0
    struct ReadError: Error, CustomStringConvertible { var description: String { "no full Calendar access" } }

    init() {
        events["users-own"] = BackendEvent(id: "users-own", calendarID: "work", title: "Coffee with Dana", start: t("2026-10-08T15:00:00-05:00"), end: t("2026-10-08T15:30:00-05:00"))
    }

    func hasFullAccess() -> Bool { calls.append("access"); return access }
    func localSourceID() -> String? { calls.append("source"); return "local" }
    func createCalendar(title: String, sourceID: String) throws -> String { calls.append("create \(title)"); return "made" }
    func deleteCalendar(id: String) throws { calls.append("delete \(id)") }
    func events(calendarID: String, from: Date, to: Date) throws -> [BackendEvent] {
        calls.append("events \(calendarID)")
        if readFails { throw ReadError() }
        return events.values.filter { $0.calendarID == calendarID && $0.start < to && $0.end > from }
    }
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> BackendEvent {
        calls.append("save \(calendarID)"); n += 1
        events["ev-\(n)"] = BackendEvent(id: "ev-\(n)", calendarID: calendarID, title: title, start: start, end: end)
        return events["ev-\(n)"]!
    }
    func event(id: String) throws -> BackendEvent? {
        calls.append("event \(id)")
        if readFails { throw ReadError() }
        return events[id]
    }
    func removeEvent(id: String, ifStill saved: BackendEvent) throws {
        calls.append("remove \(id)")
        // As EventKitBackend: the fresh read and the removal together, so an edit made after the adapter's checks stops it.
        duringRemove?()
        if let now = events[id], !saved.unchanged(in: now) { throw CalendarEventChanged() }
        events.removeValue(forKey: id)
    }
    /// Called inside a removal before its fresh read, as the user's edit landing during an undo.
    var duringRemove: (() -> Void)?
    func defaultCalendarID() -> String? { calls.append("default"); return defaultID.flatMap { calendars[$0] == true ? $0 : nil } }
    func isWritable(calendarID: String) -> Bool { calls.append("writable \(calendarID)"); return calendars[calendarID] == true }
}

private func t(_ s: String) -> Date { CalendarTime.parse(s)! }
private let chicago = TimeZone(identifier: "America/Chicago")!
private let start = "2026-10-08T15:00:00-05:00", end = "2026-10-08T15:30:00-05:00"
/// The saved choice, changed between adds as What Caret knows changes it.
private final class Choice: @unchecked Sendable {
    var id: String?
    init(_ id: String?) { self.id = id }
}

/// The helper names its calendar "Caret" (helper.ts eventCalendar); in the user scope that is only a label.
private let label = "Caret"

private func add(_ a: CalendarAdapter, task: String = "t1", title: String = "Coffee with Dana") -> CalendarEventRecord? {
    guard case let .ok(record?) = a.perform(.calendarAdd(calendar: label, title: title, start: start, end: end, taskId: task)) else { return nil }
    return record
}

@Suite struct UserCalendarTests {
    @Test func addsToTheDefaultCalendarForNewEventsAndCreatesNothing() throws {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        let added = try #require(add(a))
        #expect(b.events[added.id]?.calendarID == "home")
        #expect(added == CalendarEventRecord(id: added.id, calendar: label, title: "Coffee with Dana", start: start, end: end), "the record keeps the helper's label")
        #expect(!b.calls.contains { $0.hasPrefix("create") || $0 == "source" }, "no calendar of Caret's own: \(b.calls)")
        #expect(a.ownedCalendars.isEmpty)
    }

    @Test func addsToTheChosenCalendarAndToTheDefaultWhenTheChoiceNoLongerTakesEvents() throws {
        let b = UserCalendars()
        let choice = Choice("work")
        let a = CalendarAdapter(backend: b, scope: .user(choice: { choice.id }), zone: chicago)
        #expect(b.events[try #require(add(a, task: "t1", title: "Coffee with Dana and Sam")).id]?.calendarID == "work")
        choice.id = "holidays"
        #expect(b.events[try #require(add(a, task: "t2", title: "Lunch")).id]?.calendarID == "home", "read-only: the default stands in")
        choice.id = "deleted-calendar"
        #expect(b.events[try #require(add(a, task: "t3", title: "Walk")).id]?.calendarID == "home", "gone: the default stands in")
    }

    /// Undo removes exactly the event Caret added, by its identifier, never the user's own identical
    /// event; and only the task that added it may remove it (B16, D2-06).
    @Test func undoRemovesExactlyTheEventItAddedByIdentifier() throws {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        #expect(a.perform(.calendarFind(calendar: label, title: "Coffee with Dana", start: start, end: end)) == .ok(nil),
                "the user's own identical event is not Caret's: find looks only at events it added")
        let added = try #require(add(a))
        #expect(added.id != "users-own")
        #expect(a.perform(.calendarFind(calendar: label, title: "Coffee with Dana", start: start, end: end)) == .ok(added))
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(added))
        #expect(a.perform(.calendarGet(id: "users-own")) == .ok(nil), "an event it did not add is never read")
        #expect(a.perform(.calendarRemove(id: "users-own", taskId: "t1")) == .refused(.notAllowed, "the event is not one the reader added, in a calendar it added it to"))
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t2")) == .refused(.notAllowed, "another task added this event; only that task removes it"))
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .ok(nil))
        #expect(b.events[added.id] == nil)
        #expect(b.events["users-own"] != nil, "the user's own event stays")
        #expect(!b.calls.contains("remove users-own"))
        #expect(a.perform(.calendarGet(id: added.id)) == .ok(nil), "undo's check reads the store")
        #expect(b.calls.last == "event \(added.id)")
    }

    /// Two tasks adding the same event make one: the second is refused, as in the test scope.
    @Test func aSecondIdenticalAddIsRefused() throws {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        _ = try #require(add(a, task: "t1"))
        #expect(a.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t2"))
                == .refused(.changed, "an identical event is already in the calendar; nothing was added"))
    }

    /// Review finding 3: a reader that restarted has no record of its earlier adds, so the destination's own
    /// events stop a second copy, the user's included; nothing is saved and nothing of theirs is touched.
    @Test func anEventTheCalendarAlreadyHoldsIsNotAddedAgainAfterARestart() throws {
        let b = UserCalendars()
        let before = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        _ = try #require(add(before))
        let restarted = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        #expect(restarted.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t9"))
                == .refused(.changed, "an identical event is already in the calendar; nothing was added"))
        #expect(b.events.values.filter { $0.calendarID == "home" }.count == 1)
        let toWork = CalendarAdapter(backend: b, scope: .user(choice: { "work" }), zone: chicago)
        #expect(toWork.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t10"))
                == .refused(.changed, "an identical event is already in the calendar; nothing was added"), "the user's own identical event")
        #expect(b.events["users-own"] != nil)
        #expect(!b.calls.contains("remove users-own"))
    }

    /// An event moved out of the calendar Caret put it in is no longer Caret's to remove.
    @Test func anEventMovedToAnotherCalendarIsNotRemoved() throws {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        let added = try #require(add(a))
        b.events[added.id]?.calendarID = "work"
        #expect(a.perform(.calendarRemove(id: added.id, taskId: "t1")) == .refused(.notAllowed, "the event is not one the reader added, in a calendar it added it to"))
        #expect(b.events[added.id] != nil)
    }

    @Test func neverDeletesACalendar() throws {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        _ = try #require(add(a))
        #expect(a.perform(.calendarDispose(calendar: label, taskId: "t1")) == .refused(.notAllowed, "the reader never deletes one of the user's calendars"))
        #expect(a.disposeAll().isEmpty)
        #expect(!b.calls.contains { $0.hasPrefix("delete") })
        #expect(b.events.count == 2, "the event Caret added stays until its undo")
    }

    @Test func noCalendarThatTakesEventsIsBlockedAndSavesNothing() {
        let b = UserCalendars()
        b.defaultID = nil
        let a = CalendarAdapter(backend: b, scope: .user(choice: { "holidays" }), zone: chicago)
        #expect(a.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t1")) == .blocked(.noLocalSource))
        #expect(!b.calls.contains { $0.hasPrefix("save") })
    }

    struct Unreadable: Error, CustomStringConvertible { var description: String { "settings.json: not JSON" } }

    @Test func aChoiceThatCannotBeReadRefusesTheAdd() {
        let b = UserCalendars()
        let a = CalendarAdapter(backend: b, scope: .user(choice: { throw Unreadable() }), zone: chicago)
        #expect(a.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t1"))
                == .refused(.axError, "cannot read the calendar choice: settings.json: not JSON"))
        #expect(!b.calls.contains { $0.hasPrefix("save") })
    }

    @Test func withoutAccessNothingIsTouched() {
        let b = UserCalendars()
        b.access = false
        let a = CalendarAdapter(backend: b, scope: .user(choice: { nil }), zone: chicago)
        #expect(a.perform(.calendarAdd(calendar: label, title: "Coffee with Dana", start: start, end: end, taskId: "t1")) == .blocked(.tcc))
        #expect(b.calls == ["access"])
    }
}

/// The host's settings file as the reader reads it for the user's choice (`--calendar-user PATH`).
@Suite struct CalendarChoiceFileTests {
    private func file(_ body: String?) throws -> String {
        let path = NSTemporaryDirectory() + "caret-h8-choice-\(UUID().uuidString).json"
        if let body { try body.write(toFile: path, atomically: true, encoding: .utf8) }
        return path
    }

    @Test func readsTheChosenCalendarAndNoChoiceAsTheDefault() throws {
        #expect(try CalendarChoiceFile.read(try file(#"{"version":2,"eventCalendar":"work-1"}"#)) == "work-1")
        #expect(try CalendarChoiceFile.read(try file(#"{"version":2,"routing":false}"#)) == nil, "no key: the default")
        #expect(try CalendarChoiceFile.read(try file(nil)) == nil, "no file yet: the user has chosen nothing")
    }

    @Test func refusesAFileItCannotRead() throws {
        #expect(throws: (any Error).self) { try CalendarChoiceFile.read(try file("not json")) }
        #expect(throws: (any Error).self) { try CalendarChoiceFile.read(try file(#"{"eventCalendar":7}"#)) }
        #expect(throws: (any Error).self) { try CalendarChoiceFile.read(try file(#"{"eventCalendar":""}"#)) }
        #expect(throws: (any Error).self) { try CalendarChoiceFile.read(try file(#"["eventCalendar"]"#)) }
    }
}
