import AppKit
import CaretHostCore
import SwiftUI

/// Which way the figure faces: toward the text it stands after (left), or toward the words of
/// the line it heads (right).
public enum FigureFacing: Sendable {
    case left, right
}

/// Each character's drawing. The enum itself is CaretHostCore's, so the surface decisions can
/// name the character without SwiftUI.
extension FigureCharacter {
    var drawing: FigureDrawing {
        switch self {
        case .pebble: return Pebble()
        case .seed: return Seed()
        case .wren: return Wren()
        }
    }
}

/// The character in use: `CARET_FIGURE` when set (for screenshots, never saved), else the
/// settings' choice (`SettingsStore`), pebble by default.
@MainActor
public final class FigureSettings: ObservableObject {
    public static let shared = FigureSettings()

    @Published public var character: FigureCharacter {
        didSet {
            guard character != oldValue else { return }
            let chosen = character
            SettingsStore.shared.update(source: .menu) { $0.character = chosen }
        }
    }

    init() {
        let env = ProcessInfo.processInfo.environment["CARET_FIGURE"].flatMap(FigureCharacter.init(rawValue:))
        character = env ?? SettingsStore.shared.settings.character
    }
}

// MARK: - Pose

/// Every transform a character can take, in viewBox units. A state's end pose is one value; the
/// motion between poses is the view's job.
struct FigurePose: Equatable {
    var bodyScale = CGSize(width: 1, height: 1)
    var bodyOffsetY: CGFloat = 0
    var rotation: Double = 0
    var eyeOffset = CGSize.zero
    var eyeScale: CGFloat = 1
    var eyeSquash: CGFloat = 1
    var lids = false
    var headRotation: Double = 0
    /// The light is out: the skin is Graphite and the glow is off.
    var graphite = false
    /// The seed lies on its side.
    var fallen = false
}

/// The figure is light, not paint (v3 DIRECTION.md section 4): a radial gradient from a warm core
/// to a darker rim, a sheen, catchlights, and a glow that touches what it sits on. Error is the
/// light going out: Graphite, no glow.
struct FigureSkin {
    var graphite: Bool

    func fill(in size: CGSize) -> AnyShapeStyle {
        if graphite { return AnyShapeStyle(Color(token: Tokens.graphite)) }
        return AnyShapeStyle(RadialGradient(
            colors: [Color(token: Tokens.skinCore), Color(token: Tokens.skinMid), Color(token: Tokens.skinRim)],
            center: UnitPoint(x: 0.38, y: 0.30), startRadius: 0, endRadius: max(size.width, size.height) * 0.78
        ))
    }

    /// The flat color the body reads as, for parts drawn over it (the lids).
    var flat: Color { Color(token: graphite ? Tokens.graphite : Tokens.skinMid) }
}

protocol FigureDrawing {
    /// The viewBox. The figure's size is its width; height follows the viewBox.
    var viewBox: CGSize { get }
    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose
    /// The perch's pose: the state's pose turned along `gaze` (length at most 1, x right, y down;
    /// zero looks out at the user).
    func pose(for state: FigureState, gaze: CGVector) -> FigurePose
    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView
    /// One silhouette for the menu bar, eyes cut out.
    func glyph() -> Path
}

/// Shapes built from viewBox coordinates and scaled to the frame.
struct ViewBoxShape: Shape {
    let viewBox: CGSize
    let source: Path

    init(viewBox: CGSize, build: (inout Path) -> Void) {
        self.viewBox = viewBox
        var path = Path()
        build(&path)
        source = path
    }

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / viewBox.width, sy = rect.height / viewBox.height
        return source.applying(CGAffineTransform(scaleX: sx, y: sy).translatedBy(x: rect.minX / sx, y: rect.minY / sy))
    }
}

// MARK: - Pebble

/// A glass drop with a lit core and two eyes. Life is the glance: where it looks is what it
/// noticed. Geometry from DIRECTION.md section 4, viewBox 12 by 11.
struct Pebble: FigureDrawing {
    let viewBox = CGSize(width: 12, height: 11)

    static func outline(_ p: inout Path) {
        // M6 .6 C9.6 .6 11.7 2.8 11.7 5.9 11.7 8.8 9.3 10.4 6 10.4 2.7 10.4 .3 8.8 .3 5.9 .3 2.8 2.4 .6 6 .6 Z
        p.move(to: CGPoint(x: 6, y: 0.6))
        p.addCurve(to: CGPoint(x: 11.7, y: 5.9), control1: CGPoint(x: 9.6, y: 0.6), control2: CGPoint(x: 11.7, y: 2.8))
        p.addCurve(to: CGPoint(x: 6, y: 10.4), control1: CGPoint(x: 11.7, y: 8.8), control2: CGPoint(x: 9.3, y: 10.4))
        p.addCurve(to: CGPoint(x: 0.3, y: 5.9), control1: CGPoint(x: 2.7, y: 10.4), control2: CGPoint(x: 0.3, y: 8.8))
        p.addCurve(to: CGPoint(x: 6, y: 0.6), control1: CGPoint(x: 0.3, y: 2.8), control2: CGPoint(x: 2.4, y: 0.6))
        p.closeSubpath()
    }

    static func sheen(_ p: inout Path) {
        p.addEllipse(in: CGRect(x: 4.3 - 2.1, y: 2.7 - 1.05, width: 4.2, height: 2.1))
    }

    static func eyes(_ p: inout Path) {
        for x in [3.9, 8.1] { p.addEllipse(in: CGRect(x: x - 1.05, y: 5 - 1.05, width: 2.1, height: 2.1)) }
    }

    static func catchlights(_ p: inout Path) {
        for x in [3.55, 7.75] { p.addEllipse(in: CGRect(x: x - 0.3, y: 4.65 - 0.3, width: 0.6, height: 0.6)) }
    }

    /// Over the top half of each eye. Drawn in the body's own color, so lowered lids read as
    /// tired eyes; in Ink they read as sunglasses (the prototype's error figure).
    static func lids(_ p: inout Path) {
        for x in [2.65, 6.85] {
            p.addRoundedRect(in: CGRect(x: x, y: 3.8, width: 2.5, height: 1.25), cornerSize: CGSize(width: 0.6, height: 0.6))
        }
    }

    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose {
        var pose = FigurePose()
        let toward: CGFloat = facing == .right ? 1.1 : -1.1
        switch state {
        case .noticed, .offering, .done: pose.eyeOffset = CGSize(width: toward, height: 0)
        case .working: pose.eyeOffset = CGSize(width: 0.9, height: -0.9)
        case .needsYou: pose.eyeScale = 1.25
        case .error:
            pose.graphite = true
            pose.bodyScale = CGSize(width: 1.04, height: 0.9)
            pose.eyeOffset = CGSize(width: 0, height: 0.6)
            pose.lids = true
        case .still, .absent: break
        }
        return pose
    }

    /// The eyes travel 1.1 across and 0.8 up or down, the most the outline allows before an eye
    /// touches the edge. Done keeps its eyes ahead; Error keeps looking down.
    func pose(for state: FigureState, gaze: CGVector) -> FigurePose {
        var pose = pose(for: state, facing: .right)
        switch state {
        case .noticed, .offering, .working, .needsYou, .still:
            pose.eyeOffset = gaze == .zero ? .zero : CGSize(width: gaze.dx * 1.1, height: gaze.dy * 0.8)
        case .done, .error, .absent:
            break
        }
        return pose
    }

    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
            ZStack {
                ViewBoxShape(viewBox: box, build: Self.outline).fill(skin.fill(in: geo.size))
                ViewBoxShape(viewBox: box, build: Self.sheen).fill(Color.white.opacity(pose.graphite ? 0.08 : 0.26))
                ZStack {
                    ZStack {
                        ViewBoxShape(viewBox: box, build: Self.eyes).fill(Color(token: Tokens.eye))
                        ViewBoxShape(viewBox: box, build: Self.catchlights).fill(Color.white.opacity(0.85))
                    }
                    .scaleEffect(x: 1, y: pose.eyeSquash, anchor: UnitPoint(x: 0.5, y: 5 / box.height))
                    ViewBoxShape(viewBox: box, build: Self.lids).fill(skin.flat.opacity(pose.lids ? 1 : 0))
                }
                .scaleEffect(pose.eyeScale, anchor: UnitPoint(x: 0.5, y: 5 / box.height))
                .offset(x: pose.eyeOffset.width * k, y: pose.eyeOffset.height * k)
            }
            .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: .bottom)
            .offset(y: pose.bodyOffsetY * k)
        })
    }

    func glyph() -> Path {
        var p = Path()
        Self.outline(&p)
        Self.eyes(&p)
        return p // even-odd cuts the eyes out
    }
}

// MARK: - Seed

/// The proofreader's mark with weight. Life is posture only. Kept as a choice in settings, lit
/// like the pebble.
struct Seed: FigureDrawing {
    let viewBox = CGSize(width: 10, height: 12)

    static func outline(_ p: inout Path) {
        // M5 .5 C6.9 2.6 10 5.4 10 7.6 A5 4.4 0 0 1 0 7.6 C0 5.4 3.1 2.6 5 .5 Z; the arc as two
        // quarter-ellipse curves.
        let k: CGFloat = 0.5523
        p.move(to: CGPoint(x: 5, y: 0.5))
        p.addCurve(to: CGPoint(x: 10, y: 7.6), control1: CGPoint(x: 6.9, y: 2.6), control2: CGPoint(x: 10, y: 5.4))
        p.addCurve(to: CGPoint(x: 5, y: 12), control1: CGPoint(x: 10, y: 7.6 + 4.4 * k), control2: CGPoint(x: 5 + 5 * k, y: 12))
        p.addCurve(to: CGPoint(x: 0, y: 7.6), control1: CGPoint(x: 5 - 5 * k, y: 12), control2: CGPoint(x: 0, y: 7.6 + 4.4 * k))
        p.addCurve(to: CGPoint(x: 5, y: 0.5), control1: CGPoint(x: 0, y: 5.4), control2: CGPoint(x: 3.1, y: 2.6))
        p.closeSubpath()
    }

    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose {
        var pose = FigurePose()
        let lean: Double = facing == .right ? 10 : -10
        switch state {
        case .noticed, .done, .still, .absent: break
        case .offering: pose.rotation = lean
        case .working, .needsYou: pose.bodyOffsetY = -2
        case .error:
            pose.graphite = true
            pose.fallen = true
        }
        return pose
    }

    func pose(for state: FigureState, gaze: CGVector) -> FigurePose {
        var pose = pose(for: state, facing: .right)
        switch state {
        case .noticed, .offering, .working, .needsYou, .still: pose.rotation = Double(gaze.dx) * 10
        case .done, .error, .absent: break
        }
        return pose
    }

    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
            ViewBoxShape(viewBox: box, build: Self.outline).fill(skin.fill(in: geo.size))
                .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: .bottom)
                .rotationEffect(.degrees(pose.fallen ? -90 : pose.rotation), anchor: .bottom)
                .offset(y: (pose.fallen ? -5 : pose.bodyOffsetY) * k)
        })
    }

    func glyph() -> Path {
        var p = Path()
        Self.outline(&p)
        return p
    }
}

// MARK: - Wren

/// A small bird on your line. Life is gesture: head tilt, hop. Kept as a choice in settings, lit
/// like the pebble.
struct Wren: FigureDrawing {
    let viewBox = CGSize(width: 14, height: 12)
    /// The neck, 18% and 92% of the head group's box (head circle and beak).
    static let neck = UnitPoint(x: (7 + 0.18 * 6.9) / 14, y: (1.8 + 0.92 * 5.2) / 12)

    static func tail(_ p: inout Path) {
        p.move(to: CGPoint(x: 3.6, y: 6.6))
        p.addLine(to: CGPoint(x: 0.5, y: 4.5))
        p.addLine(to: CGPoint(x: 1.5, y: 7.6))
        p.addLine(to: CGPoint(x: 1, y: 9.6))
        p.addLine(to: CGPoint(x: 3.8, y: 8.4))
        p.closeSubpath()
    }

    static func body(_ p: inout Path) {
        p.addEllipse(in: CGRect(x: 3, y: 3.3, width: 8, height: 8))
    }

    static func head(_ p: inout Path) {
        p.addEllipse(in: CGRect(x: 7, y: 1.8, width: 5.2, height: 5.2))
        p.move(to: CGPoint(x: 11.9, y: 3.8))
        p.addLine(to: CGPoint(x: 13.9, y: 4.6))
        p.addLine(to: CGPoint(x: 11.9, y: 5.4))
        p.closeSubpath()
    }

    static func eye(_ p: inout Path) {
        p.addEllipse(in: CGRect(x: 10.3 - 0.7, y: 3.9 - 0.7, width: 1.4, height: 1.4))
    }

    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose {
        var pose = FigurePose()
        switch state {
        case .noticed, .offering: pose.headRotation = -14
        case .working: pose.headRotation = -34
        case .done, .still, .absent: break
        case .needsYou: pose.headRotation = -28
        case .error:
            pose.graphite = true
            pose.headRotation = 24
            pose.bodyScale = CGSize(width: 1.08, height: 0.9)
        }
        return pose
    }

    func pose(for state: FigureState, gaze: CGVector) -> FigurePose {
        var pose = pose(for: state, facing: .right)
        switch state {
        case .noticed, .offering, .working, .needsYou, .still: pose.headRotation += Double(gaze.dy) * 20
        case .done, .error, .absent: break
        }
        return pose
    }

    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let fill = skin.fill(in: geo.size)
            ZStack {
                // Separate shapes: in one path the tail and body wind opposite ways and the overlap
                // fills as a hole.
                ViewBoxShape(viewBox: box, build: Self.tail).fill(fill)
                ViewBoxShape(viewBox: box, build: Self.body).fill(fill)
                ZStack {
                    ViewBoxShape(viewBox: box, build: Self.head).fill(fill)
                    ViewBoxShape(viewBox: box, build: Self.eye).fill(Color(token: Tokens.eye))
                }
                .rotationEffect(.degrees(pose.headRotation), anchor: Self.neck)
            }
            .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: .bottom)
            .offset(y: pose.bodyOffsetY * geo.size.width / box.width)
        })
    }

    func glyph() -> Path {
        var tail = Path(), body = Path(), head = Path(), eye = Path()
        Self.tail(&tail)
        Self.body(&body)
        Self.head(&head)
        Self.eye(&eye)
        var p = Path(tail.cgPath.union(body.cgPath).union(head.cgPath))
        p.addPath(eye)
        return p
    }
}

// MARK: - Motion plan

/// Which of the figure's motions run, decided apart from the drawing so a test can hold the
/// Reduce Motion rule: every repeating motion and every gesture stops, and postures jump.
struct FigureMotion: Equatable {
    /// Offering at text size: 1.035 by 1.025 over 4 s.
    var breathes = false
    /// Offering and needs you: every 5 s, 150 ms.
    var blinks = false
    /// Done's squash and squint, needs you's two bobs.
    var gesture = false
    /// Done: the glow to 2.4 times its radius and back.
    var glowPulse = false
    /// Seconds for a change of posture; nil jumps.
    var posture: Double?

    static func plan(state: FigureState, animated: Bool, reduce: Bool, perched: Bool) -> FigureMotion {
        guard animated, !reduce, state != .absent else { return FigureMotion() }
        var plan = FigureMotion(posture: Motion.Duration.glance)
        // The perch can be on screen for the length of a build; a breath is a display link that
        // never stops, so the perch carries its report with its glance and one-shot blinks.
        plan.breathes = state == .offering && !perched
        plan.blinks = (state == .offering && !perched) || state == .needsYou
        plan.gesture = state == .done || state == .needsYou
        plan.glowPulse = state == .done
        return plan
    }
}

// MARK: - The view

/// The figure. `size` is its width (DIRECTION.md: 14 in a line, 16 in a pop-up header, 22
/// perched, 64 once in onboarding); its height follows the drawing's viewBox.
///
/// Motion: glances take 140 ms `ease-in-out`; Done squashes (260 ms), squints (420 ms) and pulses
/// its glow (600 ms) once; Needs you bobs twice; Offering breathes over 4 s and blinks every 5 s.
/// Error turns the light to Graphite over 240 ms. Reduce Motion stops all of it and postures
/// jump (`FigureMotion`). Entering and leaving belong to the slip that holds the figure.
struct FigureView: View {
    var character: FigureCharacter
    var state: FigureState
    var facing: FigureFacing = .right
    var size: CGFloat = Tokens.FigureSize.line
    /// False for off-screen renders: draw the state's end pose and nothing else.
    var animated = true
    /// The perch's glance, which replaces `facing`. Nil in slips and text.
    var gaze: CGVector?
    /// The perch blinks once each time this changes (A4: repeating motion on the perch cost 10.9%
    /// of a core; one-shot blinks 1.3%).
    var blinkTick: Int?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion

    init(character: FigureCharacter, state: FigureState, facing: FigureFacing = .right, size: CGFloat = Tokens.FigureSize.line,
         animated: Bool = true, gaze: CGVector? = nil, blinkTick: Int? = nil) {
        self.character = character
        self.state = state
        self.facing = facing
        self.size = size
        self.animated = animated
        self.gaze = gaze
        self.blinkTick = blinkTick
    }

    /// By height, for views that size the figure to a line of text (the writing views) and the
    /// surfaces part 2 of v3 restyles (the desk, the perch, onboarding, What Caret knows).
    init(character: FigureCharacter, state: FigureState, facing: FigureFacing = .right, height: CGFloat, animated: Bool = true,
         gaze: CGVector? = nil, blinkTick: Int? = nil) {
        let box = character.drawing.viewBox
        self.init(character: character, state: state, facing: facing, size: height * box.width / box.height, animated: animated, gaze: gaze, blinkTick: blinkTick)
    }

    var body: some View {
        let drawing = character.drawing
        let height = size * drawing.viewBox.height / drawing.viewBox.width
        let pose = gaze.map { drawing.pose(for: state, gaze: $0) } ?? drawing.pose(for: state, facing: facing)
        let faces = gaze.map { $0.dx < 0 ? FigureFacing.left : .right } ?? facing
        let plan = FigureMotion.plan(state: state, animated: animated, reduce: reduceMotion || reducesMotion, perched: gaze != nil)
        let glow = pose.graphite ? 0 : max(2, size / 4.5)
        Group {
            if state == .absent {
                Color.clear
            } else if plan.posture == nil {
                drawing.body(pose, skin: FigureSkin(graphite: pose.graphite))
                    .shadow(color: Color(token: Tokens.glow).opacity(glow > 0 ? 1 : 0), radius: glow / 2)
            } else {
                LiveFigure(drawing: drawing, pose: pose, state: state, plan: plan, glow: glow, blinkTick: gaze == nil ? nil : blinkTick, lift: height / drawing.viewBox.height)
            }
        }
        .frame(width: size, height: height)
        .scaleEffect(x: faces == .left && character == .wren ? -1 : 1, y: 1)
        .accessibilityHidden(true)
    }
}

/// The animated figure: the body with its gesture, breath and blink, and the light crossfading
/// to Graphite on error.
private struct LiveFigure: View {
    let drawing: FigureDrawing
    let pose: FigurePose
    let state: FigureState
    let plan: FigureMotion
    let glow: CGFloat
    let blinkTick: Int?
    /// Points per viewBox unit, for lifts.
    let lift: CGFloat
    /// A figure that enters already Done (returning into its seat) is a new view: the gesture
    /// plays on its appearance as well as on a change of state.
    @State private var shown = false

    private struct Trigger: Equatable {
        var state: FigureState
        var shown: Bool
    }

    var body: some View {
        KeyframeAnimator(initialValue: Gesture.rest, trigger: Trigger(state: state, shown: shown)) { g in
            ZStack {
                skinned(graphite: false, squash: g.eyeSquash).opacity(pose.graphite ? 0 : 1)
                skinned(graphite: true, squash: g.eyeSquash).opacity(pose.graphite ? 1 : 0)
            }
            .animation(.linear(duration: 0.24), value: pose.graphite)
            .scaleEffect(x: g.scaleX, y: g.scaleY, anchor: .bottom)
            .offset(y: g.lift * lift)
            .shadow(color: Color(token: Tokens.glow).opacity(glow > 0 ? 1 : 0), radius: glow * g.glow / 2)
        } keyframes: { _ in
            Gesture.track(for: state, plan: plan)
        }
        .keyframeAnimator(initialValue: Gesture.rest, repeating: plan.breathes) { content, g in
            content.scaleEffect(x: g.scaleX, y: g.scaleY, anchor: .bottom)
        } keyframes: { _ in
            Gesture.breath(active: plan.breathes)
        }
        .animation(plan.posture.map { Motion.curve(Motion.easeInOut, $0) }, value: pose)
        .onAppear { shown = true }
    }

    private func skinned(graphite: Bool, squash: CGFloat) -> some View {
        FigureBlink(drawing: drawing, pose: pose.squinting(squash), skin: FigureSkin(graphite: graphite), repeating: plan.blinks && blinkTick == nil, tick: blinkTick)
    }
}

/// The body with the eyes' blink: a 5 s repeating cycle, or one blink per `tick` on the perch.
struct FigureBlink: View {
    let drawing: FigureDrawing
    let pose: FigurePose
    let skin: FigureSkin
    let repeating: Bool
    let tick: Int?

    var body: some View {
        if let tick {
            KeyframeAnimator(initialValue: CGFloat(1), trigger: tick) { blink in
                drawing.body(pose.squinting(pose.eyeSquash * blink), skin: skin)
            } keyframes: { _ in
                Gesture.blinkOnce()
            }
        } else {
            KeyframeAnimator(initialValue: CGFloat(1), repeating: repeating) { blink in
                drawing.body(pose.squinting(pose.eyeSquash * blink), skin: skin)
            } keyframes: { _ in
                Gesture.blink(active: repeating)
            }
        }
    }
}

/// One-shot gestures and the breath, as keyframe tracks over a scale, a lift, the eyes' squash and
/// the glow's radius.
struct Gesture {
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    /// In viewBox units, negative up.
    var lift: CGFloat = 0
    var eyeSquash: CGFloat = 1
    /// The glow's radius, as a multiple of its resting radius.
    var glow: CGFloat = 1

    static let rest = Gesture()

    /// One blink, 150 ms: closed (0.1) at 60 ms, open again at 150 ms.
    static func blinkOnce() -> some Keyframes<CGFloat> {
        KeyframeTrack(\CGFloat.self) {
            LinearKeyframe(0.1, duration: 0.06)
            LinearKeyframe(1, duration: 0.09)
        }
    }

    /// 5 s cycle: open, closed (0.1) for an instant at 4.91 s, open again at 5 s.
    static func blink(active: Bool) -> some Keyframes<CGFloat> {
        KeyframeTrack(\CGFloat.self) {
            if active {
                LinearKeyframe(1, duration: Motion.Duration.blinkEvery - 0.15)
                LinearKeyframe(0.1, duration: 0.06)
                LinearKeyframe(1, duration: 0.09)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
    }

    /// Done, each on its own track so the longer ones never stretch the squash: the body 1.12 by
    /// 0.86 at once, 0.97 by 1.04 at 156 ms (60%), rest at 260 ms; the eyes squint to 0.45 from
    /// 126 to 294 ms of 420 (30% to 70%); the glow 2.4 times at 210 ms of 600 (35%). Needs you:
    /// two 1.5 unit bobs, 600 ms each.
    @KeyframesBuilder<Gesture>
    static func track(for state: FigureState, plan: FigureMotion) -> some Keyframes<Gesture> {
        let done = plan.gesture && state == .done
        let needs = plan.gesture && state == .needsYou
        KeyframeTrack(\Gesture.scaleX) {
            if done {
                LinearKeyframe(1.12, duration: 0.001)
                CubicKeyframe(0.97, duration: 0.155)
                CubicKeyframe(1, duration: 0.104)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.scaleY) {
            if done {
                LinearKeyframe(0.86, duration: 0.001)
                CubicKeyframe(1.04, duration: 0.155)
                CubicKeyframe(1, duration: 0.104)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.eyeSquash) {
            if done {
                CubicKeyframe(0.45, duration: 0.126)
                LinearKeyframe(0.45, duration: 0.168)
                CubicKeyframe(1, duration: 0.126)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.glow) {
            if done {
                CubicKeyframe(2.4, duration: 0.21)
                CubicKeyframe(1, duration: 0.39)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.lift) {
            if needs {
                CubicKeyframe(-1.5, duration: 0.3)
                CubicKeyframe(0, duration: 0.3)
                CubicKeyframe(-1.5, duration: 0.3)
                CubicKeyframe(0, duration: 0.3)
            } else {
                LinearKeyframe(0, duration: 0.01)
            }
        }
    }

    /// Offering breathes: 1.035 by 1.025 at the midpoint of 4 s.
    static func breath(active: Bool) -> some Keyframes<Gesture> {
        KeyframeTrack(\Gesture.self) {
            if active {
                CubicKeyframe(Gesture(scaleX: 1.035, scaleY: 1.025), duration: Motion.Duration.breath / 2)
                CubicKeyframe(.rest, duration: Motion.Duration.breath / 2)
            } else {
                CubicKeyframe(.rest, duration: 0.01)
            }
        }
    }
}

extension Gesture: Animatable {
    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>>> {
        get { AnimatablePair(AnimatablePair(scaleX, scaleY), AnimatablePair(lift, AnimatablePair(eyeSquash, glow))) }
        set {
            scaleX = newValue.first.first
            scaleY = newValue.first.second
            lift = newValue.second.first
            eyeSquash = newValue.second.second.first
            glow = newValue.second.second.second
        }
    }
}

extension FigurePose {
    func squinting(_ squash: CGFloat) -> FigurePose {
        var copy = self
        copy.eyeSquash = squash
        return copy
    }
}

// MARK: - Menu bar glyph

public enum FigureGlyph {
    /// A 16 pt template image of the character, 13 pt wide, eyes cut out. While working it is
    /// drawn in Carrot instead, the one time the glyph changes.
    @MainActor
    public static func image(_ character: FigureCharacter, working: Bool) -> NSImage {
        let drawing = character.drawing
        let width: CGFloat = 13
        let height = width * drawing.viewBox.height / drawing.viewBox.width
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let k = width / drawing.viewBox.width
            context.translateBy(x: (rect.width - width) / 2, y: (rect.height - height) / 2)
            context.scaleBy(x: k, y: k)
            context.addPath(drawing.glyph().cgPath)
            context.setFillColor((working ? Tokens.carrot : NSColor.black).cgColor)
            context.fillPath(using: .evenOdd)
            return true
        }
        image.isTemplate = !working
        image.accessibilityDescription = working ? "Caret, working" : "Caret"
        return image
    }
}
