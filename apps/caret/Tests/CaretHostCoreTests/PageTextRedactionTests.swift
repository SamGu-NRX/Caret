@testable import CaretHostCore
import CaretScreenCore
import Darwin
import XCTest

/// H13 item 4: a page field's text, and the inline text made from it, never reach the debug socket or the log. This
/// reuses H12's redaction rather than adding a second one: the release socket answers `ReleaseState`, an allowlist that
/// holds no `pageInline` record, no offer text and only listed counters; the log follows H12's rule (no field contents,
/// typed text or model output) and is checked the way `ShipsCoreTests` checks it, through `HostLog`.
final class PageTextRedactionTests: XCTestCase {
    static let seeds = ["SEEDPAGEBEFORE", "SEEDPAGEAFTER", "SEEDPAGEGHOST", "SEEDPAGETYPED"]

    static func pageField() throws -> PageField {
        var f = try PageInlineTests.field(1)
        // The text after the caret on its own line: inline text is offered at the end of a line.
        f.text = .init(before: "Dear SEEDPAGEBEFORE ", after: "\nSEEDPAGEAFTER", selection: "")
        return f
    }

    /// The state the host builds while a page ghost is on screen: its offer record goes through `PageInline.debugText`
    /// (as `HostRuntime.makeState` does), and the `pageInline` record holds lengths and outcomes.
    static func stateWithAPageGhost() throws -> DebugState {
        var state = ShipsCoreTests.seededState()
        let target = try XCTUnwrap(PageInline.target(try pageField()))
        let offer = Offer(text: "SEEDPAGEGHOST role", source: .page, target: target, fieldValue: "Dear SEEDPAGEBEFORE \nSEEDPAGEAFTER", caretUTF16: 20)
        let shown = PageInline.debugText(offer, typed: "SEEDPAGETYPED")
        state.offer = DebugState.OfferInfo(id: 3, text: shown.text, typedSinceOffer: shown.typed, ageMs: 1, pid: target.pid, bundleID: target.bundleID,
                                           caretUTF16: offer.caretUTF16, elementRevision: shown.revision, presentation: offer.kind.name)
        state.pageInline = DebugState.PageInlineInfo(last: "shown", shownLength: 18, notice: false, fieldRole: "AXTextArea", beforeLength: 20, afterLength: 13,
                                                     ownSuggestions: nil, tabOwner: nil, latency: LatencyRecorder().summary(), generation: LatencyRecorder().summary())
        state.counters["pageInline.shown"] = 1
        state.counters["pageInline.suppressed.SEEDPAGETYPED"] = 1
        return state
    }

    func testTheFullStateShowsLengthsAndTheReleaseStateNothingOfThePage() throws {
        let state = try Self.stateWithAPageGhost()
        let full = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        for seed in ["SEEDPAGEBEFORE", "SEEDPAGEAFTER", "SEEDPAGEGHOST"] { XCTAssertFalse(full.contains(seed), "\(seed) in the full state") }
        XCTAssertTrue(full.contains(#""beforeLength":20"#), full)
        // Nor the field's digest, which a guess at its text could be checked against (H13 review).
        XCTAssertEqual(state.offer?.elementRevision, "")
        let release = String(decoding: try JSONEncoder().encode(ReleaseState(state)), as: UTF8.self)
        for seed in Self.seeds { XCTAssertFalse(release.contains(seed), "\(seed) leaked: \(release)") }
        XCTAssertFalse(release.contains("pageInline"), "the release state keeps no page inline record")
    }

    /// The paths that write a line about a page field (its description, should anything interpolate it) go into a log
    /// that then rotates: neither file holds the page's text.
    func testAPageFieldsTextNeverReachesTheLog() throws {
        let dir = NSTemporaryDirectory() + "h13-log-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let log = HostLog(path: dir + "/host.log", cap: 200)
        let fd = try log.open()
        defer { close(fd) }
        let f = try Self.pageField()
        // A machine run over the field, an insert and its refusal: every count it makes is a line the host could write.
        let r = PageInlineTests.Rig()
        r.field(f)
        r.suggest("SEEDPAGEGHOST role")
        r.press(.tab(to: PageInlineTests.chrome))
        r.machine.replied(PageInsertReply(requestId: r.inserts.first?.requestId ?? "inline-1", outcome: .refused, says: "the page refused the insert (changed)", at: 1))
        let counted = r.commands.compactMap { c -> String? in if case .count(let n) = c { return n } else { return nil } }
        XCTAssertFalse(counted.isEmpty)
        for line in ["page field \(f)", String(describing: f), String(reflecting: f)] + counted + [String(repeating: "x", count: 300)] {
            _ = ("caret: " + line + "\n").withCString { Darwin.write(fd, $0, strlen($0)) }
        }
        XCTAssertTrue(log.rotateIfNeeded())
        let all = try String(contentsOfFile: log.path, encoding: .utf8) + String(contentsOfFile: log.rotatedPath, encoding: .utf8)
        XCTAssertTrue(all.contains("pageInline.insert.refused"), "the lines themselves are there")
        for seed in Self.seeds { XCTAssertFalse(all.contains(seed), "\(seed) in \(all)") }
    }
}
