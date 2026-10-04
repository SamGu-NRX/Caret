import CaretHostCore
import CaretScreenCore
import SwiftUI

// B19's skills as the host draws them (brief A15, part 2): the keep and promote questions under a
// run's toast, a skill's run with no Tab at the caret and on the perch, and skills in "What Caret
// knows". Synthetic content in the helper's shapes (helper/fixtures/golden/protocol.ndjson).
extension Gallery {
    static let skillName = "Order details into Tracker"
    static let skillTrigger = "a Tracker window opens with Order, Carrier and Tracking empty"

    /// A skill question in the helper's words. Decoded, since the wire type has no memberwise init.
    static func skillOffer(_ kind: SkillOffer.Kind, name: String = skillName) -> SkillOffer {
        let keep = kind == .keep
        let json = """
        {"type":"skillOffer","v":1,"id":"skill-offer-\(kind.rawValue)","at":1790000300000,"kind":"\(kind.rawValue)","taskId":"offer-5",\
        "routineId":"routine-1","skillId":\(keep ? "null" : "\"skill-1\""),"name":"\(name)",\
        "says":"\(keep ? "Keep this as \(name)?" : "Do this one on your own from now on?")",\
        "detail":"\(keep ? "Caret will offer it when you start it again." : "You'll see it happen and can undo it.")",\
        "actions":[{"id":"accept","label":"\(keep ? "Keep" : "Do it on its own")"},{"id":"decline","label":"\(keep ? "No thanks" : "Keep asking")"}]}
        """
        return try! JSONDecoder().decode(SkillOffer.self, from: Data(json.utf8))
    }

    static func skillLines(_ character: FigureCharacter = .pebble) -> [Item] {
        func line(_ name: String, _ content: LineContent) -> Item {
            Item(name: name, view: AnyView(LineView(content: content, character: character, animated: false)))
        }
        let done = Captions.done(app: "Tracker")
        func toast(_ question: LineContent.Question) -> LineContent {
            LineContent(figure: .done, lead: done.lead, text: done.rest, emphasis: .plain, hints: [Hint(key: "⌘Z", label: "Undo")], question: question)
        }
        return [
            line("skill-keep", toast(WorkLines.question(skillOffer(.keep)))),
            line("skill-promote", toast(WorkLines.question(skillOffer(.promote)))),
            // The longest a name runs (80 characters, memory.ts): the question wraps inside 520 pt.
            line("skill-keep-long", toast(WorkLines.question(skillOffer(.keep, name: "Customer, email and order number from the order queue into the Intake form")))),
            line("skill-kept", toast(WorkLines.answered(skillOffer(.keep)))),
            line("skill-on-its-own", WorkLines.onItsOwn(skillName, app: "Tracker").content),
            line("skill-on-its-own-done", WorkLines.doneOnItsOwn(skillName).content),
            line("skill-took-over", WorkLines.tookOver(next: 1, of: 3).content),
            Item(name: "skill-running-scene", view: AnyView(SkillRunScene(character: character))),
        ]
    }

    /// Skills as the helper lists them, in each state the list names, beside the base entries'
    /// permissions so the permissions page has its rows. `wrote` is where the skill on its own wrote,
    /// and `elsewhere` the rule for Undoable changes in other apps.
    static func skillEntries(wrote: Set<HelperMemory.ActionType> = [.writeHere], elsewhere: HelperMemory.Rule = .ask) -> [HelperMemory.Entry] {
        func skill(_ id: String, _ name: String, onItsOwn: Bool, clean: Int, runs: Int, handsOff: String = "null", status: HelperMemory.Status) -> HelperMemory.Entry {
            // `wrote` is required since B23, in the fields and on the entry alike, as the decoder
            // reads it; the gallery's skills on Tab wrote nothing that counts yet.
            let rules = onItsOwn ? wrote : []
            let list = "[" + rules.map { "\"\($0.rawValue)\"" }.sorted().joined(separator: ",") + "]"
            let json = #"{"routineId":"r-\#(id)","name":"\#(name)","trigger":"\#(skillTrigger)","runs":\#(runs),"cleanRuns":\#(clean),"needed":10,"onItsOwn":\#(onItsOwn),"handsOff":\#(handsOff),"wrote":\#(list)}"#
            let fields = try! JSONDecoder().decode(SkillFields.self, from: Data(json.utf8))
            return .init(id: id, status: status, says: name, evidence: .init(count: runs, lastSeen: 1_790_000_100_000, app: "Tracker"), fields: .skill(fields),
                         wrote: rules)
        }
        let skills: [HelperMemory.Entry] = [
            skill("skill-1", skillName, onItsOwn: true, clean: 11, runs: 11, status: .active),
            skill("skill-2", "Shipping address into Orders", onItsOwn: false, clean: 4, runs: 4, status: .learning),
            skill("skill-3", "Reply to the carrier in Mail", onItsOwn: false, clean: 6, runs: 6, handsOff: #"{"label":"Send","why":"outbound"}"#, status: .learning),
            .init(id: "noticed-1", status: .active, says: "You archive receipts from Mail on Fridays", evidence: .init(count: 3, lastSeen: 1_790_000_000_000, app: "Mail"),
                  fields: .unrecognized(kind: "habit")),
        ]
        let permissions = memoryEntries().filter { $0.kind == .permission }.map { e -> HelperMemory.Entry in
            guard var p = e.permission, p.action == .writeElsewhere else { return e }
            var e = e
            p.rule = elsewhere
            e.fields = .permission(p)
            return e
        }
        return skills + permissions
    }

    static func skillMemory(_ character: FigureCharacter = .pebble) -> [Item] {
        func window(_ state: MemoryBook.State, _ tab: MemoryView.Tab = .memory, pointerOn row: String? = nil) -> AnyView {
            AnyView(MemoryView(state: state, tab: tab, character: character, animated: false, now: memoryNow, revealedRow: row)
                .environment(\.timeZone, TimeZone(identifier: "America/Chicago")!)
                .environment(\.locale, Locale(identifier: "en_US")))
        }
        let refused = { (book: MemoryBook) in
            book.backOnTab("skill-1")
            // Today's helper refuses the edit (HelperMemory's header); the row says what still works.
            book.receive(HelperMemory.Reply(requestId: "host-memory-2", error: "invalid edit: unrecognized key onItsOwn", entries: []))
        }
        return [
            Item(name: "memory-skills", view: window(memoryState(entries: skillEntries()))),
            Item(name: "memory-skills-hover", view: window(memoryState(entries: skillEntries()), pointerOn: "skill-1")),
            Item(name: "memory-skills-refused", view: window(memoryState(refused, entries: skillEntries()))),
            // Today's helper does not say where a skill wrote: it is listed where it may run now.
            Item(name: "memory-permissions-exceptions", view: window(memoryState(entries: skillEntries()), .permissions)),
            Item(name: "memory-permissions-approved", view: window(memoryState(entries: skillEntries(wrote: [.writeElsewhere], elsewhere: .actIfApproved)), .permissions)),
            // Let run on its own in other apps, then the rule turned down to Ask first.
            Item(name: "memory-permissions-held-back", view: window(memoryState(entries: skillEntries(wrote: [.writeHere, .writeElsewhere])), .permissions)),
            // A kind this host cannot name, alone, so its section is in view.
            Item(name: "memory-noticed", view: window(memoryState(entries: skillEntries().filter { $0.kind != .skill }), pointerOn: "noticed-1")),
        ]
    }
}

/// A skill's run with no Tab, as the user sees it: the Tracker window it fills, its line under the
/// focused field, and the rim and the perch on that window, eyes down at it. No caption at the
/// window's corner: it is the window in front, and the line at the caret says it. Off screen only.
struct SkillRunScene: View {
    var character: FigureCharacter = .pebble
    @Environment(\.colorScheme) private var scheme

    static let size = CGSize(width: 620, height: 300)

    var body: some View {
        let dark = scheme == .dark
        let visible = CGRect(origin: .zero, size: Self.size)
        let window = CGRect(x: 40, y: 40, width: 500, height: 230)
        let layout = Rim.layout(window: window, perchHeight: PerchModel.figureHeight, visible: visible)
        let model = PerchModel()
        model.presented = true
        model.animated = false
        model.mood = .working
        model.character = character
        let rim = RimModel()
        rim.shown = true
        rim.animated = false
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x26282C : 0xD9DCE1)))
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(Color(token: Tokens.ink2).opacity(0.35)).frame(width: 7, height: 7) }
                    Text("Tracker").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(token: Tokens.ink2)).padding(.leading, 6)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .frame(height: 22)
                Rectangle().fill(Color(token: Tokens.border)).frame(height: 1)
                VStack(alignment: .leading, spacing: 10) {
                    field("Order", "ORD-2026-48213", focused: false)
                    field("Carrier", "", focused: true)
                    LineView(content: WorkLines.onItsOwn(Gallery.skillName, app: "Tracker").content, character: character, animated: false)
                        .padding(.leading, 70)
                    field("Tracking", "", focused: false)
                }
                .padding(14)
                Spacer(minLength: 0)
            }
            .frame(width: window.width, height: window.height)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: Tokens.srgb(dark ? 0x2E2F33 : 0xFBFBFC))))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(token: Tokens.border), lineWidth: 1))
            .offset(x: window.minX, y: window.minY)
            RimView(model: rim, radius: 8)
                .frame(width: layout.ring.width, height: layout.ring.height)
                .offset(x: layout.ring.minX, y: layout.ring.minY)
            PerchView(model: model)
                .offset(x: layout.perch.midX - PerchModel.size.width / 2, y: layout.perch.maxY - PerchModel.size.height)
        }
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func field(_ label: String, _ value: String, focused: Bool) -> some View {
        HStack(spacing: 10) {
            Text(label).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink2)).frame(width: 60, alignment: .trailing)
            Text(value).font(.system(size: 12)).foregroundStyle(Color(token: Tokens.ink))
                .frame(width: 230, height: 22, alignment: .leading).padding(.leading, 6)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color(nsColor: Tokens.srgb(scheme == .dark ? 0x1E1F22 : 0xFFFFFF))))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(focused ? Color(token: Tokens.carrot) : Color(token: Tokens.border), lineWidth: focused ? 2 : 1))
        }
    }
}
