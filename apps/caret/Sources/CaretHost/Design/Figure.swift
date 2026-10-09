import AppKit
import CaretHostCore
import SwiftUI

/// Which way the figure faces: toward the text it stands after (left), or toward the words of
/// the line it heads (right).
public enum FigureFacing: Sendable {
    case left, right
}

/// The figure's drawing. The enum itself is CaretHostCore's, so the surface decisions can name
/// the figure without SwiftUI.
extension FigureCharacter {
    var drawing: FigureDrawing {
        switch self {
        case .pebble: return Pebble()
        }
    }
}

/// The figure every surface draws. Pebble is the only one (Sam, 2026-10-09), so there is no
/// choice to switch or save; the surfaces read it here so they keep one source.
@MainActor
public final class FigureSettings: ObservableObject {
    public static let shared = FigureSettings()

    public let character: FigureCharacter = .pebble
}

// MARK: - Pose

/// Every transform a character can take, in viewBox units. A state's end pose is one value; the
/// motion between poses is the view's job. Poses are written facing right; the view mirrors the
/// whole figure to face left.
struct FigurePose: Equatable {
    var bodyScale = CGSize(width: 1, height: 1)
    var bodyOffsetY: CGFloat = 0
    /// The lean, in degrees about the base; positive leans toward where it faces.
    var rotation: Double = 0
    var eyeOffset = CGSize.zero
    var eyeScale: CGFloat = 1
    /// Narrows the eyes to bars (Working).
    var eyeScaleX: CGFloat = 1
    var eyeSquash: CGFloat = 1
    var lids = false
    /// The light is out: the skin is Graphite and the glow is off.
    var graphite = false
}

/// The figure is lit, not glossy (character DIRECTION.md): one linear gradient from the crest
/// down, from a warm core to a darker rim, and a glow that touches what it sits on. Error is the
/// light going out: Graphite, no glow.
struct FigureSkin {
    var graphite: Bool

    func fill(in size: CGSize) -> AnyShapeStyle {
        if graphite { return AnyShapeStyle(Color(token: Tokens.graphite)) }
        return AnyShapeStyle(LinearGradient(
            colors: [Color(token: Tokens.skinCore), Color(token: Tokens.skinMid), Color(token: Tokens.skinRim)],
            startPoint: UnitPoint(x: 0.6, y: 0.05), endPoint: UnitPoint(x: 0.45, y: 1)
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
    /// zero looks out at the user). The sign of `gaze.dx` is the view's mirror, not the pose's.
    func pose(for state: FigureState, gaze: CGVector) -> FigurePose
    /// The pose glancing along `direction` (screen directions, x right, y down) for a moment,
    /// eyes only. `mirrored`: the figure is drawn facing left, so screen right is its back.
    func glancing(_ pose: FigurePose, toward direction: CGVector, mirrored: Bool, reach: CGFloat) -> FigurePose
    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView
    /// One silhouette for the menu bar, eyes cut out; narrowed to bars while working.
    func glyph(working: Bool) -> Path
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

/// The crest (character DIRECTION.md, direction D): a river stone with a flat base, a long back
/// and a crest at 65 percent of the width, so it leans toward what it attends to. Two tall
/// capsule eyes set low. Geometry from character HANDOFF.md section 1, viewBox 12 by 11.
struct Pebble: FigureDrawing {
    let viewBox = CGSize(width: 12, height: 11)

    /// Squash, sag, lean and bob turn about the middle of the flat base.
    static let baseAnchor = UnitPoint(x: 0.5, y: 10.4 / 11)
    /// Grow, narrow and blink scale about the point between the eyes.
    static let eyeAnchor = UnitPoint(x: 6.6 / 12, y: 6.3 / 11)
    /// The farthest the eyes travel: across, then up or down. The front eye's edge then reaches
    /// x 10.1, inside the outline's 11.5 at that height.
    static let travel = CGSize(width: 1.1, height: 0.8)

    /// The apex is a fillet of radius 0.5 (Sam, 2026-10-09: keep the point, slightly rounded). It
    /// replaces the 48 degree corner at (7.8, 1): each side is cut back 0.22 along its curve with
    /// de Casteljau and joined by a circular arc with handles on both tangents, so the outline has
    /// no corner left. In viewBox units, so the tip keeps its proportion at 12 pt and at 1024.
    /// Computed by design/character/tools/tip.py.
    static func outline(_ p: inout Path) {
        p.move(to: CGPoint(x: 7.989, y: 1.115))
        p.addCurve(to: CGPoint(x: 11.6, y: 6.7), control1: CGPoint(x: 8.99, y: 1.756), control2: CGPoint(x: 11.6, y: 3.902))
        p.addCurve(to: CGPoint(x: 6.2, y: 10.4), control1: CGPoint(x: 11.6, y: 9.2), control2: CGPoint(x: 9.6, y: 10.4))
        p.addCurve(to: CGPoint(x: 0.4, y: 6.9), control1: CGPoint(x: 2.8, y: 10.4), control2: CGPoint(x: 0.4, y: 9.2))
        p.addCurve(to: CGPoint(x: 7.592, y: 1.075), control1: CGPoint(x: 0.4, y: 4.695), control2: CGPoint(x: 5.821, y: 1.755))
        p.addCurve(to: CGPoint(x: 7.989, y: 1.115), control1: CGPoint(x: 7.724, y: 1.025), control2: CGPoint(x: 7.872, y: 1.039))
        p.closeSubpath()
    }

    /// Two capsules, 1.5 by 2.1, centered at (4.7, 6.3) and (8.5, 6.3). `width` 0.8 narrows them
    /// to bars for the working menu bar glyph.
    static func eyes(_ p: inout Path, width: CGFloat = 1.5) {
        for x in [4.7, 8.5] {
            p.addRoundedRect(in: CGRect(x: x - width / 2, y: 5.25, width: width, height: 2.1),
                             cornerSize: CGSize(width: width / 2, height: width / 2))
        }
    }

    /// Over the top of each eye, in the body's flat color, so lowered lids read as tired eyes.
    /// Error only.
    static func lids(_ p: inout Path) {
        for x in [3.75, 7.55] {
            p.addRoundedRect(in: CGRect(x: x, y: 5.05, width: 1.9, height: 1.26), cornerSize: CGSize(width: 0.5, height: 0.5))
        }
    }

    /// Character HANDOFF.md section 4. `facing` does not change the pose: the view mirrors.
    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose {
        var pose = FigurePose()
        switch state {
        case .noticed, .offering, .done:
            pose.eyeOffset = CGSize(width: Self.travel.width, height: 0)
            pose.rotation = 2
        case .working:
            pose.eyeOffset = CGSize(width: 0.9, height: -0.9)
            pose.eyeScaleX = 0.55
            pose.rotation = 3
        case .needsYou:
            pose.eyeScale = 1.25
        case .error:
            pose.graphite = true
            pose.bodyScale = CGSize(width: 1.04, height: 0.9)
            pose.eyeOffset = CGSize(width: 0, height: 0.6)
            pose.rotation = -4
            pose.lids = true
        case .still, .absent:
            break
        }
        return pose
    }

    /// Done keeps its eyes ahead and Error keeps looking down; the rest look along the gaze and
    /// lean 2 degrees per unit of it, toward whichever side the view faces.
    func pose(for state: FigureState, gaze: CGVector) -> FigurePose {
        var pose = pose(for: state, facing: .right)
        switch state {
        case .noticed, .offering, .working, .needsYou, .still:
            pose.eyeOffset = CGSize(width: abs(gaze.dx) * Self.travel.width, height: gaze.dy * Self.travel.height)
            pose.rotation = Double(abs(gaze.dx)) * 2
        case .done, .error, .absent:
            break
        }
        return pose
    }

    func glancing(_ pose: FigurePose, toward direction: CGVector, mirrored: Bool, reach: CGFloat) -> FigurePose {
        var pose = pose
        let length = max(1, hypot(direction.dx, direction.dy))
        pose.eyeOffset = CGSize(width: direction.dx / length * (mirrored ? -1 : 1) * Self.travel.width * reach,
                                height: direction.dy / length * Self.travel.height * reach)
        return pose
    }

    /// Four transform layers, inside out: the eyes' narrow and blink, their grow, their glance,
    /// then the body's squash, lean and bob from the base (character HANDOFF.md section 3).
    func body(_ pose: FigurePose, skin: FigureSkin) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
            ZStack {
                ViewBoxShape(viewBox: box, build: Self.outline).fill(skin.fill(in: geo.size))
                ZStack {
                    ViewBoxShape(viewBox: box, build: { Self.eyes(&$0) }).fill(Color(token: Tokens.eye))
                        .scaleEffect(x: pose.eyeScaleX, y: pose.eyeSquash, anchor: Self.eyeAnchor)
                    ViewBoxShape(viewBox: box, build: Self.lids).fill(skin.flat.opacity(pose.lids ? 1 : 0))
                }
                .scaleEffect(pose.eyeScale, anchor: Self.eyeAnchor)
                .offset(x: pose.eyeOffset.width * k, y: pose.eyeOffset.height * k)
            }
            .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: Self.baseAnchor)
            .rotationEffect(.degrees(pose.rotation), anchor: Self.baseAnchor)
            .offset(y: pose.bodyOffsetY * k)
        })
    }

    func glyph(working: Bool) -> Path {
        var p = Path()
        Self.outline(&p)
        Self.eyes(&p, width: working ? 0.8 : 1.5)
        return p // even-odd cuts the eyes out
    }
}

// MARK: - Motion plan

/// Which of the figure's motions run, decided apart from the drawing so a test can hold the
/// Reduce Motion rule: every gesture, every rest beat and every move stop, and only the light's
/// crossfade remains, at 0.12 s.
struct FigureMotion: Equatable {
    /// How a change of posture moves; nil jumps.
    enum Posture: Equatable {
        /// The settle spring (`Motion.Spring.settle`): there in about 150 ms, a small overshoot,
        /// settled. Every glance, lean, narrowing and growing.
        case settle
        /// Error's sag: 0.24 s ease-in-out, no overshoot. The light going out does not bounce.
        case heavy
    }

    /// Done's squash and squint, Needs you's two bobs, Still's one blink.
    var gesture = false
    /// Done: the glow to 2.4 times its radius and back.
    var glowPulse = false
    var posture: Posture?
    /// Seconds for the light to go out or come back; nil switches at once (off-screen renders).
    var crossfade: Double?
    /// What the figure may do between moments, at rest; nil does nothing.
    var rest: FigureIdle.Allowance?

    static func plan(state: FigureState, animated: Bool, reduce: Bool, size: CGFloat) -> FigureMotion {
        guard animated, state != .absent else { return FigureMotion() }
        guard !reduce else { return FigureMotion(crossfade: Motion.Duration.reduced) }
        return FigureMotion(
            gesture: state == .done || state == .needsYou || state == .still,
            glowPulse: state == .done,
            posture: state == .error ? .heavy : .settle,
            crossfade: Motion.Duration.lightOut,
            rest: FigureIdle.allowance(state: state, size: size)
        )
    }

    var postureAnimation: Animation? {
        switch posture {
        case .settle?: return .spring(Motion.Spring.settle)
        case .heavy?: return Motion.curve(Motion.easeInOut, Motion.Duration.lightOut)
        case nil: return nil
        }
    }
}

// MARK: - Alive at rest

/// What the figure does between moments: a blink, sometimes two, and now and then a glance at the
/// user's typing. Never a loop with a period: after each beat the next is drawn at random, and two
/// gaps in a row are never within 0.6 s of each other, so no rhythm forms (Apple's HIG warns
/// against slow continuous oscillation; a fixed 5 s blink is one). The numbers are the
/// prototype's (design/character/prototype/pebble.js, `IDLE`); nothing measured them against
/// users. Randomness is injected, so a test sees the same beats every run.
struct FigureIdle {
    /// What a figure may do at rest, by state and size.
    struct Allowance: Equatable, Hashable {
        /// Under 20 pt (slips, pop-up headers): fewer beats, no double blinks, shorter glances.
        var small: Bool
        /// Glances are for figures attending to something; Needs you holds the user's eyes and
        /// Done is a short stay, so they only blink.
        var glances: Bool
    }

    enum Beat: Equatable {
        case blink
        case doubleBlink
        /// Look at the typing for `hold` seconds, then back.
        case glance(hold: Double)
    }

    struct Step: Equatable {
        /// Seconds from the last beat (or from coming to rest) to this one.
        var wait: Double
        var beat: Beat
    }

    static let regularGap: ClosedRange<Double> = 3...8
    static let smallGap: ClosedRange<Double> = 4.5...9
    /// Two gaps in a row closer than this would start to feel like a beat; the second is redrawn.
    static let minChange: Double = 0.6
    static let doubleBlinkChance = (regular: 0.2, small: 0.0)
    static let glanceChance = (regular: 0.25, small: 0.15)
    static let hold: ClosedRange<Double> = 0.7...1.2
    /// A glance at slip size travels this share of the way: a flick, not a turn.
    static let smallReach: CGFloat = 0.6
    static let smallBelow: CGFloat = 20

    static func allowance(state: FigureState, size: CGFloat) -> Allowance? {
        let small = size < smallBelow
        switch state {
        case .noticed, .offering, .still: return Allowance(small: small, glances: true)
        case .needsYou, .done: return Allowance(small: small, glances: false)
        case .working, .error, .absent: return nil
        }
    }

    private(set) var lastWait: Double?
    private(set) var lastWasGlance = false

    /// The next beat. `canGlance`: there is typing to look at.
    mutating func next<R: RandomNumberGenerator>(_ allowance: Allowance, canGlance: Bool, using rng: inout R) -> Step {
        let gap = allowance.small ? Self.smallGap : Self.regularGap
        var wait = Double.random(in: gap, using: &rng)
        for _ in 0..<3 where tooClose(wait) { wait = Double.random(in: gap, using: &rng) }
        if let last = lastWait, tooClose(wait) {
            wait = last + 2 * Self.minChange <= gap.upperBound ? last + 2 * Self.minChange : last - 2 * Self.minChange
        }
        let beat: Beat
        if allowance.glances, canGlance, !lastWasGlance,
           Double.random(in: 0..<1, using: &rng) < (allowance.small ? Self.glanceChance.small : Self.glanceChance.regular) {
            beat = .glance(hold: Double.random(in: Self.hold, using: &rng))
        } else if Double.random(in: 0..<1, using: &rng) < (allowance.small ? Self.doubleBlinkChance.small : Self.doubleBlinkChance.regular) {
            beat = .doubleBlink
        } else {
            beat = .blink
        }
        lastWait = wait
        if case .glance = beat { lastWasGlance = true } else { lastWasGlance = false }
        return Step(wait: wait, beat: beat)
    }

    private func tooClose(_ wait: Double) -> Bool {
        lastWait.map { abs(wait - $0) < Self.minChange } ?? false
    }

    /// Where the user is typing, seen from the figure: the unit direction from the figure's
    /// `seat` (a point inside `panel`) to the middle of `caret`. Panel and caret in one coordinate
    /// space with y down (Accessibility's). Nil when the caret is unknown or under the seat.
    static func typingDirection(panel: CGRect, seat: CGPoint, caret: CGRect) -> CGVector? {
        guard caret.height > 0 else { return nil }
        let dx = caret.midX - (panel.minX + seat.x), dy = caret.midY - (panel.minY + seat.y)
        let length = hypot(dx, dy)
        guard length >= 1 else { return nil }
        return CGVector(dx: dx / length, dy: dy / length)
    }
}

/// SplitMix64: a seeded generator for the rest beats, so tests and captures see one day twice.
struct FigureRandom: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Where the rest beats' randomness comes from. The app draws a fresh seed per figure; a test or a
/// capture names one, or freezes the figure so it never beats.
struct FigureLife: Equatable, Hashable {
    var seed: UInt64?
    var frozen = false

    static let system = FigureLife()
    static let frozen = FigureLife(frozen: true)
    static func seeded(_ seed: UInt64) -> FigureLife { FigureLife(seed: seed) }

    func generator() -> FigureRandom { FigureRandom(seed: seed ?? UInt64.random(in: .min ... .max)) }
}

private struct FigureLifeKey: EnvironmentKey {
    static let defaultValue = FigureLife.system
}

/// The screen direction from the figure to where the user is typing (x right, y down), set by the
/// panel that knows both; nil where there is no typing to look at (the perch, windows).
private struct FigureTypingKey: EnvironmentKey {
    static let defaultValue: CGVector? = nil
}

extension EnvironmentValues {
    var figureLife: FigureLife {
        get { self[FigureLifeKey.self] }
        set { self[FigureLifeKey.self] = newValue }
    }

    var figureTyping: CGVector? {
        get { self[FigureTypingKey.self] }
        set { self[FigureTypingKey.self] = newValue }
    }
}

// MARK: - The view

/// The figure. `size` is its width (14 in a line, 16 in a pop-up header, 22 perched, 64 once in
/// onboarding); its height follows the drawing's viewBox.
///
/// Motion: every change of posture moves on the settle spring (`Motion.Spring.settle`, 0.3 s,
/// bounce 0.3), so each move ends in a small settle; Error's sag is a 0.24 s ease-in-out with no
/// bounce, and the light crossfades to Graphite over 0.24 s. Done lands squashed and springs back
/// (`Motion.Spring.relief`), squints with its eyes lifted and pulses its glow once; Needs you bobs
/// twice; Still blinks once. At rest it blinks at irregular intervals and now and then glances at
/// the typing (`FigureIdle`). Reduce Motion stops all of it, postures jump and the light fades in
/// 0.12 s (`FigureMotion`). Entering and leaving belong to the slip that holds the figure.
struct FigureView: View {
    var character: FigureCharacter
    var state: FigureState
    var facing: FigureFacing = .right
    var size: CGFloat = Tokens.FigureSize.line
    /// False for off-screen renders: draw the state's end pose and nothing else.
    var animated = true
    /// The perch's glance, which replaces `facing`. Nil in slips and text.
    var gaze: CGVector?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion
    /// Reference images draw the end pose, whatever the caller asked: a render is one frozen frame.
    @Environment(\.rendersOffscreen) private var offscreen

    init(character: FigureCharacter, state: FigureState, facing: FigureFacing = .right, size: CGFloat = Tokens.FigureSize.line,
         animated: Bool = true, gaze: CGVector? = nil) {
        self.character = character
        self.state = state
        self.facing = facing
        self.size = size
        self.animated = animated
        self.gaze = gaze
    }

    /// By height, for views that size the figure to a line of text (the writing views) and the
    /// surfaces part 2 of v3 restyles (the desk, the perch, onboarding, What Caret knows).
    init(character: FigureCharacter, state: FigureState, facing: FigureFacing = .right, height: CGFloat, animated: Bool = true,
         gaze: CGVector? = nil) {
        let box = character.drawing.viewBox
        self.init(character: character, state: state, facing: facing, size: height * box.width / box.height, animated: animated, gaze: gaze)
    }

    var body: some View {
        let drawing = character.drawing
        let height = size * drawing.viewBox.height / drawing.viewBox.width
        let pose = gaze.map { drawing.pose(for: state, gaze: $0) } ?? drawing.pose(for: state, facing: facing)
        // Facing left mirrors the whole figure; the perch faces the way its gaze points.
        let mirrored = gaze.map { $0.dx < 0 } ?? (facing == .left)
        let plan = FigureMotion.plan(state: state, animated: animated && !offscreen, reduce: reduceMotion || reducesMotion, size: size)
        let glow = pose.graphite ? 0 : max(2, size / 4.5)
        Group {
            if state == .absent {
                Color.clear
            } else if plan.posture == nil {
                FigureFace(drawing: drawing, pose: pose, crossfade: plan.crossfade)
                    .shadow(color: Color(token: Tokens.glow).opacity(glow > 0 ? 1 : 0), radius: glow / 2)
                    .scaleEffect(x: mirrored ? -1 : 1, y: 1)
                    .animation(nil, value: mirrored)
            } else {
                LiveFigure(drawing: drawing, pose: pose, state: state, plan: plan, glow: glow, mirrored: mirrored,
                           lift: height / drawing.viewBox.height)
                    // A turn is a mirror, not a squash through zero: it never animates.
                    .scaleEffect(x: mirrored ? -1 : 1, y: 1)
                    .animation(nil, value: mirrored)
            }
        }
        .frame(width: size, height: height)
        .accessibilityHidden(true)
    }
}

/// The body in its skin. With a crossfade, the lit and the Graphite skins are both drawn and the
/// light fades between them; without one the pose's own skin is drawn alone.
private struct FigureFace: View {
    let drawing: FigureDrawing
    let pose: FigurePose
    let crossfade: Double?

    var body: some View {
        if let crossfade {
            ZStack {
                drawing.body(pose, skin: FigureSkin(graphite: false)).opacity(pose.graphite ? 0 : 1)
                drawing.body(pose, skin: FigureSkin(graphite: true)).opacity(pose.graphite ? 1 : 0)
            }
            .animation(.linear(duration: crossfade), value: pose.graphite)
        } else {
            drawing.body(pose, skin: FigureSkin(graphite: pose.graphite))
        }
    }
}

/// The animated figure: posture on the settle spring, the state's gesture, the light's crossfade,
/// and the rest beats.
private struct LiveFigure: View {
    let drawing: FigureDrawing
    let pose: FigurePose
    let state: FigureState
    let plan: FigureMotion
    let glow: CGFloat
    let mirrored: Bool
    /// Points per viewBox unit, for lifts.
    let lift: CGFloat

    @Environment(\.figureLife) private var life
    @Environment(\.figureTyping) private var typing
    /// A figure that enters already Done (returning into its seat) is a new view: the gesture
    /// plays on its appearance as well as on a change of state.
    @State private var shown = false
    /// Bumped once per rest blink; the blink plays on the change.
    @State private var blinks = 0
    @State private var doubleBlink = false
    /// The glance at the typing while one is held.
    @State private var glance: CGVector?
    /// `typing`, kept where the rest task reads it (a task reads state, not a stale environment).
    @State private var typingNow: CGVector?

    private struct Trigger: Equatable {
        var state: FigureState
        var shown: Bool
    }

    /// The rest beats restart from a fresh gap whenever the state or what it may do changes.
    private struct RestKey: Equatable {
        var state: FigureState
        var rest: FigureIdle.Allowance?
        var life: FigureLife
    }

    var body: some View {
        let shownPose = glance.map {
            drawing.glancing(pose, toward: $0, mirrored: mirrored, reach: plan.rest?.small == true ? FigureIdle.smallReach : 1)
        } ?? pose
        KeyframeAnimator(initialValue: Gesture.rest, trigger: Trigger(state: state, shown: shown)) { g in
            KeyframeAnimator(initialValue: CGFloat(1), trigger: blinks) { blink in
                FigureFace(drawing: drawing, pose: shownPose.gesturing(g, blink: blink), crossfade: plan.crossfade)
                    .scaleEffect(x: g.scaleX, y: g.scaleY, anchor: Pebble.baseAnchor)
                    .offset(y: g.lift * lift)
                    .shadow(color: Color(token: Tokens.glow).opacity(glow > 0 ? 1 : 0), radius: glow * g.glow / 2)
            } keyframes: { _ in
                Gesture.blink(double: doubleBlink)
            }
        } keyframes: { _ in
            Gesture.track(for: state, plan: plan)
        }
        .animation(plan.postureAnimation, value: shownPose)
        .onAppear {
            shown = true
            typingNow = typing
        }
        .onChange(of: typing) { _, now in typingNow = now }
        .task(id: RestKey(state: state, rest: plan.rest, life: life)) { await rest() }
    }

    /// Sleeps to each beat and plays it, until the state changes or the view goes away.
    private func rest() async {
        glance = nil
        guard let allowance = plan.rest, !life.frozen else { return }
        var rng = life.generator()
        var idle = FigureIdle()
        while !Task.isCancelled {
            let step = idle.next(allowance, canGlance: typingNow != nil, using: &rng)
            guard (try? await Task.sleep(for: .seconds(step.wait))) != nil else { return }
            switch step.beat {
            case .blink, .doubleBlink:
                doubleBlink = step.beat == .doubleBlink
                blinks &+= 1
            case .glance(let hold):
                guard let toward = typingNow else {
                    blinks &+= 1
                    continue
                }
                glance = toward
                guard (try? await Task.sleep(for: .seconds(hold))) != nil else { return }
                glance = nil
            }
        }
    }
}

/// One-shot gestures as keyframe tracks over a scale, a lift, the eyes' squash and rise, and the
/// glow's radius.
struct Gesture {
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    /// In viewBox units, negative up.
    var lift: CGFloat = 0
    var eyeSquash: CGFloat = 1
    /// The eyes' lift while they squint, in viewBox units, negative up.
    var eyeRise: CGFloat = 0
    /// The glow's radius, as a multiple of its resting radius.
    var glow: CGFloat = 1

    static let rest = Gesture()

    /// How far a blink closes the eyes. A capsule at 0.1 leaves a hairline that flickers at 14 pt;
    /// 0.12 is a dash (judgment from the prototype, not measured).
    static let blinkClosed: CGFloat = 0.12

    /// One blink, 150 ms: closed at 60 ms, open again at 150. A double blink adds a second after
    /// 90 ms open.
    static func blink(double: Bool) -> some Keyframes<CGFloat> {
        KeyframeTrack(\CGFloat.self) {
            LinearKeyframe(blinkClosed, duration: 0.06)
            LinearKeyframe(1, duration: 0.09)
            if double {
                LinearKeyframe(1, duration: 0.09)
                LinearKeyframe(blinkClosed, duration: 0.06)
                LinearKeyframe(1, duration: 0.09)
            } else {
                LinearKeyframe(1, duration: 0.001)
            }
        }
    }

    /// Done, each on its own track so the longer ones never stretch the squash: the body lands at
    /// 1.12 by 0.86 and springs back on `Motion.Spring.relief` (its overshoot, about 0.98 by 1.02,
    /// is the relief); the eyes squint to 0.45 and lift 0.3 from 126 to 294 ms of 420; the glow
    /// reaches 2.4 times at 210 ms of 600. Needs you: two 1.5 unit bobs, 600 ms each. Still: one
    /// blink on entering.
    @KeyframesBuilder<Gesture>
    static func track(for state: FigureState, plan: FigureMotion) -> some Keyframes<Gesture> {
        let done = plan.gesture && state == .done
        let needs = plan.gesture && state == .needsYou
        let still = plan.gesture && state == .still
        let relief = Motion.Spring.relief
        KeyframeTrack(\Gesture.scaleX) {
            if done {
                LinearKeyframe(1.12, duration: 0.001)
                SpringKeyframe(1, duration: relief.settlingDuration, spring: relief)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.scaleY) {
            if done {
                LinearKeyframe(0.86, duration: 0.001)
                SpringKeyframe(1, duration: relief.settlingDuration, spring: relief)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.eyeSquash) {
            if done {
                CubicKeyframe(0.45, duration: 0.126)
                LinearKeyframe(0.45, duration: 0.168)
                CubicKeyframe(1, duration: 0.126)
            } else if still {
                LinearKeyframe(blinkClosed, duration: 0.06)
                LinearKeyframe(1, duration: 0.09)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
        KeyframeTrack(\Gesture.eyeRise) {
            if done {
                CubicKeyframe(-0.3, duration: 0.126)
                LinearKeyframe(-0.3, duration: 0.168)
                CubicKeyframe(0, duration: 0.126)
            } else {
                LinearKeyframe(0, duration: 0.01)
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
}

extension Gesture: Animatable {
    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<CGFloat, AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>>>> {
        get { AnimatablePair(AnimatablePair(scaleX, scaleY), AnimatablePair(lift, AnimatablePair(eyeSquash, AnimatablePair(eyeRise, glow)))) }
        set {
            scaleX = newValue.first.first
            scaleY = newValue.first.second
            lift = newValue.second.first
            eyeSquash = newValue.second.second.first
            eyeRise = newValue.second.second.second.first
            glow = newValue.second.second.second.second
        }
    }
}

extension FigurePose {
    /// The pose under a gesture frame and a blink: the eyes squash by both and rise by the gesture.
    func gesturing(_ g: Gesture, blink: CGFloat) -> FigurePose {
        var copy = self
        copy.eyeSquash = eyeSquash * g.eyeSquash * blink
        copy.eyeOffset.height += g.eyeRise
        return copy
    }
}

// MARK: - Menu bar glyph

public enum FigureGlyph {
    /// A 16 pt template image of the character, 13 pt wide, eyes cut out. While working it is
    /// drawn in Carrot with its eyes narrowed to bars, the one time the glyph changes.
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
            context.addPath(drawing.glyph(working: working).cgPath)
            context.setFillColor((working ? Tokens.carrot : NSColor.black).cgColor)
            context.fillPath(using: .evenOdd)
            return true
        }
        image.isTemplate = !working
        image.accessibilityDescription = working ? "Caret, working" : "Caret"
        return image
    }
}
