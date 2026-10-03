import CaretHostCore
import XCTest

/// The copy rules a machine can check, over every string the host shows: no em or en dashes, no
/// exclamation marks, no all-caps labels, and no "How forward" left over from before A8. The lead
/// still reads the copy itself; this keeps a regression from reaching that read.
final class CopyRulesTests: XCTestCase {
    /// The files whose string literals are shown to people. Debug and log strings live elsewhere.
    private static let shownIn = [
        "CaretHost/Onboarding/OnboardingView.swift",
        "CaretHost/Perch/PerchViews.swift",
        "CaretHost/Perch/PerchController.swift",
        "CaretHost/Design/PopupView.swift",
        "CaretHost/Design/PanelParts.swift",
        "CaretHostCore/LineContent.swift",
        "CaretHostCore/CaretSettings.swift",
        "CaretHostCore/ActivityFeed.swift",
        "CaretHostCore/FillMachine.swift",
        "CaretHostCore/SurfaceMachine+Work.swift",
        "CaretHostCore/OnboardingFlow.swift",
        "CaretHostCore/MemoryPage.swift",
        "CaretHostCore/MemoryBook.swift",
        "CaretHost/Memory/MemoryView.swift",
        "Caret/AppDelegate.swift",
    ]

    private static let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../Sources").standardized

    /// String literals outside comments, without interpolations' insides.
    private func literals(_ file: String) throws -> [String] {
        let text = try String(contentsOf: Self.sources.appendingPathComponent(file), encoding: .utf8)
        let code = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let comment = line.range(of: "//") else { return line }
                // A "//" inside a string (a URL) is not a comment.
                let before = line[..<comment.lowerBound]
                return before.filter { $0 == "\"" }.count % 2 == 0 ? before : line
            }
            .joined(separator: "\n")
        let pattern = try NSRegularExpression(pattern: #""((?:[^"\\\n]|\\.)*)""#)
        return pattern.matches(in: code, range: NSRange(code.startIndex..., in: code)).compactMap {
            Range($0.range(at: 1), in: code).map { String(code[$0]) }
        }
    }

    func testShownStringsFollowTheRules() throws {
        var checked = 0
        for file in Self.shownIn {
            for literal in try literals(file) {
                // Machine strings: counters, JSON, identifiers, format pieces.
                if literal.hasPrefix("{") || literal.contains("{\\\"") || !literal.contains(where: \.isLetter) { continue }
                checked += 1
                XCTAssertFalse(literal.contains("\u{2014}"), "em dash in \(file): \(literal)")
                XCTAssertFalse(literal.contains("\u{2013}"), "en dash in \(file): \(literal)")
                XCTAssertFalse(literal.contains("!"), "exclamation mark in \(file): \(literal)")
                let letters = literal.filter(\.isLetter)
                XCTAssertFalse(letters.count >= 3 && letters == letters.uppercased(), "all caps in \(file): \(literal)")
                XCTAssertFalse(literal.localizedCaseInsensitiveContains("how forward"), "\(file): \(literal)")
            }
        }
        XCTAssertGreaterThan(checked, 100, "the scan must reach the copy")
    }

    func testTheLevelQuestionIsTheNewWording() {
        XCTAssertEqual(CaretLevel.question, "How often Caret speaks up")
        XCTAssertEqual(CaretLevel.question.capitalized, "How Often Caret Speaks Up", "the menu item, title case like its neighbors")
    }
}
