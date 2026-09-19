import Foundation

enum SkillInstructions {
    /// Instructions from Settings (live editor) or the on-disk skill note in Application Support.
    @MainActor
    static func resolvedBody(actionID: String, model: Model?) -> String? {
        if let live = model?.resolvedSkillInstructions(actionID: actionID)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !live.isEmpty {
            return live
        }
        let note = NoteRepository().skillNote(for: actionID)
        let body = note?.body.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return body.isEmpty ? nil : body
    }
}
