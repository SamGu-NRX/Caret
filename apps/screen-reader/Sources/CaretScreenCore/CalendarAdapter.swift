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
//
// The shipped app (H8) runs it in the user scope (`CalendarScope.user`) instead: it adds to the calendar
// the user chose in What Caret knows while that calendar still accepts events, else to their default
// calendar for new events, and never creates or deletes a calendar. The other rules hold there too: it
// finds, reads and removes only events it added, by their ids, each only while still in the calendar it
// was added to, and only for the task that added it, so undo removes exactly Caret's event and never one
// of the user's own, however alike. An add of an event the destination already holds, the user's own
// included, is refused, so a reader that restarted cannot add a second copy. The helper's calendar name
// ("Caret") is only a label in this scope.
import Foundation

/// What a person can change on an event besides its title, calendar and times, as the store reads it. Undo removes an
/// event only while all of it is as Caret saved it (Greptile review on #13: an undo deleted an event the user had edited).
public struct EventState: Equatable, Sendable {
    public var notes: String
    public var location: String
    public var url: String
    /// Each alarm as the store reads it: its offset in seconds, or its date.
    public var alarms: [String]
    /// Each attendee the store lets the reader read, by its address.
    public var attendees: [String]
    public var allDay: Bool
    /// When the store last saw the event change, if it says.
    public var lastModified: Date?
    public init(notes: String = "", location: String = "", url: String = "", alarms: [String] = [], attendees: [String] = [], allDay: Bool = false, lastModified: Date? = nil) {
        self.notes = notes; self.location = location; self.url = url; self.alarms = alarms; self.attendees = attendees; self.allDay = allDay; self.lastModified = lastModified
    }

    /// Whether `now` is this state still. A modification date counts only when both reads have one: the store may give
    /// none for the copy Caret saved.
    public func unchanged(in now: EventState) -> Bool {
        var a = self, b = now
        if a.lastModified == nil || b.lastModified == nil { a.lastModified = nil; b.lastModified = nil }
        return a == b
    }
}

/// An event as a backend reports it.
public struct BackendEvent: Equatable, Sendable {
    public var id: String
    public var calendarID: String
    public var title: String
    public var start: Date
    public var end: Date
    public var state: EventState
    public init(id: String, calendarID: String, title: String, start: Date, end: Date, state: EventState = EventState()) {
        self.id = id; self.calendarID = calendarID; self.title = title; self.start = start; self.end = end; self.state = state
    }

    /// Whether `now`, a fresh read of this event, is still what Caret saved: the same calendar, title, times and state.
    public func unchanged(in now: BackendEvent) -> Bool {
        now.id == id && now.calendarID == calendarID && now.title == title && abs(now.start.timeIntervalSince(start)) < 1
            && abs(now.end.timeIntervalSince(end)) < 1 && state.unchanged(in: now.state)
    }
}

/// A removal the backend refused because a fresh read of the event no longer matches what Caret saved.
public struct CalendarEventChanged: Error, CustomStringConvertible {
    public init() {}
    public var description: String { CalendarAdapter.changedByYou }
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
    /// The event as saved, with its id and state.
    func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> BackendEvent
    /// Throws when the store cannot be read; nil means it was read and holds no such event.
    func event(id: String) throws -> BackendEvent?
    /// Removes the event only if a fresh read, inside the removal, is still `saved` (BackendEvent.unchanged); otherwise
    /// throws CalendarEventChanged and removes nothing. A check before the call would leave a race with the user's edit.
    func removeEvent(id: String, ifStill saved: BackendEvent) throws
    /// The user's default calendar for new events, when it accepts them; nil when there is none (H8).
    func defaultCalendarID() -> String?
    /// The calendar exists and accepts new events (H8).
    func isWritable(calendarID: String) -> Bool
}

/// Which calendars the adapter writes to.
public enum CalendarScope: Sendable {
    /// `--calendar-test`: only calendars it creates on a local source, deleted when it is done (B16).
    case ownLocal
    /// `--calendar-user`, the shipped app (H8): the calendar the user chose in What Caret knows while it
    /// still accepts events, else their default calendar for new events. It never creates or deletes a
    /// calendar. `choice` reads the saved choice at each add and throws when it cannot be read.
    case user(choice: @Sendable () throws -> String?)
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
    /// Each event this adapter added and has not removed, by id: the name of its calendar, the id of the calendar it went
    /// into, and the task that added it.
    private var events: [String: Added] = [:]
    private struct Added { var calendar: String; var calendarID: String; var taskId: String; var saved: BackendEvent }

    /// What undo says of an event the user changed after Caret added it.
    public static let changedByYou = "You've changed this event, so Caret left it"
    /// Events this adapter removed, by id, with their calendars, newest last: a get of one reads the store, so undo's check
    /// after a removal is a real read that can fail, never the adapter's own word (B23 review, S1 audit #16).
    private var removed: [(id: String, calendar: String, calendarID: String)] = []
    /// Removed ids kept for that check. Assumed: undo checks right after it removes.
    static let removedKept = 64

    private let scope: CalendarScope

    public init(backend: CalendarBackend, scope: CalendarScope = .ownLocal, zone: TimeZone = .current) {
        self.backend = backend
        self.scope = scope
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
                if case .user = scope { return .ok(try ownMatch(calendar, title, s, e).map { record($0, calendar) }) }
                guard let cid = owned[calendar] else { return .ok(nil) }
                return .ok(try match(cid, title, s, e).map { record($0, calendar) })
            case let .calendarAdd(calendar, title, start, end, taskId):
                guard let s = CalendarTime.parse(start), let e = CalendarTime.parse(end), e > s else { return .refused(.changed, "start and end are not ISO 8601 times, or end is not after start") }
                let cid: String
                if case .user(let choice) = scope {
                    if try ownMatch(calendar, title, s, e) != nil { return .refused(.changed, "an identical event is already in the calendar; nothing was added") }
                    let chosen: String?
                    do { chosen = try choice() } catch { return .refused(.axError, "cannot read the calendar choice: \(error)") }
                    if let chosen, backend.isWritable(calendarID: chosen) {
                        cid = chosen
                    } else if let fallback = backend.defaultCalendarID() {
                        cid = fallback
                    } else {
                        return .blocked(.noLocalSource)
                    }
                    // The same event already there, whoever added it, is refused: this reader's record of its own
                    // adds dies with it, so after a restart only the calendar itself can stop a second copy. The read
                    // is of that calendar's events at that time, and no id from it leaves the adapter.
                    if try match(cid, title, s, e) != nil { return .refused(.changed, "an identical event is already in the calendar; nothing was added") }
                } else if let known = owned[calendar] {
                    cid = known
                    if try match(cid, title, s, e) != nil { return .refused(.changed, "an identical event is already in the calendar; nothing was added") }
                } else {
                    guard let source = backend.localSourceID() else { return .blocked(.noLocalSource) }
                    if let no = allowed() { return .refused(.notAllowed, no) }
                    cid = try backend.createCalendar(title: calendar, sourceID: source)
                    owned[calendar] = cid
                }
                if let no = allowed() { return .refused(.notAllowed, no) }
                let saved = try backend.saveEvent(calendarID: cid, title: title, start: s, end: e)
                events[saved.id] = Added(calendar: calendar, calendarID: cid, taskId: taskId, saved: saved)
                return .ok(record(BackendEvent(id: saved.id, calendarID: cid, title: title, start: s, end: e), calendar))
            case let .calendarGet(id):
                if events[id] == nil, let gone = removed.last(where: { $0.id == id }) {
                    // Removed by this adapter: whether it is really gone is read from the store.
                    let read: BackendEvent?
                    do { read = try backend.event(id: id) } catch { throw CalendarReadFailed(error) }
                    guard let ev = read, ev.calendarID == gone.calendarID else { return .ok(nil) }
                    return .ok(record(ev, gone.calendar))
                }
                guard let (ev, calendar) = try ownEvent(id) else { return .ok(nil) }
                return .ok(record(ev, calendar))
            case let .calendarRemove(id, taskId):
                guard try ownEvent(id) != nil, let added = events[id] else { return .refused(.notAllowed, notOurs) }
                guard added.taskId == taskId else { return .refused(.notAllowed, "another task added this event; only that task removes it") }
                if let no = allowed() { return .refused(.notAllowed, no) }
                do { try backend.removeEvent(id: id, ifStill: added.saved) } catch is CalendarEventChanged { return .refused(.changed, Self.changedByYou) }
                events.removeValue(forKey: id)
                removed.append((id, added.calendar, added.calendarID))
                if removed.count > Self.removedKept { removed.removeFirst(removed.count - Self.removedKept) }
                return .ok(nil)
            case .calendarDispose where isUserScope:
                return .refused(.notAllowed, "the reader never deletes one of the user's calendars")
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
        // In the test scope the calendar must also still be one it created and has not deleted.
        guard let added = events[id], isUserScope || owned[added.calendar] == added.calendarID else {
            events.removeValue(forKey: id)
            return nil
        }
        let read: BackendEvent?
        do { read = try backend.event(id: id) } catch { throw CalendarReadFailed(error) }
        guard let ev = read, ev.calendarID == added.calendarID else {
            events.removeValue(forKey: id)
            return nil
        }
        return (ev, added.calendar)
    }

    /// The user scope's `match`: an event this adapter added under this calendar name, still where it put it, with this
    /// title, start and end. Only its own events are read; the user's calendar is never searched.
    private func ownMatch(_ calendar: String, _ title: String, _ s: Date, _ e: Date) throws -> BackendEvent? {
        for id in events.filter({ $0.value.calendar == calendar }).keys.sorted() {
            guard let (ev, _) = try ownEvent(id) else { continue }
            if ev.title == title && abs(ev.start.timeIntervalSince(s)) < 1 && abs(ev.end.timeIntervalSince(e)) < 1 { return ev }
        }
        return nil
    }

    private var isUserScope: Bool {
        if case .user = scope { return true }
        return false
    }

    /// Why a remove of an id it does not hold is refused, in each scope's terms.
    private var notOurs: String {
        isUserScope ? "the event is not one the reader added, in a calendar it added it to" : "the event is not one the reader added, in a calendar it created"
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

/// The host's settings file, read for the calendar the user chose in What Caret knows (H8): its
/// top-level `eventCalendar`, an EventKit calendar identifier (CaretSettings on v2/host).
public enum CalendarChoiceFile {
    public struct Unreadable: Error, CustomStringConvertible {
        public let description: String
    }

    /// The chosen calendar's identifier, or nil for the default: no file yet, or no `eventCalendar` in it. A file that is
    /// not a JSON object, or a choice that is not a non-empty string, throws rather than falling back to the default.
    public static func read(_ path: String) throws -> String? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw Unreadable(description: "\(path) is not a JSON object")
        }
        guard let value = object["eventCalendar"] else { return nil }
        guard let id = value as? String, !id.isEmpty else { throw Unreadable(description: "\(path): eventCalendar is not a calendar identifier") }
        return id
    }
}
