import Foundation

/// Every string the writing features show or speak, in one file so the copy check
/// (`WritingCopyTests`) can read them all. Plain words, no dashes, no exclamation marks.
public enum WritingCopy {
    public static func kindName(_ kind: WritingCorrection.Kind) -> String {
        switch kind {
        case .spelling: return "Spelling"
        case .grammar: return "Grammar"
        case .punctuation: return "Spacing and punctuation"
        }
    }

    // MARK: Reasons

    public static let repeatedWord = "Repeated word"
    public static let twoSpaces = "Two spaces between words"
    public static let sentenceStart = "First word of a sentence"
    public static let notInDictionary = "Not in the dictionary"
    public static let grammar = "Grammar"

    public static let noSpaceAfterComma = "No space after the comma"

    public static func spaceBefore(_ mark: Character) -> String {
        "Space before the \(markName(mark))"
    }

    /// "“hour” starts with a vowel sound", the reason "a" became "an".
    public static func vowelSound(_ word: String) -> String { "“\(word)” starts with a vowel sound" }
    public static func consonantSound(_ word: String) -> String { "“\(word)” starts with a consonant sound" }

    static func markName(_ mark: Character) -> String {
        switch mark {
        case ",": return "comma"
        case ".": return "period"
        case ";": return "semicolon"
        case ":": return "colon"
        case "?": return "question mark"
        default: return "exclamation mark"
        }
    }

    // MARK: The offer

    /// The line's key hints: "Tab fix", "↓ more".
    public static let fixHint = "fix"
    public static let moreHint = "more"
    /// The hint on a line whose two answers disagree: Tab fixes nothing until one is picked.
    public static let chooseHint = "choose"

    /// "address or dress".
    public static func either(_ choices: [String]) -> String {
        choices.map(visible).joined(separator: " or ")
    }
    public static let original = "Original"
    public static let fixAll = "Fix all in this paragraph"

    /// What Tab does with the highlighted row, at the foot of the open list.
    public static func tabAction(_ kind: WritingOffer.Alternative.Kind) -> String {
        switch kind {
        case .fix: return "fix"
        case .original: return "keep original"
        case .fixAll: return "fix all"
        }
    }

    public static func fixCount(_ n: Int) -> String { n == 1 ? "1 fix" : "\(n) fixes" }

    /// The toast after Tab: "Fixed" in the accent, then what changed.
    public static let fixedLead = "Fixed"
    public static func fixed(original: String, replacement: String) -> String {
        "“\(visible(original))” to “\(visible(replacement))”"
    }

    public static func fixedAll(_ n: Int) -> String { "\(fixCount(n)) in this paragraph" }
    public static let undoHint = "Undo"

    /// Spaces made visible in a quoted fix, so "Two spaces" reads as something: "␣␣" to "␣".
    public static func visible(_ text: String) -> String {
        text.allSatisfy({ $0 == " " }) ? String(repeating: "␣", count: text.count) : text
    }

    // MARK: After Tab and ⌘Z

    /// Why Tab changed nothing, by the executor's refusal code. Short enough for one line.
    public static func notFixed(_ code: String) -> String {
        switch code {
        case "writeRefused", "writeIgnored": return "This app didn't take the fix, so nothing changed."
        case "composing": return "Caret doesn't fix text while an input method is on."
        case "revoked": return "Caret is paused, so nothing changed."
        default: return "The text changed, so nothing was fixed."
        }
    }

    public static let undoneLead = "Undone"
    public static let undoFailed = "The text changed after the fix, so it was left as it is."

    /// The line after ⌘Z took a fix back: what came back, as words.
    public static func undone(_ alternative: WritingOffer.Alternative) -> LineContent {
        let text: String
        switch alternative.kind {
        case .fixAll: text = fixedAll(alternative.diff.count)
        default:
            let change = alternative.diff.first
            text = "“\(visible(change?.original ?? ""))” is back"
        }
        return LineContent(figure: .done, lead: undoneLead, text: text, emphasis: .plain)
    }

    public static func error(_ text: String) -> LineContent {
        LineContent(figure: .error, text: text, emphasis: .plain)
    }

    // MARK: VoiceOver

    /// The line, spoken: what is wrong, the fix, and the keys.
    public static func spokenLine(reason: String, original: String, replacement: String) -> String {
        "\(reason). Replace \(spoken(original)) with \(spoken(replacement)). Tab fixes it, Down Arrow shows more."
    }

    /// Quoted text for VoiceOver, with runs of spaces said as words: "two spaces", not "open box".
    static func spoken(_ text: String) -> String {
        guard !text.isEmpty, text.allSatisfy({ $0 == " " }) else { return "“\(text)”" }
        switch text.count {
        case 1: return "one space"
        case 2: return "two spaces"
        default: return "\(text.count) spaces"
        }
    }

    /// A line whose answers disagree, spoken: what is wrong and both choices, with no Tab.
    public static func spokenChoice(reason: String, original: String, choices: [String]) -> String {
        "\(reason). Replace \(spoken(original)) with \(choices.map(spoken).joined(separator: " or ")). Down Arrow shows the choices."
    }

    public static func spokenAlternative(_ label: String, number: Int?, selected: Bool) -> String {
        let key = number.map { ", Command \($0)" } ?? ""
        return selected ? "\(label)\(key), selected" : "\(label)\(key)"
    }

    // MARK: Word finding

    public static let wordFindingUnavailable = "Word finding needs Caret's local model, which isn't running."
}
