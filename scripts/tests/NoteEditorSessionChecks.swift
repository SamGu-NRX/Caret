import Foundation

@main
struct NoteEditorSessionChecks {
    @MainActor
    static func main() async throws {
        let first = NoteEditorSnapshot(title: "First", icon: "doc.text", body: "First body", apps: [])
        let second = NoteEditorSnapshot(title: "Second", icon: "doc.text", body: "Second body", apps: [])
        let session = NoteEditorSession()
        var writes: [(NoteEditorTarget, NoteEditorSnapshot)] = []
        let writer: NoteEditorSession.Writer = { writes.append(($0, $1)) }

        precondition(session.load(.skill("a"), snapshot: first, using: writer))
        session.draft.body = "Edited first body"
        precondition(session.load(.skill("b"), snapshot: second, using: writer))
        precondition(writes.count == 1 && writes[0].0 == .skill("a"))
        precondition(writes[0].1.body == "Edited first body")
        precondition(session.target == .skill("b") && session.draft == second)

        session.draft.body = "Unsaved second body"
        precondition(session.load(.skill("b"), snapshot: second, using: writer))
        precondition(session.draft.body == "Unsaved second body")

        enum Failure: Error { case denied }
        let failingWriter: NoteEditorSession.Writer = { _, _ in throw Failure.denied }
        precondition(!session.load(.memory("a"), snapshot: first, using: failingWriter))
        precondition(session.target == .skill("b") && session.hasUnsavedChanges)
        precondition(session.draft.body == "Unsaved second body")
        guard case .failed = session.status else { fatalError("Failed write must remain visible") }
        precondition(session.save(using: writer))
        precondition(writes.last?.0 == .skill("b") && session.status == .saved)
        precondition(!session.hasUnsavedChanges)

        precondition(session.load(.memory("a"), snapshot: first, using: writer))
        session.draft.body = "Edited memory"
        precondition(session.load(.memory("b"), snapshot: second, using: writer))
        precondition(writes.last?.0 == .memory("a"))
        precondition(writes.last?.1.body == "Edited memory")
        session.draft.title = " "
        let count = writes.count
        precondition(!session.save(using: writer))
        precondition(writes.count == count && session.hasUnsavedChanges)
        session.draft.title = "A memory"
        precondition(session.save(using: writer))
        precondition(writes.last?.0 == .memory("b"))

        let retained = session.draft
        precondition(!session.delete(.memory("b"), using: { _ in false }))
        precondition(session.target == .memory("b") && session.draft == retained)
        precondition(session.delete(.skill("b"), using: { _ in true }))
        precondition(session.target == .memory("b"))
        session.draft.body = "Pending delete"
        session.scheduleSave(using: writer)
        let beforeDelete = writes.count
        precondition(session.delete(.memory("b"), using: { _ in true }))
        precondition(session.target == nil && !session.hasUnsavedChanges)
        precondition(session.save(using: writer))
        try await Task.sleep(nanoseconds: 600_000_000)
        precondition(writes.count == beforeDelete, "A pending save must not recreate a deleted note")
        precondition(session.load(.skill("a"), snapshot: first, using: writer))
        precondition(session.load(.skill("a"), snapshot: second, using: writer))
        precondition(session.draft == second, "Clean sessions must accept refreshed notes")
        session.draft.body = "A removed note's unsaved draft"
        precondition(!session.load(.skill("b"), snapshot: second, using: failingWriter))
        session.discard()
        precondition(session.load(.skill("b"), snapshot: second, using: writer))
        session.discard()
        let shell = NoteEditorSnapshot(title: "", icon: "sparkle", body: "", apps: [])
        precondition(session.load(.skill("new"), snapshot: shell, defaultTitle: "Untitled skill", using: writer))
        session.draft.body = "Instructions without a title"
        precondition(!session.save(using: failingWriter))
        precondition(session.draft.body == "Instructions without a title" && session.hasUnsavedChanges)
        precondition(session.save(using: writer))
        precondition(writes.last?.1.title == "Untitled skill")
        session.discard()
        let exclusions = NoteEditorSnapshot(title: "Tab completions", icon: "sparkle", body: "", apps: ["com.apple.Terminal"])
        precondition(session.load(.skill("tab-completions"), snapshot: exclusions, using: writer))
        session.draft.apps.append("com.apple.Safari")
        precondition(!session.load(.memory("next"), snapshot: first, using: failingWriter))
        precondition(session.draft.apps == ["com.apple.Terminal", "com.apple.Safari"])
        precondition(session.load(.memory("next"), snapshot: first, using: writer))
        precondition(writes.last?.0 == .skill("tab-completions"))
        precondition(writes.last?.1.apps == ["com.apple.Terminal", "com.apple.Safari"])
        print("Note editor checks passed: destination, refresh, failure, retry, validation, deletion")
    }
}
