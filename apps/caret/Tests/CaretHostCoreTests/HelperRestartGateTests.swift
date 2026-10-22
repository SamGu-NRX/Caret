import XCTest
@testable import CaretHostCore

/// A preview asked for while the helper restarts waits for the new helper.
final class HelperRestartGateTests: XCTestCase {
    func testItHoldsUntilTheConnectionHasGoneDownAndComeBack() {
        var gate = HelperRestartGate()
        XCTAssertFalse(gate.holds(at: 0), "nothing asked for: nothing held")
        gate.restartRequested(at: 100)
        XCTAssertTrue(gate.holds(at: 100), "the old helper may still answer")
        gate.link(up: true)
        XCTAssertTrue(gate.holds(at: 101), "an up before any down is the old connection")
        gate.link(up: false)
        XCTAssertTrue(gate.holds(at: 101))
        gate.link(up: true)
        XCTAssertFalse(gate.holds(at: 102), "the new helper is connected")
    }

    func testARestartThatNeverHappensStopsHoldingAfterTheLimit() {
        var gate = HelperRestartGate()
        gate.restartRequested(at: 0)
        XCTAssertTrue(gate.holds(at: HelperRestartGate.waitLimit - 0.1))
        XCTAssertFalse(gate.holds(at: HelperRestartGate.waitLimit))
    }
}
