import AppKit
import SwiftUI

/// The figure's states (`IDENTITY.md`, "States, side by side").
public enum FigureState: String, CaseIterable, Codable, Sendable {
    /// Enters, already looking at what it noticed.
    case noticed
    /// Turns toward the offer and breathes.
    case offering
    /// Looks away, then leaves; the menu bar glyph tints Carrot.
    case working
    /// Returns with one gesture of relief.
    case done
    /// Faces you; two small signals. Nothing happens until you answer.
    case needsYou
    /// Goes graphite; posture drops.
    case error
    /// Not drawn.
    case absent
}

/// Which way the figure faces: toward the text it stands after (left), or toward the words of
/// the line it heads (right).
public enum FigureFacing: Sendable {
    case left, right
}

/// The three characters. Pebble is the default; seed and wren are kept selectable until Sam picks
/// (`OPEN-QUESTIONS.md` 1). Each one is a drawing plus a pose per state, so adding a fourth is one
/// more case here and one more `FigureDrawing`.
public enum FigureCharacter: String, CaseIterable, Sendable {
    case pebble, seed, wren

    public var displayName: String { rawValue.capitalized }

    var drawing: FigureDrawing {
        switch self {
        case .pebble: return Pebble()
        case .seed: return Seed()
        case .wren: return Wren()
        }
    }
}

/// The character in use: `CARET_FIGURE` when set, else the menu's choice in user defaults.
@MainActor
public final class FigureSettings: ObservableObject {
    public static let shared = FigureSettings()
    static let defaultsKey = "figureCharacter"

    @Published public var character: FigureCharacter {
        didSet { UserDefaults.standard.set(character.rawValue, forKey: Self.defaultsKey) }
    }

    init() {
        let env = ProcessInfo.processInfo.environment["CARET_FIGURE"]
        let stored = UserDefaults.standard.string(forKey: Self.defaultsKey)
        character = (env ?? stored).flatMap(FigureCharacter.init(rawValue:)) ?? .pebble
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
    var opacity: Double = 1
    var graphite = false
    /// The seed lies on its side.
    var fallen = false
}

protocol FigureDrawing {
    /// The viewBox, from `IDENTITY.md`.
    var viewBox: CGSize { get }
    /// Height to width, so a given height yields the character's own width.
    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose
    func body(_ pose: FigurePose, fill: Color) -> AnyView
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
        let path = source
        let sx = rect.width / viewBox.width, sy = rect.height / viewBox.height
        return path.applying(CGAffineTransform(scaleX: sx, y: sy).translatedBy(x: rect.minX / sx, y: rect.minY / sy))
    }
}

// MARK: - Pebble

/// A soft bun with two eyes. Life is the glance: where it looks is what it noticed.
struct Pebble: FigureDrawing {
    let viewBox = CGSize(width: 12, height: 10)

    static func outline(_ p: inout Path) {
        p.move(to: CGPoint(x: 6, y: 0.7))
        p.addCurve(to: CGPoint(x: 11.6, y: 5.6), control1: CGPoint(x: 9.5, y: 0.7), control2: CGPoint(x: 11.6, y: 2.7))
        p.addCurve(to: CGPoint(x: 6, y: 9.6), control1: CGPoint(x: 11.6, y: 8.3), control2: CGPoint(x: 9.3, y: 9.6))
        p.addCurve(to: CGPoint(x: 0.4, y: 5.6), control1: CGPoint(x: 2.7, y: 9.6), control2: CGPoint(x: 0.4, y: 8.3))
        p.addCurve(to: CGPoint(x: 6, y: 0.7), control1: CGPoint(x: 0.4, y: 2.7), control2: CGPoint(x: 2.5, y: 0.7))
        p.closeSubpath()
    }

    static func eyes(_ p: inout Path) {
        for x in [4.1, 7.9] { p.addEllipse(in: CGRect(x: x - 0.95, y: 4.9 - 0.95, width: 1.9, height: 1.9)) }
    }

    static func lids(_ p: inout Path) {
        for x in [2.9, 6.7] { p.addRoundedRect(in: CGRect(x: x, y: 3.6, width: 2.4, height: 1.2), cornerSize: CGSize(width: 0.3, height: 0.3)) }
    }

    func pose(for state: FigureState, facing: FigureFacing) -> FigurePose {
        var pose = FigurePose()
        let toward: CGFloat = facing == .right ? 1.1 : -1.1
        switch state {
        case .noticed, .offering: pose.eyeOffset = CGSize(width: toward, height: 0)
        case .working: pose.eyeOffset = CGSize(width: 0.9, height: -0.9)
        case .done, .absent: break
        case .needsYou:
            pose.eyeOffset = CGSize(width: 0, height: -0.5)
            pose.eyeScale = 1.3
        case .error:
            pose.graphite = true
            pose.bodyScale = CGSize(width: 1.05, height: 0.86)
            pose.eyeOffset = CGSize(width: 0, height: 0.5)
            pose.lids = true
        }
        return pose
    }

    func body(_ pose: FigurePose, fill: Color) -> AnyView {
        let box = viewBox
        let unit = UnitPoint(x: 0.5, y: 1)
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
            ZStack {
                ViewBoxShape(viewBox: box, build: Self.outline).fill(fill)
                ZStack {
                    ViewBoxShape(viewBox: box, build: Self.eyes).fill(Color(token: Tokens.eye))
                        .scaleEffect(x: 1, y: pose.eyeSquash, anchor: UnitPoint(x: 0.5, y: 0.49))
                    ViewBoxShape(viewBox: box, build: Self.lids).fill(fill.opacity(pose.lids ? 1 : 0))
                }
                .scaleEffect(pose.eyeScale, anchor: UnitPoint(x: 0.5, y: 0.49))
                .offset(x: pose.eyeOffset.width * k, y: pose.eyeOffset.height * k)
            }
            .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: unit)
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

/// The proofreader's mark with weight. Life is posture only.
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
        case .noticed, .done, .absent: break
        case .offering: pose.rotation = lean
        case .working: pose.bodyOffsetY = -2
        case .needsYou: pose.bodyOffsetY = -2
        case .error:
            pose.graphite = true
            pose.fallen = true
        }
        return pose
    }

    func body(_ pose: FigurePose, fill: Color) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
            ViewBoxShape(viewBox: box, build: Self.outline).fill(fill)
                .scaleEffect(x: pose.bodyScale.width, y: pose.bodyScale.height, anchor: .bottom)
                // Fallen: on its side about the base center, lifted so it lies on the baseline.
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

/// A small bird on your line. Life is gesture: head tilt, hop, flight.
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
        case .done, .absent: break
        case .needsYou: pose.headRotation = -28
        case .error:
            pose.graphite = true
            pose.headRotation = 24
            pose.bodyScale = CGSize(width: 1.08, height: 0.9)
        }
        return pose
    }

    func body(_ pose: FigurePose, fill: Color) -> AnyView {
        let box = viewBox
        return AnyView(GeometryReader { geo in
            let k = geo.size.width / box.width
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
            .offset(y: pose.bodyOffsetY * k)
        })
    }

    func glyph() -> Path {
        // The menu bar glyph fills even-odd so the eye is cut out; the parts are unioned first so
        // their overlaps stay filled.
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

// MARK: - The view

/// The figure at text size. Height sets the scale; width follows the character's viewBox.
///
/// Motion (`IDENTITY.md`): posture changes take 160 ms `--ease-in-out` (the seed's fall 240 ms
/// `--ease-fall`); Done plays its one gesture; Needs you signals twice; Offering breathes over 4 s
/// and the pebble blinks every 5 s. Reduce Motion drops the breath, blink and gestures and jumps
/// postures, so the caption alone carries the result. Entering and leaving belong to the panel
/// that holds the figure.
struct FigureView: View {
    var character: FigureCharacter
    var state: FigureState
    var facing: FigureFacing = .right
    var height: CGFloat = 10
    /// False for off-screen renders: draw the state's end pose and nothing else.
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let drawing = character.drawing
        let width = height * drawing.viewBox.width / drawing.viewBox.height
        let end = drawing.pose(for: state, facing: facing)
        let moving = animated && !reduceMotion
        let fill = Color(token: end.graphite ? Tokens.graphite : Tokens.carrot)
        Group {
            if state == .absent {
                Color.clear
            } else if moving {
                KeyframeAnimator(initialValue: Gesture.rest, trigger: state) { g in
                    KeyframeAnimator(initialValue: CGFloat(1), repeating: blinks) { blink in
                        drawing.body(end.squinting(g.eyeSquash * blink), fill: fill)
                    } keyframes: { _ in
                        Gesture.blink(active: blinks)
                    }
                    .scaleEffect(x: g.scaleX, y: g.scaleY, anchor: .bottom)
                    .offset(y: g.lift * height / drawing.viewBox.height)
                    .opacity(g.opacity)
                } keyframes: { _ in
                    Gesture.track(for: state, character: character)
                }
                .keyframeAnimator(initialValue: Gesture.rest, repeating: state == .offering) { content, g in
                    content.scaleEffect(x: g.scaleX, y: g.scaleY, anchor: .bottom)
                } keyframes: { _ in
                    Gesture.breath(character: character, active: state == .offering)
                }
                .animation(postureAnimation, value: state)
            } else {
                drawing.body(end, fill: fill)
            }
        }
        .frame(width: width, height: height)
        .scaleEffect(x: facing == .left && character == .wren ? -1 : 1, y: 1)
        .accessibilityHidden(true)
    }

    /// The pebble blinks once every 5 s while offering, 150 ms.
    private var blinks: Bool { state == .offering && character == .pebble }

    private var postureAnimation: Animation {
        if state == .error && character == .seed { return Motion.curve(Motion.easeFall, 0.24) }
        return Motion.curve(Motion.easeInOut, 0.16)
    }
}

/// One-shot gestures and the breath, as keyframe tracks over a scale, a lift and an opacity.
struct Gesture {
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    var lift: CGFloat = 0
    var opacity: Double = 1
    /// The pebble's eyes: 0.18 is the happy squint.
    var eyeSquash: CGFloat = 1

    static let rest = Gesture()

    /// 5 s cycle: open until 93%, closed (0.1) at 95.5%, open again at 100%.
    static func blink(active: Bool) -> some Keyframes<CGFloat> {
        KeyframeTrack(\CGFloat.self) {
            if active {
                LinearKeyframe(1, duration: 4.65)
                LinearKeyframe(0.1, duration: 0.125)
                LinearKeyframe(1, duration: 0.225)
            } else {
                LinearKeyframe(1, duration: 0.01)
            }
        }
    }

    /// Done: bow (seed, 220 ms), squash (pebble, 260 ms), hop (wren, 280 ms). Needs you: two
    /// 600 ms dims (seed), two 1.5 pt bobs (pebble), two 300 ms chirps (wren).
    static func track(for state: FigureState, character: FigureCharacter) -> some Keyframes<Gesture> {
        KeyframeTrack(\Gesture.self) {
            switch (state, character) {
            case (.done, .seed):
                CubicKeyframe(Gesture(scaleX: 1.08, scaleY: 0.84), duration: 0.11)
                CubicKeyframe(.rest, duration: 0.11)
            case (.done, .pebble):
                // The squash (260 ms) and the happy squint (eyes closed from 25% to 75% of 420 ms).
                CubicKeyframe(Gesture(scaleX: 1.12, scaleY: 0.86, eyeSquash: 0.18), duration: 0.104)
                CubicKeyframe(Gesture(eyeSquash: 0.18), duration: 0.21)
                CubicKeyframe(.rest, duration: 0.106)
            case (.done, .wren):
                CubicKeyframe(Gesture(lift: -3), duration: 0.112)
                CubicKeyframe(.rest, duration: 0.168)
            case (.needsYou, .seed):
                CubicKeyframe(Gesture(opacity: 0.55), duration: 0.3)
                CubicKeyframe(.rest, duration: 0.3)
                CubicKeyframe(Gesture(opacity: 0.55), duration: 0.3)
                CubicKeyframe(.rest, duration: 0.3)
            case (.needsYou, .pebble):
                CubicKeyframe(Gesture(lift: -1.5), duration: 0.3)
                CubicKeyframe(.rest, duration: 0.3)
                CubicKeyframe(Gesture(lift: -1.5), duration: 0.3)
                CubicKeyframe(.rest, duration: 0.3)
            case (.needsYou, .wren):
                CubicKeyframe(Gesture(lift: -1.2), duration: 0.15)
                CubicKeyframe(.rest, duration: 0.15)
                CubicKeyframe(Gesture(lift: -1.2), duration: 0.15)
                CubicKeyframe(.rest, duration: 0.15)
            default:
                CubicKeyframe(.rest, duration: 0.01)
            }
        }
    }

    /// Offering breathes over 4 s: 3% (seed), 4% by 3% (pebble), 2% by 3% (wren).
    static func breath(character: FigureCharacter, active: Bool) -> some Keyframes<Gesture> {
        let peak: Gesture
        switch character {
        case .seed: peak = Gesture(scaleX: 1.03, scaleY: 1.03)
        case .pebble: peak = Gesture(scaleX: 1.04, scaleY: 1.03)
        case .wren: peak = Gesture(scaleX: 1.02, scaleY: 1.03)
        }
        return KeyframeTrack(\Gesture.self) {
            if active {
                CubicKeyframe(peak, duration: 2)
                CubicKeyframe(.rest, duration: 2)
            } else {
                CubicKeyframe(.rest, duration: 0.01)
            }
        }
    }
}

extension Gesture: Animatable {
    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, AnimatablePair<AnimatablePair<CGFloat, Double>, CGFloat>> {
        get { AnimatablePair(AnimatablePair(scaleX, scaleY), AnimatablePair(AnimatablePair(lift, opacity), eyeSquash)) }
        set {
            scaleX = newValue.first.first
            scaleY = newValue.first.second
            lift = newValue.second.first.first
            opacity = newValue.second.first.second
            eyeSquash = newValue.second.second
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
    /// A 16 pt template image of the character, 12 pt tall, eyes cut out. While working it is
    /// drawn in Carrot instead (`IDENTITY.md`, the one time the glyph changes).
    @MainActor
    public static func image(_ character: FigureCharacter, working: Bool) -> NSImage {
        let drawing = character.drawing
        let height: CGFloat = 12
        let width = height * drawing.viewBox.width / drawing.viewBox.height
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            let k = height / drawing.viewBox.height
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
