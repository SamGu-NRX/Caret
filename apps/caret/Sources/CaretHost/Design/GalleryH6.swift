import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// Renders for brief H6: "When Caret helps" in What Caret knows, an Ask's question on the desk
// (B29), and the fill slip with ⌘1 Fill all (D2-04). Synthetic content only, from the helper's
// golden lines (ask-choices.ndjson).
extension Gallery {
    /// Questions as ask-choices.ndjson has them, decoded through the same checks a helper's pass.
    static func askQuestion(part: AskQuestion.Part) -> AskQuestion {
        let options: String
        let text: String
        switch part {
        case .fields:
            text = "Which fields should Caret fill?"
            options = #"[{"kind":"field","id":"o1","label":"Landlord name","section":"Current residence"},{"kind":"field","id":"o2","label":"Landlord phone","section":"Current residence"},{"kind":"field","id":"o3","label":"Monthly rent","section":"Current residence"}]"#
        case .source:
            text = "Where should Caret copy from?"
            options = #"[{"kind":"window","id":"o1","app":"TextEdit","title":"Rental notes.txt"},{"kind":"window","id":"o2","app":"Mail","title":"Lease renewal"},{"kind":"memory","id":"o3"}]"#
        case .person:
            text = "Whose details go in?"
            options = #"[{"kind":"you","id":"o1"},{"kind":"person","id":"o2","name":"Gary Pruitt"}]"#
        }
        let line = #"{"type":"askQuestion","v":1,"requestId":"ask-7","at":1790000301200,"questionId":"ask-1-ask-7","part":"\#(part.rawValue)","text":"\#(text)","pick":"\#(part == .fields ? "many" : "one")","options":\#(options),"window":{"pid":4100,"windowId":"page:eng7:12","appName":"Google Chrome","title":"Rental application"},"expires":1790000901200}"#
        return try! JSONDecoder().decode(AskQuestion.self, from: Data(line.utf8))
    }

    static func h6(_ character: FigureCharacter = .pebble) -> [Item] {
        func list(_ text: String, _ phase: AskCaret.Phase) -> AnyView {
            let section = AskSection(text: text, phase: phase, character: character, showsFocus: true, animated: false)
            return AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(section), askActive: true, askHeader: phase.header { _ in false })
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        func permissions(routing: Bool) -> AnyView {
            AnyView(MemoryView(state: memoryState(), files: memoryFiles(), tab: .permissions, character: character, routing: routing, animated: false, now: memoryNow)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        let fields = AskCaret.Question(ask: askQuestion(part: .fields), highlight: 1, selected: ["o1", "o2"])
        let source = AskCaret.Question(ask: askQuestion(part: .source), highlight: 1)
        let fillAll = FillOverlay.offerContent(caption: "from Mail, Invoice 2041", sourceApp: "Mail", fillAll: true)
        return [
            Item(name: "memory-routing-on", view: permissions(routing: true)),
            Item(name: "memory-routing-off", view: permissions(routing: false)),
            Item(name: "ask-question-fields", view: list("do the landlord bit", .question(fields))),
            Item(name: "ask-question-source", view: list("do the landlord bit", .question(source))),
            Item(name: "line-fill-all", view: AnyView(LineView(content: fillAll, character: character, animated: false, figureGaze: FillOverlay.lookAtField))),
        ]
    }
}
