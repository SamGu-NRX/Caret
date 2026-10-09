import Foundation

/// The checks between a guard's approval (`InsertionGuard`, `UndoGuard`) and the write it approved, for an insert
/// and for Caret's ordinary Undo. Before it, only the claim's authorization, the process, the policy and focus were
/// asked again (PR #13 Apex review, a beta.2 blocker): typing could shift the approved offsets, and a selection made
/// after Caret set its own could turn an insert into a replacement, or Undo's "" into a deletion of the user's text.
///
/// The executor asks `input` before every write and every posted key, and `selected` after it sets the selection
/// and before it writes over it. Keys the user types meanwhile are held and sent after the write (`KeyHold`), so
/// they do not move the mark; a click does, and so does a key the hold let through after its deadline.
public enum WriteRecheck {
    public enum Refusal: String, Equatable, Sendable {
        /// A key or a click reached the system since the key that asked for the write.
        case inputMoved
        /// The field no longer holds exactly the approved value, or cannot be read.
        case fieldChanged
        /// The selection is not exactly the span about to be written over.
        case selectionMoved
        /// Another element holds focus.
        case targetMoved
    }

    /// Nil while no input arrived since `atKey`, the mark taken with the key that asked for the write.
    public static func input<Mark: Equatable>(atKey: Mark, now: Mark) -> Refusal? {
        atKey == now ? nil : .inputMoved
    }

    /// Nil when the field, read after the selection was set, is the approved one: the same element, exactly
    /// `expectedValue`, unit for unit, and exactly `range` selected.
    public static func selected(value: String?, selection: UTF16Selection?, sameElement: Bool, expectedValue: String, range: UTF16Selection) -> Refusal? {
        guard sameElement else { return .targetMoved }
        guard let value, value.utf16.elementsEqual(expectedValue.utf16) else { return .fieldChanged }
        guard selection == range else { return .selectionMoved }
        return nil
    }

    /// What a write left, read back once it settled.
    public enum Landed: Equatable, Sendable {
        /// The predicted value.
        case applied
        /// The value before the write: nothing landed.
        case untouched
        /// Anything else: an edit in the wrong place, or one merged with someone else's. Reported loudly.
        case misplaced
        /// The field could not be read.
        case unknown
    }

    public static func landed(value: String?, before: String, expected: String) -> Landed {
        guard let value else { return .unknown }
        if value.utf16.elementsEqual(expected.utf16) { return .applied }
        if value.utf16.elementsEqual(before.utf16) { return .untouched }
        return .misplaced
    }
}
