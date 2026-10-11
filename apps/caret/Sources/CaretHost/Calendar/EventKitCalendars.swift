import CaretHostCore
import EventKit
import Foundation

/// The user's calendars through EventKit, for the event card's destination line and What Caret knows
/// (H8 decision 1). Reading the authorization status asks nothing; `requestAccess` is the one call that
/// puts macOS's prompt up, and only the first accepted event card makes it (`SurfaceMachine`). A store
/// is made only once access is granted, and made again after any change in access, since a store made
/// before a grant does not see the calendars. The reader writes the event itself (caret-screen
/// --calendar-user); as Caret's child it is covered by Caret's answer.
final class EventKitCalendars: CalendarDirectory, CalendarAccessAsking {
    static let shared = EventKitCalendars()

    /// The Info.plist key macOS shows in its prompt. Without it, asking for access ends the process.
    static let usageKey = "NSCalendarsFullAccessUsageDescription"

    private var store: EKEventStore?
    private var storeAccess: CalendarAccess?
    /// What this process's own request was answered (`CalendarAccess.effective`).
    private var answered: CalendarAccess?
    private var changes: NSObjectProtocol?
    /// Calendars or the default changed (`EKEventStoreChanged`), or access did. Main thread.
    var onChange: (() -> Void)?

    /// The request's answer stands only until the status (or a store) says anything but notDetermined: after
    /// that it is the status's, so a later reset of Calendar access in System Settings is asked about again.
    var access: CalendarAccess {
        let now = status
        if now != .notDetermined { answered = nil }
        return CalendarAccess.effective(status: now, answered: answered)
    }

    /// When the class status says notDetermined, whether a store sees calendars, checked at most once a second:
    /// the status can say notDetermined after a grant (`EventKitBackend.hasFullAccess`, VM run 5). A store asks
    /// nothing; only `requestAccess` puts the prompt up.
    private var probe: (at: Date, store: EKEventStore, sees: Bool)?

    private func storeSeesCalendars() -> Bool {
        if let probe, Date().timeIntervalSince(probe.at) < 1 { return probe.sees }
        let s = probe?.store ?? EKEventStore()
        if probe?.sees == false { s.reset() }
        let sees = !s.calendars(for: .event).isEmpty
        probe = (Date(), s, sees)
        return sees
    }

    private var status: CalendarAccess {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined: return storeSeesCalendars() ? .fullAccess : .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .fullAccess: return .fullAccess
        case .writeOnly: return .writeOnly
        @unknown default: return .denied
        }
    }

    func writableCalendars() -> [WritableCalendar] {
        guard let s = grantedStore() else { return [] }
        return s.calendars(for: .event).filter(\.allowsContentModifications).map(Self.writable)
    }

    func defaultCalendar() -> WritableCalendar? {
        guard let c = grantedStore()?.defaultCalendarForNewEvents, c.allowsContentModifications else { return nil }
        return Self.writable(c)
    }

    /// Where the next accepted event goes, by the choice saved in What Caret knows.
    func destination(choice: String?) -> EventDestination {
        EventDestination.resolve(choice: choice, in: self)
    }

    /// Puts macOS's Calendar prompt up when Caret has never asked, and calls `done` on main with the access
    /// that results. A build without the usage string (a bare `swift run`) does not ask: `done` hears the
    /// access as it is, and the reader's `blocked: tcc` says the rest.
    func requestAccess(_ done: @escaping (CalendarAccess) -> Void) {
        guard access == .notDetermined, Bundle.main.object(forInfoDictionaryKey: Self.usageKey) != nil else {
            if access == .notDetermined { FileHandle.standardError.write(Data("caret: calendar: no \(Self.usageKey) in this build; not asking\n".utf8)) }
            return done(access)
        }
        // The store that asks is kept: after a grant it reads the calendars even while the status lags.
        let asking = EKEventStore()
        asking.requestFullAccessToEvents { [weak self] granted, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error { FileHandle.standardError.write(Data("caret: calendar: access request: \(error.localizedDescription)\n".utf8)) }
                self.answered = granted ? .fullAccess : .denied
                self.store = granted ? asking : nil
                self.storeAccess = granted ? .fullAccess : nil
                let calendars = granted ? asking.calendars(for: .event).count : 0
                FileHandle.standardError.write(Data("caret: calendar: granted \(granted), status \(self.status.rawValue), \(calendars) calendars\n".utf8))
                if granted { self.watch(asking) }
                done(self.access)
                self.onChange?()
            }
        }
    }

    private func grantedStore() -> EKEventStore? {
        let now = access
        guard now.granted else {
            store = nil
            return nil
        }
        if let store, storeAccess == now { return store }
        let s = EKEventStore()
        store = s
        storeAccess = now
        watch(s)
        return s
    }

    private func watch(_ s: EKEventStore) {
        if let changes { NotificationCenter.default.removeObserver(changes) }
        changes = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: s, queue: .main) { [weak self] _ in
            self?.onChange?()
        }
    }

    private static func writable(_ c: EKCalendar) -> WritableCalendar {
        WritableCalendar(id: c.calendarIdentifier, title: c.title, account: c.source?.title ?? "")
    }
}
