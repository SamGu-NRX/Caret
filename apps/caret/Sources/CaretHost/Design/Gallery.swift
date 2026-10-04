import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// Off-screen renders of every surface, from synthetic content: the reference images the snapshot
/// tests compare against, and the evidence the lead reviews. Nothing here reads the screen.
@MainActor
enum Gallery {
    struct Item {
        let name: String
        let view: AnyView
    }

    /// The canvas behind a render, so the panel's shadow and edge read as they do over a window.
    static func canvas(dark: Bool) -> Color {
        Color(nsColor: Tokens.srgb(dark ? 0x1E1E20 : 0xECECEE))
    }

    /// Renders `view` at 2x in one appearance. The tokens are dynamic `NSColor`s, so the drawing
    /// appearance is set as well as SwiftUI's color scheme.
    /// `canvasHex` replaces the canvas, for a render over a host's own document.
    static func png<V: View>(_ view: V, dark: Bool, padding: CGFloat = 24, canvasHex: UInt32? = nil) -> Data? {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
        var data: Data?
        appearance.performAsCurrentDrawingAppearance {
            let content = view
                .environment(\.drawsOwnSurface, true)
                .environment(\.rendersOffscreen, true)
                .environment(\.colorScheme, dark ? .dark : .light)
                .padding(padding)
                .background(canvasHex.map { Color(nsColor: Tokens.srgb($0)) } ?? canvas(dark: dark))
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            guard let cg = renderer.cgImage else { return }
            data = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])
        }
        return data
    }

    // MARK: - Synthetic specs

    /// The three pop-ups of the Fable plan, section 2, from the same synthetic content as the
    /// golden fixture (`Tests/CaretHostCoreTests/Fixtures/popup-specs.json`).
    nonisolated static func node(_ key: String, _ quote: String? = nil) -> PopupSpec.Ref { .node(key: key, quote: quote) }

    static let eventCard: PopupSpec = {
        let sentence = node("4242-1/compose/body", "Thursday at 3")
        func time(_ text: String, _ rule: String) -> PopupSpec.Value { PopupSpec.Value(text, ref: .derived(rule: rule, from: [sentence])) }
        let times = PopupSpec.Block(id: "time", .choices(PopupSpec.Choices(rows: [
            .init(label: time("2:30 to 3:00 pm", "shift-30m")),
            .init(label: time("3:00 to 3:30 pm", "parseTime+30m")),
            .init(label: time("3:30 to 4:00 pm", "shift+30m")),
        ], selected: 1)))
        return PopupSpec(id: "popup-event-1", figure: .offering, blocks: [
            .init(.header(.init(title: PopupSpec.Value("Coffee with Dana", ref: .derived(rule: "eventTitle", from: [node("4242-1/compose/body", "grab coffee with Dana")]))))),
            .init(id: "when", .facts(.init(rows: [
                .init(value: time("Thursday Oct 9, 3:00 to 3:30 pm", "parseTime+30m")),
                .init(value: PopupSpec.Value("Personal", ref: .memory(id: "calendar-default")), secondary: true),
            ]))),
            .init(.source(.init(PopupSpec.Value("your message to Dana", ref: node("4242-1/compose"))))),
            .init(.actions(.init(items: [
                .init(id: "add", label: "Add", key: .tab),
                .init(id: "changeTime", label: "Change time", key: .cmd2, reveal: .init(replace: "when", with: times)),
            ]))),
        ])
    }()

    static let fillPreview: PopupSpec = {
        func dest(_ text: String) -> PopupSpec.Value { PopupSpec.Value(text, ref: node("5151-2/form/\(text.lowercased())/label")) }
        func val(_ text: String, _ key: String = "6060-1/message/body") -> PopupSpec.Value { PopupSpec.Value(text, ref: node(key, text)) }
        return PopupSpec(id: "popup-fill-1", figure: .offering, blocks: [
            .init(.header(.init(title: PopupSpec.Value("Fill 4 fields", ref: .derived(rule: "count", from: [node("5151-2/form")]))))),
            .init(.source(.init(PopupSpec.Value("Mail, Invoice 2041", ref: node("6060-1/message"))))),
            .init(.fields(.init(rows: [
                .init(destination: dest("Name"), value: val("Dana Reyes"), state: .ready),
                .init(destination: dest("Email"), value: val("dana@northline.example", "6060-1/message/from"), state: .ready),
                .init(destination: dest("Company"), value: val("Northline"), state: .unsure),
                .init(destination: dest("Amount"), value: val("$1,240.00"), state: .ready),
            ]))),
            .init(.actions(.init(items: [
                .init(id: "fillAll", label: "Fill all", key: .tab),
                .init(id: "reviewOne", label: "Review one by one", key: .down),
            ]))),
        ])
    }()

    static let picker: PopupSpec = {
        func person(_ name: String, _ hint: String, _ id: String) -> PopupSpec.Choices.Row {
            .init(label: PopupSpec.Value(name, ref: .memory(id: id)), hint: PopupSpec.Value(hint, ref: .memory(id: id)))
        }
        return PopupSpec(id: "popup-which-1", figure: .needsYou, blocks: [
            .init(.header(.init(title: PopupSpec.Value("Which Dana?", ref: .derived(rule: "ambiguousName", from: [node("4242-1/compose/body", "Dana")]))))),
            .init(.choices(.init(rows: [
                person("Dana Reyes", "Northline", "person-reyes"),
                person("Dana Kim", "climbing", "person-kim"),
                person("Dana Okafor", "dentist", "person-okafor"),
            ], selected: 0))),
            .init(.actions(.init(items: [.init(id: "choose", label: "Choose", key: .tab)]))),
        ])
    }()

    static let alternatives = [
        "before lunch and ask Dana for the slides",
        "after the call and loop Dana in",
        "tonight, with the slides attached",
        "once Dana confirms the room",
    ]

    // MARK: - What gets rendered

    /// Each pop-up, as the user first sees it, plus the event card after Command-2.
    static func specs(_ character: FigureCharacter = .pebble) -> [Item] {
        let revealed = eventCard.applyingReveal(of: "changeTime")
        return [
            Item(name: "popup-event-card", view: AnyView(PopupView(spec: eventCard, character: character, animated: false))),
            Item(name: "popup-event-card-change-time", view: AnyView(PopupView(spec: revealed, highlight: 1, character: character, animated: false))),
            Item(name: "popup-fill-preview", view: AnyView(PopupView(spec: fillPreview, character: character, animated: false))),
            Item(name: "popup-picker", view: AnyView(PopupView(spec: picker, highlight: 0, character: character, animated: false))),
        ]
    }

    /// Every state of the slip (DIRECTION.md section 5.3) and the fill slip (5.5), as the machine
    /// builds them.
    static func lines(_ character: FigureCharacter = .pebble) -> [Item] {
        func line(_ name: String, _ content: LineContent, compact: Bool = false, gaze: CGVector? = nil) -> Item {
            Item(name: name, view: AnyView(LineView(content: content, character: character, compact: compact, animated: false, figureGaze: gaze)))
        }
        let fillSource = FillOverlay.offerContent(caption: "from Mail, Invoice 2041", sourceApp: "Mail")
        let fillMemory = FillOverlay.offerContent(caption: FillOrigin.memoryCaption, sourceApp: nil)
        return [
            line("line-action", LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thursday 3:00 to 3:30", hints: [Hint(key: "Tab")])),
            // Working: the figure gone, its seat kept; the bar at step 1 of 3; then at 4 s the
            // seconds and Esc Stop; work with no step count holds the bar at 8 percent.
            line("line-working", WorkLines.working(app: "Calendar", fillRows: nil, seconds: 1, figureLeft: true, done: 1, steps: 3).content),
            line("line-working-stoppable", WorkLines.working(app: "Calendar", fillRows: nil, seconds: 4, figureLeft: true, done: 2, steps: 3).content),
            line("line-working-unstepped", WorkLines.working(app: "Calendar", fillRows: nil, seconds: 6, figureLeft: true).content),
            // A17: Esc sent, the helper has not confirmed the stop.
            line("line-stopping", WorkLines.stopping.content),
            line("line-done", WorkLines.done(app: "Calendar", undo: true).content),
            line("line-undone", WorkLines.undone(nil).content),
            line("line-error", WorkLines.stopped(app: "Calendar", reason: .mismatch, next: 0, steps: 1, fillFilled: nil).content),
            // The stopped line names the helper's reason: Esc mid-run, a window that closed, and a
            // fill cut short by a change.
            line("line-stopped-you", WorkLines.stoppedByYou(next: 1, of: 3).content),
            line("line-stopped-window-gone", WorkLines.stopped(app: "TextEdit", reason: .windowGone, next: 0, steps: 1, fillFilled: nil).content),
            line("line-stopped-fill-changed", WorkLines.stopped(app: "Safari", reason: .changed, next: 2, steps: 3, fillFilled: 2).content),
            line("line-fill-source", fillSource, gaze: FillOverlay.lookAtField),
            line("line-fill-source-compact", fillSource, compact: true, gaze: FillOverlay.lookAtField),
            line("line-fill-toast", WorkLines.filled(1, from: "Mail").content),
            // A value from what the user told Caret (A14): the same slip, naming no window.
            line("line-fill-memory", fillMemory, gaze: FillOverlay.lookAtField),
            line("line-fill-memory-toast", LineContent(figure: .done, lead: "Filled", text: "1 field \(FillOrigin.memoryCaption)", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")])),
            Item(name: "alternatives-collapsed-quoted", view: AnyView(AlternativesScene(character: character, collapsed: true))),
            Item(name: "alternatives-open", view: AnyView(AlternativesScene(character: character))),
            // H2's fallback, after the second ↓: the list under the line.
            Item(name: "alternatives-list", view: AnyView(AlternativesScene(character: character, current: 2, list: true))),
        ]
    }
}

// MARK: - Onboarding

extension Gallery {
    /// A clock that never fires: a render is one moment of the flow.
    final class StillClock: SurfaceClock {
        final class Never: SurfaceTimer { func cancel() {} }
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        func schedule(after seconds: TimeInterval, repeats: Bool, _ fire: @escaping () -> Void) -> SurfaceTimer { Never() }
    }

    /// The first look's found offer: the fill preview, from a synthetic Safari form.
    static let firstLookFound = FirstLookReply.Found(
        kind: .fill, family: "fill", offerKey: "first-look-1.0",
        window: .init(pid: 5151, windowId: "5151-2", appName: "Safari", title: "Payment"), spec: fillPreview,
        sourceApps: ["Mail"]
    )

    /// The first look's run, as the helper reports it.
    static func firstLookProgress(_ phase: TaskProgress.Phase, written: Int? = nil) -> TaskProgress {
        let counts = written.map { #","written":\#($0)"# } ?? ""
        let why = phase == .stopped ? #","stopReason":"changed""# : ""
        let line = #"{"type":"taskProgress","v":1,"at":1790000001000,"taskId":"first-look-1.0","planId":"first-look-1.0","phase":"\#(phase.rawValue)","step":null,"steps":4,"says":null,"detail":null\#(counts)\#(why)}"#
        // A fixed literal of the protocol's own shape; it cannot fail to decode.
        return try! JSONDecoder().decode(TaskProgress.self, from: Data(line.utf8))
    }

    /// Every onboarding screen, and each state of the ones that change, reached by sending the
    /// flow the events the window would.
    static func onboarding(_ character: FigureCharacter = .pebble) -> [Item] {
        // Today's helper keeps no typed values, so the flow skips the know step and shows five
        // dots; the know screens are drawn as a helper that keeps them would show them.
        func flow(ax: Bool = true, input: Bool = true, know: Bool = false, _ events: [OnboardingFlow.Event]) -> OnboardingFlow.State {
            let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: ax, inputMonitoring: input), clock: StillClock(), showsKnow: know)
            for event in events { flow.send(event) }
            return flow.state
        }
        let toTryIt: [OnboardingFlow.Event] = [.next, .next, .next]
        let toFirstLook = toTryIt + [.key(.tab), .next]
        // The flow's first request, with its default token.
        let found = FirstLookReply(requestId: "first-look-1-1", at: 0, outcome: .found, found: firstLookFound)
        let nothing = FirstLookReply(requestId: "first-look-1-1", at: 0, outcome: .nothing)
        let screens: [(String, OnboardingFlow.State)] = [
            ("welcome", flow([])),
            // The screen as it opens: every role on, watch included, and Balanced.
            ("work", flow([.next])),
            // What Caret knows so far: as it opens, typed in, and an email Continue would not keep.
            ("know", flow(know: true, [.next, .next])),
            ("know-typed", flow(know: true, [.next, .next, .setAbout(.name, "Dana Whitfield"), .setAbout(.email, "dana.whitfield@example.com")])),
            ("know-problem", flow(know: true, [.next, .next, .setAbout(.name, "Dana Whitfield"), .setAbout(.email, "dana.whitfield@example"), .next])),
            ("permissions-waiting", flow(ax: false, input: false, [.next, .next])),
            ("permissions-on", flow(ax: false, input: false, [.next, .next, .permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true))])),
            ("try-it", flow(toTryIt)),
            ("try-it-declined", flow(toTryIt + [.key(.character("9"))])),
            ("try-it-filled", flow(toTryIt + [.key(.tab)])),
            // Another app that also takes Tab is running (Cotypist on Sam's Mac, Q1).
            ("try-it-tab-owner", flow(toTryIt + [.otherTabOwners(["Cotypist"])])),
            ("first-look-asking", flow(toFirstLook)),
            ("first-look-found", flow(toFirstLook + [.firstLookReply(found)])),
            // Tab taken: the line under the card at four seconds, the figure gone, Esc offered.
            ("first-look-working", {
                var state = flow(toFirstLook + [.firstLookReply(found), .key(.tab)])
                state.firstLookRun?.seconds = 4
                state.firstLookRun?.figureLeft = true
                return state
            }()),
            ("first-look-done", flow(toFirstLook + [.firstLookReply(found), .key(.tab), .taskProgress(firstLookProgress(.done, written: 4))])),
            ("first-look-nothing", flow(toFirstLook + [.firstLookReply(nothing)])),
            ("first-look-error", flow(toFirstLook + [.firstLookUnsent])),
        ]
        return screens.map { name, state in
            Item(name: "onboarding-\(name)", view: AnyView(OnboardingView(state: state, character: character, animated: false)))
        }
    }
}

/// Alternatives at a caret, drawn over a sample sentence with the host's own geometry
/// (`AlternativesLayout`): the ghost text, the underline under it while collapsed and quoted, and
/// once ↓ moved, the figure and ticks after it. With `list`, H2's fallback list below.
struct AlternativesScene: View {
    var character: FigureCharacter
    var current = 1
    /// Collapsed: the faint value alone, underlined because it is quoted from a source.
    var collapsed = false
    var list = false
    /// The field's width; a narrow one shows that the tag is dropped rather than wrapped.
    var fieldWidth: CGFloat = 640
    var candidates = Gallery.alternatives

    static let font = NSFont.systemFont(ofSize: 13)
    static let lead = "The meeting moved to Thursday, so I'll send the notes "

    var body: some View {
        let font = Self.font
        let leadWidth = ceil((Self.lead as NSString).size(withAttributes: [.font: font]).width)
        let shown = candidates[collapsed ? 0 : current]
        let width = ceil((shown as NSString).size(withAttributes: [.font: font]).width)
        let lineHeight = ceil(font.ascender - font.descender + font.leading)
        let field = CGRect(x: 0, y: 0, width: fieldWidth, height: 24)
        let caret = CGRect(x: 4 + leadWidth, y: (field.height - lineHeight) / 2, width: 1, height: lineHeight)
        let figure = Tokens.FigureSize.inText(caretHeight: caret.height)
        let tag = AlternativesTag(current: current, count: candidates.count, character: character, figureSize: figure, animated: false)
        let layout = AlternativesLayout(
            caret: caret, field: field, textWidth: width, fontSize: font.pointSize,
            tagWidth: NSHostingView(rootView: tag).fittingSize.width, open: !collapsed
        )
        return VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                Rectangle().fill(Color(nsColor: .textBackgroundColor))
                    .overlay(Rectangle().strokeBorder(Color(token: Tokens.rule), lineWidth: 1))
                    .frame(width: field.width, height: field.height)
                (Text(Self.lead).foregroundColor(Color(nsColor: .textColor))
                    + Text(shown).foregroundColor(Color(nsColor: .textColor).opacity(0.45)))
                    .font(Font(font))
                    .lineLimit(1)
                    .fixedSize()
                    .offset(x: 4, y: caret.minY)
                Rectangle().fill(Color(nsColor: .textColor)).frame(width: 1, height: caret.height).offset(x: caret.minX, y: caret.minY)
                // The decor, as the host draws it from the caret's top right.
                HStack(alignment: .bottom, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        Spacer(minLength: 0)
                        if collapsed { UnevenUnderline(width: layout.underlineWidth, animated: false) }
                    }
                    .frame(width: layout.textSpan, height: layout.decorHeight, alignment: .leading)
                    if layout.showsTag { tag.padding(.leading, layout.tagGap).padding(.bottom, layout.tagBottom) }
                }
                .fixedSize()
                .offset(x: caret.maxX, y: caret.minY)
            }
            .frame(width: field.width, height: field.height, alignment: .topLeading)
            .clipped()
            if list {
                AlternativesListView(candidates: candidates, current: current, font: font)
                    .padding(.leading, caret.maxX - FieldPanelPlacement.caretInset)
            }
        }
        .fixedSize()
    }
}

/// Every state of the figure at its four sizes (14 in a slip, 16 in a pop-up, 22 perched, 64
/// once in onboarding), and the other two characters at slip size. The grid sizes its window to
/// its rows: the prototype's window was shorter than its content (LEAD-REVIEW defect 1).
struct FigureGalleryView: View {
    static let sizes: [CGFloat] = [Tokens.FigureSize.line, Tokens.FigureSize.popup, Tokens.FigureSize.perch, Tokens.FigureSize.onboarding]

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 12) {
            GridRow {
                Text("")
                ForEach(Self.sizes, id: \.self) { Text("\(Int($0)) pt").font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2)) }
                Text("Seed, wren").font(Tokens.Font.chromeSmall).foregroundStyle(Color(token: Tokens.ink2))
            }
            ForEach(FigureState.allCases, id: \.self) { state in
                GridRow {
                    Text(Self.label(state)).font(Tokens.Font.chrome).foregroundStyle(Color(token: Tokens.ink))
                    ForEach(Self.sizes, id: \.self) { size in
                        FigureView(character: .pebble, state: state, facing: .right, size: size, animated: false)
                            .frame(width: 72, height: 64)
                    }
                    HStack(spacing: 10) {
                        FigureView(character: .seed, state: state, size: 14, animated: false)
                        FigureView(character: .wren, state: state, size: 14, animated: false)
                    }
                    .frame(height: 64)
                }
            }
        }
        .padding(18)
        .fixedSize()
        .panelChrome(radius: Tokens.Shape.popupRadius)
    }

    static func label(_ state: FigureState) -> String {
        switch state {
        case .noticed: return "Noticed"
        case .offering: return "Offering"
        case .working: return "Working, about to leave"
        case .done: return "Done"
        case .needsYou: return "Needs you"
        case .error: return "Error"
        case .still: return "Still"
        case .absent: return "Absent (not drawn)"
        }
    }
}

/// The two A2 layout fixes, drawn at text size over a synthetic form with the claim form's
/// geometry (fields 23 pt tall, 29 pt apart), with the line placed by `LinePlacement` exactly as
/// the host places it. Off screen, so both themes render on one Mac whatever the form app's own
/// appearance.
struct LayoutFixScene: View {
    /// `fromMemory`: an empty form whose Full name is offered from what the user told Caret (A14).
    enum Moment { case toastGivesWay, lineAfterToast, fromMemory }

    var moment: Moment
    var character: FigureCharacter = .pebble
    @Environment(\.colorScheme) private var scheme

    static let rows = ["Full name", "Email", "Phone", "Order number"]
    static let values = ["Dana Whitfield", "dana.whitfield@lumenlabs.example", "+1 (512) 555-0142", ""]
    static let fieldX: CGFloat = 150, fieldW: CGFloat = 320, fieldH: CGFloat = 23, top: CGFloat = 20, pitch: CGFloat = 52

    static func field(_ i: Int) -> CGRect { CGRect(x: fieldX, y: top + CGFloat(i) * pitch, width: fieldW, height: fieldH) }

    var body: some View {
        let toast = LineContent(figure: .done, lead: "Filled", text: "1 field from Caret Fixture", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")])
        let source = LineContent(figure: .offering, text: "from Caret Fixture, Reference", emphasis: .secondary, hints: [Hint(key: "Tab")])
        let memory = LineContent(figure: .offering, text: FillOrigin.memoryCaption, emphasis: .secondary, hints: [Hint(key: "Tab")])
        // Toast for row 1 while row 2's value waits; or, after the toast, row 2's own line; or the
        // first field's line on a form nothing has filled yet.
        let (content, anchorRow): (LineContent, Int)
        switch moment {
        case .toastGivesWay: (content, anchorRow) = (toast, 0)
        case .lineAfterToast: (content, anchorRow) = (source, 2)
        case .fromMemory: (content, anchorRow) = (memory, 0)
        }
        let width = NSHostingView(rootView: LineView(content: content, character: character, animated: false)).fittingSize.width
        let compactWidth = NSHostingView(rootView: LineView(content: content, character: character, compact: true, animated: false)).fittingSize.width
        let obstacles = (0..<Self.rows.count).filter { $0 != anchorRow }.map(Self.field)
            + [CGRect(x: 0, y: -40, width: 600, height: 40)]
        let choice = LinePlacement.choose(
            field: Self.field(anchorRow), width: width, compactWidth: compactWidth, obstacles: obstacles,
            bounds: CGRect(x: -8, y: -8, width: 516, height: 260)
        )
        let filled: Int
        switch moment {
        case .toastGivesWay: filled = 1
        case .lineAfterToast: filled = 2
        case .fromMemory: filled = 0
        }
        return ZStack(alignment: .topLeading) {
            ForEach(Array(Self.rows.enumerated()), id: \.offset) { i, label in
                Text(label + ":").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
                    .offset(x: 16, y: Self.field(i).minY + 3)
                FieldBox(
                    text: i < filled ? Self.values[i] : (i == filled ? Self.values[i] : ""),
                    ghost: i == filled, focused: i == filled
                )
                .frame(width: Self.fieldW, height: Self.fieldH)
                .offset(x: Self.field(i).minX, y: Self.field(i).minY)
            }
            LineView(content: content, character: character, compact: choice.compact, animated: false)
                .environment(\.drawsOwnSurface, true)
                .offset(x: choice.frame.minX, y: choice.frame.minY)
        }
        .frame(width: 500, height: Self.top + CGFloat(Self.rows.count) * Self.pitch, alignment: .topLeading)
        .background(Color(nsColor: Tokens.srgb(scheme == .dark ? 0x323232 : 0xEEEFEE)))
    }

    /// An AppKit text field, roughly: text background, hairline border, focus ring when focused.
    struct FieldBox: View {
        var text: String
        var ghost: Bool
        var focused: Bool
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            let dark = scheme == .dark
            ZStack(alignment: .leading) {
                Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x1E1E1E : 0xFFFFFF)))
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(Color(token: Tokens.ink).opacity(ghost ? (dark ? 0.5 : 0.45) : 1))
                    .padding(.leading, 4)
            }
            .overlay(Rectangle().strokeBorder(Color(nsColor: Tokens.srgb(dark ? 0x4A4A4A : 0xC8C8C8)), lineWidth: 1))
            .overlay(focused ? RoundedRectangle(cornerRadius: 3).stroke(Color.accentColor.opacity(0.55), lineWidth: 3).padding(-2) : nil)
        }
    }
}

/// A pop-up placed by `FieldPanelPlacement` over a synthetic form with the claim form's geometry
/// (fields 320 x 24 every 52 pt, labels on the left), the field at `focusRow` focused and the
/// screen's edge `room` points right of the window and `roomBelow` under it. Off screen, both
/// themes on one Mac.
struct PanelPlacementScene: View {
    var spec: PopupSpec
    var highlight: Int?
    var focusRow: Int
    var room: CGFloat
    var roomBelow: CGFloat = 0
    var character: FigureCharacter = .pebble
    @Environment(\.colorScheme) private var scheme

    static let rows = ["Full name", "Email", "Phone", "", "Order number", "Order total", "Shipping address", "", "Promo code"]
    static let windowW: CGFloat = 520, titleBar: CGFloat = 28, fieldX: CGFloat = 170, fieldW: CGFloat = 320, fieldH: CGFloat = 24
    static let top: CGFloat = 54, pitch: CGFloat = 52

    static func field(_ i: Int) -> CGRect { CGRect(x: fieldX, y: top + CGFloat(i) * pitch, width: fieldW, height: fieldH) }
    static func label(_ i: Int) -> CGRect? { rows[i].isEmpty ? nil : CGRect(x: 18, y: field(i).minY + 3, width: 140, height: 18) }
    static var windowH: CGFloat { top + CGFloat(rows.count) * pitch }

    /// Where the rule puts the pop-up, given every other field, label and the title bar.
    var choice: FieldPanelPlacement.Choice {
        let view = PopupView(spec: spec, highlight: highlight, character: character, animated: false)
        let size = NSHostingView(rootView: view).fittingSize
        let narrow = NSHostingView(rootView: PopupView(spec: spec, highlight: highlight, character: character, animated: false, width: PopupView.minWidth)).fittingSize
        let focused = Self.field(focusRow)
        let items = (0..<Self.rows.count).filter { $0 != focusRow }.flatMap { [Self.field($0)] + (Self.label($0).map { [$0] } ?? []) }
            + (Self.label(focusRow).map { [$0] } ?? []) + [CGRect(x: 0, y: 0, width: Self.windowW, height: Self.titleBar)]
        let caret = CGRect(x: focused.minX + 4, y: focused.minY + 3, width: 1, height: 18)
        return FieldPanelPlacement.choose(
            field: focused, caret: caret, size: size, narrow: narrow,
            bounds: CGRect(x: -40, y: -40, width: Self.windowW + 40 + room, height: Self.windowH + 40 + roomBelow),
            obstacles: { frame in items.filter { $0.intersects(frame) } }
        )
    }

    var body: some View {
        let choice = self.choice
        let dark = scheme == .dark
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x323232 : 0xEEEFEE)))
                .frame(width: Self.windowW, height: Self.windowH)
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x3A3A3A : 0xE4E4E4)))
                .frame(width: Self.windowW, height: Self.titleBar)
            ForEach(Array(Self.rows.enumerated()), id: \.offset) { i, label in
                if !label.isEmpty {
                    Text(label + ":").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
                        .offset(x: 18, y: Self.field(i).minY + 3)
                }
                LayoutFixScene.FieldBox(text: "", ghost: false, focused: i == focusRow)
                    .frame(width: Self.fieldW, height: Self.fieldH)
                    .offset(x: Self.field(i).minX, y: Self.field(i).minY)
            }
            PopupView(spec: spec, highlight: highlight, character: character, animated: false,
                      width: choice.spot.isNarrow ? PopupView.minWidth : nil)
                .offset(x: choice.frame.minX, y: choice.frame.minY)
        }
        .frame(width: Self.windowW + room, height: Self.windowH + roomBelow, alignment: .topLeading)
        .background(Color(nsColor: Tokens.srgb(dark ? 0x1B1F2A : 0x9DB4CC)))
    }
}

// MARK: - The perch and the activity list

extension Gallery {
    /// The perch in each mood, in a corner of a synthetic screen with the window it works in, so
    /// the render shows the glance as `PerchGaze` computes it.
    static func perch(_ character: FigureCharacter = .pebble) -> [Item] {
        [
            Item(name: "perch-working", view: AnyView(PerchScene(mood: .working, character: character))),
            Item(name: "perch-waiting", view: AnyView(PerchScene(mood: .waiting, needsYou: 1, character: character))),
            Item(name: "perch-needs-you", view: AnyView(PerchScene(mood: .needsYou, needsYou: 2, character: character))),
            Item(name: "perch-done", view: AnyView(PerchScene(mood: .done, character: character))),
            Item(name: "perch-error", view: AnyView(PerchScene(mood: .error, character: character))),
            Item(name: "perch-working-above", view: AnyView(PerchScene(mood: .working, character: character, windowAbove: true))),
        ]
    }

    /// 2026-10-02 15:00 CDT, for the list's Done times.
    static let listNow = Date(timeIntervalSince1970: 1_790_971_200)

    static let activityRows: [ActivityRow] = {
        let t = Int64(listNow.timeIntervalSince1970 * 1000)
        return [
            ActivityRow(id: "run-2", section: .needsYou, state: .paused, says: "Fill the six fields", app: "Caret Fixture",
                        progress: "Stopped before step 3 of 6", actions: [.resume, .undo], updatedAt: t - 20_000),
            ActivityRow(id: "watch-2", section: .needsYou, state: .needsYou, says: "Watching 'Upload' in Caret Fixture", app: "Caret Fixture",
                        progress: "Waiting for you", actions: [], updatedAt: t - 60_000),
            ActivityRow(id: "run-3", section: .inProgress, state: .running, says: "Fill the claim form from Invoice 2041", app: "Caret Fixture",
                        progress: "Step 4 of 6", actions: [.takeOver], updatedAt: t - 5_000),
            ActivityRow(id: "watch-1", section: .inProgress, state: .running, says: "Watching 'Test run' in Caret Fixture", app: "Caret Fixture",
                        progress: "Watching", actions: [], updatedAt: t - 90_000),
            ActivityRow(id: "run-1", section: .done, state: .done, says: "Coffee with Dana, Thu 3:00 to 3:30", app: "Calendar",
                        progress: nil, actions: [.undo], updatedAt: t - 16 * 60_000),
            ActivityRow(id: "run-0", section: .done, state: .failed, says: "Fill the schedule form", app: "Caret Fixture",
                        progress: "Stopped at step 2 of 5", actions: [.undo], updatedAt: t - 41 * 60_000),
        ]
    }()

    static func activity(_ character: FigureCharacter = .pebble) -> [Item] {
        func list(_ rows: [ActivityRow], mood: Perch.Mood?, busy: Set<String> = []) -> AnyView {
            AnyView(ActivityListView(rows: rows, mood: mood, character: character, busy: busy, animated: false, now: listNow)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        return [
            Item(name: "activity-list", view: list(activityRows, mood: .needsYou)),
            Item(name: "activity-list-taking-over", view: list(activityRows, mood: .needsYou, busy: ["run-3"])),
            Item(name: "activity-list-empty", view: list([], mood: nil)),
        ]
    }
}

/// A corner of a synthetic screen: the window a task works in, and the perch in the corner's
/// home, aimed by `PerchGaze` exactly as on screen. Off screen only; nothing here reads the screen.
struct PerchScene: View {
    var mood: Perch.Mood
    var needsYou = 0
    var character: FigureCharacter = .pebble
    /// The window straight above the perch rather than up and to the left.
    var windowAbove = false
    @Environment(\.colorScheme) private var scheme

    static let size = CGSize(width: 300, height: 190)

    var body: some View {
        let visible = CGRect(origin: .zero, size: Self.size)
        let perch = PerchPlacement.frame(.bottomRight, size: PerchModel.size, in: visible)
        let window = windowAbove ? CGRect(x: 170, y: 14, width: 120, height: 84) : CGRect(x: 16, y: 16, width: 168, height: 104)
        let model = PerchModel()
        model.presented = true
        model.animated = false
        model.mood = mood
        model.needsYou = needsYou
        model.character = character
        switch mood {
        case .done, .error: model.gaze = .zero
        default: model.gaze = PerchGaze.toward(window, from: CGPoint(x: perch.midX, y: perch.midY))
        }
        let dark = scheme == .dark
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x26282C : 0xD9DCE1)))
            SceneWindow(title: "Upload", dark: dark)
                .frame(width: window.width, height: window.height)
                .offset(x: window.minX, y: window.minY)
            PerchView(model: model)
                .offset(x: perch.minX, y: perch.minY)
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// A window, roughly: title bar with three dots and a title, an empty body.
    struct SceneWindow: View {
        var title: String
        var dark: Bool

        var body: some View {
            VStack(spacing: 0) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(Color(token: Tokens.secondary).opacity(0.35)).frame(width: 7, height: 7) }
                    Text(title).font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(token: Tokens.secondary)).padding(.leading, 6)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(height: 20)
                Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach([0.8, 0.55, 0.65], id: \.self) { w in
                        RoundedRectangle(cornerRadius: 2).fill(Color(token: Tokens.secondary).opacity(0.18)).frame(height: 5).frame(maxWidth: .infinity, alignment: .leading).scaleEffect(x: w, y: 1, anchor: .leading)
                    }
                }
                .padding(10)
                Spacer(minLength: 0)
            }
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: Tokens.srgb(dark ? 0x2E2F33 : 0xFBFBFC))))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(token: Tokens.border), lineWidth: 1))
        }
    }
}

// MARK: - What Caret knows

extension Gallery {
    /// The memory window over synthetic entries: the helper's shapes as the contract fixture has
    /// them (`Tests/CaretHostCoreTests/Fixtures/memory.ndjson`), built here so the app target does
    /// not read test files. 2026-09-21 09:16 CDT for the evidence lines.
    static let memoryNow = Date(timeIntervalSince1970: 1_790_000_160)

    static func memoryEntries() -> [HelperMemory.Entry] {
        let t: Int64 = 1_790_000_000_000
        func ev(_ count: Int, _ dt: Int64, _ app: String?) -> HelperMemory.Evidence { HelperMemory.Evidence(count: count, lastSeen: t + dt, app: app) }
        func routine() -> HelperMemory.Fields {
            .routine(.init(srcApps: ["Caret Fixture"], dstApp: "Mail Fixture", steps: 3, name: nil, silent: .init(hits: 1, misses: 0)))
        }
        var entries: [HelperMemory.Entry] = [
            .init(id: "about-1", status: .active, says: "Guest: Marcus Lowe (ops) (from your edit)", evidence: ev(1, 60_000, "Mail Fixture"),
                  fields: .about(.init(label: "Guest", value: "Marcus Lowe (ops)", source: .edit))),
            .init(id: "people-1", status: .paused, says: "\"Dana\" in Mail Fixture usually means Dana Reyes (chosen 3 times)", evidence: ev(3, 30_000, "Mail Fixture"),
                  fields: .people(.init(alias: "Dana", name: "Dana Reyes"))),
            .init(id: "preference-1", status: .active, says: "Phone numbers go in as 512-555-0100 (you changed this 2 times)", evidence: ev(2, 20_000, "Caret Fixture"),
                  fields: .preference(.format(template: "###-###-####"))),
            .init(id: "preference-2", status: .active, says: "Guest gets your Guest, Marcus Lowe (ops) (you changed this once)", evidence: ev(1, 60_000, "Mail Fixture"),
                  fields: .preference(.useInstead(field: "Guest", aboutId: "about-1"))),
            .init(id: "routine-1", status: .learning, says: "3 values from Caret Fixture to Mail Fixture (seen 2 times; learning, 1 of 3 silent predictions right)",
                  evidence: ev(2, 90_000, "Mail Fixture"), fields: routine()),
        ]
        let starts: [(HelperMemory.ActionType, HelperMemory.Rule, Bool)] = [
            (.read, .act, true), (.show, .act, true), (.writeHere, .ask, false), (.writeElsewhere, .ask, false),
            (.outbound, .handoff, false), (.destructive, .handoff, false), (.sensitive, .handoff, true),
        ]
        for (action, rule, fixed) in starts {
            let uses: [HelperMemory.Use]? = action == .writeHere
                ? [.init(at: t + 120_000, says: "Filled Guest in Mail Fixture", app: "Mail Fixture"), .init(at: t + 60_000, says: "Filled Email in Caret Fixture", app: "Caret Fixture")]
                : nil
            entries.append(.init(id: "permission-\(action.rawValue)", status: .active, says: "", evidence: ev(0, 0, nil),
                                 fields: .permission(.init(action: action, rule: rule, fixed: fixed)), uses: uses))
        }
        return entries
    }

    /// A book in each state the window shows, reached by the calls the window makes.
    static func memoryState(_ setup: (MemoryBook) -> Void = { _ in }, connected: Bool = true, entries: [HelperMemory.Entry]? = nil) -> MemoryBook.State {
        let book = MemoryBook(clock: StillClock())
        var asked: [HelperMemory.Request] = []
        book.send = { asked.append($0); return true }
        book.linkChanged(true)
        book.receive(HelperMemory.Reply(requestId: asked.last!.requestId, error: nil, entries: entries ?? memoryEntries()))
        setup(book)
        if !connected { book.linkChanged(false) }
        return book.state
    }

    static func memory(_ character: FigureCharacter = .pebble) -> [Item] {
        func window(_ state: MemoryBook.State, _ tab: MemoryView.Tab = .memory, pointerOn row: String? = nil) -> AnyView {
            AnyView(MemoryView(state: state, tab: tab, character: character, animated: false, now: memoryNow, revealedRow: row)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        return [
            Item(name: "memory-list", view: window(memoryState())),
            // The pointer on the people row: its controls show, every other row's stay hidden.
            Item(name: "memory-list-hover", view: window(memoryState(), pointerOn: "people-1")),
            Item(name: "memory-edit", view: window(memoryState { book in
                book.beginEdit("about-1")
                book.updateDraft("value", "Marcus Lowe, Operations")
            })),
            Item(name: "memory-edit-problem", view: window(memoryState { book in
                book.beginEdit("preference-1")
                book.updateDraft("template", "512-###-####")
                book.saveEdit()
            })),
            Item(name: "memory-forget", view: window(memoryState { $0.askToForget("routine-1") })),
            Item(name: "memory-typed-offline", view: window(memoryState({ $0.remember([TypedAbout(label: "Name", value: "Dana Whitfield")]) }, connected: false))),
            Item(name: "memory-empty", view: window(memoryState(entries: []))),
            Item(name: "memory-permissions", view: window(memoryState(), .permissions)),
            Item(name: "memory-permissions-refused", view: window(memoryState { $0.setRule(.outbound, .act) }, .permissions)),
        ]
    }
}
