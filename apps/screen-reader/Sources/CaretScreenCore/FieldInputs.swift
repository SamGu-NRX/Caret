// Which of the user's keys count as input on a field, and at which element (issue #26). When Stop cuts off a write
// whose answer is lost, the helper reads the field once to see whether the write landed. A field holding exactly
// Caret's value reads the same whether Caret wrote it or the user typed it after Stop, so the reader reports each key
// going down in a watched process as fieldInput: the element that had keyboard focus as the reader last read it, never
// the key itself. The helper counts a report on the written field, or one it cannot place, as the user's input there.
//
// Esc is never reported: it types nothing, and it is Caret's Stop key, so counting it would turn every Stop into one
// whose write Caret cannot claim. Tab is reported at the element it leaves, and it moves focus: until the reader reads
// where focus went, the keys after it are reported at no element, so the helper counts them against every field of
// the window.
import Foundation

public enum FieldInputs {
    /// macOS virtual key codes (HIToolbox kVK_Escape, kVK_Tab).
    public static let escapeCode: UInt16 = 53
    public static let tabCode: UInt16 = 48

    /// The report for a key going down at `at` in process `pid`, or nil for Esc. `windowId` and `key` are where focus
    /// was last read; `focusMoved` says a Tab went down since then, so the element is not known.
    public static func report(keyCode: UInt16, at: Int64, pid: Int, windowId: String?, key: String?, focusMoved: Bool) -> FieldInput? {
        if keyCode == escapeCode { return nil }
        return FieldInput(at: at, pid: pid, windowId: windowId, key: focusMoved || windowId == nil ? nil : key)
    }

    /// Whether the key moves keyboard focus away from the element the reader last read as focused.
    public static func movesFocus(keyCode: UInt16) -> Bool { keyCode == tabCode }
}
