import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// L1's renders: H11's and H14's page task states in v41's look, each with what a helper told `sourceExcerpts` sends
// (each row's source and the source's lines around its value, the fields left with a reason), and the crop shown for one
// row. Synthetic content only: the same people and values as H11's and H14's galleries, so each "after" stands beside
// its "before".
extension Gallery {
    struct L1Source {
        var source: RowSource
        var name: String
        var text: String
        var edited: Int64?
        var tab: SourceExcerpt.Tab?
    }

    /// Robin's note in Notes, last edited on Tuesday.
    static let l1Notes = L1Source(source: RowSource(kind: .window, name: "Notes"), name: "Robin's details",
                                  text: "Robin's details\nRobin Vale\nrobin@example.test\n+1 512 555 0142\n123 King St W, Toronto, Ontario M5V 2T6, Canada\nCan start 2026-10-20",
                                  edited: h14Edited, tab: nil)
    /// The LinkedIn tab Robin left for the form.
    static let l1Tab = L1Source(source: RowSource(kind: .tab, name: "Google Chrome"), name: "Robin Vale | LinkedIn",
                                text: "Robin Vale\nSoftware Engineer at Northwind Robotics\nJun 2023 to Aug 2026 · Full time\nToronto, Ontario, Canada",
                                edited: nil, tab: SourceExcerpt.Tab(title: "Robin Vale | LinkedIn", host: "www.linkedin.com"))
    /// Ines's note for H14's wizard.
    static let l1JobNote = L1Source(source: RowSource(kind: .window, name: "Notes"), name: "Job search",
                                    text: "Job search\nInes Vandermeer\nines.vandermeer@example.org\nApplying to field robotics roles this month.",
                                    edited: h14Edited, tab: nil)

    /// Each field's source and the words its value came from (a resolved date's source reads "Jun 2023").
    static let l1Spans: [String: (L1Source, String)] = [
        "Full name": (l1Notes, "Robin Vale"), "Email": (l1Notes, "robin@example.test"), "Phone": (l1Notes, "+1 512 555 0142"),
        "Country": (l1Notes, "Canada"), "City": (l1Notes, "Toronto"), "Start date": (l1Notes, "2026-10-20"),
        "Province": (l1Notes, "Ontario"), "Postal code": (l1Notes, "M5V 2T6"),
        "Employer": (l1Tab, "Northwind Robotics"), "Title": (l1Tab, "Software Engineer"), "From": (l1Tab, "Jun 2023"),
        "To": (l1Tab, "Aug 2026"), "Work type": (l1Tab, "Full time"),
    ]

    /// What the user told Caret: an entry's label and value.
    static let l1Memory: [String: String] = ["School": "University of Waterloo", "Degree": "BMath, Computer Science"]

    static let l1Gender = "'Gender' is yours to answer: Caret never answers questions about who you are."
    static let l1Referral = "'Who referred you?' is yours: Caret found nothing on screen or in memory for it."

    /// An excerpt of `s` around the first `span`; offsets in UTF-16 units, as the helper counts.
    static func l1Excerpt(_ s: L1Source, _ span: String) -> SourceExcerpt? {
        guard let r = s.text.range(of: span) else { return nil }
        let start = s.text.utf16.distance(from: s.text.utf16.startIndex, to: r.lowerBound.samePosition(in: s.text.utf16)!)
        return SourceExcerpt(text: s.text, start: start, end: start + span.utf16.count, name: s.name, edited: s.edited, tab: s.tab)
    }

    /// A preview as a helper told `sourceExcerpts` sends it.
    static func l1Enrich(_ p: GoalProgress.Preview) -> GoalProgress.Preview {
        var p = p
        guard var page = p.page else { return p }
        let ines = p.steps.contains { $0.says.contains("Ines") }
        page.rows = page.rows.map { r in
            var r = r
            if let value = l1Memory[r.label] {
                r.source = RowSource(kind: .memory, name: "")
                r.excerpt = SourceExcerpt(text: value, start: 0, end: value.utf16.count, name: r.label, edited: nil)
            } else if ines, let e = l1Excerpt(l1JobNote, r.value) {
                r.source = l1JobNote.source
                r.excerpt = e
            } else if let (source, span) = l1Spans[r.label] {
                r.source = source.source
                r.excerpt = l1Excerpt(source, span)
            }
            return r
        }
        if p.reason == .nextPage {
            p.warnings += [l1Gender, l1Referral]
            page.from = "Google Chrome, Robin Vale | LinkedIn"
        }
        var left: [LeftField] = []
        for w in p.warnings {
            let says = String(w.dropLast(w.hasSuffix(".") ? 1 : 0))
            if w == h11Withheld.first { left.append(LeftField(label: "Why do you want to work here?", why: .answer, says: says)) }
            if w == l1Gender { left.append(LeftField(label: "Gender", why: .identity, says: says)) }
            if w == l1Referral { left.append(LeftField(label: "Who referred you?", why: .notFound, says: says)) }
        }
        page.left = left.isEmpty ? nil : left
        p.page = page
        return p
    }

    static func l1Panels() -> [(String, PageTaskPanel)] {
        h11Panels(enrich: l1Enrich) + h14Panels(enrich: l1Enrich)
    }

    /// The row each state shows its crop for: the row a user would point at, the row being written while it runs, a
    /// blank's sentence where the panel has one. Nil: no crop (a stopped panel, the attach rows).
    static func l1Crop(_ name: String, _ panel: PageTaskPanel) -> Int? {
        func step(_ label: String) -> Int? { panel.sections.flatMap(\.lines).first { $0.label == label }?.key }
        let writing = panel.sections.last?.lines.first { $0.state == .writing }?.key
        switch name {
        case "page-task-preview": return step("Phone")
        case "page-task-progress", "page-task-progress-stoppable": return writing
        case "page-task-reveal": return step("Postal code")
        case "page-task-handoff": return step("Email")
        case "page-task-next-page": return step("From")
        case "page-task-done": return step("Email")
        case "page-task-partial": return step("Why do you want to work here?")
        case "page-task-attach-choose": return step("Full name")
        default: return nil
        }
    }

    static func l1View(_ panel: PageTaskPanel, crop: Int?, side: PageTaskLook.CropSide = .trailing, figure: PageTaskLook.Figure = PageTaskLook.figure,
                       character: FigureCharacter, motion: PageTaskLook.Motion = PageTaskLook.motion(.key, reduceMotion: false)) -> AnyView {
        AnyView(PageTaskGroupView(panel: panel, crop: crop, side: side, character: character, animated: false, figure: figure, now: memoryNow)
            .environment(\.lookMotion, motion)
            .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
            .environment(\.calendar, { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "America/Chicago")!; return c }())
            .environment(\.locale, Locale(identifier: "en_US")))
    }

    /// Every L1 render: the states (names as H11's and H14's, prefixed `l1-`), the figure options, the opaque panel, the
    /// crop's other two places, and a dotted blank's sentence.
    static func l1(_ character: FigureCharacter = .pebble) -> [Item] {
        let panels = l1Panels()
        var items = panels.map { name, panel in Item(name: "l1-\(name)", view: l1View(panel, crop: l1Crop(name, panel), character: character)) }
        let byName = Dictionary(uniqueKeysWithValues: panels)
        let preview = byName["page-task-preview"]!
        let phone = l1Crop("page-task-preview", preview)
        for f in PageTaskLook.Figure.allCases {
            items.append(Item(name: "l1-figure-\(f.rawValue)", view: l1View(preview, crop: phone, figure: f, character: character)))
        }
        items.append(Item(name: "l1-reduce-transparency", view: AnyView(l1View(preview, crop: phone, character: character).environment(\.lookReducesTransparency, true))))
        items.append(Item(name: "l1-crop-leading", view: l1View(preview, crop: phone, side: .leading, character: character)))
        items.append(Item(name: "l1-crop-overlay", view: l1View(preview, crop: phone, side: .overlay, character: character)))
        let next = byName["page-task-next-page"]!
        let referral = next.sections.flatMap(\.lines).first { $0.label == "Who referred you?" }?.key
        items.append(Item(name: "l1-next-page-notfound", view: l1View(next, crop: referral, character: character)))
        let gender = next.sections.flatMap(\.lines).first { $0.label == "Gender" }?.key
        items.append(Item(name: "l1-next-page-identity", view: l1View(next, crop: gender, character: character)))
        return items
    }
}
