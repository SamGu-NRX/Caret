import CaretHostCore
import Foundation
import SwiftUI

// Renders of a value question on the desk: which value goes in one field. Synthetic content only, from the helper's
// golden lines (ask-values.ndjson) and one made-up list long enough to scroll.
extension Gallery {
    /// The golden value questions, decoded through the same checks a helper's pass: "work email" (two values, the
    /// second read from a window), and the long list.
    static func askValueQuestion(long: Bool = false) -> AskQuestion {
        let options: String
        let text: String
        if long {
            text = "Which address should go in Street address?"
            let streets = [
                ("1180 Hollow Creek Road, Apartment 4B", "Your saved Address"),
                ("1180 Hollow Creek Road, Apartment 4D", "Lease renewal: New unit: 1180 Hollow Creek Road, Apartment 4D"),
                ("22 Marlow Street", "Rental notes.txt: Previous address: 22 Marlow Street"),
                ("22 Marlow St., Unit 3", "Mail, Deposit refund: Forwarding from 22 Marlow St., Unit 3"),
                ("PO Box 4417", "Your saved Mailing address"),
                ("4417 Larkspur Lane", "Moving checklist.txt: Storage unit at 4417 Larkspur Lane"),
                ("9 Wren Court", "Calendar, Viewing on Saturday: 9 Wren Court"),
            ]
            let values = streets.enumerated().map { i, s in #"{"kind":"value","id":"o\#(i + 1)","value":"\#(s.0)","source":"\#(s.1)"}"# }
            options = "[" + (values + [#"{"kind":"blank","id":"o8"}"#]).joined(separator: ",") + "]"
        } else {
            text = "Which email should go in Work email?"
            options = #"[{"kind":"value","id":"o1","value":"grace.oduya@example.com","source":"Your saved Email"},{"kind":"value","id":"o2","value":"g.oduya@lumen.example","source":"Venue deposit and Thursday review: Grace's other address: g.oduya@lumen.example"},{"kind":"blank","id":"o3"}]"#
        }
        let line = #"{"type":"askQuestion","v":1,"requestId":"ask-21","at":1790000502400,"questionId":"ask-5-ask-21","part":"value","text":"\#(text)","pick":"one","options":\#(options),"filling":["First name: Grace","Last name: Oduya"],"window":{"pid":4100,"windowId":"page:eng7:15","appName":"Google Chrome","title":"Request a demo | Ledgerline"},"expires":1790001102400}"#
        return try! JSONDecoder().decode(AskQuestion.self, from: Data(line.utf8))
    }

    static func askValues(_ character: FigureCharacter = .pebble) -> [Item] {
        func desk(_ question: AskCaret.Question) -> AnyView {
            let phase = AskCaret.Phase.question(question)
            let section = AskSection(text: "can u put my name and work email in", phase: phase, character: character, showsFocus: true, animated: false)
            return AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(section), askActive: true, askHeader: phase.header { _ in false })
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        return [
            Item(name: "ask-question-value", view: desk(AskCaret.Question(ask: askValueQuestion()))),
            Item(name: "ask-question-value-highlighted", view: desk(AskCaret.Question(ask: askValueQuestion(), highlight: 1))),
            Item(name: "ask-question-value-scrolls", view: desk(AskCaret.Question(ask: askValueQuestion(long: true), highlight: 0))),
        ]
    }
}
