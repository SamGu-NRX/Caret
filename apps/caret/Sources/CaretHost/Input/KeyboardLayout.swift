import Carbon.HIToolbox
import CaretHostCore

/// The physical keyboard, for keys named by position rather than character.
enum KeyboardLayout {
    /// The key code of the key above Tab: § on an ISO keyboard, ` on ANSI and JIS. Cotypist's keys
    /// take the whole suggestion with it (`GhostKeys.cotypist`).
    static func aboveTabKeyCode() -> Int64 {
        KBGetLayoutType(Int16(LMGetKbdType())) == PhysicalKeyboardLayoutType(kKeyboardISO)
            ? KeyStroke.isoSectionKeyCode
            : KeyStroke.graveKeyCode
    }
}
