import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// Reduce Motion on the live figure. The render tests can't check it: `Gallery.png` sets
/// `rendersOffscreen`, which freezes every figure before Reduce Motion is read, so a render with
/// Reduce Motion on matches one with it off whether or not the figure honors it (Greptile on #19).
/// Here the figure is hosted the way a panel hosts it, and the test reads the motion plan the view
/// chose (`FigureMotionKey`).
@MainActor
final class FigureReduceMotionTests: XCTestCase {
    @MainActor
    private final class Seen {
        var plans: [FigureMotion] = []
    }

    /// The plans one hosted figure reports. `caret` is the panel's switch (`reducesMotion`, which
    /// `HostedPanel` copies from the system); `system` is SwiftUI's own Reduce Motion value. Both are
    /// set either way, so the Mac's setting can't decide the result.
    private func livePlans(_ state: FigureState, caret: Bool, system: Bool) -> [FigureMotion] {
        let seen = Seen()
        let figure = FigureView(character: .pebble, state: state, size: Tokens.FigureSize.perch)
            .environment(\.reducesMotion, caret)
            .environment(\._accessibilityReduceMotion, system)
            .environment(\.figureLife, .frozen)
            .onPreferenceChange(FigureMotionKey.self) { plans in
                MainActor.assumeIsolated { seen.plans = plans }
            }
        let host = NSHostingView(rootView: figure)
        host.frame = NSRect(x: 0, y: 0, width: 64, height: 64)
        let deadline = Date().addingTimeInterval(2)
        while seen.plans.isEmpty, Date() < deadline {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        return seen.plans
    }

    private static let states = FigureState.allCases.filter { $0 != .absent }

    /// On screen with Reduce Motion off, the figure moves as its plan says: postures on a curve,
    /// the light's crossfade at 0.24 s, and the state's gesture and rest beats. A figure frozen by
    /// `rendersOffscreen` reports an empty plan and fails here.
    func testOnScreenTheFigureMovesAsPlanned() {
        for state in Self.states {
            let moving = FigureMotion.plan(state: state, animated: true, reduce: false, size: Tokens.FigureSize.perch)
            XCTAssertNotNil(moving.posture, "\(state)")
            XCTAssertEqual(livePlans(state, caret: false, system: false), [moving], "\(state)")
        }
    }

    /// With either Reduce Motion on, the same hosted figure stops: no gesture, no rest beats,
    /// postures jump, and only the light's crossfade stays, at 0.12 s.
    func testReduceMotionStopsTheLiveFigure() {
        let still = FigureMotion(crossfade: Motion.Duration.reduced)
        for state in Self.states {
            let moving = FigureMotion.plan(state: state, animated: true, reduce: false, size: Tokens.FigureSize.perch)
            XCTAssertNotEqual(still, moving, "\(state)")
            XCTAssertEqual(livePlans(state, caret: true, system: false), [still], "\(state), Caret's switch")
            XCTAssertEqual(livePlans(state, caret: false, system: true), [still], "\(state), the system's setting")
        }
    }
}
