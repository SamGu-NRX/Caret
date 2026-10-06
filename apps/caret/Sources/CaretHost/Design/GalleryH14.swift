import CaretHostCore
import CaretScreenCore
import SwiftUI

// H14's states: the page task panel's attach rows (a chooser, a saved file offered, a file confirmed, a page that only
// attaches, a file the helper refused, the run after Tab), the line offering to keep a file and its answer, the
// memory window's Files group, and the Sites tab's switches for inline text. Synthetic content only.

extension Gallery {
    /// Last edited on Tuesday, six days before `memoryNow` (a Monday).
    static let h14Edited: Int64 = 1_789_481_760_000
    static let h14Resume = AttachFile(path: "/Users/robin/Documents/Robin Vale Resume.pdf", name: "Robin Vale Resume.pdf", edited: h14Edited)

    /// The F1 wizard's page 3 as a preview: a name to fill, the résumé's file input and its dropzone.
    static func h14Preview(writes: Bool = true, saved: Bool = false) -> GoalProgress.Preview {
        var steps: [GoalProgress.Step] = []
        var rows: [GoalProgress.PageView.Row] = []
        if writes {
            steps.append(GoalProgress.Step(index: 0, kind: .write, says: "Full name: Ines Vandermeer"))
            rows.append(.init(step: 0, label: "Full name", value: "Ines Vandermeer", picked: false))
            steps.append(GoalProgress.Step(index: 1, kind: .write, says: "Email: ines.vandermeer@example.org"))
            rows.append(.init(step: 1, label: "Email", value: "ines.vandermeer@example.org", picked: false))
        }
        let file: GoalProgress.Step.File = saved
            ? .saved(savedId: "file-1a2b3c4d", path: h14Resume.path, name: h14Resume.name, edited: h14Edited) : .choose
        steps.append(GoalProgress.Step(index: 2, kind: .attach, says: saved ? "Resume: \(h14Resume.name)" : "Resume: a file you choose", file: file))
        steps.append(GoalProgress.Step(index: 3, kind: .attach, says: "Or drop your resume here: a file you choose", file: .choose))
        steps.append(GoalProgress.Step(index: 4, kind: .handoff, says: "You press Submit application"))
        let page = GoalProgress.PageView(windowId: "page:eng1:7", app: h11App, anchor: nil, viewport: nil, from: "Notes, Job search and Mail, Gareth Lowe",
                                         rows: rows, attach: [], files: [.init(step: 2, label: "Resume", accept: [".pdf", ".doc", ".docx"]),
                                                                         .init(step: 3, label: "Or drop your resume here", accept: [])])
        return GoalProgress.Preview(segment: 0, segments: 1, reason: .start, replaces: nil, digest: String(repeating: "b", count: 64), expires: h11Expires,
                                    place: .window(app: "Google Chrome", title: "Apply: Field Robotics Technician (step 3 of 3)"), steps: steps, warnings: [], page: page)
    }

    static func h14Task(writes: Bool = true, saved: Bool = false) -> PageTask {
        PageTask(preview: h14Preview(writes: writes, saved: saved), goalId: "goal-3-a1")!
    }

    static func h14Panels() -> [(String, PageTaskPanel)] {
        let chicago: Calendar = {
            var c = Calendar(identifier: .gregorian)
            c.timeZone = TimeZone(identifier: "America/Chicago")!
            return c
        }()
        func panel(_ t: PageTask) -> PageTaskPanel { PageTaskPanel(task: t, stoppable: false, now: memoryNow, calendar: chicago) }

        let choose = h14Task()
        let saved = h14Task(saved: true)
        var confirmed = h14Task(saved: true)
        confirmed.confirmSaved(step: 2)
        var only = h14Task(writes: false)
        _ = only.tab(nowMs: 1)
        var refused = h14Task()
        refused.confirm(step: 3, file: AttachFile(path: "/Users/robin/Desktop/resume-link.pdf", name: "resume-link.pdf", edited: h14Edited))
        _ = refused.tab(nowMs: 1)
        _ = refused.refused("goalAccept refused: Caret can't attach the file you chose (it is a link); nothing ran, so choose another and accept again")
        var running = confirmed
        _ = running.tab(nowMs: 1)
        _ = running.receive(h11Receipt("goal-3-a1", 0))
        _ = running.receive(h11Receipt("goal-3-a1", 1))
        return [
            ("page-task-attach-choose", panel(choose)), ("page-task-attach-saved", panel(saved)), ("page-task-attach-confirmed", panel(confirmed)),
            ("page-task-attach-only", panel(only)), ("page-task-attach-refused", panel(refused)), ("page-task-attach-running", panel(running)),
        ]
    }

    static let h14SaveOffer = FileSaveOffer(id: "file-offer-1", at: 1, expires: 2, goalId: "goal-3-a1", question: "Resume", site: "https://jobs.example.com/orbitline/apply",
                                            file: .init(name: h14Resume.name), replaces: nil, says: "Use \(h14Resume.name) for 'Resume' next time?")

    static let h14SavedFiles: [SavedFilesReply.File] = [
        .init(id: "file-1a2b3c4d", question: "Resume", site: "https://jobs.example.com/orbitline/apply", name: h14Resume.name, path: h14Resume.path,
              savedOn: 1_789_900_000_000, edited: h14Edited, status: .active),
        .init(id: "file-5e6f7a8b", question: "Cover letter", site: "https://careers.example.org/apply/88", name: "Robin Vale Cover Letter.pdf",
              path: "/Users/robin/Documents/Robin Vale Cover Letter.pdf", savedOn: 1_789_800_000_000, edited: 1_789_395_360_000, status: .active),
        .init(id: "file-9c0d1e2f", question: "Transcript", site: nil, name: "Transcript 2021.pdf", path: "/Users/robin/Downloads/Transcript 2021.pdf",
              savedOn: 1_789_700_000_000, edited: nil, status: .active),
    ]

    static func h14(_ character: FigureCharacter = .pebble) -> [Item] {
        func env(_ v: some View) -> AnyView {
            AnyView(v.environment(\.timeZone, TimeZone(identifier: "America/Chicago")!).environment(\.locale, Locale(identifier: "en_US")))
        }
        let panels = h14Panels().map { name, panel in Item(name: name, view: AnyView(PageTaskView(panel: panel, character: character, animated: false))) }
        var files = SavedFilesBook.State()
        files.loaded = true
        files.connected = true
        files.files = h14SavedFiles
        var confirming = files
        confirming.confirmingForget = "file-5e6f7a8b"
        func memory(_ f: SavedFilesBook.State, pointerOn row: String? = nil) -> AnyView {
            // The Files group comes last in the list: drawn as the window shows it scrolled to the end.
            env(MemoryView(state: memoryState(), files: memoryFiles(), savedFiles: f, tab: .memory, character: character, animated: false, now: memoryNow, revealedRow: row)
                .environment(\.offscreenScrolledToEnd, true))
        }
        func sites(web: Bool, rich: Bool) -> AnyView {
            var s = sitesState
            s.pageInlineText = web
            s.pageInlineContentEditable = rich
            return env(MemoryView(state: memoryState(), files: memoryFiles(), tab: .sites, character: character, sites: s, animated: false, now: memoryNow))
        }
        return panels + [
            Item(name: "file-save-offer", view: AnyView(LineView(content: FileSaveCopy.offered(h14SaveOffer), character: character, animated: false))),
            Item(name: "file-save-saved", view: AnyView(LineView(content: FileSaveCopy.replied(FileSaveReply(requestId: "fs1", outcome: .saved, fileId: "file-1a2b3c4d",
                                                                                                       says: "Caret will offer \(h14Resume.name) for 'Resume' next time.")),
                                                            character: character, animated: false))),
            Item(name: "memory-files", view: memory(files, pointerOn: "file-1a2b3c4d")),
            Item(name: "memory-files-forget", view: memory(confirming)),
            Item(name: "sites-switches", view: sites(web: true, rich: false)),
            Item(name: "sites-switches-web-off", view: sites(web: false, rich: true)),
        ]
    }
}
