import Foundation

enum SkillInstructions {
    /// System prompt from the on-disk skill note (`notes/skills/<action>.md` in Application Support).
    static func skillFileBody(actionID: String) -> String? {
        let body = NoteRepository().skillNote(for: actionID)?
            .body
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return body.isEmpty ? nil : body
    }
}
