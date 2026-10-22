import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Reduce Motion on the live figure and the live slip. The render tests can't check it: `Gallery.png`
/// sets `rendersOffscreen`, which freezes every figure before Reduce Motion is read, and an image
/// render draws one still frame whatever the slip decided. So a render with Reduce Motion on matches
/// one with it off whether or not either view honors it (Greptile on #19). Here each view is hosted
/// the way a panel hosts it, and the test reads the motion it chose (`FigureMotionKey`,
/// `SlipMotionKey`).
@MainActor
final class ReduceMotionLiveTests: XCTestCase {
    @MainActor
    private final class Seen<Value> {
        var value: Value?
    }

    /// What one hosted view reports for `key`. `caret` is the panel's switch (`reducesMotion`, which
    /// `HostedPanel` copies from the system); `system` is SwiftUI's own Reduce Motion value. Both are
    /// set either way, so the Mac's setting can't decide the result.
    private func reported<K: PreferenceKey>(_ key: K.Type, by view: some View, caret: Bool, system: Bool) -> K.Value?
        where K.Value: Equatable {
        let seen = Seen<K.Value>()
        let root = view
            .environment(\.reducesMotion, caret)
            .environment(\._accessibilityReduceMotion, system)
            .environment(\.figureLife, .frozen)
            .onPreferenceChange(key) { value in
                MainActor.assumeIsolated { seen.value = value }
            }
        let host = NSHostingView(rootView: root)
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 120)
        let deadline = Date().addingTimeInterval(2)
        while seen.value == nil, Date() < deadline {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return seen.value
    }

    // MARK: - The figure

    private static let states = FigureState.allCases.filter { $0 != .absent }

    private func figure(_ state: FigureState) -> FigureView {
        FigureView(character: .pebble, state: state, size: Tokens.FigureSize.perch)
    }

    /// On screen with Reduce Motion off, the figure moves as its plan says: postures on a curve,
    /// the light's crossfade at 0.24 s, and the state's gesture and rest beats. A figure frozen by
    /// `rendersOffscreen` reports an empty plan and fails here.
    func testOnScreenTheFigureMovesAsPlanned() {
        for state in Self.states {
            let moving = FigureMotion.plan(state: state, animated: true, reduce: false, size: Tokens.FigureSize.perch)
            XCTAssertNotNil(moving.posture, "\(state)")
            XCTAssertEqual(reported(FigureMotionKey.self, by: figure(state), caret: false, system: false), [moving], "\(state)")
        }
    }

    /// With either Reduce Motion on, the same hosted figure stops: no gesture, no rest beats,
    /// postures jump, and only the light's crossfade stays, at 0.12 s.
    func testReduceMotionStopsTheLiveFigure() {
        let still = FigureMotion(crossfade: Motion.Duration.reduced)
        for state in Self.states {
            let moving = FigureMotion.plan(state: state, animated: true, reduce: false, size: Tokens.FigureSize.perch)
            XCTAssertNotEqual(still, moving, "\(state)")
            XCTAssertEqual(reported(FigureMotionKey.self, by: figure(state), caret: true, system: false), [still], "\(state), Caret's switch")
            XCTAssertEqual(reported(FigureMotionKey.self, by: figure(state), caret: false, system: true), [still], "\(state), the system's setting")
        }
    }

    // MARK: - The slip

    /// A working slip with a question under it, so every motion the slip has (the caption's swap,
    /// the figure leaving its seat, the question row, the step bar) is on screen.
    private var slip: LineView {
        LineView(content: LineContent(figure: .working, app: "Calendar", text: "Adding to Calendar",
                                      question: LineContent.Question(text: "Which calendar?"), progress: 0.5),
                 character: .pebble)
    }

    /// On screen with Reduce Motion off, a slip's changes move.
    func testOnScreenTheSlipMoves() {
        XCTAssertEqual(reported(SlipMotionKey.self, by: slip, caret: false, system: false), [SlipMotion(moves: true, fades: false)])
    }

    /// With either Reduce Motion on, the same hosted slip's changes fade at 0.12 s instead of moving.
    func testReduceMotionTurnsTheLiveSlipsMovesIntoFades() {
        let fading = SlipMotion(moves: false, fades: true)
        XCTAssertEqual(reported(SlipMotionKey.self, by: slip, caret: true, system: false), [fading], "Caret's switch")
        XCTAssertEqual(reported(SlipMotionKey.self, by: slip, caret: false, system: true), [fading], "the system's setting")
    }
}
