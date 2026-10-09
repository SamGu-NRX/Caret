import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Brief item 5: spelling fixes in web page fields, where Caret cannot read or write the text through
/// Accessibility. The page reports the text around the caret (`PageField.text`); the machine checks the
/// word just closed and each finished sentence, offers the fix at the caret, and Tab sends one page insert
/// that replaces the text before the caret (`PageInsert.replace`), so the page's own Undo takes it back.
final class PageWritingTests: XCTestCase {
    static let chrome: Int32 = 4100

    static func field(_ before: String, after: String = "", kind: PageField.FieldKind = .textarea, own: PageField.OwnSuggestions? = nil,
                      key: String = "f0/form[apply]/textarea:cover letter~0") -> PageField {
        PageField(
            at: 1_790_400_000_100, app: AppRef(pid: Int(chrome), bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing"),
            windowId: "page:eng1:7", title: "Apply", key: key, role: "AXTextArea", editable: true, empty: before.isEmpty,
            frame: Frame(x: 136, y: 213, width: 520, height: 120), look: PageField.Look(inset: 13, fontSize: 15, placeholder: false, dark: false),
            text: PageField.Text(before: before, after: after, selection: ""), ownSuggestions: own,
            caret: Frame(x: 361.5, y: 221, width: 1, height: 18), token: "0:D0:e4", fieldKind: kind
        )
    }

    final class Rig {
        let arbiter = OfferArbiter()
        let clock = ManualClock()
        let machine: PageWritingMachine
        var commands: [PageWritingMachine.Command] = []
        var gate = PageWritingMachine.Gate(allowed: true, contentEditable: false, settings: PageInlineSettings(), language: "en")

        init() {
            machine = PageWritingMachine(arbiter: arbiter, clock: clock)
            machine.output = { [unowned self] in self.commands.append($0) }
        }

        func field(_ f: PageField?) { machine.field(f, gate: gate) }
        var checks: [PageWritingMachine.Check] { commands.compactMap { if case .check(let c) = $0 { return c } else { return nil } } }
        var lines: [WritingOffer] { commands.compactMap { if case .drawLine(let w, _) = $0 { return w } else { return nil } } }
        var inserts: [PageInsert] { commands.compactMap { if case .send(let s) = $0 { return s } else { return nil } } }
        var lineHidden: Bool {
            for c in commands.reversed() {
                if case .hideLine = c { return true }
                if case .drawLine = c { return false }
            }
            return true
        }

        /// The checker's answer to the last check: a spelling fix of `word` to `replacement`, wherever it is in the text.
        func answer(_ word: String, _ replacement: String, needsChoice: Bool = false) {
            guard let c = checks.last else { return XCTFail("no check asked") }
            let span = UTF16Span((c.value as NSString).range(of: word, options: .backwards))
            machine.checked(c.id, [WritingCorrection(span: span, original: word, replacement: replacement, kind: .spelling, reason: "",
                                                     source: .spellChecker, needsChoice: needsChoice)])
        }

        func press(_ key: KeyStroke) -> OfferArbiter.Decision {
            let d = arbiter.handleKeyDown(key)
            if case .consume(let claim) = d { machine.claimed(claim) }
            if case .pass(let reason) = d { machine.offerChanged(reason) }
            if case .navigate(let id, let ui) = d { machine.navigated(offerID: id, ui: ui) }
            return d
        }
    }

    // MARK: - When it checks

    func testAClosedWordIsCheckedAlone() {
        let r = Rig()
        r.field(Self.field("I like teh"))
        XCTAssertTrue(r.checks.isEmpty, "the first report of a field only sets where typing starts")
        r.field(Self.field("I like teh "))
        let c = try? XCTUnwrap(r.checks.last)
        XCTAssertEqual(c?.span, UTF16Span(start: 7, end: 10))
        XCTAssertEqual(c?.word, true)
    }

    func testAFinishedSentenceIsCheckedWhole() {
        let r = Rig()
        r.field(Self.field("I will recieve it"))
        r.field(Self.field("I will recieve it. "))
        XCTAssertEqual(r.checks.last?.span, UTF16Span(start: 0, end: 18))
        XCTAssertEqual(r.checks.last?.word, false)
    }

    func testNothingIsCheckedWhereInlineTextWouldNotBe() {
        for (gate, f) in [
            (PageWritingMachine.Gate(allowed: false, contentEditable: true, settings: PageInlineSettings(), language: "en"), Self.field("I like teh ")),
            (PageWritingMachine.Gate(allowed: true, contentEditable: false, settings: PageInlineSettings(), language: "en"), Self.field("I like teh ", kind: .contenteditable)),
            (PageWritingMachine.Gate(allowed: true, contentEditable: true, settings: PageInlineSettings(), language: "en"), Self.field("I like teh ", kind: .contenteditable, own: .gmail)),
        ] {
            let r = Rig()
            r.gate = gate
            r.field(Self.field("I like teh", kind: f.fieldKind ?? .textarea, own: f.ownSuggestions))
            r.field(f)
            XCTAssertTrue(r.checks.isEmpty, "\(f)")
        }
    }

    // MARK: - The line and Tab

    func testTabReplacesTheWordAndWhatFollowsItUpToTheCaret() throws {
        let r = Rig()
        r.field(Self.field("I like teh"))
        r.field(Self.field("I like teh "))
        r.answer("teh", "the")
        XCTAssertEqual(r.lines.last?.active.replacement, "the")
        let offer = try XCTUnwrap(r.arbiter.snapshot().current)
        XCTAssertEqual(offer.source, .page)
        XCTAssertNotNil(offer.kind.writing)
        guard case .consume(let claim) = r.press(.tab(to: Self.chrome)) else { return XCTFail("Tab did not take the fix") }
        XCTAssertFalse(claim.insertsText, "the page writes it, not Accessibility")
        let sent = try XCTUnwrap(r.inserts.last)
        XCTAssertEqual(sent.expect, "I like teh ")
        XCTAssertEqual(sent.replace, 4)
        XCTAssertEqual(sent.text, "the ")
        XCTAssertTrue(r.lineHidden)
    }

    func testAFixTheCheckerIsUnsureOfIsNotOfferedLive() {
        let r = Rig()
        r.field(Self.field("I like adress"))
        r.field(Self.field("I like adress "))
        r.answer("adress", "address", needsChoice: true)
        XCTAssertTrue(r.lines.isEmpty)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testAnAnswerForTextThatMovedOnIsDropped() {
        let r = Rig()
        r.field(Self.field("I like teh"))
        r.field(Self.field("I like teh "))
        let asked = r.checks.last
        r.field(Self.field("I like teh c"))
        if let asked {
            r.machine.checked(asked.id, [WritingCorrection(span: UTF16Span(start: 7, end: 10), original: "teh", replacement: "the", kind: .spelling, reason: "", source: .spellChecker)])
        }
        XCTAssertTrue(r.lines.isEmpty)
    }

    func testTypingTakesTheLineDown() {
        let r = Rig()
        r.field(Self.field("I like teh"))
        r.field(Self.field("I like teh "))
        r.answer("teh", "the")
        XCTAssertEqual(r.press(.typing("c", to: Self.chrome)), .pass(.dismissed))
        XCTAssertTrue(r.lineHidden)
        XCTAssertNil(r.arbiter.snapshot().current)
    }

    func testAnErrorAfterTheCaretIsNotOffered() {
        let r = Rig()
        r.field(Self.field("Done", after: " teh end"))
        r.field(Self.field("Done. ", after: " teh end"))
        if let c = r.checks.last {
            let span = UTF16Span((c.value as NSString).range(of: "teh"))
            r.machine.checked(c.id, [WritingCorrection(span: span, original: "teh", replacement: "the", kind: .spelling, reason: "", source: .spellChecker)])
        }
        XCTAssertTrue(r.lines.isEmpty, "a page insert replaces only text before the caret")
    }

    func testARefusedInsertSaysSoAtTheField() throws {
        let r = Rig()
        r.field(Self.field("I like teh"))
        r.field(Self.field("I like teh "))
        r.answer("teh", "the")
        _ = r.press(.tab(to: Self.chrome))
        let sent = try XCTUnwrap(r.inserts.last)
        r.machine.replied(PageInsertReply(requestId: sent.requestId, outcome: .refused, says: "stale", at: 0))
        XCTAssertTrue(r.commands.contains { if case .drawError = $0 { return true } else { return false } })
    }

    // MARK: - The wire

    func testAReplaceIsWrittenOnlyWhenItReplacesSomething() throws {
        let plain = PageInsert(requestId: "inline-1", windowId: "w", key: "k", expect: "ab", text: "c", token: "t", at: 0)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(plain), as: UTF8.self).contains("replace"))
        var fix = plain
        fix.replace = 2
        let data = try JSONEncoder().encode(fix)
        XCTAssertEqual(try JSONDecoder().decode(PageInsert.self, from: data).replace, 2)
    }

    func testAReplaceLongerThanTheTextBeforeTheCaretIsRefused() throws {
        var bad = PageInsert(requestId: "fix-1", windowId: "w", key: "k", expect: "ab", text: "c", token: "t", at: 0)
        bad.replace = 3
        XCTAssertThrowsError(try JSONDecoder().decode(PageInsert.self, from: try JSONEncoder().encode(bad)))
    }

    /// Audit finding b: the page engine reports a password input without its text (walker.ts excludes it), so nothing
    /// is checked or offered there.
    func testAFieldReportedWithoutTextIsNeverChecked() {
        let r = Rig()
        var f = Self.field("hunter2")
        f.text = nil
        r.field(f)
        r.field(f)
        XCTAssertTrue(r.checks.isEmpty)
        XCTAssertNil(r.arbiter.snapshot().current)
    }
}
