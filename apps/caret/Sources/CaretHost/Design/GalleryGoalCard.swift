import CaretHostCore
import Foundation
import SwiftUI

// Renders of slice 1 on the desk: the task question, and a goal card through its preview, edit, run and end. Synthetic
// content only, from the helper's golden lines (ask-task.ndjson).
extension Gallery {
    static let goalInstruction = "answer dana, thursday at 3 works"

    /// ask-task.ndjson's task question, decoded through the same checks a helper's pass.
    static func askTaskQuestion() -> AskQuestion {
        let line = #"{"type":"askQuestion","v":1,"requestId":"ask-31","at":1790400000900,"questionId":"ask-9-ask-31","part":"task","text":"Which should Caret do?","pick":"one","options":[{"kind":"task","id":"o1","label":"Fill To and Message","says":"Fills them in and stops there. Pressing and sending stay yours."},{"kind":"task","id":"o2","label":"Do the whole task","says":"Shows every step before anything runs. Sending stays yours."}],"window":{"pid":4210,"windowId":"4210-3","appName":"Mail","title":"Re: Planning review"},"expires":1790400600900}"#
        return try! JSONDecoder().decode(AskQuestion.self, from: Data(line.utf8))
    }

    /// ask-task.ndjson's segments: the reply in Mail (`calendar` false), or the calendar part after it.
    static func goalPreview(calendar: Bool = false) -> GoalProgress {
        let line = calendar
            ? #"{"type":"goalProgress","v":1,"at":1790400014800,"goalId":"goal-4-ask-32","requestId":null,"event":"segment","segment":1,"segments":2,"reason":"crossWindow","replaces":null,"digest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expires":1790400134800,"where":{"kind":"calendar","calendar":"Caret"},"steps":[{"index":3,"kind":"calendar","says":"Add 'Planning review' to your Caret calendar, Thursday, October 15, 3:00 to 4:00 PM","tier":"write"}],"warnings":["Dana's email says 3:00 but not how long; Caret made it an hour."]}"#
            : #"{"type":"goalProgress","v":1,"at":1790400005200,"goalId":"goal-4-ask-32","requestId":"ask-32","event":"segment","segment":0,"segments":2,"reason":"start","replaces":null,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expires":1790400125200,"where":{"kind":"window","app":"Mail","title":"Re: Planning review"},"steps":[{"index":0,"kind":"write","says":"To: dana.whitfield@example.com","tier":"write"},{"index":1,"kind":"write","says":"Message: Thursday at 3 works for me. See you then.","drafted":"Thursday at 3 works for me. See you then.","tier":"write"},{"index":2,"kind":"handoff","says":"'Send' reads as outbound; you press it","tier":"yours"}],"warnings":[]}"#
        return try! JSONDecoder().decode(GoalProgress.self, from: Data(line.utf8))
    }

    static func goalCard(calendar: Bool = false) -> GoalCard {
        guard case .segment(let p) = goalPreview(calendar: calendar).event else { fatalError("the golden line is a segment") }
        return GoalCard(preview: p, goalId: "goal-4-ask-32", instruction: goalInstruction)!
    }

    static func goalCards(_ character: FigureCharacter = .pebble) -> [Item] {
        func desk(_ phase: AskCaret.Phase, text: String = goalInstruction) -> AnyView {
            let section = AskSection(text: text, phase: phase, character: character, showsFocus: true, animated: false)
            return AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(section), askActive: true, askHeader: phase.header { _ in false })
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        var editing = goalCard()
        _ = editing.startEdit()
        editing.editText("Thursday at 3 works. I'll bring the Q3 numbers.")
        var running = goalCard()
        _ = running.accept(nowMs: 1_790_400_006_000)
        _ = running.receive(GoalProgress(at: 1_790_400_007_000, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-4-ask-32:s0", step: 0, steps: 2, phase: .verified, says: "To holds dana.whitfield@example.com"))))
        var ended = running
        _ = ended.receive(GoalProgress(at: 1_790_400_008_000, goalId: "goal-4-ask-32", requestId: nil, event: .step(.init(segment: 0, taskId: "goal-4-ask-32:s0", step: 1, steps: 2, phase: .verified, says: "Message holds the reply"))))
        _ = ended.receive(GoalProgress(at: 1_790_400_008_500, goalId: "goal-4-ask-32", requestId: nil, event: .finished(.init(outcome: .handoff, verified: 2, skipped: 0, left: ["You press Send"], says: "Done. Send is yours."))))
        return [
            Item(name: "ask-question-task", view: desk(.question(AskCaret.Question(ask: askTaskQuestion())))),
            Item(name: "goal-card-preview", view: desk(.goal(goalCard()))),
            Item(name: "goal-card-editing", view: desk(.goal(editing))),
            Item(name: "goal-card-running", view: desk(.goal(running), text: "")),
            Item(name: "goal-card-ended", view: desk(.goal(ended), text: "")),
            Item(name: "goal-card-calendar", view: desk(.goal(goalCard(calendar: true)), text: "")),
        ]
    }
}
