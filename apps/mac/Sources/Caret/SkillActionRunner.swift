import AppKit
import ApplicationServices

enum GatewaySkillActions {
    static let ids: Set<String> = [
        "extract-tasks",
        "tone-polite",
        "revise",
        "summarize",
        "translate",
    ]

    static func contains(_ actionID: String) -> Bool {
        ids.contains(actionID)
    }

    static func previewLabel(for actionID: String) -> String {
        switch actionID {
        case "translate": return "Translation"
        case "summarize": return "Summary"
        case "extract-tasks": return "Tasks"
        case "tone-polite": return "Polite draft"
        case "revise": return "Revised draft"
        default: return "Preview"
        }
    }
}

struct SkillActionSnapshot: Equatable {
    let processID: pid_t
    let axRole: String?
    let axSubrole: String?
    let inputText: String
    let selectedText: String
}

@MainActor
final class SkillActionRunner {
    func run(action: CaretAction, skill: CaretSkill?, target: SelectionTarget?, model: Model?) {
        _ = skill
        guard GatewaySkillActions.contains(action.id) else {
            NSLog("[Caret] action=%@ is not wired to Vercel gateway yet", action.id)
            return
        }

        guard let resolved = resolveInput(target: target) else {
            NSLog("[Caret] action=%@ skipped: no selection or clipboard text", action.id)
            model?.failSkillPreview(
                actionID: action.id,
                message: "Select text in another app, or copy text to the clipboard."
            )
            return
        }

        let (input, snapshot) = resolved
        guard let instructions = model?.resolvedSkillInstructions(actionID: action.id)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !instructions.isEmpty
        else {
            model?.failSkillPreview(
                actionID: action.id,
                message: "Add Instructions for this skill in Caret Settings, then try again."
            )
            return
        }

        model?.beginSkillPreview(actionID: action.id)

        Task {
            await GatewayKeySync.syncFromGitHubIfNeeded(projectRoot: CaretPaths.projectRoot)
            do {
                let output = try await CaretCLI.runAction(
                    actionID: action.id,
                    text: input,
                    instructions: instructions
                )
                await MainActor.run {
                    model?.finishSkillPreview(actionID: action.id, output: output)
                }
                if let snapshot {
                    await self.applyOutput(output, snapshot: snapshot)
                }
            } catch {
                NSLog("[Caret] action=%@ failed: %@", action.id, String(describing: error))
                await MainActor.run {
                    model?.failSkillPreview(actionID: action.id, message: String(describing: error))
                }
            }
        }
    }

    private func resolveInput(target: SelectionTarget?) -> (String, SkillActionSnapshot?)? {
        if let target, let input = inputText(from: target) {
            let snapshot = SkillActionSnapshot(
                processID: target.focusedProcessID ?? 0,
                axRole: target.axRole,
                axSubrole: target.axSubrole,
                inputText: input,
                selectedText: target.selectedText
            )
            return (input, snapshot)
        }
        if let clip = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !clip.isEmpty {
            return (clip, nil)
        }
        return nil
    }

    private func inputText(from target: SelectionTarget) -> String? {
        let selected = target.selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !selected.isEmpty {
            return target.selectedText
        }
        if let full = target.fieldContext?.fullText.trimmingCharacters(in: .whitespacesAndNewlines),
           !full.isEmpty {
            return target.fieldContext?.fullText
        }
        return nil
    }

    private func applyOutput(_ output: String, snapshot: SkillActionSnapshot) async {
        guard snapshot.processID != 0 else { return }
        guard let app = NSRunningApplication(processIdentifier: snapshot.processID),
              app.processIdentifier == NSWorkspace.shared.frontmostApplication?.processIdentifier
        else {
            NSLog("[Caret] apply skipped: frontmost app changed")
            return
        }
        guard let element = AXHelpers.focusedTextElement(in: app) else {
            NSLog("[Caret] apply skipped: no focused text element")
            return
        }

        let role = AXHelpers.stringValue(element, kAXRoleAttribute as CFString)
        let subrole = AXHelpers.stringValue(element, kAXSubroleAttribute as CFString)
        guard role == snapshot.axRole, subrole == snapshot.axSubrole else {
            NSLog("[Caret] apply skipped: focus moved to a different field")
            return
        }

        let trimmedSelected = snapshot.selectedText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedSelected.isEmpty {
            if !AXHelpers.replaceSelectionIfMatches(
                element,
                expectedSelected: snapshot.selectedText,
                replacement: output
            ) {
                NSLog("[Caret] apply skipped: selection changed")
            }
            return
        }

        if let ctx = AXHelpers.makeFieldContext(from: element),
           ctx.fullText == snapshot.inputText {
            _ = AXHelpers.setFieldValue(element, output)
            return
        }

        if AXHelpers.insertAtCaret(element, text: output) {
            return
        }
        NSLog("[Caret] apply skipped: could not insert result")
    }
}
