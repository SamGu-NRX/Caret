import Foundation
import Testing
@testable import CaretScreenCore

/// helper/fixtures/golden/press-risk.json: the presses the reader's table and helper/src/executor/risk.ts must agree on.
private let riskURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/press-risk.json")

private struct RiskCase: Decodable {
    let label: String
    let role: String
    let windowSubrole: String?
    let bundleId: String
    let risk: String
    let readerAllows: Bool
}

/// S1 audit #10: before B22 the reader pressed any control the helper named, "Allow" in a permission dialog included.
@Suite struct RiskTableTests {
    @Test func agreesWithTheHelperAndAllowsOnlyWhatItPositivelyClassifies() throws {
        struct File: Decodable { let cases: [RiskCase] }
        let cases = try JSONDecoder().decode(File.self, from: Data(contentsOf: riskURL)).cases
        #expect(cases.count >= 10)
        for c in cases {
            #expect(RiskTable.classify(label: c.label, windowSubrole: c.windowSubrole, bundleId: c.bundleId) == c.risk, "\(c.label) in \(c.windowSubrole ?? "no subrole") of \(c.bundleId)")
            let refusal = RiskTable.refusal(label: c.label, role: c.role, windowSubrole: c.windowSubrole, bundleId: c.bundleId)
            #expect((refusal == nil) == c.readerAllows, "\(c.label) as \(c.role): \(refusal ?? "allowed")")
        }
    }

    @Test func refusesASystemPromptWhateverItsButtonSaysInAnyLanguage() {
        for label in ["Next", "Autoriser", "Erlauben", "Continue"] {
            #expect(RiskTable.refusal(label: label, role: "AXButton", windowSubrole: "AXSystemDialog", bundleId: "dev.caret.fixture") != nil, "\(label)")
        }
        // The same safe press in the app's own standard window goes through.
        #expect(RiskTable.refusal(label: "Next", role: "AXButton", windowSubrole: "AXStandardWindow", bundleId: "dev.caret.fixture") == nil)
    }

    /// B22 review: a label that matches no risk word is no evidence the press is safe.
    @Test func refusesEveryLabelItDoesNotKnowToBeSafe() {
        for label in ["Transmit", "Enviar", "Senden", "OK", "Continue", "Confirm", "Done"] {
            #expect(RiskTable.classify(label: label, windowSubrole: "AXStandardWindow", bundleId: "dev.caret.fixture") == "unclassified", "\(label)")
            #expect(RiskTable.refusal(label: label, role: "AXButton", windowSubrole: "AXStandardWindow", bundleId: "dev.caret.fixture") != nil, "\(label)")
        }
    }

    @Test func mirrorsTheHelpersWordTableWordForWord() throws {
        // risk.ts's RISK_TABLE, read from the source, so a word added on one side alone fails here.
        let src = riskURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/executor/risk.ts")
        let ts = try String(contentsOf: src, encoding: .utf8)
        for (risk, phrases) in RiskTable.words {
            let quoted = phrases.map { "\"\($0)\"" }.joined(separator: ", ")
            #expect(ts.contains("\(risk): [\(quoted)]"), "\(risk)")
        }
        // SAFE_PRESSES holds the same labels, in any order.
        guard let line = ts.split(separator: "\n").first(where: { $0.contains("export const SAFE_PRESSES") }) else { Issue.record("no SAFE_PRESSES in risk.ts"); return }
        let listed = Set(line.split(separator: "\"").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) })
        #expect(listed == RiskTable.safePresses)
    }
}
