// B21: which keys press a button. One right answer per case, so each is pinned here on its own.
import CaretScreenCore
import Testing

@Suite struct KeyPressesTests {
    let shift: UInt64 = 0x0002_0000, control: UInt64 = 0x0004_0000, option: UInt64 = 0x0008_0000, command: UInt64 = 0x0010_0000
    let capsLock: UInt64 = 0x0001_0000, keypad: UInt64 = 0x0020_0000, fn: UInt64 = 0x0080_0000

    @Test func readsOnlyReturnEnterAndSpaceHeldAlone() {
        #expect(KeyPresses.via(keyCode: 36, flags: 0, autorepeat: false) == .return)
        #expect(KeyPresses.via(keyCode: 76, flags: keypad, autorepeat: false) == .enter)
        #expect(KeyPresses.via(keyCode: 49, flags: 0, autorepeat: false) == .space)
        // A laptop's Enter is Fn-Return; Caps Lock changes nothing.
        #expect(KeyPresses.via(keyCode: 36, flags: fn | capsLock, autorepeat: false) == .return)
        for m in [shift, control, option, command] {
            #expect(KeyPresses.via(keyCode: 36, flags: m, autorepeat: false) == nil)
            #expect(KeyPresses.via(keyCode: 49, flags: m, autorepeat: false) == nil)
        }
        #expect(KeyPresses.via(keyCode: 36, flags: 0, autorepeat: true) == nil)
        // Letters, Tab, Escape and the arrows are never reported.
        for code in [0, 1, 48, 53, 123, 124, 125, 126] { #expect(KeyPresses.via(keyCode: code, flags: 0, autorepeat: false) == nil) }
    }

    @Test func returnAndEnterPressTheEnabledDefaultButton() {
        for via in [UserPress.Via.return, .enter] {
            #expect(KeyPresses.target(via, focusedRole: nil, enabledDefaultButton: true) == .defaultButton)
            #expect(KeyPresses.target(via, focusedRole: "AXWindow", enabledDefaultButton: true) == .defaultButton)
            #expect(KeyPresses.target(via, focusedRole: "AXButton", enabledDefaultButton: true) == .defaultButton)
            #expect(KeyPresses.target(via, focusedRole: "AXList", enabledDefaultButton: true) == .defaultButton)
            // No default button, or a disabled one: Return presses nothing, even with a button focused.
            #expect(KeyPresses.target(via, focusedRole: "AXButton", enabledDefaultButton: false) == nil)
            #expect(KeyPresses.target(via, focusedRole: nil, enabledDefaultButton: false) == nil)
        }
    }

    @Test func aReturnTypedIntoATextFieldIsNeverAPress() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
            for via in [UserPress.Via.return, .enter, .space] {
                #expect(KeyPresses.target(via, focusedRole: role, enabledDefaultButton: true) == nil, "\(via) in \(role)")
            }
        }
    }

    @Test func spacePressesTheFocusedButtonOnly() {
        for role in ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton"] {
            #expect(KeyPresses.target(.space, focusedRole: role, enabledDefaultButton: false) == .focused)
        }
        // A link, a list, the window itself or no focus: Space scrolls or does nothing, and the default button is not its.
        for role in ["AXLink", "AXList", "AXWindow", "AXWebArea"] {
            #expect(KeyPresses.target(.space, focusedRole: role, enabledDefaultButton: true) == nil)
        }
        #expect(KeyPresses.target(.space, focusedRole: nil, enabledDefaultButton: true) == nil)
        #expect(KeyPresses.target(.click, focusedRole: "AXButton", enabledDefaultButton: true) == nil)
    }
}
