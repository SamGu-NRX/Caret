import XCTest
import SwiftUI
import CaretCore
@testable import Caret

final class MeetingDemoTests: XCTestCase {
    private func offer() -> CaretActionOffer {
        CaretActionOffer(
            proposalID: "demo", revision: 1,
            target: TargetIdentity(pid: 1, bundleID: "test", windowID: "w", elementID: "e", elementRevision: "r"),
            workflowID: "book-calendar-link", title: "Propose meeting times", effect: "",
            evidence: [], missingInputs: [], executionMethod: "local-sample-planner", sampleOnly: true
        )
    }

    func testExplicitOptInAndEnvironmentPrecedence() throws {
        let empty = CoreLaunchSettings.DeveloperConfig()
        let enabled = try JSONDecoder().decode(CoreLaunchSettings.DeveloperConfig.self, from: Data("{\"demoMeeting\":true}".utf8))
        XCTAssertFalse(CoreLaunchSettings.demoMeetingEnabled(environment: [:], config: empty))
        XCTAssertTrue(CoreLaunchSettings.demoMeetingEnabled(environment: ["CARET_DEMO_MEETING": "1"], config: empty))
        XCTAssertTrue(CoreLaunchSettings.demoMeetingEnabled(environment: [:], config: enabled))
        for value in ["0", "true", "", "yes"] {
            XCTAssertFalse(CoreLaunchSettings.demoMeetingEnabled(environment: ["CARET_DEMO_MEETING": value], config: enabled))
        }
    }

    func testOnlyExactLocalMeetingSampleCanRun() {
        var demo = offer()
        XCTAssertFalse(demo.isExecutable(demoMeetingEnabled: false))
        XCTAssertTrue(demo.isExecutable(demoMeetingEnabled: true))
        XCTAssertTrue(demo.sampleOnly)
        demo.missingInputs = ["calendar"]
        XCTAssertFalse(demo.isExecutable(demoMeetingEnabled: true))
        demo.missingInputs = []
        for method in ["", "unwired", "draft_only", "local-sample-planner ", "LOCAL-SAMPLE-PLANNER"] {
            demo.executionMethod = method
            XCTAssertFalse(demo.isExecutable(demoMeetingEnabled: true))
        }
        demo.executionMethod = "local-sample-planner"
        demo.workflowID = "another-sample"
        XCTAssertFalse(demo.isExecutable(demoMeetingEnabled: true))
    }

    func testDemoCompletionNeverClaimsExternalCompletionOrTruncatesEvidence() {
        let demo = offer()
        XCTAssertEqual(demo.completionScope, .localDemo)
        XCTAssertEqual(demo.completionScope.label, "Demo holds created")
        let rows = (1...8).map { "Synthetic hold \($0) read back from local database" } + ["No external calendar changed."]
        XCTAssertEqual(CaretActionOffer.visibleEvidence(rows, scope: demo.completionScope), rows)
        XCTAssertEqual(CaretActionOffer.CompletionScope.draftOnly.label, "Draft ready")
        XCTAssertEqual(CaretActionOffer.CompletionScope.externalEffect.label, "Done")
    }

    @MainActor
    func testPreviewExpandsForFullProposalAndEvidence() {
        var demo = offer()
        let compact = NSHostingView(rootView: CaretActionOfferRow(offer: demo, run: {}).frame(width: 340))
        let compactHeight = compact.fittingSize.height
        // Synthetic strings test wrapping only; production times always come from the adapter.
        demo.effect = (1...6).map { "Option \($0): synthetic meeting interval, with a separately disclosed buffered hold interval." }.joined(separator: "\n")
        let proposal = NSHostingView(rootView: CaretActionOfferRow(offer: demo, run: {}).frame(width: 340))
        XCTAssertGreaterThan(proposal.fittingSize.height, compactHeight + 80)
        demo.evidence = (1...8).map { "Source \($0): synthetic option and full buffered hold interval, no external calendar write." }
        let full = NSHostingView(rootView: CaretActionOfferRow(offer: demo, run: {}).frame(width: 340))
        XCTAssertGreaterThan(full.fittingSize.height, proposal.fittingSize.height + 100)
    }
}
