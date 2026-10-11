import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// H11's states: the page task panel from preview to its end (fast-browser.md "UI moments" 1 to 6), the desk's
// one line when the preview is at the form, the quiet offer to keep an answer, and a fill pop-up showing a
// saved answer whole. Synthetic content only, the same people and values as helper/fixtures/golden.
extension Gallery {
    static let h11App = AppRef(pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome")
    static let h11Expires: Int64 = 4_102_444_800_000

    /// A page segment's preview: rows by label and value, `picked` for a list's value; `tick` adds a box to tick.
    static func h11Preview(_ rows: [(String, String, Bool)], tick: String? = nil, press: String? = nil, warnings: [String] = [],
                           attach: [String] = [], reason: GoalProgress.Preview.Reason = .start, segment: Int = 0, first: Int = 0) -> GoalProgress.Preview {
        var steps: [GoalProgress.Step] = []
        var view: [GoalProgress.PageView.Row] = []
        for (i, r) in rows.enumerated() {
            steps.append(GoalProgress.Step(index: first + i, kind: .write, says: "\(r.0): \(r.1)"))
            view.append(.init(step: first + i, label: r.0, value: r.1, picked: r.2))
        }
        if let tick { steps.append(GoalProgress.Step(index: first + steps.count, kind: .write, says: "Tick '\(tick)'")) }
        if let press { steps.append(GoalProgress.Step(index: first + steps.count, kind: .handoff, says: "'\(press)' runs the page's own script; you press it")) }
        let page = GoalProgress.PageView(windowId: "page:eng1:7", app: h11App, anchor: nil, viewport: nil,
                                         from: "Notes, Robin's details and what you told Caret", rows: view, attach: attach)
        return GoalProgress.Preview(segment: segment, segments: segment + 1, reason: reason, replaces: reason == .start ? nil : "goal-1-a1",
                                    digest: String(repeating: "a", count: 64), expires: h11Expires, place: .window(app: "Google Chrome", title: "Apply: Northwind Robotics"),
                                    steps: steps, warnings: warnings, page: page)
    }

    static let h11Rows: [(String, String, Bool)] = [
        ("Full name", "Robin Vale", false), ("Email", "robin@example.test", false), ("Phone", "+1 512 555 0142", false),
        ("Country", "Canada", true), ("City", "Toronto", false), ("Start date", "2026-10-20", false),
        ("School", "University of Waterloo", true), ("Degree", "BMath, Computer Science", true),
    ]

    static let h11Withheld = ["'Why do you want to work here?' is yours to write: Caret doesn't write answers."]

    static func h11Task() -> PageTask {
        PageTask(preview: h11Preview(h11Rows, tick: "Do you need visa sponsorship?", warnings: h11Withheld, attach: ["Resume/CV"]), goalId: "goal-1-a1")!
    }

    static func h11Receipt(_ goal: String, _ step: Int, _ phase: GoalProgress.Receipt.Phase = .verified) -> GoalProgress {
        GoalProgress(at: 1, goalId: goal, requestId: nil, event: .step(.init(segment: 0, taskId: "\(goal):s0", step: step, steps: 9, phase: phase, says: "")))
    }

    static func h11Finished(_ goal: String, _ outcome: GoalProgress.End.Outcome, _ says: String, left: [String] = []) -> GoalProgress {
        GoalProgress(at: 1, goalId: goal, requestId: nil, event: .finished(.init(outcome: outcome, verified: 9, skipped: 0, left: left, says: says)))
    }

    /// The panel's states, each from a PageTask driven as the machine drives it.
    static func h11Panels() -> [(String, PageTaskPanel)] {
        var preview = h11Task()
        let previewPanel = PageTaskPanel(task: preview, stoppable: false)

        var progress = preview
        _ = progress.tab(nowMs: 1)
        for i in 0..<4 { _ = progress.receive(h11Receipt("goal-1-a1", i)) }
        _ = progress.receive(h11Receipt("goal-1-a1", 4, .skipped))
        let progressPanel = PageTaskPanel(task: progress, stoppable: false)

        var reveal = progress
        for i in 5..<9 { _ = reveal.receive(h11Receipt("goal-1-a1", i)) }
        _ = reveal.receive(h11Finished("goal-1-a1", .partial, "Partly done: 9 fields verified. Left for you: 'Why do you want to work here?'.", left: ["'Why do you want to work here?'"]))
        let more = h11Preview([("Province", "Ontario", true), ("Postal code", "M5V 2T6", false)], reason: .afterReveal, first: 0)
        _ = reveal.receive(GoalProgress(at: 1, goalId: "goal-1-a1~1", requestId: nil, event: .segment(more)))
        let revealPanel = PageTaskPanel(task: reveal, stoppable: false)

        var handoff = PageTask(preview: h11Preview(Array(h11Rows.prefix(4)), press: "Next", attach: ["Resume/CV"]), goalId: "goal-1-a1")!
        _ = handoff.tab(nowMs: 1)
        for i in 0..<4 { _ = handoff.receive(h11Receipt("goal-1-a1", i)) }
        _ = handoff.receive(h11Finished("goal-1-a1", .handoff, "Ready: 4 done. 'Next' runs the page's own script; you press it."))
        let handoffPanel = PageTaskPanel(task: handoff, stoppable: false)

        var next = handoff
        let page2 = h11Preview([("Employer", "Northwind Robotics", false), ("Title", "Software Engineer", false), ("From", "2023-06", false),
                                ("To", "2026-08", false), ("Work type", "Full time", true)], reason: .nextPage, segment: 0)
        _ = next.receive(GoalProgress(at: 1, goalId: "goal-2-a1", requestId: nil, event: .segment(page2)))
        let nextPanel = PageTaskPanel(task: next, stoppable: false)

        var done = PageTask(preview: h11Preview(Array(h11Rows.prefix(6))), goalId: "goal-1-a1")!
        _ = done.tab(nowMs: 1)
        for i in 0..<6 { _ = done.receive(h11Receipt("goal-1-a1", i)) }
        _ = done.receive(h11Finished("goal-1-a1", .done, "Done: 6 fields verified."))
        let donePanel = PageTaskPanel(task: done, stoppable: false)

        let partialPanel: PageTaskPanel = {
            var t = reveal
            _ = t.tab(nowMs: 1)
            _ = t.receive(h11Receipt("goal-1-a1~1", 0))
            _ = t.receive(h11Receipt("goal-1-a1~1", 1))
            _ = t.receive(h11Finished("goal-1-a1~1", .partial, "Partly done: 11 fields verified. Left for you: 'Why do you want to work here?'.", left: ["'Why do you want to work here?'"]))
            return PageTaskPanel(task: t, stoppable: false)
        }()

        var stopped = h11Task()
        _ = stopped.tab(nowMs: 1)
        for i in 0..<3 { _ = stopped.receive(h11Receipt("goal-1-a1", i)) }
        _ = stopped.receive(GoalProgress(at: 1, goalId: "goal-1-a1", requestId: nil, event: .stopped(.init(
            segment: 0, step: 3, reason: .targetChanged, says: "'Country' changed while Caret was filling it, so Caret stopped after 3 of 9 steps.", freshPlan: nil))))
        let stoppedPanel = PageTaskPanel(task: stopped, stoppable: false)

        var stoppable = progress
        stoppable.stage = .running
        let stoppablePanel = PageTaskPanel(task: stoppable, stoppable: true)
        _ = preview

        return [
            ("page-task-preview", previewPanel), ("page-task-progress", progressPanel), ("page-task-progress-stoppable", stoppablePanel),
            ("page-task-reveal", revealPanel), ("page-task-handoff", handoffPanel), ("page-task-next-page", nextPanel),
            ("page-task-done", donePanel), ("page-task-partial", partialPanel), ("page-task-stopped", stoppedPanel),
        ]
    }

    static let h11SaveOffer = LineContent(figure: .offering, text: "Save this answer for next time?", emphasis: .plain, hints: [Hint(key: "⌘1", label: "Save"), Hint(key: "Esc")])

    /// helper/fixtures/golden/answers.ndjson's pop-up: a saved answer, both paragraphs, in the fill preview.
    static let h11SavedAnswerPopup: PopupSpec = {
        func node(_ key: String, _ quote: String? = nil) -> PopupSpec.Ref { .node(key: key, quote: quote) }
        let answer = "The project I'm proudest of is a billing migration I led two years ago. Our invoices were built by a nightly job that had grown to four hours. I split it into small steps, ran the old and new paths side by side for a month, and moved customers over in batches.\n\nThe job now takes eleven minutes."
        return PopupSpec(id: "fill-answers-1", figure: .offering, blocks: [
            .init(.header(.init(title: PopupSpec.Value("Fill 2 fields", ref: .derived(rule: "count", from: [node("page-eng1-7/form/textbox:full name~0")]))))),
            .init(.source(.init(PopupSpec.Value("Notes, Me and your saved answer", ref: .derived(rule: "sources", from: [node("3001-1/standard/textarea:note~0"), .memory(id: "answer-1a2b3c4d")]))))),
            .init(.fields(.init(rows: [
                .init(destination: PopupSpec.Value("Full name", ref: .derived(rule: "fieldLabel", from: [node("page-eng1-7/form/textbox:full name~0")])),
                      value: PopupSpec.Value("Alex Rivera", ref: node("3001-1/standard/textarea:note~0", "Alex Rivera")), state: .ready),
                .init(destination: PopupSpec.Value("Please elaborate on a project you're proud of", ref: .derived(rule: "fieldLabel", from: [node("page-eng1-7/form/textbox:project~0")])),
                      value: PopupSpec.Value(answer, ref: .derived(rule: SavedAnswers.rowRule, from: [.memory(id: "answer-1a2b3c4d")])), state: .ready),
            ]))),
            .init(.actions(.init(items: [.init(id: "fillAll", label: "Fill all", key: .tab)]))),
        ])
    }()

    static func h11(_ character: FigureCharacter = .pebble) -> [Item] {
        let panels = h11Panels().map { name, panel in Item(name: name, view: AnyView(PageTaskView(panel: panel, character: character, animated: false))) }
        let desk = AskSection(text: "fill out this form from my note", phase: .atForm, character: character, showsFocus: false, animated: false)
        return panels + [
            Item(name: "desk-preview-at-form", view: AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(desk), askActive: true, askHeader: AskCaret.Phase.atForm.header { _ in false })
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))),
            Item(name: "answer-save-offer", view: AnyView(LineView(content: h11SaveOffer, character: character, animated: false))),
            Item(name: "fill-preview-saved-answer", view: AnyView(PopupView(spec: h11SavedAnswerPopup, character: character, animated: false))),
        ]
    }
}
