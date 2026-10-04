import CaretScreenCore
import Foundation

/// What VoiceOver hears for a slip or a pop-up (v3 DIRECTION.md section 7). A slip never takes
/// focus, so it is announced: on entrance and again on each change of state. The words are the
/// caption and what the visible keys do. The working line's seconds are left out, so it is
/// announced once when work starts and once more when Esc Stop joins it, not every second.
public enum SlipSpeech {
    /// The accessibility label: the caption, with the lead word.
    public static func label(_ line: LineContent) -> String {
        caption(line)
    }

    /// The accessibility value: what the keys do ("Tab adds it to Calendar"), the question's keys
    /// included, or nil with no keys.
    public static func value(_ line: LineContent) -> String? {
        let phrases = line.hints.map { phrase($0, line: line) } + (line.question?.hints.map { phrase($0, line: nil) } ?? [])
        return phrases.isEmpty ? nil : sentences(phrases)
    }

    /// One announcement for the line: caption, keys, then the question under it and its keys.
    public static func line(_ line: LineContent) -> String {
        var parts = [caption(line)] + line.hints.map { phrase($0, line: line) }
        if let q = line.question {
            parts.append(q.text)
            if let detail = q.detail { parts.append(detail) }
            parts += q.hints.map { phrase($0, line: nil) }
        }
        return sentences(parts)
    }

    /// A pop-up, everything it shows in reading order: the title, each fact, the source, each
    /// field's destination, value and state, the highlighted choice, a change, the steps, and what
    /// its keys do. The pop-up is one element with these words, so nothing on it is out of reach
    /// of VoiceOver before Tab acts on it.
    public static func popup(_ spec: PopupSpec, highlight: Int?) -> String {
        var parts: [String] = []
        for block in spec.blocks {
            switch block.content {
            case .header(let header): parts.append(header.title.text)
            case .facts(let facts):
                parts += facts.rows.map { row in [row.label, row.value.text].compactMap { $0 }.joined(separator: ": ") }
            case .source(let source): parts.append("From \(source.value.text)")
            case .fields(let fields):
                parts += fields.rows.map { row in
                    let value = row.value?.text ?? "kept as it is"
                    let note: String?
                    switch row.state {
                    case .ready, .kept: note = nil
                    case .unsure: note = "unsure"
                    case .done: note = "filled"
                    case .failed: note = "not filled"
                    }
                    return ["\(row.destination.text): \(value)", note].compactMap { $0 }.joined(separator: ", ")
                }
                if fields.more > 0 { parts.append("And \(fields.more) more") }
            case .choices(let choices):
                if let chosen = choice(choices, highlight: highlight) { parts.append(chosen) }
            case .diff(let diff):
                parts.append([diff.label.map { "\($0):" }, "\(diff.before.text) becomes \(diff.after.text)"].compactMap { $0 }.joined(separator: " "))
            case .steps(let steps):
                parts += steps.rows.map { row in
                    switch row.state {
                    case .pending: return row.label
                    case .running: return "\(row.label), now"
                    case .done: return "\(row.label), done"
                    case .failed: return "\(row.label), failed"
                    }
                }
            case .actions(let actions):
                parts += actions.items.map { "\(spokenKey(Hint.key($0.key))): \($0.label)" }
                parts.append("Escape closes it")
            }
        }
        return sentences(parts)
    }

    /// What ↑ or ↓ changed on a pop-up already announced: only the newly highlighted choice.
    public static func popupHighlight(_ spec: PopupSpec, highlight: Int?) -> String? {
        guard let choices = spec.choices, let chosen = choice(choices, highlight: highlight) else { return nil }
        return sentences([chosen])
    }

    static func choice(_ choices: PopupSpec.Choices, highlight: Int?) -> String? {
        let index = highlight ?? choices.selected
        guard choices.rows.indices.contains(index) else { return nil }
        let row = choices.rows[index]
        return [row.label.text, row.hint?.text].compactMap { $0 }.joined(separator: ", ") + ", highlighted"
    }

    /// The words to post now, or nil when they are what was last said for this panel.
    public static func announcement(next: String, last: String?) -> String? {
        next == last ? nil : next
    }

    // MARK: -

    public static func caption(_ line: LineContent) -> String {
        let text = withoutSeconds(line.text)
        return [line.lead, text].compactMap { $0 }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// "Adding to Calendar, 4 s" is "Adding to Calendar": the count is on screen, not in speech.
    public static func withoutSeconds(_ text: String) -> String {
        guard let range = text.range(of: #", \d+ s$"#, options: .regularExpression) else { return text }
        return String(text[..<range.lowerBound])
    }

    static func phrase(_ hint: Hint, line: LineContent?) -> String {
        let key = spokenKey(hint.key)
        switch hint.label {
        case nil:
            if hint.key == "Tab", let app = line?.app, line?.lead == nil { return "Tab adds it to \(app)" }
            return "\(key) takes it"
        case "Stop": return "\(key) stops it"
        case "Undo": return "\(key) undoes it"
        case "Take over": return "\(key) takes over"
        case let label?: return "\(key): \(label)"
        }
    }

    public static func spokenKey(_ key: String) -> String {
        switch key {
        case "Esc": return "Escape"
        case "↓": return "Down arrow"
        case "↑": return "Up arrow"
        default:
            if key.hasPrefix("⌘") { return "Command " + key.dropFirst() }
            return key
        }
    }

    /// Each part a sentence, ended once.
    public static func sentences(_ parts: [String]) -> String {
        parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { [".", "?", "!", "\u{2026}"].contains($0.last.map(String.init) ?? "") ? $0 : $0 + "." }
            .joined(separator: " ")
    }
}
