import Foundation

/// How ⌘Z on a writing fix's toast reverts the fix. Recorded on the grant when the fix is written
/// (`UndoGrant.range`), from the app it was written in.
public enum UndoStrategy: String, Codable, Sendable {
    /// Caret writes the original back over the range through Accessibility, with the same guard as
    /// the fix (`RangeEdit`). The app records that write as an edit of its own, so its next Undo
    /// puts the fix back (V1a check 6, in TextEdit, for Fix and for Fix all).
    case axRestore
    /// Caret sends the app one ⌘Z, which takes the fix out of the app's own history
    /// (`NativeUndo.run`). Only where acceptance proved that one native Undo reverses exactly
    /// Caret's AX fix and nothing typed before it (`NativeUndoApps`).
    case nativeUndo
}

/// The apps whose native Undo reverses Caret's AX range write as one step.
public enum NativeUndoApps {
    /// TextEdit only, on the lead's decision for H7 (V1a check 6's option A). The proof is
    /// writing_vm_acceptance.py's `native` case, run in V1b's VM job: after a Tab fix, with Caret's
    /// toast gone, one TextEdit ⌘Z leaves exactly the sentence as typed, and the next undoes the
    /// typing. An app is not added because it exposes `AXSelectedText`: whether an AX write becomes
    /// its own undo group is the app's choice, and no other app has been measured.
    public static let proven: Set<String> = ["com.apple.TextEdit"]

    public static func strategy(bundleID: String?) -> UndoStrategy {
        bundleID.map(proven.contains) == true ? .nativeUndo : .axRestore
    }
}

/// What the native Undo needs from the system. The executor answers through Accessibility, the
/// workspace and a pid-directed key; tests answer from a script. It has no way to write text: once
/// the ⌘Z is sent, nothing Caret does through it can change the field's value.
public protocol NativeUndoTarget {
    /// Nil while the write's authorization is live, its process is the one written to, its pid is
    /// allowed and the written element still has the app's focus; otherwise why not.
    func refusal() -> String?
    /// The app is the active one, the app keys go to.
    func isFrontmost() -> Bool
    /// The written element, as the range guard reads it; nil when it cannot be read.
    func read() -> RangeEdit.Live?
    /// One ⌘Z, marked as Caret's, posted to the app's pid only. False when nothing was posted (the
    /// target stopped holding just before the key).
    func postUndo() -> Bool
    /// Moves the caret. A selection change, not a text write.
    func select(_ selection: UTF16Selection)
    func sleep(_ seconds: TimeInterval)
    var now: Date { get }
}

/// ⌘Z on a writing fix's toast, by the app's own Undo (`UndoStrategy.nativeUndo`).
///
/// Before the key: the same checks as the AX restore (the grant's authorization, process, pid and
/// focused element, and the undo edit validated against the field as the fix left it), and the app
/// must be frontmost, so the ⌘Z reaches the window holding the fix. Then exactly one ⌘Z, never
/// another. After it: the whole value must become the value before the fix, UTF-16 unit for unit.
/// A timeout, any other value, or a target that stopped holding ends it as a failure with no text
/// written: a posted key whose effect is not seen yet may still land, and writing over it could
/// undo something else. Only when the value matches is the caret put back where the user had it,
/// and only if nothing moved the selection meanwhile.
public enum NativeUndo {
    public enum Outcome: Equatable, Sendable {
        /// The value is the one before the fix.
        case reverted
        /// Refused before any key was sent; the field is as the fix left it.
        case refused(String)
        /// The ⌘Z was sent and the value did not become the one before the fix in time. Nothing
        /// was written after the key.
        case failed(String)

        public var error: String? {
            switch self {
            case .reverted: return nil
            case .refused(let code), .failed(let code): return code
            }
        }
    }

    /// How long the value may take to come back (the executor's paste settle time).
    public static let timeout: TimeInterval = 1.5
    static let poll: TimeInterval = 0.02

    public static func run(_ grant: UndoGrant, on target: NativeUndoTarget, timeout: TimeInterval = timeout) -> Outcome {
        guard let undo = grant.rangeUndo else { return .refused("noUndo") }
        if let refusal = target.refusal() { return .refused(refusal) }
        guard let before = target.read() else { return .refused("fieldUnreadable") }
        let approved: RangeEdit.Approved
        switch undo.validate(before, phase: .observed, now: target.now) {
        case .failure(let refusal): return .refused(refusal.code)
        case .success(let a): approved = a
        }
        // The undo edit and the grant must agree on the value before the fix.
        guard approved.resultingValue.utf16.elementsEqual(grant.priorValue.utf16) else { return .refused("approvalMismatch") }
        guard target.isFrontmost() else { return .refused("appNotFront") }
        if let refusal = target.refusal() { return .refused(refusal) }
        guard target.postUndo() else { return .refused(target.refusal() ?? "targetNotAllowed") }

        let sent = target.now
        var reverted: RangeEdit.Live?
        while reverted == nil {
            if let live = target.read() {
                if live.value.utf16.elementsEqual(grant.priorValue.utf16) {
                    reverted = live
                    continue
                }
                if !live.value.utf16.elementsEqual(grant.writtenValue.utf16) { return .failed("nativeUndoMismatch") }
            }
            if target.now.timeIntervalSince(sent) > timeout { return .failed("nativeUndoTimeout") }
            target.sleep(poll)
        }
        // The app selects what its Undo put back; the user's caret goes where it was before the fix,
        // as the AX restore leaves it, unless something moved the selection since the Undo landed.
        if target.refusal() == nil, let again = target.read(), again.value.utf16.elementsEqual(grant.priorValue.utf16),
           again.selection == reverted?.selection, again.selection != approved.resultingSelection {
            target.select(approved.resultingSelection)
        }
        return .reverted
    }
}
