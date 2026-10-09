import Foundation

/// What Caret is showing for one app, reduced to what decides key ownership.
///
/// `KeyOwnership.owns` is the table at the end of `SURFACES.md` (section 8), written as code. The
/// arbiter computes the surface from the current offer and its navigation state, and decides each
/// key from the surface and the key alone, with no Accessibility call.
public enum Surface: Equatable, Sendable {
    case nothing
    /// Ghost text, alternatives closed. `candidates` counts the top one.
    case ghost(candidates: Int)
    /// Alternatives open: the ghost shows candidate `index` of `count`.
    case alternatives(count: Int)
    /// One action in another app. `numbered` lists the Command-digits with a visible action.
    case actionLine(numbered: Set<Int>, hasVariants: Bool)
    /// H11: a line with no Tab action, only Command-digits (the offer to save an answer the user typed).
    /// Tab stays the app's, so moving between a form's fields never takes it; `numbered` lists its digits.
    case quietLine(numbered: Set<Int>)
    /// `rows` counts choice rows; `numbered` the Command-digits with a visible action; `hasDown`
    /// says an action is bound to the down arrow ("↓ Review one by one").
    case popup(rows: Int, numbered: Set<Int>, hasDown: Bool)
    case ghostFill(fillAll: Bool)
    /// Work running after Tab. `stoppable` once it has run 3 s.
    case working(stoppable: Bool)
    case toast
    case errorLine
    /// A writing correction's line under the error. `tabFixes` is `WritingOffer.ownsTab`: false
    /// for a correction that needs a choice, whose Tab stays the app's.
    case writingLine(tabFixes: Bool)
    /// A writing correction's alternatives, open, with `rows` rows.
    case writingList(rows: Int)
}

/// Which keys take ghost text, a setting with two presets (brief item 6). Only ghost text and its
/// alternatives read it; fills, action lines, pop-ups and writing fixes keep their keys in both.
public enum GhostKeys: String, Codable, CaseIterable, Sendable {
    /// Tab takes the whole suggestion and ⌥→ the next word (brief A18, bug 17).
    case caret
    /// Cotypist's, which Sam's hands know: Tab takes the next word, the key above Tab the whole
    /// suggestion, and ⌥Tab types a real Tab. ⌥→ stays the app's word motion.
    case cotypist
}

/// A key-down reduced to the classes the ownership table talks about.
public enum KeyClass: Equatable, Sendable, CustomStringConvertible {
    case tab, shiftTab, up, down, left, right, escape, returnKey, delete, space
    /// ⌥→ with no other modifier: takes the next word of the ghost text (brief A18, bug 17).
    case optionRight
    /// ⌥Tab with no other modifier: under Cotypist's keys, a real Tab while ghost text shows.
    case optionTab
    /// The key above Tab with no modifier (` on ANSI, § on ISO): under Cotypist's keys, the whole
    /// suggestion. Elsewhere it types, as `typing` does.
    case aboveTab
    case commandDigit(Int)
    case commandZ
    /// Text-producing keys: letters, digits, punctuation.
    case typing
    /// Anything else with a modifier (⌘C, ⌃A) or without text (F-keys, Home).
    case other

    public var description: String {
        switch self {
        case .tab: return "tab"
        case .shiftTab: return "shift-tab"
        case .up: return "up"
        case .down: return "down"
        case .left: return "left"
        case .right: return "right"
        case .escape: return "esc"
        case .returnKey: return "return"
        case .delete: return "delete"
        case .space: return "space"
        case .optionRight: return "opt-right"
        case .optionTab: return "opt-tab"
        case .aboveTab: return "above-tab"
        case .commandDigit(let n): return "cmd-\(n)"
        case .commandZ: return "cmd-z"
        case .typing: return "typing"
        case .other: return "other"
        }
    }

    /// `aboveTab` is the key code of the key above Tab on this Mac's keyboard (`KeyStroke.graveKeyCode`
    /// on ANSI, `KeyStroke.isoSectionKeyCode` on ISO).
    public init(_ key: KeyStroke, aboveTab: Int64 = KeyStroke.graveKeyCode) {
        let plain = !key.command && !key.control && !key.option
        switch key.keyCode {
        case KeyStroke.tabKeyCode where plain:
            self = key.shift ? .shiftTab : .tab
        case KeyStroke.tabKeyCode where key.option && !key.command && !key.control && !key.shift:
            self = .optionTab
        case aboveTab where plain && !key.shift:
            self = .aboveTab
        case KeyStroke.escapeKeyCode where plain && !key.shift: self = .escape
        case KeyStroke.downKeyCode where plain && !key.shift: self = .down
        case KeyStroke.upKeyCode where plain && !key.shift: self = .up
        case KeyStroke.leftKeyCode: self = .left
        case KeyStroke.rightKeyCode where key.option && !key.command && !key.control && !key.shift: self = .optionRight
        case KeyStroke.rightKeyCode: self = .right
        case KeyStroke.returnKeyCode: self = .returnKey
        case KeyStroke.deleteKeyCode: self = .delete
        default:
            if let digit = key.commandDigit { self = .commandDigit(digit) }
            else if key.isUndo { self = .commandZ }
            else if key.keyCode == KeyStroke.spaceKeyCode, plain { self = .space }
            else if let text = key.text, !text.isEmpty, !key.command, !key.control { self = .typing }
            else { self = .other }
        }
    }
}

public enum KeyOwnership {
    /// True when `key` belongs to Caret while `surface` is visible. Every other key passes to the
    /// app, and a key that passes dismisses what Caret was showing.
    ///
    /// Two refinements of the table, both from `SURFACES.md` section 4: Command-1 to 3 are owned
    /// only for a numbered action or row that is visible, and the arrows only where they move
    /// something. A consumed key that does nothing visible would break the host's own shortcut
    /// (Command-1 switches browser tabs) for no gain.
    ///
    /// Ghost text: Tab takes the whole phrase and ⌥→ the next word, so "Tab Tab Tab" walks through
    /// short phrases as in Cursor (brief A18, bug 17). ⌥→ moves the caret a word in every Mac text
    /// view, which is the same motion the word takes. Shift+Tab used to take a word and is the
    /// host's again: in a form it moves focus back, and a second word key was one too many.
    ///
    /// Under Cotypist's keys (`GhostKeys.cotypist`) ghost text owns Tab (the next word), the key
    /// above Tab (the whole suggestion) and ⌥Tab (a real Tab), and leaves ⌥→ to the app.
    public static func owns(_ surface: Surface, _ key: KeyClass, keys: GhostKeys = .caret) -> Bool {
        switch surface {
        case .nothing:
            return false
        case .ghost(let candidates):
            switch (key, keys) {
            case (.tab, _), (.escape, _): return true
            case (.optionRight, .caret): return true
            case (.aboveTab, .cotypist), (.optionTab, .cotypist): return true
            case (.down, _): return candidates >= 2
            default: return false
            }
        case .alternatives(let count):
            switch (key, keys) {
            case (.tab, _), (.up, _), (.down, _), (.escape, _): return true
            case (.optionRight, .caret): return true
            case (.aboveTab, .cotypist), (.optionTab, .cotypist): return true
            case (.commandDigit(let n), _): return n <= count
            default: return false
            }
        case .actionLine(let numbered, let hasVariants):
            switch key {
            case .tab, .escape: return true
            case .commandDigit(let n): return numbered.contains(n)
            case .down: return hasVariants
            default: return false
            }
        case .popup(let rows, let numbered, let hasDown):
            switch key {
            case .tab, .escape: return true
            case .commandDigit(let n): return n <= rows || numbered.contains(n)
            case .down: return rows > 0 || hasDown
            case .up: return rows > 0
            default: return false
            }
        case .ghostFill(let fillAll):
            switch key {
            case .tab, .escape: return true
            case .commandDigit(1): return fillAll
            default: return false
            }
        case .working(let stoppable):
            return stoppable && key == .escape
        case .toast:
            return key == .commandZ || key == .escape
        case .errorLine:
            return key == .escape
        case .quietLine(let numbered):
            switch key {
            case .escape: return true
            case .commandDigit(let n): return numbered.contains(n)
            default: return false
            }
        case .writingLine(let tabFixes):
            // ⌥→ stays the app's: it moves the caret a word, and a fix has no next word to take.
            switch key {
            case .tab: return tabFixes
            case .down, .escape: return true
            default: return false
            }
        case .writingList(let rows):
            switch key {
            case .tab, .up, .down, .escape: return true
            case .commandDigit(let n): return n <= min(rows, WritingOffer.numberedRows)
            default: return false
            }
        }
    }
}
