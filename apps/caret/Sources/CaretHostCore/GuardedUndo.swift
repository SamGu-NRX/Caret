import Foundation

/// The app side of an insert's AX undo, as `GuardedUndo.run` drives it. `InsertionExecutor`
/// implements it with Accessibility on the written element.
public protocol UndoTarget: AnyObject {
    /// Why the claim's target no longer holds (authorization, process, policy), or nil.
    func refusal() -> String?
    /// No key or click since ⌘Z (the input mark taken at the key).
    func quiet() -> Bool
    func read() -> InsertionGuard.LiveField?
    /// Sets the selection: a write to the app.
    func select(_ selection: UTF16Selection) -> Bool
    /// Replaces the selection with `text`: the write that changes text.
    func replaceSelection(_ text: String) -> WriteFallback.AXAnswer
    func sleep(_ seconds: TimeInterval)
    var now: Date { get }
}

/// ⌘Z on an insert's grant (S2). Before any write deletes text, Caret proves the exact range and
/// its exact contents, or reports and writes nothing:
///
/// 1. `UndoGuard.approve` judges the field as read now (S1's states for an unconfirmed grant).
/// 2. Every write to the app (the selection, the text, a selection put back) is preceded,
///    immediately and after the target check, by the input mark taken at ⌘Z (`permit`): a key or
///    click since then is the user's, and the write could cross it.
/// 3. After selecting the span, the field is read again: the same value unit for unit, exactly the
///    span selected, still quiet (`UndoGuard.recheck`). Only then is the text written.
/// 4. The field must then read exactly the recorded original.
public enum GuardedUndo {
    public struct Outcome: Equatable, Sendable {
        public var ok: Bool
        public var error: String?
        /// Only the part of an unconfirmed write that had gone in was taken out.
        public var partial: Bool
        /// For an unconfirmed write's field left as it is: what it holds and held, in S1's words.
        public var says: String?

        public init(ok: Bool, error: String?, partial: Bool = false, says: String? = nil) {
            self.ok = ok
            self.error = error
            self.partial = partial
            self.says = says
        }
    }

    /// Asked immediately before each write an undo makes: the target first, then the input mark.
    public static func permit(refusal: String?, quiet: Bool) -> String? {
        refusal ?? (quiet ? nil : UndoGuard.Rejection.inputDuringUndo.code)
    }

    public static func run(_ grant: UndoGrant, on app: UndoTarget, settleTimeout: TimeInterval) -> Outcome {
        func fail(_ code: String, _ says: String? = nil) -> Outcome { Outcome(ok: false, error: code, says: says) }
        /// An unconfirmed write's field that is left as it is: what it holds and held (S1).
        func leftAlone(_ held: String) -> String? {
            grant.unconfirmed ? "\(UnconfirmedInsert.contents(before: grant.priorValue, held: held)); Caret left it as it is" : nil
        }
        func mayWrite() -> String? { permit(refusal: app.refusal(), quiet: app.quiet()) }

        guard let live = app.read() else {
            return fail("fieldUnreadable", grant.unconfirmed ? "Caret could not read the field; before the write it held \(UnconfirmedInsert.quoted(grant.priorValue))" : nil)
        }
        let revert: UndoGuard.Revert
        switch UndoGuard.approve(grant, live: live) {
        case .failure(.fieldChanged): return fail(UndoGuard.Rejection.fieldChanged.code, leftAlone(live.value))
        case .failure(let rejection): return fail(rejection.code)
        case .success(let r): revert = r
        }
        if let refused = mayWrite() { return fail(refused) }
        let span = UTF16Selection(start: revert.start, end: revert.start + revert.length)
        guard app.select(span) else { return fail("writeRefused") }
        let selected = app.read()
        if let rejection = selected.map({ UndoGuard.recheck(revert, approvedValue: live.value, now: $0, quiet: app.quiet()) }) ?? .fieldChanged {
            // Only a selection this undo made, over an unchanged field, is put back, and only with
            // the same permit as any write.
            if let selected, UTF16Text.same(selected.value, live.value), selected.selection == span, let previous = live.selection, mayWrite() == nil {
                _ = app.select(previous)
            }
            return fail(rejection.code, rejection == .fieldChanged ? selected.flatMap { leftAlone($0.value) } : nil)
        }
        if let refused = mayWrite() { return fail(refused) }
        // A restore the app did not answer may still apply: it is waited for like one it took.
        let answer = app.replaceSelection(revert.restore)
        guard answer != .refused else { return fail("writeRefused") }
        let deadline = app.now.addingTimeInterval(settleTimeout)
        repeat {
            if let value = app.read()?.value, UndoGuard.restored(revert, value: value) { return Outcome(ok: true, error: nil, partial: revert.partialWrite) }
            app.sleep(0.02)
        } while app.now < deadline
        return fail(answer == .uncertain ? WriteFallback.writeUncertain : "writeMismatch")
    }
}

/// After a refused range write, the selection Caret made is put back only when a fresh read shows
/// the field exactly as before and the selection still Caret's span, and then the permit (the
/// target, and for an undo ⌘Z's input mark) holds immediately before the selection write. A click
/// recorded during the reads is the user's selection to keep (S2 confirmation).
public enum SelectionRollback {
    public static func allowed(
        read: () -> (value: String, selection: UTF16Selection)?, before: String, span: UTF16Selection, permit: () -> Bool
    ) -> Bool {
        guard let now = read(), UTF16Text.same(now.value, before), now.selection == span else { return false }
        return permit()
    }
}
