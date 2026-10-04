import CaretHostCore
import XCTest

final class WordFindingTests: XCTestCase {
    private func descriptions(_ text: String) -> [String] { WordFinding.brackets(in: text).map(\.description) }

    func testFindsABracketedRequestForAWord() {
        let text = "I keep [word for delaying a task] my taxes."
        let found = WordFinding.brackets(in: text)
        XCTAssertEqual(found.map(\.description), ["word for delaying a task"])
        XCTAssertEqual(UTF16Text.slice(text, start: found[0].span.start, end: found[0].span.end), "[word for delaying a task]")
        XCTAssertEqual(descriptions("She was [a word meaning very happy] about it."), ["a word meaning very happy"])
        XCTAssertEqual(descriptions("It was [synonym for big] news."), ["synonym for big"])
        XCTAssertEqual(descriptions("He is [opposite of generous] with time."), ["opposite of generous"])
        XCTAssertEqual(descriptions("We [another way to say talked] for hours."), ["another way to say talked"])
    }

    func testIgnoresBracketsThatAreNotRequests() {
        let notRequests = [
            "As shown before [1], it works.",
            "As shown before [1, 2], it works.",
            "This was argued [Smith 2020] already.",
            "Read [the docs](https://example.com) first.",
            "See [the guide][guide] for details.",
            "[guide]: https://example.com/guide",
            "A footnote[^1] goes here.",
            "Link to [[Project Notes]] page.",
            "- [x] word for done",
            "- [ ] buy milk",
            "Dear [Your Name], thanks.",
            "Due [INSERT DATE] at noon.",
            "He said it [sic] twice.",
            "Then [laughs] we left.",
            "Use items[i] for the word for each.",
            "Call f()[0] to get the word for it.",
            "let x = [word for delaying a task]",
            "Run `grep [word for x] file` now.",
            "Visit https://example.com/[word for delay a task] today.",
            "A [word for [nested] thing] here.",
            "An unclosed [word for delaying a task",
            "Cite [@smith2020] here.",
            "That was [pauses for a moment] fine.",
            "It cost [word for 5 dollars] total.",
        ]
        for text in notRequests {
            XCTAssertEqual(descriptions(text), [], text)
        }
    }

    func testTheRequestIsTheOneJustClosedAtTheCaret() {
        let text = "I [word for delaying a task] it. Then [synonym for big] "
        let caret = UTF16Text.length(text)
        XCTAssertEqual(WordFinding.request(in: text, caret: caret)?.description, "synonym for big")
        // Far from the caret, nothing is asked.
        XCTAssertNil(WordFinding.request(in: text + "and then more", caret: caret + 13))
    }

    func testRequestCarriesContextAndRevision() {
        let text = "Stop [word for delaying a task] and start."
        let bracket = WordFinding.brackets(in: text)[0]
        let request = WordFindingRequest.make(bracket, in: text)
        XCTAssertEqual(request.context, "Stop ___ and start.")
        XCTAssertEqual(request.revision, UTF16Text.digest(text))
        XCTAssertLessThanOrEqual(WordFindingRequest(description: "d", context: String(repeating: "a", count: 500), language: "en", revision: "r").context.count, 240)
    }

    func testUsableTermsAreShortCleanAndAtMostThree() {
        let raw = ["  procrastinate.", "\"Procrastinate\"", "put off", "dawdle and dither about it endlessly", "[stall]", "", "line\nbreak", "delay", "stall"]
        XCTAssertEqual(WordFinding.usableTerms(raw), ["procrastinate", "put off", "delay"])
    }

    // MARK: - The port, with a fake model

    actor FakeModel: LocalWritingPort {
        var answer: [String]
        var ready: Bool
        var delayNanos: UInt64
        private(set) var asked: [WordFindingRequest] = []

        init(answer: [String], ready: Bool = true, delayNanos: UInt64 = 0) {
            self.answer = answer
            self.ready = ready
            self.delayNanos = delayNanos
        }

        var availability: LocalWritingAvailability {
            ready ? .ready : .unavailable(reason: WritingCopy.wordFindingUnavailable)
        }

        func findWords(_ request: WordFindingRequest) async throws -> [String] {
            asked.append(request)
            if delayNanos > 0 { try await Task.sleep(nanoseconds: delayNanos) }
            return answer
        }
    }

    let request = WordFindingRequest(description: "word for delaying a task", context: "I ___ my taxes.", language: "en", revision: "rev-1")

    func testSuggestReturnsUsableTerms() async {
        let model = FakeModel(answer: ["procrastinate", "put off", "defer", "stall"])
        let result = await WordFinder.suggest(request, using: model, currentRevision: { "rev-1" })
        XCTAssertEqual(result, .terms(["procrastinate", "put off", "defer"]))
        let asked = await model.asked
        XCTAssertEqual(asked, [request])
    }

    func testAnUnavailableModelSaysWhyAndIsNotAsked() async {
        let model = FakeModel(answer: ["x"], ready: false)
        let result = await WordFinder.suggest(request, using: model, currentRevision: { "rev-1" })
        XCTAssertEqual(result, .unavailable(reason: WritingCopy.wordFindingUnavailable))
        let asked = await model.asked
        XCTAssertTrue(asked.isEmpty)
    }

    func testAnAnswerForAnOlderRevisionIsDropped() async {
        let model = FakeModel(answer: ["procrastinate"])
        let result = await WordFinder.suggest(request, using: model, currentRevision: { "rev-2" })
        XCTAssertEqual(result, .stale)
    }

    func testNothingUsableIsSaidPlainly() async {
        let model = FakeModel(answer: ["Here is a long sentence instead of a word.", ""])
        let result = await WordFinder.suggest(request, using: model, currentRevision: { "rev-1" })
        XCTAssertEqual(result, .nothingUsable)
    }

    func testCancellationStopsTheRequest() async {
        let model = FakeModel(answer: ["procrastinate"], delayNanos: 5_000_000_000)
        let request = self.request
        let task = Task { await WordFinder.suggest(request, using: model, currentRevision: { "rev-1" }) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .cancelled)
    }
}
