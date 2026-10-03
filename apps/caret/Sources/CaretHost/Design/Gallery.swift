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
    static func png<V: View>(_ view: V, dark: Bool, padding: CGFloat = 24) -> Data? {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
        var data: Data?
        appearance.performAsCurrentDrawingAppearance {
            let content = view
                .environment(\.drawsOwnSurface, true)
                .environment(\.colorScheme, dark ? .dark : .light)
                .padding(padding)
                .background(canvas(dark: dark))
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

    static func lines(_ character: FigureCharacter = .pebble) -> [Item] {
        let done = Captions.done(character, app: "Calendar")
        func line(_ name: String, _ content: LineContent, compact: Bool = false) -> Item {
            Item(name: name, view: AnyView(LineView(content: content, character: character, compact: compact, animated: false)))
        }
        return [
            line("line-action", LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thu 3:00 to 3:30", hints: [Hint(key: "Tab")])),
            line("line-working", LineContent(figure: .absent, app: "Calendar", text: Captions.working(character, app: "Calendar") + ", 4 s", emphasis: .plain, hints: [Hint(key: "Esc", label: "Stop")], appGlyphOnly: true)),
            line("line-done", LineContent(figure: .done, lead: done.lead, text: done.rest, emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")])),
            line("line-error", LineContent(figure: .error, text: Captions.error(character, app: "Calendar"), emphasis: .plain)),
            line("line-fill-source", LineContent(figure: .offering, text: "from Mail, Invoice 2041", emphasis: .secondary, hints: [Hint(key: "Tab")])),
            line("line-fill-source-compact", LineContent(figure: .offering, text: "from Mail, Invoice 2041", emphasis: .secondary, hints: [Hint(key: "Tab")]), compact: true),
            line("line-fill-toast", LineContent(figure: .done, lead: "Filled", text: "1 field from Mail", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")])),
            Item(name: "alternatives-collapsed-quoted", view: AnyView(AlternativesScene(character: character, collapsed: true))),
            Item(name: "alternatives-open", view: AnyView(AlternativesScene(character: character))),
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
        window: .init(pid: 5151, windowId: "5151-2", appName: "Safari", title: "Payment"), spec: fillPreview
    )

    /// Every onboarding screen, and each state of the ones that change, reached by sending the
    /// flow the events the window would.
    static func onboarding(_ character: FigureCharacter = .pebble) -> [Item] {
        func flow(ax: Bool = true, input: Bool = true, _ events: [OnboardingFlow.Event]) -> OnboardingFlow.State {
            let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: ax, inputMonitoring: input), clock: StillClock())
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
            ("work", flow([.next, .setRole(.watch, false)])),
            ("permissions-waiting", flow(ax: false, input: false, [.next, .next])),
            ("permissions-on", flow(ax: false, input: false, [.next, .next, .permissions(OnboardingPermissions(accessibility: true, inputMonitoring: true))])),
            ("try-it", flow(toTryIt)),
            ("try-it-declined", flow(toTryIt + [.key(.character("9"))])),
            ("try-it-filled", flow(toTryIt + [.key(.tab)])),
            ("first-look-asking", flow(toFirstLook)),
            ("first-look-found", flow(toFirstLook + [.firstLookReply(found)])),
            ("first-look-nothing", flow(toFirstLook + [.firstLookReply(nothing)])),
            ("first-look-error", flow(toFirstLook + [.firstLookUnsent])),
        ]
        return screens.map { name, state in
            Item(name: "onboarding-\(name)", view: AnyView(OnboardingView(state: state, character: character, animated: false)))
        }
    }
}

/// Alternatives open, drawn over a sample sentence the way they sit at a caret: ghost text with
/// the uneven underline, the figure and count after it, and the list below.
struct AlternativesScene: View {
    var character: FigureCharacter
    var current = 1
    /// Collapsed: the faint value alone, underlined because it is quoted from a source.
    var collapsed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .lastTextBaseline, spacing: 0) {
                Text("The meeting moved to Thursday, so I'll send the notes ")
                    .foregroundStyle(Color(token: Tokens.ink))
                Rectangle().fill(Color(token: Tokens.ink)).frame(width: 1, height: 15).offset(y: 3)
                VStack(alignment: .leading, spacing: 0) {
                    Text(Gallery.alternatives[collapsed ? 0 : current])
                        .foregroundStyle(Color(token: Tokens.ink).opacity(0.45))
                    if collapsed { UnevenUnderline(width: 262, animated: false) }
                }
                .alignmentGuide(.lastTextBaseline) { $0[.lastTextBaseline] - (collapsed ? 5 : 0) }
                if !collapsed {
                    AlternativesTag(current: current, count: Gallery.alternatives.count, character: character, figureHeight: 9, animated: false)
                        .padding(.leading, 4)
                }
            }
            .font(.system(size: 13))
            if !collapsed {
                AlternativesListView(candidates: Gallery.alternatives, current: current)
                    .padding(.leading, 300)
            }
        }
        .fixedSize()
    }
}

/// Every state of every character, at text size (11 pt) and at four times that for review.
struct FigureGalleryView: View {
    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 10) {
            GridRow {
                Text("")
                ForEach(FigureCharacter.allCases, id: \.self) { c in
                    Text(c.displayName).font(Tokens.Font.title).foregroundStyle(Color(token: Tokens.ink))
                        .gridCellColumns(1)
                }
            }
            ForEach(FigureState.allCases, id: \.self) { state in
                GridRow {
                    Text(Self.label(state)).font(Tokens.Font.body).foregroundStyle(Color(token: Tokens.secondary))
                    ForEach(FigureCharacter.allCases, id: \.self) { c in
                        HStack(alignment: .bottom, spacing: 14) {
                            FigureView(character: c, state: state, facing: .right, height: 11, animated: false)
                            FigureView(character: c, state: state, facing: .right, height: 44, animated: false)
                        }
                        .frame(width: 96, height: 50, alignment: .bottomLeading)
                    }
                }
            }
        }
        .padding(16)
        .panelChrome(radius: 10)
    }

    static func label(_ state: FigureState) -> String {
        switch state {
        case .noticed: return "Noticed"
        case .offering: return "Offering"
        case .working: return "Working, before it leaves"
        case .done: return "Done"
        case .needsYou: return "Needs you"
        case .error: return "Error"
        case .absent: return "Absent (not drawn)"
        }
    }
}

/// The two A2 layout fixes, drawn at text size over a synthetic form with the claim form's
/// geometry (fields 23 pt tall, 29 pt apart), with the line placed by `LinePlacement` exactly as
/// the host places it. Off screen, so both themes render on one Mac whatever the form app's own
/// appearance.
struct LayoutFixScene: View {
    enum Moment { case toastGivesWay, lineAfterToast }

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
        // Toast for row 1 while row 2's value waits; or, after the toast, row 2's own line.
        let (content, anchorRow) = moment == .toastGivesWay ? (toast, 0) : (source, 2)
        let width = NSHostingView(rootView: LineView(content: content, character: character, animated: false)).fittingSize.width
        let compactWidth = NSHostingView(rootView: LineView(content: content, character: character, compact: true, animated: false)).fittingSize.width
        let obstacles = (0..<Self.rows.count).filter { $0 != anchorRow }.map(Self.field)
            + [CGRect(x: 0, y: -40, width: 600, height: 40)]
        let choice = LinePlacement.choose(
            field: Self.field(anchorRow), width: width, compactWidth: compactWidth, obstacles: obstacles,
            bounds: CGRect(x: -8, y: -8, width: 516, height: 260)
        )
        let filled = moment == .toastGivesWay ? 1 : 2
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
