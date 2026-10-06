// B20 part 4: which observers see a click on a button of a process the experiment started, when the click is
// posted to that process alone (CGEventPostToPid), as the evaluation must post it: a click through the HID
// stream would land in whatever window is in front, which may be the user's. Three observers are installed
// before the click: an NSEvent global monitor (the reader's input watch today), a listen-only event tap for
// the one process, and a listen-only session tap. None of them can change an event.
//
//   press-observe PID TITLE_PREFIX BUTTON_LABEL    -> one JSON line
import AppKit
import ApplicationServices
import Foundation

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

func out(_ o: [String: Any]) -> Never {
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    print(String(decoding: d, as: UTF8.self))
    exit(0)
}
func attr(_ e: AXUIElement, _ n: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ n: String) -> String? { attr(e, n) as? String }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func find(_ e: AXUIElement, depth: Int = 0, _ ok: (AXUIElement) -> Bool) -> AXUIElement? {
    if ok(e) { return e }
    if depth > 20 { return nil }
    for k in kids(e) { if let f = find(k, depth: depth + 1, ok) { return f } }
    return nil
}
func point(_ e: AXUIElement, _ n: String) -> CGPoint? {
    guard let v = attr(e, n), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}
func size(_ e: AXUIElement) -> CGSize? {
    guard let v = attr(e, kAXSizeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

let a = Array(CommandLine.arguments.dropFirst())
guard a.count == 3, let pid = pid_t(a[0]) else { out(["ok": false, "error": "usage: press-observe PID TITLE_PREFIX BUTTON_LABEL"]) }
_ = NSApplication.shared
let app = AXUIElementCreateApplication(pid)
let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
guard let win = wins.first(where: { (str($0, kAXTitleAttribute) ?? "").hasPrefix(a[1]) }) else { out(["ok": false, "error": "no window '\(a[1])'"]) }
guard let button = find(win, { str($0, kAXRoleAttribute) == kAXButtonRole && str($0, kAXTitleAttribute) == a[2] }),
      let bp = point(button, kAXPositionAttribute), let bs = size(button), let wp = point(win, kAXPositionAttribute) else {
    out(["ok": false, "error": "no button '\(a[2])' with a frame"])
}
var wid: CGWindowID = 0
_ = _AXUIElementGetWindow(win, &wid)
// Accessibility and CGEvent locations share one space: origin at the top left of the primary screen.
let at = CGPoint(x: bp.x + bs.width / 2, y: bp.y + bs.height / 2)
let local = CGPoint(x: at.x - wp.x, y: at.y - wp.y)

var seen: [String: [String]] = ["monitor": [], "pidTap": [], "sessionTap": []]
let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { e in
    seen["monitor", default: []].append("\(e.type == .leftMouseDown ? "down" : "up")")
}
final class Box { var name: String; init(_ n: String) { name = n } }
let cb: CGEventTapCallBack = { _, type, event, refcon in
    let box = Unmanaged<Box>.fromOpaque(refcon!).takeUnretainedValue()
    seen[box.name, default: []].append("\(type == .leftMouseDown ? "down" : type == .leftMouseUp ? "up" : "\(type.rawValue)")@\(Int(event.location.x)),\(Int(event.location.y))")
    return Unmanaged.passUnretained(event)
}
let mask = CGEventMask(1 << CGEventType.leftMouseDown.rawValue) | CGEventMask(1 << CGEventType.leftMouseUp.rawValue)
let pidBox = Box("pidTap"), sessionBox = Box("sessionTap")
let pidTap = CGEvent.tapCreateForPid(pid: pid, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: cb, userInfo: Unmanaged.passUnretained(pidBox).toOpaque())
let sessionTap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: cb, userInfo: Unmanaged.passUnretained(sessionBox).toOpaque())
for t in [pidTap, sessionTap].compactMap({ $0 }) {
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, t, 0), .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
}
RunLoop.main.run(until: Date().addingTimeInterval(0.3))

/// Posted input resets HIDIdleTime as a person's does, so the GUI gate is told when this program posts: "busy
/// DEADLINE" in CARET_SYNTHETIC_FILE while posting, then the end time (helper/scripts/synthetic-input.ts).
func markPosting(_ busy: Bool) {
    guard let f = ProcessInfo.processInfo.environment["CARET_SYNTHETIC_FILE"], !f.isEmpty else { return }
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    try? (busy ? "busy \(ms + 5000)" : "\(ms)").write(toFile: f, atomically: true, encoding: .utf8)
}

typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
let setLocal = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation").map { unsafeBitCast($0, to: SetWindowLocation.self) }
func click(_ type: CGEventType) -> Bool {
    guard let e = CGEvent(mouseEventSource: CGEventSource(stateID: .privateState), mouseType: type, mouseCursorPosition: at, mouseButton: .left) else { return false }
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(wid))
    e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(wid))
    e.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(wid))
    setLocal?(e, local)
    // To the fixture's pid only. Nothing goes to the HID or session tap.
    e.postToPid(pid)
    return true
}
markPosting(true)
let posted = click(.leftMouseDown)
RunLoop.main.run(until: Date().addingTimeInterval(0.08))
let posted2 = click(.leftMouseUp)
markPosting(false)
RunLoop.main.run(until: Date().addingTimeInterval(1.0))
if let m = monitor { NSEvent.removeMonitor(m) }
var hit: AXUIElement?
let hitErr = AXUIElementCopyElementAtPosition(app, Float(at.x), Float(at.y), &hit)
out(["ok": true, "posted": posted && posted2, "point": [at.x, at.y], "window": Int(wid), "seen": seen,
     "pidTapMade": pidTap != nil, "sessionTapMade": sessionTap != nil, "listenAccess": CGPreflightListenEventAccess(),
     "elementAtPoint": hitErr == .success ? "\(hit.flatMap { str($0, kAXRoleAttribute) } ?? "?") '\(hit.flatMap { str($0, kAXTitleAttribute) } ?? "")'" : "error \(hitErr.rawValue)"])
