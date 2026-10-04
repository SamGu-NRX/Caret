import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// A15 part 3: a fill whose source window has closed is withdrawn as soon as the host can tell, and
/// is not offered again, rather than shown until Tab and refused there (A14 walk-3). Withdrawn, not
/// dimmed: what is on screen at the caret is always something Tab can take.
final class FillSourceGoneTests: XCTestCase {
    private func shown() -> FillRig {
        let rig = FillRig()
        rig.world.front(.email)
        rig.propose()
        XCTAssertEqual(rig.takeLog(), ["watch 5150", "offer \(FillFx.email) \(FillFx.caption) showLine"])
        return rig
    }

    func testAShownValueIsWithdrawnWithinARecheckOfItsSourceClosing() {
        let rig = shown()
        rig.world.closedSources = ["Reference"]
        rig.clock.advance(by: FillMachine.recheckInterval)
        XCTAssertNil(rig.arbiter.snapshot().current, "Tab has nothing to take")
        XCTAssertNil(rig.machine.shownOfferID)
        XCTAssertEqual(rig.takeLog(), ["hide offer"])
        XCTAssertTrue(rig.counts.contains("fill.withdrawn.sourceGone"))
        XCTAssertEqual(rig.machine.status.lastSkip, "sourceGone")
        // Tab now reaches the app.
        XCTAssertEqual(rig.arbiter.handleKeyDown(Fx.tab(), now: rig.clock.now), .pass(.noOffer))
    }

    func testAValueWhoseSourceIsAlreadyGoneIsNeverShown() {
        let rig = FillRig()
        rig.world.front(.email)
        rig.world.closedSources = ["Reference"]
        rig.propose()
        XCTAssertNil(rig.arbiter.snapshot().current)
        XCTAssertEqual(rig.takeLog(), ["watch 5150"])
        XCTAssertEqual(rig.machine.status.lastSkip, "sourceGone")
    }

    func testItIsNotOfferedAgainWhenTheFieldIsLookedAtAgain() {
        let rig = shown()
        rig.world.closedSources = ["Reference"]
        rig.clock.advance(by: FillMachine.recheckInterval)
        rig.takeLog()
        rig.world.closedSources = []
        rig.machine.fieldChanged(pid: Fx.app, at: 2)
        XCTAssertNil(rig.arbiter.snapshot().current, "a source that closed once is not trusted for this value again; the helper proposes anew")
    }

    func testAValueFromMemoryHasNoWindowToClose() {
        let rig = FillRig()
        rig.world.front(.email)
        rig.world.closedSources = ["Reference"]
        rig.propose(FillFx.memoryProposal())
        XCTAssertEqual(rig.arbiter.snapshot().current?.text, FillFx.email)
        rig.clock.advance(by: FillMachine.recheckInterval)
        XCTAssertNotNil(rig.arbiter.snapshot().current)
    }
}
