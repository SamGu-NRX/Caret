import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// H5's new states: a control Caret never writes, in the fill preview and on the desk's card; the
// helper's own sentence when an Ask refuses or asks; "Caret can't see this page yet"; and the Sites
// tab of What Caret knows. Synthetic content only, the same as helper/fixtures/golden/host.ndjson.
extension Gallery {
    /// The fill preview with a control the user sets under the two fields Tab fills.
    static let fillPreviewHandoff: PopupSpec = {
        func node(_ key: String, _ quote: String? = nil) -> PopupSpec.Ref { .node(key: key, quote: quote) }
        func dest(_ text: String) -> PopupSpec.Value { PopupSpec.Value(text, ref: .derived(rule: "fieldLabel", from: [node("page:e1:7/f0/\(text.lowercased())")])) }
        return PopupSpec(id: "fill-9", figure: .offering, blocks: [
            .init(.header(.init(title: PopupSpec.Value("Fill 2 fields", ref: .derived(rule: "count", from: [node("page:e1:7/f0")]))))),
            .init(.source(.init(PopupSpec.Value("Notes, Pizza night", ref: node("7200-1/notes/body"))))),
            .init(.fields(.init(rows: [
                .init(destination: dest("Name"), value: PopupSpec.Value("Dana Whitfield", ref: node("7200-1/notes/body", "Dana Whitfield")), state: .ready),
                .init(destination: dest("Phone"), value: PopupSpec.Value("+1 512 555 0142", ref: node("7200-1/notes/body", "+1 512 555 0142")), state: .ready),
            ]))),
            .init(.fields(.init(rows: [
                .init(destination: dest("Pizza size"), value: PopupSpec.Value("Large", ref: .derived(rule: "handoffValue", from: [node("7200-1/notes/body")])), state: .yours),
            ]))),
            .init(.actions(.init(items: [.init(id: "fillAll", label: "Fill all", key: .tab)]))),
        ])
    }()

    /// helper/fixtures/golden/host.ndjson's `plan-7-ask-7`: an Ask whose results are only controls.
    static let askCardControls = AskCaret.Card(
        title: AskCopy.title(fields: [], writes: 0, press: nil, app: "Google Chrome", toSet: ["Pizza size", "Crust"]), app: "Google Chrome",
        steps: [
            AskCaret.Step(text: AskCopy.set("Large", in: "Pizza size"), yours: true, field: "Pizza size"),
            AskCaret.Step(text: AskCopy.set("Thin", in: "Crust"), yours: true, field: "Crust"),
        ],
        more: 0, action: "Got it", offerKey: "plan-7-ask-7", actionId: "run", writes: 0, press: nil
    )

    /// An Ask that fills one field and leaves one control to the user.
    static let askCardFillAndSet = AskCaret.Card(
        title: AskCopy.title(fields: ["Name"], writes: 1, press: nil, app: "Google Chrome", toSet: ["Pizza size"]), app: "Google Chrome",
        steps: [
            AskCaret.Step(text: AskCopy.write("Dana Whitfield", into: "Name"), field: "Name"),
            AskCaret.Step(text: AskCopy.set("Large", in: "Pizza size"), yours: true, field: "Pizza size"),
        ],
        more: 0, action: "Fill 1 field", offerKey: "plan-8-ask-8", actionId: "run", writes: 1, press: nil
    )

    static let sitesState = SitesPage.State(off: ["http://127.0.0.1:4310", "https://careers.example.org"], here: "https://jobs.example.com")

    static func h5(_ character: FigureCharacter = .pebble) -> [Item] {
        func list(_ text: String, _ phase: AskCaret.Phase) -> AnyView {
            let section = AskSection(text: text, phase: phase, character: character, showsFocus: false, animated: false)
            return AnyView(ActivityListView(rows: [], character: character, animated: false, now: listNow, ask: AnyView(section), askActive: true, askHeader: phase.header { _ in false })
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        func sites(_ state: SitesPage.State) -> AnyView {
            AnyView(MemoryView(state: memoryState(), files: memoryFiles(), tab: .sites, character: character, sites: state, animated: false, now: memoryNow)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        let question = AskCopy.planError(PlanProposal.Failure(code: .unsure, detail: "\"8:15\" for Delivery time reads more than one way", says: "Is \"8:15\" in the morning or the evening? Say it with am or pm."))
        let refusal = AskCopy.planError(PlanProposal.Failure(code: .unsupportedStep, detail: "the plan only hands the user the press 'Submit order' (outbound)", says: "Submitting is yours to do."))
        return [
            Item(name: "fill-preview-handoff", view: AnyView(PopupView(spec: fillPreviewHandoff, character: character, animated: false))),
            Item(name: "ask-proposal-controls", view: list("set the pizza to large with thin crust", .proposed(askCardControls))),
            Item(name: "ask-proposal-fill-and-set", view: list("my name, and a large pizza", .proposed(askCardFillAndSet))),
            Item(name: "ask-failed-question", view: list("make the delivery 8:15", .failed(question))),
            Item(name: "ask-failed-refusal", view: list("hit submit", .failed(refusal))),
            Item(name: "page-sight-line", view: AnyView(PageSightView(character: character, animated: false))),
            Item(name: "memory-sites", view: sites(sitesState)),
            Item(name: "memory-sites-empty", view: sites(SitesPage.State(here: "https://jobs.example.com"))),
            Item(name: "memory-sites-problem", view: sites(SitesPage.State(off: ["https://careers.example.org"], draft: "pizza night", problem: SitesPage.notAnAddress))),
        ]
    }
}
