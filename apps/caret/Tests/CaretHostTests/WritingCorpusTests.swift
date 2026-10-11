import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// Precision and recall of the writing checks on a held-out corpus
/// (`CaretHostCoreTests/Fixtures/writing-corpus.json`), written by an agent that had not seen the
/// rules. Each case is a field's text ending in a finished sentence; the check reads the last
/// sentence, as it would after a boundary. Measured twice: the static rules alone, and the static
/// rules with the system checker (static wins where both flag the same text).
///
/// A false correction on a clean sentence is the costly failure, so it is reported first.
/// `CARET_WRITING_EVAL_OUT=<dir>` writes the table and every disagreement there.
@MainActor
final class WritingCorpusTests: XCTestCase {
    struct Corpus: Decodable {
        struct Case: Decodable {
            var id: String
            var text: String
            var errors: [Expected]
            var note: String?
        }

        struct Expected: Decodable {
            var original: String
            var replacement: String
            var kind: WritingCorrection.Kind
        }

        var cases: [Case]
    }

    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../CaretHostCoreTests/Fixtures/writing-corpus.json").standardized

    struct Tally {
        var expected: [WritingCorrection.Kind: Int] = [:]
        var found: [WritingCorrection.Kind: Int] = [:]
        /// Right fix, by the expected kind (recall) and by the predicted kind (precision).
        var hitsExpected: [WritingCorrection.Kind: Int] = [:]
        var hitsFound: [WritingCorrection.Kind: Int] = [:]
        /// Flagged the right text with a different fix.
        var wrongFix = 0
        var cleanCases = 0
        var cleanCasesFlagged = 0
        var cleanFalseCorrections = 0
        /// Marks whose checker answers disagree: offered as a choice, never applied by Tab.
        var needsChoice = 0
        var notes: [String] = []
    }

    func testCorpusPrecisionAndRecall() async throws {
        let data = try Data(contentsOf: Self.fixture)
        let corpus = try JSONDecoder().decode(Corpus.self, from: data)
        XCTAssertGreaterThanOrEqual(corpus.cases.count, 60)
        let native = NativeChecker.supports("en") ? NativeChecker() : nil

        var staticOnly = Tally(), combined = Tally()
        var latencies: [Double] = []
        var outside: [String] = []
        var outsideKinds: [WritingCorrection.Kind] = []
        for (n, item) in corpus.cases.enumerated() {
            let text = item.text
            let sentence = try XCTUnwrap(WritingCheck.lastSentence(in: text, caret: UTF16Text.length(text)), item.id)
            // An error outside the sentence Caret picked is a miss for both configurations.
            var expected: [(UTF16Span, Corpus.Expected)] = []
            for e in item.errors {
                if let span = locate(e.original, in: text, within: sentence) {
                    expected.append((span, e))
                } else {
                    outside.append("  \(item.id) outside the checked sentence: “\(e.original)” (\(e.kind.rawValue))")
                    outsideKinds.append(e.kind)
                }
            }
            let rules = WritingCheck.check(text, sentence: sentence)
            score(rules, expected, item, text, into: &staticOnly)
            if let native {
                let field = NativeChecker.FieldKey(pid: 1, windowID: "corpus", elementID: "case-\(n)")
                let start = Date()
                let outcome = await native.check(text, sentence: sentence, language: "en", field: field)
                latencies.append(Date().timeIntervalSince(start) * 1000)
                native.closeField(field)
                guard case .corrections(let system) = outcome else { XCTFail("stale"); continue }
                score(WritingCheck.merged(rules, system), expected, item, text, into: &combined)
            }
        }

        for kind in outsideKinds {
            staticOnly.expected[kind, default: 0] += 1
            combined.expected[kind, default: 0] += 1
        }
        var report = [
            "Corpus: \(corpus.cases.count) cases, \(staticOnly.cleanCases) clean, \(corpus.cases.count - staticOnly.cleanCases) with errors.",
            "",
        ]
        report += table("Static rules alone", staticOnly)
        if native != nil {
            report += [""] + table("Static rules with NSSpellChecker", combined)
            latencies.sort()
            report += ["", String(format: "NSSpellChecker latency per sentence: p50 %.1f ms, p95 %.1f ms, max %.1f ms (n=%d)",
                                  percentile(latencies, 0.5), percentile(latencies, 0.95), latencies.last ?? 0, latencies.count)]
        } else {
            report += ["", "NSSpellChecker: no English dictionary on this Mac; not measured."]
        }
        report += ["", "Errors outside the sentence Caret checked (\(outside.count)):"] + outside
        report += ["", "Disagreements, static alone:"] + staticOnly.notes
        if native != nil { report += ["", "Disagreements, with NSSpellChecker:"] + combined.notes }
        let out = report.joined(separator: "\n")
        print(out)
        // Measured 0 on the first, blind run (2026-10-04); the static rules must stay there.
        XCTAssertEqual(staticOnly.cleanFalseCorrections, 0, "a static rule corrected a clean sentence")
        // With the system checker everything is reported, not asserted: its answers move between
        // runs and with macOS's dictionary (the lead's rerun at 3887f61), and this eval does not
        // gate. T1 measured 3 false corrections in 2 clean cases; T2's eval-3 measured 0.
        if let dir = ProcessInfo.processInfo.environment["CARET_WRITING_EVAL_OUT"] {
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try out.write(toFile: (dir as NSString).appendingPathComponent("corpus-eval.txt"), atomically: true, encoding: .utf8)
        }
    }

    // MARK: -

    /// The first place `original` occurs inside the sentence.
    private func locate(_ original: String, in text: String, within sentence: UTF16Span) -> UTF16Span? {
        let r = (text as NSString).range(of: original, options: [], range: sentence.nsRange)
        return r.location == NSNotFound ? nil : UTF16Span(r)
    }

    private func apply(_ span: UTF16Span, _ replacement: String, to text: String) -> String {
        UTF16Text.slice(text, start: 0, end: span.start)! + replacement + UTF16Text.slice(text, start: span.end, end: UTF16Text.length(text))!
    }

    /// A found correction matches an expected one when their spans meet and applying either alone
    /// gives the same text.
    private func score(_ found: [WritingCorrection], _ expected: [(UTF16Span, Corpus.Expected)], _ item: Corpus.Case, _ text: String, into t: inout Tally) {
        if item.errors.isEmpty {
            t.cleanCases += 1
            if !found.isEmpty { t.cleanCasesFlagged += 1 }
            t.cleanFalseCorrections += found.count
        }
        for (_, e) in expected { t.expected[e.kind, default: 0] += 1 }
        for f in found {
            t.found[f.kind, default: 0] += 1
            if f.needsChoice {
                t.needsChoice += 1
                t.notes.append("  \(item.id) needs a choice: “\(f.original)” to “\(f.replacement)” or “\(f.otherReplacements.first ?? "")”")
            }
        }
        var used = Set<Int>()
        for (span, e) in expected {
            let want = apply(span, e.replacement, to: text)
            let meets = found.indices.filter { !used.contains($0) && (found[$0].span.overlaps(span) || found[$0].span == span) }
            if let i = meets.first(where: { apply(found[$0].span, found[$0].replacement, to: text) == want }) {
                used.insert(i)
                t.hitsExpected[e.kind, default: 0] += 1
                t.hitsFound[found[i].kind, default: 0] += 1
            } else if let i = meets.first {
                used.insert(i)
                t.wrongFix += 1
                t.notes.append("  \(item.id) wrong fix: “\(found[i].original)” to “\(found[i].replacement)”, expected “\(e.original)” to “\(e.replacement)” (\(e.kind.rawValue))")
            } else {
                t.notes.append("  \(item.id) missed: “\(e.original)” to “\(e.replacement)” (\(e.kind.rawValue))")
            }
        }
        for (i, f) in found.enumerated() where !used.contains(i) {
            let label = item.errors.isEmpty ? "FALSE on clean" : "extra"
            t.notes.append("  \(item.id) \(label): “\(f.original)” to “\(f.replacement)” (\(f.kind.rawValue), \(sourceName(f.source))) in: \(item.text)")
        }
    }

    private func sourceName(_ s: WritingCorrection.Source) -> String {
        switch s {
        case .rule(let r): return r.rawValue
        case .spellChecker: return "NSSpellChecker"
        }
    }

    private func table(_ title: String, _ t: Tally) -> [String] {
        func pct(_ a: Int, _ b: Int) -> String { b == 0 ? "n/a" : String(format: "%.0f%% (%d/%d)", 100 * Double(a) / Double(b), a, b) }
        var rows = [
            "## \(title)",
            "False corrections on clean sentences: \(t.cleanFalseCorrections) in \(t.cleanCasesFlagged) of \(t.cleanCases) clean cases.",
            "Flagged the right text with a different fix: \(t.wrongFix).",
            "Offered as a choice with no Tab (the checker's answers disagree): \(t.needsChoice).",
            "| Kind | Precision | Recall |",
            "| --- | --- | --- |",
        ]
        for kind in WritingCorrection.Kind.allCases {
            rows.append("| \(kind.rawValue) | \(pct(t.hitsFound[kind] ?? 0, t.found[kind] ?? 0)) | \(pct(t.hitsExpected[kind] ?? 0, t.expected[kind] ?? 0)) |")
        }
        let hits = t.hitsExpected.values.reduce(0, +)
        rows.append("| all | \(pct(hits, t.found.values.reduce(0, +))) | \(pct(hits, t.expected.values.reduce(0, +))) |")
        return rows
    }

    private func percentile(_ sorted: [Double], _ p: Double) -> Double {
        guard !sorted.isEmpty else { return 0 }
        return sorted[min(sorted.count - 1, Int((Double(sorted.count) * p).rounded(.up)) - 1)]
    }
}
