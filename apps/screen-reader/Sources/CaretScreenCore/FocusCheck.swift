// The check between focusing a web field and writing its value (B23, S1 audit #14). A WebKit window that is not key
// applies a value write to whichever field has focus, so the reader focuses the field first (B20). A page's focus
// handler can then move focus to another field, and the value would land there. So after the focus and right before
// the write, the field must still have focus and still be in the window the helper named, and the app's focused
// element, when it is in that window, must be the field. Anything else, an unreadable answer included, is refused.

public enum FocusCheck {
    /// Where the app says its focused element is.
    public enum AppFocus: Equatable, Sendable {
        /// The field the reader focused.
        case target
        /// Another element of the target window.
        case elsewhereInWindow
        /// An element of another window, as when the target window is not the key one; the field's own focus decides.
        case otherWindow
        /// The app's focused element could not be read; the field's own focus decides.
        case unknown
    }

    /// Nil when the write may go ahead; otherwise the focusMoved detail.
    /// - Parameters:
    ///   - elementFocused: the field's AXFocused; nil when it could not be read.
    ///   - inTargetWindow: whether the field's AXWindow is the window the helper named; nil when it could not be read.
    public static func refusal(elementFocused: Bool?, inTargetWindow: Bool?, appFocus: AppFocus) -> String? {
        switch inTargetWindow {
        case nil: return "the reader cannot read which window the field is in"
        case false?: return "the field is no longer in the window Caret meant"
        case true?: break
        }
        switch elementFocused {
        case nil: return "the reader cannot read whether the field has focus"
        case false?: return "focus moved off the field after Caret focused it"
        case true?: break
        }
        return appFocus == .elsewhereInWindow ? "focus is on another element of the window" : nil
    }
}
