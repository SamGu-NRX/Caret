import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// Renders for brief H8: the event card naming where Tab puts the event, and "Calendar for new events"
// in What Caret knows in each state. Synthetic content only: invented calendars and the helper's event
// card as event-card.ts builds it.
extension Gallery {
    /// The user's calendars for a render, as EventKit would list them.
    final class GalleryCalendars: CalendarDirectory {
        let access: CalendarAccess
        let calendars = [
            WritableCalendar(id: "home-1", title: "Home", account: "iCloud"),
            WritableCalendar(id: "work-1", title: "Work", account: "Exchange"),
            WritableCalendar(id: "family-1", title: "Family", account: "iCloud"),
        ]
        init(_ access: CalendarAccess) { self.access = access }
        func writableCalendars() -> [WritableCalendar] { access.granted ? calendars : [] }
        func defaultCalendar() -> WritableCalendar? { access.granted ? calendars[0] : nil }
    }

    static func h8(_ character: FigureCharacter = .pebble) -> [Item] {
        func permissions(_ access: CalendarAccess, choice: String?) -> AnyView {
            let row = CalendarChoiceRow.make(choice: choice, directory: GalleryCalendars(access))
            return AnyView(MemoryView(state: memoryState(), files: memoryFiles(), tab: .permissions, character: character, calendarRow: row, animated: false, now: memoryNow)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        func card(_ access: CalendarAccess, choice: String?) -> AnyView {
            let line = EventCalendarCopy.cardLine(EventDestination.resolve(choice: choice, in: GalleryCalendars(access)))
            let spec = EventCardCopy.card(EventCardCopy.destinedSpec(helperEventCard, line: line))
            return AnyView(PopupView(spec: spec, character: character, animated: false))
        }
        return [
            Item(name: "event-card-destination", view: card(.fullAccess, choice: "work-1")),
            Item(name: "event-card-destination-not-asked", view: card(.notDetermined, choice: nil)),
            Item(name: "memory-calendar-not-asked", view: permissions(.notDetermined, choice: nil)),
            Item(name: "memory-calendar-default", view: permissions(.fullAccess, choice: nil)),
            Item(name: "memory-calendar-chosen", view: permissions(.fullAccess, choice: "work-1")),
            Item(name: "memory-calendar-denied", view: permissions(.denied, choice: nil)),
        ]
    }
}
