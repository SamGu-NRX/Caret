// The reader's calendar adapter (B16): EventKit behind the helper's CalendarPort, here because EventKit
// needs a native process. The rules live in this file so they can be tested without EventKit; the real
// store is EventKitBackend in CaretScreenCalendar.
//   - It never asks for Calendar access. A request would put a system prompt on the user's screen, so
//     without full access every verb answers blocked: tcc.
//   - It writes only to calendars it created itself, on a local (On My Mac) source, which no account
//     syncs. With no local source it answers blocked: noLocalSource. It never looks at, writes to or
//     removes from any other calendar: it looks events up only by the ids of events it added, and
//     searches only its own calendars, so an event outside them is never even read.
//   - An add of an event its calendar already holds (same title, start and end) returns that event, so
//     two tasks racing to add the same event make one. The add's answer is built from what was saved,
//     with no read back that could fail after the save and lose the id.
//   - calendarDispose, and disposeAll when the reader stops, delete the calendars it created.
// A calendar it created is known only for the life of the reader; a reader that is killed leaves it behind.
import Foundation

/// An event as a backend reports it.
public struct BackendEvent: Equatable, Sendable {
    public var id: String
    public var calendarID: String
    public var title: String
    public var start: Date
    public var end: Date
    public init(id: String, calendarID: String, title: String, start: Date, end: Date) {
        self.id = id; self.calendarID = calendarID; self.title = title; self.start = start; self.end = end
    }
}

/// The calendar store the adapter drives. EventKitBackend is the real one; tests use a fake.
public protocol CalendarBackend: AnyObject {
    /// Full Calendar access is already granted. Must never ask for it.
    func hasFullAccess() -> Bool
    /// A local source to create a calendar on, or nil when there is none.
    func localSourceID() -> String?
    func createCalendar(title: String, sourceID: String) throws -> String
    func deleteCalendar(id: String) throws
    func events(calendarID: String, from: Date, to: Date) -> [BackendEvent]
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> String
    func event(id: String) -> BackendEvent?
    func removeEvent(id: String) throws
}

public enum CalendarAnswer: Equatable, Sendable {
    case ok(CalendarEventRecord?)
    case blocked(CalendarBlock)
    case refused(VerbOutcome, String)
}

public final class CalendarAdapter: @unchecked Sendable {
    private let backend: CalendarBackend
    private let zone: TimeZone
    // Calls arrive on one queue in the reader; the lock keeps the owned table consistent for tests that call from anywhere.
    private let lock = NSLock()
    /// Calendar name to the identifier of the calendar this adapter created under that name.
    private var owned: [String: String] = [:]
    /// Each event this adapter added and has not removed, by id, with the name of its calendar.
    private var events: [String: String] = [:]

    public init(backend: CalendarBackend, zone: TimeZone = .current) {
        self.backend = backend
        self.zone = zone
    }

    /// The names of the calendars it created and has not yet deleted.
    public var ownedCalendars: [String] {
        lock.lock(); defer { lock.unlock() }
        return owned.keys.sorted()
    }

    public func perform(_ verb: ReaderVerb) -> CalendarAnswer {
        lock.lock(); defer { lock.unlock() }
        guard verb.isCalendar else { return .refused(.notAllowed, "not a calendar verb") }
        // Checked before anything else, so without access nothing touches the store.
        guard backend.hasFullAccess() else { return .blocked(.tcc) }
        do {
            switch verb {
            case let .calendarFind(calendar, title, start, end):
                guard let s = CalendarTime.parse(start), let e = CalendarTime.parse(end) else { return .refused(.changed, "start and end are not ISO 8601 times") }
                guard let cid = owned[calendar] else { return .ok(nil) }
                return .ok(match(cid, title, s, e).map { record($0, calendar) })
            case let .calendarAdd(calendar, title, start, end, _):
                guard let s = CalendarTime.parse(start), let e = CalendarTime.parse(end), e > s else { return .refused(.changed, "start and end are not ISO 8601 times, or end is not after start") }
                let cid: String
                if let known = owned[calendar] {
                    cid = known
                    if let same = match(cid, title, s, e) { return .ok(record(same, calendar)) }
                } else {
                    guard let source = backend.localSourceID() else { return .blocked(.noLocalSource) }
                    cid = try backend.createCalendar(title: calendar, sourceID: source)
                    owned[calendar] = cid
                }
                let id = try backend.saveEvent(calendarID: cid, title: title, start: s, end: e)
                events[id] = calendar
                return .ok(record(BackendEvent(id: id, calendarID: cid, title: title, start: s, end: e), calendar))
            case let .calendarGet(id):
                guard let calendar = events[id] else { return .ok(nil) }
                guard let ev = backend.event(id: id) else {
                    events.removeValue(forKey: id)
                    return .ok(nil)
                }
                return .ok(record(ev, calendar))
            case let .calendarRemove(id, _):
                guard events[id] != nil else { return .refused(.notAllowed, "the event is not one the reader added") }
                try backend.removeEvent(id: id)
                events.removeValue(forKey: id)
                return .ok(nil)
            case let .calendarDispose(calendar, _):
                if let cid = owned[calendar] {
                    try backend.deleteCalendar(id: cid)
                    owned.removeValue(forKey: calendar)
                    events = events.filter { $0.value != calendar }
                }
                return .ok(nil)
            default:
                return .refused(.notAllowed, "not a calendar verb")
            }
        } catch {
            return .refused(.axError, String(describing: error))
        }
    }

    /// Deletes every calendar it created, when the reader stops. Returns the errors, one line each.
    @discardableResult
    public func disposeAll() -> [String] {
        lock.lock(); defer { lock.unlock() }
        var errors: [String] = []
        for (name, cid) in owned {
            do {
                try backend.deleteCalendar(id: cid)
                owned.removeValue(forKey: name)
                events = events.filter { $0.value != name }
            } catch { errors.append("\(name): \(error)") }
        }
        return errors
    }

    /// The event in its own calendar `cid` with this title, start and end, if any.
    private func match(_ cid: String, _ title: String, _ s: Date, _ e: Date) -> BackendEvent? {
        backend.events(calendarID: cid, from: s.addingTimeInterval(-1), to: e.addingTimeInterval(1))
            .first { $0.title == title && abs($0.start.timeIntervalSince(s)) < 1 && abs($0.end.timeIntervalSince(e)) < 1 }
    }

    private func record(_ e: BackendEvent, _ calendar: String) -> CalendarEventRecord {
        CalendarEventRecord(id: e.id, calendar: calendar, title: e.title, start: CalendarTime.format(e.start, zone: zone), end: CalendarTime.format(e.end, zone: zone))
    }
}
