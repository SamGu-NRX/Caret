// calendar-tool: what calendar_vm_acceptance.py reads back through EventKit, and the one press it makes
// on macOS's Calendar prompt. Built on the host, run only in the rig guest, where it is granted Calendar
// and Accessibility. It never adds, edits or removes an event or a calendar. Every answer is one JSON line.
//
//   calendar-tool status                 Calendar authorization, by EventKit's name
//   calendar-tool default                the default calendar for new events: id, title, source
//   calendar-tool find TITLE DAYS        every event with this title from a day ago to DAYS days ahead
//   calendar-tool event ID               the event with this identifier, or null
//   calendar-tool prompt WORD            the on-screen alert whose text names WORD and Calendar: its app,
//                                        window, texts and buttons (needs Accessibility)
//   calendar-tool allow WORD             presses that alert's "Allow" button by Accessibility
import AppKit
import ApplicationServices
import EventKit
import Foundation

func out(_ object: Any?) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object ?? NSNull(), options: [.sortedKeys, .fragmentsAllowed])) ?? Data("null".utf8)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("calendar-tool: \(message)\n".utf8))
    exit(1)
}

func statusName() -> String {
    switch EKEventStore.authorizationStatus(for: .event) {
    case .notDetermined: "notDetermined"
    case .restricted: "restricted"
    case .denied: "denied"
    case .fullAccess: "fullAccess"
    case .writeOnly: "writeOnly"
    @unknown default: "unknown"
    }
}

func store() -> EKEventStore {
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { fail("no full Calendar access (\(statusName()))") }
    return EKEventStore()
}

let iso = ISO8601DateFormatter()
/// The guest's own clock: "Thursday 15:00".
let local: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .current
    f.dateFormat = "EEEE HH:mm"
    return f
}()
func describe(_ e: EKEvent) -> [String: Any] {
    ["id": e.eventIdentifier ?? "", "title": e.title ?? "", "calendarId": e.calendar?.calendarIdentifier ?? "",
     "calendarTitle": e.calendar?.title ?? "", "start": e.startDate.map(iso.string) ?? "", "end": e.endDate.map(iso.string) ?? "",
     "startLocal": e.startDate.map(local.string) ?? "", "endLocal": e.endDate.map(local.string) ?? ""]
}

// MARK: - Accessibility, for the prompt

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }

/// Static texts and buttons under `el`, to a bounded depth.
func walk(_ el: AXUIElement, depth: Int = 0, texts: inout [String], buttons: inout [(String, AXUIElement)]) {
    guard depth < 12 else { return }
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    if role == kAXStaticTextRole, let v = attr(el, kAXValueAttribute) as? String { texts.append(v) }
    if role == kAXButtonRole { buttons.append((attr(el, kAXTitleAttribute) as? String ?? "", el)) }
    for c in children(el) { walk(c, depth: depth + 1, texts: &texts, buttons: &buttons) }
}

/// The on-screen window whose texts name `word` and "Calendar", in any running app.
func findPrompt(_ word: String) -> (app: String, pid: pid_t, texts: [String], buttons: [(String, AXUIElement)])? {
    guard AXIsProcessTrusted() else { fail("no Accessibility") }
    for app in NSWorkspace.shared.runningApplications {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        for w in (attr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
            var texts: [String] = []
            var buttons: [(String, AXUIElement)] = []
            walk(w, texts: &texts, buttons: &buttons)
            let all = texts.joined(separator: " ")
            if all.contains(word), all.localizedCaseInsensitiveContains("calendar"), !buttons.isEmpty {
                return (app.localizedName ?? app.bundleIdentifier ?? "?", app.processIdentifier, texts, buttons)
            }
        }
    }
    return nil
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: status | default | find TITLE DAYS | event ID | prompt WORD | allow WORD") }
args.removeFirst()
switch command {
case "status":
    out(["access": statusName()])
case "default":
    guard let c = store().defaultCalendarForNewEvents else { out(nil) }
    out(["id": c.calendarIdentifier, "title": c.title, "source": c.source?.title ?? "", "writable": c.allowsContentModifications])
case "find":
    guard args.count == 2, let days = Double(args[1]) else { fail("usage: find TITLE DAYS") }
    let s = store()
    let from = Date().addingTimeInterval(-86_400), to = Date().addingTimeInterval(days * 86_400)
    out(s.events(matching: s.predicateForEvents(withStart: from, end: to, calendars: nil)).filter { $0.title == args[0] }.map(describe))
case "event":
    guard args.count == 1 else { fail("usage: event ID") }
    out(store().event(withIdentifier: args[0]).map(describe))
case "prompt":
    guard args.count == 1 else { fail("usage: prompt WORD") }
    guard let p = findPrompt(args[0]) else { out(nil) }
    // Its app's on-screen windows by number, for a capture by window number.
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    let numbers = list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(p.pid) }.compactMap { $0[kCGWindowNumber as String] as? Int }
    out(["app": p.app, "pid": p.pid, "texts": p.texts, "buttons": p.buttons.map(\.0), "windows": numbers])
case "allow":
    guard args.count == 1 else { fail("usage: allow WORD") }
    guard let p = findPrompt(args[0]) else { out(["pressed": false, "why": "no prompt naming \(args[0]) and Calendar"]) }
    guard let (title, button) = p.buttons.first(where: { $0.0.hasPrefix("Allow") }) else {
        out(["pressed": false, "why": "no Allow button", "buttons": p.buttons.map(\.0)])
    }
    let r = AXUIElementPerformAction(button, kAXPressAction as CFString)
    out(["pressed": r == .success, "button": title, "app": p.app, "axError": r.rawValue])
default:
    fail("unknown command \(command)")
}
