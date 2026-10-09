import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// The crest's drawing, poses and glyph, and the rest-beat scheduler (`FigureIdle`). Logic only:
/// nothing here renders a view to a reference or opens a window.
@MainActor
final class FigureTests: XCTestCase {
    private let pebble = Pebble()

    // MARK: - Rest beats

    private func steps(_ allowance: FigureIdle.Allowance, canGlance: Bool = false, seed: UInt64 = 1, count: Int = 2000) -> [FigureIdle.Step] {
        var rng = FigureRandom(seed: seed)
        var idle = FigureIdle()
        return (0..<count).map { _ in idle.next(allowance, canGlance: canGlance, using: &rng) }
    }

    func testGapsStayInTheirRangeAndNeverFallIntoARhythm() {
        for (allowance, range) in [(FigureIdle.Allowance(small: false, glances: true), FigureIdle.regularGap),
                                   (FigureIdle.Allowance(small: true, glances: true), FigureIdle.smallGap)] {
            let waits = steps(allowance).map(\.wait)
            XCTAssertTrue(waits.allSatisfy(range.contains), "\(allowance): every gap within \(range)")
            for (a, b) in zip(waits, waits.dropFirst()) {
                XCTAssertGreaterThanOrEqual(abs(a - b), FigureIdle.minChange - 1e-9, "\(allowance): two gaps in a row too alike: \(a), \(b)")
            }
            // Spread across the range, not bunched at one interval.
            let mean = waits.reduce(0, +) / Double(waits.count)
            let sd = (waits.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(waits.count)).squareRoot()
            XCTAssertGreaterThan(sd, 1, "\(allowance): gaps spread (sd \(sd))")
            XCTAssertEqual(mean, (range.lowerBound + range.upperBound) / 2, accuracy: 0.3)
        }
    }

    func testTheSameSeedGivesTheSameBeats() {
        let a = steps(FigureIdle.Allowance(small: false, glances: true), canGlance: true, seed: 42, count: 50)
        let b = steps(FigureIdle.Allowance(small: false, glances: true), canGlance: true, seed: 42, count: 50)
        let c = steps(FigureIdle.Allowance(small: false, glances: true), canGlance: true, seed: 43, count: 50)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
    }

    func testSlipSizesNeverDoubleBlinkAndRegularSizesSometimesDo() {
        let small = steps(FigureIdle.Allowance(small: true, glances: false)).map(\.beat)
        XCTAssertFalse(small.contains(.doubleBlink))
        let regular = steps(FigureIdle.Allowance(small: false, glances: false)).map(\.beat)
        let doubles = regular.filter { $0 == .doubleBlink }.count
        XCTAssertEqual(Double(doubles) / Double(regular.count), FigureIdle.doubleBlinkChance.regular, accuracy: 0.04)
    }

    func testGlancesNeedTypingAnAllowanceAndNeverComeTwiceInARow() {
        func glances(_ beats: [FigureIdle.Beat]) -> [Double] {
            beats.compactMap { if case .glance(let hold) = $0 { return hold } else { return nil } }
        }
        XCTAssertTrue(glances(steps(FigureIdle.Allowance(small: false, glances: true), canGlance: false).map(\.beat)).isEmpty, "no typing, no glance")
        XCTAssertTrue(glances(steps(FigureIdle.Allowance(small: false, glances: false), canGlance: true).map(\.beat)).isEmpty, "Needs you and Done only blink")

        let regular = steps(FigureIdle.Allowance(small: false, glances: true), canGlance: true).map(\.beat)
        let small = steps(FigureIdle.Allowance(small: true, glances: true), canGlance: true).map(\.beat)
        for beats in [regular, small] {
            for (a, b) in zip(beats, beats.dropFirst()) {
                if case .glance = a, case .glance = b { XCTFail("two glances in a row") }
            }
            XCTAssertTrue(glances(beats).allSatisfy(FigureIdle.hold.contains))
        }
        XCTAssertGreaterThan(glances(regular).count, glances(small).count, "slip sizes glance less often")
        XCTAssertGreaterThan(glances(small).count, 0)
    }

    func testOnlyARestingFigureHasBeats() {
        XCTAssertEqual(FigureIdle.allowance(state: .offering, size: 14), FigureIdle.Allowance(small: true, glances: true))
        XCTAssertEqual(FigureIdle.allowance(state: .noticed, size: 22), FigureIdle.Allowance(small: false, glances: true))
        XCTAssertEqual(FigureIdle.allowance(state: .needsYou, size: 64), FigureIdle.Allowance(small: false, glances: false))
        XCTAssertEqual(FigureIdle.allowance(state: .done, size: 16), FigureIdle.Allowance(small: true, glances: false))
        for state in [FigureState.working, .error, .absent] {
            XCTAssertNil(FigureIdle.allowance(state: state, size: 64), "\(state): away or the light is out")
        }
    }

    func testTheTypingDirectionPointsFromTheSeatToTheCaret() throws {
        // A slip above a field, the caret below and to the left of the figure's seat.
        let panel = CGRect(x: 100, y: 100, width: 300, height: 30)
        let seat = CGPoint(x: 15, y: 15)
        let toward = try XCTUnwrap(FigureIdle.typingDirection(panel: panel, seat: seat, caret: CGRect(x: 50, y: 200, width: 2, height: 18)))
        XCTAssertEqual(hypot(toward.dx, toward.dy), 1, accuracy: 1e-9)
        XCTAssertLessThan(toward.dx, 0)
        XCTAssertGreaterThan(toward.dy, 0, "y grows down, as Accessibility's does")
        XCTAssertNil(FigureIdle.typingDirection(panel: panel, seat: seat, caret: .zero), "no caret, no direction")
        XCTAssertNil(FigureIdle.typingDirection(panel: panel, seat: seat, caret: CGRect(x: 114, y: 106, width: 2, height: 18)), "under the seat")
    }

    // MARK: - Poses

    func testEachStateHasItsHandoffPose() {
        let noticed = pebble.pose(for: .noticed, facing: .right)
        XCTAssertEqual(noticed.eyeOffset, CGSize(width: 1.1, height: 0))
        XCTAssertEqual(noticed.rotation, 2)

        let working = pebble.pose(for: .working, facing: .right)
        XCTAssertEqual(working.eyeOffset, CGSize(width: 0.9, height: -0.9))
        XCTAssertEqual(working.eyeScaleX, 0.55)
        XCTAssertEqual(working.rotation, 3)

        let needs = pebble.pose(for: .needsYou, facing: .right)
        XCTAssertEqual(needs.eyeScale, 1.25)
        XCTAssertEqual(needs.rotation, 0)

        let error = pebble.pose(for: .error, facing: .right)
        XCTAssertTrue(error.graphite && error.lids)
        XCTAssertEqual(error.rotation, -4)
        XCTAssertEqual(error.bodyScale, CGSize(width: 1.04, height: 0.9))
        XCTAssertEqual(error.eyeOffset, CGSize(width: 0, height: 0.6))

        XCTAssertEqual(pebble.pose(for: .still, facing: .right), FigurePose())
        for state in FigureState.allCases {
            XCTAssertEqual(pebble.pose(for: state, facing: .left), pebble.pose(for: state, facing: .right), "\(state): the view mirrors, the pose does not")
        }
    }

    func testAGazeLeftIsTheMirrorsJobNotThePoses() {
        let left = pebble.pose(for: .noticed, gaze: CGVector(dx: -0.5, dy: 0.25))
        XCTAssertEqual(left.eyeOffset.width, 0.55, accuracy: 1e-9)
        XCTAssertEqual(left.eyeOffset.height, 0.2, accuracy: 1e-9)
        XCTAssertEqual(left.rotation, 1, accuracy: 1e-9)
        XCTAssertEqual(left, pebble.pose(for: .noticed, gaze: CGVector(dx: 0.5, dy: 0.25)))
        XCTAssertEqual(pebble.pose(for: .done, gaze: CGVector(dx: -1, dy: 1)), pebble.pose(for: .done, facing: .right), "Done keeps its eyes ahead")
    }

    func testAGlanceMovesOnlyTheEyesAndTurnsWithTheMirror() {
        let offering = pebble.pose(for: .offering, facing: .right)
        let back = pebble.glancing(offering, toward: CGVector(dx: -1, dy: 0), mirrored: false, reach: 1)
        XCTAssertEqual(back.eyeOffset.width, -1.1, accuracy: 1e-9)
        XCTAssertEqual(back.rotation, offering.rotation, "a glance is the eyes alone")
        let mirrored = pebble.glancing(offering, toward: CGVector(dx: -1, dy: 0), mirrored: true, reach: 1)
        XCTAssertEqual(mirrored.eyeOffset.width, 1.1, accuracy: 1e-9, "facing left, screen left is ahead")
        let flick = pebble.glancing(offering, toward: CGVector(dx: 0, dy: 1), mirrored: false, reach: FigureIdle.smallReach)
        XCTAssertEqual(flick.eyeOffset.height, 0.8 * 0.6, accuracy: 1e-9)
    }

    func testABlinkClosesToADash() {
        XCTAssertEqual(Gesture.blinkClosed, 0.12)
    }

    // MARK: - Drawing and glyph

    /// The apex is a fillet, not a corner: the crest's top sits a little under the old point
    /// (7.8, 1) and is still forward of the middle.
    func testTheCrestIsPointedButRounded() {
        var p = Path()
        Pebble.outline(&p)
        let top = p.cgPath.boundingBoxOfPath // the curve itself, not its control points
        XCTAssertEqual(top.minY, 1.046, accuracy: 0.01)
        XCTAssertEqual(top.minX, 0.4, accuracy: 0.001)
        XCTAssertEqual(top.maxX, 11.6, accuracy: 0.001)
        XCTAssertEqual(top.maxY, 10.4, accuracy: 0.001)
    }

    /// Working narrows the cut-out eyes to bars: a point inside the resting eye but outside the
    /// bar is clear at rest and solid while working.
    func testTheWorkingGlyphNarrowsItsEyesToBars() throws {
        func alpha(working: Bool, at viewBox: CGPoint) throws -> CGFloat {
            let image = FigureGlyph.image(.pebble, working: working)
            let rep = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 128, pixelsHigh: 128, bitsPerSample: 8, samplesPerPixel: 4,
                                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
            rep.size = NSSize(width: 16, height: 16)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            image.draw(in: NSRect(x: 0, y: 0, width: 16, height: 16))
            NSGraphicsContext.restoreGraphicsState()
            let k: CGFloat = 13 / 12
            let x = 1.5 + viewBox.x * k, y = (16 - 11 * k) / 2 + viewBox.y * k
            return rep.colorAt(x: Int(x * 8), y: Int(y * 8))?.alphaComponent ?? 0
        }
        // 0.6 left of the left eye's center: inside the 1.5 wide capsule, outside the 0.8 bar.
        let edge = CGPoint(x: 4.7 - 0.6, y: 6.3)
        XCTAssertLessThan(try alpha(working: false, at: edge), 0.2, "cut out at rest")
        XCTAssertGreaterThan(try alpha(working: true, at: edge), 0.8, "solid beside the bar while working")
        XCTAssertLessThan(try alpha(working: true, at: CGPoint(x: 4.7, y: 6.3)), 0.2, "the bar itself is cut out")
    }

    /// The menu bar reference draws both glyphs, so its snapshot guards them: the lit one in Carrot
    /// and the resting template one in the bar's ink. The two halves hold the same clock, so the
    /// resting half's extra dark pixels are its glyph. The reference was once blank (the strips were
    /// clipped to their empty middle) and passed every comparison.
    func testTheMenuBarRenderShowsBothGlyphs() throws {
        let item = try XCTUnwrap(Gallery.glyph().first)
        let rep = try XCTUnwrap(Gallery.png(item.view, dark: false).flatMap(NSBitmapImageRep.init(data:)))
        var carrot = 0, inkRest = 0, inkLit = 0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let (r, g, b) = (c.redComponent, c.greenComponent, c.blueComponent)
                if r > 0.7, g > 0.25, g < 0.6, b < 0.35 { carrot += 1 }
                if r + g + b < 0.9 { if x < rep.pixelsWide / 2 { inkRest += 1 } else { inkLit += 1 } }
            }
        }
        XCTAssertGreaterThan(carrot, 100, "the lit glyph is drawn in Carrot")
        XCTAssertGreaterThan(inkRest - inkLit, 100, "the resting glyph is drawn in the bar's ink")
    }
}
