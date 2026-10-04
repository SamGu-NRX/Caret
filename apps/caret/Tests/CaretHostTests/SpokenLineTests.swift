import CaretHostCore
import XCTest
@testable import CaretHost

/// What VoiceOver hears for the skills surfaces (`SurfaceCoordinator.spoken`): each part a sentence,
/// ended once. A16's live announcement log heard "…Caret Fixture?. Caret will offer it when you start
/// it again.." before this.
@MainActor
final class SpokenLineTests: XCTestCase {
    private func toast(_ question: LineContent.Question) -> PanelContent {
        .line(LineContent(figure: .done, lead: "Done,", text: "in Tracker", emphasis: .plain, question: question))
    }

    func testTheKeepQuestionIsSpokenAsSentences() {
        let spoken = SurfaceCoordinator.spoken(toast(WorkLines.question(Gallery.skillOffer(.keep))))
        XCTAssertEqual(spoken, "Keep this as Order details into Tracker? Caret will offer it when you start it again. Tab: Keep. Esc: No thanks.")
    }

    func testThePromoteQuestionIsSpokenAsSentences() {
        let spoken = SurfaceCoordinator.spoken(toast(WorkLines.question(Gallery.skillOffer(.promote))))
        XCTAssertEqual(spoken, "Do this one on your own from now on? You'll see it happen and can undo it. Tab: Do it on its own. Esc: Keep asking.")
    }

    func testARunWithNoTabSaysEscTakesOver() {
        let spoken = SurfaceCoordinator.spoken(.line(WorkLines.onItsOwn("Order details into Tracker", app: "Tracker").content))
        XCTAssertEqual(spoken, "On its own: Order details into Tracker. Esc takes over.")
    }

    func testOtherLinesAreNotAnnounced() {
        XCTAssertNil(SurfaceCoordinator.spoken(.line(WorkLines.tookOver(next: 1, of: 3).content)))
    }

    func testAHintWithoutALabelIsJustItsKey() {
        let q = LineContent.Question(text: "Keep this?", hints: [Hint(key: "Tab", label: nil)])
        XCTAssertEqual(SurfaceCoordinator.spoken(toast(q)), "Keep this? Tab.")
    }
}
