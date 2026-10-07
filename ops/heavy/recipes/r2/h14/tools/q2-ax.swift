// VM only: Q2's read-backs and window chores through Accessibility, CGWindowList and EventKit. Prints one JSON object.
// Refuses to run unless rig-run started it (RIG_JOB set): it presses UI in other apps.
//
//   q2-ax front                              the frontmost app {pid, name}
//   q2-ax activate <pid>                     LaunchServices activation by bundle id (a background process's own
//                                            activate() is ignored), then Window > Bring All to Front; waits 5 s
//   q2-ax windows <pid>                      on-screen windows {number, title, frame} (CGWindowList, top-left points)
//   q2-ax focused <pid>                      the focused element {role, value, selection, frame}
//   q2-ax doc <pid>                          the value of the first text area in the app's focused or main window
//   q2-ax texts <pid> <title-prefix>         every static text and text field value in that window, in order
//   q2-ax setframe <pid> <x> <y> <w> <h>     moves and sizes the app's main window
//   q2-ax menu <pid> <title>                 presses an item in the app's status-item menu (V1b's menu-quit)
//   q2-ax events <calendar-title> [days]     events from now to +days (default 30) in calendars with that title
//   q2-ax axwin <pid>                        H14: each Accessibility window of the app {title, subrole, frame, buttons
//                                            [{title, description, frame}], texts}: the page task panel's attach rows
//                                            are buttons named "<label>, <file text>", and an open panel has a "Choose"
//                                            button and the message "Choose a file for '<label>'"
import AppKit
import ApplicationServices
import EventKit

func emit(_ o: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(o["error"] == nil ? 0 : 1)
}
guard ProcessInfo.processInfo.environment["RIG_JOB"] != nil else { emit(["error": "VM only (RIG_JOB unset)"]) }
let args = CommandLine.arguments
func arg(_ i: Int) -> String { guard args.count > i else { emit(["error": "missing argument \(i)"]) }; return args[i] }
func pidArg(_ i: Int) -> pid_t { guard let p = pid_t(arg(i)) else { emit(["error": "bad pid \(arg(i))"]) }; return p }

func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func str(_ e: AXUIElement, _ name: String) -> String? { attr(e, name) as? String }
func role(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute) ?? "" }
func frame(_ e: AXUIElement) -> [Double]? {
    guard let p = attr(e, kAXPositionAttribute), let s = attr(e, kAXSizeAttribute) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt); AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return [pt.x, pt.y, sz.width, sz.height].map { Double($0) }
}
func appElement(_ pid: pid_t) -> AXUIElement { let a = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(a, 3); return a }
func window(_ pid: pid_t) -> AXUIElement? {
    let a = appElement(pid)
    if let w = attr(a, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
    if let w = attr(a, kAXMainWindowAttribute) { return (w as! AXUIElement) }
    return (attr(a, kAXWindowsAttribute) as? [AXUIElement])?.first
}
func front() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }

let needsAX: Set<String> = ["focused", "doc", "texts", "setframe", "menu", "activate", "axwin"]
if needsAX.contains(arg(1)) && !AXIsProcessTrusted() { emit(["error": "q2-ax is not trusted for Accessibility"]) }

switch arg(1) {
case "front":
    let a = NSWorkspace.shared.frontmostApplication
    emit(["pid": a?.processIdentifier ?? -1, "name": a?.localizedName ?? ""])
case "activate":
    let p = pidArg(2)
    guard let bundle = NSRunningApplication(processIdentifier: p)?.bundleIdentifier else { emit(["error": "no app with pid \(p)"]) }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-b", bundle]
    try? open.run(); open.waitUntilExit()
    if let bar = attr(appElement(p), kAXMenuBarAttribute) {
        for item in children(bar as! AXUIElement) where str(item, kAXTitleAttribute) == "Window" {
            for menu in children(item) { for e in children(menu) where str(e, kAXTitleAttribute) == "Bring All to Front" { AXUIElementPerformAction(e, kAXPressAction as CFString) } }
        }
    }
    for _ in 0..<50 where front() != p { usleep(100_000) }
    emit(["front": front() == p, "frontPid": front() ?? -1])
case "windows":
    let p = pidArg(2)
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var out: [[String: Any]] = []
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == Int(p) {
        let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
        out.append(["number": w[kCGWindowNumber as String] as? Int ?? 0, "title": w[kCGWindowName as String] as? String ?? "",
                    "layer": w[kCGWindowLayer as String] as? Int ?? 0,
                    "frame": [b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0]])
    }
    emit(["windows": out])
case "focused":
    let p = pidArg(2)
    guard let f = attr(appElement(p), kAXFocusedUIElementAttribute) else { emit(["error": "no focused element"]) }
    let e = f as! AXUIElement
    var r = CFRange()
    if let v = attr(e, kAXSelectedTextRangeAttribute) { AXValueGetValue(v as! AXValue, .cfRange, &r) }
    emit(["role": role(e), "value": str(e, kAXValueAttribute) ?? NSNull(), "selection": [r.location, r.length],
          "frame": frame(e) ?? NSNull(), "title": str(e, kAXTitleAttribute) ?? NSNull(), "description": str(e, kAXDescriptionAttribute) ?? NSNull()])
case "doc":
    let p = pidArg(2)
    guard let w = window(p) else { emit(["error": "no window"]) }
    func area(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
        if role(e) == kAXTextAreaRole as String { return e }
        guard d < 8 else { return nil }
        for c in children(e) { if let hit = area(c, d + 1) { return hit } }
        return nil
    }
    guard let a = area(w, 0) else { emit(["error": "no text area", "window": str(w, kAXTitleAttribute) ?? ""]) }
    var r = CFRange()
    if let v = attr(a, kAXSelectedTextRangeAttribute) { AXValueGetValue(v as! AXValue, .cfRange, &r) }
    emit(["value": str(a, kAXValueAttribute) ?? "", "selection": [r.location, r.length], "window": str(w, kAXTitleAttribute) ?? "", "frame": frame(w) ?? NSNull()])
case "texts":
    let p = pidArg(2), prefix = arg(3)
    let wins = (attr(appElement(p), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    guard let w = wins.first(where: { (str($0, kAXTitleAttribute) ?? "").hasPrefix(prefix) }) else {
        emit(["error": "no window titled \(prefix)…", "titles": wins.map { str($0, kAXTitleAttribute) ?? "" }])
    }
    var out: [String] = []
    func walk(_ e: AXUIElement, _ d: Int) {
        let r = role(e)
        if r == kAXStaticTextRole as String || r == kAXTextFieldRole as String || r == kAXTextAreaRole as String, let v = str(e, kAXValueAttribute), !v.isEmpty { out.append(v) }
        guard d < 10 else { return }
        for c in children(e) { walk(c, d + 1) }
    }
    walk(w, 0)
    emit(["texts": out])
case "setframe":
    let p = pidArg(2)
    guard args.count >= 7, let x = Double(args[3]), let y = Double(args[4]), let wd = Double(args[5]), let h = Double(args[6]) else { emit(["error": "setframe pid x y w h"]) }
    guard let w = window(p) else { emit(["error": "no window"]) }
    var pt = CGPoint(x: x, y: y), sz = CGSize(width: wd, height: h)
    let r1 = AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &pt)!)
    let r2 = AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &sz)!)
    emit(["position": r1.rawValue, "size": r2.rawValue, "frame": frame(w) ?? NSNull()])
case "menu":
    let p = pidArg(2), wanted = arg(3)
    guard let extras = attr(appElement(p), "AXExtrasMenuBar"), let item = children(extras as! AXUIElement).first else { emit(["error": "the app has no status item"]) }
    let press = AXUIElementPerformAction(item, kAXPressAction as CFString)
    func find(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
        if role(e) == kAXMenuItemRole as String && str(e, kAXTitleAttribute) == wanted { return e }
        guard d < 4 else { return nil }
        for c in children(e) { if let hit = find(c, d + 1) { return hit } }
        return nil
    }
    var target: AXUIElement?
    for _ in 0..<30 { target = find(item, 0); if target != nil { break }; usleep(100_000) }
    guard let t = target else {
        let seen = children(item).flatMap(children).map { str($0, kAXTitleAttribute) ?? "" }
        _ = AXUIElementPerformAction(item, kAXCancelAction as CFString)
        emit(["error": "no menu item titled \(wanted)", "openResult": press.rawValue, "items": seen])
    }
    emit(["pressed": wanted, "openResult": press.rawValue, "pressResult": AXUIElementPerformAction(t, kAXPressAction as CFString).rawValue])
case "events":
    let title = arg(2), days = Double(args.count > 3 ? args[3] : "30") ?? 30
    let status = EKEventStore.authorizationStatus(for: .event)
    guard status == .fullAccess else { emit(["error": "no full Calendar access (status \(status.rawValue))"]) }
    let store = EKEventStore()
    let cals = store.calendars(for: .event).filter { $0.title == title }
    guard !cals.isEmpty else { emit(["events": [], "calendars": store.calendars(for: .event).map(\.title)]) }
    let now = Date()
    let pred = store.predicateForEvents(withStart: now.addingTimeInterval(-86_400), end: now.addingTimeInterval(days * 86_400), calendars: cals)
    let iso = ISO8601DateFormatter()
    iso.timeZone = .current
    emit(["events": store.events(matching: pred).map { ["title": $0.title ?? "", "start": iso.string(from: $0.startDate), "end": iso.string(from: $0.endDate), "calendar": $0.calendar.title] },
          "timeZone": TimeZone.current.identifier])
case "axwin":
    let p = pidArg(2)
    let wins = (attr(appElement(p), kAXWindowsAttribute) as? [AXUIElement]) ?? []
    var out: [[String: Any]] = []
    for w in wins {
        var buttons: [[String: Any]] = []
        var texts: [String] = []
        var seen = 0
        // Bounded: an open panel's file browser is a large tree, and only its buttons and message are wanted.
        func walk(_ e: AXUIElement, _ d: Int) {
            seen += 1
            guard seen <= 800 else { return }
            let r = role(e)
            if r == kAXButtonRole as String, buttons.count < 100 {
                buttons.append(["title": str(e, kAXTitleAttribute) ?? "", "description": str(e, kAXDescriptionAttribute) ?? "", "frame": frame(e) ?? NSNull()])
            } else if r == kAXStaticTextRole as String, texts.count < 80, let v = str(e, kAXValueAttribute), !v.isEmpty {
                texts.append(v)
            }
            guard d < 16 else { return }
            for c in children(e) { walk(c, d + 1) }
        }
        walk(w, 0)
        out.append(["title": str(w, kAXTitleAttribute) ?? "", "subrole": str(w, kAXSubroleAttribute) ?? "", "frame": frame(w) ?? NSNull(),
                    "buttons": buttons, "texts": texts])
    }
    emit(["windows": out])
default:
    emit(["error": "usage: front | activate PID | windows PID | focused PID | doc PID | texts PID PREFIX | setframe PID X Y W H | menu PID TITLE | events CALENDAR [DAYS] | axwin PID"])
}
