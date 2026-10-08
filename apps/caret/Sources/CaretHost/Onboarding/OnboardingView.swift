import CaretHostCore
import CaretScreenCore
import SwiftUI

/// Onboarding's six screens, drawn from `OnboardingFlow.State` (`SURFACES.md` section 7, with
/// the A7 brief's order and the Fable plan's copy fixes). Every control is drawn here in SwiftUI,
/// not taken from AppKit, so the off-screen renders show exactly what the window shows.
///
/// Copy is third person throughout ("Caret ..."), sentence case, with no dashes for punctuation and no
/// all-caps labels. v3 (DIRECTION.md 5.9): headlines in Caret's serif voice, Continue as the ink
/// button, Back as quiet text, and Carrot only on the figure and the current dot (and on a field
/// Caret is about to fill, which is the product being shown, not chrome).
///
/// Motion, all rare (this window opens once): screens crossfade with a 6 pt slide the way the user
/// moved (160 ms ease-out); the figure performs once on the first screen (arrives, reads the line,
/// bows); a grant's check and the try-it fill state what changed. Reduce Motion keeps the fades
/// and drops every movement.
///
/// A step is a `StepPage`: its title, an optional line, then its content, at the insets every step
/// shares. The bar (Back, the dots, Continue) and the keys (Return, Esc) belong to this view and the
/// controller, so a new step adds a case to `OnboardingFlow.Step` and a page here, nothing else.
struct OnboardingView: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    /// False for off-screen renders: every element in its end state, nothing scheduled.
    var animated = true
    var send: (OnboardingFlow.Event) -> Void = { _ in }
    /// What the permissions step shows as the privacy promise. The window reads the bundle; renders pass their own text.
    var promise = PermissionsScreen.privacyLine

    /// DIRECTION.md's 520 by 460.
    static let size = CGSize(width: 520, height: 460)
    /// Every step's insets: 36 at the sides, 34 above the title.
    static let inset: CGFloat = 36
    static let top: CGFloat = 34

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                screen
                    .id(state.step)
                    .transition(transition)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .animation(animated ? Motion.curve(Motion.easeOut, 0.16) : nil, value: state.step)
            bar
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .background(Color(token: Tokens.window))
    }

    private var transition: AnyTransition {
        guard animated, !reduceMotion else { return .opacity }
        let dx: CGFloat = state.direction == .forward ? 6 : -6
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(x: dx)),
            removal: .opacity.combined(with: .offset(x: -dx))
        )
    }

    @ViewBuilder
    private var screen: some View {
        switch state.step {
        case .welcome: WelcomeScreen(character: character, animated: animated)
        case .work: WorkScreen(state: state, send: send)
        case .know: KnowScreen(state: state, send: send)
        case .permissions: PermissionsScreen(state: state, promise: promise, animated: animated, send: send)
        case .jevKey: JevKeyScreen(state: state, animated: animated, send: send)
        case .tryIt: TryItScreen(state: state, character: character, animated: animated)
        case .firstLook: FirstLookScreen(state: state, character: character, animated: animated, send: send)
        }
    }

    /// Back on the left from the second screen, a dot per screen in the middle, the primary on the
    /// right, with Skip beside it on the screen that can be skipped.
    /// Return and Esc are the window's (`OnboardingController`), so they work from anywhere.
    private var bar: some View {
        ZStack {
            // A flow of one step (a returning user's permissions, the menu's key item) has no place to show.
            if state.steps.count > 1 {
                StepDots(current: state.stepIndex, count: state.steps.count)
            }
            HStack {
                if state.canGoBack {
                    Button("Back") { send(.back) }.buttonStyle(QuietButtonStyle(size: 13))
                        .disabled(state.step == .jevKey && state.jevKey.phase == .checking)
                }
                Spacer()
                if state.step == .know || (state.step == .jevKey && !state.jevKey.phase.saved) {
                    Button("Skip") { send(.skip) }.buttonStyle(QuietButtonStyle(size: 13)).padding(.trailing, 8)
                        .disabled(state.jevKey.phase == .checking)
                }
                Button(state.step == .firstLook || state.only != nil ? "Done" : "Continue") { send(.next) }
                    .buttonStyle(OnboardingButtonStyle(kind: .primary))
                    .disabled(!state.canContinue)
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 22)
        .padding(.top, 8)
    }
}

/// One step's page: the title in Caret's voice, an optional line under it, then the step's own
/// content, at the insets every step shares.
struct StepPage<Content: View>: View {
    var title: String
    var detail: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: title, detail: detail)
            content.padding(.top, 18)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
    }
}

// MARK: - Shared parts

/// A step's heading: Caret speaking, in the voice at display size (New York 22, tracking -0.3), and
/// an optional 13 pt Ink 2 line under it.
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

/// One dot per step: the current one Carrot and larger (7 pt against 5, so it does not rest on
/// color alone), the rest Ink 3 (a mark, 3.8:1 on the window).
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

/// The step's buttons, as v3 draws every button in Caret's windows (`WindowButtonStyle`): primary
/// is the ink button (Continue, Done), secondary is key-styled (Open System Settings, Look again).
struct OnboardingButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary }
    var kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        WindowButtonBody(label: configuration.label, pressed: configuration.isPressed, kind: kind == .primary ? .ink : .key, small: false)
    }
}

/// A group of rows on the window: a hairline block, radius 10, no fill of its own (DIRECTION.md:
/// no cards).
struct OnboardingCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        Block { content }
    }
}

// MARK: - 1. Welcome

/// The only place the figure performs (DIRECTION.md 5.9), once, at 64 pt: it arrives (160 ms,
/// opacity, a 2 pt rise, scale 0.9 to 1), at 420 ms looks down at the headline, at 720 ms bows
/// (520 ms: 1.06 wide by 0.9 tall with a 1 pt dip at 45 percent), then settles into the 4 s breath.
/// This is the delight budget, spent once. Under Reduce Motion it is simply there, looking at the
/// words, and still.
struct WelcomeScreen: View {
    var character: FigureCharacter
    var animated: Bool

    static let headline = "Caret works where you type."
    static let line = "It offers the next words, and sometimes the next step. Tab takes it. Typing says no."
    static let loginLine = "Caret starts when you log in. You can turn that off in Login Items."

    enum Beat { case before, entered, looking, bowing, rest }
    @State private var beat: Beat = Self.performed ? .rest : .before
    /// The performance happens once per launch: Back to this screen finds the figure already there.
    @MainActor static var performed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            FigureView(character: character, state: .noticed, size: Tokens.FigureSize.onboarding, animated: !still, gaze: gaze)
                .keyframeAnimator(initialValue: Bow.rest, trigger: beat == .bowing) { figure, bow in
                    figure.scaleEffect(x: bow.x, y: bow.y, anchor: .bottom).offset(y: bow.dip)
                } keyframes: { _ in Bow.track(active: beat == .bowing) }
                .keyframeAnimator(initialValue: Gesture.rest, repeating: beat == .rest && !still) { figure, g in
                    figure.scaleEffect(x: g.scaleX, y: g.scaleY, anchor: .bottom)
                } keyframes: { _ in Gesture.breath(active: beat == .rest && !still) }
                .opacity(shown ? 1 : 0)
                .scaleEffect(shown ? 1 : 0.9, anchor: .bottom)
                .offset(y: shown ? 0 : 2)
                .padding(.bottom, 26)
            Text(Self.headline)
                .font(Tokens.Font.voiceDisplay(.newYork))
                .tracking(-0.3)
                .foregroundStyle(Color(token: Tokens.ink))
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(Self.line)
                .font(.system(size: 13))
                .foregroundStyle(Color(token: Tokens.ink2))
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .frame(maxWidth: 360)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 9)
            Spacer(minLength: 0)
            // Opening Caret made it a login item (SMAppService agent, H4); say so on the first screen.
            // Room below, so it reads as the page's last line rather than a caption on Continue.
            Text(Self.loginLine)
                .font(Tokens.Font.chromeSmall)
                .foregroundStyle(Color(token: Tokens.ink2))
                .multilineTextAlignment(.center)
                .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
        .task {
            guard !still, beat == .before else { return }
            Self.performed = true
            withAnimation(Motion.curve(Motion.easeOut, Motion.Duration.figureEnter)) { beat = .entered }
            try? await Task.sleep(for: .milliseconds(420))
            beat = .looking
            try? await Task.sleep(for: .milliseconds(300))
            beat = .bowing
            try? await Task.sleep(for: .milliseconds(Int(Motion.Duration.bow * 1000)))
            beat = .rest
        }
    }

    private var still: Bool { !animated || reduceMotion }
    private var shown: Bool { still || beat != .before }

    /// Out at the user as it arrives, then down at the headline (the figure's glance, 140 ms).
    private var gaze: CGVector {
        if still { return CGVector(dx: 0, dy: 0.8) }
        switch beat {
        case .before, .entered: return CGVector(dx: 0, dy: 0.001)
        case .looking, .bowing, .rest: return CGVector(dx: 0, dy: 0.8)
        }
    }

    /// The bow: wider and shorter about the bottom edge with a 1 pt dip, peaking at 45 percent of
    /// 520 ms, ease-in-out both ways.
    struct Bow: Animatable {
        var x: CGFloat = 1
        var y: CGFloat = 1
        var dip: CGFloat = 0
        static let rest = Bow()

        var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, CGFloat> {
            get { AnimatablePair(AnimatablePair(x, y), dip) }
            set {
                x = newValue.first.first
                y = newValue.first.second
                dip = newValue.second
            }
        }

        static func track(active: Bool) -> some Keyframes<Bow> {
            KeyframeTrack(\Bow.self) {
                if active {
                    CubicKeyframe(Bow(x: 1.06, y: 0.9, dip: 1), duration: Motion.Duration.bow * 0.45)
                    CubicKeyframe(.rest, duration: Motion.Duration.bow * 0.55)
                } else {
                    CubicKeyframe(.rest, duration: 0.01)
                }
            }
        }
    }
}

// MARK: - 2. How you want to work

struct WorkScreen: View {
    var state: OnboardingFlow.State
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: "How should Caret work with you?")
            SectionLabel(text: "Help with").padding(.top, 14)
            VStack(alignment: .leading, spacing: 2) {
                ForEach(CaretRole.allCases, id: \.self) { role in
                    RoleRow(role: role, on: state.roles.contains(role)) { send(.toggleRole(role)) }
                }
            }
            .padding(.top, 6)
            SectionLabel(text: CaretLevel.question).padding(.top, 12)
            LevelPicker(level: state.level) { send(.setLevel($0)) }.padding(.top, 8)
            Text(state.roles.isEmpty ? "Choose at least one kind of help to continue." : state.level.detail)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
            Text("You can change these from the menu bar.")
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .padding(.top, 2)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
    }
}

/// A group's name: the windows' group head (Chrome 12 semibold, Ink 2), sentence case.
struct SectionLabel: View {
    var text: String

    var body: some View {
        GroupHead(text: text)
    }
}

/// A checkbox row: the whole row toggles. The box is Ink with a check when on, an Ink 2 outline
/// when off (3:1 against the window either way).
struct RoleRow: View {
    var role: CaretRole
    var on: Bool
    var toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                CheckBox(on: on).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                VStack(alignment: .leading, spacing: 1) {
                    Text(role.title).font(.system(size: 13)).foregroundStyle(Color(token: Tokens.ink))
                    Text(role.detail).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary))
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(role.title)
        .accessibilityHint(role.detail)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(on ? "On" : "Off")
    }
}

struct CheckBox: View {
    var on: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)
        ZStack {
            if on {
                // Ink, not Carrot: the light is the figure's (DIRECTION.md 5.9).
                shape.fill(Color(token: Tokens.inkFill))
                Path { p in
                    p.move(to: CGPoint(x: 4, y: 8.2))
                    p.addLine(to: CGPoint(x: 6.8, y: 11))
                    p.addLine(to: CGPoint(x: 12, y: 5.2))
                }
                .stroke(Color(token: Tokens.onInk), style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
            } else {
                shape.strokeBorder(Color(token: Tokens.ink2), lineWidth: 1.5)
            }
        }
        .frame(width: 16, height: 16)
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

/// Three segments; the chosen one lifts onto the card color with a border, the others stay flat.
/// No motion between them: it is a choice, not a journey.
struct LevelPicker: View {
    var level: CaretLevel
    var choose: (CaretLevel) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(CaretLevel.allCases, id: \.self) { option in
                let chosen = option == level
                Button { choose(option) } label: {
                    Text(option.title)
                        .font(.system(size: 13, weight: chosen ? .semibold : .regular))
                        // Ink on both: Secondary on the track is 3.9:1, under 4.5:1. The chosen
                        // segment is told apart by its card, border and weight.
                        .foregroundStyle(Color(token: Tokens.ink))
                        .frame(maxWidth: .infinity)
                        .frame(height: 26)
                        .background {
                            if chosen {
                                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(token: Tokens.card))
                                RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(option.title)
                .accessibilityHint(option.detail)
                .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(2)
        .background(Color(token: Tokens.border), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .frame(width: 300)
    }
}

// MARK: - 3. What Caret knows so far

/// The Fable plan's minute two: the first view of memory, typed by hand (no Contacts in A11).
/// Continue hands what was typed to memory; Skip keeps nothing. The wording is pinned by
/// `OnboardingHostTests.testTheKnowScreensWordingIsPinned`.
struct KnowScreen: View {
    static let title = "What Caret knows so far."
    static let detail = "Type your name and email, and Caret can fill them in for you."
    /// The step shows only when the helper says it keeps typed values (`OnboardingFlow.State.showsKnow`),
    /// so Continue does hand them to something that saves them; the footnote says what Continue
    /// does, not that it is done.
    static let footnote = "Continue saves these on this Mac. When Caret works out what to fill, they may go to its cloud model. Change or remove them any time in What Caret Knows, in the menu bar."
    static let namePlaceholder = "Your name"
    static let emailPlaceholder = "you@example.com"

    var state: OnboardingFlow.State
    var send: (OnboardingFlow.Event) -> Void

    /// Where focus is: the email after Continue found a problem with it, else the name until it
    /// holds something. On screen the problem moves focus there; off screen it draws the ring.
    private var focus: AboutField {
        if state.about.showsProblem, let field = state.about.problemField { return field }
        return state.about.name.isEmpty ? .name : .email
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: Self.title, detail: Self.detail)
            OnboardingCard {
                VStack(spacing: 0) {
                    row(.name, placeholder: Self.namePlaceholder)
                    Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.leading, 14)
                    row(.email, placeholder: Self.emailPlaceholder)
                }
            }
            .padding(.top, 18)
            if state.about.showsProblem, let problem = state.about.problem {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .padding(.top, 8)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            Text(Self.footnote)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 14)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
    }

    private func row(_ field: AboutField, placeholder: String) -> some View {
        HStack(spacing: 12) {
            FieldLabel(text: field.label).frame(width: 44, alignment: .leading)
            EntryField(
                title: field.label, text: state.about[field], placeholder: placeholder,
                autofocus: field == .name, showsFocus: focus == field,
                focusNow: state.about.showsProblem && state.about.problemField == field,
                onChange: { send(.setAbout(field, $0)) }
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

// MARK: - 4. Permissions

struct PermissionsScreen: View {
    /// The bundle's PrivacyPromise.txt, which every app build writes from `PRIVACY_PROMISE` and refuses to finish
    /// without (scripts/privacy_gate.sh). Nil only without an app bundle, as under `swift run`. No fallback text: a
    /// copy here would drift from the approved one.
    static let privacyLine = { () -> PrivacyPromise? in
        guard let url = Bundle.main.url(forResource: "PrivacyPromise", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return PrivacyPromise(text)
    }()
    /// Only a development run can lack the resource, so this speaks to whoever is building Caret.
    static let missingPromiseTitle = "No privacy promise in this build"
    static let missingPromiseLine = "PrivacyPromise.txt is missing or empty, so this screen can't say what Caret sends. Development runs have no app bundle; apps/caret/scripts/build-app.sh writes the file into the app."

    var state: OnboardingFlow.State
    var promise: PrivacyPromise?
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(
                title: "Let Caret see where you type.",
                detail: "Accessibility lets Caret read the field you're in and the windows around it, and put text there when you press Tab."
            )
            OnboardingCard {
                VStack(spacing: 0) {
                    PermissionRow(
                        title: "Accessibility", optional: false, detail: nil,
                        granted: state.permissions.accessibility, animated: animated
                    ) { send(.openSystemSettings(.accessibility)) }
                    if state.showsInputMonitoring {
                        Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.leading, 40)
                        PermissionRow(
                            title: "Input Monitoring", optional: true,
                            detail: "Lets a click anywhere pause work Caret is doing for you.",
                            granted: state.permissions.inputMonitoring, animated: animated
                        ) { send(.openSystemSettings(.inputMonitoring)) }
                    }
                    Rectangle().fill(Color(token: Tokens.border)).frame(height: 1).padding(.leading, 40)
                    // No check mark: the host cannot tell yet whether the extension is loaded, so the row only offers.
                    // No detail line either: the window's height holds three rows only without one.
                    PermissionRow(
                        title: "Caret for Chrome", optional: true, detail: nil,
                        granted: false, animated: animated, actionTitle: "Add to your browser…", announcesState: false
                    ) { send(.addToChrome) }
                }
            }
            .padding(.top, 18)
            if !state.permissions.accessibility {
                Text("This screen moves on by itself once Accessibility is on.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.secondary))
                    .padding(.top, 10)
            }
            Group {
                if let promise {
                    PrivacyPromiseText(promise: promise)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        GroupHead(text: Self.missingPromiseTitle)
                        Text(Self.missingPromiseLine)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(token: Tokens.ink))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 16)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

/// The whole promise scrolls in the height the permission card leaves, so reading it never pushes the permission
/// controls out of the fixed window. Its foot fades out to show there is more; the bottom padding lets the last line
/// scroll clear of that fade.
struct PrivacyPromiseText: View {
    var promise: PrivacyPromise

    static let fade: CGFloat = 18

    var body: some View {
        ScrollingColumn {
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
            // Room for the overlay scroller at the right, and for the last line to clear the fade.
            .padding(.trailing, 10)
            .padding(.bottom, Self.fade)
        }
        .mask {
            VStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: Self.fade)
            }
        }
        .scrollIndicatorsFlash(onAppear: true)
    }

    /// 4 under a heading, as a group head sits over its rows; 8 between paragraphs; 14 before a new heading.
    static func gap(after previous: PrivacyPromise.Block, before block: PrivacyPromise.Block) -> CGFloat {
        switch (previous, block) {
        case (.heading, _): return 4
        case (.paragraph, .paragraph): return 8
        case (.paragraph, .heading): return 14
        }
    }
}

/// One grant: a ring while it is off, an Ink check once it is on, and the button that opens
/// System Settings at the right pane. The check enters at 160 ms ease-out from 0.9 (state
/// indication); under Reduce Motion it fades only.
struct PermissionRow: View {
    var title: String
    var optional: Bool
    var detail: String?
    var granted: Bool
    var animated: Bool
    var actionTitle = "Open System Settings"
    /// False for a row whose state the host cannot read (Caret for Chrome): VoiceOver hears no "on" or "off".
    var announcesState = true
    var open: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
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
                    .transition(animated && !reduceMotion ? .opacity.combined(with: .scale(scale: 0.9)) : .opacity)
                }
            }
            .frame(width: 18, height: 18)
            .animation(animated ? Motion.curve(Motion.easeOut, 0.16) : nil, value: granted)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
                    if optional { Text("Optional").font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary)) }
                }
                if let detail {
                    Text(detail).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if granted {
                Text("On").font(.system(size: 13)).foregroundStyle(Color(token: Tokens.secondary))
            } else {
                Button(actionTitle, action: open).buttonStyle(OnboardingButtonStyle(kind: .secondary))
            }
        }
        .padding(.horizontal, 14)
        // 10, not 12: with Caret for Chrome as a third row, 12 made the permissions step taller than
        // the 460 pt window under v3's serif title (the bar was pushed down and the title up, I5).
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(announcesState ? "\(title), \(granted ? "on" : "off")" : title)
    }
}

// MARK: - 4b. The Jev key

/// H12: one paste field for the key of Jev, the cloud model that decides what Caret offers, and the answer of the one
/// request that checks it (`JevKeyCheck`). Skippable: without a key the helper runs without Jev and the menu says so.
/// The key goes to the login keychain only after Jev's answer shows it authenticates (`Outcome.keepsKey`).
///
/// The line under the field states what happened, in place: it enters at 160 ms ease-out with a 2 pt rise (state
/// indication, as the first look's line does); under Reduce Motion it fades only. VoiceOver hears each new line once.
struct JevKeyScreen: View {
    static let title = "Add your Jev key."
    static let detail = "Jev is the cloud model that decides what Caret offers, like which value goes in a field. Paste your TypeSafe API key to turn it on."
    static let placeholder = "Paste your key"
    static let footnote = "Caret keeps the key in your login keychain and checks it with one small request. Without a key, Caret still writes the next words, but filling forms and next steps need Jev."
    static let storedLine = "Caret has a key saved. Paste a new one to replace it."

    var state: OnboardingFlow.State
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What the line under the field says, and whether it is a problem the user has to act on (Ink) or a report (Ink 2).
    static func line(_ draft: OnboardingFlow.JevKeyDraft) -> (text: String, problem: Bool, done: Bool)? {
        switch draft.phase {
        case .editing: return draft.stored && draft.text.isEmpty ? (storedLine, false, false) : nil
        case .malformed: return ("That isn't a key. A key has no spaces in it.", true, false)
        case .checking: return ("Checking the key with Jev…", false, false)
        case .checked(let outcome, let saved):
            switch outcome {
            case .works where saved: return ("Jev took the key. It's in your login keychain.", false, true)
            // The coordinator's words for a key whose account is out of credits (H12, 2026-10-05).
            case .noCredits where saved: return ("This key works, but its account has no credits. Add credits at console.typesafe.ai.", true, false)
            case .works, .noCredits: return ("Jev took the key, but your keychain didn't save it. Try again.", true, false)
            case .rejected: return ("Jev didn't accept this key. Check that you copied all of it.", true, false)
            case .unreachable: return ("Caret couldn't reach Jev. Check your connection, then try again.", true, false)
            case .unclear: return ("Jev couldn't check the key just now. Try again in a moment.", true, false)
            }
        }
    }

    var body: some View {
        let draft = state.jevKey
        let line = Self.line(draft)
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: Self.title, detail: Self.detail)
            OnboardingCard {
                HStack(spacing: 12) {
                    FieldLabel(text: "Key").frame(width: 44, alignment: .leading)
                    EntryField(
                        title: "Jev key", text: draft.text.reveal, placeholder: Self.placeholder,
                        autofocus: true, showsFocus: draft.phase != .checking && !draft.phase.saved,
                        // The field is disabled while the check runs, which takes focus away; a problem gives it back,
                        // and so does each Continue that found one.
                        focusNow: line?.problem == true && !draft.phase.saved, focusToken: draft.submits,
                        enabled: draft.phase != .checking, secure: true,
                        onChange: { send(.setJevKey($0)) }
                    )
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .padding(.top, 18)
            ZStack(alignment: .topLeading) {
                if let line {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if line.done { Check().alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 } }
                        Text(line.text)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(token: line.problem ? Tokens.ink : Tokens.secondary))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .id(line.text)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 2)))
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(minHeight: 32, alignment: .topLeading)
            .padding(.top, 8)
            .animation(lineMotion(draft.phase), value: line?.text)
            Text(Self.footnote)
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
        .onChange(of: line?.text) { _, text in
            guard animated, let text else { return }
            AccessibilityNotification.Announcement(text).post()
        }
    }

    /// Only Jev's answer, which arrives on its own a moment after Return, enters with motion. A line Return itself
    /// puts up ("Checking…", "That isn't a key") changes at once: keyboard actions get no animation.
    private func lineMotion(_ phase: OnboardingFlow.JevKeyDraft.Phase) -> Animation? {
        guard animated, case .checked = phase else { return nil }
        return Motion.curve(Motion.easeOut, reduceMotion ? Motion.Duration.reduced : 0.16)
    }

    /// The same Ink check a granted permission shows, at 14 pt.
    private struct Check: View {
        var body: some View {
            ZStack {
                Circle().fill(Color(token: Tokens.inkFill))
                Path { p in
                    p.move(to: CGPoint(x: 4, y: 7.2))
                    p.addLine(to: CGPoint(x: 6.1, y: 9.4))
                    p.addLine(to: CGPoint(x: 10.2, y: 4.8))
                }
                .stroke(Color(token: Tokens.onInk), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
            .frame(width: 14, height: 14)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - 5. Try it

/// A sample source window Caret draws itself (left) and a form whose Amount field is offered the
/// value from it (right). The figure in the source line looks left, at the invoice: where it looks
/// is what it noticed. Only a real Tab fills the field (`OnboardingFlow.tryItKey`).
struct TryItScreen: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    var animated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenTitle(title: "Try it.", detail: "The amount is in the invoice on the left. Press Tab to fill it in.")
            // 196 + 16 + 232 = 444, inside the 448 the step's insets leave.
            HStack(alignment: .top, spacing: 16) {
                SampleSourceWindow(animated: animated)
                SampleForm(tryIt: state.tryIt, character: character, animated: animated)
            }
            .padding(.top, 20)
            hint.padding(.top, 16)
            // Another app that takes Tab can keep it from reaching Caret in other apps (Q1 bugs 17
            // and 18: Cotypist). Ink, not secondary: the user has something to do.
            if let notice = OtherTabOwners.notice(state.otherTabOwners) {
                Text(notice)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
    }

    @ViewBuilder
    private var hint: some View {
        let t = state.tryIt
        HStack(spacing: 6) {
            if t.completed {
                // Ghost text is the offer seen most, so its word key is taught here (A18, bug 17).
                Text("That's it. Tab takes the offer, \u{2325}\u{2192} one word of it. Typing says no.")
            } else if t.offerVisible {
                Keycap(text: "Tab")
                Text("takes it. Keep typing to say no.")
            } else {
                Text("Typing says no. Delete what you typed to see the offer again.")
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(Color(token: Tokens.secondary))
        .accessibilityElement(children: .combine)
    }
}

/// The invoice, as a small window: a monochrome title bar (drawn, so it is not mistaken for a
/// real window), the sender, and the amount with the uneven underline that marks it as the source.
struct SampleSourceWindow: View {
    var animated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { _ in Circle().fill(Color(token: Tokens.secondary)).opacity(0.35).frame(width: 7, height: 7) }
                Spacer()
                Text(TryItSample.sourceApp).font(.system(size: 11)).foregroundStyle(Color(token: Tokens.secondary))
                Spacer()
                Color.clear.frame(width: 31, height: 7)
            }
            .padding(.horizontal, 9)
            .frame(height: 24)
            Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(TryItSample.sender).font(.system(size: 12, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
                Text(TryItSample.sourceTitle).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary))
                Text("Amount due").font(.system(size: 11)).foregroundStyle(Color(token: Tokens.secondary)).padding(.top, 12)
                Text(TryItSample.value)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color(token: Tokens.ink))
                    .overlay(alignment: .bottomLeading) {
                        GeometryReader { geo in UnevenUnderline(width: geo.size.width, animated: animated) }
                            .frame(height: 3)
                            .offset(y: 4)
                    }
                Text("Due October 30").font(.system(size: 11)).foregroundStyle(Color(token: Tokens.secondary)).padding(.top, 8)
            }
            .padding(12)
        }
        .frame(width: 196, alignment: .leading)
        .background(Color(token: Tokens.card), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color(token: Tokens.border), lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sample invoice from \(TryItSample.sender), \(TryItSample.sourceTitle). Amount due \(TryItSample.value).")
    }
}

/// The form: Payee already filled, Amount focused and empty, with the ghost value in it and the
/// source line above its right edge (`SURFACES.md` 5). After Tab the value is real, the field
/// flashes the Carrot wash once (400 ms, state indication), and the line becomes the result.
struct SampleForm: View {
    var tryIt: OnboardingFlow.TryIt
    var character: FigureCharacter
    var animated: Bool
    @State private var wash: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Pay an invoice").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink))
            FieldLabel(text: "Payee").padding(.top, 12)
            SampleField(focused: false) {
                Text(TryItSample.sender).foregroundStyle(Color(token: Tokens.ink))
            }
            .padding(.top, 4)
            HStack(alignment: .bottom) {
                FieldLabel(text: TryItSample.fieldLabel).fixedSize()
                Spacer(minLength: 6)
                line
            }
            .frame(height: 30, alignment: .bottom)
            .padding(.top, 10)
            SampleField(focused: !tryIt.completed, wash: wash) {
                HStack(spacing: 0) {
                    if tryIt.offerVisible {
                        caret
                        Text(TryItSample.value).foregroundStyle(Color(token: Tokens.ink).opacity(0.45))
                    } else {
                        Text(tryIt.value).foregroundStyle(Color(token: Tokens.ink))
                        if !tryIt.completed { caret }
                    }
                }
            }
            .padding(.top, 4)
            .accessibilityElement()
            .accessibilityLabel(TryItSample.fieldLabel)
            .accessibilityValue(fieldValueForVoiceOver)
        }
        .frame(width: 232, alignment: .leading)
        .onChange(of: tryIt.completed) { _, completed in
            guard completed, animated, !reduceMotion else { return }
            wash = 1
            withAnimation(.linear(duration: 0.4)) { wash = 0 }
        }
    }

    /// The line by the field: the offer's source with Tab, then the result once taken.
    @ViewBuilder
    private var line: some View {
        if tryIt.completed {
            LineView(content: LineContent(figure: .done, lead: "Filled", text: "1 field from \(TryItSample.sourceApp)", emphasis: .plain),
                     character: character, compact: true, animated: animated)
        } else if tryIt.offerVisible {
            LineView(content: LineContent(figure: .offering, text: TryItSample.caption, emphasis: .secondary, hints: [Hint(key: "Tab")]),
                     character: character, compact: true, animated: animated, figureFacing: .left)
        }
    }

    private var caret: some View {
        Rectangle().fill(Color(token: Tokens.ink)).frame(width: 1, height: 15)
    }

    private var fieldValueForVoiceOver: String {
        if tryIt.offerVisible { return "Empty. Caret offers \(TryItSample.value) \(TryItSample.caption). Press Tab to fill it in." }
        return tryIt.value.isEmpty ? "Empty" : tryIt.value
    }
}

struct FieldLabel: View {
    var text: String
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.secondary))
    }
}

/// A text field drawn in SwiftUI: 26 tall, radius 5, the text background, a hairline border, and
/// a 2 pt Carrot ring while focused.
struct SampleField<Content: View>: View {
    var focused: Bool
    var wash: Double = 0
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
        content
            .font(.system(size: 13))
            .padding(.horizontal, 7)
            .frame(maxWidth: .infinity, minHeight: 26, maxHeight: 26, alignment: .leading)
            .background(Color(nsColor: .textBackgroundColor), in: shape)
            .overlay { shape.fill(Color(token: Tokens.carrotWash)).opacity(wash) }
            .overlay { shape.strokeBorder(Color(token: Tokens.keycapBorder), lineWidth: 1) }
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .strokeBorder(Color(token: Tokens.carrot).opacity(0.7), lineWidth: 2)
                        .padding(-2)
                }
            }
    }
}

// MARK: - 6. First look

struct FirstLookScreen: View {
    var state: OnboardingFlow.State
    var character: FigureCharacter
    var animated: Bool
    var send: (OnboardingFlow.Event) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch state.firstLook {
            case .idle, .asking:
                figure(.working)
                ScreenTitle(title: "Looking at your open windows…", detail: "Caret runs what you turned on, once, over the windows already open.")
            case .found(let found):
                ScreenTitle(title: "Caret found something.", detail: "In \(found.window.appName), \(found.window.title).")
                FoundOffer(found: found, run: state.firstLookRun, character: character, animated: animated)
                    .padding(.top, 16)
            case .nothing:
                figure(.noticed)
                ScreenTitle(title: "Nothing yet.", detail: "Caret will show up where you type when it has something.")
            case .failed:
                figure(.noticed)
                ScreenTitle(title: "Caret couldn't look just now.", detail: "It will show up where you type when it has something.")
                Button("Look again") { send(.lookAgain) }
                    .buttonStyle(OnboardingButtonStyle(kind: .secondary))
                    .padding(.top, 14)
            }
            Spacer(minLength: 0)
            Text("Caret lives in the menu bar, where you can pause it or change these choices.")
                .font(.system(size: 12))
                .foregroundStyle(Color(token: Tokens.secondary))
        }
        .padding(.horizontal, OnboardingView.inset)
        .padding(.top, OnboardingView.top)
        .padding(.bottom, 8)
    }

    private func figure(_ state: FigureState) -> some View {
        FigureView(character: character, state: state, height: 28, animated: animated)
            .padding(.bottom, 14)
    }

}

/// The first look's offer, ready to take: the card with the keys that take it from here (an
/// action on the down arrow or one that changes the card needs the real surface and is left
/// off). Once
/// taken, the action bar gives way to the work line under the card, the same line the real
/// surfaces draw (`WorkLines`): working, then its result. The line enters at 160 ms ease-out with a
/// 2 pt rise (state indication); under Reduce Motion it fades only. Its words change in place.
struct FoundOffer: View {
    var found: FirstLookReply.Found
    var run: FirstLookRun?
    var character: FigureCharacter
    var animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let line = run?.line()
        VStack(alignment: .leading, spacing: 10) {
            // Esc is Back in this window, so the card shows only the keys that take it. Once taken,
            // the figure leaves the card for the line: one figure, where the work is.
            PopupView(
                spec: run == nil ? Self.takeable(found.spec) : Self.withoutActions(found.spec), character: character,
                figure: run == nil ? nil : .absent, animated: animated, showsEsc: false
            )
                .accessibilityElement(children: .combine)
            if let line {
                LineView(content: line.content, character: character, animated: animated)
                    .transition(animated && !reduceMotion ? .opacity.combined(with: .offset(y: 2)) : .opacity)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(line.text)
            }
        }
        .animation(animated ? Motion.curve(Motion.easeOut, 0.16) : nil, value: line == nil)
        .onChange(of: line?.text) { _, text in
            // The line reports work the user cannot see: VoiceOver hears each change once.
            guard animated, let text else { return }
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
