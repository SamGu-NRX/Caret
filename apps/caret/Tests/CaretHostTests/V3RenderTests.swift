import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI
import XCTest
@testable import CaretHost

/// v3 part 1: the slip at the edges, alternatives that must not wrap, the underline that stops at
/// its text, and Reduce Motion. Off screen; nothing here opens a window or posts an event.
@MainActor
final class SlipEdgeTests: XCTestCase {
    /// LEAD-REVIEW defect 3: the prototype's slip ran off the screen. At every edge the rule's
    /// frame is whole on the screen, 8 pt inside, and off the caret's line.
    func testTheSlipStaysWholeAtEveryEdge() {
        let usable = SlipEdgeScene.screen.insetBy(dx: FieldPanelPlacement.margin, dy: FieldPanelPlacement.margin)
        for edge in SlipEdgeScene.Edge.allCases {
            let scene = SlipEdgeScene(edge: edge)
            let frame = scene.choice.frame
            XCTAssertTrue(usable.contains(frame), "\(edge): \(frame) leaves \(usable)")
            let line = CGRect(x: scene.field.minX, y: scene.caret.minY, width: scene.field.width, height: scene.caret.height)
            XCTAssertFalse(frame.intersects(line), "\(edge) covers the caret's line")
        }
    }

    func testAtTheRightEdgeTheSlipIsPushedLeftNotCut() {
        let scene = SlipEdgeScene(edge: .screenRight)
        XCTAssertLessThan(scene.choice.frame.minX, scene.caret.minX - FieldPanelPlacement.caretInset, "moved left of its usual spot")
        XCTAssertEqual(scene.choice.frame.maxX, SlipEdgeScene.screen.maxX - FieldPanelPlacement.margin, accuracy: 0.5)
    }

    func testAtTheBottomTheSlipFlipsAboveTheCaret() {
        for edge in [SlipEdgeScene.Edge.screenBottom, .windowBottom] {
            let scene = SlipEdgeScene(edge: edge)
            XCTAssertEqual(scene.choice.spot.corner, .bottomLeft, "\(edge) pins its bottom, so it grows upward")
            XCTAssertLessThanOrEqual(scene.choice.frame.maxY, scene.caret.minY, "\(edge) sits above the caret")
        }
    }

    /// In a text view the slip stays inside what is visible of the host window when it fits.
    func testAtTheWindowsRightEdgeTheSlipStaysInsideTheWindow() {
        let scene = SlipEdgeScene(edge: .windowRight)
        XCTAssertLessThanOrEqual(scene.choice.frame.maxX, scene.window.maxX - FieldPanelPlacement.margin + 0.5)
    }

    /// Defect 2, the wrap: an alternative too long for the line drops the figure and ticks rather
    /// than push them onto a second line, and the scene stays one line tall.
    func testALongAlternativeNeverWrapsTheFigureAndTicks() throws {
        let caret = CGRect(x: 300, y: 4, width: 1, height: 16)
        let field = CGRect(x: 0, y: 0, width: 640, height: 24)
        let fits = AlternativesLayout(caret: caret, field: field, textWidth: 200, fontSize: 13, tagWidth: 40, open: true)
        XCTAssertTrue(fits.showsTag)
        let long = AlternativesLayout(caret: caret, field: field, textWidth: 320, fontSize: 13, tagWidth: 40, open: true)
        XCTAssertFalse(long.showsTag)
        XCTAssertNil(long.tagFrame(caret: caret, width: 40, height: 12))
        let frame = try XCTUnwrap(fits.tagFrame(caret: caret, width: 40, height: 12))
        XCTAssertLessThanOrEqual(frame.maxX, field.maxX - AlternativesLayout.edge)
        XCTAssertEqual(frame.maxY, caret.minY + caret.height * 0.78, accuracy: 0.01, "bottom on the baseline")

        // The render: one 24 pt line, and no Carrot tick or lit skin anywhere in it.
        let render = try Pixels(XCTUnwrap(Gallery.png(Gallery.alternativesEdges()[0].view, dark: false, padding: 0)))
        XCTAssertEqual(render.height, 48, "one line at 2x")
        XCTAssertEqual(render.count { $0.0 - $0.2 > 50 && $0.0 > $0.1 }, 0, "no lit tick or figure drawn")
    }

    /// Defect 2, the overrun: the underline stops at its text, and at the field's edge when the
    /// text runs past it.
    func testTheUnderlineStopsAtItsText() throws {
        let caret = CGRect(x: 300, y: 4, width: 1, height: 16)
        let field = CGRect(x: 0, y: 0, width: 640, height: 24)
        XCTAssertEqual(AlternativesLayout(caret: caret, field: field, textWidth: 120, fontSize: 13, tagWidth: 40, open: false).underlineWidth, 120)
        XCTAssertEqual(AlternativesLayout(caret: caret, field: field, textWidth: 900, fontSize: 13, tagWidth: 40, open: false).underlineWidth, 640 - 2 - 301)

        // The render: the rightmost underline pixel is at the text's end, not past it.
        let scene = AlternativesScene(character: .pebble, collapsed: true)
        let font = AlternativesScene.font
        let lead = ceil((AlternativesScene.lead as NSString).size(withAttributes: [.font: font]).width)
        let text = ceil((Gallery.alternatives[0] as NSString).size(withAttributes: [.font: font]).width)
        let end = 4 + lead + 1 + text
        let render = try Pixels(XCTUnwrap(Gallery.png(scene, dark: false, padding: 0)))
        // The underline is Carrot at 0.55 over the page: the only warm pixels in the scene.
        let rightmost = try XCTUnwrap(render.rightmost { $0.0 - $0.2 > 50 && $0.0 > $0.1 }, "an underline is drawn")
        XCTAssertLessThanOrEqual(CGFloat(rightmost) / 2, end + 1.5, "the underline runs past its text")
        XCTAssertGreaterThanOrEqual(CGFloat(rightmost) / 2, end - 3, "the underline reaches its text's end")

        // And it sits 2 pt under the baseline, whatever room is below the caret.
        let rows = (0..<render.height).filter { y in (0..<render.width).contains { x in let p = render.rgb(y * render.width + x); return p.0 - p.2 > 50 && p.0 > p.1 } }
        let middle = CGFloat(rows.first! + rows.last! + 1) / 4
        let lineHeight = ceil(font.ascender - font.descender + font.leading)
        let caretTop = (24 - lineHeight) / 2
        XCTAssertEqual(middle, caretTop + lineHeight * 0.78 + 2, accuracy: 1, "the underline's middle is 2 pt under the baseline")
    }
}

@MainActor
final class ReduceMotionTests: XCTestCase {
    /// Every entrance becomes a 0.12 s fade with no scale or settle.
    func testPanelsFadeInAt012WithNoMovement() {
        for popup in [false, true] {
            XCTAssertEqual(Motion.Entrance.panel(popup: popup, reduce: true), Motion.Entrance(duration: 0.12, scale: nil, settle: 0))
        }
        XCTAssertEqual(Motion.Entrance.panel(popup: false, reduce: false), Motion.Entrance(duration: 0.16, scale: 0.97, settle: 2))
        XCTAssertEqual(Motion.Entrance.panel(popup: true, reduce: false), Motion.Entrance(duration: 0.18, scale: 0.96, settle: 2))
    }

    /// Every exit that fades is a 0.12 s fade; one that is at once stays at once.
    func testExitsFadeAt012() {
        XCTAssertEqual(Motion.exit(0.22, reduce: true), 0.12)
        XCTAssertEqual(Motion.exit(0.08, reduce: true), 0.12)
        XCTAssertEqual(Motion.exit(0, reduce: true), 0)
        XCTAssertEqual(Motion.exit(0.22, reduce: false), 0.22)
    }

    /// Under Reduce Motion the figure's gestures, rest beats and moves stop and postures jump; only
    /// the light's crossfade stays, at 0.12 s.
    func testTheFiguresGesturesAndRestStopUnderReduceMotion() {
        for state in FigureState.allCases where state != .absent {
            XCTAssertEqual(FigureMotion.plan(state: state, animated: true, reduce: true, size: 22),
                           FigureMotion(crossfade: Motion.Duration.reduced), "\(state)")
        }
        let offering = FigureMotion.plan(state: .offering, animated: true, reduce: false, size: 14)
        XCTAssertEqual(offering.posture, .settle)
        XCTAssertEqual(offering.rest, FigureIdle.Allowance(small: true, glances: true))
        let done = FigureMotion.plan(state: .done, animated: true, reduce: false, size: 14)
        XCTAssertTrue(done.gesture && done.glowPulse)
        XCTAssertEqual(FigureMotion.plan(state: .error, animated: true, reduce: false, size: 22).posture, .heavy, "the light going out does not bounce")
        XCTAssertEqual(FigureMotion.plan(state: .offering, animated: false, reduce: false, size: 22), FigureMotion(), "a render is one frozen frame")
    }

    /// Under Reduce Motion a slip draws its end state in every frame: the render with the
    /// environment set equals the still render.
    func testASlipUnderReduceMotionDrawsItsEndState() throws {
        let content = WorkLines.done(app: "Calendar", undo: true).content
        let still = try XCTUnwrap(Gallery.png(LineView(content: content, character: .pebble, animated: false), dark: false))
        let reduced = try XCTUnwrap(Gallery.png(LineView(content: content, character: .pebble, animated: true).environment(\.reducesMotion, true), dark: false))
        XCTAssertEqual(try SnapshotTests.difference(still, reduced), 0)
    }
}

/// Contrast of every text and mark against what is behind it, measured from rendered pixels. Each
/// surface is rendered twice, with and without one token (`Tokens.hidden`); the pixels that change
/// are that token's glyphs and marks, and the second render is what is behind them. Per connected
/// shape (a glyph, a dot, the bar) the strongest pixel is its color over its ground; the token's
/// ratio is the weakest shape's. Text needs 4.5:1, marks 3:1 (WCAG 1.4.3, 1.4.11).
@MainActor
final class ContrastRenderTests: XCTestCase {
    struct Probe {
        let name: String
        let token: NSColor
        let minimum: Double
    }

    /// The document behind the glass: Caret's theme over a page of either theme, the worst case
    /// being the opposite one.
    static let grounds: [(String, UInt32)] = [("white page", 0xFFFFFF), ("dark editor", 0x1F1F24)]

    static func surfaces() -> [(String, AnyView, [Probe])] {
        let text = 4.5, mark = 3.0
        let lines = Dictionary(uniqueKeysWithValues: Gallery.lines().map { ($0.name, $0.view) })
        let specs = Dictionary(uniqueKeysWithValues: Gallery.specs().map { ($0.name, $0.view) })
        let skills = Dictionary(uniqueKeysWithValues: Gallery.skillLines().map { ($0.name, $0.view) })
        return [
            ("Offer slip", lines["line-action"]!, [Probe(name: "Ink, sentence", token: Tokens.ink, minimum: text),
                                                    Probe(name: "Ink 2, keycap label and app glyph", token: Tokens.ink2, minimum: text)]),
            ("Working slip", lines["line-working-stoppable"]!, [Probe(name: "Ink, caption and seconds", token: Tokens.ink, minimum: text),
                                                                Probe(name: "Ink 2, Esc Stop", token: Tokens.ink2, minimum: text),
                                                                Probe(name: "Carrot, step bar", token: Tokens.carrot, minimum: mark)]),
            ("Result slip", lines["line-done"]!, [Probe(name: "Carrot text, Added", token: Tokens.carrotText, minimum: text),
                                                  Probe(name: "Ink 2, ⌘Z Undo", token: Tokens.ink2, minimum: text)]),
            ("Error slip", lines["line-error"]!, [Probe(name: "Ink, sentence", token: Tokens.ink, minimum: text),
                                                  Probe(name: "Graphite, error figure", token: Tokens.graphite, minimum: mark)]),
            ("Fill slip", lines["line-fill-source"]!, [Probe(name: "Ink 2, source and Tab Fill", token: Tokens.ink2, minimum: text)]),
            ("Question slip", skills["skill-promote"]!, [Probe(name: "Ink, question", token: Tokens.ink, minimum: text),
                                                         Probe(name: "Ink 2, hint and keys", token: Tokens.ink2, minimum: text)]),
            ("Picker pop-up", specs["popup-picker"]!, [Probe(name: "Ink, title and chosen row", token: Tokens.ink, minimum: text),
                                                       Probe(name: "Ink 2, other rows, hints, keycaps", token: Tokens.ink2, minimum: text),
                                                       Probe(name: "Carrot, chosen row's edge", token: Tokens.carrot, minimum: mark)]),
            ("Fill preview pop-up", specs["popup-fill-preview"]!, [Probe(name: "Ink 2, labels and source", token: Tokens.ink2, minimum: text)]),
            // The ticks stand on the host's document, which the scene draws, not on glass.
            ("Alternatives in text", lines["alternatives-open"]!, [Probe(name: "Ink 3, idle ticks", token: Tokens.ink3, minimum: mark),
                                                                   Probe(name: "Carrot, current tick", token: Tokens.carrot, minimum: mark)]),
        ]
    }

    func testEveryTextAndMarkMeetsItsContrastInBothThemes() throws {
        var table = ["| Surface | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, view, probes) in Self.surfaces() {
            for probe in probes {
                var cells: [String] = []
                for dark in [false, true] {
                    for (ground, hex) in Self.grounds {
                        let ratio = try Self.measure(view, token: probe.token, dark: dark, canvas: hex)
                        cells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
                        if let ratio, ratio < probe.minimum {
                            failures.append("\(surface), \(probe.name), \(dark ? "dark" : "light") over \(ground): \(String(format: "%.2f", ratio))")
                        }
                        if ratio == nil { failures.append("\(surface), \(probe.name): nothing drawn in that token") }
                    }
                }
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | \(probe.minimum == 4.5 ? "4.5 text" : "3 mark") |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    /// The weakest shape's ratio, or nil when the token draws nothing in the view.
    static func measure(_ view: AnyView, token: NSColor, dark: Bool, canvas: UInt32) throws -> Double? {
        let shown = try Pixels(XCTUnwrap(Gallery.png(view, dark: dark, canvasHex: canvas)))
        Tokens.hidden = token
        defer { Tokens.hidden = nil }
        let hidden = try Pixels(XCTUnwrap(Gallery.png(view, dark: dark, canvasHex: canvas)))
        precondition(shown.width == hidden.width && shown.height == hidden.height)
        var changed = [Bool](repeating: false, count: shown.width * shown.height)
        for i in changed.indices where Pixels.distance(shown.rgb(i), hidden.rgb(i)) > 6 { changed[i] = true }
        var seen = [Bool](repeating: false, count: changed.count)
        var weakest: Double?
        for start in changed.indices where changed[start] && !seen[start] {
            var stack = [start], members: [Int] = []
            seen[start] = true
            while let i = stack.popLast() {
                members.append(i)
                let x = i % shown.width, y = i / shown.width
                for dy in -1...1 { for dx in -1...1 {
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < shown.width, ny < shown.height else { continue }
                    let j = ny * shown.width + nx
                    if changed[j] && !seen[j] { seen[j] = true; stack.append(j) }
                }}
            }
            // A speck of a few pixels is antialiasing at a shape's edge, not a shape.
            guard members.count >= 6 else { continue }
            // Its ground is the commonest color behind it: a lid over an eye is measured against
            // the glass the figure stands on, not against the eye.
            var grounds: [Int: Int] = [:]
            func bucket(_ p: (Double, Double, Double)) -> Int { (Int(p.0) >> 3) << 10 | (Int(p.1) >> 3) << 5 | Int(p.2) >> 3 }
            for i in members { grounds[bucket(hidden.rgb(i)), default: 0] += 1 }
            let ground = grounds.max { $0.value < $1.value }!.key
            let best = members.filter { bucket(hidden.rgb($0)) == ground }
                .map { Pixels.contrast(shown.rgb($0), hidden.rgb($0)) }.max() ?? 0
            weakest = min(weakest ?? .infinity, best)
        }
        return weakest
    }
}

/// An RGBA render's pixels, sRGB, 8 bits.
struct Pixels {
    let width: Int
    let height: Int
    let data: [UInt8]

    init(_ png: Data) throws {
        let rep = try XCTUnwrap(NSBitmapImageRep(data: png))
        width = rep.pixelsWide
        height = rep.pixelsHigh
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = try XCTUnwrap(CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(try XCTUnwrap(rep.cgImage), in: CGRect(x: 0, y: 0, width: width, height: height))
        data = pixels
    }

    func rgb(_ i: Int) -> (Double, Double, Double) {
        (Double(data[i * 4]), Double(data[i * 4 + 1]), Double(data[i * 4 + 2]))
    }

    func count(_ match: ((Double, Double, Double)) -> Bool) -> Int {
        (0..<(width * height)).filter { match(rgb($0)) }.count
    }

    /// The rightmost column holding a matching pixel.
    func rightmost(_ match: ((Double, Double, Double)) -> Bool) -> Int? {
        var best: Int?
        for i in 0..<(width * height) where match(rgb(i)) { best = max(best ?? 0, i % width) }
        return best
    }

    static func near(_ p: (Double, Double, Double), _ color: NSColor, _ tolerance: Double) -> Bool {
        let c = color.usingColorSpace(.sRGB)!
        return distance(p, (Double(c.redComponent) * 255, Double(c.greenComponent) * 255, Double(c.blueComponent) * 255)) <= tolerance
    }

    static func distance(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        max(abs(a.0 - b.0), abs(a.1 - b.1), abs(a.2 - b.2))
    }

    static func luminance(_ p: (Double, Double, Double)) -> Double {
        func linear(_ c: Double) -> Double { let v = c / 255; return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(p.0) + 0.7152 * linear(p.1) + 0.0722 * linear(p.2)
    }

    static func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        let (la, lb) = (luminance(a), luminance(b))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
}
