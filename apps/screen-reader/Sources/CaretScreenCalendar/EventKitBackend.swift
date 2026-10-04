// The real calendar store behind CalendarAdapter. It reads the authorization status, and creates an
// EKEventStore only once full access is already granted: it never calls a request method, so it can
// never put a system prompt on the screen. The adapter decides what may be written; this file only
// translates its calls to EventKit.
import CaretScreenCore
import EventKit
import Foundation

public struct EventKitError: Error, CustomStringConvertible {
    public let description: String
    init(_ d: String) { description = d }
}

public final class EventKitBackend: CalendarBackend, @unchecked Sendable {
    private var storeObj: EKEventStore?

    public init() {}

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

    public func hasFullAccess() -> Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
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
        let s = try store()
        guard let source = s.source(withIdentifier: sourceID), source.sourceType == .local else { throw EventKitError("source \(sourceID) is not a local source") }
        let c = EKCalendar(for: .event, eventStore: s)
        c.title = title
        c.source = source
        try s.saveCalendar(c, commit: true)
        return c.calendarIdentifier
    }

    public func deleteCalendar(id: String) throws {
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

    public func saveEvent(calendarID: String, title: String, start: Date, end: Date) throws -> String {
        let s = try store()
        guard let c = s.calendar(withIdentifier: calendarID), c.source.sourceType == .local else { throw EventKitError("calendar \(calendarID) is not a local calendar") }
        let e = EKEvent(eventStore: s)
        e.calendar = c
        e.title = title
        e.startDate = start
        e.endDate = end
        try s.save(e, span: .thisEvent, commit: true)
        guard let id = e.eventIdentifier else { throw EventKitError("the saved event has no identifier") }
        return id
    }

    /// Throws when access is gone (S1 audit #16: before B23 this answered "no such event", which undo took as removed).
    public func event(id: String) throws -> BackendEvent? {
        let s = try store()
        guard let e = s.event(withIdentifier: id) else { return nil }
        return Self.backendEvent(e)
    }

    public func removeEvent(id: String) throws {
        let s = try store()
        guard let e = s.event(withIdentifier: id) else { return }
        try s.remove(e, span: .thisEvent, commit: true)
    }

    private static func backendEvent(_ e: EKEvent) -> BackendEvent? {
        guard let id = e.eventIdentifier, let c = e.calendar, let start = e.startDate, let end = e.endDate else { return nil }
        return BackendEvent(id: id, calendarID: c.calendarIdentifier, title: e.title ?? "", start: start, end: end)
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
