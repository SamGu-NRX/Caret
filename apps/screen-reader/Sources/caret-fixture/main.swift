// caret-fixture: synthetic AppKit windows for caret-screen's tests and experiments.
// Every name, number and address here is invented. The app never activates itself, so it does
// not take focus from whoever is using the Mac; its windows open behind other windows.
//
//   caret-fixture [--windows reference,claim,schedule] [--gold FILE] [--duration S]
//                 [--e1 FILE --cycles N --period S] [--webkit URL]
//                 [--activity FILE] [--focus-forms [--visit reference,distractors]]
//   --windows executor adds the executor window, driven by lines on stdin:
//     reset | seed FIELD VALUE | remove FIELD | sheet | dump
//   --background-only makes the app impossible to activate (no key windows, so no focus-driven modes).
//   --windows roster,seating adds a list of eight names and a six-seat chart for the loop recognizer;
//   the seating window takes stdin lines reset | dump. Only one stdin-driven window may be open.
//   Each command answers one JSON line on stdout.
import AppKit
import WebKit

setvbuf(stdout, nil, _IOLBF, 0)

func die(_ m: String) -> Never {
    FileHandle.standardError.write(Data("caret-fixture: \(m)\n".utf8))
    exit(2)
}

var argv = Array(CommandLine.arguments.dropFirst())
func opt(_ n: String) -> String? {
    guard let i = argv.firstIndex(of: n) else { return nil }
    guard i + 1 < argv.count else { die("\(n) needs a value") }
    defer { argv.removeSubrange(i...(i + 1)) }
    return argv[i + 1]
}
func has(_ n: String) -> Bool {
    guard let i = argv.firstIndex(of: n) else { return false }
    argv.remove(at: i)
    return true
}

let windowList = (opt("--windows") ?? "reference,claim,schedule").split(separator: ",").map(String.init)
let goldPath = opt("--gold")
let duration = TimeInterval(opt("--duration") ?? "3600") ?? 3600
let e1Path = opt("--e1")
let cycles = Int(opt("--cycles") ?? "40") ?? 40
let period = TimeInterval(opt("--period") ?? "1.2") ?? 1.2
let webkitURL = opt("--webkit")
let activityPath = opt("--activity")
let focusForms = has("--focus-forms")
/// Background-only: AppKit never activates the app, so it cannot take the foreground even for a moment.
/// Its windows can never be key, so focus-driven modes (--focus-forms, --activity, --e1) need the default.
let backgroundOnly = has("--background-only")
/// Windows made key, in this order, before each form is focused: the user looks something up, then goes to the form.
let visitList = (opt("--visit") ?? "").split(separator: ",").map(String.init)
if !argv.isEmpty { die("unknown arguments: \(argv.joined(separator: " "))") }

func ms() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

/// Appends one JSON object per line to a log file.
final class LineLog {
    let h: FileHandle
    init(_ path: String) {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: path) else { fatalError("cannot write \(path)") }
        self.h = h
    }
    func write(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        h.write(d + Data([0x0A]))
    }
}

// MARK: - data

struct Field {
    let label: String
    /// "left" puts the label on the same row, "above" over the field, "placeholder" uses no label at all.
    let labelPlacement: String
    let placeholder: String?
    let gold: String?
}

let reference: [(section: String, lines: [String])] = [
    ("Order confirmation", [
        "Order number: ORD-2026-48213",
        "Placed: September 28, 2026",
        "Total: $1,315.50",
        "Ship to: 1200 Barton Springs Rd, Austin, TX 78704",
        "Tracking: TRK-88213-55",
    ]),
    ("Email signature", [
        "Dana Whitfield",
        "Senior Product Designer",
        "Lumen Labs",
        "dana.whitfield@lumenlabs.example",
        "+1 (512) 555-0142",
        "https://lumenlabs.example/dana",
    ]),
    ("Meeting", [
        "Design review with Priya Raman",
        "Thursday, October 8, 2026",
        "3:00 PM to 3:45 PM",
        "https://meet.example.com/xqp-rtz-kfa",
    ]),
]

/// Near misses for every gold value: another person, another order, another meeting.
let distractors: [(section: String, lines: [String])] = [
    ("Inbox: Re: Q4 vendor review", [
        "From: Priya Raman <priya.raman@northwind.example>",
        "Engineering Manager, Northwind Traders",
        "Phone: +1 (415) 555-0199",
        "https://northwind.example/priya",
    ]),
    ("Earlier order", [
        "Order number: ORD-2026-47109",
        "Total: $89.20",
        "Ship to: 455 Congress Ave, Austin, TX 78701",
        "Support ticket: SUP-30417",
    ]),
    ("Calendar", [
        "Vendor sync, Friday, October 9, 2026",
        "10:30 AM to 11:00 AM",
        "https://meet.example.com/abq-mnt-zzp",
        "Room 4B, Building C",
    ]),
]

let claimForm: [Field] = [
    Field(label: "Full name", labelPlacement: "left", placeholder: nil, gold: "Dana Whitfield"),
    Field(label: "Email", labelPlacement: "left", placeholder: nil, gold: "dana.whitfield@lumenlabs.example"),
    Field(label: "Phone", labelPlacement: "left", placeholder: "(555) 555-5555", gold: "+1 (512) 555-0142"),
    Field(label: "Company", labelPlacement: "above", placeholder: nil, gold: "Lumen Labs"),
    Field(label: "Order number", labelPlacement: "left", placeholder: nil, gold: "ORD-2026-48213"),
    Field(label: "Order total", labelPlacement: "left", placeholder: nil, gold: "$1,315.50"),
    Field(label: "Shipping address", labelPlacement: "left", placeholder: nil, gold: "1200 Barton Springs Rd, Austin, TX 78704"),
    Field(label: "Website", labelPlacement: "placeholder", placeholder: "Website", gold: "https://lumenlabs.example/dana"),
    Field(label: "Promo code", labelPlacement: "left", placeholder: nil, gold: nil),
]

let scheduleForm: [Field] = [
    Field(label: "Meeting date", labelPlacement: "left", placeholder: nil, gold: "Thursday, October 8, 2026"),
    Field(label: "Start time", labelPlacement: "left", placeholder: "e.g. 9:30 AM", gold: "3:00 PM"),
    Field(label: "Video link", labelPlacement: "left", placeholder: nil, gold: "https://meet.example.com/xqp-rtz-kfa"),
    Field(label: "Attendee email", labelPlacement: "above", placeholder: nil, gold: "dana.whitfield@lumenlabs.example"),
    Field(label: "Attendee job title", labelPlacement: "left", placeholder: nil, gold: "Senior Product Designer"),
    Field(label: "Room number", labelPlacement: "left", placeholder: nil, gold: nil),
]

// MARK: - windows

let app = NSApplication.shared
// A deactivate-on-activation guard alone still left the fixture frontmost for a second at launch (B3, 2026-10-02).
app.setActivationPolicy(backgroundOnly ? .prohibited : .accessory)
// Launched from the frontmost app (a terminal or an agent host), the fixture was made the active app
// at launch and held the foreground for a whole evaluation run (executor run-3). It never needs to
// be active: windows are made key without activation. So it hands activation back whenever it gets it.
var activationsRefused = 0
let refuseActivation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
    activationsRefused += 1
    FileHandle.standardError.write(Data("caret-fixture: became active; deactivating (\(activationsRefused))\n".utf8))
    NSApp.deactivate()
}

var windows: [String: NSWindow] = [:]
var formFields: [String: [(Field, NSTextField)]] = [:]

func makeWindow(_ title: String, _ rect: NSRect) -> NSWindow {
    let w = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    w.title = title
    w.isReleasedWhenClosed = false
    return w
}

func label(_ s: String, _ frame: NSRect, bold: Bool = false) -> NSTextField {
    let l = NSTextField(labelWithString: s)
    l.frame = frame
    if bold { l.font = .boldSystemFont(ofSize: 13) }
    return l
}

func buildReference(_ title: String = "Caret Fixture — Reference", _ sections: [(section: String, lines: [String])] = reference, x: Double = 60) -> NSWindow {
    let w = makeWindow(title, NSRect(x: x, y: 80, width: 460, height: 520))
    let v = w.contentView!
    var y = 480.0
    for (section, lines) in sections {
        let box = NSBox(frame: NSRect(x: 12, y: y - Double(lines.count) * 24 - 40, width: 436, height: Double(lines.count) * 24 + 36))
        box.title = section
        box.setAccessibilityLabel(section)
        var ly = Double(lines.count) * 24 - 18
        for line in lines {
            box.contentView!.addSubview(label(line, NSRect(x: 8, y: ly, width: 410, height: 20)))
            ly -= 24
        }
        v.addSubview(box)
        y -= Double(lines.count) * 24 + 52
    }
    return w
}

func buildForm(_ title: String, _ fields: [Field], origin: NSPoint) -> NSWindow {
    let rowH = 52.0
    let h = Double(fields.count) * rowH + 40
    let w = makeWindow(title, NSRect(x: origin.x, y: origin.y, width: 520, height: h))
    let v = w.contentView!
    var y = h - 50
    var out: [(Field, NSTextField)] = []
    for f in fields {
        let tf = NSTextField(frame: NSRect(x: 170, y: y, width: 320, height: 24))
        tf.placeholderString = f.placeholder
        switch f.labelPlacement {
        case "left":
            v.addSubview(label(f.label + ":", NSRect(x: 16, y: y + 2, width: 145, height: 20)))
        case "above":
            v.addSubview(label(f.label, NSRect(x: 170, y: y + 26, width: 320, height: 18)))
        default:
            break
        }
        v.addSubview(tf)
        out.append((f, tf))
        y -= rowH
    }
    formFields[title] = out
    return w
}

/// E8 drift window: things that move element keys on purpose. A status label and a button title
/// toggle between words, and an unnamed field is inserted above three other unnamed fields and
/// removed again, which shifts their ordinals.
final class DriftWindow {
    let w = makeWindow("Caret Fixture — Drift", NSRect(x: 300, y: 300, width: 420, height: 260))
    let status = NSTextField(labelWithString: "Status: Online")
    let button = NSButton(title: "Play", target: nil, action: nil)
    var fields: [NSTextField] = []
    var extra: NSTextField?
    var tick = 0

    init() {
        let v = w.contentView!
        status.frame = NSRect(x: 16, y: 220, width: 200, height: 20)
        button.frame = NSRect(x: 230, y: 214, width: 100, height: 30)
        v.addSubview(status); v.addSubview(button)
        for i in 0..<3 {
            let f = NSTextField(frame: NSRect(x: 16, y: 130 - Double(i) * 34, width: 380, height: 24))
            f.stringValue = "row \(["alpha", "bravo", "charlie"][i])"
            v.addSubview(f); fields.append(f)
        }
        w.orderBack(nil)
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in self.step() }
    }

    func step() {
        tick += 1
        if tick % 2 == 0 { status.stringValue = status.stringValue.hasSuffix("Online") ? "Status: Away" : "Status: Online" }
        if tick % 3 == 0 { button.title = button.title == "Play" ? "Pause" : "Play" }
        if tick % 4 == 0 {
            if let e = extra { e.removeFromSuperview(); extra = nil } else {
                let e = NSTextField(frame: NSRect(x: 16, y: 170, width: 380, height: 24))
                // Added after the others in the view list but placed above them, as layout code often does;
                // inserted first so it precedes them in the accessibility order too.
                w.contentView!.addSubview(e, positioned: .below, relativeTo: fields[0])
                extra = e
            }
        }
    }
}
var drift: DriftWindow?

/// The executor's fixture: named fields (two pairs share a label in different sections, so a locator
/// by label alone is ambiguous), a status line, and buttons with known effects. Stdin commands reset
/// it, change it behind the reader's back, and report its true state, which is how the evaluation
/// checks the executor without trusting the executor's own reading.
final class ExecutorWindow {
    static let title = "Caret Fixture — Executor"
    let w = makeWindow(ExecutorWindow.title, NSRect(x: 620, y: 520, width: 560, height: 560))
    var fields: [String: NSView] = [:]
    var frames: [String: (NSView, NSRect)] = [:]
    let notes = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 50))
    let status = NSTextField(labelWithString: "Status: Active")
    var noteLabel: NSTextField?
    var sent = false
    var sheet: NSWindow?

    init() {
        let v = w.contentView!
        func field(_ name: String, _ label: String, _ frame: NSRect, in parent: NSView) {
            let tf = NSTextField(frame: frame)
            tf.setAccessibilityLabel(label)
            parent.addSubview(tf)
            fields[name] = tf
            frames[name] = (parent, frame)
        }
        var y = 520.0
        for (name, label) in [("name", "Name"), ("email", "Email"), ("reference", "Reference"), ("message", "Message"), ("eventTitle", "Event title")] {
            v.addSubview(label_(label + ":", NSRect(x: 16, y: y + 2, width: 110, height: 20)))
            field(name, label, NSRect(x: 130, y: y, width: 300, height: 24), in: v)
            y -= 34
        }
        let scroll = NSScrollView(frame: NSRect(x: 130, y: y - 30, width: 300, height: 50))
        notes.setAccessibilityLabel("Notes")
        notes.isRichText = false
        scroll.documentView = notes
        v.addSubview(label_("Notes:", NSRect(x: 16, y: y + 2, width: 110, height: 20)))
        v.addSubview(scroll)
        fields["notes"] = notes
        y -= 90
        for (i, section) in ["Billing", "Shipping"].enumerated() {
            let box = NSBox(frame: NSRect(x: 12 + Double(i) * 270, y: y - 40, width: 260, height: 100))
            box.title = section
            box.setAccessibilityLabel(section)
            v.addSubview(box)
            let key = section.lowercased()
            field("\(key)City", "City", NSRect(x: 8, y: 40, width: 230, height: 24), in: box.contentView!)
            field("\(key)Street", "Street", NSRect(x: 8, y: 8, width: 230, height: 24), in: box.contentView!)
        }
        status.frame = NSRect(x: 16, y: 70, width: 200, height: 20)
        v.addSubview(status)
        for (i, title) in ["Archive", "Add note", "Next page", "Send"].enumerated() {
            let b = NSButton(title: title, target: self, action: #selector(pressed(_:)))
            b.frame = NSRect(x: 16 + Double(i) * 130, y: 20, width: 120, height: 30)
            v.addSubview(b)
        }
        w.orderBack(nil)
    }

    private func label_(_ s: String, _ f: NSRect) -> NSTextField { label(s, f) }

    @objc func pressed(_ b: NSButton) {
        switch b.title {
        case "Archive": status.stringValue = "Status: Archived"
        case "Add note":
            if noteLabel == nil {
                let l = NSTextField(labelWithString: "Note added")
                l.frame = NSRect(x: 240, y: 70, width: 200, height: 20)
                w.contentView!.addSubview(l)
                noteLabel = l
            }
        case "Next page": w.title = ExecutorWindow.title + " (page 2)"
        case "Send": sent = true
        default: break
        }
    }

    func value(_ name: String) -> String? {
        guard let f = fields[name], f.superview != nil || f === notes else { return nil }
        if f === notes { return notes.enclosingScrollView?.superview == nil ? nil : notes.string }
        return (f as? NSTextField)?.stringValue
    }

    func set(_ name: String, _ value: String) -> Bool {
        guard let f = fields[name] else { return false }
        if f === notes { notes.string = value } else { (f as? NSTextField)?.stringValue = value }
        return true
    }

    func command(_ line: String) -> [String: Any] {
        let parts = line.split(separator: " ", maxSplits: 2).map(String.init)
        switch parts.first ?? "" {
        case "reset":
            if let s = sheet { w.endSheet(s); sheet = nil }
            for (name, (parent, frame)) in frames where fields[name]!.superview == nil {
                fields[name]!.frame = frame
                parent.addSubview(fields[name]!)
            }
            for name in fields.keys { _ = set(name, "") }
            status.stringValue = "Status: Active"
            noteLabel?.removeFromSuperview(); noteLabel = nil
            w.title = ExecutorWindow.title
            sent = false
            return ["ok": true]
        case "seed" where parts.count >= 2:
            return ["ok": set(parts[1], parts.count == 3 ? parts[2] : "")]
        case "remove" where parts.count == 2:
            guard let f = fields[parts[1]], f !== notes else { return ["ok": false] }
            f.removeFromSuperview()
            return ["ok": true]
        case "sheet":
            let s = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
            s.contentView!.addSubview(label("Unsaved changes", NSRect(x: 20, y: 60, width: 260, height: 20)))
            w.beginSheet(s)
            sheet = s
            return ["ok": true]
        case "dump":
            var values: [String: Any] = [:]
            for name in fields.keys { values[name] = value(name) ?? NSNull() }
            return ["ok": true, "title": w.title, "fields": values, "status": status.stringValue, "note": noteLabel != nil, "sent": sent, "sheet": sheet != nil]
        default:
            return ["ok": false, "error": "unknown command \(line)"]
        }
    }
}
var executorWindow: ExecutorWindow?

/// Names for the loop fixture, in list order. Invented, like everything here.
let rosterNames = ["Dana Whitfield", "Priya Raman", "Marcus Lowe", "Ines Okafor", "Tomas Brandt", "Keiko Sato", "Rafael Duarte", "Amara Nwosu"]

/// The loop recognizer's source: one named group of static text lines, which share an element template.
func buildRoster() -> NSWindow {
    let w = makeWindow("Caret Fixture — Roster", NSRect(x: 60, y: 80, width: 300, height: 290))
    let box = NSBox(frame: NSRect(x: 12, y: 12, width: 276, height: 262))
    box.title = "Attendees"
    box.setAccessibilityLabel("Attendees")
    var y = 212.0
    for n in rosterNames {
        box.contentView!.addSubview(label(n, NSRect(x: 8, y: y, width: 250, height: 20)))
        y -= 26
    }
    w.contentView!.addSubview(box)
    return w
}

/// The loop recognizer's destination: six fields that share the label "Guest", so their keys differ only by ordinal.
final class SeatingWindow {
    static let title = "Caret Fixture — Seating"
    let w = makeWindow(SeatingWindow.title, NSRect(x: 400, y: 80, width: 360, height: 280))
    var guests: [NSTextField] = []

    init() {
        var y = 236.0
        for i in 0..<6 {
            w.contentView!.addSubview(label("Seat \(i + 1):", NSRect(x: 16, y: y + 2, width: 70, height: 20)))
            let f = NSTextField(frame: NSRect(x: 90, y: y, width: 250, height: 24))
            f.setAccessibilityLabel("Guest")
            w.contentView!.addSubview(f)
            guests.append(f)
            y -= 38
        }
        w.orderBack(nil)
    }

    func command(_ line: String) -> [String: Any] {
        switch line {
        case "reset":
            for g in guests { g.stringValue = "" }
            return ["ok": true]
        case "dump":
            return ["ok": true, "title": w.title, "guests": guests.map { $0.stringValue }]
        default:
            return ["ok": false, "error": "unknown command \(line)"]
        }
    }
}
var seatingWindow: SeatingWindow?

for name in windowList {
    switch name {
    case "drift": drift = DriftWindow()
    case "executor": executorWindow = ExecutorWindow()
    case "reference": windows[name] = buildReference()
    case "distractors": windows[name] = buildReference("Caret Fixture — Inbox", distractors, x: 300)
    case "claim": windows[name] = buildForm("Caret Fixture — Claim form", claimForm, origin: NSPoint(x: 540, y: 80))
    case "schedule": windows[name] = buildForm("Caret Fixture — Schedule follow-up", scheduleForm, origin: NSPoint(x: 1080, y: 80))
    case "roster": windows[name] = buildRoster()
    case "seating": seatingWindow = SeatingWindow()
    default: die("unknown window \(name)")
    }
}
for w in windows.values { w.orderBack(nil) }

/// Accessibility frames use a top-left origin on the primary screen.
func axFrame(_ v: NSView) -> [Double] {
    guard let w = v.window else { return [] }
    let r = w.convertToScreen(v.convert(v.bounds, to: nil))
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    return [r.origin.x, primaryHeight - r.origin.y - r.height, r.width, r.height].map { $0.rounded() }
}

if let gp = goldPath {
    var forms: [[String: Any]] = []
    for (title, fields) in formFields.sorted(by: { $0.key < $1.key }) {
        forms.append(["window": title, "fields": fields.map { f, tf in
            ["label": f.label, "gold": f.gold as Any, "frame": axFrame(tf)] as [String: Any]
        }])
    }
    let d = try! JSONSerialization.data(withJSONObject: ["pid": Int(getpid()), "forms": forms], options: [.prettyPrinted, .sortedKeys])
    try! d.write(to: URL(fileURLWithPath: gp))
}

// MARK: - E1: scripted AppKit changes, each carrying a marker "T<ms><action><n>"

final class E1Script {
    let log: LineLog
    let w = makeWindow("Caret Fixture — E1", NSRect(x: 60, y: 620, width: 460, height: 220))
    let programmatic = NSTextField(frame: NSRect(x: 16, y: 170, width: 420, height: 24))
    let typed = NSTextField(frame: NSRect(x: 16, y: 136, width: 420, height: 24))
    let focusA = NSTextField(frame: NSRect(x: 16, y: 102, width: 200, height: 24))
    let focusB = NSTextField(frame: NSRect(x: 236, y: 102, width: 200, height: 24))
    let status = NSTextField(labelWithString: "idle")
    var extra: NSWindow?
    var n = 0

    init(log: LineLog) {
        self.log = log
        status.frame = NSRect(x: 16, y: 60, width: 420, height: 20)
        for v in [programmatic, typed, focusA, focusB, status] { w.contentView!.addSubview(v) }
        w.orderBack(nil)
        // A background app posts focus notifications only within its key window.
        w.makeKey()
    }

    func marker(_ a: String) -> String { "T\(ms())\(a)\(n)" }
    func record(_ a: String, _ m: String) { log.write(["t": ms(), "action": a, "marker": m]) }

    /// One cycle runs every action once, spaced by `period`, in a fixed order.
    func run(cycles: Int, period: TimeInterval, done: @escaping () -> Void) {
        let actions = ["v", "k", "f", "s", "t", "w", "c"]
        var step = 0
        Timer.scheduledTimer(withTimeInterval: period, repeats: true) { t in
            MainActor.assumeIsolated {
                if step >= cycles * actions.count {
                    t.invalidate()
                    done()
                    return
                }
                self.n = step / actions.count
                self.perform(actions[step % actions.count])
                step += 1
            }
        }
    }

    func perform(_ a: String) {
        let m = marker(a)
        switch a {
        case "v":
            record(a, m); programmatic.stringValue = m
        case "k":
            w.makeFirstResponder(typed)
            if let ed = typed.currentEditor() as? NSTextView {
                ed.selectAll(nil)
                record(a, m); ed.insertText(m, replacementRange: ed.selectedRange())
            }
        case "f":
            let target = n % 2 == 0 ? focusA : focusB
            target.stringValue = m
            record(a, m); w.makeFirstResponder(target)
        case "s":
            record(a, m); status.stringValue = m
        case "t":
            record(a, m); w.title = "Caret Fixture — E1 \(m)"
        case "w":
            let x = makeWindow("Caret Fixture — E1 extra \(m)", NSRect(x: 540, y: 620, width: 300, height: 120))
            record(a, m); x.orderBack(nil)
            extra = x
        case "c":
            record(a, m); extra?.close(); extra = nil
        default:
            break
        }
    }
}

var e1: E1Script?
if let p = e1Path {
    let s = E1Script(log: LineLog(p))
    e1 = s
    s.run(cycles: cycles, period: period) {}
}

// MARK: - WebKit window for E1 (the page scripts its own changes)

var webView: WKWebView?
if let u = webkitURL, let url = URL(string: u) {
    let w = makeWindow("Caret Fixture — WebKit", NSRect(x: 540, y: 620, width: 520, height: 360))
    let wv = WKWebView(frame: w.contentView!.bounds)
    wv.autoresizingMask = [.width, .height]
    w.contentView!.addSubview(wv)
    if url.isFileURL { wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) } else { wv.load(URLRequest(url: url)) }
    w.orderBack(nil)
    windows["webkit"] = w
    webView = wv
}

// MARK: - user-like activity for the shadow logger and the fill evaluation

/// Focuses form fields one at a time and types into them through the field editor, the way a
/// person would. Half the values exist in the Reference window; the rest are invented. Every entry
/// is logged with whether its value exists elsewhere, so the shadow log can be scored.
final class Activity {
    let log: LineLog
    var slots: [(window: String, field: Int, gold: String?)] = []
    var i = 0
    let invented = ["Weekly sync notes", "Blue Cypress Hall", "call back after four", "Westlake Terrace", "Second floor lobby"]

    init(log: LineLog) {
        self.log = log
        for title in ["Caret Fixture — Claim form", "Caret Fixture — Schedule follow-up"] {
            for (fi, f) in (formFields[title] ?? []).enumerated() { slots.append((title, fi, f.0.gold)) }
        }
    }

    func start(every: TimeInterval) {
        Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
            MainActor.assumeIsolated { self.step() }
        }
    }

    /// Entry i uses slot i mod n. Each round, a slot switches between its gold value (on screen in the
    /// Reference window) and an invented one, so consecutive entries in one field always differ.
    /// Invented values carry the entry number and no typed value, so none can appear anywhere else.
    func plan(_ i: Int) -> (window: String, field: Int, text: String, existsElsewhere: Bool) {
        let slot = i % slots.count
        let s = slots[slot]
        let round = i / slots.count
        if let g = s.gold, (round + slot) % 2 == 0 { return (s.window, s.field, g, true) }
        return (s.window, s.field, "\(invented[i % invented.count]) \(i + 1)", false)
    }

    func step() {
        let p = plan(i)
        i += 1
        guard let w = windows.values.first(where: { $0.title == p.window }), let tf = formFields[p.window]?[p.field].1 else { return }
        w.makeKey()
        w.makeFirstResponder(tf)
        log.write(["t": ms(), "event": "focus", "window": p.window, "label": formFields[p.window]![p.field].0.label])
        // Clear the old entry the way a person does, select all and delete, then pause before typing,
        // so the reader sees the field empty. A programmatic clear posts no notification at all.
        if let ed = tf.currentEditor() as? NSTextView {
            ed.selectAll(nil)
            ed.deleteBackward(nil)
        }
        let chars = Array(p.text)
        var c = 0
        var waited = 0
        Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { t in
            if waited < 6 { waited += 1; return }
            MainActor.assumeIsolated {
                guard c < chars.count, let ed = tf.currentEditor() as? NSTextView else {
                    t.invalidate()
                    self.log.write(["t": ms(), "event": "entered", "window": p.window, "length": chars.count, "existsElsewhere": p.existsElsewhere])
                    return
                }
                ed.insertText(String(chars[c]), replacementRange: ed.selectedRange())
                c += 1
            }
        }
    }
}

var activity: Activity?
if let p = activityPath {
    let a = Activity(log: LineLog(p))
    activity = a
    a.start(every: 8)
}

/// Focuses the first empty field of each form once, a few seconds apart, to exercise focus-triggered fill.
/// With --visit, the listed windows are made key first, 1.5 s apart, so the reader sees the user
/// pass through them and the last one is the window the user just left.
if focusForms {
    for v in visitList where windows[v] == nil { die("--visit names \(v), which is not among --windows") }
    var delay = 6.0
    for title in ["Caret Fixture — Claim form", "Caret Fixture — Schedule follow-up"] {
        guard let w = windows.values.first(where: { $0.title == title }), let tf = formFields[title]?.first?.1 else { continue }
        for v in visitList {
            let vw = windows[v]!
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { vw.makeKey() }
            delay += 1.5
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            MainActor.assumeIsolated {
                // Without a key window, a background app posts no focus notification for a new first responder.
                w.makeKey()
                _ = w.makeFirstResponder(tf)
            }
        }
        delay += 6
    }
}

// Stdin commands for the executor or seating window, one per line, each answered with one JSON line.
if executorWindow != nil && seatingWindow != nil { die("the executor and seating windows both read stdin; open one of them") }
let stdinCommand: ((String) -> [String: Any])? = executorWindow.map { ex in { ex.command($0) } } ?? seatingWindow.map { sw in { sw.command($0) } }
if let command = stdinCommand {
    var pending = Data()
    FileHandle.standardInput.readabilityHandler = { h in
        let chunk = h.availableData
        if chunk.isEmpty { h.readabilityHandler = nil; return }
        pending.append(chunk)
        while let nl = pending.firstIndex(of: 0x0A) {
            let line = String(decoding: pending[pending.startIndex..<nl], as: UTF8.self)
            pending.removeSubrange(pending.startIndex...nl)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    let out = command(line.trimmingCharacters(in: .whitespaces))
                    let d = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
                    print(String(decoding: d, as: UTF8.self))
                }
            }
        }
    }
}

DispatchQueue.main.asyncAfter(deadline: .now() + duration) { exit(0) }
print("caret-fixture pid \(getpid()) windows \(windows.keys.sorted().joined(separator: ","))")
app.run()
