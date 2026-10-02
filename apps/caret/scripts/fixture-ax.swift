// Accessibility actions on fixture processes, for the fill acceptance run. No keyboard or mouse
// event is posted: focus moves by writing AXFocused on the field, which AppKit applies inside the
// fixture without activating it. Every command refuses a pid that is not listed in
// CARET_TEST_PIDS, so it can only act on processes the test started.
//
// Build: swiftc -O fixture-ax.swift -o ../.build/fixture-ax
// Usage: fixture-ax focus <pid> <x,y,w,h>     focus the text field with that AX frame
//        fixture-ax value <pid> <x,y,w,h>     print {"value": ...} for that field
//        fixture-ax focused <pid>             print the focused element's role and frame
//        fixture-ax set-text <pid> <window title> <old> <new>   rewrite a label (AXValue) if settable
//        fixture-ax close <pid> <window title>                  press the window's close button
//        fixture-ax frontmost                 print the frontmost pid (NSWorkspace and lsappinfo)
//        fixture-ax activate <pid>            ask macOS to activate the fixture (may be refused)
//        fixture-ax key-if-front <pid> tab|space|char <c>
//            post ONE key at the HID level, only while both checks say <pid> is frontmost. The
//            only global event this tool can send; callers hold gui.lock (long-run skill).

import AppKit
import ApplicationServices
import Foundation

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data("fixture-ax: \(message)\n".utf8))
    exit(code)
}

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

let allowed = Set((ProcessInfo.processInfo.environment["CARET_TEST_PIDS"] ?? "").split(separator: ",").compactMap { Int32($0) })

func requirePID(_ raw: String) -> pid_t {
    guard let pid = Int32(raw) else { fail("bad pid \(raw)") }
    guard allowed.contains(pid) else { fail("refused: pid \(pid) is not in CARET_TEST_PIDS") }
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { fail("pid \(pid) is not running") }
    return pid
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String? { attribute(element, name) as? String }

func children(_ element: AXUIElement, _ name: String = kAXChildrenAttribute) -> [AXUIElement] {
    (attribute(element, name) as? [AnyObject] ?? []).compactMap {
        CFGetTypeID($0) == AXUIElementGetTypeID() ? unsafeBitCast($0, to: AXUIElement.self) : nil
    }
}

func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func parseFrame(_ raw: String) -> CGRect {
    let parts = raw.split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4 else { fail("frame must be x,y,w,h") }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

func walk(_ root: AXUIElement, limit: Int = 3000, _ visit: (AXUIElement) -> Bool) {
    var queue = [root]
    var seen = 0
    while !queue.isEmpty, seen < limit {
        let element = queue.removeFirst()
        seen += 1
        if visit(element) { return }
        queue.append(contentsOf: children(element))
    }
}

func textField(pid: pid_t, frame wanted: CGRect) -> AXUIElement {
    var found: AXUIElement?
    for window in children(AXUIElementCreateApplication(pid), kAXWindowsAttribute) {
        walk(window) { element in
            guard string(element, kAXRoleAttribute) == kAXTextFieldRole, let f = frame(element),
                  abs(f.minX - wanted.minX) <= 1, abs(f.minY - wanted.minY) <= 1,
                  abs(f.width - wanted.width) <= 1, abs(f.height - wanted.height) <= 1
            else { return false }
            found = element
            return true
        }
        if found != nil { break }
    }
    guard let found else { fail("no text field at \(wanted) in pid \(pid)", code: 4) }
    return found
}

func window(pid: pid_t, title: String) -> AXUIElement {
    guard let w = children(AXUIElementCreateApplication(pid), kAXWindowsAttribute).first(where: { string($0, kAXTitleAttribute) == title }) else {
        fail("no window titled \(title) in pid \(pid)", code: 4)
    }
    return w
}

/// LaunchServices' front application, from `lsappinfo`, independent of this process's NSWorkspace
/// cache.
func lsFront() -> pid_t? {
    func run(_ args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        do { try process.run() } catch { return "" }
        process.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }
    let asn = run(["front"]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !asn.isEmpty else { return nil }
    let info = run(["info", "-only", "pid", asn])
    guard let value = info.split(separator: "=").last?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
    return pid_t(value)
}

/// NSWorkspace's answer, refreshed by spinning the run loop so its notification-fed cache is
/// current, and lsappinfo's, which must agree.
func isFront(_ pid: pid_t) -> Bool {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && lsFront() == pid
}

func waitFront(_ pid: pid_t, seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if isFront(pid) { return true }
        usleep(50_000)
    }
    return false
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: see the header") }
guard AXIsProcessTrusted() else { fail("not trusted for Accessibility") }

switch command {
case "focus" where args.count == 3:
    let pid = requirePID(args[1])
    let field = textField(pid: pid, frame: parseFrame(args[2]))
    let started = Date()
    let result = AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    emit(["ok": result == .success, "axError": result.rawValue, "atMs": started.timeIntervalSince1970 * 1000])
case "fields" where args.count == 2:
    // Every text field of the pid's windows with its window title and AX frame, in tree order.
    let pid = requirePID(args[1])
    var out: [[String: Any]] = []
    for w in children(AXUIElementCreateApplication(pid), kAXWindowsAttribute) {
        let title = string(w, kAXTitleAttribute) ?? ""
        walk(w) { element in
            if string(element, kAXRoleAttribute) == kAXTextFieldRole, let f = frame(element) {
                out.append(["window": title, "frame": [f.minX, f.minY, f.width, f.height], "value": string(element, kAXValueAttribute) ?? ""])
            }
            return false
        }
    }
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
case "value" where args.count == 3:
    let pid = requirePID(args[1])
    let field = textField(pid: pid, frame: parseFrame(args[2]))
    emit(["value": string(field, kAXValueAttribute) ?? NSNull()])
case "focused" where args.count == 2:
    let pid = requirePID(args[1])
    guard let raw = attribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute) else { emit(["focused": NSNull()]); break }
    let element = unsafeBitCast(raw, to: AXUIElement.self)
    let f = frame(element)
    emit(["role": string(element, kAXRoleAttribute) ?? NSNull(), "frame": f.map { [$0.minX, $0.minY, $0.width, $0.height] } ?? NSNull()])
case "set-text" where args.count == 5:
    let pid = requirePID(args[1])
    var target: AXUIElement?
    walk(window(pid: pid, title: args[2])) { element in
        guard string(element, kAXValueAttribute) == args[3] else { return false }
        target = element
        return true
    }
    guard let target else { fail("no element with that text", code: 4) }
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &settable)
    let result = settable.boolValue ? AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, args[4] as CFString) : .attributeUnsupported
    emit(["ok": result == .success, "settable": settable.boolValue, "axError": result.rawValue])
case "key-window" where args.count == 3:
    // Make one fixture window its app's key window by writing AXMain on it, the way a user
    // switching windows inside the app would. Reports the app's focused window before and after,
    // and the frontmost app, which must not change.
    let pid = requirePID(args[1])
    let app = AXUIElementCreateApplication(pid)
    func focusedTitle() -> String {
        guard let raw = attribute(app, kAXFocusedWindowAttribute) else { return "" }
        return string(unsafeBitCast(raw, to: AXUIElement.self), kAXTitleAttribute) ?? ""
    }
    let frontBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    let before = focusedTitle()
    let result = AXUIElementSetAttributeValue(window(pid: pid, title: args[2]), kAXMainAttribute as CFString, kCFBooleanTrue)
    usleep(150_000)
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    emit(["ok": result == .success, "axError": result.rawValue, "focusedBefore": before, "focusedAfter": focusedTitle(),
          "frontBefore": frontBefore, "frontAfter": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "lsFront": lsFront() ?? -1])
case "close" where args.count == 3:
    let pid = requirePID(args[1])
    let w = window(pid: pid, title: args[2])
    guard let raw = attribute(w, kAXCloseButtonAttribute) else { fail("window has no close button", code: 4) }
    let result = AXUIElementPerformAction(unsafeBitCast(raw, to: AXUIElement.self), kAXPressAction as CFString)
    emit(["ok": result == .success, "axError": result.rawValue])
case "frontmost":
    emit(["pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "lsappinfo": lsFront() ?? -1])
case "activate" where args.count == 2:
    // A normal activation request, never kAXFrontmost. macOS may refuse it (cooperative
    // activation); the caller must then stop and report deferred: foreground.
    let pid = requirePID(args[1])
    let ok = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows]) ?? false
    let front = waitFront(pid, seconds: 2)
    emit(["requested": ok, "front": front])
case "key-if-front" where args.count == 3 || args.count == 4:
    // One real HID key, posted only if LaunchServices says the fixture is frontmost, checked by
    // two independent routes immediately before the post.
    let pid = requirePID(args[1])
    let codes: [String: (CGKeyCode, String?)] = ["tab": (48, "\t"), "space": (49, " ")]
    var key: (CGKeyCode, String?)
    if let known = codes[args[2]] {
        key = known
    } else if args[2] == "char", args.count == 4, args[3].count == 1 {
        key = (0, args[3])
    } else {
        fail("key must be tab, space or char <c>")
    }
    guard isFront(pid) else { emit(["posted": false, "reason": "notFrontmost"]); exit(3) }
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: key.0, keyDown: down) else { continue }
        event.flags = []
        if let text = key.1 {
            let units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        if down, !isFront(pid) { emit(["posted": false, "reason": "lostFront"]); exit(3) }
        event.post(tap: .cghidEventTap)
        usleep(4_000)
    }
    emit(["posted": true, "atMs": Date().timeIntervalSince1970 * 1000])
default:
    fail("usage: see the header")
}
