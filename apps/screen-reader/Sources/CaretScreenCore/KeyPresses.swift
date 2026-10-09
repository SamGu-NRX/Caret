// Which key presses press a button (B21). In AppKit, Return and keypad Enter press the key window's default
// button, and Space presses the focused button. The reader's press watch reports those as userPress, read
// only, beside clicks (B20). The decision is made from the key's code and modifier flags and from what the
// reader last saw of the window: the focused element's role and the default button. A key's characters are
// never read, and every other key is dropped where it arrives.
//
// Return or Enter in a single-line text field (AXTextField or AXSecureTextField, not in a web page) counts as a
// press of the window's enabled default button: AppKit presses it, 5 times of 5 with the fixture frontmost and
// Note focused (B21 gui/keys-front; B22 lead decision). In a text area, a combo box or a field of a web page
// Return is text, a choice or the page's own submit, so it still never counts there; Space in any text field
// is text. A click on the same button is always seen.
import Foundation

public enum KeyPresses {
    /// macOS virtual key codes (HIToolbox kVK_Return, kVK_ANSI_KeypadEnter, kVK_Space).
    public static let returnCode = 36
    public static let enterCode = 76
    public static let spaceCode = 49

    /// The modifier flags (CGEventFlags raw values) that make a key a shortcut rather than a press:
    /// Shift, Control, Option and Command. Caps Lock, Fn and the keypad flag are left out: the Enter key
    /// on a laptop is Fn-Return, and keypad keys carry the keypad flag.
    public static let shortcutFlags: UInt64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000

    /// Roles that take typed text, Return and Space included: the editable roles, and a password field, which
    /// some apps give its own role rather than a subrole of AXTextField (B21 review).
    public static let textRoles: Set<String> = Roles.editable.union(["AXSecureTextField"])

    /// Roles that Space presses when focused. A link is left out: Space scrolls a page with a link focused.
    public static let spacePressable: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton"]

    /// What a press key presses.
    public enum Target: Equatable, Sendable {
        /// The window's default button (Return, Enter).
        case defaultButton
        /// The focused element (Space).
        case focused
    }

    /// The press key a key going down is, or nil: another key, a key repeat, or a key held with a shortcut modifier.
    public static func via(keyCode: Int, flags: UInt64, autorepeat: Bool) -> UserPress.Via? {
        if autorepeat || flags & shortcutFlags != 0 { return nil }
        switch keyCode {
        case returnCode: return .return
        case enterCode: return .enter
        case spaceCode: return .space
        default: return nil
        }
    }

    /// Roles of a single-line field, in which Return presses the default button when the field is not in a web page.
    public static let singleLineRoles: Set<String> = ["AXTextField", "AXSecureTextField"]

    /// What the key presses, given the role of the element that had focus, whether that element is a single-line
    /// field outside any web page (`singleLineField`, read by the reader when focus arrived), and whether the
    /// window has an enabled default button, as the reader last read them. Nil when it presses nothing the reader
    /// reports: Return in a text field that is not single-line, Space in any text field, Return with no enabled
    /// default button, or Space on something that is not a button.
    public static func target(_ via: UserPress.Via, focusedRole: String?, singleLineField: Bool, enabledDefaultButton: Bool) -> Target? {
        if let r = focusedRole, textRoles.contains(r) {
            let returnKey = via == .return || via == .enter
            return returnKey && singleLineField && singleLineRoles.contains(r) && enabledDefaultButton ? .defaultButton : nil
        }
        switch via {
        case .return, .enter: return enabledDefaultButton ? .defaultButton : nil
        case .space: return focusedRole.map { spacePressable.contains($0) } == true ? .focused : nil
        case .click: return nil
        }
    }
}
