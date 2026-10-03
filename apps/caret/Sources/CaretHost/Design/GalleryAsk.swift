import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// Renders for brief A13: the ask field and its card in the activity list, the event card as the host
// draws the helper's offer, and the compact line an offer falls back to on a crowded form. Synthetic
// content only, the same as the helper's golden lines.
extension Gallery {
    static let askInstruction = "Put the order number in Reference and send it"

    /// The golden proposal's card (helper/fixtures/golden/protocol.ndjson, `plan-1-ask-1`).
    static let askCard = AskCaret.Card(
        title: "1 field in 'Caret Fixture — Executor'", app: "Caret Fixture",
        steps: [AskCaret.Step(text: AskCopy.write("ORD-2026-48213", into: "Reference")), AskCaret.Step(text: AskCopy.press("Send"), yours: true)],
        more: 0, action: "Fill 1 field", offerKey: "plan-1-ask-1", actionId: "run", writes: 1, press: "Send"
    )

    /// A three-write plan with a press, for the running card.
    static let askCardLonger: AskCaret.Card = {
        var card = askCard
        card.title = "2 fields in 'Caret Fixture — Executor'"
        card.steps = [
            AskCaret.Step(text: AskCopy.write("Dana Whitfield", into: "Name"), state: .done),
            AskCaret.Step(text: AskCopy.write("dana.whitfield@lumenlabs.example", into: "Email"), state: .running),
            AskCaret.Step(text: AskCopy.press("Send"), yours: true),
        ]
        card.action = "Fill 2 fields"
        card.writes = 2
        return card
    }()

    static func ask(_ character: FigureCharacter = .pebble) -> [Item] {
        func list(_ text: String, _ phase: AskCaret.Phase, rows: [ActivityRow] = [], focus: Bool = true) -> AnyView {
            let section = AskSection(text: text, phase: phase, character: character, showsFocus: focus, animated: false)
            return AnyView(ActivityListView(rows: rows, character: character, animated: false, now: listNow, ask: AnyView(section), askActive: phase != .idle)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        let untraced = AskCopy.planError(PlanProposal.Failure(code: .untracedValue, detail: "step 1 ('Reference holds ORD-2026-99999'): 'ORD-2026-99999' is not in any window, in memory or in your instruction"))
        var ended = askCard
        ended.steps[0].state = .done
        var stopped = askCardLonger
        stopped.steps[1].state = .pending
        return [
            Item(name: "ask-empty", view: list("", .idle, focus: false)),
            Item(name: "ask-empty-focused", view: list("", .idle)),
            Item(name: "ask-text", view: list(askInstruction, .idle)),
            Item(name: "ask-planning", view: list(askInstruction, .asking(requestId: "ask-1"))),
            Item(name: "ask-proposal-handoff", view: list(askInstruction, .proposed(askCard))),
            Item(name: "ask-proposal-in-list", view: list(askInstruction, .proposed(askCard), rows: Array(activityRows.prefix(3)))),
            Item(name: "ask-running", view: list("", .running(askCardLonger))),
            Item(name: "ask-ended-handoff", view: list("", .ended(ended, AskCopy.handoff(press: "Send", app: "Caret Fixture", filled: 1)))),
            Item(name: "ask-ended-stopped", view: list("", .ended(stopped, WorkLines.stoppedByYou(next: 1, of: 3)))),
            Item(name: "ask-failed-untraced", view: list("Put ORD-2026-99999 in Reference", .failed(untraced))),
        ]
    }

    /// The helper's event card (helper/src/offers/event-card.ts eventCardSpec): title, when, the
    /// calendar it would use, the sentence, and Tab Add.
    static let helperEventCard: PopupSpec = {
        let from = node("5150-1/k:message", "coffee with Dana on Thursday at 3")
        func derived(_ text: String, _ rule: String) -> PopupSpec.Value { PopupSpec.Value(text, ref: .derived(rule: rule, from: [from])) }
        return PopupSpec(id: "event-1", figure: .offering, blocks: [
            .init(.header(.init(title: derived("Coffee with Dana", "eventTitle")))),
            .init(.facts(.init(rows: [
                .init(label: "When", value: derived("Thu 3:00 to 3:30 PM", "eventTime")),
                .init(label: "Calendar", value: derived("Caret", "eventCalendar")),
            ]))),
            .init(.source(.init(PopupSpec.Value("I'll grab coffee with Dana on Thursday at 3.", ref: from)))),
            .init(.actions(.init(items: [.init(id: "add", label: "Add", key: .tab)]))),
        ])
    }()

    static func events(_ character: FigureCharacter = .pebble) -> [Item] {
        let card = EventCardCopy.card(helperEventCard)
        let line = LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thu 3:00 to 3:30 PM", hints: [Hint(key: "Tab")])
        return [
            Item(name: "event-line", view: AnyView(LineView(content: line, character: character, animated: false))),
            Item(name: "event-card", view: AnyView(PopupView(spec: card, character: character, animated: false))),
            Item(name: "event-blocked", view: AnyView(LineView(content: WorkLines.blocked(.tcc).content, character: character, animated: false))),
            Item(name: "compact-event-card", view: AnyView(LineView(content: CompactOffer.line(card, highlight: nil), character: character, compact: true, animated: false))),
            Item(name: "compact-action-line", view: AnyView(LineView(
                content: CompactOffer.line(ActionLine(offerKey: "event-1", app: "Calendar", endState: PopupSpec.Value("Coffee with Dana, Thu 3:00 to 3:30 PM", ref: .memory(id: "x")),
                                                      actions: [.init(id: "add", label: "Add", key: .tab)], variants: card)),
                character: character, compact: true, animated: false))),
        ]
    }
}

/// The compact fallback over the claim form with no room around the window, as on A12's 1440 by
/// 900 screen: the event card has no spot that covers nothing, so the compact line is placed by the
/// same rule and drawn where it covers no field or label. Off screen only.
struct CompactPlacementScene: View {
    var spec: PopupSpec
    var focusRow = 2
    var character: FigureCharacter = .pebble
    @Environment(\.colorScheme) private var scheme

    typealias Form = PanelPlacementScene

    private var obstacles: [CGRect] {
        (0..<Form.rows.count).filter { $0 != focusRow }.flatMap { [Form.field($0)] + (Form.label($0).map { [$0] } ?? []) }
            + (Form.label(focusRow).map { [$0] } ?? []) + [CGRect(x: 0, y: 0, width: Form.windowW, height: Form.titleBar)]
    }

    /// The screen is the window: nothing beside or under it.
    private var bounds: CGRect { CGRect(x: -8, y: -8, width: Form.windowW + 16, height: Form.windowH + 16) }
    private var caret: CGRect { let f = Form.field(focusRow); return CGRect(x: f.minX + 4, y: f.minY + 3, width: 1, height: 18) }

    var compactLine: LineContent { CompactOffer.line(spec, highlight: nil) }

    func choose<V: View>(_ view: V, narrow: CGSize? = nil) -> FieldPanelPlacement.Choice {
        let all = obstacles
        return FieldPanelPlacement.choose(
            field: Form.field(focusRow), caret: caret, size: NSHostingView(rootView: view).fittingSize, narrow: narrow, bounds: bounds,
            obstacles: { frame in all.filter { $0.intersects(frame) } }
        )
    }

    /// Where the full card would go: covering something, or nowhere on screen.
    var cardChoice: FieldPanelPlacement.Choice {
        choose(PopupView(spec: spec, character: character, animated: false),
               narrow: NSHostingView(rootView: PopupView(spec: spec, character: character, animated: false, width: PopupView.minWidth)).fittingSize)
    }

    var lineChoice: FieldPanelPlacement.Choice { choose(LineView(content: compactLine, character: character, compact: true, animated: false)) }

    var body: some View {
        let line = lineChoice
        let dark = scheme == .dark
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x323232 : 0xEEEFEE)))
                .frame(width: Form.windowW, height: Form.windowH)
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x3A3A3A : 0xE4E4E4)))
                .frame(width: Form.windowW, height: Form.titleBar)
            ForEach(Array(Form.rows.enumerated()), id: \.offset) { i, label in
                if !label.isEmpty {
                    Text(label + ":").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
                        .offset(x: 18, y: Form.field(i).minY + 3)
                }
                LayoutFixScene.FieldBox(text: "", ghost: false, focused: i == focusRow)
                    .frame(width: Form.fieldW, height: Form.fieldH)
                    .offset(x: Form.field(i).minX, y: Form.field(i).minY)
            }
            LineView(content: compactLine, character: character, compact: true, animated: false)
                .offset(x: line.frame.minX, y: line.frame.minY)
        }
        .frame(width: Form.windowW, height: Form.windowH, alignment: .topLeading)
        .background(Color(nsColor: Tokens.srgb(dark ? 0x1B1F2A : 0x9DB4CC)))
    }
}
