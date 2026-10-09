// The real calendar store behind CalendarAdapter. It reads the authorization status, and, while that says
// notDetermined, whether a store sees calendars (`hasFullAccess`): it never calls a request method, so it can
// never put a system prompt on the screen (in the shipped app Caret asks, when the user first accepts an
// event card, and this process inherits Caret's answer). The adapter decides what may be written; this
// file only translates its calls to EventKit, and refuses a write outside its scope as a second check:
// with `--calendar-test` only local calendars, with `--calendar-user` any calendar that accepts events
// but never creating or deleting one.
import CaretScreenCore
import EventKit
import Foundation

public struct EventKitError: Error, CustomStringConvertible {
    public let description: String
    init(_ d: String) { description = d }
}

public final class EventKitBackend: CalendarBackend, @unchecked Sendable {
    private var storeObj: EKEventStore?
    /// `--calendar-user` (H8): saves go to the user's calendars; calendars are never created or deleted.
    private let userCalendars: Bool

    public init(userCalendars: Bool = false) {
        self.userCalendars = userCalendars
    }

    /// The authorization status, by name, without asking for anything.
    public static func statusName() -> String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined: "notDetermined"
        case .restricted: "restricted"
        case .denied: "denied"
        case .fullAccess: "fullAccess"
        case .writeOnly: "writeOnly"
        @unknown default: "unknown"
        }
    }

    /// Full access, without asking. The class status is not enough on its own: in the rig guest (evidence/host/h8,
    /// VM run 5), a process that was running when access was granted read the status as notDetermined, then
    /// fullAccess, then notDetermined again, while a new store in that process read the calendars throughout. The
    /// shipped reader starts at launch, before Caret first asks, so while the status says notDetermined a store is
    /// asked: one that sees calendars means access. Making a store and listing its calendars prompts for nothing;
    /// only the request methods do, and this file calls none.
    public func hasFullAccess() -> Bool {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess: return true
        case .notDetermined:
            let s = storeObj ?? EKEventStore()
            guard !s.calendars(for: .event).isEmpty else { return false }
            storeObj = s
            return true
        default: return false
        }
    }

    private func store() throws -> EKEventStore {
        guard hasFullAccess() else { throw EventKitError("no full Calendar access") }
        if let s = storeObj { return s }
        let s = EKEventStore()
        storeObj = s
        return s
    }

    public func localSourceID() -> String? {
        (try? store())?.sources.first { $0.sourceType == .local }?.sourceIdentifier
    }

    public func createCalendar(title: String, sourceID: String) throws -> String {
        guard !userCalendars else { throw EventKitError("the user's calendars are never added to by creating one") }
        let s = try store()
        guard let source = s.source(withIdentifier: sourceID), source.sourceType == .local else { throw EventKitError("source \(sourceID) is not a local source") }
        let c = EKCalendar(for: .event, eventStore: s)
        c.title = title
        c.source = source
        try s.saveCalendar(c, commit: true)
        return c.calendarIdentifier
    }

    public func deleteCalendar(id: String) throws {
        guard !userCalendars else { throw EventKitError("a user's calendar is never deleted") }
        let s = try store()
        guard let c = s.calendar(withIdentifier: id) else { return }
        // The adapter only names calendars it created; a non-local one here would be a bug, so it is refused.
        guard c.source.sourceType == .local else { throw EventKitError("calendar \(id) is not on a local source") }
        try s.removeCalendar(c, commit: true)
    }

    /// Throws when access is gone (S1 audit #16: before B23 this answered no events); a calendar that is gone has none.
    public func events(calendarID: String, from: Date, to: Date) throws -> [BackendEvent] {
        let s = try store()
        guard let c = s.calendar(withIdentifier: calendarID) else { return [] }
        return s.events(matching: s.predicateForEvents(withStart: from, end: to, calendars: [c])).compactMap(Self.backendEvent)
    }

    public func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> BackendEvent {
        let s = try store()
        guard let c = s.calendar(withIdentifier: calendarID) else { throw EventKitError("no calendar \(calendarID)") }
        if userCalendars {
            guard c.allowsContentModifications else { throw EventKitError("calendar \(calendarID) does not accept new events") }
        } else {
            guard c.source.sourceType == .local else { throw EventKitError("calendar \(calendarID) is not a local calendar") }
        }
        let e = EKEvent(eventStore: s)
        e.calendar = c
        e.title = title
        e.startDate = start
        e.endDate = end
        try s.save(e, span: .thisEvent, commit: true)
        guard let id = e.eventIdentifier else { throw EventKitError("the saved event has no identifier") }
        // The state undo compares against is the store's own read of the saved event, so what the store adds on save (a
        // calendar's default alarm, a modification date) is not taken for the user's edit. A read that fails here falls
        // back to the saved object: the id is never lost to it.
        let stored = (s.event(withIdentifier: id)).flatMap(Self.backendEvent)
        return stored ?? Self.backendEvent(e) ?? BackendEvent(id: id, calendarID: calendarID, title: title, start: start, end: end)
    }

    /// Throws when access is gone (S1 audit #16: before B23 this answered "no such event", which undo took as removed).
    public func event(id: String) throws -> BackendEvent? {
        let s = try store()
        guard let e = s.event(withIdentifier: id) else { return nil }
        return Self.backendEvent(e)
    }

    public func defaultCalendarID() -> String? {
        guard let c = (try? store())?.defaultCalendarForNewEvents, c.allowsContentModifications else { return nil }
        return c.calendarIdentifier
    }

    public func isWritable(calendarID: String) -> Bool {
        (try? store())?.calendar(withIdentifier: calendarID)?.allowsContentModifications == true
    }

    /// The fresh read and the removal happen here, together, so an edit the user makes after the adapter's checks still
    /// stops it: an event that is no longer as Caret saved it is left (CalendarEventChanged).
    public func removeEvent(id: String, ifStill saved: BackendEvent) throws {
        let s = try store()
        guard let e = s.event(withIdentifier: id) else { return }
        _ = e.refresh()
        guard let now = Self.backendEvent(e), saved.unchanged(in: now) else { throw CalendarEventChanged() }
        try s.remove(e, span: .thisEvent, commit: true)
    }

    private static func backendEvent(_ e: EKEvent) -> BackendEvent? {
        guard let id = e.eventIdentifier, let c = e.calendar, let start = e.startDate, let end = e.endDate else { return nil }
        let alarms = (e.alarms ?? []).map { a in a.absoluteDate.map { "at \($0.timeIntervalSince1970)" } ?? "offset \(a.relativeOffset)" }
        let attendees = (e.attendees ?? []).map { $0.url.absoluteString }.sorted()
        let state = EventState(notes: e.notes ?? "", location: e.location ?? "", url: e.url?.absoluteString ?? "", alarms: alarms.sorted(), attendees: attendees, allDay: e.isAllDay, lastModified: e.lastModifiedDate)
        return BackendEvent(id: id, calendarID: c.calendarIdentifier, title: e.title ?? "", start: start, end: end, state: state)
    }

    /// A read-only look, through a store of its own, at every event calendar with this title: its source
    /// and how many events it holds in the two years either side of now. For the VM test's own check.
    public static func audit(title: String) throws -> [[String: Any]] {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw EventKitError("blocked: tcc") }
        let s = EKEventStore()
        let year: TimeInterval = 365 * 24 * 3600
        return s.calendars(for: .event).filter { $0.title == title }.map { c in
            let n = s.events(matching: s.predicateForEvents(withStart: Date().addingTimeInterval(-2 * year), end: Date().addingTimeInterval(2 * year), calendars: [c])).count
            return ["title": c.title, "id": c.calendarIdentifier, "sourceType": c.source.sourceType.rawValue, "sourceTitle": c.source.title, "events": n]
        }
    }
}
