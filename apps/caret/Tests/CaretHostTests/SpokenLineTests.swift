import CaretHostCore
import CaretScreenCore
import XCTest
@testable import CaretHost

/// What VoiceOver hears for a slip (v3 DIRECTION.md section 7): one element per slip, announced on
/// entrance and on each change of state, each part a sentence ended once. A16's live announcement
/// log heard "…Caret Fixture?. Caret will offer it when you start it again.." before that rule.
@MainActor
final class SpokenLineTests: XCTestCase {
    private func toast(_ question: LineContent.Question) -> PanelContent {
        .line(LineContent(figure: .done, lead: "Added", text: "to Tracker", emphasis: .plain, question: question))
    }

    func testTheKeepQuestionIsSpokenAsSentences() {
        let spoken = SurfaceCoordinator.spoken(toast(WorkLines.question(Gallery.skillOffer(.keep))))
        XCTAssertEqual(spoken, "Added to Tracker. Keep this as Order details into Tracker? Caret will offer it when you start it again. Tab: Keep. Escape: No thanks.")
    }

    func testARunWithNoTabSaysEscapeTakesOver() {
        let spoken = SurfaceCoordinator.spoken(.line(WorkLines.onItsOwn("Order details into Tracker", app: "Tracker").content))
        XCTAssertEqual(spoken, "On its own: Order details into Tracker. Escape takes over.")
    }

    func testEveryStateIsSpokenNowNotOnlyQuestions() {
        XCTAssertEqual(SurfaceCoordinator.spoken(.line(WorkLines.tookOver(next: 1, of: 3).content)), "You took over before step 2 of 3.")
    }

    func testAPopupSaysItsTitleChoiceAndKeys() {
        XCTAssertEqual(
            SurfaceCoordinator.spoken(.popup(Gallery.picker, highlight: 1)),
            "Which Dana? Dana Kim, climbing, highlighted. Tab: Choose. Escape closes it."
        )
    }

    /// A pop-up says everything it shows, so nothing on it is out of VoiceOver's reach before Tab.
    func testAnEventCardSaysItsWhenAndSource() {
        XCTAssertEqual(
            SurfaceCoordinator.spoken(.popup(Gallery.eventCard, highlight: nil)),
            "Coffee with Dana. Thursday Oct 9, 3:00 to 3:30 pm. Personal. From your message to Dana. Tab: Add. Command 2: Change time. Escape closes it."
        )
    }

    func testAFillPreviewSaysEveryFieldAndValue() {
        XCTAssertEqual(
            SurfaceCoordinator.spoken(.popup(Gallery.fillPreview, highlight: nil)),
            "Fill 4 fields. From Mail, Invoice 2041. Name: Dana Reyes. Email: dana@northline.example. Company: Northline, unsure. Amount: $1,240.00. Tab: Fill all. Down arrow: Review one by one. Escape closes it."
        )
    }

    /// After the pop-up was announced whole, ↓ says only the new choice.
    func testAMovedHighlightSaysOnlyTheNewChoice() {
        XCTAssertEqual(SlipSpeech.popupHighlight(Gallery.picker, highlight: 2), "Dana Okafor, dentist, highlighted.")
        XCTAssertNil(SlipSpeech.popupHighlight(Gallery.fillPreview, highlight: nil))
    }

    func testTheQuestionsKeysAreInTheSlipsValue() {
        let line = LineContent(figure: .done, lead: "Added", text: "to Tracker", emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")],
                               question: WorkLines.question(Gallery.skillOffer(.promote)))
        XCTAssertEqual(SlipSpeech.value(line), "Command Z undoes it. Tab: Do it on its own. Escape: Keep asking.")
    }

    /// One offer from shown to added, as the coordinator would announce it with the machine's own
    /// lines: the working line is said once when work starts and once when Esc Stop joins it, not
    /// every second.
    func testOneOfferFromShownToAddedIsAnnouncedOncePerState() {
        let offer = LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thursday 3:00 to 3:30", hints: [Hint(key: "Tab")])
        var lines: [PanelContent] = [.line(offer)]
        for second in 0...5 {
            lines.append(.line(WorkLines.working(app: "Calendar", fillRows: nil, seconds: second, figureLeft: second > 0, done: min(second, 2), steps: 3).content))
        }
        lines.append(.line(WorkLines.done(app: "Calendar", undo: true).content))
        var last: String?
        var heard: [String] = []
        for content in lines {
            if let words = SlipAnnouncer.next(SurfaceCoordinator.spoken(content), last: last) {
                heard.append(words)
                last = words
            }
        }
        XCTAssertEqual(heard, [
            "Coffee with Dana, Thursday 3:00 to 3:30. Tab adds it to Calendar.",
            "Adding to Calendar.",
            "Adding to Calendar. Escape stops it.",
            "Added to Calendar. Command Z undoes it.",
        ])
    }

    /// The slip's accessibility label is its caption and its value says what the keys do. (That it
    /// is one element is the view's `.accessibilityElement(children: .ignore)`: SwiftUI builds no
    /// accessibility tree for a hosting view that is not on screen, so it is not counted here.)
    func testTheSlipsLabelIsTheCaptionAndItsValueTheKeys() {
        let done = WorkLines.done(app: "Calendar", undo: true).content
        XCTAssertEqual(SlipSpeech.label(done), "Added to Calendar")
        XCTAssertEqual(SlipSpeech.value(done), "Command Z undoes it.")
        let working = WorkLines.working(app: "Calendar", fillRows: nil, seconds: 7, figureLeft: true).content
        XCTAssertEqual(SlipSpeech.label(working), "Adding to Calendar", "the seconds are on screen, not in the label")
        XCTAssertEqual(SlipSpeech.value(working), "Escape stops it.")
    }
}
