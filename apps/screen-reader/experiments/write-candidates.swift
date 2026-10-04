// B20 part 1: ways to put text into a web field whose window is not key, tried one at a time on a process
// the evaluation started itself. The field is found by its DOM id (AXDOMIdentifier, which WebKit and
// Chromium both expose). Each candidate acts, waits, and reads the field's value back through
// Accessibility as its own after-check; the evaluation compares that with the page's own JavaScript.
// Every run also reports whether the target app became active and whether its window moved up the
// on-screen window order, since a means that brings the window forward does not count.
//
//   write-candidates PID TITLE_PREFIX DOM_ID CANDIDATE VALUE    -> one JSON line
//   write-candidates PID TITLE_PREFIX DOM_ID describe           -> the field's attributes, actions and parameterized attributes
//
// Candidates:
//   value           AXValue
//   focus-value     AXFocused on the field, then AXValue
//   main-value      AXMain on the window, AXFocused on the field, then AXValue
//   insert          AXFocused, AXSelectedTextRange over all, AXSelectedText (the reader's insert)
//   type-cg         AXFocused, then each character as a keyboard event to the pid (CGEventPostToPid)
//   type-sl         the same through SkyLight's SLEventPostToPid with an authentication message
//
// B20 also had paste-cg, which put the value on the general pasteboard and restored it. It is gone: nothing in
// Caret's tests may write the user's clipboard, even briefly (BUILD-ORDER clipboard rule, 2026-10-03), and
// Command-V reads only the general pasteboard, so a paste cannot be tried with a private one.
//
// Keyboard events go only to PID, which the caller started. Nothing is posted to the HID or session tap. With
// CARET_REQUIRE_FRONT=1 (a run that measures the target while it is frontmost), LaunchServices must name PID as
// the frontmost app immediately before every posted event, or the candidate stops with "deferred: foreground".
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
func find(_ e: AXUIElement, id: String, depth: Int = 0) -> AXUIElement? {
    if str(e, "AXDOMIdentifier") == id { return e }
    if depth > 30 { return nil }
    for k in kids(e) { if let f = find(k, id: id, depth: depth + 1) { return f } }
    return nil
}
func set(_ e: AXUIElement, _ n: String, _ v: CFTypeRef) -> AXError { AXUIElementSetAttributeValue(e, n as CFString, v) }

let a = Array(CommandLine.arguments.dropFirst())
guard a.count >= 4, let pid = pid_t(a[0]) else { out(["ok": false, "error": "usage: write-candidates PID TITLE_PREFIX DOM_ID CANDIDATE [VALUE]"]) }
let (prefix, domId, cand) = (a[1], a[2], a[3])
let value = a.count >= 5 ? a[4] : ""
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)
let wins = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
guard let win = wins.first(where: { (str($0, kAXTitleAttribute) ?? "").hasPrefix(prefix) }) else {
    out(["ok": false, "error": "no window starting with '\(prefix)'", "titles": wins.map { str($0, kAXTitleAttribute) ?? "" }])
}
var wid: CGWindowID = 0
_ = _AXUIElementGetWindow(win, &wid)
guard let field = find(win, id: domId) else { out(["ok": false, "error": "no element with DOM id \(domId)"]) }

/// Where the window sits among on-screen, layer-0 windows, front first; nil when it is not on screen.
func zIndex() -> Int? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let normal = list.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
    return normal.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == Int(wid) })
}
/// Whether the target process is the active app, read after letting the run loop take AppKit's updates.
func active() -> Bool {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    return NSRunningApplication(processIdentifier: pid)?.isActive ?? false
}
func frontPid() -> Int {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    return Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)
}

if cand == "describe" {
    var names: CFArray?, actions: CFArray?, params: CFArray?
    AXUIElementCopyAttributeNames(field, &names)
    AXUIElementCopyActionNames(field, &actions)
    AXUIElementCopyParameterizedAttributeNames(field, &params)
    var settable: [String] = []
    for n in (names as? [String]) ?? [] {
        var s: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(field, n as CFString, &s) == .success, s.boolValue { settable.append(n) }
    }
    out(["ok": true, "role": str(field, kAXRoleAttribute) ?? "", "attributes": (names as? [String]) ?? [], "settable": settable,
         "actions": (actions as? [String]) ?? [], "parameterized": (params as? [String]) ?? [], "window": Int(wid), "z": zIndex() as Any, "active": active()])
}

// MARK: - keyboard events to the pid

/// Posted input resets HIDIdleTime as a person's does, so the GUI gate is told when this program posts: "busy
/// DEADLINE" in CARET_SYNTHETIC_FILE while posting, then the end time (helper/scripts/synthetic-input.ts).
func markPosting(_ busy: Bool) {
    guard let f = ProcessInfo.processInfo.environment["CARET_SYNTHETIC_FILE"], !f.isEmpty else { return }
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    try? (busy ? "busy \(ms + 5000)" : "\(ms)").write(toFile: f, atomically: true, encoding: .utf8)
}

typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
typealias SetAuth = @convention(c) (CGEvent, AnyObject) -> Void
typealias MsgFactory = @convention(c) (AnyClass, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> AnyObject?
let skylight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
func sym<T>(_ name: String, _: T.Type) -> T? { dlsym(skylight, name).map { unsafeBitCast($0, to: T.self) } }

/// SkyLight's per-pid post with an authentication message, as cua-driver's keyboard path does. False when the SPI is missing.
func postSL(_ e: CGEvent) -> Bool {
    guard let post = sym("SLEventPostToPid", PostToPid.self) else { return false }
    if let setAuth = sym("SLEventSetAuthenticationMessage", SetAuth.self),
       let cls: AnyClass = NSClassFromString("SLSEventAuthenticationMessage"),
       let send = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend").map({ unsafeBitCast($0, to: MsgFactory.self) }) {
        let sel = NSSelectorFromString("messageWithEventRecord:pid:version:")
        if class_respondsToSelector(object_getClass(cls), sel) {
            let raw = Unmanaged.passUnretained(e).toOpaque()
            for off in [24, 32, 16] {
                guard let rec = raw.load(fromByteOffset: off, as: UnsafeMutableRawPointer?.self) else { continue }
                if let msg = send(cls, sel, rec, pid, 0) { setAuth(e, msg) }
                break
            }
        }
    }
    post(pid, e)
    return true
}
let requireFront = ProcessInfo.processInfo.environment["CARET_REQUIRE_FRONT"] == "1"
func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags = [], text: String? = nil, sl: Bool) -> Bool {
    if requireFront, frontPid() != Int(pid) {
        markPosting(false)
        out(["ok": false, "error": "deferred: foreground (frontmost is \(frontPid()), not \(pid))"])
    }
    guard let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: code, keyDown: down) else { return false }
    e.flags = flags
    if let t = text { let u = Array(t.utf16); e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u) }
    if sl { return postSL(e) }
    e.postToPid(pid)
    return true
}
func typeText(_ s: String, sl: Bool) -> Bool {
    for ch in s {
        guard key(0, down: true, text: String(ch), sl: sl) else { return false }
        usleep(8000)
        guard key(0, down: false, text: String(ch), sl: sl) else { return false }
        usleep(8000)
    }
    return true
}
/// Command-A then the text: the field's old text is selected and typed over, as a person would.
func selectAllKeys(sl: Bool) -> Bool { key(0, down: true, flags: .maskCommand, sl: sl) && key(0, down: false, flags: .maskCommand, sl: sl) }

// MARK: - run one candidate

let z0 = zIndex(), active0 = active(), front0 = frontPid()
var detail = ""
var acted = true
switch cand {
case "value":
    detail = "value=\(set(field, kAXValueAttribute, value as CFString).rawValue)"
case "focus-value":
    detail = "focus=\(set(field, kAXFocusedAttribute, kCFBooleanTrue).rawValue) value=\(set(field, kAXValueAttribute, value as CFString).rawValue)"
case "main-value":
    detail = "main=\(set(win, kAXMainAttribute, kCFBooleanTrue).rawValue) focus=\(set(field, kAXFocusedAttribute, kCFBooleanTrue).rawValue) value=\(set(field, kAXValueAttribute, value as CFString).rawValue)"
case "insert":
    let f = set(field, kAXFocusedAttribute, kCFBooleanTrue)
    var r = CFRange(location: 0, length: ((str(field, kAXValueAttribute) ?? "") as NSString).length)
    let sel = AXValueCreate(.cfRange, &r).map { set(field, kAXSelectedTextRangeAttribute, $0) } ?? .failure
    detail = "focus=\(f.rawValue) select=\(sel.rawValue) replace=\(set(field, kAXSelectedTextAttribute, value as CFString).rawValue)"
case "type-cg", "type-sl":
    let sl = cand == "type-sl"
    let f = set(field, kAXFocusedAttribute, kCFBooleanTrue)
    usleep(100_000)
    let focused = (attr(field, kAXFocusedAttribute) as? Bool) ?? false
    markPosting(true)
    let posted = selectAllKeys(sl: sl) && typeText(value, sl: sl)
    markPosting(false)
    detail = "focus=\(f.rawValue) focusedBefore=\(focused) posted=\(posted)"
    acted = posted
default:
    out(["ok": false, "error": "unknown candidate \(cand)"])
}
usleep(300_000)
let after = str(field, kAXValueAttribute)
let z1 = zIndex(), active1 = active(), front1 = frontPid()
out(["ok": true, "candidate": cand, "acted": acted, "detail": detail, "axAfter": after as Any, "axSaysLanded": after == value,
     "zBefore": z0 as Any, "zAfter": z1 as Any, "raised": (z0 != nil && z1 != nil && z1! < z0!) || (z0 == nil && z1 != nil),
     "activeBefore": active0, "activeAfter": active1, "frontBefore": front0, "frontAfter": front1, "window": Int(wid)])
