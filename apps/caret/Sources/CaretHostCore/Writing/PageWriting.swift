import CaretScreenCore
import CoreGraphics
import Foundation

/// Brief item 5: spelling and grammar fixes in a web page field.
///
/// Caret cannot read or write a page field through Accessibility (H10, H13). The helper's page engine reports the
/// text around the caret after each focus change and burst of typing (`PageField.text`); this machine checks the word
/// the user just closed (`WordFix`) and each finished sentence (`WritingMarks.boundary`, with the static rules), as
/// the native writing coordinator does, and offers the fix nearest the caret in the same line (`WritingOffer`). Tab
/// sends one `PageInsert` that replaces the text from the error to the caret, with the fix and the text after it, so
/// the page edits as it does for the user's own typing and the page's Undo takes the fix back in one step.
///
/// Differences from the native path, each forced by what a page gives: no underlines (the page reports where the caret
/// is, not where each word is), so only the line under the caret shows; and only an error that ends at or before the
/// caret can be fixed, since the page replaces text just before its caret. The same fields as inline text take it
/// (`PageInline.takes`): inputs and textareas, contenteditables with that setting, never a page with its own
/// suggestions. The coordinator checks (`NativeChecker`) and draws; every decision is here (`PageWritingTests`).
public final class PageWritingMachine {
    public enum Command: Equatable {
        /// Check `span` of `value` with the system checker and answer `checked(id, …)`.
        case check(Check)
        /// Show the line for this offer under the page's caret.
        case drawLine(WritingOffer, caret: CGRect)
        case hideLine
        case send(PageInsert)
        case drawError(LineContent, field: CGRect)
        case hideError
        case count(String)
    }

    public struct Check: Equatable, Sendable {
        public var id: UInt64
        public var value: String
        public var span: UTF16Span
        /// The word just closed (spelling only, live rules) rather than a finished sentence.
        public var word: Bool
    }

    public struct Gate: Equatable, Sendable {
        /// Not paused, the words role on, no input method composing, the browser allowed.
        public var allowed: Bool
        /// `CaretSettings.pageInlineContentEditable`.
        public var contentEditable: Bool
        public var settings: PageInlineSettings
        /// The language checks run in; nil runs none.
        public var language: String?

        public init(allowed: Bool, contentEditable: Bool, settings: PageInlineSettings, language: String?) {
            self.allowed = allowed
            self.contentEditable = contentEditable
            self.settings = settings
            self.language = language
        }
    }

    public var output: (Command) -> Void = { _ in }
    public private(set) var lastOutcome: String?

    private let arbiter: OfferArbiter
    private let clock: SurfaceClock
    private var gate = Gate(allowed: false, contentEditable: false, settings: PageInlineSettings(), language: nil)
    private var current: PageField?
    /// The text the field last reported, by focus: a check runs on the change from it.
    private var previous: (focus: String, value: String)?
    private var pending: (check: Check, focus: String)?
    private var checks: UInt64 = 0

    private struct Shown {
        var offerID: UInt64
        var target: TargetIdentity
        var token: String
        var before: String
        var value: String
        var caret: CGRect
        var frame: CGRect
        var page: PageField.OwnSuggestions?
    }
    private var shown: Shown?
    private var awaiting: (requestId: String, frame: CGRect, page: PageField.OwnSuggestions?, timer: SurfaceTimer)?
    private var inserts = 0
    private var errorTimer: SurfaceTimer?

    /// How long an answer to a fix may take before the line says the page may not have taken it, and how long an
    /// error line stays: inline text's (`PageInlineMachine`), since the page does the same insert.
    static let insertWait = PageInlineMachine.insertWait
    static let errorLifetime = PageInlineMachine.errorLifetime

    public init(arbiter: OfferArbiter, clock: SurfaceClock) {
        self.arbiter = arbiter
        self.clock = clock
    }

    private static func focusKey(_ f: PageField) -> String { "\(f.windowId)|\(f.key ?? "")|\(f.token ?? "")" }

    // MARK: - Inputs

    /// The page field the user is in, after each walk; nil when they left the page.
    public func field(_ f: PageField?, gate g: Gate) {
        current = f
        gate = g
        guard let f, let text = f.text, text.selection.isEmpty, f.key != nil, f.caret != nil,
              g.allowed, g.language != nil, f.pageFocused != false,
              PageInline.takes(f.fieldKind, contentEditable: g.contentEditable),
              f.ownSuggestions == nil || (f.ownSuggestions == .gmail && g.settings.isOn(.gmail))
        else {
            previous = nil
            pending = nil
            return withdraw()
        }
        let focus = Self.focusKey(f)
        let value = text.before + text.after
        // The line belongs to the exact field state it was offered on: the same element, and the same text on each side
        // of the caret (a click that moved the caret changes the split, not the value).
        if let s = shown, !(s.before.utf16.elementsEqual(text.before.utf16) && s.value.utf16.elementsEqual(value.utf16)
                             && s.target.windowID == f.windowId && s.target.elementID == f.key && s.token == f.token) {
            withdraw()
        } else if let s = shown, let caret = f.caret, PageInlineMachine.rect(caret) != s.caret, let offer = arbiter.snapshot().current,
                  offer.id == s.offerID, let writing = offer.kind.writing {
            // Only the caret's place moved (a scroll): the line follows it.
            shown?.caret = PageInlineMachine.rect(caret)
            output(.drawLine(writing, caret: PageInlineMachine.rect(caret)))
        }
        let last = previous?.focus == focus ? previous?.value : nil
        previous = (focus, value)
        guard let last else { return }
        // Item 3: right after a paste, drop, undo or redo in a rich editor, its undo would group our fix with that edit.
        if f.fieldKind == .contenteditable, let quiet = text.quietMs, quiet < PageInlineMachine.editQuietMs { return note("afterEdit") }
        let caret = UTF16Selection.caret(UTF16Text.length(text.before))
        if let sentence = WritingMarks.boundary(previous: last, value: value, selection: caret) {
            ask(Check(id: next(), value: value, span: sentence, word: false), focus: focus)
        } else if let word = WordFix.closedWord(previous: last, value: value, selection: caret), WordFix.eligible(word, in: value) {
            ask(Check(id: next(), value: value, span: word, word: true), focus: focus)
        }
    }

    private func next() -> UInt64 {
        checks &+= 1
        return checks
    }

    private func ask(_ c: Check, focus: String) {
        pending = (c, focus)
        output(.check(c))
    }

    /// The system checker's findings for check `id`. Ignored when the field moved on since it was asked.
    public func checked(_ id: UInt64, _ found: [WritingCorrection]) {
        guard let p = pending, p.check.id == id else { return note("stale") }
        pending = nil
        guard let f = current, let text = f.text, Self.focusKey(f) == p.focus,
              (text.before + text.after).utf16.elementsEqual(p.check.value.utf16),
              let t = PageInline.target(f), let token = f.token, let caretFrame = f.caret
        else { return note("moved") }
        let value = p.check.value
        let caret = UTF16Text.length(text.before)
        let language = gate.language ?? "en"
        let candidates: [WritingCorrection]
        if p.check.word {
            candidates = found.filter { p.check.span.contains($0.span) && WordFix.offersLive($0) }
        } else {
            // A finished sentence: the static rules with the checker's findings, as in a native field. A spelling fix
            // still has to be one the live rules accept, since no underline marks the word it changes.
            let merged = WritingCheck.merged(WritingCheck.check(value, sentence: p.check.span, language: language), found)
            candidates = merged.filter { !$0.needsChoice && ($0.kind != .spelling || WordFix.offersLive($0)) }
        }
        // The page replaces only text just before its caret, and at most what it reports there.
        let fixable = candidates.filter { $0.span.end <= caret && caret - $0.span.start <= UTF16Text.length(text.before) }
        guard !fixable.isEmpty else { return note(candidates.isEmpty ? "clean" : "afterCaret") }
        let live = RangeEdit.Live(target: t, value: value, selection: .caret(caret))
        guard let writing = WritingOffer.correction(marks: fixable, checkedRevision: UTF16Text.digest(value), live: live, language: language) else {
            return note("noOffer")
        }
        let offer = Offer(text: "", source: .page, kind: .writing(writing), target: t, fieldValue: value, caretUTF16: caret,
                          createdAt: clock.now, maxAgeSeconds: RangeEdit.defaultMaxAge)
        // Published unshown, drawn, then revealed: Tab takes only a fix whose line is on screen.
        guard let offerID = arbiter.publish(offer, shown: false) else { return note("refused") }
        let caretRect = PageInlineMachine.rect(caretFrame)
        shown = Shown(offerID: offerID, target: t, token: token, before: text.before, value: value, caret: caretRect,
                      frame: f.frame.map(PageInlineMachine.rect) ?? caretRect, page: f.ownSuggestions)
        output(.drawLine(writing, caret: caretRect))
        guard arbiter.reveal(offerID: offerID) else {
            shown = nil
            output(.hideLine)
            return note("keyBeforeDrawn")
        }
        note("offered")
    }

    /// ↓, ↑ or a Command digit moved within the offer: draw it as the arbiter now holds it.
    public func navigated(offerID: UInt64, ui: OfferUI) {
        guard let s = shown, s.offerID == offerID, let writing = arbiter.snapshot().current?.kind.writing else { return }
        output(.drawLine(writing, caret: s.caret))
    }

    /// A key the arbiter passed or Esc: the line goes once its offer has.
    public func offerChanged(_ reason: OfferArbiter.PassReason) {
        guard let s = shown, arbiter.snapshot().current?.id != s.offerID else { return }
        hide()
    }

    /// Tab (or a Command digit) took a fix: one page insert replaces the text from the error to the caret.
    public func claimed(_ claim: Claim) {
        guard let s = shown, claim.offer.id == s.offerID else { return }
        hide()
        guard let edit = claim.rangeEdit else { return }
        let caret = UTF16Text.length(s.before)
        guard edit.replace.end <= caret, let tail = UTF16Text.slice(s.value, start: edit.replace.end, end: caret) else {
            return note("insert.afterCaret")
        }
        let text = edit.replacement + tail
        let replace = caret - edit.replace.start
        guard !text.isEmpty, let f = current, f.windowId == s.target.windowID, f.key == s.target.elementID, f.token == s.token else {
            note("insert.fieldMoved")
            return sayError(PageInlineCopy.notTaken(s.page), at: s.frame)
        }
        inserts += 1
        let requestId = "fix-\(inserts)"
        let expect = PageInline.lastUnits(s.before)
        guard replace <= UTF16Text.length(expect) else { return note("insert.tooFar") }
        output(.send(PageInsert(requestId: requestId, windowId: s.target.windowID, key: s.target.elementID, expect: expect, text: text,
                                token: s.token, at: Int64(clock.now.timeIntervalSince1970 * 1000), replace: replace)))
        note("insert.sent")
        awaiting?.timer.cancel()
        let timer = clock.schedule(after: Self.insertWait, repeats: false) { [weak self] in
            guard let self, let a = self.awaiting, a.requestId == requestId else { return }
            self.awaiting = nil
            self.note("insert.unanswered")
            self.sayError(PageInlineCopy.unverified(a.page), at: a.frame)
        }
        awaiting = (requestId, s.frame, s.page, timer)
    }

    /// The page's answer to a fix. Answers to inline text's inserts (another prefix) are not this machine's.
    public func replied(_ r: PageInsertReply) {
        guard let a = awaiting, a.requestId == r.requestId else { return }
        a.timer.cancel()
        awaiting = nil
        note("insert.\(r.outcome.rawValue)")
        switch r.outcome {
        case .inserted: return
        case .refused, .failed: sayError(PageInlineCopy.notTaken(a.page), at: a.frame)
        case .unverified: sayError(PageInlineCopy.unverified(a.page), at: a.frame)
        }
    }

    /// The settings stopped writing help, or the page went: what is shown goes.
    public func gateClosed() {
        previous = nil
        pending = nil
        withdraw()
    }

    /// A newer offer took the slot from this machine's fix: its line goes, since Tab now belongs to the newer one.
    public func displaced(_ offer: Offer) {
        guard let s = shown, s.offerID == offer.id else { return }
        hide()
    }

    /// The fix goes from the arbiter and the screen together, so Tab never takes one that is not drawn.
    private func withdraw() {
        if let s = shown { arbiter.invalidate(offerID: s.offerID) }
        hide()
    }

    private func hide() {
        guard shown != nil else { return }
        shown = nil
        output(.hideLine)
    }

    private func sayError(_ line: LineContent, at frame: CGRect) {
        errorTimer?.cancel()
        output(.drawError(line, field: frame))
        errorTimer = clock.schedule(after: Self.errorLifetime, repeats: false) { [weak self] in
            self?.errorTimer = nil
            self?.output(.hideError)
        }
    }

    private func note(_ outcome: String) {
        lastOutcome = outcome
        output(.count("pageWriting.\(outcome)"))
    }
}
