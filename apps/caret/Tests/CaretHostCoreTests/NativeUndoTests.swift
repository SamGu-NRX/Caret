import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// ⌘Z on a writing fix's toast by the app's own Undo (V1a check 6, option A), against a scripted
/// app. The target interface has no text write, so the tests check what was sent and selected.
final class NativeUndoTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    /// The app as the native Undo sees it: a field whose value follows a script of reads, a clock
    /// that moves only when the run sleeps, and a record of every key and caret move.
    private final class App: NativeUndoTarget {
        var now: Date
        /// The value each read returns, by the number of ⌘Z sent so far; the last entry repeats.
        var valueAfterUndo: (_ elapsed: TimeInterval) -> String
        var written: String
        var selection: UTF16Selection?
        var selectionAfterUndo: UTF16Selection?
        var target: TargetIdentity
        var front = true
        var refusals: [String?] = []
        var postAnswers = true
        private(set) var posts = 0
        private(set) var selects: [UTF16Selection] = []
        private var sentAt: Date?

        init(now: Date, target: TargetIdentity, written: String, selection: UTF16Selection?, valueAfterUndo: @escaping (TimeInterval) -> String) {
            self.now = now
            self.target = target
            self.written = written
            self.selection = selection
            self.valueAfterUndo = valueAfterUndo
        }

        func refusal() -> String? { refusals.isEmpty ? nil : refusals.removeFirst() }
        func isFrontmost() -> Bool { front }

        func read() -> RangeEdit.Live? {
            let value = sentAt.map { valueAfterUndo(now.timeIntervalSince($0)) } ?? written
            var t = target
            t.elementRevision = UTF16Text.digest(value)
            let sel = sentAt != nil && value != written ? (selectionAfterUndo ?? selection) : selection
            return RangeEdit.Live(target: t, value: value, selection: sel)
        }

        func postUndo() -> Bool {
            guard postAnswers else { return false }
            posts += 1
            sentAt = now
            return true
        }

        func select(_ selection: UTF16Selection) {
            selects.append(selection)
            self.selectionAfterUndo = selection
        }

        func sleep(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    private func identity() -> TargetIdentity {
        TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: "body", elementRevision: "")
    }

    /// The fix of `word` to `fixed` in `typed`, with the caret at the end, and its grant.
    private func fix(_ typed: String, _ word: String, _ fixed: String) throws -> (grant: UndoGrant, written: String) {
        var t = identity()
        t.elementRevision = UTF16Text.digest(typed)
        let observed = RangeEdit.Live(target: t, value: typed, selection: .caret(UTF16Text.length(typed)))
        let r = (typed as NSString).range(of: word)
        let edit = try RangeEdit.make(live: observed, replace: UTF16Span(r), replacement: fixed, now: t0).get()
        let approved = try edit.validate(observed, now: t0).get()
        var w = identity()
        w.elementRevision = UTF16Text.digest(approved.resultingValue)
        let after = RangeEdit.Live(target: w, value: approved.resultingValue, selection: approved.resultingSelection)
        let undo = try edit.verify(after: after, approved: approved, now: t0).get()
        var grant = UndoGrant.range(undo, priorValue: typed, writtenValue: approved.resultingValue, writeID: 1, strategy: .nativeUndo, createdAt: t0)
        grant.target = w
        return (grant, approved.resultingValue)
    }

    private func app(_ written: String, caret: Int, undo: @escaping (TimeInterval) -> String) -> App {
        App(now: t0.addingTimeInterval(0.2), target: identity(), written: written, selection: .caret(caret), valueAfterUndo: undo)
    }

    // MARK: - The capability

    func testOnlyTextEditUsesItsOwnUndo() {
        XCTAssertEqual(NativeUndoApps.strategy(bundleID: "com.apple.TextEdit"), .nativeUndo)
        XCTAssertEqual(NativeUndoApps.strategy(bundleID: "com.apple.mail"), .axRestore)
        XCTAssertEqual(NativeUndoApps.strategy(bundleID: nil), .axRestore)
    }

    func testARangeGrantIsAnAXRestoreUnlessToldOtherwise() throws {
        let (grant, _) = try fix("We will recieve it. ", "recieve", "receive")
        XCTAssertEqual(grant.strategy, .nativeUndo)
        let plain = UndoGrant.range(grant.rangeUndo!, priorValue: grant.priorValue, writtenValue: grant.writtenValue, writeID: 1)
        XCTAssertEqual(plain.strategy, .axRestore)
    }

    // MARK: - Reverted

    func testOneUndoPutsTheOriginalBackAndTheCaretWhereItWas() throws {
        let typed = "We will recieve the parcel tomorrow. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in typed }
        app.selectionAfterUndo = UTF16Selection(start: 8, end: 15)
        XCTAssertEqual(NativeUndo.run(grant, on: app), .reverted)
        XCTAssertEqual(app.posts, 1)
        XCTAssertEqual(app.selects, [.caret(UTF16Text.length(typed))], "the caret goes back to the end, not left on the restored word")
    }

    /// The text typed before the fix is part of the value the Undo must leave, unit for unit.
    func testTypingBeforeTheFixMustSurviveExactly() throws {
        let typed = "Dear Ana,\nI will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let undoesTypingToo = app(written, caret: UTF16Text.length(written)) { _ in "Dear Ana,\n" }
        XCTAssertEqual(NativeUndo.run(grant, on: undoesTypingToo), .failed("nativeUndoMismatch"))
        XCTAssertEqual(undoesTypingToo.posts, 1, "never a second ⌘Z")
        XCTAssertEqual(undoesTypingToo.selects, [])
    }

    func testFixAllIsOneWriteAndOneUndo() throws {
        let typed = "I recieve teh letters every week. "
        let (grant, written) = try fix(typed, "recieve teh", "receive the")
        let app = app(written, caret: UTF16Text.length(written)) { _ in typed }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .reverted)
        XCTAssertEqual(app.posts, 1)
    }

    func testADelayedUndoIsWaitedFor() throws {
        let typed = "We will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { elapsed in elapsed < 0.6 ? written : typed }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .reverted)
        XCTAssertEqual(app.posts, 1)
    }

    /// Unicode: a value that reads the same but differs in UTF-16 units is not the original.
    func testTheValueMustMatchUnitForUnit() throws {
        let typed = "Caf\u{E9} recieve. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "Cafe\u{301} recieve. " }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .failed("nativeUndoMismatch"))
    }

    // MARK: - Sent, and not seen: stop, never write

    func testAnAppThatIgnoresTheUndoTimesOutWithNoSecondKeyAndNoWrite() throws {
        let typed = "We will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in written }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .failed("nativeUndoTimeout"))
        XCTAssertEqual(app.posts, 1)
        XCTAssertEqual(app.selects, [])
    }

    func testTypingDuringTheUndoStopsIt() throws {
        let typed = "We will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in written + "x" }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .failed("nativeUndoMismatch"))
        XCTAssertEqual(app.posts, 1)
        XCTAssertEqual(app.selects, [])
    }

    /// Reverted, then the user clicks elsewhere before the caret is put back: their selection stays.
    func testASelectionMovedAfterTheUndoIsLeftAlone() throws {
        let typed = "We will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        final class Clicking: NativeUndoTarget {
            let inner: NativeUndoTests.App
            var reads = 0
            init(_ inner: NativeUndoTests.App) { self.inner = inner }
            func refusal() -> String? { inner.refusal() }
            func isFrontmost() -> Bool { inner.isFrontmost() }
            func read() -> RangeEdit.Live? {
                reads += 1
                var live = inner.read()
                if reads > 2 { live?.selection = .caret(2) }
                return live
            }
            func postUndo() -> Bool { inner.postUndo() }
            func select(_ selection: UTF16Selection) { inner.select(selection) }
            func sleep(_ seconds: TimeInterval) { inner.sleep(seconds) }
            var now: Date { inner.now }
        }
        let inner = app(written, caret: UTF16Text.length(written)) { _ in typed }
        inner.selectionAfterUndo = UTF16Selection(start: 8, end: 15)
        let app = Clicking(inner)
        XCTAssertEqual(NativeUndo.run(grant, on: app), .reverted)
        XCTAssertEqual(inner.selects, [])
    }

    // MARK: - Refused before any key

    func testNotFrontmostSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.front = false
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("appNotFront"))
        XCTAssertEqual(app.posts, 0)
    }

    func testFocusMovingJustBeforeTheKeySendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.refusals = [nil, "targetNotAllowed"]
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("targetNotAllowed"))
        XCTAssertEqual(app.posts, 0)
    }

    /// Review of H7: a key typed after the toast's ⌘Z, before the posted one, would be what the
    /// posted ⌘Z undoes. The executor reports it as `inputDuringUndo`; nothing is sent.
    func testInputBeforeTheKeySendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.refusals = [nil, "inputDuringUndo"]
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("inputDuringUndo"))
        XCTAssertEqual(app.posts, 0)
    }

    /// Review of H7: a click after the Undo landed is the user's selection; the caret is not moved.
    func testAClickAfterTheUndoKeepsTheUsersSelection() throws {
        let typed = "We will recieve it. "
        let (grant, written) = try fix(typed, "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in typed }
        app.selectionAfterUndo = UTF16Selection(start: 8, end: 15)
        app.refusals = [nil, nil, "inputDuringUndo"]
        XCTAssertEqual(NativeUndo.run(grant, on: app), .reverted)
        XCTAssertEqual(app.selects, [])
    }

    func testARevokedGrantSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.refusals = ["revoked"]
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("revoked"))
        XCTAssertEqual(app.posts, 0)
    }

    func testAKeyRefusedAtThePostSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.postAnswers = false
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("targetNotAllowed"))
    }

    func testAnExpiredGrantSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: UTF16Text.length(written)) { _ in "" }
        app.now = t0.addingTimeInterval(UndoGrant.defaultLifetime + 1)
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("expired"))
        XCTAssertEqual(app.posts, 0)
    }

    func testAFieldChangedSinceTheFixSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written + "!", caret: UTF16Text.length(written) + 1) { _ in "" }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("revisionChanged"))
        XCTAssertEqual(app.posts, 0)
    }

    func testACaretMovedSinceTheFixSendsNothing() throws {
        let (grant, written) = try fix("We will recieve it. ", "recieve", "receive")
        let app = app(written, caret: 2) { _ in "" }
        XCTAssertEqual(NativeUndo.run(grant, on: app), .refused("selectionMoved"))
        XCTAssertEqual(app.posts, 0)
    }

    // MARK: - The keys

    /// Two quick ⌘Z: the arbiter hands the toast's grant to the first only; the second is the
    /// app's own and passes through, so the app undoes the typing next, as it would without Caret.
    func testTheSecondCommandZIsTheApps() throws {
        let arbiter = OfferArbiter()
        let (grant, _) = try fix("We will recieve it. ", "recieve", "receive")
        var g = grant
        g.createdAt = Date()
        arbiter.showToast(g)
        let key = KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: 4242)
        guard case .undo(let taken) = arbiter.handleKeyDown(key) else { return XCTFail("the first ⌘Z takes the grant") }
        XCTAssertEqual(taken.strategy, .nativeUndo)
        XCTAssertEqual(arbiter.handleKeyDown(key), .pass(.noOffer))
    }
}
