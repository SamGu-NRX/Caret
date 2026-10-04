// The reader's calendar adapter (B16): EventKit behind the helper's CalendarPort, here because EventKit
// needs a native process. The rules live in this file so they can be tested without EventKit; the real
// store is EventKitBackend in CaretScreenCalendar.
//   - It never asks for Calendar access. A request would put a system prompt on the user's screen, so
//     without full access every verb answers blocked: tcc.
//   - It writes only to calendars it created itself, on a local (On My Mac) source, which no account
//     syncs. With no local source it answers blocked: noLocalSource. It never looks at, writes to or
//     removes from any other calendar: it looks events up only by the ids of events it added, and
//     searches only its own calendars, so an event outside them is never even read.
//   - An add of an event its calendar already holds (same title, start and end) is refused and adds
//     nothing, so two tasks racing to add the same event make one. The add's answer is built from what
//     was saved, with no read back that could fail after the save and lose the id.
//   - Each event it added is kept with the task that added it, and only that task may remove it; a
//     calendar still holding another task's event is not disposed (CodeRabbit on PR #4).
//   - Right before each change (creating a calendar, saving or removing an event, deleting a calendar)
//     it asks `allowed`, the reader's live grant and deadline check (S1 audit #8): a stop that came while
//     it looked things up refuses the change.
//   - A read that fails is an error, never "not there" (S1 audit #16): undo's check after a removal must
//     not count a failed read as the event being gone.
//   - An id it added is trusted only while the event is still in the calendar it was added to.
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
    /// Throws when the store cannot be read; an empty answer means it was read and holds none.
    func events(calendarID: String, from: Date, to: Date) throws -> [BackendEvent]
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> String
    /// Throws when the store cannot be read; nil means it was read and holds no such event.
    func event(id: String) throws -> BackendEvent?
    func removeEvent(id: String) throws
}

/// The store could not be read (S1 audit #16): answered as axError "cannot read the calendar", never as absent.
public struct CalendarReadFailed: Error, CustomStringConvertible {
    public let description: String
    init(_ underlying: Error) { description = "cannot read the calendar: \(underlying)" }
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
    /// Each event this adapter added and has not removed, by id: the name of its calendar and the task that added it.
    private var events: [String: (calendar: String, taskId: String)] = [:]
    /// Events this adapter removed, by id, with their calendars, newest last: a get of one reads the store, so undo's check
    /// after a removal is a real read that can fail, never the adapter's own word (B23 review, S1 audit #16).
    private var removed: [(id: String, calendar: String)] = []
    /// Removed ids kept for that check. Assumed: undo checks right after it removes.
    static let removedKept = 64

    public init(backend: CalendarBackend, zone: TimeZone = .current) {
        self.backend = backend
        self.zone = zone
    }

    /// The names of the calendars it created and has not yet deleted.
    public var ownedCalendars: [String] {
        lock.lock(); defer { lock.unlock() }
        return owned.keys.sorted()
    }

    /// Why a change may not be made now, asked right before each one; the reader's grant and deadline check.
    public typealias Allowed = () -> String?

    /// Runs one calendar verb. `allowed` is asked right before each change to the store; a refusal there answers
    /// notAllowed with what was already done (a calendar created on the way) left as it is.
    public func perform(_ verb: ReaderVerb, allowed: Allowed = { nil }) -> CalendarAnswer {
        lock.lock(); defer { lock.unlock() }
        guard verb.isCalendar else { return .refused(.notAllowed, "not a calendar verb") }
        // Checked before anything else, so without access nothing touches the store.
        guard backend.hasFullAccess() else { return .blocked(.tcc) }
        do {
            switch verb {
            case let .calendarFind(calendar, title, start, end):
                guard let s = CalendarTime.parse(start), let e = CalendarTime.parse(end) else { return .refused(.changed, "start and end are not ISO 8601 times") }
                guard let cid = owned[calendar] else { return .ok(nil) }
                return .ok(try match(cid, title, s, e).map { record($0, calendar) })
            case let .calendarAdd(calendar, title, start, end, taskId):
                guard let s = CalendarTime.parse(start), let e = CalendarTime.parse(end), e > s else { return .refused(.changed, "start and end are not ISO 8601 times, or end is not after start") }
                let cid: String
                if let known = owned[calendar] {
                    cid = known
                    if try match(cid, title, s, e) != nil { return .refused(.changed, "an identical event is already in the calendar; nothing was added") }
                } else {
                    guard let source = backend.localSourceID() else { return .blocked(.noLocalSource) }
                    if let no = allowed() { return .refused(.notAllowed, no) }
                    cid = try backend.createCalendar(title: calendar, sourceID: source)
                    owned[calendar] = cid
                }
                if let no = allowed() { return .refused(.notAllowed, no) }
                let id = try backend.saveEvent(calendarID: cid, title: title, start: s, end: e)
                events[id] = (calendar, taskId)
                return .ok(record(BackendEvent(id: id, calendarID: cid, title: title, start: s, end: e), calendar))
            case let .calendarGet(id):
                if events[id] == nil, let gone = removed.last(where: { $0.id == id }) {
                    // Removed by this adapter: whether it is really gone is read from the store.
                    let read: BackendEvent?
                    do { read = try backend.event(id: id) } catch { throw CalendarReadFailed(error) }
                    guard let ev = read, ev.calendarID == owned[gone.calendar] else { return .ok(nil) }
                    return .ok(record(ev, gone.calendar))
                }
                guard let (ev, calendar) = try ownEvent(id) else { return .ok(nil) }
                return .ok(record(ev, calendar))
            case let .calendarRemove(id, taskId):
                guard try ownEvent(id) != nil, let added = events[id] else { return .refused(.notAllowed, "the event is not one the reader added, in a calendar it created") }
                guard added.taskId == taskId else { return .refused(.notAllowed, "another task added this event; only that task removes it") }
                if let no = allowed() { return .refused(.notAllowed, no) }
                try backend.removeEvent(id: id)
                events.removeValue(forKey: id)
                removed.append((id, added.calendar))
                if removed.count > Self.removedKept { removed.removeFirst(removed.count - Self.removedKept) }
                return .ok(nil)
            case let .calendarDispose(calendar, taskId):
                if let cid = owned[calendar] {
                    let others = Set(events.values.filter { $0.calendar == calendar && $0.taskId != taskId }.map(\.taskId))
                    if !others.isEmpty { return .refused(.notAllowed, "the calendar holds events other tasks added (\(others.sorted().joined(separator: ", "))); it is not deleted") }
                    if let no = allowed() { return .refused(.notAllowed, no) }
                    try backend.deleteCalendar(id: cid)
                    owned.removeValue(forKey: calendar)
                    events = events.filter { $0.value.calendar != calendar }
                }
                return .ok(nil)
            default:
                return .refused(.notAllowed, "not a calendar verb")
            }
        } catch let e as CalendarReadFailed {
            return .refused(.axError, e.description)
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
                events = events.filter { $0.value.calendar != name }
            } catch { errors.append("\(name): \(error)") }
        }
        return errors
    }

    /// An event this adapter added, read only if its id is one it added, and kept only while the event is
    /// still in the calendar it was added to; otherwise the id is forgotten and nil returned. A read that fails
    /// throws CalendarReadFailed and forgets nothing: it says nothing about whether the event is there.
    private func ownEvent(_ id: String) throws -> (BackendEvent, String)? {
        guard let added = events[id], let cid = owned[added.calendar] else {
            events.removeValue(forKey: id)
            return nil
        }
        let read: BackendEvent?
        do { read = try backend.event(id: id) } catch { throw CalendarReadFailed(error) }
        guard let ev = read, ev.calendarID == cid else {
            events.removeValue(forKey: id)
            return nil
        }
        return (ev, added.calendar)
    }

    /// The event in its own calendar `cid` with this title, start and end, if any. Throws CalendarReadFailed when the
    /// calendar cannot be read.
    private func match(_ cid: String, _ title: String, _ s: Date, _ e: Date) throws -> BackendEvent? {
        let all: [BackendEvent]
        do { all = try backend.events(calendarID: cid, from: s.addingTimeInterval(-1), to: e.addingTimeInterval(1)) } catch { throw CalendarReadFailed(error) }
        return all.first { $0.title == title && abs($0.start.timeIntervalSince(s)) < 1 && abs($0.end.timeIntervalSince(e)) < 1 }
    }

    private func record(_ e: BackendEvent, _ calendar: String) -> CalendarEventRecord {
        CalendarEventRecord(id: e.id, calendar: calendar, title: e.title, start: CalendarTime.format(e.start, zone: zone), end: CalendarTime.format(e.end, zone: zone))
    }
}
