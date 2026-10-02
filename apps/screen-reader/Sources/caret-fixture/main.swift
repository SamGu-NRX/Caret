// caret-fixture: synthetic AppKit windows for caret-screen's tests and experiments.
// Every name, number and address here is invented. The app never activates itself, so it does
// not take focus from whoever is using the Mac; its windows open behind other windows.
//
//   caret-fixture [--windows reference,claim,schedule] [--gold FILE] [--duration S]
//                 [--e1 FILE --cycles N --period S] [--webkit URL]
//                 [--activity FILE] [--focus-forms]
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
app.setActivationPolicy(.accessory)

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

for name in windowList {
    switch name {
    case "drift": drift = DriftWindow()
    case "reference": windows[name] = buildReference()
    case "distractors": windows[name] = buildReference("Caret Fixture — Inbox", distractors, x: 300)
    case "claim": windows[name] = buildForm("Caret Fixture — Claim form", claimForm, origin: NSPoint(x: 540, y: 80))
    case "schedule": windows[name] = buildForm("Caret Fixture — Schedule follow-up", scheduleForm, origin: NSPoint(x: 1080, y: 80))
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
    let invented = ["Weekly sync notes", "Blue Cypress Hall", "call back after four", "QX-77120-B", "Westlake Terrace"]

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

    /// Entry i uses slot i mod n. A slot alternates between its gold value (on screen in the Reference
    /// window) and an invented one, so consecutive entries in one field always differ. Invented values carry the entry number, so none repeats.
    func plan(_ i: Int) -> (window: String, field: Int, text: String, existsElsewhere: Bool) {
        let s = slots[i % slots.count]
        let round = i / slots.count
        if let g = s.gold, (round + i) % 2 == 0 { return (s.window, s.field, g, true) }
        return (s.window, s.field, "\(invented[i % invented.count]) \(i + 1)", false)
    }

    func step() {
        let p = plan(i)
        i += 1
        guard let w = windows.values.first(where: { $0.title == p.window }), let tf = formFields[p.window]?[p.field].1 else { return }
        tf.stringValue = ""
        w.makeKey()
        w.makeFirstResponder(tf)
        log.write(["t": ms(), "event": "focus", "window": p.window, "label": formFields[p.window]![p.field].0.label])
        let chars = Array(p.text)
        var c = 0
        Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { t in
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
if focusForms {
    var delay = 6.0
    for title in ["Caret Fixture — Claim form", "Caret Fixture — Schedule follow-up"] {
        guard let w = windows.values.first(where: { $0.title == title }), let tf = formFields[title]?.first?.1 else { continue }
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

DispatchQueue.main.asyncAfter(deadline: .now() + duration) { exit(0) }
print("caret-fixture pid \(getpid()) windows \(windows.keys.sorted().joined(separator: ","))")
app.run()
