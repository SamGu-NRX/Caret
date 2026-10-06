import Foundation
import Testing
@testable import CaretScreenCore

/// helper/fixtures/golden/event-sentences.json: the helper's event card tests feed the generator the
/// date and time spans listed there as the reader's typed values. This checks that the reader's own
/// detector finds exactly those spans in each sentence, so the two sides cannot drift apart.
private let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/event-sentences.json")

private struct Fixture: Decodable {
    struct Span: Decodable, Equatable { let kind: String; let text: String }
    struct Sentence: Decodable { let id: String; let sentence: String; let spans: [Span] }
    let sentences: [Sentence]
}

@Suite struct EventSentences {
    @Test func theDetectorFindsTheListedDateAndTimeSpans() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        #expect(fixture.sentences.count == 40)
        let detector = TypedValueDetector()
        var wrong: [String] = []
        for s in fixture.sentences {
            let found = detector.detect(s.sentence)
                .filter { $0.kind == .date || $0.kind == .time }
                .map { Fixture.Span(kind: $0.kind.rawValue, text: $0.text) }
            if found != s.spans {
                let json = found.map { #"{ "kind": "\#($0.kind)", "text": "\#($0.text)" }"# }.joined(separator: ", ")
                wrong.append("\(s.id): [\(json)]")
            }
        }
        #expect(wrong.isEmpty, "the detector finds other spans:\n\(wrong.joined(separator: "\n"))")
    }
}
