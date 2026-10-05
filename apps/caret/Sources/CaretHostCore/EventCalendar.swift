import Foundation

// Where an accepted event card's event goes in the shipped app (H8, lead decision 1): the calendar the
// user chose in What Caret knows, else their default calendar for new events. The reader writes it
// (caret-screen --calendar-user, CalendarAdapter's user scope) by the same rule, from the same saved
// choice, so the card names the calendar the event lands in. Caret asks macOS for Calendar access the
// first time an event card is accepted (`SurfaceMachine.calendarAccessUndetermined`), never at launch.

/// macOS's Calendar authorization for Caret, by EventKit's names.
public enum CalendarAccess: String, Codable, Sendable {
    case notDetermined, denied, restricted, writeOnly, fullAccess

    /// The reader needs full access: it reads each event back after adding it and before undoing it.
    /// Write-only access, which System Settings can grant, is not enough.
    public var granted: Bool { self == .fullAccess }
}

/// A calendar Caret may add events to.
public struct WritableCalendar: Codable, Equatable, Sendable {
    /// EventKit's `calendarIdentifier`.
    public var id: String
    public var title: String
    /// The account it belongs to ("iCloud", "On My Mac"), to tell two calendars of one name apart.
    public var account: String

    public init(id: String, title: String, account: String) {
        self.id = id
        self.title = title
        self.account = account
    }
}

/// The user's calendars as the host sees them. EventKit's in the app (`EventKitCalendars`); tests use a fake.
public protocol CalendarDirectory: AnyObject {
    /// Read without asking anything.
    var access: CalendarAccess { get }
    /// Every calendar that accepts new events, in the order Calendar lists them; empty without full access.
    func writableCalendars() -> [WritableCalendar]
    /// The default calendar for new events, when there is full access and it accepts events.
    func defaultCalendar() -> WritableCalendar?
}

/// Where the next accepted event goes, and how the card and What Caret knows say it.
public enum EventDestination: Equatable, Sendable {
    /// Caret has not asked for Calendar access yet; it asks when the user accepts a card.
    case notAsked
    /// Access was refused or limited in System Settings.
    case noAccess(CalendarAccess)
    /// Full access, and no calendar accepts new events.
    case noCalendar
    /// `chosen` is false for the default calendar for new events. `missing` holds a choice that no
    /// longer names a writable calendar, so the default stands in for it.
    case calendar(WritableCalendar, chosen: Bool, missing: String? = nil)

    /// The user's choice if it still names a writable calendar, else the default for new events.
    /// The reader applies the same rule to the same choice (CalendarAdapter, user scope).
    public static func resolve(choice: String?, in directory: CalendarDirectory) -> EventDestination {
        let access = directory.access
        guard access != .notDetermined else { return .notAsked }
        guard access.granted else { return .noAccess(access) }
        if let choice, let chosen = directory.writableCalendars().first(where: { $0.id == choice }) {
            return .calendar(chosen, chosen: true)
        }
        guard let fallback = directory.defaultCalendar() else { return .noCalendar }
        return .calendar(fallback, chosen: false, missing: choice)
    }

    public var calendar: WritableCalendar? {
        if case .calendar(let c, _, _) = self { return c }
        return nil
    }
}

/// The words for the destination: the card's line and the What Caret knows row.
public enum EventCalendarCopy {
    /// The card's line under the time.
    public static func cardLine(_ d: EventDestination) -> String {
        switch d {
        case .calendar(let c, _, _): return "Adding to \(c.title)"
        case .notAsked: return "Adding to your default calendar"
        case .noAccess: return "Caret can't use Calendar"
        case .noCalendar: return "No calendar takes new events"
        }
    }

    /// The row in What Caret knows, Permissions.
    public static let title = "Calendar for new events"
    public static let covers = "Where Tab puts an event Caret offers to add."
    /// The pop-up's first item: whatever the user's default is now.
    public static func defaultItem(_ d: CalendarDirectory) -> String {
        d.defaultCalendar().map { "Default (\($0.title))" } ?? "Default calendar"
    }

    /// Under the row: what happens now, in a sentence.
    public static func detail(_ d: EventDestination) -> String {
        switch d {
        case .notAsked:
            return "Caret asks to use Calendar the first time you add an event, then adds it to your default calendar."
        case .noAccess(.writeOnly):
            return "Caret can add events but not read them back, so it can't undo one. Allow full access in System Settings, Privacy & Security, Calendars."
        case .noAccess:
            return "Caret can't use Calendar. Turn it on in System Settings, Privacy & Security, Calendars."
        case .noCalendar:
            return "None of your calendars takes new events."
        case .calendar(let c, false, _?):
            return "The calendar you picked is gone or read-only, so events go to \(c.title), your default."
        case .calendar(let c, true, _):
            return "Events you add go to \(c.title) in \(c.account)."
        case .calendar(let c, false, nil):
            return "Events you add go to \(c.title), your default calendar. It changes when your default does."
        }
    }

    /// A pop-up item for one calendar: its title, with the account when two calendars share the title.
    public static func item(_ c: WritableCalendar, among all: [WritableCalendar]) -> String {
        all.filter { $0.title == c.title }.count > 1 ? "\(c.title) (\(c.account))" : c.title
    }
}

/// What Caret knows, Permissions: the "Calendar for new events" row (H8). Its pop-up lists the default
/// first, then every calendar that takes new events; it works only with full access, and otherwise shows
/// the default alone, disabled, with the sentence saying what to do.
public struct CalendarChoiceRow: Equatable, Sendable {
    public struct Item: Equatable, Sendable {
        /// The calendar's identifier; nil for "Default".
        public var id: String?
        public var title: String
    }

    public var items: [Item]
    /// The item shown as chosen: the saved choice while it still takes events, else the default (nil).
    public var current: String?
    public var detail: String
    public var enabled: Bool

    public static func make(choice: String?, directory: CalendarDirectory) -> CalendarChoiceRow {
        let destination = EventDestination.resolve(choice: choice, in: directory)
        let all = directory.writableCalendars()
        let first = Item(id: nil, title: EventCalendarCopy.defaultItem(directory))
        let current: String?
        if case .calendar(let c, true, _) = destination { current = c.id } else { current = nil }
        return CalendarChoiceRow(
            items: [first] + all.map { Item(id: $0.id, title: EventCalendarCopy.item($0, among: all)) },
            current: current, detail: EventCalendarCopy.detail(destination), enabled: directory.access.granted && !all.isEmpty
        )
    }
}
