import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// Onboarding's four panes, drawn from `OnboardingFlow.State` (~/.caret-run/design/onboard2/HANDOFF.md). The panes are
/// thin on purpose: the flow decides everything, `OnboardingCopy` holds every word, and a pane only lays them out, so
/// the design can change without touching the mechanics.
///
/// Motion (HANDOFF §4), all rare because this window opens once: panes cross with opacity and a 6 pt slide (160 ms
/// out); the figure arrives and nods once on Hello; the grant's check fades in (120 ms linear) and a Carrot rule draws
/// under "Caret is on." (320 ms out). Keyboard-caused changes (Tab takes the ghost, Esc) change at once. Reduce Motion
/// keeps fades and drops every movement.
struct OnboardingView: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    /// False for off-screen renders: every element in its end state, nothing scheduled.
    var animated = true
    var send: (OnboardingFlow.Event) -> Void = { _ in }
    /// The privacy promise the `on` pane shows. The window reads the bundle; renders pass their own text.
    var promise = PrivacyPromiseText.bundled

    /// The main window and the guide beside System Settings (HANDOFF §6).
    static func size(for frame: OnboardingFlow.Frame) -> CGSize {
        frame == .guide ? CGSize(width: 420, height: 392) : CGSize(width: 640, height: 660)
    }

    static let inset: CGFloat = 36
    static let top: CGFloat = 40

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let size = Self.size(for: state.frame)
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                pane.id(state.step).transition(transition)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .animation(animated ? OnboardingMotion.curve(OnboardingMotion.out, 0.16, reduce: reduceMotion) : nil, value: state.step)
            OnboardingBar(state: state, send: send)
        }
        .frame(width: size.width, height: size.height)
        .background(Color(token: Tokens.window))
    }

    private var transition: AnyTransition {
        guard animated, !reduceMotion else { return .opacity }
        let dx: CGFloat = state.direction == .forward ? 6 : -6
        return .asymmetric(insertion: .opacity.combined(with: .offset(x: dx)), removal: .opacity.combined(with: .offset(x: -dx)))
    }

    @ViewBuilder
    private var pane: some View {
        switch state.step {
        case .hello: HelloPane(state: state, character: character, animated: animated, send: send)
        case .access: AccessPane(state: state, animated: animated, send: send)
        case .on: OnPane(state: state, promise: promise, animated: animated, send: send)
        case .first: FirstPane(state: state, character: character, animated: animated)
        }
    }
}

/// HANDOFF §4's curves (v41): out for entrances and swaps, in-out for the window's frame and the drawn toggle.
enum OnboardingMotion {
    static let out = (0.22, 1.0, 0.36, 1.0)
    static let inOut = (0.83, 0.0, 0.17, 1.0)
    /// Reduce Motion: fades only, linear.
    static let reduced = Animation.linear(duration: 0.12)

    static func curve(_ c: (Double, Double, Double, Double), _ duration: Double, reduce: Bool) -> Animation {
        reduce ? reduced : Motion.curve(c, duration)
    }
}

/// The footer: the quiet choice at the left, the step dots in the middle, the primary at the right (HANDOFF §5 order).
struct OnboardingBar: View {
    var state: OnboardingFlow.State
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        ZStack {
            if state.steps.count > 1 { StepDots(current: state.stepIndex, count: state.steps.count).accessibilitySortPriority(2) }
            HStack {
                if let quiet { Button(quiet.title) { send(quiet.event) }.buttonStyle(QuietButtonStyle(size: 13)).accessibilitySortPriority(3) }
                Spacer()
                if let primary {
                    // The flow decides what the primary does on each step (Return sends the same event).
                    Button(primary) { send(.next) }
                        .buttonStyle(OnboardingButtonStyle(kind: .primary))
                        .disabled(!state.canContinue)
                        .keyboardShortcut(.defaultAction)
                        .accessibilitySortPriority(1)
                }
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 22)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
    }

    private var quiet: (title: String, event: OnboardingFlow.Event)? {
        switch state.step {
        case .hello, .access: return state.alone ? nil : (OnboardingCopy.Hello.later, .setUpLater)
        case .on:
            if case .ready = state.on.preview, state.on.decision == .pending { return (OnboardingCopy.On.keep, .keep) }
            return nil
        case .first:
            guard state.firstLookFound != nil, state.first.run == nil, !state.first.declined, state.first.calendar == nil else { return nil }
            return (OnboardingCopy.First.notNow, .notNow)
        }
    }

    private var primary: String? {
        switch state.step {
        case .hello: return OnboardingCopy.Hello.primary
        case .access: return nil
        case .on:
            if case .ready = state.on.preview, state.on.decision != .kept { return OnboardingCopy.On.send }
            return OnboardingCopy.On.done
        case .first:
            if let found = state.firstLookFound, state.first.run == nil, !state.first.declined, state.first.calendar == nil {
                return found.takeable.first?.label ?? OnboardingCopy.First.done
            }
            return OnboardingCopy.First.done
        }
    }
}

// MARK: - Shared parts

/// A pane's heading in Caret's voice (New York 22, tracking -0.3) and an optional line under it.
struct ScreenTitle: View {
    var title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(Tokens.Font.voiceDisplay(.newYork))
                .tracking(-0.3)
                .foregroundStyle(Color(token: Tokens.ink))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let detail {
                Text(detail)
                    .font(.system(size: 13))
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One dot per step: the current one Carrot and larger (7 pt against 5, so it does not rest on colour alone).
struct StepDots: View {
    var current: Int
    var count: Int

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { i in
                Circle()
                    .fill(Color(token: i == current ? Tokens.carrot : Tokens.ink3))
                    .frame(width: i == current ? 7 : 5, height: i == current ? 7 : 5)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(count)")
    }
}

/// Primary is the ink button; secondary is key-styled.
struct OnboardingButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    var kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        WindowButtonBody(label: configuration.label, pressed: configuration.isPressed, kind: kind == .primary ? .ink : .key, small: false)
    }
}

/// Press feedback for a row that is not a button to look at.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(Motion.curve(Motion.easeOut, 0.12), value: configuration.isPressed)
    }
}

struct FieldLabel: View {
    var text: String
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary))
    }
}

/// An app's icon at 16 pt, before its name. Decorative: the name says it.
struct AppIcon: View {
    var bundleId: String
    var size: CGFloat = 16

    var body: some View {
        Group {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable()
            } else {
                RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color(token: Tokens.rule))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A line of text that announces itself to VoiceOver when it changes, and swaps with a short fade (keyboard-paced
/// changes swap at once).
struct SwappingLine<Content: View>: View {
    var key: String
    /// False for a change a key caused (Tab took the ghost): it swaps at once.
    var animated: Bool
    /// What VoiceOver hears for the new line; the key when nil.
    var announcement: String? = nil
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            content.id(key).transition(.opacity)
        }
        .animation(animated ? OnboardingMotion.curve(OnboardingMotion.out, 0.14, reduce: reduceMotion) : nil, value: key)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.updatesFrequently)
        .onChange(of: key) { _, new in
            guard !new.isEmpty else { return }
            AccessibilityNotification.Announcement(announcement ?? new).post()
        }
    }
}

// MARK: - 1. Hello

/// The win before the ask: the person's own sentence, with the local model's next words after the caret. The figure
/// arrives and nods once (160 ms out, then a 240 ms nod at 720 ms); under Reduce Motion it is simply there.
struct HelloPane: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void

    @State private var arrived = false
    @State private var nod = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let hello = state.hello
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            // Drawn still: its arrival and nod below are the whole performance (no breath or blink loop).
            FigureView(character: character, state: .noticed, size: Tokens.FigureSize.onboarding, animated: false,
                       gaze: CGVector(dx: 0, dy: 0.8))
                .scaleEffect(x: nod ? 1.06 : 1, y: nod ? 0.92 : 1, anchor: .bottom)
                .offset(y: nod ? 1 : 0)
                .opacity(still || arrived ? 1 : 0)
                .scaleEffect(still || arrived ? 1 : 0.9, anchor: .bottom)
                .offset(y: still || arrived ? 0 : 2)
                .padding(.bottom, 22)
            ScreenTitle(title: OnboardingCopy.Hello.title, detail: OnboardingCopy.Hello.line)
            FieldLabel(text: OnboardingCopy.Hello.fieldLabel).padding(.top, 26)
            HelloField(hello: hello, enabled: hello.model == .ready, send: send).padding(.top, 8)
            SwappingLine(key: coachKey, animated: animated && !state.hello.taken,
                         announcement: state.hello.ghost != nil ? "Tab \(OnboardingCopy.Hello.coachShown)" : nil) { coach }
                .frame(minHeight: 22, alignment: .topLeading)
                .padding(.top, 8)
            if let notice = OtherTabOwners.notice(state.otherTabOwners) {
                Text(notice).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink)).fixedSize(horizontal: false, vertical: true).padding(.top, 4)
            }
            AppsLine(apps: hello.apps).padding(.top, 18)
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Text(OnboardingCopy.Hello.caption)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 280, alignment: .trailing)
            }
            .padding(.bottom, 10)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
        .task {
            guard !still, !arrived else { return }
            withAnimation(Motion.curve(OnboardingMotion.out, Motion.Duration.figureEnter)) { arrived = true }
            guard (try? await Task.sleep(for: .milliseconds(720))) != nil else { return }
            withAnimation(Motion.curve(OnboardingMotion.out, 0.12)) { nod = true }
            guard (try? await Task.sleep(for: .milliseconds(120))) != nil else { return }
            withAnimation(Motion.curve(OnboardingMotion.out, 0.12)) { nod = false }
        }
    }

    private var still: Bool { !animated || reduceMotion }

    private var coachKey: String {
        let h = state.hello
        if h.model == .unavailable { return OnboardingCopy.Hello.unavailable }
        if case .loading = h.model { return OnboardingCopy.Hello.loading }
        if h.ghost != nil { return OnboardingCopy.Hello.coachShown }
        return h.taken ? OnboardingCopy.Hello.coachTaken : ""
    }

    @ViewBuilder
    private var coach: some View {
        let h = state.hello
        HStack(spacing: 6) {
            if h.ghost != nil, h.model == .ready {
                Keycap(text: "Tab")
                Text(OnboardingCopy.Hello.coachShown)
            } else {
                Text(coachKey)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(Color(token: Tokens.ink2))
    }
}

/// The Hello field: the person's text, and the model's next words after it in Ink at 45 percent. Tab is the window's
/// (`OnboardingController.event`), so the field never inserts a tab character while a ghost shows.
struct HelloField: View {
    var hello: OnboardingFlow.Hello
    var enabled: Bool
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        EntryField(title: OnboardingCopy.Hello.fieldLabel, text: hello.text, placeholder: OnboardingCopy.Hello.placeholder,
                   autofocus: true, showsFocus: enabled, enabled: enabled, onChange: { send(.typed($0)) }, onSubmit: { send(.next) })
            .overlay(alignment: .leading) {
                if let ghost = hello.ghost {
                    // The typed text, invisible, keeps the ghost's start at the caret; one line, clipped.
                    HStack(spacing: 0) {
                        Text(hello.text).hidden()
                        Text(ghost).foregroundStyle(Color(token: Tokens.ink).opacity(0.45))
                    }
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .clipped()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
            .accessibilityHint(hello.ghost.map { "Caret offers: \($0). Press Tab to take it." } ?? "")
    }
}

/// "It'll be there in Mail, Slack, Notes and Chrome.", each name after its icon.
struct AppsLine: View {
    var apps: [HelloApp]

    var body: some View {
        HStack(spacing: 4) {
            Text("It'll be there in")
            ForEach(Array(apps.enumerated()), id: \.offset) { i, app in
                HStack(spacing: 4) {
                    AppIcon(bundleId: app.bundleId)
                    Text(app.name + (i == apps.count - 1 ? "." : (i == apps.count - 2 ? " and" : ",")))
                        .foregroundStyle(Color(token: Tokens.ink))
                }
            }
        }
        .font(.system(size: 13))
        .foregroundStyle(Color(token: Tokens.ink2))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(OnboardingCopy.Hello.apps(HelloApps.list(apps)))
    }
}

// MARK: - 2. The switch

/// The guide beside System Settings: the live mark waiting for the switch, a drawing of the row to flip, and the one
/// real failure ("Caret isn't in the list?"). When the switch lands the mark's ring gives way to the check (120 ms
/// linear), the headline becomes "Caret is on." and a Carrot rule draws under it (320 ms out).
struct AccessPane: View {
    var state: OnboardingFlow.State
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let granted = state.access.granted
        VStack(alignment: .leading, spacing: 0) {
            SwappingLine(key: granted ? OnboardingCopy.Access.landedTitle : OnboardingCopy.Access.title, animated: animated) {
                ScreenTitle(title: granted ? OnboardingCopy.Access.landedTitle : OnboardingCopy.Access.title)
            }
            Text(granted ? OnboardingCopy.Access.landedLine : (state.access.reopened ? OnboardingCopy.Access.reopened : OnboardingCopy.Access.line))
                .font(.system(size: 13))
                .foregroundStyle(Color(token: Tokens.ink2))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 7)
            // No rule under Reduce Motion (HANDOFF §4).
            if !reduceMotion { CarrotRule(drawn: granted, animated: animated).padding(.top, 6) }
            HStack(spacing: 12) {
                GrantMark(granted: granted, animated: animated)
                VStack(alignment: .leading, spacing: 2) {
                    Text(OnboardingCopy.Access.row).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
                    SwappingLine(key: granted ? OnboardingCopy.Access.on : OnboardingCopy.Access.waiting, animated: animated) {
                        Text(granted ? OnboardingCopy.Access.on : OnboardingCopy.Access.waiting).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2))
                    }
                }
            }
            .padding(.top, 14)
            SettingsRowDrawing(on: granted, animated: animated && !reduceMotion).padding(.top, 14)
            if !granted {
                Button(OnboardingCopy.Access.help) { send(.toggleHelp) }
                    .buttonStyle(QuietButtonStyle(size: 13))
                    .padding(.top, 14)
                if state.access.helpOpen {
                    Text(OnboardingCopy.Access.helpLine)
                        .font(.system(size: 12))
                        .foregroundStyle(Color(token: Tokens.ink2))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                    Button(OnboardingCopy.Access.reopen) { send(.openSystemSettings) }
                        .buttonStyle(QuietButtonStyle(size: 12))
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 30)
        .padding(.top, 34)
        .onAppear {
            guard animated, !state.access.granted else { return }
            AccessibilityNotification.Announcement(OnboardingCopy.Access.waiting).post()
        }
    }
}

/// The ring while waiting, the Ink check once on.
struct GrantMark: View {
    var granted: Bool
    var animated: Bool

    var body: some View {
        ZStack {
            Circle().strokeBorder(Color(token: Tokens.secondary), lineWidth: 1.5).opacity(granted ? 0 : 1)
            if granted {
                ZStack {
                    Circle().fill(Color(token: Tokens.inkFill))
                    Path { p in
                        p.move(to: CGPoint(x: 5, y: 9.2))
                        p.addLine(to: CGPoint(x: 7.8, y: 12))
                        p.addLine(to: CGPoint(x: 13, y: 6.2))
                    }
                    .stroke(Color(token: Tokens.onInk), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
                }
                .transition(.opacity)
            }
        }
        .frame(width: 18, height: 18)
        .animation(animated ? .linear(duration: 0.12) : nil, value: granted)
        .accessibilityHidden(true)
    }
}

/// The Carrot rule under "Caret is on.": the product's own write verb, drawn once.
struct CarrotRule: View {
    var drawn: Bool
    var animated: Bool
    @State private var progress: CGFloat = 0

    var body: some View {
        Capsule()
            .fill(Color(token: Tokens.carrot))
            .frame(width: 120, height: 2)
            .scaleEffect(x: drawn ? (animated ? max(progress, 0.001) : 1) : 0.001, y: 1, anchor: .leading)
            .opacity(drawn ? 1 : 0)
            .onChange(of: drawn) { _, now in
                guard now, animated else { return }
                // One frame after the headline's swap.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) {
                    withAnimation(Motion.curve(OnboardingMotion.out, 0.32)) { progress = 1 }
                }
            }
            .accessibilityHidden(true)
    }
}

/// A drawing of System Settings' row for Caret: its icon, its name and the switch, which flips on at 700 ms and back
/// at 1500 ms once, to show which control to touch (320 ms in-out). Decorative; the line above says it in words.
struct SettingsRowDrawing: View {
    var on: Bool
    var animated: Bool
    @State private var demo = false

    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage ?? NSImage()).resizable().frame(width: 22, height: 22)
            Text("Caret").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
            Spacer()
            DrawnSwitch(on: on || demo)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(Color(token: Tokens.card), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
        .animation(animated ? Motion.curve(OnboardingMotion.inOut, 0.32) : nil, value: on || demo)
        .task {
            guard animated, !on else { return }
            guard (try? await Task.sleep(for: .milliseconds(700))) != nil else { return }
            demo = true
            guard (try? await Task.sleep(for: .milliseconds(800))) != nil else { return }
            demo = false
        }
        .accessibilityHidden(true)
    }
}

struct DrawnSwitch: View {
    var on: Bool

    var body: some View {
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule().fill(on ? Color.accentColor : Color(token: Tokens.rule).opacity(3))
            Circle().fill(.white).shadow(color: .black.opacity(0.2), radius: 1, y: 0.5).padding(2)
        }
        .frame(width: 38, height: 22)
    }
}

// MARK: - 3. Caret is on

/// What is on now, then, before anything leaves the Mac, the lines a first look may send, and the promise in a scroll
/// box. Send is Return; keeping everything on the Mac is the quiet choice.
struct OnPane: View {
    var state: OnboardingFlow.State
    var promise: PrivacyPromise?
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: OnboardingCopy.On.title)
            VStack(spacing: 0) {
                CapabilityRow(title: "Next words", detail: OnboardingCopy.On.nextWords(HelloApps.list(state.hello.apps)), state: "On", on: true)
                CapabilityRow(title: "Fixes", detail: OnboardingCopy.On.fixesDetail, state: "On in Mac apps\n\(OnboardingCopy.On.fixesWeb)", on: true)
                CapabilityRow(title: "The next step", detail: OnboardingCopy.On.stepDetail, state: stepState, on: state.on.decision == .sent, last: true)
            }
            .padding(.top, 12)
            consent.padding(.top, 16)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, 32)
    }

    private var stepState: String {
        switch state.on.decision {
        case .sent: return OnboardingCopy.On.stepSent
        case .kept: return "\(OnboardingCopy.On.stepKept)\n\(OnboardingCopy.On.stepKeptDetail)"
        case .pending: return "Needs the cloud model"
        }
    }

    @ViewBuilder
    private var consent: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch (state.on.decision, state.on.preview) {
            case (.kept, _):
                GroupHead(text: OnboardingCopy.On.keptHead)
                body(OnboardingCopy.On.kept)
            case (.sent, _):
                HStack(spacing: 8) {
                    LookingRing(animated: animated)
                    body(OnboardingCopy.On.looking)
                }
            case (.pending, .idle), (.pending, .building):
                GroupHead(text: OnboardingCopy.On.consentHead)
                HStack(spacing: 8) {
                    LookingRing(animated: animated)
                    body(OnboardingCopy.On.building)
                }
            case (.pending, .empty):
                GroupHead(text: OnboardingCopy.On.consentHead)
                body(OnboardingCopy.On.empty)
            case (.pending, .failed):
                GroupHead(text: OnboardingCopy.On.consentHead)
                body(OnboardingCopy.On.failed)
            case (.pending, .ready(let preview)):
                GroupHead(text: OnboardingCopy.On.consentHead)
                body(OnboardingCopy.On.consentLine(chars: preview.chars, windows: preview.windows.count))
                // Every window and every line Send would approve, scrolling when there are more than fit.
                ScrollingColumn(indicators: .visible) {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)],
                              alignment: .leading, spacing: 12) {
                        ForEach(Array(preview.windows.enumerated()), id: \.offset) { i, window in
                            PreviewCrop(window: window, animated: animated, delay: Double(min(i, 4)) * 0.04)
                        }
                    }
                    .padding(.trailing, 10)
                }
                .frame(maxHeight: 150)
            }
            if state.on.needsKey, state.on.decision == .pending || state.alone {
                KeyBlock(draft: state.on.jevKey, send: send).padding(.top, 4)
            }
            PromiseBox(promise: promise).padding(.top, 8)
        }
    }

    private func body(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink2)).fixedSize(horizontal: false, vertical: true)
    }
}

struct CapabilityRow: View {
    var title: String
    var detail: String
    var state: String
    var on: Bool
    var last = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                GrantMark(granted: on, animated: false)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
                    Text(detail).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2)).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Text(state).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2)).multilineTextAlignment(.trailing)
            }
            .padding(.vertical, 9)
            if !last { Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One window of the preview: its app and title, banded lines that may go, hatched bars for lines that stay (never
/// their text). Appears with opacity, a 2 pt rise and scale .98 (160 ms out), 40 ms after the one before.
struct PreviewCrop: View {
    var window: OnboardingPreview.Window
    var animated: Bool
    var delay: Double
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                AppIcon(bundleId: window.bundleId, size: 14)
                Text(window.appName).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
                Text(window.title).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2)).lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(window.lines.enumerated()), id: \.offset) { _, line in
                    if let text = line.text {
                        Text(text).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink))
                            .padding(.horizontal, 3)
                            .background(Color(token: Tokens.carrotWash), in: RoundedRectangle(cornerRadius: 3))
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Hatch().frame(height: 9).frame(maxWidth: 180)
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(token: Tokens.card), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
        .opacity(still || shown ? 1 : 0)
        .scaleEffect(still || shown || reduceMotion ? 1 : 0.98)
        .offset(y: still || shown || reduceMotion ? 0 : 2)
        .onAppear {
            guard !still else { return }
            withAnimation(OnboardingMotion.curve(OnboardingMotion.out, 0.16, reduce: reduceMotion).delay(delay)) { shown = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(voiceOver)
    }

    private var still: Bool { !animated }

    private var voiceOver: String {
        let going = window.lines.compactMap(\.text)
        return "\(window.appName), \(window.title). \(going.count) line\(going.count == 1 ? "" : "s") may go: \(going.joined(separator: " ")). The rest stays on this Mac."
    }
}

/// Diagonal hatching: a line that stays on the Mac.
struct Hatch: View {
    var body: some View {
        Canvas { ctx, size in
            var x: CGFloat = -size.height
            while x < size.width {
                var p = Path()
                p.move(to: CGPoint(x: x, y: size.height))
                p.addLine(to: CGPoint(x: x + size.height, y: 0))
                ctx.stroke(p, with: .color(Color(token: Tokens.ink3).opacity(0.5)), lineWidth: 1)
                x += 4
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 2))
        .accessibilityHidden(true)
    }
}

/// The spinner: the only loop in onboarding (700 ms per turn); a still ring under Reduce Motion.
struct LookingRing: View {
    var animated: Bool
    @State private var turning = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .trim(from: 0, to: animated && !reduceMotion ? 0.7 : 1)
            .stroke(Color(token: Tokens.ink2), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: 12, height: 12)
            .rotationEffect(.degrees(turning && !reduceMotion ? 360 : 0))
            .onAppear {
                guard animated, !reduceMotion else { return }
                withAnimation(.linear(duration: 0.7).repeatForever(autoreverses: false)) { turning = true }
            }
            .onChange(of: reduceMotion) { _, reduce in
                // Reduce Motion turned on: the loop stops (a still ring); off again: it turns.
                withAnimation(reduce || !animated ? nil : .linear(duration: 0.7).repeatForever(autoreverses: false)) { turning = !reduce && animated }
            }
            .accessibilityHidden(true)
    }
}

/// The key the cloud model needs for now (H12's field and outcome lines, unchanged): Send checks it, then sends.
struct KeyBlock: View {
    var draft: OnboardingFlow.JevKeyDraft
    var send: (OnboardingFlow.Event) -> Void

    static func line(_ draft: OnboardingFlow.JevKeyDraft) -> (text: String, problem: Bool)? {
        switch draft.phase {
        case .editing: return draft.stored && draft.text.isEmpty ? ("Caret has a key saved. Paste a new one to replace it.", false) : nil
        case .malformed: return ("That isn't a key. A key has no spaces in it.", true)
        case .checking: return ("Checking the key with Jev…", false)
        case .checked(let outcome, let saved):
            switch outcome {
            case .works where saved: return ("Jev took the key. It's in your login keychain.", false)
            case .noCredits where saved: return ("This key works, but its account has no credits. Add credits at console.typesafe.ai.", true)
            case .works, .noCredits: return ("Jev took the key, but your keychain didn't save it. Try again.", true)
            case .rejected: return ("Jev didn't accept this key. Check that you copied all of it.", true)
            case .unreachable: return ("Caret couldn't reach Jev. Check your connection, then try again.", true)
            case .unclear: return ("Jev couldn't check the key just now. Try again in a moment.", true)
            }
        }
    }

    var body: some View {
        let line = Self.line(draft)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                FieldLabel(text: OnboardingCopy.On.keyLabel).frame(width: 30, alignment: .leading)
                EntryField(title: "Jev key", text: draft.text.reveal, placeholder: OnboardingCopy.On.keyPlaceholder,
                           showsFocus: draft.phase != .checking, focusNow: line?.problem == true, focusToken: draft.submits,
                           enabled: draft.phase != .checking, secure: true, onChange: { send(.setJevKey($0)) }, onSubmit: { send(.next) })
            }
            Text(line?.text ?? OnboardingCopy.On.keyNote)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: line?.problem == true ? Tokens.ink : Tokens.ink2))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The whole privacy promise in a hairline box with a scroller that stays visible, 120 pt tall (HANDOFF §6: a fade
/// read as clipped text, and a disclosure would hide the promise at the one moment it matters).
struct PromiseBox: View {
    var promise: PrivacyPromise?

    var body: some View {
        Block {
            Group {
                if let promise {
                    PrivacyPromiseText(promise: promise)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        GroupHead(text: PrivacyPromiseText.missingTitle)
                        Text(PrivacyPromiseText.missingLine).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(height: 120, alignment: .top)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(OnboardingCopy.On.promiseLabel)
    }
}

/// The promise's blocks, scrolling. `bundled` reads PrivacyPromise.txt, which every app build writes and refuses to
/// finish without (scripts/privacy_gate.sh); nil only without an app bundle (swift run, xctest).
struct PrivacyPromiseText: View {
    static let bundled = { () -> PrivacyPromise? in
        guard let url = Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return PrivacyPromise(text)
    }()
    static let missingTitle = "No privacy promise in this build"
    static let missingLine = "PrivacyPromise.txt is missing or empty, so this screen can't say what Caret sends. Development runs have no app bundle; apps/caret/scripts/build-app.sh writes the file into the app."

    var promise: PrivacyPromise

    var body: some View {
        ScrollingColumn(indicators: .visible) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(promise.blocks.enumerated()), id: \.offset) { index, block in
                    let gap = index == 0 ? 0 : Self.gap(after: promise.blocks[index - 1], before: block)
                    switch block {
                    case .heading(let text):
                        GroupHead(text: text).padding(.top, gap)
                    case .paragraph(let text):
                        Text(text)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(token: Tokens.secondary))
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, gap)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.trailing, 10)
        }
    }

    /// 4 under a heading; 8 between paragraphs; 14 before a new heading.
    static func gap(after previous: PrivacyPromise.Block, before block: PrivacyPromise.Block) -> CGFloat {
        switch (previous, block) {
        case (.heading, _): return 4
        case (.paragraph, .paragraph): return 8
        case (.paragraph, .heading): return 14
        }
    }
}

// MARK: - 4. The first step

/// What the look found, in the person's own app, with the keys that take it; or nothing. Under the offer, the one trust
/// sentence. Calendar is asked by macOS at the first accept of an event, with the hint saying why.
struct FirstPane: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    var animated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            if let found = state.firstLookFound, !state.first.declined {
                ScreenTitle(title: OnboardingCopy.First.title, detail: OnboardingCopy.First.lead(app: found.window.appName, title: found.window.title))
                FoundOffer(found: found, run: state.first.run, character: character, animated: animated).padding(.top, 18)
                trust.padding(.top, 22)
                SwappingLine(key: hintKey(found), animated: animated) { hint(found) }.padding(.top, 10)
            } else if state.first.declined {
                ScreenTitle(title: OnboardingCopy.First.declinedTitle, detail: OnboardingCopy.First.declinedHint)
            } else {
                ScreenTitle(title: OnboardingCopy.First.nothingTitle, detail: OnboardingCopy.First.nothing)
                trust.padding(.top, 18)
            }
            Spacer(minLength: 0)
            Text(OnboardingCopy.First.menuBar).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2)).padding(.bottom, 8)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
    }

    private var trust: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(OnboardingCopy.First.trust)
            Text(OnboardingCopy.First.soon)
                .font(.system(size: 11))
                .padding(.horizontal, 5)
                .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(Color(token: Tokens.rule), lineWidth: 1) }
            Text(OnboardingCopy.First.undo)
        }
        .font(.system(size: 13))
        .foregroundStyle(Color(token: Tokens.ink))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private func hintKey(_ found: FirstLookReply.Found) -> String {
        if state.first.calendar == .asking { return OnboardingCopy.First.asking }
        if state.first.calendar == .denied { return OnboardingCopy.First.denied }
        if case .done? = state.first.run?.phase { return OnboardingCopy.First.doneHint }
        return OnboardingCopy.hint(for: found).map { "\($0.key) \($0.words)" }.joined(separator: " ")
    }

    @ViewBuilder
    private func hint(_ found: FirstLookReply.Found) -> some View {
        Group {
            if state.first.calendar != nil || state.first.run != nil {
                Text(hintKey(found))
            } else {
                HStack(spacing: 6) {
                    ForEach(Array(OnboardingCopy.hint(for: found).enumerated()), id: \.offset) { _, h in
                        Keycap(text: h.key)
                        Text(h.words)
                    }
                }
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(Color(token: Tokens.ink2))
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The first look's offer, ready to take: the card with the keys that take it. Once taken, the action bar gives way to
/// the work line under the card (`WorkLines`): working, then its result. The line enters at 160 ms out with a 2 pt rise;
/// under Reduce Motion it fades only.
struct FoundOffer: View {
    var found: FirstLookReply.Found
    var run: FirstLookRun?
    var character: FigureCharacter
    var animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let line = run?.line()
        VStack(alignment: .leading, spacing: 10) {
            PopupView(
                spec: run == nil ? Self.takeable(found.spec) : Self.withoutActions(found.spec), character: character,
                figure: run == nil ? nil : .absent, animated: false, showsEsc: false
            )
                .accessibilityElement(children: .combine)
            if let line {
                // Still: onboarding allows one loop (the spinner), and the line appears because a key was pressed.
                LineView(content: line.content, character: character, animated: false)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(line.text)
            }
        }
        // Once per phase, not every second of its counter.
        .onChange(of: run?.phase.name) { _, _ in
            guard animated, let text = run?.line()?.text else { return }
            AccessibilityNotification.Announcement(text).post()
        }
    }

    /// The card with only the actions Tab and Command-digits take here.
    static func takeable(_ spec: PopupSpec) -> PopupSpec {
        var copy = spec
        copy.blocks = copy.blocks.compactMap { block in
            guard case .actions(var actions) = block.content else { return block }
            actions.items.removeAll { !$0.takenDirectly }
            guard !actions.items.isEmpty else { return nil }
            var kept = block
            kept.content = .actions(actions)
            return kept
        }
        return copy
    }

    /// The card once taken: its keys did their work, so its action bar goes.
    static func withoutActions(_ spec: PopupSpec) -> PopupSpec {
        var copy = spec
        copy.blocks.removeAll { if case .actions = $0.content { return true } else { return false } }
        return copy
    }
}
