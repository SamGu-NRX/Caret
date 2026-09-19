import Combine
import Foundation

enum NoteEditorTarget: Equatable {
    case skill(String)
    case memory(String)
}

struct NoteEditorSnapshot: Equatable {
    var title: String
    var icon: String
    var body: String
    var apps: [String]
}

enum NoteEditorWriteError: Error {
    case noteUnavailable
    case saveFailed
}

enum NoteSaveStatus: Equatable {
    case idle
    case saving
    case saved
    case failed(String)
}

/// The draft owns its destination, even after the sidebar selection changes.
@MainActor
final class NoteEditorSession: ObservableObject {
    @Published var draft = NoteEditorSnapshot(title: "", icon: "doc.text", body: "", apps: [])
    @Published private(set) var target: NoteEditorTarget?
    @Published private(set) var status: NoteSaveStatus = .idle
    private var baseline: NoteEditorSnapshot?
    private var pendingSave: Task<Void, Never>?

    typealias Writer = @MainActor (NoteEditorTarget, NoteEditorSnapshot) throws -> Void

    var hasUnsavedChanges: Bool {
        guard let baseline else { return false }
        return draft != baseline
    }

    @discardableResult
    func load(_ next: NoteEditorTarget, snapshot: NoteEditorSnapshot, using write: Writer) -> Bool {
        // A view refresh must not replace a draft, including one whose save failed.
        guard next != target else {
            if !hasUnsavedChanges {
                draft = snapshot
                baseline = snapshot
            }
            return true
        }
        guard save(using: write) else { return false }
        target = next
        draft = snapshot
        baseline = snapshot
        status = .idle
        return true
    }

    func scheduleSave(using write: @escaping Writer) {
        pendingSave?.cancel()
        pendingSave = nil
        guard hasUnsavedChanges else {
            status = .idle
            return
        }
        status = .saving
        pendingSave = Task { [weak self] in
            // Preserve the existing editor's 450 ms debounce.
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            self?.save(using: write)
        }
    }

    @discardableResult
    func save(using write: Writer) -> Bool {
        pendingSave?.cancel()
        pendingSave = nil
        guard hasUnsavedChanges, let target else { return true }
        guard !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status = .failed("Add a title before saving. Your changes are still here.")
            return false
        }
        do {
            try write(target, draft)
            baseline = draft
            status = .saved
            return true
        } catch NoteEditorWriteError.noteUnavailable {
            status = .failed("This note is no longer available. Copy your draft before discarding changes to continue.")
            return false
        } catch {
            status = .failed("Couldn't save this note. Your changes are still here. Check storage access and try again.")
            return false
        }
    }

    @discardableResult
    func delete(_ deleted: NoteEditorTarget, using remove: (NoteEditorTarget) -> Bool) -> Bool {
        guard remove(deleted) else { return false }
        if target == deleted { discard() }
        return true
    }

    func discard() {
        pendingSave?.cancel()
        pendingSave = nil
        target = nil
        baseline = nil
        draft = NoteEditorSnapshot(title: "", icon: "doc.text", body: "", apps: [])
        status = .idle
    }
}
