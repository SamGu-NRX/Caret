import XCTest
@testable import CaretHostCore

final class PopupSpecTests: XCTestCase {
    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/popup-specs.json")

    private func fixture() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixtureURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func data(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// The error as the fixture names it: `case(arg, arg)`, paths without the `$.` root.
    private func short(_ error: PopupSpecError) -> String {
        switch error {
        case .unknownBlock(let type, let path): return "unknownBlock(\(type), \(path))"
        case .missingReference(let path): return "missingReference(\(path))"
        case .invalidReference(let path, _): return "invalidReference(\(path))"
        case .tooManyChoices(let path, _): return "tooManyChoices(\(path))"
        case .noPrimaryAction(let path): return "noPrimaryAction(\(path))"
        case .actionKeyConflictsWithChoices(let path, _): return "actionKeyConflictsWithChoices(\(path))"
        case .unknownRevealTarget(let path, _): return "unknownRevealTarget(\(path))"
        case .missingBlock(let type): return "missingBlock(\(type))"
        case .unsupportedVersion(let v): return "unsupportedVersion(\(v))"
        default: return error.description
        }
    }

    func testTheThreeGoldenSpecsDecode() throws {
        let valid = try XCTUnwrap(try fixture()["valid"] as? [String: Any])
        XCTAssertEqual(Set(valid.keys), ["eventCard", "fillPreview", "picker"])

        let card = try PopupSpec.decode(data(valid["eventCard"]!))
        XCTAssertEqual(card.header?.title.text, "Coffee with Dana")
        XCTAssertEqual(card.actions.map(\.key), [.tab, .cmd2])
        XCTAssertEqual(card.actions[1].reveal?.replace, "when")
        guard case .choices(let times)? = card.actions[1].reveal?.with.content else { return XCTFail("reveal is not choices") }
        XCTAssertEqual(times.rows.map(\.label.text), ["2:30 to 3:00 pm", "3:00 to 3:30 pm", "3:30 to 4:00 pm"])
        XCTAssertEqual(times.selected, 1)

        let fill = try PopupSpec.decode(data(valid["fillPreview"]!))
        guard case .fields(let fields) = fill.blocks[2].content else { return XCTFail("third block is not fields") }
        XCTAssertEqual(fields.rows.map(\.state), [.ready, .ready, .unsure, .ready])
        XCTAssertEqual(fields.rows[1].value?.ref, .node(key: "6060-1/message/from", quote: "dana@northline.example"))

        let picker = try PopupSpec.decode(data(valid["picker"]!))
        XCTAssertEqual(picker.figure, .needsYou)
        XCTAssertEqual(picker.choices?.rows.map { $0.hint?.text }, ["Northline", "climbing", "dentist"])
    }

    func testEveryInvalidFixtureIsRefusedWithItsNamedError() throws {
        let invalid = try XCTUnwrap(try fixture()["invalid"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(invalid.count, 10)
        for case let item in invalid {
            let name = item["name"] as? String ?? "?"
            let expected = item["error"] as? String ?? "?"
            do {
                _ = try PopupSpec.decode(data(item["spec"]!))
                XCTFail("\(name): decoded, expected \(expected)")
            } catch let error as PopupSpecError {
                XCTAssertEqual(short(error), expected, name)
            }
        }
    }

    func testJSONDecoderSurfacesTheSpecificErrorUnwrapped() throws {
        let json = #"{"v":1,"id":"x","figure":"offering","blocks":[{"type":"map"}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(PopupSpec.self, from: Data(json.utf8))) { error in
            XCTAssertEqual(error as? PopupSpecError, .unknownBlock(type: "map", path: "blocks[0]"))
        }
    }

    func testRoundTripPreservesEverySpec() throws {
        let valid = try XCTUnwrap(try fixture()["valid"] as? [String: Any])
        for (name, raw) in valid {
            let spec = try PopupSpec.decode(data(raw))
            let again = try JSONDecoder().decode(PopupSpec.self, from: JSONEncoder().encode(spec))
            XCTAssertEqual(again, spec, name)
        }
    }

    func testNotJSONIsMalformed() {
        XCTAssertThrowsError(try PopupSpec.decode(Data("{".utf8))) { error in
            XCTAssertEqual(error as? PopupSpecError, .malformedJSON)
        }
    }
}
